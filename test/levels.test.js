import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planLevels, swings } from '../src/strategies/levels.js';
import { GoldStrategy } from '../src/strategies/goldStrategy.js';
import { makeCfg } from './helpers.js';

const LONG = 'LONG';
const SHORT = 'SHORT';

// ── stop: structural, only ever tightened ────────────────────────────────────

test('a stop wider than the volatility band is pulled in to the ceiling', () => {
    const lv = planLevels({
        direction: LONG, entry: 4000, structuralStop: 3900, // 100 of structure
        atr: 5, atrStopMult: 3, maxStop: 15,                 // band = 15
    });
    assert.equal(lv.risk, 15, 'risk is capped, not taken from structure');
    assert.equal(lv.stop, 3985);
});

test('a stop inside the band is used exactly as the setup drew it', () => {
    const lv = planLevels({
        direction: LONG, entry: 4000, structuralStop: 3992, // 8 of structure
        atr: 20, atrStopMult: 3, maxStop: 15,                // band = 60 -> 15
    });
    assert.equal(lv.stop, 3992, 'never widened beyond the invalidation point');
    assert.equal(lv.risk, 8);
});

test('the stop band follows ATR, so no two volatility regimes share a stop', () => {
    const quiet = planLevels({ direction: LONG, entry: 100, structuralStop: 80, atr: 1, atrStopMult: 3, maxStop: 15 });
    const wild = planLevels({ direction: LONG, entry: 100, structuralStop: 80, atr: 8, atrStopMult: 3, maxStop: 15 });
    assert.equal(quiet.risk, 3, '3 x ATR in a quiet tape');
    assert.equal(wild.risk, 15, 'capped by the hard ceiling in a wild tape');
    assert.ok(quiet.risk < wild.risk, 'the stop varies with the setup');
});

test('SHORT mirrors the stop and target', () => {
    const lv = planLevels({
        direction: SHORT, entry: 4000, structuralStop: 4012,
        atr: 0, structuralTargets: [3960], minRR: 1.5, maxRR: 4,
    });
    assert.equal(lv.stop, 4012);
    assert.equal(lv.target, 3960);
});

// ── target: the nearest level that pays, otherwise no trade ──────────────────

test('the target is the nearest structural level that clears minRR', () => {
    const lv = planLevels({
        direction: LONG, entry: 100, structuralStop: 90, // risk 10
        structuralTargets: [105, 108, 116, 130], minRR: 1.5, maxRR: 4,
    });
    assert.equal(lv.target, 116, 'first level at or beyond 1.5R');
    assert.equal(lv.target2, 130, 'the runner is the next paying level');
    assert.equal(lv.rr, 1.6);
});

test('a setup whose structure all sits under minRR is refused', () => {
    const lv = planLevels({
        direction: LONG, entry: 100, structuralStop: 90, // risk 10, needs 15
        structuralTargets: [105, 108], minRR: 1.5, maxRR: 4,
    });
    assert.equal(lv, null, 'resistance right on top of us: no trade, no loss');
});

test('with nothing ahead the target falls back to minRR x risk', () => {
    const lv = planLevels({
        direction: LONG, entry: 100, structuralStop: 90,
        structuralTargets: [], minRR: 1.5, maxRR: 4,
    });
    assert.equal(lv.target, 115);
    assert.equal(lv.target2, 125, 'runner at the next R, still inside maxRR');
});

test('the target never aims past maxRR x risk', () => {
    const lv = planLevels({
        direction: LONG, entry: 100, structuralStop: 90,
        structuralTargets: [400], minRR: 1.5, maxRR: 4,
    });
    assert.equal(lv.target, 140, 'clamped to 4R');
    assert.equal(lv.rr, 4);
});

test('every planned trade clears the reward:risk gate', () => {
    for (const targets of [[], [116], [105, 116, 130], [400]]) {
        const lv = planLevels({ direction: LONG, entry: 100, structuralStop: 92, structuralTargets: targets, minRR: 1.5, maxRR: 4 });
        assert.ok(lv, `a trade was taken (${targets.join('|')})`);
        assert.ok(lv.rr >= 1.5, `rr ${lv.rr} clears the gate`);
        assert.ok(lv.target > 100, 'target is above entry for a LONG');
        assert.ok(lv.stop < 100, 'stop is below entry for a LONG');
    }
});

