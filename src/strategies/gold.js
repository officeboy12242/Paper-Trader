/**
 * Gold (XAUUSD) 24-hour strategy presets.
 *
 * These run alongside the six WA-BOT NSE traders as ordinary registry entries
 * with `roundTheClock: true`, so they scan on a fixed interval day and night
 * with no EOD square-off. Each returns candidates in the same shape the
 * SourceStrategy produces, and each owns its own virtual trader, stats and DB
 * rows exactly like a WA-BOT source.
 *
 * Levels convention:
 *   stop   : the setup's own invalidation point, scaled to ATR and capped by
 *            `<PREFIX>_STOP_RISK` — derived per trade, never a fixed number
 *   target : the nearest structural level that pays at least MIN_RR times that
 *            trade's risk; setups that cannot pay are refused
 *   sizing : ₹ margin x leverage for notional, then cut down so one stop can
 *            never cost more than MAX_RISK_INR
 */

import { LONG, SHORT } from '../engine/risk.js';
import { sessionDate } from '../market/clock.js';
import { planLevels, swings } from './levels.js';

const avg = (xs) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);

/** EMA seeded from the SMA of the first `period` closes. */
export function ema(values, period) {
    const out = [];
    const k = 2 / (period + 1);
    let prev = null;
    for (let i = 0; i < values.length; i++) {
        if (i < period - 1) { out.push(null); continue; }
        if (i === period - 1) prev = avg(values.slice(0, period));
        else prev = values[i] * k + prev * (1 - k);
        out.push(prev);
    }
    return out;
}

export function atr(bars, period = 14) {
    const trs = [];
    for (let i = 1; i < bars.length; i++) {
        const b = bars[i], p = bars[i - 1];
        trs.push(Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close)));
    }
    const out = new Array(bars.length).fill(null);
    for (let i = 0; i < trs.length; i++) {
        if (i < period - 1) continue;
        out[i + 1] = avg(trs.slice(i - period + 1, i + 1));
    }
    return out;
}

/** ATR of the latest bar — the volatility the levels are sized against. 0 = no history. */
const lastAtr = (bars, period = 14) => {
    if (bars.length < period + 1) return 0;
    const a = atr(bars, period);
    return a[a.length - 1] ?? 0;
};

/**
 * Liquidity sweep (smart money concept): price sweeps a recent swing extreme
 * and closes back inside the range — trapped liquidity -> reversal entry.
 *
 * Tuned for frequency: a sweep only needs to touch the extreme and close back
 * inside — no trend filter, minimal depth, any rejection strength. This forms
 * setups often. Stop beyond the sweep wick (bounded), target then trail.
 */
export function liquiditySweep(bars, opts = {}) {
    const { lookback = 60, stopRisk = 15, minRisk = 4, minSweep = 0.5, ...plan } = opts;
    if (bars.length < lookback + 30) return null;
    const today = bars.slice(-lookback - 30, -30); // the window swept through
    const recent = bars.slice(-30);
    const swingHigh = Math.max(...today.map((b) => b.high));
    const swingLow = Math.min(...today.map((b) => b.low));
    const a = lastAtr(bars);
    const pivots = swings(recent);

    for (let i = recent.length - 6; i >= 0; i--) {
        const b = recent[i];
        const closeBack = b.close > swingLow && b.close < swingHigh;
        if (b.low < swingLow && b.close > swingLow && closeBack) {
            // Bullish sweep of the lows.
            const depth = swingLow - b.low;
            if (depth < minSweep) continue;
            const entry = b.close;
            const structuralStop = b.low - 0.5;
            if (entry - structuralStop < minRisk) continue;
            const lv = planLevels({
                direction: LONG, entry, structuralStop, atr: a,
                structuralTargets: [...pivots.highs, swingHigh], maxStop: stopRisk, ...plan,
            });
            if (!lv) continue;
            return { direction: LONG, entry: round2(entry), stop: lv.stop, target: lv.target, target2: lv.target2, score: 75, checks: { sweepLow: true, closeBackInside: true, depth: round2(depth), atr: round2(a), rr: lv.rr } };
        }
        if (b.high > swingHigh && b.close < swingHigh && closeBack) {
            const depth = b.high - swingHigh;
            if (depth < minSweep) continue;
            const entry = b.close;
            const structuralStop = b.high + 0.5;
            if (structuralStop - entry < minRisk) continue;
            const lv = planLevels({
                direction: SHORT, entry, structuralStop, atr: a,
                structuralTargets: [...pivots.lows, swingLow], maxStop: stopRisk, ...plan,
            });
            if (!lv) continue;
            return { direction: SHORT, entry: round2(entry), stop: lv.stop, target: lv.target, target2: lv.target2, score: 75, checks: { sweepHigh: true, closeBackInside: true, depth: round2(depth), atr: round2(a), rr: lv.rr } };
        }
    }
    return null;
}

