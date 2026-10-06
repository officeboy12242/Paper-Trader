/**
 * System-1 decision gate (Jev / Laya-style) powered by Groq.
 *
 * Jev (TypeSafe) is a paid "System 1" decision model: you give it a state and
 * typed questions (choice / score / noul) and it answers with ONLY typed
 * values — no free-form reasoning, no prose to parse. Laya
 * (convaiinnovations/laya on Hugging Face) is the Apache-2.0 open clone, but it
 * ships no hosted API and needs ~1 GB+ of RAM to serve, which the Render
 * starter plan cannot afford — so this module reproduces the same behaviour on
 * Groq's always-on API:
 *
 *   - the model is told it is a System 1 decision model that must not reason;
 *   - its reply is constrained (JSON-schema strict decoding, retried as plain
 *     JSON) to exactly one compact verdict:
 *       { take: yes|no|noul, direction: buy|sell|neutral,
 *         conviction: 0-100, noul: confirm|deny|uncertain }
 *   - temperature is 0 and max_tokens is tiny so it cannot ramble.
 *
 * Contract with the engine (mirrors the nightly ML gate):
 *   - mode=off     — never called
 *   - mode=shadow  — every accepted setup is scored; the verdict is recorded on
 *                    the decision and stored in signal metadata (SQLite + Mongo)
 *                    but never blocks a trade (default)
 *   - mode=on      — a verdict that is not a clean, sufficiently-convincing
 *                    confirmation flips the setup to REJECT. The model is the
 *                    final word on direction, exactly like Jev/Laya in the loop.
 *   - a missing key, provider error, budget exhaustion, cooldown or malformed
 *     reply degrades to "no opinion" and can never block or slow a scan.
 *   - a daily call budget (SYSTEM1_MAX_PER_DAY) and a consecutive-error
 *     cooldown keep cost and failure noise bounded.
 */

import { sessionDate } from '../market/clock.js';

const API_URL = 'https://api.groq.com/openai/v1/chat/completions';

/** The typed output contract the model must obey (Laya's choice/score/noul idea). */
export const VERDICT_SCHEMA = {
    type: 'object',
    properties: {
        take: { type: 'string', enum: ['yes', 'no', 'noul'] },
        direction: { type: 'string', enum: ['buy', 'sell', 'neutral'] },
        conviction: { type: 'integer', minimum: 0, maximum: 100 },
        noul: { type: 'string', enum: ['confirm', 'deny', 'uncertain'] },
    },
    required: ['take', 'direction', 'conviction', 'noul'],
    additionalProperties: false,
};

export const SYSTEM_PROMPT =
    'You are a System 1 decision model for intraday trading. ' +
    'Decide IMMEDIATELY and DECISIVELY from the STATE below. ' +
    'You do NOT reason, analyze, justify or explain. No chain of thought. No hedging. No markdown. ' +
    'Reply with exactly one JSON object:\n' +
    '{"take": "yes" | "no" | "noul", "direction": "buy" | "sell" | "neutral", ' +
    '"conviction": <integer 0-100>, "noul": "confirm" | "deny" | "uncertain"}\n' +
    '- take: "yes" = take the proposed trade as given, "no" = reject it, "noul" = cannot decide from the state.\n' +
    '- direction: the direction with the edge right now ("buy" = long, "sell" = short, "neutral" = no edge).\n' +
    '- conviction: your honest confidence 0-100 in "take" (50 = coin flip, 60 = slight edge, 80+ = strong).\n' +
    '- noul: your nuance label: "confirm" | "deny" | "uncertain".\n' +
    'If the STATE is missing, contradictory, or too uncertain to act on, answer ' +
    'take "noul", conviction under 50, noul "uncertain". Never invent data. Output ONLY the JSON object.';

const TAKES = new Set(['yes', 'no', 'noul']);
const DIRECTIONS = new Set(['buy', 'sell', 'neutral']);
const NOULS = new Set(['confirm', 'deny', 'uncertain']);

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/** Parse a model reply into a typed verdict. Tolerant; null when unparseable. */
export function parseVerdict(raw) {
    if (raw == null) return null;
    let text = String(raw).trim();
    if (!text) return null;
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    let obj;
    try {
        obj = JSON.parse(text.slice(start, end + 1));
    } catch {
        return null;
    }
    if (!obj || typeof obj !== 'object') return null;
    const take = TAKES.has(obj.take) ? obj.take : 'noul';
    const direction = DIRECTIONS.has(obj.direction) ? obj.direction : 'neutral';
    const rawConv = Number(obj.conviction);
    const conviction = Number.isFinite(rawConv) ? Math.round(clamp(rawConv, 0, 100)) : 0;
    const noul = NOULS.has(obj.noul) ? obj.noul : 'uncertain';
    return { take, direction, conviction, noul };
}

