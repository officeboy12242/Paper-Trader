// System-1 decision gate (Jev/Laya-style, Groq or Gemini): typed verdict
// parsing, shadow/off/on semantics, veto reasons, budget, cooldown and the
// trader hook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict, buildState, VERDICT_SCHEMA, SYSTEM_PROMPT, System1Gate } from '../src/ml/system1.js';
import { Trader } from '../src/engine/trader.js';
import { nullLogger } from '../src/logger.js';
import { loadConfig, publicConfig } from '../src/config.js';
import { makeWorld } from './helpers.js';

const now = () => 1_800_000_000_000; // 2027-01-15ish, fixed for a day-key check

const baseCfg = {
    SYSTEM1_GATE_MODE: 'shadow',
    SYSTEM1_PROVIDER: 'groq',
    SYSTEM1_MODEL: 'openai/gpt-oss-120b',
    SYSTEM1_CONVICTION_MIN: 60,
    SYSTEM1_TIMEOUT_MS: 5000,
    SYSTEM1_MAX_PER_DAY: 0,
    SYSTEM1_COOLDOWN_MS: 0,
    SYSTEM1_API_KEY: '',
    SYSTEM1_GEMINI_API_KEY: '',
    GROQ_API_KEY: 'test-key',
};

const pass = (over = {}) => ({
    symbol: 'XAUUSD',
    direction: 'LONG',
    decision: 'PASS',
    setup: { entry: 2670.1, stop: 2668.5, target: 2675.2, score: 78, target2: 2680 },
    confluence: 70,
    filterCondition: 'gold_sweep: checks: breakout, higher_low',
    bars: [{ close: 2670.5 }, { close: 2670.6 }],
    ...over,
});

/** http mock: succeeds with `content`, or throws when content is an Error. */
function httpVia(content) {
    const calls = [];
    const http = {
        calls,
        async post(url, body, opts) {
            calls.push({ url, body, opts });
            if (content instanceof Error) throw content;
            return { data: { choices: [{ message: { content } }] } };
        },
    };
    return http;
}

const gate = (http, cfgOver = {}, gateOver = {}) => new System1Gate({ cfg: { ...baseCfg, ...cfgOver }, logger: nullLogger, now, http, retryDelayMs: 0, ...gateOver });

// ── verdict parsing ─────────────────────────────────────────────────────────

test('parseVerdict accepts a plain JSON reply', () => {
    assert.deepEqual(parseVerdict('{"take":"yes","direction":"buy","conviction":82,"noul":"confirm"}'),
        { take: 'yes', direction: 'buy', conviction: 82, noul: 'confirm' });
});

test('parseVerdict strips code fences and surrounding prose', () => {
    const raw = '```json\n{"take": "no", "direction": "sell", "conviction": 30, "noul": "deny"}\n```';
    assert.deepEqual(parseVerdict(raw), { take: 'no', direction: 'sell', conviction: 30, noul: 'deny' });
    const prose = 'Here is my call: {"take":"noul","direction":"neutral","conviction":45,"noul":"uncertain"} — hope that helps.';
    assert.deepEqual(parseVerdict(prose), { take: 'noul', direction: 'neutral', conviction: 45, noul: 'uncertain' });
});

test('parseVerdict coerces bad fields to safe defaults', () => {
    // missing take/noul + non-numeric conviction
    assert.deepEqual(parseVerdict('{"direction":"buy","conviction":"maybe"}'),
        { take: 'noul', direction: 'buy', conviction: 0, noul: 'uncertain' });
    // conviction clamped to 0..100
    assert.deepEqual(parseVerdict('{"take":"yes","direction":"buy","conviction":999,"noul":"confirm"}'),
        { take: 'yes', direction: 'buy', conviction: 100, noul: 'confirm' });
    assert.deepEqual(parseVerdict('{"take":"yes","direction":"buy","conviction":-5,"noul":"confirm"}'),
        { take: 'yes', direction: 'buy', conviction: 0, noul: 'confirm' });
});

test('parseVerdict returns null for garbage', () => {
    assert.equal(parseVerdict(null), null);
    assert.equal(parseVerdict(''), null);
    assert.equal(parseVerdict('no json here'), null);
    assert.equal(parseVerdict('{broken'), null);
    assert.equal(parseVerdict('[]'), null);
});

