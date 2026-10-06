/**
 * The three indicators behind the SVMKR mashup: UT Bot, Hull MA, LRS.
 *
 * ── PROVENANCE, read this before trusting the numbers ────────────────────────
 * The TradingView script `SVMKR_UT_Bot_HMA_UCS_LRS` (author svmkr987) is marked
 * open-source but its page does not serve the Pine source, so this is NOT a
 * line-by-line port. Each component is implemented from its canonical public
 * definition — the widely-copied "UT Bot Alerts" trailing stop, Alan Hull's HMA,
 * and a least-squares regression slope in the shape of ucsgears' UCS_LRS — and
 * the combination rule is taken from the script's own description: buy when
 * price crosses above the trailing stop with a positive slope above its average,
 * sell on the mirror. Input defaults follow the public UT Bot (ATR 10,
 * sensitivity 1); the original's tuning is unknown.
 *
 * No win rate is claimed anywhere in here. The only honest numbers come from
 * SvmkrPositionTracker, which grades real posted trades against real premiums.
 */

/** Weighted MA — newest bar carries the heaviest weight. Pine's ta.wma. */
export function wma(values, period) {
    const out = new Array(values.length).fill(null);
    if (!(period > 0)) return out;
    const denom = (period * (period + 1)) / 2;

    for (let i = period - 1; i < values.length; i++) {
        let sum = 0;
        let ok = true;
        for (let k = 0; k < period; k++) {
            const v = values[i - period + 1 + k];
            if (!Number.isFinite(v)) {
                ok = false;
                break;
            }
            sum += v * (k + 1);
        }
        out[i] = ok ? sum / denom : null;
    }
    return out;
}

/**
 * Hull Moving Average: WMA(2·WMA(n/2) − WMA(n), √n).
 * The double-WMA subtraction is what removes the lag a plain MA carries.
 */
export function hma(values, period = 21) {
    const half = Math.max(1, Math.round(period / 2));
    const root = Math.max(1, Math.round(Math.sqrt(period)));
    const fast = wma(values, half);
    const slow = wma(values, period);

    const raw = values.map((_, i) =>
        Number.isFinite(fast[i]) && Number.isFinite(slow[i]) ? 2 * fast[i] - slow[i] : null
    );
    return wma(raw, root);
}

/** True range per bar; the first bar has no previous close to reach back to. */
export function trueRanges(candles) {
    return candles.map((c, i) => {
        if (i === 0) return c.high - c.low;
        const pc = candles[i - 1].close;
        return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
    });
}

/**
 * Wilder's ATR (Pine's ta.atr → ta.rma): SMA seed, then smoothed.
 * A plain rolling mean here would make the trailing stop noticeably jumpier.
 */
export function wilderAtr(candles, period = 10) {
    const tr = trueRanges(candles);
    const out = new Array(candles.length).fill(null);
    if (candles.length < period) return out;

    let seed = 0;
    for (let i = 0; i < period; i++) seed += tr[i];
    out[period - 1] = seed / period;

    for (let i = period; i < candles.length; i++) {
        out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
    }
    return out;
}

/** Heikin Ashi candles — the UT Bot's optional smoothing source. */
export function heikinAshi(candles) {
    const out = [];
    for (let i = 0; i < candles.length; i++) {
        const c = candles[i];
        const close = (c.open + c.high + c.low + c.close) / 4;
        const open = i === 0 ? (c.open + c.close) / 2 : (out[i - 1].open + out[i - 1].close) / 2;
        out.push({
            ts: c.ts,
            open,
            close,
            high: Math.max(c.high, open, close),
            low: Math.min(c.low, open, close),
            volume: c.volume,
        });
    }
    return out;
}

/**
 * UT Bot (Ultimate Trailing Stop).
 *
 * The stop ratchets one way only while price stays on its side, and jumps to the
 * other side of price when that breaks — so `pos` flips at most once per swing.
 * A signal is a CROSS on a closed bar, never merely "price is above the stop":
 * the latter is true for hours and would re-fire on every poll.
 *
 * @param {{high:number,low:number,close:number,open:number,ts:number}[]} candles ascending
 * @param {{ atrPeriod?: number, sensitivity?: number, useHeikinAshi?: boolean }} [opts]
 * @returns {{ stop: (number|null)[], pos: number[], buy: boolean[], sell: boolean[] }}
 */
