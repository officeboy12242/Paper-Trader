/**
 * Adds an LLM verdict layer on top of the deterministic SVMKR scanner.
 *
 * The scanner (SvmkrScanService) decides mechanically whether a UT Bot cross
 * fired with HMA + slope confirmations. This service asks a free LLM on
 * OrcaRouter to grade the surviving setup — BUY / SKIP / WAIT with a
 * 0–100 confidence and a 2–3 sentence "why" grounded in the actual numbers
 * from the card. It never changes the scanner's decision; it only annotates
 * the card so a reader sees a synthesized verdict before the plan details.
 *
 * Failsoft: every model can fail (429, timeout, unparsable output). When they
 * all do, verdict() returns null and the card renders exactly like today.
 *
 * Model ladder (free on OrcaRouter):
 *   1. deepseek/deepseek-v4-flash-free — the only free DeepSeek slug that
 *      OrcaRouter currently hosts (`pro-free` was retired). Non-reasoning,
 *      ~9s typical.
 *
 * Override via SVMKR_LLM_MODELS env var (comma-separated).
 *
 * max_tokens=4000 leaves headroom for the schema-shaped JSON response and
 * covers any future reasoning-enabled DeepSeek variant we may add back.
 * Timeout is 30s to cover cold starts.
 */

import axios from 'axios';
import { logger } from '../utils/logger.js';
import { config } from '../config/config.js';

const ORCAROUTER_URL = 'https://api.orcarouter.ai/v1/chat/completions';
const DEFAULT_MODELS = [
    'deepseek/deepseek-v4-flash-free',
];
/** Per-model timeout: 30s covers cold starts. */
const PER_MODEL_TIMEOUT_MS = 30_000;
/** Big enough to leave content headroom AFTER any hidden reasoning token burn. */
const MAX_TOKENS = 4_000;

const SYSTEM_PROMPT = `You are a disciplined Indian F&O options trader grading ONE specific SVMKR (UT Bot + HMA + slope) setup card.

Decide BUY, SKIP, or WAIT. Rate confidence 0-100. Explain in 2-3 sentences using the actual numbers you were given (index level, strike, premiums, R:R, confirmations). No adjectives without numbers to back them up.

Bias toward SKIP when:
- Confirmations < 2 (only one of HMA / slope agrees)
- R:R below 1.2:1 on T1
- Signal is not fresh (a standing on-demand read, not a new cross)
- Bar time past 15:00 IST — insufficient time to work before close
- IV extreme or missing on the leg

Bias toward BUY when:
- Fresh UT cross, confirmations = 2/2, R:R >= 1.3
- Momentum aligned (HMA + slope both direction-agree)
- Index risk to stop is inside a normal ATR range

WAIT is for borderline — one confirmation, thin R:R, but structure fine — where a slightly better print would flip it to BUY.

Output STRICT JSON only, nothing before or after. Exact schema:
{"verdict":"BUY"|"SKIP"|"WAIT","confidence":0-100,"why":"<2-3 sentences citing numbers>"}`;

class SvmkrLlmVerdictService {
    constructor(cfg = config) {
        this.config = cfg;
        this.apiKey = String(cfg.ORCAROUTER_API_KEY || '').trim();
        const raw = String(cfg.SVMKR_LLM_MODELS || '').trim();
        this.models = raw
            ? raw.split(',').map((s) => s.trim()).filter(Boolean)
            : [...DEFAULT_MODELS];
        this.timeoutMs = Number(cfg.SVMKR_LLM_TIMEOUT_MS) || PER_MODEL_TIMEOUT_MS;
    }

    isConfigured() {
        return Boolean(this.apiKey);
    }