test('buildState includes the trade levels, R:R and context', () => {
    const state = buildState(pass());
    assert.match(state, /proposed long trade/);
    assert.match(state, /entry 2670.1/);
    assert.match(state, /stop 2668.5/);
    assert.match(state, /target 2675.2/);
    assert.match(state, /risk:reward 3.19/);
    assert.match(state, /last close 2670.6/);
    assert.match(state, /confluence 70/);
    // no levels, no crash, honest '—' markers
    const sparse = buildState({ symbol: 'XAUUSD', direction: 'LONG', setup: {} });
    assert.match(sparse, /entry —/);
});

test('prompt and schema forbid reasoning and define only the typed contract', () => {
    assert.match(SYSTEM_PROMPT, /System 1 decision model/);
    assert.match(SYSTEM_PROMPT, /do NOT reason/i);
    assert.deepEqual(Object.keys(VERDICT_SCHEMA.properties).sort(), ['conviction', 'direction', 'noul', 'take']);
    assert.deepEqual(VERDICT_SCHEMA.required.sort(), ['conviction', 'direction', 'noul', 'take']);
    assert.equal(VERDICT_SCHEMA.additionalProperties, false);
});

// ── gate semantics ──────────────────────────────────────────────────────────

test('strict JSON-schema request shape + auth on the live call', async () => {
    const http = httpVia('{"take":"yes","direction":"buy","conviction":80,"noul":"confirm"}');
    const g = gate(http);
    const verdict = await g.ask(pass());
    assert.deepEqual(verdict, { take: 'yes', direction: 'buy', conviction: 80, noul: 'confirm' });
    assert.equal(http.calls.length, 1);
    const { url, body, opts } = http.calls[0];
    assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(body.temperature, 0);
    assert.equal(body.max_tokens, 120);
    assert.equal(body.model, 'openai/gpt-oss-120b');
    assert.equal(body.response_format.type, 'json_schema');
    assert.equal(body.response_format.json_schema.strict, true);
    assert.equal(body.response_format.json_schema.schema, VERDICT_SCHEMA);
    assert.equal(opts.timeout, 5000);
    assert.equal(opts.headers.Authorization, 'Bearer test-key');
    assert.equal(body.headers, undefined);
});

test('falls back to plain json_object when the schema path is rejected', async () => {
    let n = 0;
    const http = {
        async post(url, body) {
            n += 1;
            if (n === 1) throw new Error('model does not support json_schema');
            return { data: { choices: [{ message: { content: '{"take":"no","direction":"sell","conviction":25,"noul":"deny"}' } }] } };
        },
    };
    const g = gate(http);
    const v = await g.ask(pass());
    assert.equal(n, 2);
    assert.deepEqual(v, { take: 'no', direction: 'sell', conviction: 25, noul: 'deny' });
    assert.equal(g.consecutiveErrors, 0);
});

test('shadow mode records the verdict and never vetoes', async () => {
    const http = httpVia('{"take":"no","direction":"sell","conviction":10,"noul":"deny"}');
    const g = gate(http, { SYSTEM1_GATE_MODE: 'shadow' });
    const d1 = pass();
    const d2 = pass({ symbol: 'ETHUSD' });
    await g.apply([d1, d2]);
    assert.equal(d1.decision, 'PASS');
    assert.equal(d1.system1.take, 'no');
    assert.equal(d1.system1.conviction, 10);
    assert.equal(String(d1.system1.model), 'openai/gpt-oss-120b');
    assert.deepEqual(d2.system1, d1.system1);
});

test('off mode never calls the provider', async () => {
    const http = httpVia('{"take":"yes","direction":"buy","conviction":99,"noul":"confirm"}');
    const g = gate(http, { SYSTEM1_GATE_MODE: 'off' });
    await g.apply([pass()]);
    assert.equal(http.calls.length, 0);
});

