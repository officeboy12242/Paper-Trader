/**
 * Composite strategy ranking.
 *
 *   score = 100 x ( w_pnl x N_pnl + w_pf x N_pf + w_wr x N_wr + w_dd x N_dd + w_n x N_n ) / sum(w)
 *
 *   N_pnl  net P&L, min-max scaled across the strategies being ranked (0..1)
 *   N_pf   min(profit factor, PF_CAP) / PF_CAP           (no trades -> 0)
 *   N_wr   win rate / 100
 *   N_dd   1 - min(max drawdown %, DD_CAP) / DD_CAP      (no trades -> 0)
 *   N_n    min(trades, FULL_SAMPLE) / FULL_SAMPLE         (small samples count for less)
 *
 * Win rate is one input of five. A 90% win rate with a profit factor below 1
 * and a negative net P&L scores low on three of the other four terms.
 * Weights and caps are set by RANK_WEIGHTS / RANK_PF_CAP / RANK_DD_CAP_PCT /
 * RANK_FULL_SAMPLE_TRADES and returned with every ranking so the UI can show them.
 */

export const RANK_FORMULA =
    'score = 100 x (w_pnl*N_pnl + w_pf*N_pf + w_wr*N_wr + w_dd*N_dd + w_n*N_n) / sum(w)';

export function rankingSettings(cfg) {
    return {
        formula: RANK_FORMULA,
        weights: { ...cfg.RANK_WEIGHTS },
        pfCap: cfg.RANK_PF_CAP,
        ddCapPct: cfg.RANK_DD_CAP_PCT,
        fullSampleTrades: cfg.RANK_FULL_SAMPLE_TRADES,
        terms: {
            N_pnl: 'net P&L, min-max scaled across ranked strategies',
            N_pf: `min(profit factor, ${cfg.RANK_PF_CAP}) / ${cfg.RANK_PF_CAP}`,
            N_wr: 'win rate / 100',
            N_dd: `1 - min(max drawdown %, ${cfg.RANK_DD_CAP_PCT}) / ${cfg.RANK_DD_CAP_PCT}`,
            N_n: `min(trades, ${cfg.RANK_FULL_SAMPLE_TRADES}) / ${cfg.RANK_FULL_SAMPLE_TRADES}`,
        },
    };
}

/**
 * @param {{ strategy: object, metrics: object }[]} rows one per strategy, metrics from computeMetrics
 * @param {object} cfg
 * @returns rows sorted by score desc with `rank`, `score`, `components`
 */
export function rankStrategies(rows, cfg) {
    const w = cfg.RANK_WEIGHTS;
    const wSum = Object.values(w).reduce((s, v) => s + v, 0) || 1;
    const pnls = rows.map((r) => r.metrics.netPnl || 0);
    const lo = Math.min(...pnls, 0);
    const hi = Math.max(...pnls, 0);

    const scored = rows.map((r) => {
        const m = r.metrics;
        const has = m.totalTrades > 0;
        const comp = {
            N_pnl: has ? (hi > lo ? ((m.netPnl || 0) - lo) / (hi - lo) : 0.5) : 0,
            N_pf: has ? Math.min(Number.isFinite(m.profitFactor) ? m.profitFactor : m.profitFactor === Infinity ? cfg.RANK_PF_CAP : 0, cfg.RANK_PF_CAP) / cfg.RANK_PF_CAP : 0,
            N_wr: has ? (m.winRate || 0) / 100 : 0,
            N_dd: has ? 1 - Math.min(m.maxDrawdownPct || 0, cfg.RANK_DD_CAP_PCT) / cfg.RANK_DD_CAP_PCT : 0,
            N_n: Math.min(m.totalTrades, cfg.RANK_FULL_SAMPLE_TRADES) / cfg.RANK_FULL_SAMPLE_TRADES,
        };
        const raw = w.netPnl * comp.N_pnl + w.profitFactor * comp.N_pf + w.winRate * comp.N_wr + w.drawdown * comp.N_dd + w.trades * comp.N_n;
        const score = Math.round((100 * raw * 100) / wSum) / 100;
        const components = Object.fromEntries(Object.entries(comp).map(([k, v]) => [k, Math.round(v * 1000) / 1000]));
        return { ...r, score, components, provisional: m.totalTrades < Math.min(5, cfg.RANK_FULL_SAMPLE_TRADES) };
    });

    scored.sort((a, b) => b.score - a.score || (b.metrics.netPnl || 0) - (a.metrics.netPnl || 0) || a.strategy.id - b.strategy.id);
    return scored.map((r, i) => ({ ...r, rank: i + 1 }));
}