/** Trend pullback: EMA20/EMA50 stack, pullback tags EMA20, close back above. */
export function emaPullback(bars, opts = {}) {
    const { fast = 20, slow = 50, stopRisk = 15, minRisk = 4, ...plan } = opts;
    if (bars.length < slow + 30) return null;
    const closes = bars.map((b) => b.close);
    const ef = ema(closes, fast);
    const es = ema(closes, slow);
    const recent = bars.slice(-6);
    const pivots = swings(bars.slice(-40));
    const a = lastAtr(bars);
    for (let i = recent.length - 3; i < recent.length - 1; i++) {
        const idx = bars.length - recent.length + i;
        const b = bars[idx];
        const trendUp = ef[idx] > es[idx] && ef[idx - 1] > es[idx - 1];
        const trendDown = ef[idx] < es[idx] && ef[idx - 1] < es[idx - 1];
        if (trendUp && b.low <= ef[idx] && b.close > ef[idx]) {
            const entry = b.close;
            const structuralStop = b.low - 1;
            if (entry - structuralStop < minRisk) continue;
            const lv = planLevels({
                direction: LONG, entry, structuralStop, atr: a,
                structuralTargets: pivots.highs, maxStop: stopRisk, ...plan,
            });
            if (!lv) continue;
            return { direction: LONG, entry: round2(entry), stop: lv.stop, target: lv.target, target2: lv.target2, score: 70, checks: { emaStack: true, emaTag: true, atr: round2(a), rr: lv.rr } };
        }
        if (trendDown && b.high >= ef[idx] && b.close < ef[idx]) {
            const entry = b.close;
            const structuralStop = b.high + 1;
            if (structuralStop - entry < minRisk) continue;
            const lv = planLevels({
                direction: SHORT, entry, structuralStop, atr: a,
                structuralTargets: pivots.lows, maxStop: stopRisk, ...plan,
            });
            if (!lv) continue;
            return { direction: SHORT, entry: round2(entry), stop: lv.stop, target: lv.target, target2: lv.target2, score: 70, checks: { emaStack: true, emaTag: true, atr: round2(a), rr: lv.rr } };
        }
    }
    return null;
}