test('on mode vetoes: take=no, then low conviction, then direction conflict, then passes', async () => {
    const veto = (content, extra = {}) => {
        const http = httpVia(content);
        const g = gate(http, { SYSTEM1_GATE_MODE: 'on' });
        const d = pass(extra);
        return { http, g, d };
    };
    let r = veto('{"take":"no","direction":"sell","conviction":10,"noul":"deny"}');
    await r.g.apply([r.d]);
    assert.equal(r.d.decision, 'REJECT');
    assert.match(r.d.reason, /system1 veto: no \(deny\)/);

    r = veto('{"take":"yes","direction":"buy","conviction":45,"noul":"confirm"}');
    await r.g.apply([r.d]);
    assert.equal(r.d.decision, 'REJECT');
    assert.match(r.d.reason, /conviction 45 < 60/);

    r = veto('{"take":"yes","direction":"sell","conviction":90,"noul":"confirm"}');
    await r.g.apply([r.d]);
    assert.equal(r.d.decision, 'REJECT');
    assert.match(r.d.reason, /direction sell conflicts/);

    r = veto('{"take":"yes","direction":"buy","conviction":88,"noul":"confirm"}');
    await r.g.apply([r.d]);
    assert.equal(r.d.decision, 'PASS');
    assert.equal(r.d.reason, undefined);

    // short setup with a sell confirmation passes
    r = veto('{"take":"yes","direction":"sell","conviction":75,"noul":"confirm"}', { direction: 'SHORT' });
    await r.g.apply([r.d]);
    assert.equal(r.d.decision, 'PASS');
});

test('provider failure degrades to "no opinion" and never vetoes', async () => {
    const http = httpVia(new Error('groq is down'));
    const g = gate(http, { SYSTEM1_GATE_MODE: 'on' });
    const d = pass();
    await g.apply([d]);
    assert.equal(d.decision, 'PASS');
    assert.equal(d.system1, undefined);
    assert.equal(g.lastRun.ok, false);
    assert.equal(g.consecutiveErrors, 1);
});

test('no key configured → quiet no-op, no http call', async () => {
    const http = httpVia('{"take":"yes","direction":"buy","conviction":99,"noul":"confirm"}');
    const g = gate(http, { SYSTEM1_API_KEY: '', GROQ_API_KEY: '' });
    const d = pass();
    await g.apply([d]);
    assert.equal(http.calls.length, 0);
    assert.equal(d.system1, undefined);
    assert.equal(g.configured, false);
});

test('daily budget caps the number of verdicts', async () => {
    const http = httpVia('{"take":"yes","direction":"buy","conviction":80,"noul":"confirm"}');
    const g = gate(http, { SYSTEM1_MAX_PER_DAY: 2 });
    const ds = [pass(), pass({ symbol: 'ETHUSD' }), pass({ symbol: 'NIFTY' })];
    await g.apply(ds);
    assert.equal(http.calls.length, 2);
    assert.equal(ds[0].system1.take, 'yes');
    assert.equal(ds[1].system1.take, 'yes');
    assert.equal(ds[2].system1, undefined);
    assert.equal(g.callsToday, 2);
});

test('three consecutive failures put the gate into a cooldown that skips calls', async () => {
    let calls = 0;
    const http = {
        async post() {
            calls += 1;
            throw new Error('burst');
        },
    };
    const g = gate(http, { SYSTEM1_COOLDOWN_MS: 120_000 });
    await g.ask(pass());
    await g.ask(pass());
    assert.equal(g.consecutiveErrors, 2);
    assert.equal(g.cooldownUntil, 0);
    await g.ask(pass());
    // Each failed ask makes two POST attempts: strict schema + json fallback.
    assert.equal(calls, 6);
    assert.ok(g.cooldownUntil > now(), 'cooldownUntil set');
    const v = await g.ask(pass()); // inside cooldown: skipped, no network
    assert.equal(v, null);
    assert.equal(calls, 6);
});

test('non-PASS decisions are never scored', async () => {
    const http = httpVia('{"take":"yes","direction":"buy","conviction":99,"noul":"confirm"}');
    const g = gate(http, { SYSTEM1_GATE_MODE: 'on' });
    const d = pass({ decision: 'NO_SETUP' });
    await g.apply([d]);
    assert.equal(http.calls.length, 0);
    assert.equal(d.system1, undefined);
});

// ── Gemini provider ─────────────────────────────────────────────────────────

/** http mock speaking Gemini's response shape. */
function geminiVia(content) {
    const calls = [];
    const http = {
        calls,
        async post(url, body, opts) {
            calls.push({ url, body, opts });
            if (content instanceof Error) throw content;
            return { data: { candidates: [{ content: { parts: [{ text: content }] } }] } };
        },
    };
    return http;
}

