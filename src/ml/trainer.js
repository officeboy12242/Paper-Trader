/**
 * Nightly self-training (the "in-process trainer" option).
 *
 * Reads closed trades out of SQLite — the same file the engine writes to —
 * rebuilds the feature vector each one had at decision time, and fits a
 * logistic-regression gate on a forward-chaining split.
 *
 * Three things stop this from becoming a liability:
 *
 *  1. It refuses to run below ML_MIN_TRADES closed trades. Training on a
 *     handful of outcomes memorises them; until the sample exists the honest
 *     answer is "no model".
 *  2. A candidate is only promoted when it beats a walk-forward test — it has
 *     to clear ML_MIN_ACC *and* the trades it would veto must have lost money
 *     in aggregate (a gate that rejects winners destroys value faster than no
 *     gate at all) *and* beat the incumbent's test accuracy.
 *  3. The gate itself never runs without a promoted model, and every call is
 *     wrapped so a bad row cannot block trading.
 */

import { trainLogreg, predictLogreg, accuracy, logLoss, auc } from './logreg.js';
import { FEATURE_NAMES, featuresFor } from './features.js';

const safeParse = (v) => {
    if (v == null) return null;
    if (typeof v === 'object') return v;
    try {
        return JSON.parse(v);
    } catch {
        return null;
    }
};

/**
 * Closed trades joined back to the signal that produced them, so the features
 * are recomputed from the same `featureBars` the decision saw.
 * @returns {{xs:number[][], ys:number[], ts:number[], pnls:number[], n:number}}
 */
export function buildDataset(db) {
    const xs = [];
    const ys = [];
    const ts = [];
    const pnls = [];
    for (const r of db.closedTradesWithSignals()) {
        const meta = safeParse(r.signal_metadata);
        xs.push(featuresFor({
            ts: r.entry_time ?? r.exit_time ?? Date.now(),
            symbol: r.symbol,
            direction: r.direction,
            entry: r.entry_price,
            stop: r.stop_loss_price,
            target: r.target_price,
            setupScore: meta?.setup?.score ?? null,
            confluence: meta?.confluence ?? null,
            bars: meta?.featureBars ?? null,
        }));
        ys.push(Number(r.net_pnl) > 0 ? 1 : 0);
        ts.push(Number(r.exit_time ?? r.entry_time ?? 0));
        pnls.push(Number(r.net_pnl) || 0);
    }
    return { xs, ys, ts, pnls, n: xs.length };
}

/** Chronological 70/30 split — the test window is always later than training. */
function split(ds) {
    const order = ds.xs.map((_, i) => i).sort((a, b) => ds.ts[a] - ds.ts[b]);
    const trainEnd = Math.floor(order.length * 0.7);
    const idx = (list) => list.map((i) => [ds.xs[i], ds.ys[i], ds.pnls[i]]);
    const [tr, te] = [idx(order.slice(0, trainEnd)), idx(order.slice(trainEnd))];
    return {
        Xtr: tr.map((r) => r[0]), ytr: tr.map((r) => r[1]),
        Xte: te.map((r) => r[0]), yte: te.map((r) => r[1]), pnlte: te.map((r) => r[2]),
        through: ds.ts[order[trainEnd - 1]] ?? null,
    };
}

const skip = (reason, extra = {}) => ({ ran: false, promoted: false, reason, ...extra });

/**
 * One training run. Returns a summary the engine logs and shows on the
 * dashboard; never throws on bad data.
 *
 * @param {{db:object, cfg:object, now?:() => number, dataset?:object}} opts
 */
