/**
 * Gold (XAUUSD) 24-hour strategy presets.
 *
 * These run alongside the six WA-BOT NSE traders as ordinary registry entries
 * with `roundTheClock: true`, so they scan on a fixed interval day and night
 * with no EOD square-off. Each returns candidates in the same shape the
 * SourceStrategy produces, and each owns its own virtual trader, stats and DB
 * rows exactly like a WA-BOT source.
 *
 * Levels convention (user spec):
 *   stop   : ~$15 adverse move from entry
 *   target : $40 first objective, $70 / $100 hit by the trailing stop
 *   sizing : $30k paper margin with 50x leverage, Delta Exchange style
 */

import { LONG, SHORT } from '../engine/risk.js';

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

/**
 * Liquidity sweep (smart money concept): price sweeps a recent swing extreme
 * and closes back inside the range — trapped liquidity -> reversal entry.
 *
 * Tuned for frequency: a sweep only needs to touch the extreme and close back
 * inside — no trend filter, minimal depth, any rejection strength. This forms
 * setups often. Stop beyond the sweep wick (bounded), target then trail.
 */
export function liquiditySweep(bars, { lookback = 60, stopRisk = 15, minRisk = 4, target = 40, minSweep = 0.5 } = {}) {
    if (bars.length < lookback + 30) return null;
    const today = bars.slice(-lookback - 30, -30); // the window swept through
    const recent = bars.slice(-30);
    const swingHigh = Math.max(...today.map((b) => b.high));
    const swingLow = Math.min(...today.map((b) => b.low));

    for (let i = recent.length - 6; i >= 0; i--) {
        const b = recent[i];
        const closeBack = b.close > swingLow && b.close < swingHigh;
        if (b.low < swingLow && b.close > swingLow && closeBack) {
            // Bullish sweep of the lows.
            const depth = swingLow - b.low;
            if (depth < minSweep) continue;
            const entry = b.close;
            const rawStop = b.low - 0.5;
            const stop = rawStop >= entry - stopRisk ? rawStop : entry - stopRisk;
            const risk = entry - stop;
            if (risk < minRisk) continue;
            const t1 = entry + Math.max(target, risk * 2);
            const t2 = entry + Math.max(target * 1.75, risk * 3);
            return { direction: LONG, entry: round2(entry), stop: round2(stop), target: round2(t1), target2: round2(t2), score: 75, checks: { sweepLow: true, closeBackInside: true, depth: round2(depth) } };
        }
        if (b.high > swingHigh && b.close < swingHigh && closeBack) {
            const depth = b.high - swingHigh;
            if (depth < minSweep) continue;
            const entry = b.close;
            const rawStop = b.high + 0.5;
            const stop = rawStop <= entry + stopRisk ? rawStop : entry + stopRisk;
            const risk = stop - entry;
            if (risk < minRisk) continue;
            const t1 = entry - Math.max(target, risk * 2);
            const t2 = entry - Math.max(target * 1.75, risk * 3);
            return { direction: SHORT, entry: round2(entry), stop: round2(stop), target: round2(t1), target2: round2(t2), score: 75, checks: { sweepHigh: true, closeBackInside: true, depth: round2(depth) } };
        }
    }
    return null;
}

/** Trend pullback: EMA20/EMA50 stack, pullback tags EMA20, close back above. */
export function emaPullback(bars, { fast = 20, slow = 50, stopRisk = 15, minRisk = 4, target = 40 } = {}) {
    if (bars.length < slow + 30) return null;
    const closes = bars.map((b) => b.close);
    const ef = ema(closes, fast);
    const es = ema(closes, slow);
    const recent = bars.slice(-6);
    for (let i = recent.length - 3; i < recent.length - 1; i++) {
        const idx = bars.length - recent.length + i;
        const b = bars[idx];
        const trendUp = ef[idx] > es[idx] && ef[idx - 1] > es[idx - 1];
        const trendDown = ef[idx] < es[idx] && ef[idx - 1] < es[idx - 1];
        if (trendUp && b.low <= ef[idx] && b.close > ef[idx]) {
            const entry = b.close;
            const stop = Math.max(b.low - 1, entry - stopRisk);
            if (entry - stop < minRisk) continue;
            return { direction: LONG, entry: round2(entry), stop: round2(stop), target: round2(entry + target), target2: round2(entry + target * 1.75), score: 70, checks: { emaStack: true, emaTag: true } };
        }
        if (trendDown && b.high >= ef[idx] && b.close < ef[idx]) {
            const entry = b.close;
            const stop = Math.min(b.high + 1, entry + stopRisk);
            if (stop - entry < minRisk) continue;
            return { direction: SHORT, entry: round2(entry), stop: round2(stop), target: round2(entry - target), target2: round2(entry - target * 1.75), score: 70, checks: { emaStack: true, emaTag: true } };
        }
    }
    return null;
}

