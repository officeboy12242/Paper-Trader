import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCfg } from './helpers.js';
import { computeMetrics, equityCurve, pnlBy } from '../src/stats/statistics.js';
import { rankStrategies } from '../src/stats/ranking.js';

let seq = 0;
const tr = (net, { day = '2026-10-06', hold = 600, gross = net + 40, fees = 40 } = {}) => ({
    id: ++seq, status: 'CLOSED', net_pnl: net, gross_pnl: gross, fees, holding_seconds: hold, exit_time: 1_000_000 + seq * 1000, session_date: day, symbol: 'X', direction: 'LONG', exit_reason: 'TARGET',
});

test('win rate, P&L and averages are correct', () => {
    const m = computeMetrics([tr(100), tr(200), tr(300), tr(-150)], { capital: 100000 });
    assert.equal(m.totalTrades, 4);
    assert.equal(m.winningTrades, 3);
    assert.equal(m.losingTrades, 1);
    assert.equal(m.winRate, 75);
    assert.equal(m.lossRate, 25);
    assert.equal(m.netPnl, 450);
    assert.equal(m.grossProfit, 600);
    assert.equal(m.grossLoss, 150);
    assert.equal(m.profitFactor, 4);
    assert.equal(m.avgWin, 200);
    assert.equal(m.avgLoss, -150);
    assert.equal(m.largestWin, 300);
    assert.equal(m.largestLoss, -150);
    assert.equal(m.fees, 160);
    assert.equal(m.avgHoldingSeconds, 600);
});

test('max drawdown is the largest peak-to-trough fall of cumulative net P&L', () => {
    const m = computeMetrics([tr(100), tr(-50), tr(-80), tr(200), tr(-60)], { capital: 1000 });
    // equity 100, 50, -30, 170, 110 -> worst fall 100 -> -30 = 130
    assert.equal(m.maxDrawdown, 130);
    assert.equal(m.maxDrawdownPct, Math.round((130 / 1100) * 10000) / 100);
    assert.deepEqual(equityCurve([tr(10), tr(-5)]).map((p) => p.equity), [10, 5]);
});

test('no trades gives empty metrics, not zeros that pretend to be results', () => {
    const m = computeMetrics([]);
    assert.equal(m.totalTrades, 0);
    assert.equal(m.winRate, null);
    assert.equal(m.profitFactor, null);
});

test('daily and monthly P&L grouping', () => {
    const rows = pnlBy([tr(100, { day: '2026-10-05' }), tr(-40, { day: '2026-10-05' }), tr(70, { day: '2026-11-02' })], 'month');
    assert.deepEqual(rows.map((r) => [r.key, r.netPnl, r.trades]), [['2026-10', 60, 2], ['2026-11', 70, 1]]);
});

test('ranking: a 90% win rate with one huge loss does not rank first', () => {
    const cfg = makeCfg();
    const a = [...Array(9)].map(() => tr(100)).concat([tr(-5000)]); // 90% WR, net -4100
    const b = [...Array(5)].map(() => tr(800)).concat([...Array(5)].map(() => tr(-300))); // 50% WR, net +2500
    const ranked = rankStrategies([
        { strategy: { id: 1, code: 'A' }, metrics: computeMetrics(a, { capital: 500000 }) },
        { strategy: { id: 2, code: 'B' }, metrics: computeMetrics(b, { capital: 500000 }) },
    ], cfg);
    assert.equal(ranked[0].strategy.code, 'B');
    assert.equal(ranked[0].rank, 1);
    assert.ok(ranked[0].score > ranked[1].score);
    assert.equal(ranked[1].metrics.winRate, 90);
});

test('ranking weights are configurable and change the order', () => {
    const fast = [...Array(10)].map(() => tr(50)); // 100% WR, small P&L
    const big = [tr(3000), tr(-500), tr(-500)]; // 33% WR, larger P&L
    const rows = [
        { strategy: { id: 1, code: 'FAST' }, metrics: computeMetrics(fast) },
        { strategy: { id: 2, code: 'BIG' }, metrics: computeMetrics(big) },
    ];
    const byPnl = rankStrategies(rows, makeCfg({ RANK_WEIGHTS: 'netPnl:1,profitFactor:0,winRate:0,drawdown:0,trades:0' }));
    assert.equal(byPnl[0].strategy.code, 'BIG');
    const byWr = rankStrategies(rows, makeCfg({ RANK_WEIGHTS: 'netPnl:0,profitFactor:0,winRate:1,drawdown:0,trades:0' }));
    assert.equal(byWr[0].strategy.code, 'FAST');
});

test('strategies with no trades score zero and are marked provisional', () => {
    const r = rankStrategies([{ strategy: { id: 1 }, metrics: computeMetrics([]) }], makeCfg());
    assert.equal(r[0].score, 0);
    assert.equal(r[0].provisional, true);
});
