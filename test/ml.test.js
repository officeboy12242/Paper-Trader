import { test } from 'node:test';
import assert from 'node:assert/strict';

import { trainLogreg, predictLogreg, accuracy, auc, standardizeFit } from '../src/ml/logreg.js';
import { FEATURE_NAMES, featuresFor, venueOf } from '../src/ml/features.js';
import { runTraining, buildDataset, pruneModelVersions } from '../src/ml/trainer.js';
import { scoreModel } from '../src/ml/gate.js';
import { makeCfg, makeWorld, place, bar } from './helpers.js';
import { Trader } from '../src/engine/trader.js';

const DIMS = FEATURE_NAMES.length;

// Deterministic synthetic problem: feature 0 drives the label, no RNG.
function synth(n = 240) {
    const xs = [];
    const ys = [];
    const ts = [];
    const pnls = [];
    for (let i = 0; i < n; i++) {
        const rr = (i % 20) / 4;                        // 0 .. 4.75
        const y = rr + ((i * 37) % 11) / 100 > 2 ? 1 : 0;
        const x = new Array(DIMS).fill(0);
        x[0] = rr;
        x[1] = rr * 2;
        xs.push(x);
        ys.push(y);
        ts.push(1_700_000_000_000 + i * 60_000);
        pnls.push(y ? 2000 : -1500);
    }
    return { xs, ys, ts, pnls, n };
}

// ── logreg ───────────────────────────────────────────────────────────────────

test('logistic regression separates a learnable problem', () => {
    const ds = synth(240);
    const model = trainLogreg(ds.xs, ds.ys);
    assert.ok(accuracy(model, ds.xs, ds.ys) > 0.9, 'fits the training rows');
    assert.ok(auc(model, ds.xs, ds.ys) > 0.9, 'ranks winners above losers');
    assert.ok(predictLogreg(model, ds.xs[ds.ys.indexOf(1)]) > 0.5, 'scores a winner > 0.5');
    assert.equal(model.weights.length, DIMS);
    assert.equal(model.mean.length, DIMS);
});

test('a constant feature cannot divide by zero when standardised', () => {
    const X = [[1, 5], [1, 7], [1, 9]];
    const { mean, std } = standardizeFit(X);
    assert.equal(std[0], 1, 'zero-variance column falls back to 1');
    assert.ok(Number.isFinite(mean[0]));
    assert.ok(!Number.isNaN(predictLogreg(trainLogreg(X, [1, 0, 1]), [1, 6])));
});

test('training rejects a mismatched dataset', () => {
    assert.throws(() => trainLogreg([], []), /empty|mismatched/i);
    assert.throws(() => trainLogreg([[1], [2]], [1]), /rows vs/i);
});

// ── features ─────────────────────────────────────────────────────────────────

test('the feature vector is always the same length, whatever is missing', () => {
    assert.equal(featuresFor({}).length, DIMS, 'no inputs at all');
    assert.equal(featuresFor({ ts: Date.now(), symbol: 'XAUUSD' }).length, DIMS);
    assert.equal(featuresFor({ ts: Date.now(), symbol: 'RELIANCE', direction: 'LONG', entry: 100, stop: 95, target: 115, setupScore: 80, confluence: 60 }).length, DIMS);
    assert.ok(featuresFor({ ts: 1_700_000_000_000, symbol: 'X' }).every(Number.isFinite));
    assert.deepEqual(featuresFor({ ts: 1_700_000_000_000, symbol: 'X' }), featuresFor({ ts: 1_700_000_000_000, symbol: 'X' }), 'deterministic');
});

test('reward:risk is direction-agnostic — long and short of the same setup agree', () => {
    const long = featuresFor({ entry: 100, stop: 95, target: 115, direction: 'LONG' });
    const short = featuresFor({ entry: 100, stop: 105, target: 85, direction: 'SHORT' });
    assert.equal(long[0], 3);       // 15 / 5
    assert.equal(short[0], 3);      // 15 / 5
    assert.equal(long[2], 1);
    assert.equal(short[2], -1);
});

test('bar features are neutral placeholders, flagged by hasBars, when there are no bars', () => {
    const none = featuresFor({ bars: null });
    assert.equal(none[12], 0, 'hasBars = 0');
    assert.equal(none[13], 0, 'vol unknown -> 0');
    assert.equal(none[15], 0.5, 'position in range unknown -> neutral');

    const bars = Array.from({ length: 40 }, (_, i) => ({ open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i + (i % 3), volume: 1000 }));
    const withBars = featuresFor({ bars });
    assert.equal(withBars[12], 1, 'hasBars = 1');
    assert.ok(withBars[13] > 0, 'vol measured');
    assert.ok(withBars[15] >= 0 && withBars[15] <= 1, 'position in range is a ratio');
    assert.ok(withBars[14] !== 0, 'a rising window has a trend');
});