export function runTraining({ db, cfg, now = Date.now, dataset = null }) {
    const at = now();
    const ds = dataset ?? buildDataset(db);

    if (ds.n < cfg.ML_MIN_TRADES) {
        return skip(`not enough closed trades: ${ds.n} / ${cfg.ML_MIN_TRADES}`, { sampleSize: ds.n, at });
    }
    const winners = ds.ys.reduce((a, b) => a + b, 0);
    if (winners === 0 || winners === ds.n) {
        return skip(`degenerate labels: ${winners}/${ds.n} wins — nothing to discriminate`, { sampleSize: ds.n, at });
    }

    const sp = split(ds);
    if (sp.Xte.length < cfg.ML_MIN_TEST || sp.Xtr.length < cfg.ML_MIN_TEST) {
        return skip(`window too small to test honestly: ${sp.Xtr.length} train / ${sp.Xte.length} test, needs ${cfg.ML_MIN_TEST} each`, { sampleSize: ds.n, at });
    }

    const model = trainLogreg(sp.Xtr, sp.ytr);

    const testAcc = accuracy(model, sp.Xte, sp.yte);
    const testAuc = auc(model, sp.Xte, sp.yte);
    const testLoss = logLoss(model, sp.Xte, sp.yte);
    const trainAcc = accuracy(model, sp.Xtr, sp.ytr);

    // What it would veto, measured in rupees. This is the number that matters:
    // accuracy is worthless if the trades it drops were the profitable ones.
    const totalPnl = sp.pnlte.reduce((a, b) => a + b, 0);
    let rejectedPnl = 0;
    for (let i = 0; i < sp.Xte.length; i++) if (predictLogreg(model, sp.Xte[i]) < 0.5) rejectedPnl += sp.pnlte[i];
    const retainedPnl = totalPnl - rejectedPnl;

    // Majority-class baseline: predict the common outcome every time.
    const trainWins = sp.ytr.reduce((a, b) => a + b, 0);
    const baselineAcc = Math.max(trainWins, sp.ytr.length - trainWins) / sp.ytr.length;

    const incumbent = db.currentModel();
    const incumbentAcc = incumbent?.metrics?.testAcc ?? null;

    const fails = [];
    if (testAcc < cfg.ML_MIN_ACC) fails.push(`test accuracy ${testAcc.toFixed(3)} < ${cfg.ML_MIN_ACC}`);
    if (rejectedPnl > 0) fails.push(`would veto +₹${Math.round(rejectedPnl)} of winners`);
    if (incumbentAcc != null && testAcc <= incumbentAcc) fails.push(`not better than incumbent ${incumbentAcc.toFixed(3)}`);

    const promoted = fails.length === 0;
    const metrics = { trainAcc, testAcc, testAuc, testLoss, baselineAcc, totalPnl, rejectedPnl, retainedPnl, incumbentAcc };

    const modelId = db.insertModelVersion({
        createdAt: at,
        trainedThrough: sp.through,
        sampleSize: ds.n,
        trainSize: sp.Xtr.length,
        testSize: sp.Xte.length,
        featureNames: FEATURE_NAMES,
        model,
        metrics,
        promoted,
        note: promoted ? 'promoted' : `held back: ${fails.join('; ')}`,
    });
    if (promoted) pruneModelVersions(db, cfg.ML_KEEP_VERSIONS);

    return {
        ran: true,
        promoted,
        reason: promoted ? 'promoted' : fails.join('; '),
        modelId,
        sampleSize: ds.n,
        trainSize: sp.Xtr.length,
        testSize: sp.Xte.length,
        trainAcc,
        testAcc,
        testAuc,
        testLoss,
        baselineAcc,
        totalPnl,
        rejectedPnl,
        retainedPnl,
        incumbentAcc,
        at,
    };
}

/**
 * Keep the last `keep` runs plus the model currently in force — a string of
 * failed nights must never evict the one good model.
 */
export function pruneModelVersions(db, keep = 12) {
    const rows = db.listModelVersions(1000);
    const keepIds = new Set();
    const current = rows.find((r) => r.promoted);
    if (current) keepIds.add(current.id);
    for (const r of rows.slice(0, Math.max(1, keep))) keepIds.add(r.id);
    let removed = 0;
    for (const r of rows) {
        if (!keepIds.has(r.id)) {
            db.deleteModelVersion(r.id);
            removed += 1;
        }
    }
    return removed;
}