/** Compact, neutral "state" (Jev-style context) for one proposed trade. */
export function buildState(d) {
    const s = d.setup || {};
    const entry = Number(s.entry);
    const stop = Number(s.stop);
    const target = Number(s.target);
    let rr = null;
    if ([entry, stop, target].every((n) => Number.isFinite(n) && n > 0)) {
        const risk = Math.abs(entry - stop);
        const reward = Math.abs(target - entry);
        if (risk > 0) rr = Math.round((reward / risk) * 100) / 100;
    }
    const dir = d.direction === 'LONG' ? 'long' : d.direction === 'SHORT' ? 'short' : '—';
    const last = Array.isArray(d.bars) && d.bars.length ? d.bars[d.bars.length - 1] : null;
    const rows = [
        'state:',
        `symbol ${d.symbol || '—'}`,
        `source ${String(d.filterCondition || '—').slice(0, 120)}`,
        `proposed ${dir} trade`,
        `entry ${Number.isFinite(entry) ? entry : '—'}`,
        `stop ${Number.isFinite(stop) ? stop : '—'}`,
        `target ${Number.isFinite(target) ? target : '—'}`,
        `risk:reward ${rr ?? '—'}`,
    ];
    if (d.setup?.score != null) rows.push(`setup score ${d.setup.score}`);
    if (d.setup?.target2 != null) rows.push(`target2 ${d.setup.target2}`);
    if (d.confluence != null) rows.push(`confluence ${d.confluence}`);
    if (last?.close != null) rows.push(`last close ${last.close}`);
    return `QUESTION: should we take this proposed ${dir} trade?\n\n${rows.join('\n')}`;
}

/**
 * Shared gate. One instance lives on the engine and is handed to every trader
 * context so the daily budget and error state are global.
 */
export class System1Gate {
    /**
     * @param {{cfg: object, logger?: object, now?: () => number, http?: object}} o
     *        http is injectable for tests (defaults to axios.post shape).
     */
    constructor({ cfg, logger = null, now = Date.now, http = null }) {
        this.cfg = cfg;
        this.logger = logger;
        this.now = now;
        this.http = http; // null = live axios import below
        this.callsToday = 0;
        this.dayKey = null;
        this.consecutiveErrors = 0;
        this.cooldownUntil = 0;
        this.lastRun = null;
        this.lastBudgetSkipped = false;
    }

    get mode() {
        return this.cfg.SYSTEM1_GATE_MODE;
    }

    get configured() {
        return Boolean((this.cfg.SYSTEM1_API_KEY || this.cfg.GROQ_API_KEY || '').trim());
    }

    _resetDay() {
        const day = sessionDate(this.now());
        if (day !== this.dayKey) {
            this.dayKey = day;
            this.callsToday = 0;
        }
    }

    _key() {
        return (this.cfg.SYSTEM1_API_KEY || this.cfg.GROQ_API_KEY || '').trim();
    }

    _post(body) {
        if (this.http) return this.http.post(API_URL, body, { timeout: this.cfg.SYSTEM1_TIMEOUT_MS });
        // Live path: import lazily so tests never need axios installed.
        return import('axios').then(({ default: axios }) =>
            axios.post(API_URL, body, { timeout: this.cfg.SYSTEM1_TIMEOUT_MS }));
    }