    _buildUserPrompt(scan) {
        const { label, tech, setup } = scan;
        const s = setup;
        const p = s.plan || {};

        // R:R computed from actual sized plan — the same numbers the reader sees.
        const rr =
            Number.isFinite(p.premT1) &&
            Number.isFinite(p.premEntry) &&
            Number.isFinite(p.premStop) &&
            p.premEntry !== p.premStop
                ? ((p.premT1 - p.premEntry) / (p.premEntry - p.premStop)).toFixed(2)
                : null;

        const bar = new Date(tech.barTs).toLocaleTimeString('en-IN', {
            timeZone: 'Asia/Kolkata',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        });

        const lines = [
            `Index: ${label}`,
            `Side: ${s.side} (${s.side === 'CE' ? 'bullish CE' : 'bearish PE'})`,
            `Fresh signal: ${s.fresh ? 'yes — UT cross printed on the last closed 5m bar' : 'no — standing on-demand read, no new cross'}`,
            `Confirmations: ${s.confirmations}/2`,
            `Scanner reasons: ${s.reasons.join(' | ')}`,
            '',
            `Index level: ${tech.close}`,
            `UT trailing stop: ${tech.trailingStop}`,
            `HMA(21): ${tech.hma} (price ${tech.aboveHma ? 'above' : 'below'} HMA)`,
            `Regression slope: ${tech.slope} vs avg ${tech.slopeAvg}`,
            `ATR(10): ${tech.atr}`,
            `Bar time: ${bar} IST (bar age ${tech.barAgeMin} min)`,
            '',
            `Strike / expiry: ${s.strike} ${s.side} · ${s.expiry}`,
            `Entry premium: ₹${p.premEntry ?? s.premium}`,
            `Stop premium: ₹${p.premStop ?? '?'}`,
            `Target 1 premium: ₹${p.premT1 ?? '?'}`,
            `Target 2 premium: ₹${p.premT2 ?? '?'}`,
            `Index risk (points to stop): ${s.indexRisk}`,
            `IV: ${s.iv != null ? s.iv + '%' : 'unknown'}`,
            p.lots > 0 ? `Sizing: ${p.lots} lot(s) = ${p.qty} qty, capital ₹${p.capitalUsed}` : 'Sizing: not sized (capital limit)',
            p.riskRs != null ? `Risk on 1 lot: ₹${p.riskRs}` : null,
            p.t1Rs != null ? `Reward on T1: ₹${p.t1Rs}` : null,
            rr != null ? `R:R (T1): ${rr}:1` : null,
            '',
            'Grade this setup. Return STRICT JSON only in the exact schema.',
        ].filter(Boolean);

        return lines.join('\n');
    }

    async _tryModel(model, userPrompt) {
        try {
            const { data } = await axios.post(
                ORCAROUTER_URL,
                {
                    model,
                    messages: [
                        { role: 'system', content: SYSTEM_PROMPT },
                        { role: 'user', content: userPrompt },
                    ],
                    temperature: 0.2,
                    max_tokens: MAX_TOKENS,
                    // Reasoning models on OrcaRouter honour this — keeps latency sane
                    // while still producing a reasoned JSON verdict.
                    reasoning_effort: 'low',
                },
                {
                    headers: {
                        Authorization: `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json',
                    },
                    timeout: this.timeoutMs,
                }
            );
            const content = data?.choices?.[0]?.message?.content?.trim() || '';
            return { content, model };
        } catch (err) {
            const detail = err?.response?.data?.error?.message || err.message;
            logger.warn(`SVMKR verdict ${model} failed: ${detail}`);
            return null;
        }
    }

    /**
     * Parses the first {...} JSON object out of raw content.
     * Qwen/DeepSeek sometimes wrap output in prose or code fences even when
     * asked for strict JSON, so we extract robustly rather than parsing the
     * whole string.
     */
    _parse(content) {
        if (!content) return null;
        const match = content.match(/\{[\s\S]*\}/);
        if (!match) return null;
        try {
            const obj = JSON.parse(match[0]);
            const v = String(obj.verdict || '').toUpperCase().trim();
            if (!['BUY', 'SKIP', 'WAIT'].includes(v)) return null;
            const conf = Math.max(0, Math.min(100, Math.round(Number(obj.confidence) || 0)));
            const why = String(obj.why || '').trim().slice(0, 500);
            if (!why) return null;
            return { verdict: v, confidence: conf, why };
        } catch {
            return null;
        }
    }

    /**
     * @param {object} scan from SvmkrScanService.scan()
     * @returns {Promise<{verdict:string,confidence:number,why:string,model:string}|null>}
     */
    async verdict(scan) {
        if (!this.isConfigured()) return null;
        if (!scan?.setup) return null;

        const userPrompt = this._buildUserPrompt(scan);
        for (const model of this.models) {
            const res = await this._tryModel(model, userPrompt);
            if (!res?.content) continue;
            const parsed = this._parse(res.content);
            if (parsed) {
                logger.info(
                    `SVMKR verdict (${res.model}): ${parsed.verdict} ${parsed.confidence}% — ${scan.key} ${scan.setup.side}`
                );
                return { ...parsed, model: res.model };
            }
            logger.warn(`SVMKR verdict ${res.model} returned unparseable content`);
        }
        return null;
    }
}

export default SvmkrLlmVerdictService;
export const svmkrLlmVerdictService = new SvmkrLlmVerdictService();