/** Donchian breakout: close beyond 30-bar extreme with ATR-bounded stop. */
export function donchianBreakout(bars, { period = 30, atrPeriod = 14, stopRisk = 15, minRisk = 4, target = 40 } = {}) {
    if (bars.length < period + atrPeriod + 10) return null;
    const atrx = atr(bars, atrPeriod);
    const window = bars.slice(-period - 1, -1);
    const high = Math.max(...window.map((b) => b.high));
    const low = Math.min(...window.map((b) => b.low));
    const last = bars[bars.length - 1];
    const a = atrx[atrx.length - 1] ?? 0;
    if (!(a > 0)) return null;
    if (last.close > high) {
        const entry = last.close;
        const stop = Math.max(entry - stopRisk, entry - 1.5 * a);
        if (entry - stop < minRisk) return null;
        return { direction: LONG, entry: round2(entry), stop: round2(stop), target: round2(entry + target), target2: round2(entry + target * 1.75), score: 68, checks: { donchianHigh: true } };
    }
    if (last.close < low) {
        const entry = last.close;
        const stop = Math.min(entry + stopRisk, entry + 1.5 * a);
        if (stop - entry < minRisk) return null;
        return { direction: SHORT, entry: round2(entry), stop: round2(stop), target: round2(entry - target), target2: round2(entry - target * 1.75), score: 68, checks: { donchianLow: true } };
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
            '24h ETHUSD spot. Sweep of the swing extreme with a close back inside the range (trapped liquidity), reversal entry, stop past the wick, first target then trailing.',
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
            '24h ETHUSD spot. Close beyond the 30-bar channel with an ATR-bounded stop and a trailing target.',
        sourceFiles: 'src/strategies/gold.js (donchianBreakout)',
        run: donchianBreakout,
    },
];

const round2 = (n) => Math.round(n * 100) / 100;

export const GOLD_STRATEGIES = [
    {
        key: 'gold_sweep',
        symbol: 'XAUUSD',
        prefix: 'GOLD',
        name: 'Gold · Liquidity Sweep',
        description:
            '24h XAUUSD. Sweep of the swing extreme with a close back inside the range (trapped liquidity), reversal entry, ~$15 stop, $40 first target, trailing through $70/$100. The flagship gold setup.',
        sourceFiles: 'src/strategies/gold.js (liquiditySweep)',
        run: liquiditySweep,
    },
    {
        key: 'gold_trend',
        symbol: 'XAUUSD',
        prefix: 'GOLD',
        name: 'Gold · EMA Pullback Trend',
        description:
            '24h XAUUSD. EMA 20/50 stack in the direction of the trade; a pullback that tags the fast EMA and closes back with trend continues. ~$15 stop, $40 first target, trailing through $70/$100.',
        sourceFiles: 'src/strategies/gold.js (emaPullback)',
        run: emaPullback,
    },
    {
        key: 'gold_breakout',
        symbol: 'XAUUSD',
        prefix: 'GOLD',
        name: 'Gold · Donchian Breakout',
        description:
            '24h XAUUSD. Close beyond the 30-bar channel with an ATR-bounded stop (capped at $15). $40 first target, trailing through $70/$100.',
        sourceFiles: 'src/strategies/gold.js (donchianBreakout)',
        run: donchianBreakout,
    },
];