test('nonsense input produces no trade rather than broken levels', () => {
    assert.equal(planLevels({ direction: LONG, entry: 100, structuralStop: 100 }), null, 'zero-width stop');
    assert.equal(planLevels({ direction: LONG, entry: NaN, structuralStop: 90 }), null, 'bad entry');
    assert.equal(planLevels({ direction: 'FLAT', entry: 100, structuralStop: 90 }), null, 'bad direction');
});

// ── structural targets ──────────────────────────────────────────────────────

test('swings() finds fractal pivot highs and lows', () => {
    // falls to a trough, spikes to a peak, dips again, recovers
    const bars = [
        { high: 5, low: 5 },
        { high: 4, low: 1 },
        { high: 3, low: 4 },
        { high: 9, low: 3 },
        { high: 2, low: 2 },
        { high: 3, low: 3 },
    ];
    const { highs, lows } = swings(bars, { left: 1, right: 1 });
    assert.deepEqual(highs, [9], 'the spike is higher than its immediate neighbours');
    assert.deepEqual(lows, [1, 2], 'both troughs are lower than their neighbours');
    assert.ok(lows[0] < highs[0], 'the pivot low sits under the pivot high');
});

// ── sizing: one stop-loss can never cost more than MAX_RISK_INR ─────────────

function goldStrategy(overrides = {}) {
    const cfg = makeCfg(overrides);
    return new GoldStrategy({
        def: { key: 'gold_sweep', symbol: 'XAUUSD', prefix: 'GOLD', run: () => null },
        cfg,
        marketData: null,
    });
}

test('a wide stop gets fewer units than a tight one', () => {
    const g = goldStrategy();
    const wide = g._sizing(4000, { entry: 4000, stop: 3985 });   // $15
    const tight = g._sizing(4000, { entry: 4000, stop: 3995 });  // $5
    assert.ok(wide < tight, `wide=${wide} tight=${tight}`);
});

test('the rupee risk of a stop stays under MAX_RISK_INR', () => {
    const cfg = makeCfg();
    const g = goldStrategy();
    const rate = cfg.INR_USD_RATE;
    for (const stopDist of [3, 5, 10, 15, 25]) {
        const qty = g._sizing(4000, { entry: 4000, stop: 4000 - stopDist });
        const riskInr = qty * stopDist * rate;
        assert.ok(
            riskInr <= cfg.MAX_RISK_INR,
            `stop $${stopDist} -> qty ${qty} risks ₹${riskInr} > ₹${cfg.MAX_RISK_INR}`,
        );
    }
});

test('sizing never drops below one unit and still respects the notional', () => {
    const cfg = makeCfg();
    const g = goldStrategy();
    const notional = Math.round((cfg.GOLD_MARGIN_INR * cfg.GOLD_LEVERAGE) / (4000 * cfg.INR_USD_RATE));
    assert.equal(g._sizing(4000, null), notional, 'no setup -> Delta notional size');
    assert.ok(g._sizing(4000, { entry: 4000, stop: 3999.99 }) >= 1, 'never fractional/zero');
});

// ── config guard rails ──────────────────────────────────────────────────────

test('MIN_RR above MAX_RR refuses to boot', () => {
    assert.throws(() => makeCfg({ MIN_RR: 5, MAX_RR: 2 }), /MIN_RR=5 must not exceed MAX_RR=2/);
});

test('the per-trade risk model is exposed on the public config', async () => {
    const { publicConfig } = await import('../src/config.js');
    const c = publicConfig(makeCfg());
    assert.equal(c.riskPlan.minRR, 1.5);
    assert.equal(c.riskPlan.maxRR, 4);
    assert.equal(c.riskPlan.atrStopMult, 3);
    assert.equal(c.riskPlan.maxRiskInr, 3000);
    assert.equal(c.gold.minRR, 1.5, 'the UI reads minRR, not a fixed target');
    assert.equal(c.gold.target, undefined, 'no static target is published any more');
});