    /**
     * Ask the model for one typed verdict on a setup that already passed the
     * rules. Never throws. Returns a verdict object or null ("no opinion").
     */
    async ask(d) {
        this._resetDay();
        if (this.now() < this.cooldownUntil) {
            this._log('warn', 'COOLDOWN', 'system1 skipping while provider cooldown is active');
            return null;
        }
        const maxPerDay = Number(this.cfg.SYSTEM1_MAX_PER_DAY) || 0;
        if (maxPerDay > 0 && this.callsToday >= maxPerDay) {
            if (!this.lastBudgetSkipped) {
                this.lastBudgetSkipped = true;
                this._log('warn', 'BUDGET', `system1 daily budget (${maxPerDay} calls) reached — no more verdicts today`);
            }
            return null;
        }
        this.lastBudgetSkipped = false;
        const key = this._key();
        if (!key) {
            this.lastRun = { at: this.now(), ok: false, error: 'no SYSTEM1_API_KEY / GROQ_API_KEY set' };
            return null;
        }
        if (!d?.setup) return null;

        const model = this.cfg.SYSTEM1_MODEL || 'openai/gpt-oss-120b';
        const started = this.now();
        const body = {
            model,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: buildState(d) },
            ],
            temperature: 0,
            max_tokens: 120,
            response_format: { type: 'json_schema', json_schema: { name: 'system_one_verdict', strict: true, schema: VERDICT_SCHEMA } },
        };
        const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

        this.callsToday += 1;
        let text = null;
        try {
            try {
                const { data } = await this._post({ ...body, headers });
                text = data?.choices?.[0]?.message?.content ?? '';
            } catch (schemaErr) {
                // Some models reject strict json_schema — retry as plain JSON mode.
                this._log('debug', 'SCHEMA RETRY', String(schemaErr?.message || schemaErr));
                const { data } = await this._post({
                    ...body,
                    headers,
                    response_format: { type: 'json_object' },
                });
                text = data?.choices?.[0]?.message?.content ?? '';
            }
            const verdict = parseVerdict(text);
            if (!verdict) throw new Error('system1 reply did not parse to a verdict');
            this.consecutiveErrors = 0;
            this.lastRun = { at: started, tookMs: this.now() - started, model, ok: true, verdict };
            return verdict;
        } catch (err) {
            this.consecutiveErrors += 1;
            const cooldownMs = Number(this.cfg.SYSTEM1_COOLDOWN_MS) || 0;
            if (cooldownMs > 0 && this.consecutiveErrors >= 3) {
                this.cooldownUntil = this.now() + cooldownMs;
                this._log('warn', 'COOLDOWN SET', `system1 failed ${this.consecutiveErrors}x — cooling down ${Math.round(cooldownMs / 60000)}m`);
            }
            this.lastRun = { at: started, ok: false, error: String(err?.message || err).slice(0, 200), model };
            this._log('warn', 'GATE OPINION', `system1 call failed: ${this.lastRun.error}`);
            return null;
        }
    }

    /**
     * Score every accepted setup in a scan's decisions. Mutates the decisions
     * exactly like the nightly ML gate: shadow records `d.system1`, on vetoes.
     * Never throws — a failure means "no opinion".
     */
    async apply(decisions) {
        try {
            if (!Array.isArray(decisions) || !decisions.length) return;
            const mode = this.mode;
            if (mode === 'off') return;
            const minConv = Number(this.cfg.SYSTEM1_CONVICTION_MIN) || 0;
            for (const d of decisions) {
                if (d.decision !== 'PASS' && d.decision !== 'SOFT') continue;
                if (!d.setup) continue;
                const v = await this.ask(d);
                if (!v) continue;
                d.system1 = { ...v, model: this.cfg.SYSTEM1_MODEL || 'openai/gpt-oss-120b' };
                if (mode !== 'on') continue;
                const sideOk = (d.direction === 'LONG' && v.direction === 'buy') || (d.direction === 'SHORT' && v.direction === 'sell');
                const strongEnough = v.conviction >= minConv;
                const confirmed = v.take === 'yes' && sideOk && strongEnough;
                if (!confirmed) {
                    d.decision = 'REJECT';
                    const why = v.take !== 'yes' ? `${v.take} (${v.noul})` : !sideOk ? `direction ${v.direction} conflicts` : `conviction ${v.conviction} < ${minConv}`;
                    d.reason = `system1 veto: ${why}`;
                }
            }
        } catch (err) {
            this._log('warn', 'GATE SKIPPED', String(err?.message || err));
        }
    }

    _log(level, event, message) {
        try {
            if (level === 'warn') this.logger?.warn?.('SYSTEM1', event, message);
            else if (level === 'debug') this.logger?.debug?.('SYSTEM1', event, message);
        } catch {
            /* logging must never break the gate */
        }
    }
}

/** One convenient default instance for contexts that just want the gate. */
export const system1Gate = (cfg, o = {}) => new System1Gate({ cfg, ...o });