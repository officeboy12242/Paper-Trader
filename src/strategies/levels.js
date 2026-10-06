/**
 * Per-trade stop / target planner for the 24-hour gold and ETH traders.
 *
 * Nothing here is a constant. Every trade gets its own stop and target, built
 * from that trade's own structure, so no two trades carry the same levels:
 *
 *   STOP   the setup's invalidation point (sweep wick, confirmation candle,
 *          pullback low). It is never widened, but it is capped by the current
 *          ATR band and by a hard ceiling, so one trade cannot cost more than
 *          the configured maximum no matter how far away the structure sits.
 *
 *   TARGET the nearest structural level in the trade's direction that pays at
 *          least MIN_RR times that trade's own risk. If every nearby level
 *          pays less than that, the setup is REFUSED — no trade, no loss.
 *
 * Capital preservation wins every tie: a refused trade is free.
 */

import { dirSign, round2 } from '../engine/risk.js';

/**
 * Fractal swing points over `bars` — a pivot high needs `left` bars to its
 * left and `right` bars to its right that are all lower (and vice versa).
 *
 * @param {Array<{high:number, low:number}>} bars
 * @returns {{ highs: number[], lows: number[] }}
 */
export function swings(bars, { left = 3, right = 3 } = {}) {
    const highs = [];
    const lows = [];
    for (let i = left; i + right < bars.length; i++) {
        const b = bars[i];
        let isHigh = true;
        let isLow = true;
        for (let j = i - left; j <= i + right && (isHigh || isLow); j++) {
            if (j === i) continue;
            if (bars[j].high >= b.high) isHigh = false;
            if (bars[j].low <= b.low) isLow = false;
        }
        if (isHigh) highs.push(b.high);
        if (isLow) lows.push(b.low);
    }
    return { highs, lows };
}

/**
 * Derive this trade's stop and target from its own structure.
 *
 * @param {object} p
 * @param {'LONG'|'SHORT'} p.direction
 * @param {number} p.entry           candidate fill
 * @param {number} p.structuralStop  where the setup is proven wrong
 * @param {number} [p.atr]           current ATR (0 = no volatility band)
 * @param {number[]} [p.structuralTargets] candidate target prices (swing/day levels)
 * @param {number} [p.minRR]         minimum reward this trade must offer
 * @param {number} [p.maxRR]         furthest target we will aim at
 * @param {number} [p.atrStopMult]   ATR multiple used as the stop band
 * @param {number} [p.maxStop]       hard ceiling on stop distance
 * @returns {{stop:number,target:number,target2:number,risk:number,rr:number}|null}
 *          `null` means the setup cannot pay — do not take the trade.
 */
export function planLevels({
    direction,
    entry,
    structuralStop,
    atr = 0,
    structuralTargets = [],
    minRR = 1.5,
    maxRR = 4,
    atrStopMult = 3,
    maxStop = Infinity,
}) {
    if (direction !== 'LONG' && direction !== 'SHORT') return null;
    if (!(entry > 0) || !Number.isFinite(structuralStop)) return null;
    const d = dirSign(direction);

    // ── STOP: structural, only ever tightened ───────────────────────────────
    const raw = Math.abs(entry - structuralStop);
    if (!(raw > 0)) return null;
    const band = atr > 0 ? atr * atrStopMult : maxStop;
    const ceiling = Math.max(Number.EPSILON, Math.min(band, maxStop));
    const risk = Math.min(raw, ceiling);
    if (!(risk > 0)) return null;
    const stop = round2(entry - d * risk);

    // ── TARGET: nearest level that pays, otherwise refuse ───────────────────
    const levels = structuralTargets
        .filter((t) => Number.isFinite(t))
        .map((t) => (t - entry) * d)
        .filter((x) => x > 0)
        .sort((a, b) => a - b);
    const paying = levels.filter((x) => x >= minRR * risk);

    let targetDist;
    if (paying.length) {
        targetDist = Math.min(paying[0], maxRR * risk);
    } else if (levels.length) {
        // Structure exists but every level is closer than the reward we need:
        // resistance is sitting right on top of us. Skip it.
        return null;
    } else {
        // Nothing ahead: nothing to aim at but the risk itself.
        targetDist = minRR * risk;
    }
    if (!(targetDist > 0)) return null;
    const target = round2(entry + d * targetDist);

    const runner = paying.find((x) => x > targetDist);
    const target2Dist = Math.min(maxRR * risk, runner ?? targetDist + risk);
    const target2 = round2(entry + d * target2Dist);

    return { stop, target, target2, risk: round2(risk), rr: round2(targetDist / risk) };
}