export function utBot(candles, { atrPeriod = 10, sensitivity = 1, useHeikinAshi = false } = {}) {
    const n = candles.length;
    const stop = new Array(n).fill(null);
    const pos = new Array(n).fill(0);
    const buy = new Array(n).fill(false);
    const sell = new Array(n).fill(false);
    if (!n) return { stop, pos, buy, sell };

    // ATR always comes off the real candles; Heikin Ashi only replaces the price
    // the stop is measured against, matching the public script's behaviour.
    const atr = wilderAtr(candles, atrPeriod);
    const priceBars = useHeikinAshi ? heikinAshi(candles) : candles;
    const src = priceBars.map((c) => c.close);

    for (let i = 0; i < n; i++) {
        if (!Number.isFinite(atr[i])) continue;
        const nLoss = sensitivity * atr[i];
        const prev = Number.isFinite(stop[i - 1]) ? stop[i - 1] : null;

        if (prev == null) {
            stop[i] = src[i] - nLoss;
            pos[i] = 1;
            continue;
        }

        const prevSrc = src[i - 1];
        if (src[i] > prev && prevSrc > prev) {
            stop[i] = Math.max(prev, src[i] - nLoss);
        } else if (src[i] < prev && prevSrc < prev) {
            stop[i] = Math.min(prev, src[i] + nLoss);
        } else if (src[i] > prev) {
            stop[i] = src[i] - nLoss;
        } else {
            stop[i] = src[i] + nLoss;
        }

        // Position flips against the PREVIOUS stop — using the current one would
        // compare price to a level derived from that same price.
        if (prevSrc < prev && src[i] > prev) pos[i] = 1;
        else if (prevSrc > prev && src[i] < prev) pos[i] = -1;
        else pos[i] = pos[i - 1];

        const crossUp = src[i] > stop[i] && prevSrc <= prev;
        const crossDown = src[i] < stop[i] && prevSrc >= prev;
        buy[i] = crossUp;
        sell[i] = crossDown;
    }

    return { stop, pos, buy, sell };
}

/** Least-squares slope of the last `period` values, per bar. */
export function linRegSlope(values, period = 20) {
    const out = new Array(values.length).fill(null);
    if (period < 2) return out;

    // x is 0..period-1 every time, so its sums are constant.
    const sumX = (period * (period - 1)) / 2;
    const sumX2 = ((period - 1) * period * (2 * period - 1)) / 6;
    const denom = period * sumX2 - sumX * sumX;
    if (denom === 0) return out;

    for (let i = period - 1; i < values.length; i++) {
        let sumY = 0;
        let sumXY = 0;
        let ok = true;
        for (let k = 0; k < period; k++) {
            const v = values[i - period + 1 + k];
            if (!Number.isFinite(v)) {
                ok = false;
                break;
            }
            sumY += v;
            sumXY += k * v;
        }
        if (ok) out[i] = (period * sumXY - sumX * sumY) / denom;
    }
    return out;
}

/** EMA that tolerates leading nulls (indicator series always have them). */
export function emaSeries(values, span) {
    const out = new Array(values.length).fill(null);
    const alpha = 2 / (span + 1);
    let prev = null;
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (!Number.isFinite(v)) continue;
        prev = prev == null ? v : alpha * v + (1 - alpha) * prev;
        out[i] = prev;
    }
    return out;
}

/**
 * Linear Regression Slope state, UCS_LRS shape: smoothed slope plus its own
 * rolling average, so "rising" means rising faster than it has been.
 *
 * @returns {{ slope: number|null, avg: number|null, bull: boolean, bear: boolean }}
 */
export function lrsState(closes, { period = 20, smooth = 3, avgPeriod = 20 } = {}) {
    const smoothed = emaSeries(linRegSlope(closes, period), smooth);

    const last = smoothed.length - 1;
    const slope = Number.isFinite(smoothed[last]) ? smoothed[last] : null;

    let avg = null;
    const window = smoothed.slice(Math.max(0, smoothed.length - avgPeriod)).filter(Number.isFinite);
    if (window.length >= Math.min(5, avgPeriod)) {
        avg = window.reduce((a, b) => a + b, 0) / window.length;
    }

    return {
        slope,
        avg,
        bull: slope != null && avg != null && slope > 0 && slope > avg,
        bear: slope != null && avg != null && slope < 0 && slope < avg,
    };
}

/**
 * Keep only bars that have actually closed.
 *
 * Yahoo returns the in-progress candle, whose high/low/close still move. Acting
 * on it means a trailing stop that flips and unflips inside one bar — the exact
 * repaint that makes a live alert contradict itself minutes later.
 */
export function closedBarsOnly(candles, intervalMs, nowMs = Date.now()) {
    return (candles || []).filter((c) => Number.isFinite(c?.ts) && c.ts + intervalMs <= nowMs);
}