/** Donchian breakout: close beyond 30-bar extreme with ATR-bounded stop. */
export function donchianBreakout(bars, opts = {}) {
    const { period = 30, atrPeriod = 14, stopRisk = 15, minRisk = 4, ...plan } = opts;
    if (bars.length < period + atrPeriod + 10) return null;
    const atrx = atr(bars, atrPeriod);
    const window = bars.slice(-period - 1, -1);
    const high = Math.max(...window.map((b) => b.high));
    const low = Math.min(...window.map((b) => b.low));
    const last = bars[bars.length - 1];
    const a = atrx[atrx.length - 1] ?? 0;
    if (!(a > 0)) return null;
    // Measured move: the channel's own height, projected from the breakout.
    const span = high - low;
    if (last.close > high) {
        const entry = last.close;
        const structuralStop = entry - Math.min(stopRisk, 1.5 * a);
        if (entry - structuralStop < minRisk) return null;
        const lv = planLevels({
            direction: LONG, entry, structuralStop, atr: a,
            structuralTargets: [entry + span, entry + span * 1.6], maxStop: stopRisk, ...plan,
        });
        if (!lv) return null;
        return { direction: LONG, entry: round2(entry), stop: lv.stop, target: lv.target, target2: lv.target2, score: 68, checks: { donchianHigh: true, atr: round2(a), rr: lv.rr } };
    }
    if (last.close < low) {
        const entry = last.close;
        const structuralStop = entry + Math.min(stopRisk, 1.5 * a);
        if (structuralStop - entry < minRisk) return null;
        const lv = planLevels({
            direction: SHORT, entry, structuralStop, atr: a,
            structuralTargets: [entry - span, entry - span * 1.6], maxStop: stopRisk, ...plan,
        });
        if (!lv) return null;
        return { direction: SHORT, entry: round2(entry), stop: lv.stop, target: lv.target, target2: lv.target2, score: 68, checks: { donchianLow: true, atr: round2(a), rr: lv.rr } };
    }
    return null;
}

export const ETH_STRATEGIES = [
    {
        key: 'eth_sweep',
        symbol: 'ETHUSD',
        prefix: 'ETH',
        name: 'ETH · Liquidity Sweep',
        description:
            '24h ETHUSD spot. Sweep of the swing extreme with a close back inside the range (trapped liquidity), reversal entry. Stop past the wick, ATR-scaled and capped; target is the nearest swing clearing the reward:risk gate. Setups that cannot pay are skipped.',
        sourceFiles: 'src/strategies/gold.js (liquiditySweep)',
        run: liquiditySweep,
    },
    {
        key: 'eth_trend',
        symbol: 'ETHUSD',
        prefix: 'ETH',
        name: 'ETH · EMA Pullback Trend',
        description:
            '24h ETHUSD spot. EMA 20/50 stack in the direction of the trade; a pullback that tags the fast EMA and closes back with trend continues.',
        sourceFiles: 'src/strategies/gold.js (emaPullback)',
        run: emaPullback,
    },
    {
        key: 'eth_breakout',
        symbol: 'ETHUSD',
        prefix: 'ETH',
        name: 'ETH · Donchian Breakout',
        description:
            '24h ETHUSD spot. Close beyond the 30-bar channel with an ATR-scaled stop (hard cap applies) and a target clamped to the reward:risk gate.',
        sourceFiles: 'src/strategies/gold.js (donchianBreakout)',
        run: donchianBreakout,
    },
    {
        key: 'eth_daybreak',
        symbol: 'ETHUSD',
        prefix: 'ETH',
        name: 'ETH · Day Break Confirm',
        description:
            '24h ETHUSD spot. Break of the IST day high/low, then a confirming 1m candle whose extreme breaks — entry on the break, stop at the confirmation candle, target the nearest structural level paying the reward:risk gate (the opposite day extreme when it qualifies). Profit locks at the configured booking level.',
        sourceFiles: 'src/strategies/gold.js (dayHighLowBreakout)',
        run: dayHighLowBreakout,
    },
];

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Day High/Low Break + 1-Minute Confirmation (from the 1-Minute Trading
 * Strategy PDF). Mark the IST day's high/low; a break of either level is only
 * the first leg — entry waits for a confirming 1m candle and a break of that
 * candle's extreme. Stop at the confirmation candle's far edge (bounded by
 * ATR and the stop ceiling), target the nearest structural level that pays
 * the reward:risk gate — the opposite day extreme when it qualifies.
 */