test('venue one-hot puts gold, ETH and NSE in exactly one bucket', () => {
    assert.equal(venueOf('XAUUSD'), 'gold');
    assert.equal(venueOf('gold'), 'gold');
    assert.equal(venueOf('ETHUSD'), 'eth');
    assert.equal(venueOf('RELIANCE'), 'nse');
    for (const s of ['XAUUSD', 'ETHUSD', 'SBIN']) {
        const v = featuresFor({ symbol: s });
        assert.equal(v[9] + v[10] + v[11], 1, `${s} lands in one venue`);
    }
});

test('time features are cyclic and land inside the unit circle', () => {
    const morning = featuresFor({ ts: Date.UTC(2026, 9, 6, 4, 30) });   // 10:00 IST
    const evening = featuresFor({ ts: Date.UTC(2026, 9, 6, 17, 30) });  // 23:00 IST
    for (const v of [morning, evening]) {
        assert.ok(Math.hypot(v[5], v[6]) <= 1.0001, 'hour angle is on the circle');
        assert.ok(Math.hypot(v[7], v[8]) <= 1.0001, 'day angle is on the circle');
    }
    assert.notDeepEqual(morning.slice(5, 7), evening.slice(5, 7), 'different times differ');
});

// ── dataset ──────────────────────────────────────────────────────────────────

test('buildDataset labels each closed trade by its rupee outcome', async () => {
    const w = makeWorld({ SLIPPAGE_BPS: 0, TRAILING_ENABLED: 'false' });
    w.marketData.getBars = async () => (w.feed.bars.get('SBIN') || []).filter((b) => b.ts <= w.clock.t);
    place(w, { symbol: 'SBIN', direction: 'LONG', orderType: 'MARKET', referencePrice: 1000, entry: 1000, stop: 990, target: 1100 });
    w.feed.set('SBIN', [bar('10:01', 1000, 1001, 999, 1000), bar('10:02', 1000, 1101, 1000, 1100)]);
    w.clock.set('10:03');
    await w.positions.monitor();

    const t = w.db.searchTrades({}).rows[0];
    assert.equal(t.status, 'CLOSED');
    assert.ok(t.net_pnl > 0, 'this one won');

    const ds = buildDataset(w.db);
    assert.equal(ds.n, 1);
    assert.equal(ds.ys[0], 1, 'a winning trade labels 1');
    assert.equal(ds.pnls[0], t.net_pnl);
    assert.equal(ds.xs[0].length, DIMS);
});

// ── the nightly run ──────────────────────────────────────────────────────────

test('nothing trains until there are enough closed trades', () => {
    const w = makeWorld();
    const s = runTraining({ db: w.db, cfg: makeCfg(), dataset: buildDataset(w.db) });
    assert.equal(s.ran, false);
    assert.equal(s.promoted, false);
    assert.match(s.reason, /not enough closed trades: 0 \/ 100/);
    assert.equal(w.db.listModelVersions(10).length, 0, 'nothing was written');
});

test('a degenerate label set is refused even when it is large', () => {
    const ds = synth(240);
    ds.ys = ds.ys.map(() => 1);
    const s = runTraining({ db: makeWorld().db, cfg: makeCfg(), dataset: ds });
    assert.equal(s.ran, false);
    assert.match(s.reason, /degenerate labels/);
});

test('a window too small to test honestly is refused', () => {
    const cfg = makeCfg({ ML_MIN_TEST: 100 });
    const s = runTraining({ db: makeWorld().db, cfg, dataset: synth(200) }); // 60 in the test window < 100
    assert.equal(s.ran, false);
    assert.match(s.reason, /window too small/);
});

test('a model that beats the walk-forward test is promoted', () => {
    const db = makeWorld().db;
    const cfg = makeCfg();
    const s = runTraining({ db, cfg, dataset: synth(240) });
    assert.equal(s.ran, true);
    assert.equal(s.promoted, true, s.reason);
    assert.ok(s.testAcc >= cfg.ML_MIN_ACC, `test accuracy ${s.testAcc}`);
    assert.ok(s.rejectedPnl <= 0, 'the trades it would veto lost money');
    assert.ok(s.retainedPnl >= s.totalPnl, 'vetoing only added rupees');
    assert.ok(s.testAuc > 0.8, `auc ${s.testAuc}`);

    const inForce = db.currentModel();
    assert.ok(inForce, 'the promoted model is queryable');
    assert.equal(inForce.sample_size, 240);
    assert.equal(inForce.weights.length, DIMS);
    assert.equal(inForce.featureNames.length, DIMS);
    assert.equal(inForce.promoted, true);
});

