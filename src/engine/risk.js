/**
 * Risk overlay applied on top of each source's own levels.
 *
 * Rules (all configurable, defaults shown):
 *  - Hard stop: never more than STOP_LOSS_PERCENT (5%) from the actual fill.
 *    LONG  hard = fill x 0.95,  SHORT hard = fill x 1.05.
 *    If the source's own stop is tighter, the source stop is used.
 *  - Minimum target: MIN_TARGET (10) in MIN_TARGET_UNIT (points = Rs per share).
 *    The source target is kept when it is already at least that far away.
 *  - Trailing: armed when the target is reached. The stop jumps to a lock level
 *    (TRAIL_LOCK_PCT of the target distance, default 100% = the target itself)
 *    and then follows the best price by TRAIL_DISTANCE. It only ever tightens.
 */

export const LONG = 'LONG';
export const SHORT = 'SHORT';

export const dirSign = (direction) => (direction === LONG ? 1 : -1);

export const round2 = (n) => Math.round(n * 100) / 100;

/** Tighter of two stops for this direction (higher for LONG, lower for SHORT). */
export function tighterStop(direction, a, b) {
    if (!Number.isFinite(a)) return b;
    if (!Number.isFinite(b)) return a;
    return direction === LONG ? Math.max(a, b) : Math.min(a, b);
}

export function hardStopFor(direction, fill, stopLossPercent) {
    const pct = stopLossPercent / 100;
    return round2(direction === LONG ? fill * (1 - pct) : fill * (1 + pct));
}

/** Minimum favourable distance (price points per share) the target must sit from the fill. */
export function minTargetDistance(cfg, fill, quantity) {
    switch (cfg.MIN_TARGET_UNIT) {
        case 'rupees':
            // Rs MIN_TARGET gross on the whole position.
            return quantity > 0 ? cfg.MIN_TARGET / quantity : cfg.MIN_TARGET;
        case 'percent':
            return (fill * cfg.MIN_TARGET) / 100;
        default:
            return cfg.MIN_TARGET;
    }
}

export function trailDistanceFor(cfg, fill, initialRisk) {
    switch (cfg.TRAIL_DISTANCE_UNIT) {
        case 'points':
            return cfg.TRAIL_DISTANCE;
        case 'r':
            return cfg.TRAIL_DISTANCE * initialRisk;
        default:
            return (fill * cfg.TRAIL_DISTANCE) / 100;
    }
}

/**
 * Final levels for a position, computed from the ACTUAL fill price.
 *
 * @param {object} p
 * @param {'LONG'|'SHORT'} p.direction
 * @param {number} p.fill
 * @param {number} p.quantity
 * @param {number|null} p.sourceStop
 * @param {number|null} p.sourceTarget
 * @param {object} cfg
 */
export function finalizeLevels({ direction, fill, quantity, sourceStop = null, sourceTarget = null }, cfg) {
    if (direction !== LONG && direction !== SHORT) throw new Error(`bad direction ${direction}`);
    if (!(fill > 0)) throw new Error(`bad fill ${fill}`);
    const d = dirSign(direction);

    const hardStop = hardStopFor(direction, fill, cfg.STOP_LOSS_PERCENT);
    // A source stop on the wrong side of the fill cannot protect anything.
    const sourceStopUsable = Number.isFinite(sourceStop) && (sourceStop - fill) * d < 0;
    const stop = round2(sourceStopUsable ? tighterStop(direction, sourceStop, hardStop) : hardStop);
    const stopBasis = sourceStopUsable && stop === round2(sourceStop) && stop !== hardStop ? 'SOURCE' : 'HARD_5PCT';

    const minDist = minTargetDistance(cfg, fill, quantity);
    const minTarget = fill + d * minDist;
    const sourceTargetUsable = Number.isFinite(sourceTarget) && (sourceTarget - fill) * d > 0;
    const target = round2(
        sourceTargetUsable
            ? direction === LONG
                ? Math.max(sourceTarget, minTarget)
                : Math.min(sourceTarget, minTarget)
            : minTarget
    );
    let targetBasis = sourceTargetUsable && Math.abs(target - round2(sourceTarget)) < 0.005 ? 'SOURCE' : 'MIN_TARGET';
    // A fixed-point minimum on a very cheap stock can put a SHORT target at or
    // below zero. Clamp to one tick and flag it: the position will exit on its
    // stop, trailing stop or the end-of-day square-off instead.
    let finalTarget = target;
    if (finalTarget <= 0) {
        finalTarget = 0.05;
        targetBasis = 'MIN_TARGET_UNREACHABLE';
    }

    const initialRisk = Math.abs(fill - stop);
    const trailDistance = round2(trailDistanceFor(cfg, fill, initialRisk));

    return { stop, hardStop, stopBasis, target: finalTarget, targetBasis, minTargetDistance: round2(minDist), trailDistance, initialRisk: round2(initialRisk) };
}

/**
 * Arm trailing once the target has printed.
 * @returns {{ stop: number, highWater: number }} never looser than `trade.stop`
 */
export function activateTrailing(trade, barExtreme, cfg) {
    const d = dirSign(trade.direction);
    const lockDist = (Math.abs(trade.target_price - trade.entry_price) * cfg.TRAIL_LOCK_PCT) / 100;
    const lock = trade.entry_price + d * lockDist;
    const highWater = trade.direction === LONG
        ? Math.max(trade.high_water ?? trade.entry_price, barExtreme)
        : Math.min(trade.high_water ?? trade.entry_price, barExtreme);
    const follow = highWater - d * trade.trail_distance;
    const stop = round2(tighterStop(trade.direction, trade.stop_loss_price, tighterStop(trade.direction, lock, follow)));
    return { stop, highWater };
}

/**
 * Move an active trailing stop after a closed bar.
 * @returns {{ stop: number, highWater: number, moved: boolean }}
 */
export function ratchetTrailing(trade, barExtreme) {
    const d = dirSign(trade.direction);
    const highWater = trade.direction === LONG
        ? Math.max(trade.high_water ?? trade.entry_price, barExtreme)
        : Math.min(trade.high_water ?? trade.entry_price, barExtreme);
    const candidate = highWater - d * trade.trail_distance;
    const stop = round2(tighterStop(trade.direction, trade.stop_loss_price, candidate));
    return { stop, highWater, moved: stop !== trade.stop_loss_price };
}

/** Gross P&L in rupees for a closed position. */
export function grossPnl(direction, entry, exit, quantity) {
    return round2((exit - entry) * quantity * dirSign(direction));
}
