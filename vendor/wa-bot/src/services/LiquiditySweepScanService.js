/**
 * Liquidity sweep scanner.
 *
 * A liquidity pool is a price level with stop-loss orders resting beneath it —
 * everyone long from that level keeps a stop just under it. A sweep is price
 * trading THROUGH the pool, filling those stops, then closing back above it:
 * the sellers are spent and the move reverses. If price closes below and stays
 * there, the level genuinely broke and there is no trade.
 *
 * The distinction that matters is wick versus close. A sweep pierces the level
 * intrabar and closes back on the original side; a breakdown closes beyond it.
 *
 * Measured on 59 sessions of 5m bars across NIFTY, BANKNIFTY and FINNIFTY,
 * scored on the underlying in R-multiples with a date-split holdout:
 *
 *   pool      profit factor
 *   SWING     1.29    nearest confirmed intraday pivot low
 *   EQUAL     2.31    double bottom, two pivots within 0.25 ATR
 *   ORL       1.15    low of the first 30 minutes
 *   SESSION   1.10    running low of the day
 *   PDL       0.97    previous day's low — DROPPED, failed out of sample
 *
 * Pierce depth gates quality and the relationship is an inverted U, not
 * "deeper is better":
 *
 *   0.10-0.25 ATR   40.0% win   PF 0.83   a poke; no stops actually flushed
 *   0.25-0.50 ATR   47.8% win   PF 1.17
 *   0.50-1.00 ATR   55.1% win   PF 1.53   the real sweep
 *   1.00+ ATR       44.6% win   PF 0.87   a breakdown, not a sweep
 *
 * So 0.25 ATR is a hard floor (below it the setup is measurably negative) and
 * 0.50-1.00 ATR is graded A+. The floor held exactly across the split:
 * PF 1.28 in sample, 1.28 out.
 *
 * Long side only. SWEEP_SHORT decayed to PF 0.94 out of sample and was negative
 * on NIFTY, so it is not scanned.
 *
 * MUST run on 5m data. The same rules on 15m lose money (PF 0.89) because the
 * stop-run and the recovery collapse into a single candle, leaving no reclaim
 * bar to enter on.
 */

import { logger } from '../utils/logger.js';
import {
    computeAtrSeries,
    fetchYahooCandles,
    istDayKey,
    istMinutes,
} from '../utils/yahooCandles.js';

/**
 * Measured per-index performance, same 59-session 5m backtest, quality sweeps
 * only (pierce 0.25-1.30 ATR). Confidence is derived from these rather than
 * being a flat number, because the same setup is not equally good everywhere.
 *
 * SENSEX is included because it is traded here on request; its profit factor
 * is below 1, so the confidence it reports is deliberately low rather than
 * flattering. A number that hides that would be worse than no number.
 */
export const INDEX_STATS = {
    NIFTY: { winRate: 55.7, pf: 1.48 },
    FINNIFTY: { winRate: 51.8, pf: 1.32 },
    BANKNIFTY: { winRate: 45.8, pf: 1.14 },
    SENSEX: { winRate: 42.5, pf: 0.95 },
};

/** Measured win rate by grade, across all indices. */
export const GRADE_WIN_RATE = { 'A+': 57, A: 50 };

/**
 * Confidence for one setup: the grade's measured win rate blended with the
 * index's own. Returns the parts too, so an alert can show its working instead
 * of asserting a number.
 *
 * @param {string} indexKey
 * @param {'A+'|'A'} grade
 */
export function sweepConfidence(indexKey, grade) {
    const idx = INDEX_STATS[String(indexKey || '').toUpperCase()];
    const gradeWr = GRADE_WIN_RATE[grade] ?? 50;
    if (!idx) return { percent: gradeWr, gradeWr, indexWr: null, pf: null, edge: 'unmeasured' };

    const percent = Math.round((gradeWr + idx.winRate) / 2);
    return {
        percent,
        gradeWr,
        indexWr: idx.winRate,
        pf: idx.pf,
        // Below 1.0 the strategy lost money on this index in testing.
        edge: idx.pf >= 1.0 ? 'positive' : 'negative',
    };
}

export const SWEEP_CONFIG = {
    pivotLeft: 3,
    pivotRight: 3,
    minPierceAtr: 0.25, // below this the setup is measurably negative
    maxPierceAtr: 1.30, // above this it is a breakdown
    aPlusLow: 0.5,
    aPlusHigh: 1.0,
    maxReclaimBars: 3,
    t1R: 0.75,
    t2R: 1.25, // beat 2.0R on BOTH win rate and expectancy out of sample
    trailAtr: 1.5,
    firstEntryMin: 9 * 60 + 45, // skip opening auction noise
    lastEntryMin: 14 * 60 + 45,
    minStopAtr: 0.3,
    maxStopAtr: 6.0,
};

/**
 * Confirmed pivot lows. A pivot needs `right` bars after it to exist, so the
 * newest usable one always sits a few bars back — never the current bar.
 */