test('an identical re-run is held back — it cannot beat its own incumbent', () => {
    const db = makeWorld().db;
    const cfg = makeCfg();
    runTraining({ db, cfg, dataset: synth(240) });
    const again = runTraining({ db, cfg, dataset: synth(240) });
    assert.equal(again.ran, true);
    assert.equal(again.promoted, false, 'equal accuracy is not better than equal accuracy');
    assert.match(again.reason, /not better than incumbent/);
    assert.equal(db.currentModel().id, 1, 'the incumbent stays in force');
    assert.equal(db.listModelVersions(10).length, 2, 'the held-back run is still recorded');
});

test('pruning keeps the model in force no matter how many failures follow', () => {
    const db = makeWorld().db;
    const base = {
        trainedThrough: 1, sampleSize: 10, trainSize: 7, testSize: 3,
        featureNames: FEATURE_NAMES,
        model: { weights: new Array(DIMS).fill(0), mean: new Array(DIMS).fill(0), std: new Array(DIMS).fill(1), bias: 0 },
        metrics: { testAcc: 0.5 },
        note: 'x',
    };
    for (let i = 1; i <= 6; i++) db.insertModelVersion({ ...base, createdAt: i, promoted: i === 2 });

    const removed = pruneModelVersions(db, 3);
    assert.equal(removed, 2, 'only the two oldest losers went');
    assert.ok(db.currentModel(), 'the promoted model survived');
    assert.equal(db.listModelVersions(100).length, 4);
});

// ── the gate at decision time ────────────────────────────────────────────────

const modelOf = (bias) => ({
    weights: new Array(DIMS).fill(0),
    mean: new Array(DIMS).fill(0),
    std: new Array(DIMS).fill(1),
    bias,
});
const HATE = modelOf(-5);   // p ~ 0.007
const LOVE = modelOf(5);    // p ~ 0.993

const decision = () => ({
    decision: 'PASS',
    symbol: 'ETHUSD',
    direction: 'SHORT',
    setup: { entry: 2700, stop: 2715, target: 2655, score: 70 },
    confluence: 55,
    bars: null,
});

function runGate(mode, model, d = decision(), threshold = 0.45) {
    const fake = {
        code: 'Strategy-99',
        ctx: { cfg: { ML_GATE_MODE: mode, ML_GATE_THRESHOLD: threshold }, ml: { model }, now: () => 1_700_000_000_000, logger: { warn() {} } },
    };
    Trader.prototype._applyModelGate.call(fake, [d]);
    return d;
}

test('shadow mode scores but never vetoes', () => {
    const d = runGate('shadow', HATE);
    assert.equal(d.decision, 'PASS', 'a score alone changes nothing');
    assert.ok(d.modelScore < 0.45, `recorded ${d.modelScore}`);
});

test('on mode vetoes below the threshold and keeps everything else', () => {
    assert.equal(runGate('on', HATE).decision, 'REJECT');
    assert.match(runGate('on', HATE).reason, /model gate/);
    assert.equal(runGate('on', LOVE).decision, 'PASS', 'a confident setup passes');
    assert.equal(runGate('off', HATE).decision, 'PASS', 'off means untouched');
});

test('without a promoted model the gate has no opinion at all', () => {
    assert.equal(runGate('on', null).decision, 'PASS');
    assert.equal(runGate('on', null).modelScore, undefined, 'no score is invented');
    assert.equal(scoreModel(null, {}), null);
    assert.equal(scoreModel({ weights: [], mean: [], std: [], bias: 0 }, {}), null, 'an empty model is not a model');
    assert.ok(scoreModel(LOVE, {}) > 0.9);
});

test('the gate cannot break a scan — a malformed model degrades to no opinion', () => {
    const broken = { weights: [1, 2], mean: 'nope', std: null, bias: 0 };
    assert.equal(scoreModel(broken, { symbol: 'ETHUSD' }), null);
    const d = runGate('on', broken);
    assert.equal(d.decision, 'PASS', 'a broken model never blocks');
});

test('off-mode decisions are left completely alone', () => {
    for (const kind of ['REJECT', 'NO_SETUP', 'ERROR']) {
        const d = { decision: kind, symbol: 'X' };
        runGate('on', HATE, d);
        assert.equal(d.decision, kind, `${kind} is not re-scored`);
        assert.equal(d.modelScore, undefined);
    }
});
