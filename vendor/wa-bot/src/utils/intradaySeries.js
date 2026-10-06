/**
 * Intraday series helpers for 15m candle data.
 *
 * The v1 heatmap mixed clocks: sector % came from the live index feed while
 * stock % came from the 9:00–9:08 pre-open auction. Those two numbers describe
 * different moments, so a "hot sector with a moving stock" could be neither.
 *
 * Everything here is derived from ONE multi-day intraday series per symbol, so
 * intraday %, VWAP, ATR, opening range and relative strength are guaranteed to
 * agree with each other. One HTTP call, one clock.
 */

import { candlePartsIST } from './yahooIntradayCandles.js';

/** NSE continuous session, as minutes past IST midnight. */
export const SESSION_OPEN_MIN = 9 * 60 + 15;
export const SESSION_CLOSE_MIN = 15 * 60 + 30;

/** Minutes past IST midnight for a candle timestamp. */
export function istMinutesOfDay(tsMs) {
    const p = candlePartsIST(tsMs);
    return p.hour * 60 + p.minute;
}

/** `YYYY-MM-DD` in IST — the session a candle belongs to. */
export function istDateKey(tsMs) {
    const p = candlePartsIST(tsMs);
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/**
 * Group candles into trading sessions, oldest first.
 *
 * Needed because a `range: '5d'` fetch returns five days of 15m bars in one
 * flat array. Scanning that for "the 09:15 candle" finds the one from five
 * days ago, which is exactly the kind of silent staleness this module exists
 * to prevent.
 *
 * @returns {{ date: string, candles: object[] }[]}
 */
export function splitSessionsIST(candles = []) {
    const sessions = [];
    let current = null;
    for (const c of candles) {
        if (!Number.isFinite(c?.ts)) continue;
        const key = istDateKey(c.ts);
        if (!current || current.date !== key) {
            current = { date: key, candles: [] };
            sessions.push(current);
        }
        current.candles.push(c);
    }
    return sessions;
}

/** The most recent session's candles. */
export function todaySession(candles = []) {
    const sessions = splitSessionsIST(candles);
    return sessions.length ? sessions[sessions.length - 1].candles : [];
}

/**
 * Close of the session before the latest one — the reference for today's %.
 * Returns null when only one session is present (can't compute a change).
 */
export function previousSessionClose(candles = []) {
    const sessions = splitSessionsIST(candles);
    if (sessions.length < 2) return null;
    const prev = sessions[sessions.length - 2].candles;
    const last = prev[prev.length - 1];
    return Number.isFinite(last?.close) ? last.close : null;
}

/** Today's move vs the previous session close, in percent. */
export function intradayChangePct(candles = []) {
    const session = todaySession(candles);
    const prevClose = previousSessionClose(candles);
    const last = session[session.length - 1];
    if (!Number.isFinite(prevClose) || prevClose <= 0 || !Number.isFinite(last?.close)) return null;
    return ((last.close / prevClose) - 1) * 100;
}

/**
 * Running session VWAP, one value per candle.
 *
 * Yahoo reports zero volume on index feeds and occasionally on thin stocks.
 * Returning null (rather than a volume-less average) lets callers treat VWAP
 * as unavailable instead of silently filtering on a meaningless number.
 *
 * @returns {number[]|null} aligned to `session`, or null when volume is absent
 */
export function sessionVwap(session = []) {
    let pv = 0;
    let vol = 0;
    const out = [];
    for (const c of session) {
        const typical = (c.high + c.low + c.close) / 3;
        const v = Number(c.volume) || 0;
        pv += typical * v;
        vol += v;
        out.push(vol > 0 ? pv / vol : null);
    }
    return vol > 0 ? out : null;
}

/** The 09:15 IST candle — the opening range. Falls back to the first bar. */
export function openingRangeCandle(session = []) {
    for (const c of session) {
        if (istMinutesOfDay(c.ts) === SESSION_OPEN_MIN) return c;
    }
    return session[0] || null;
}

/**
 * Relative strength vs the index, in percentage points.
 * Positive means the stock is outperforming today.
 */
export function relativeStrength(stockChangePct, indexChangePct) {
    if (!Number.isFinite(stockChangePct) || !Number.isFinite(indexChangePct)) return null;
    return stockChangePct - indexChangePct;
}

/** Session turnover in ₹ — a liquidity gate that survives penny-stock volume. */
export function sessionTurnover(session = []) {
    let sum = 0;
    for (const c of session) {
        const v = Number(c.volume) || 0;
        if (v > 0) sum += ((c.high + c.low + c.close) / 3) * v;
    }
    return sum > 0 ? sum : null;
}