function pivotLows(candles, left, right) {
    const flags = new Array(candles.length).fill(false);
    for (let i = left; i < candles.length - right; i++) {
        const lo = candles[i].l;
        let isPivot = true;
        let ties = 0;
        for (let j = i - left; j <= i + right; j++) {
            if (candles[j].l < lo) { isPivot = false; break; }
            if (candles[j].l === lo) ties++;
        }
        if (isPivot && ties === 1) flags[i] = true;
    }
    return flags;
}

/**
 * Liquidity pools visible at bar `i`, all formed earlier the same session.
 * Overnight levels behave differently and are handled by the gap, not a sweep.
 */
function poolsAt(candles, i, dayStart, pivotFlags, atr) {
    const pools = [];
    const today = [];

    for (let j = i - SWEEP_CONFIG.pivotRight - 1; j >= dayStart && j >= i - 60; j--) {
        if (pivotFlags[j]) {
            today.push(candles[j].l);
            if (today.length >= 4) break;
        }
    }

    if (today.length) {
        pools.push({ kind: 'SWING', level: Math.max(...today) });
        // Two pivots within a quarter ATR are a double bottom: two layers of
        // stops stacked at the same price, the strongest pool on the chart.
        outer: for (let a = 0; a < today.length; a++) {
            for (let b = a + 1; b < today.length; b++) {
                if (Math.abs(today[a] - today[b]) <= 0.25 * atr) {
                    pools.push({ kind: 'EQUAL', level: Math.max(today[a], today[b]) });
                    break outer;
                }
            }
        }
    }

    if (i - dayStart > 6) {
        let orl = Infinity;
        for (let j = dayStart; j < dayStart + 6; j++) orl = Math.min(orl, candles[j].l);
        if (Number.isFinite(orl)) pools.push({ kind: 'ORL', level: orl });
    }

    if (i > dayStart) {
        let sess = Infinity;
        for (let j = dayStart; j < i; j++) sess = Math.min(sess, candles[j].l);
        if (Number.isFinite(sess)) pools.push({ kind: 'SESSION', level: sess });
    }

    return pools;
}

/**
 * Detect a sweep on the most recent closed bar.
 *
 * @param {import('../utils/yahooCandles.js').Candle[]} candles 5m bars
 * @returns {object|null} setup, or null when the current bar is not a reclaim
 */
export function detectSweep(candles) {
    const n = candles.length;
    if (n < 40) return null;

    const atrSeries = computeAtrSeries(candles, 14);
    const i = n - 1;
    const atr = atrSeries[i];
    if (!Number.isFinite(atr) || atr <= 0) return null;

    const today = istDayKey(candles[i].t);
    let dayStart = i;
    while (dayStart > 0 && istDayKey(candles[dayStart - 1].t) === today) dayStart--;
    if (i - dayStart < 6) return null; // too early in the session to have pools

    const pivots = pivotLows(candles, SWEEP_CONFIG.pivotLeft, SWEEP_CONFIG.pivotRight);
    const pools = poolsAt(candles, i, dayStart, pivots, atr);
    if (!pools.length) return null;

    const close = candles[i].c;
    let best = null;

    for (const pool of pools) {
        if (!Number.isFinite(pool.level) || pool.level >= candles[i].h) continue;

        // How deep did price go through the pool over the last few bars?
        let pierce = 0;
        let sweptLow = null;
        const from = Math.max(dayStart, i - SWEEP_CONFIG.maxReclaimBars);
        for (let k = from; k <= i; k++) {
            if (candles[k].l < pool.level) {
                const d = pool.level - candles[k].l;
                if (d > pierce) { pierce = d; sweptLow = candles[k].l; }
            }
        }
        if (sweptLow == null) continue;

        const depth = pierce / atr;
        if (depth < SWEEP_CONFIG.minPierceAtr || depth > SWEEP_CONFIG.maxPierceAtr) continue;
        // Not reclaimed yet: the level may simply be breaking.
        if (close <= pool.level) continue;

        if (!best || depth > best.pierceAtr) {
            best = { pool: pool.kind, level: pool.level, sweptLow, pierceAtr: depth };
        }
    }
    if (!best) return null;

    const stop = best.sweptLow - 0.1 * atr;
    const entry = close;
    const r = entry - stop;
    if (r <= 0) return null;
    if (r < SWEEP_CONFIG.minStopAtr * atr || r > SWEEP_CONFIG.maxStopAtr * atr) return null;

    const aPlus =
        (best.pierceAtr >= SWEEP_CONFIG.aPlusLow && best.pierceAtr <= SWEEP_CONFIG.aPlusHigh) ||
        best.pool === 'EQUAL';

    return {
        side: 'CE',
        pool: best.pool,
        grade: aPlus ? 'A+' : 'A',
        level: round2(best.level),
        sweptLow: round2(best.sweptLow),
        entry: round2(entry),
        stop: round2(stop),
        rPoints: round2(r),
        pierceAtr: Number(best.pierceAtr.toFixed(2)),
        atr: round2(atr),
        t1: round2(entry + SWEEP_CONFIG.t1R * r),
        t2: round2(entry + SWEEP_CONFIG.t2R * r),
        trailAtr: SWEEP_CONFIG.trailAtr,
        barTime: candles[i].t.toISOString(),
        expectedWinRate: aPlus ? 57 : 50,
    };
}