test('gemini: responseSchema request shape + auth header + verdict extraction', async () => {
    const http = geminiVia('{"take":"yes","direction":"buy","conviction":80,"noul":"confirm"}');
    const g = gate(http, { SYSTEM1_PROVIDER: 'gemini', SYSTEM1_GEMINI_API_KEY: 'gm-test-key', SYSTEM1_MODEL: '' });
    const verdict = await g.ask(pass());
    assert.equal(g.provider, 'gemini');
    assert.equal(g.model, 'gemini-3.8-flash');
    assert.deepEqual(verdict, { take: 'yes', direction: 'buy', conviction: 80, noul: 'confirm' });
    assert.equal(http.calls.length, 1);
    const { url, body, opts } = http.calls[0];
    assert.match(url, /generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-3\.8-flash:generateContent$/);
    assert.equal(opts.headers['x-goog-api-key'], 'gm-test-key');
    assert.equal(opts.headers.Authorization, undefined);
    assert.equal(body.headers, undefined);
    assert.equal(body.generationConfig.temperature, 0);
    assert.equal(body.generationConfig.maxOutputTokens, 200);
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    assert.equal(body.generationConfig.responseSchema.type, 'OBJECT');
    assert.deepEqual(body.generationConfig.responseSchema.properties.take.enum, ['yes', 'no', 'noul']);
    assert.deepEqual(body.generationConfig.responseSchema.properties.conviction, { type: 'INTEGER' });
    assert.match(body.contents[0].parts[0].text, /proposed long trade/);
    assert.match(body.systemInstruction.parts[0].text, /System 1 decision model/);
    assert.equal(opts.timeout, 5000);
});

test('gemini: relaxed JSON mode retry when responseSchema is rejected', async () => {
    let n = 0;
    const seen = [];
    const http = {
        async post(url, body) {
            n += 1;
            seen.push({ url, body });
            if (n === 1) throw new Error('responseSchema not supported for this model');
            return { data: { candidates: [{ content: { parts: [{ text: '{"take":"no","direction":"sell","conviction":20,"noul":"deny"}' }] } }] } };
        },
    };
    const g = gate(http, { SYSTEM1_PROVIDER: 'gemini', SYSTEM1_GEMINI_API_KEY: 'gm-test-key' });
    const v = await g.ask(pass());
    assert.equal(n, 2);
    assert.deepEqual(v, { take: 'no', direction: 'sell', conviction: 20, noul: 'deny' });
    assert.equal(seen[1].body.generationConfig.responseSchema, undefined);
    assert.equal(seen[1].body.generationConfig.responseMimeType, 'application/json');
    assert.equal(g.consecutiveErrors, 0);
});

test('gemini: on-mode veto works over the gemini verdict too', async () => {
    const http = geminiVia('{"take":"yes","direction":"buy","conviction":40,"noul":"confirm"}');
    const g = gate(http, { SYSTEM1_PROVIDER: 'gemini', SYSTEM1_GEMINI_API_KEY: 'gm-test-key', SYSTEM1_GATE_MODE: 'on' });
    const d = pass();
    await g.apply([d]);
    assert.equal(d.decision, 'REJECT');
    assert.match(d.reason, /conviction 40 < 60/);
});

test('a transient 503 is retried once on the same attempt shape before giving up', async () => {
    let n = 0;
    const http = {
        async post(url, body) {
            n += 1;
            if (n === 1) throw Object.assign(new Error('503 high demand'), { response: { status: 503 } });
            if (n === 2) return { data: { choices: [{ message: { content: '{"take":"yes","direction":"buy","conviction":71,"noul":"confirm"}' } }] } };
            throw new Error(`unexpected extra call #${n}`);
        },
    };
    const g = gate(http);
    const v = await g.ask(pass());
    assert.equal(n, 2, 'exactly one retry on the strict attempt, then success');
    assert.deepEqual(v, { take: 'yes', direction: 'buy', conviction: 71, noul: 'confirm' });
    assert.equal(g.consecutiveErrors, 0);
});

test('persistent 5xx across both attempts still degrades to no opinion', async () => {
    let n = 0;
    const http = {
        async post() {
            n += 1;
            throw Object.assign(new Error('503 high demand'), { response: { status: 503 } });
        },
    };
    const g = gate(http);
    const v = await g.ask(pass());
    assert.equal(v, null);
    assert.equal(n, 4, '2 tries x 2 attempt shapes');
    assert.equal(g.consecutiveErrors, 1);
    assert.equal(g.lastRun.ok, false);
});

