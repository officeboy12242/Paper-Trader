/**
 * The feature vector every model sees — one function, so a decision scored
 * live and a trade scored at training time are described identically.
 *
 * Deliberately small (16 numbers). With a few hundred labelled trades there
 * is no way to fit a large vector honestly, and a 16-dim regularised linear
 * model is easy to reason about when it starts vetoing things.
 *
 * Two groups:
 *   - setup/time/venue features: always available, from the signal itself.
 *   - bar features: from the ~90 one-minute bars captured at decision time.
 *     When they are missing the vector still has to be a fixed length, so
 *     those slots get neutral placeholders and `hasBars` is 0 — letting the
 *     model learn that "unknown" is not "calm".
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const BAR_WINDOW = 30;
const MIN_BARS = 5;

export const FEATURE_NAMES = [
    'rr',           // reward:risk the setup offered (direction-agnostic)
    'stopPct',      // stop distance as % of entry
    'dir',          // +1 long, -1 short, 0 unknown
    'score',        // setup score 0..1
    'confluence',   // confluence score 0..1
    'hourSin',      // IST time of day, cyclic
    'hourCos',
    'dowSin',       // IST day of week, cyclic
    'dowCos',
    'venueGold',
    'venueEth',
    'venueNse',
    'hasBars',      // 1 when the bar features below are real
    'vol',          // stdev of last-30 log returns, in %
    'trend',        // change over the window, in %
    'posInRange',   // last close inside the window's high/low, 0..1
];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const finite = (v) => (typeof v === 'number' && Number.isFinite(v));

/** Gold / ETH settle on Delta, everything else on the NSE. */
export function venueOf(symbol) {
    const s = String(symbol ?? '').toUpperCase();
    if (s === 'XAUUSD' || s === 'GOLD' || s === 'XAUTUSD') return 'gold';
    if (s === 'ETHUSD' || s === 'ETH') return 'eth';
    return 'nse';
}

/**
 * @param {object} i
 * @param {number} i.ts decision or entry time (epoch ms)
 * @param {string} i.symbol
 * @param {string} [i.direction] LONG | SHORT
 * @param {number} [i.entry]
 * @param {number} [i.stop]
 * @param {number} [i.target]
 * @param {number} [i.setupScore]
 * @param {number} [i.confluence]
 * @param {Array<{open:number,high:number,low:number,close:number}>} [i.bars]
 * @returns {number[]} exactly FEATURE_NAMES.length numbers
 */
export function featuresFor({ ts, symbol, direction, entry, stop, target, setupScore, confluence, bars } = {}) {
    // IST wall clock, expressed as angles so 23:00 and 00:00 are neighbours.
    const d = new Date((ts ?? Date.now()) + IST_OFFSET_MS);
    const hour = d.getUTCHours() + d.getUTCMinutes() / 60;
    const dow = d.getUTCDay();
    const hourAngle = (2 * Math.PI * hour) / 24;
    const dowAngle = (2 * Math.PI * dow) / 7;

    // (target - entry) / (entry - stop) is positive for both directions:
    // a long has target above entry, a short has target below and the
    // denominator flips sign with direction, keeping the ratio reward/risk.
    const rrDen = finite(entry) && finite(stop) ? entry - stop : 0;
    const rr = rrDen !== 0 && finite(target) ? clamp((target - entry) / rrDen, 0, 5) : 0;
    const stopPct = rrDen !== 0 && entry ? clamp((Math.abs(rrDen) / entry) * 100, 0, 50) : 0;

    const venue = venueOf(symbol);
    const usable = Array.isArray(bars) && bars.length >= MIN_BARS ? bars.slice(-BAR_WINDOW) : null;
    let vol = 0;
    let trend = 0;
    let posInRange = 0.5;
    if (usable) {
        const closes = usable.map((b) => b.close).filter(finite);
        if (closes.length >= MIN_BARS) {
            const rets = [];
            for (let i = 1; i < closes.length; i++) {
                if (closes[i - 1] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
            }
            if (rets.length) {
                const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
                const varr = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
                vol = Math.sqrt(varr) * 100;
            }
            const first = closes[0];
            const last = closes[closes.length - 1];
            if (first > 0) trend = ((last - first) / first) * 100;
            const highs = usable.map((b) => b.high).filter(finite);
            const lows = usable.map((b) => b.low).filter(finite);
            if (highs.length && lows.length) {
                const hi = Math.max(...highs);
                const lo = Math.min(...lows);
                posInRange = hi > lo ? clamp((last - lo) / (hi - lo), 0, 1) : 0.5;
            }
        }
    }

    return [
        rr,
        stopPct,
        direction === 'LONG' ? 1 : direction === 'SHORT' ? -1 : 0,
        finite(setupScore) ? clamp(setupScore / 100, 0, 1) : 0,
        finite(confluence) ? clamp(confluence / 100, 0, 1) : 0,
        Math.sin(hourAngle),
        Math.cos(hourAngle),
        Math.sin(dowAngle),
        Math.cos(dowAngle),
        venue === 'gold' ? 1 : 0,
        venue === 'eth' ? 1 : 0,
        venue === 'nse' ? 1 : 0,
        usable ? 1 : 0,
        vol,
        trend,
        posInRange,
    ];
}