function round2(v) {
    return Math.round(v * 100) / 100;
}

/** True when the bar is inside the window the edge was measured on. */
export function isTradeableTime(date) {
    const m = istMinutes(date);
    return m >= SWEEP_CONFIG.firstEntryMin && m <= SWEEP_CONFIG.lastEntryMin;
}

/**
 * Scan one index for a live sweep.
 *
 * @param {{ key: string, yahoo: string, label?: string, lot?: number }} spec
 * @param {{ ignoreTimeWindow?: boolean }} [opts]
 */
export async function scanIndexForSweep(spec, opts = {}) {
    const candles = await fetchYahooCandles(spec.yahoo, { interval: '5m', range: '5d' });
    if (!candles.length) {
        logger.debug(`sweep ${spec.key}: no candles`);
        return null;
    }

    const setup = detectSweep(candles);
    if (!setup) return null;

    const last = candles[candles.length - 1];
    if (!opts.ignoreTimeWindow && !isTradeableTime(last.t)) return null;

    const confidence = sweepConfidence(spec.key, setup.grade);
    return {
        index: spec.key,
        label: spec.label || spec.key,
        lot: spec.lot ?? null,
        confidence,
        ...setup,
    };
}

/** WhatsApp-ready alert text. */
export function formatSweepAlert(setup, extra = {}) {
    const poolLabel = {
        SWING: 'swing low',
        EQUAL: 'double bottom (equal lows)',
        ORL: 'opening-range low',
        SESSION: 'session low',
    }[setup.pool] || setup.pool;

    const lines = [
        `*⚡ LIQUIDITY SWEEP — ${setup.label}*  [${setup.grade}]`,
        '',
        `Price pierced the ${poolLabel} at ${fmt(setup.level)} down to ` +
            `${fmt(setup.sweptLow)} (${setup.pierceAtr} ATR), then reclaimed it.`,
        `Stops beneath ${fmt(setup.level)} were filled — sellers exhausted.`,
        '',
        `📌 Entry  *${fmt(setup.entry)}*`,
        `🔻 Stop   ${fmt(setup.stop)}   (${fmt(setup.rPoints)} pts = 1R)`,
        `🎯 T1     ${fmt(setup.t1)}   (0.75R)`,
        `🎯 T2     ${fmt(setup.t2)}   (1.25R)`,
    ];

    if (extra.strike) {
        lines.push(
            '',
            `📊 *${extra.strike.strike} CE*  @  ₹${fmt(extra.strike.ce?.ltp)}` +
                (extra.strike.ce?.oi ? `   OI ${extra.strike.ce.oi.toLocaleString('en-IN')}` : ''),
        );
        if (extra.expiry) lines.push(`📅 Expiry ${extra.expiry}`);
        if (setup.lot && Number.isFinite(extra.strike.ce?.ltp)) {
            lines.push(`💰 ₹${fmt(extra.strike.ce.ltp * setup.lot)} per lot (${setup.lot})`);
        }

        // The exchange keeps serving the last snapshot after the close, so a
        // premium can read as live when it is a settlement figure hours old.
        // Say which it is rather than letting the number speak for itself.
        if (extra.chainAsOf) {
            if (extra.chainLive) {
                lines.push(`_Premium live as of ${extra.chainAsOf}_`);
            } else {
                lines.push(
                    `⚠️ _Premium is a SETTLEMENT price from ${extra.chainAsOf}` +
                        `${extra.chainAgeMinutes ? ` (${formatAge(extra.chainAgeMinutes)} old)` : ''}` +
                        ` — indicative only. Check the live premium before entering._`,
                );
            }
        }
    }

    lines.push(
        '',
        buildConfidenceLine(setup),
        `_Grade ${setup.grade} · trail ${setup.trailAtr} ATR after T1_`,
        '_Not advice. Verify premiums at your broker._',
    );
    return lines.join('\n');
}


/**
 * Confidence line. Shows the two measured inputs behind the number so it can be
 * argued with, and flags an index whose profit factor is below 1 instead of
 * letting a middling percentage imply the setup is merely average there.
 */
function buildConfidenceLine(setup) {
    const c = setup.confidence;
    if (!c) return `_Historical win rate ~${setup.expectedWinRate}%_`;

    const filled = Math.max(0, Math.min(10, Math.round(c.percent / 10)));
    const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
    const parts = [`*Confidence ${c.percent}%*  ${bar}`];

    if (c.indexWr != null) {
        parts.push(`_grade ${c.gradeWr}% · ${setup.index || 'index'} ${c.indexWr}% · PF ${c.pf}_`);
    }
    if (c.edge === 'negative') {
        parts.push('⚠️ _This index tested below break-even (PF < 1). Size accordingly._');
    }
    return parts.join('\n');
}

function formatAge(mins) {
    if (mins < 60) return `${mins}m`;
    const h = Math.floor(mins / 60);
    return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

function fmt(v) {
    if (!Number.isFinite(v)) return '—';
    return v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default { detectSweep, scanIndexForSweep, formatSweepAlert, SWEEP_CONFIG };