test('gemini provider resolution: key sources + model defaults', () => {
    // dedicated key wins
    assert.equal(gate(null, { SYSTEM1_PROVIDER: 'gemini', SYSTEM1_GEMINI_API_KEY: 'k' }).configured, true);
    // GEMINI_API_KEY fallback
    assert.equal(gate(null, { SYSTEM1_PROVIDER: 'gemini', GEMINI_API_KEY: 'k' }).configured, true);
    // generic SYSTEM1_API_KEY fallback
    assert.equal(gate(null, { SYSTEM1_PROVIDER: 'gemini', SYSTEM1_API_KEY: 'k' }).configured, true);
    // no gemini key source at all
    assert.equal(gate(null, { SYSTEM1_PROVIDER: 'gemini', SYSTEM1_GEMINI_API_KEY: '', GEMINI_API_KEY: '', SYSTEM1_API_KEY: '' }).configured, false);
    // provider default models
    assert.equal(gate(null, { SYSTEM1_MODEL: '' }).model, 'openai/gpt-oss-120b');
    assert.equal(gate(null, { SYSTEM1_PROVIDER: 'gemini', SYSTEM1_MODEL: '' }).model, 'gemini-3.8-flash');
    // explicit override respected
    assert.equal(gate(null, { SYSTEM1_PROVIDER: 'gemini', SYSTEM1_MODEL: 'gemini-2.5-flash' }).model, 'gemini-2.5-flash');
    assert.equal(gate(null, { SYSTEM1_MODEL: 'llama-3.3-70b-versatile' }).model, 'llama-3.3-70b-versatile');
});

// ── trader hook ─────────────────────────────────────────────────────────────

test('trader._applySystem1Gate forwards decisions to the shared gate and survives a missing gate', async () => {
    const world = makeWorld();
    const http = httpVia('{"take":"yes","direction":"buy","conviction":77,"noul":"confirm"}');
    const configured = gate(http, { SYSTEM1_GATE_MODE: 'shadow' });
    const def = { key: 'gold_sweep', code: 'Gold-07', roundTheClock: true };
    const trader = new Trader({
        def,
        strategyId: world.sid,
        strategy: { aiAvailable: () => false },
        ctx: { ...world, cfg: { ...baseCfg }, system1: configured },
    });
    const decisions = [pass()];
    await trader._applySystem1Gate(decisions);
    assert.equal(decisions[0].system1.take, 'yes');

    // A missing gate is the "engine not fully wired" case — must not throw.
    const bare = new Trader({
        def,
        strategyId: world.sid,
        strategy: { aiAvailable: () => false },
        ctx: { ...world, cfg: { ...baseCfg }, system1: undefined },
    });
    await bare._applySystem1Gate([pass()]);
});

// ── config surface ──────────────────────────────────────────────────────────

test('system1 knobs and publicConfig block exist', () => {
    const cfg = loadConfig();
    assert.equal(cfg.SYSTEM1_GATE_MODE, 'shadow');
    assert.ok(['groq', 'gemini'].includes(cfg.SYSTEM1_PROVIDER), 'provider is groq or gemini');
    assert.equal(cfg.SYSTEM1_CONVICTION_MIN, 60);
    assert.equal(typeof cfg.SYSTEM1_MODEL, 'string');
    assert.equal(typeof cfg.SYSTEM1_GEMINI_API_KEY, 'string');
    const pub = publicConfig(cfg);
    assert.equal(pub.system1.provider, cfg.SYSTEM1_PROVIDER);
    assert.equal(pub.system1.mode, cfg.SYSTEM1_GATE_MODE);
    const expectedModel = cfg.SYSTEM1_PROVIDER === 'gemini' ? 'gemini-3.8-flash' : 'openai/gpt-oss-120b';
    assert.equal(pub.system1.model, expectedModel);
    assert.equal(typeof pub.system1.configured, 'boolean');
    // a gemini provider with a key resolves its own model + configured state
    const gpub = publicConfig({ ...cfg, SYSTEM1_PROVIDER: 'gemini', SYSTEM1_GEMINI_API_KEY: 'k' });
    assert.equal(gpub.system1.model, 'gemini-3.8-flash');
    assert.equal(gpub.system1.configured, true);
    // the groq key path is unchanged
    const qpub = publicConfig({ ...cfg, SYSTEM1_PROVIDER: 'groq', SYSTEM1_API_KEY: 'k' });
    assert.equal(qpub.system1.model, 'openai/gpt-oss-120b');
    assert.equal(qpub.system1.configured, true);
});