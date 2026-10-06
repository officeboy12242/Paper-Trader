/**
 * Pure indicator math for the swing momentum scan.
 *
 * Deliberately dependency-free and side-effect-free: the ranking must be
 * deterministic and reproducible so results can be audited against outcomes.
 * No LLM is involved in any number produced here.
 */

/** NSE trading days — used to convert calendar lookbacks to bar counts. */
export const TRADING_DAYS_YEAR = 252;
export const TRADING_DAYS_6M = 126;

/**
 * Volatility floor (annualised) for the momentum denominator. A thin stock that
 * prints the same close repeatedly measures near-zero volatility, which would
 * divide a modest return into a huge ratio and top the ranking. No real liquid
 * Indian equity sits below ~5%, so anything under this is a data artifact.
 */
export const MIN_ANNUAL_VOL = 0.05;

export function sma(values, period) {
    const vals = values.filter(Number.isFinite);
    if (vals.length < period) return null;
    const slice = vals.slice(-period);
    return slice.reduce((s, v) => s + v, 0) / period;
}

/** Sample standard deviation (n-1). */
export function stdev(values) {
    const vals = values.filter(Number.isFinite);
    if (vals.length < 2) return null;
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / (vals.length - 1);
    return Math.sqrt(variance);
}

/** Simple (not log) daily returns. */
export function dailyReturns(closes) {
    const out = [];
    for (let i = 1; i < closes.length; i++) {
        const prev = closes[i - 1];
        const cur = closes[i];
        if (!Number.isFinite(prev) || !Number.isFinite(cur) || prev === 0) continue;
        out.push(cur / prev - 1);
    }
    return out;
}

/** Annualised volatility from daily returns over the last `lookback` bars. */
export function annualizedVolatility(closes, lookback) {
    const window = closes.slice(-(lookback + 1));
    const rets = dailyReturns(window);
    const sd = stdev(rets);
    if (sd == null || sd === 0) return null;
    return sd * Math.sqrt(TRADING_DAYS_YEAR);
}

/** Total price return over the last `lookback` bars. */
export function periodReturn(closes, lookback) {
    if (closes.length < lookback + 1) return null;
    const start = closes[closes.length - 1 - lookback];
    const end = closes[closes.length - 1];
    if (!Number.isFinite(start) || !Number.isFinite(end) || start === 0) return null;
    return end / start - 1;
}

/**
 * Risk-adjusted momentum ratio, per NSE's Nifty200 Momentum 30 methodology:
 * excess return over the risk-free rate, divided by annualised daily volatility.
 * Dividing by volatility is what stops the ranking from simply collecting the
 * most volatile stocks in the universe.
 */
export function momentumRatio(closes, lookback, riskFreeAnnual = 0.065) {
    const ret = periodReturn(closes, lookback);
    const vol = annualizedVolatility(closes, lookback);
    if (ret == null || vol == null || vol < MIN_ANNUAL_VOL) return null;
    const excess = ret - riskFreeAnnual * (lookback / TRADING_DAYS_YEAR);
    return excess / vol;
}

/** Z-scores across a universe; nulls stay null. */
export function zScores(values) {
    const finite = values.filter(Number.isFinite);
    if (finite.length < 2) return values.map(() => null);
    const mean = finite.reduce((s, v) => s + v, 0) / finite.length;
    const sd = stdev(finite);
    if (!sd) return values.map((v) => (Number.isFinite(v) ? 0 : null));
    return values.map((v) => (Number.isFinite(v) ? (v - mean) / sd : null));
}

/**
 * NSE's normalisation: maps a z-score to a strictly positive weight multiplier,
 * compressing the downside so a single terrible period cannot dominate the blend.
 */
export function normalizeZ(z) {
    if (!Number.isFinite(z)) return null;
    return z >= 0 ? 1 + z : 1 / (1 - z);
}

/** Wilder's ATR. Returns the latest value. */
export function atr(candles, period = 14) {
    if (!Array.isArray(candles) || candles.length < period + 1) return null;

    const trs = [];
    for (let i = 1; i < candles.length; i++) {
        const c = candles[i];
        const prevClose = candles[i - 1].close;
        if (![c.high, c.low, prevClose].every(Number.isFinite)) continue;
        trs.push(
            Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose))
        );
    }
    if (trs.length < period) return null;

    // Seed with a simple average, then apply Wilder smoothing.
    let value = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
    for (let i = period; i < trs.length; i++) {
        value = (value * (period - 1) + trs[i]) / period;
    }
    return value;
}

/** Highest high over the last `lookback` bars (defaults to 52 weeks). */
export function highestHigh(candles, lookback = TRADING_DAYS_YEAR) {
    const slice = candles.slice(-lookback);
    const highs = slice.map((c) => c.high).filter(Number.isFinite);
    return highs.length ? Math.max(...highs) : null;
}

/** Lowest low over the last `lookback` bars. */
export function lowestLow(candles, lookback = TRADING_DAYS_YEAR) {
    const slice = candles.slice(-lookback);
    const lows = slice.map((c) => c.low).filter(Number.isFinite);
    return lows.length ? Math.min(...lows) : null;
}

/** Latest volume as a multiple of the trailing average (excluding today). */
export function volumeRatio(candles, period = 20) {
    if (candles.length < period + 1) return null;
    const latest = candles[candles.length - 1]?.volume;
    if (!Number.isFinite(latest) || latest <= 0) return null;
    const prior = candles.slice(-(period + 1), -1).map((c) => c.volume).filter((v) => v > 0);
    if (prior.length < Math.ceil(period / 2)) return null;
    const avg = prior.reduce((s, v) => s + v, 0) / prior.length;
    if (!avg) return null;
    return latest / avg;
}

/** Average daily traded value (₹) over `period` bars — the liquidity filter. */
export function avgTurnover(candles, period = 20) {
    const slice = candles.slice(-period).filter((c) => c.volume > 0 && Number.isFinite(c.close));
    if (!slice.length) return null;
    return slice.reduce((s, c) => s + c.close * c.volume, 0) / slice.length;
}

/**
 * Highest high of the `lookback` bars ending `offset` bars ago — used to test a
 * genuine breakout (today exceeds the prior range, not merely its own high).
 */
export function priorHighestHigh(candles, lookback = TRADING_DAYS_YEAR, offset = 1) {
    if (candles.length < offset + 1) return null;
    return highestHigh(candles.slice(0, candles.length - offset), lookback);
}

/** Most recent swing low over `lookback` bars — the structural stop reference. */
export function recentSwingLow(candles, lookback = 20) {
    return lowestLow(candles, lookback);
}
