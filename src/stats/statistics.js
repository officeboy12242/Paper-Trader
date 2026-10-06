/**
 * Performance statistics. Pure functions over CLOSED trades of ONE strategy
 * (callers filter by strategy_id; nothing here mixes strategies).
 *
 * Definitions
 *  win / loss      net_pnl > 0 / net_pnl < 0 (net of fees); 0 is breakeven
 *  win rate        wins / total closed trades
 *  gross profit    sum of positive net P&L;  gross loss = |sum of negative net P&L|
 *  profit factor   gross profit / gross loss (Infinity when there are no losses)
 *  max drawdown    largest peak-to-trough fall of the cumulative net P&L curve,
 *                  in rupees, and as % of (capital + peak equity)
 */

import { sessionDate, weekKey, monthKey } from '../market/clock.js';

const r2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : n);

export function computeMetrics(trades, { capital = 500000 } = {}) {
    const closed = trades.filter((t) => t.status === 'CLOSED' && Number.isFinite(t.net_pnl));
    const sorted = [...closed].sort((a, b) => a.exit_time - b.exit_time || a.id - b.id);
    const wins = sorted.filter((t) => t.net_pnl > 0);
    const losses = sorted.filter((t) => t.net_pnl < 0);
    const grossProfit = wins.reduce((s, t) => s + t.net_pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.net_pnl, 0));
    const netPnl = sorted.reduce((s, t) => s + t.net_pnl, 0);
    const fees = sorted.reduce((s, t) => s + (t.fees || 0), 0);
    const grossPnl = sorted.reduce((s, t) => s + (t.gross_pnl || 0), 0);

    let equity = 0;
    let peak = 0;
    let maxDd = 0;
    let maxDdPct = 0;
    for (const t of sorted) {
        equity += t.net_pnl;
        peak = Math.max(peak, equity);
        const dd = peak - equity;
        if (dd > maxDd) maxDd = dd;
        const base = capital + peak;
        if (base > 0) maxDdPct = Math.max(maxDdPct, (dd / base) * 100);
    }

    const holding = sorted.map((t) => t.holding_seconds).filter(Number.isFinite);
    const n = sorted.length;
    return {
        totalTrades: n,
        winningTrades: wins.length,
        losingTrades: losses.length,
        breakevenTrades: n - wins.length - losses.length,
        winRate: n ? r2((wins.length / n) * 100) : null,
        lossRate: n ? r2((losses.length / n) * 100) : null,
        profitFactor: grossLoss > 0 ? r2(grossProfit / grossLoss) : grossProfit > 0 ? Infinity : null,
        grossProfit: r2(grossProfit),
        grossLoss: r2(grossLoss),
        grossPnl: r2(grossPnl),
        netPnl: r2(netPnl),
        fees: r2(fees),
        avgWin: wins.length ? r2(grossProfit / wins.length) : null,
        avgLoss: losses.length ? r2(-grossLoss / losses.length) : null,
        largestWin: wins.length ? r2(Math.max(...wins.map((t) => t.net_pnl))) : null,
        largestLoss: losses.length ? r2(Math.min(...losses.map((t) => t.net_pnl))) : null,
        expectancy: n ? r2(netPnl / n) : null,
        maxDrawdown: r2(maxDd),
        maxDrawdownPct: r2(maxDdPct),
        avgHoldingSeconds: holding.length ? Math.round(holding.reduce((s, v) => s + v, 0) / holding.length) : null,
        bestTrade: wins.length ? pick(sorted.reduce((a, b) => (b.net_pnl > a.net_pnl ? b : a))) : null,
        worstTrade: losses.length ? pick(sorted.reduce((a, b) => (b.net_pnl < a.net_pnl ? b : a))) : null,
    };
}

const pick = (t) => ({ id: t.id, symbol: t.symbol, direction: t.direction, net_pnl: t.net_pnl, exit_reason: t.exit_reason, session_date: t.session_date });

/** Cumulative net P&L after each closed trade. */
export function equityCurve(trades) {
    let eq = 0;
    return trades
        .filter((t) => t.status === 'CLOSED')
        .sort((a, b) => a.exit_time - b.exit_time || a.id - b.id)
        .map((t) => {
            eq += t.net_pnl;
            return { t: t.exit_time, id: t.id, equity: r2(eq), pnl: t.net_pnl };
        });
}

/** Net P&L grouped by IST session date or month. */
export function pnlBy(trades, unit = 'day') {
    const map = new Map();
    for (const t of trades) {
        if (t.status !== 'CLOSED') continue;
        const day = t.session_date || sessionDate(t.exit_time);
        const key = unit === 'month' ? monthKey(day) : unit === 'week' ? weekKey(day) : day;
        const row = map.get(key) || { key, netPnl: 0, trades: 0, wins: 0, losses: 0 };
        row.netPnl += t.net_pnl;
        row.trades += 1;
        if (t.net_pnl > 0) row.wins += 1;
        else if (t.net_pnl < 0) row.losses += 1;
        map.set(key, row);
    }
    return [...map.values()]
        .map((r) => ({ ...r, netPnl: r2(r.netPnl), winRate: r.trades ? r2((r.wins / r.trades) * 100) : null }))
        .sort((a, b) => a.key.localeCompare(b.key));
}

/** Inclusive session-date bounds for a named period. */
export function periodRange(period, now = Date.now()) {
    const today = sessionDate(now);
    if (period === 'daily' || period === 'today') return { from: today, to: today, label: today };
    if (period === 'weekly') {
        const wk = weekKey(today);
        const d = new Date(`${today}T00:00:00Z`);
        const dow = d.getUTCDay() || 7;
        d.setUTCDate(d.getUTCDate() - (dow - 1));
        return { from: d.toISOString().slice(0, 10), to: today, label: wk };
    }
    if (period === 'monthly') return { from: `${monthKey(today)}-01`, to: today, label: monthKey(today) };
    return { from: null, to: null, label: 'ALL' };
}

export function filterPeriod(trades, period, now = Date.now()) {
    const { from, to } = periodRange(period, now);
    return trades.filter((t) => (!from || t.session_date >= from) && (!to || t.session_date <= to));
}
