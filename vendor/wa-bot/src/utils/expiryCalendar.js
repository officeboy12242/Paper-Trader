/**
 * Indian index-derivatives expiry calendar.
 *
 * Post-SEBI rationalisation (circular Oct 2024, effective 20 Nov 2024) each
 * exchange may run weekly expiries on ONE benchmark index only. NSE kept NIFTY;
 * BANKNIFTY / FINNIFTY / MIDCPNIFTY weeklies were withdrawn and are now monthly.
 * From 4 Sep 2025 NSE settles on Tuesday and BSE on Thursday.
 *
 *   NIFTY       — every Tuesday (weekly) + last Tuesday (monthly)
 *   BANKNIFTY   — last Tuesday only
 *   FINNIFTY    — last Tuesday only
 *   MIDCPNIFTY  — last Tuesday only
 *   SENSEX      — Thursday, BSE. Not covered: BSE exposes no usable public
 *                 option chain (see ExpiryTradeService).
 *
 * When an expiry date is a holiday it moves to the PREVIOUS trading day.
 */

import { isIndianEquityTradingDay } from './indianMarketCalendar.js';

const IST_TZ = 'Asia/Kolkata';
const DAY_MS = 24 * 60 * 60 * 1000;

/** NSE settles index derivatives on Tuesday (2 = Tuesday). */
export const NSE_EXPIRY_WEEKDAY = 2;

export const WEEKLY_EXPIRY_INDICES = ['NIFTY'];
export const MONTHLY_EXPIRY_INDICES = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY'];

/** Calendar parts for a timestamp in IST. */
export function istParts(ms) {
    const p = new Intl.DateTimeFormat('en-GB', {
        timeZone: IST_TZ,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        weekday: 'short',
    }).formatToParts(new Date(ms));
    const get = (t) => p.find((x) => x.type === t)?.value;
    const weekdayName = get('weekday');
    const weekdayIdx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekdayName);
    return {
        year: Number(get('year')),
        month: Number(get('month')),
        day: Number(get('day')),
        weekday: weekdayIdx,
        weekdayName,
        dateStr: `${get('year')}-${get('month')}-${get('day')}`,
    };
}

/** IST date string (YYYY-MM-DD) for a timestamp. */
export function istDateStr(ms) {
    return istParts(ms).dateStr;
}

/** Midday-UTC anchor for an IST calendar date — avoids DST/rollover edges. */
function anchorMs(year, month, day) {
    return Date.UTC(year, month - 1, day, 6, 30, 0);
}

/** Last `weekday` of the given IST month, as a midday anchor timestamp. */
export function lastWeekdayOfMonth(year, month, weekday = NSE_EXPIRY_WEEKDAY) {
    // Walk back from the final day of the month to the first matching weekday.
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    for (let d = lastDay; d >= 1; d--) {
        const ms = anchorMs(year, month, d);
        if (istParts(ms).weekday === weekday) return ms;
    }
    return null;
}

/**
 * Shift back to the previous trading day when the nominal date is a holiday.
 * @returns {number} adjusted timestamp
 */
export function rollToTradingDay(ms, config = {}) {
    let cur = ms;
    for (let i = 0; i < 10; i++) {
        if (isIndianEquityTradingDay(cur, config)) return cur;
        cur -= DAY_MS;
    }
    return ms;
}

/**
 * Which indices expire on the given date?
 * @param {number} [dateMs]
 * @returns {{ isExpiry: boolean, indices: string[], kind: 'weekly'|'monthly'|null, dateStr: string }}
 */
export function getExpiriesOn(dateMs = Date.now(), config = {}) {
    const parts = istParts(dateMs);
    const dateStr = parts.dateStr;

    if (!isIndianEquityTradingDay(dateMs, config)) {
        return { isExpiry: false, indices: [], kind: null, dateStr };
    }

    // Monthly: the last-Tuesday anchor for this month, holiday-adjusted.
    const monthlyAnchor = lastWeekdayOfMonth(parts.year, parts.month, NSE_EXPIRY_WEEKDAY);
    const monthlyMs = monthlyAnchor != null ? rollToTradingDay(monthlyAnchor, config) : null;
    const isMonthly = monthlyMs != null && istDateStr(monthlyMs) === dateStr;

    // Weekly: this week's Tuesday, holiday-adjusted.
    const daysSinceExpiryDay = (parts.weekday - NSE_EXPIRY_WEEKDAY + 7) % 7;
    const weeklyAnchor = anchorMs(parts.year, parts.month, parts.day) - daysSinceExpiryDay * DAY_MS;
    const weeklyMs = rollToTradingDay(weeklyAnchor, config);
    const isWeekly = istDateStr(weeklyMs) === dateStr;

    if (isMonthly) {
        return { isExpiry: true, indices: [...MONTHLY_EXPIRY_INDICES], kind: 'monthly', dateStr };
    }
    if (isWeekly) {
        return { isExpiry: true, indices: [...WEEKLY_EXPIRY_INDICES], kind: 'weekly', dateStr };
    }
    return { isExpiry: false, indices: [], kind: null, dateStr };
}

/** Convenience predicate. */
export function isExpiryDay(dateMs = Date.now(), config = {}) {
    return getExpiriesOn(dateMs, config).isExpiry;
}

/**
 * Next expiry on/after `fromMs`.
 * @returns {{ dateStr: string, indices: string[], kind: string, daysAway: number }|null}
 */
export function nextExpiry(fromMs = Date.now(), config = {}) {
    for (let i = 0; i < 40; i++) {
        const ms = fromMs + i * DAY_MS;
        const r = getExpiriesOn(ms, config);
        if (r.isExpiry) return { ...r, daysAway: i };
    }
    return null;
}

/** Does this index expire on the given date? */
export function indexExpiresOn(index, dateMs = Date.now(), config = {}) {
    const r = getExpiriesOn(dateMs, config);
    return r.isExpiry && r.indices.includes(String(index || '').toUpperCase());
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Parse NSE's expiry format ("11-Aug-2026") to the 15:30 IST settlement instant.
 * @returns {number|null} epoch ms
 */
export function parseNseExpiry(str) {
    const m = String(str || '').trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
    if (!m) return null;
    const day = Number(m[1]);
    const monthIdx = MONTH_ABBR.findIndex((x) => x.toLowerCase() === m[2].toLowerCase());
    if (monthIdx < 0) return null;
    // 15:30 IST == 10:00 UTC
    return Date.UTC(Number(m[3]), monthIdx, day, 10, 0, 0);
}

/**
 * Fraction of a year until a specific expiry instant. Never negative.
 * Always prefer this over assuming expiry is today — a manual lookup on a
 * Monday must price against Tuesday's close, not Monday's.
 */
export function yearsToExpiry(expiryMs, nowMs = Date.now()) {
    if (!Number.isFinite(expiryMs)) return 0;
    return Math.max(0, expiryMs - nowMs) / (365 * DAY_MS);
}

/** Hours until a specific expiry instant. */
export function hoursToExpiry(expiryMs, nowMs = Date.now()) {
    return yearsToExpiry(expiryMs, nowMs) * 365 * 24;
}

/** Fraction of a year remaining until TODAY's 15:30 IST close. Never negative. */
export function yearsToExpiryClose(nowMs = Date.now()) {
    const p = istParts(nowMs);
    return yearsToExpiry(Date.UTC(p.year, p.month - 1, p.day, 10, 0, 0), nowMs);
}

/** Hours remaining in today's session (0 once the close has passed). */
export function hoursToExpiryClose(nowMs = Date.now()) {
    return yearsToExpiryClose(nowMs) * 365 * 24;
}