export function dayHighLowBreakout(bars, opts = {}) {
    const { stopRisk = 15, minRisk = 4, ...plan } = opts;
    if (bars.length < 60) return null;
    const today = sessionDate(bars[bars.length - 1].ts);
    const dayBars = bars.filter((b) => sessionDate(b.ts) === today);
    if (dayBars.length < 10) return null;
    const dayHigh = Math.max(...dayBars.map((b) => b.high));
    const dayLow = Math.min(...dayBars.map((b) => b.low));
    const last = bars[bars.length - 1];
    const a = lastAtr(bars);
    const pivots = swings(bars.slice(-90));

    for (let i = bars.length - 8; i >= 1; i--) {
        const conf = bars[i];
        const prev = bars[i - 1];
        // Setup A: break below the day low, green confirmation, green-high break.
        if (prev.low < dayLow && conf.close > conf.open && last.close > conf.high) {
            const entry = conf.high;
            const structuralStop = conf.low;
            if (entry - structuralStop < minRisk) continue;
            const lv = planLevels({
                direction: LONG, entry, structuralStop, atr: a,
                structuralTargets: [dayHigh, ...pivots.highs], maxStop: stopRisk, ...plan,
            });
            if (!lv) continue;
            return { direction: LONG, entry: round2(entry), stop: lv.stop, target: lv.target, target2: lv.target2, score: 70, checks: { dayLowBreak: true, greenConfirm: true, triggerBreak: true, atr: round2(a), rr: lv.rr } };
        }
        // Setup B: break above the day high, red confirmation, red-low break.
        if (prev.high > dayHigh && conf.close < conf.open && last.close < conf.low) {
            const entry = conf.low;
            const structuralStop = conf.high;
            if (structuralStop - entry < minRisk) continue;
            const lv = planLevels({
                direction: SHORT, entry, structuralStop, atr: a,
                structuralTargets: [dayLow, ...pivots.lows], maxStop: stopRisk, ...plan,
            });
            if (!lv) continue;
            return { direction: SHORT, entry: round2(entry), stop: lv.stop, target: lv.target, target2: lv.target2, score: 70, checks: { dayHighBreak: true, redConfirm: true, triggerBreak: true, atr: round2(a), rr: lv.rr } };
        }
    }
    return null;
}

export const GOLD_STRATEGIES = [
    {
        key: 'gold_sweep',
        symbol: 'XAUUSD',
        prefix: 'GOLD',
        name: 'Gold · Liquidity Sweep',
        description:
            '24h XAUUSD. Sweep of the swing extreme with a close back inside the range (trapped liquidity), reversal entry. Stop sits past the sweep wick, scaled to ATR and capped; target is the nearest swing that pays at least the reward:risk gate. Setups that cannot pay are skipped.',
        sourceFiles: 'src/strategies/gold.js (liquiditySweep)',
        run: liquiditySweep,
    },
    {
        key: 'gold_trend',
        symbol: 'XAUUSD',
        prefix: 'GOLD',
        name: 'Gold · EMA Pullback Trend',
        description:
            '24h XAUUSD. EMA 20/50 stack in the direction of the trade; a pullback that tags the fast EMA and closes back with trend continues. Stop below the pullback low, ATR-scaled; target is the nearest swing high that clears the reward:risk gate.',
        sourceFiles: 'src/strategies/gold.js (emaPullback)',
        run: emaPullback,
    },
    {
        key: 'gold_breakout',
        symbol: 'XAUUSD',
        prefix: 'GOLD',
        name: 'Gold · Donchian Breakout',
        description:
            '24h XAUUSD. Close beyond the 30-bar channel with an ATR-scaled stop (hard cap applies). Target is the channel measured move, clamped to the reward:risk gate.',
        sourceFiles: 'src/strategies/gold.js (donchianBreakout)',
        run: donchianBreakout,
    },
    {
        key: 'gold_daybreak',
        symbol: 'XAUUSD',
        prefix: 'GOLD',
        name: 'Gold · Day Break Confirm',
        description:
            '24h XAUUSD. Break of the IST day high/low, then a confirming 1m candle whose extreme breaks — entry on the break, stop at the confirmation candle, target the opposite day extreme. Profit locks at the configured booking level.',
        sourceFiles: 'src/strategies/gold.js (dayHighLowBreakout)',
        run: dayHighLowBreakout,
    },
];
