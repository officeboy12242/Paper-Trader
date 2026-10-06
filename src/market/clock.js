/**
 * IST session clock. India has no DST, so IST is a fixed UTC+05:30 offset.
 * Trading-day decisions delegate to the original WA-BOT NSE calendar.
 */

import {
    isIndianEquityTradingDay,
    getIndianMarketClosedReason,
} from '../../vendor/wa-bot/src/utils/indianMarketCalendar.js';

const IST_OFFSET_MS = 330 * 60 * 1000;

/** `YYYY-MM-DD` of the IST calendar day containing `ms`. */
export function sessionDate(ms = Date.now()) {
    return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Minutes past IST midnight. */
export function istMinutes(ms = Date.now()) {
    const d = new Date(ms + IST_OFFSET_MS);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
}

export function hhmmToMinutes(hhmm) {
    const [h, m] = String(hhmm).split(':').map(Number);
    return h * 60 + m;
}

/** Epoch ms for an IST wall-clock time on a session date. */
export function istTimestamp(dateStr, hhmm) {
    const [y, mo, d] = dateStr.split('-').map(Number);
    const [h, mi] = String(hhmm).split(':').map(Number);
    return Date.UTC(y, mo - 1, d, h, mi) - IST_OFFSET_MS;
}

/** ISO week key, e.g. 2026-W41 (weeks start Monday). */
export function weekKey(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    const day = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
    return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function monthKey(dateStr) {
    return dateStr.slice(0, 7);
}

export function isTradingDay(ms = Date.now(), calendarConfig = {}) {
    return isIndianEquityTradingDay(ms, calendarConfig);
}

export function closedReason(ms = Date.now(), calendarConfig = {}) {
    return getIndianMarketClosedReason(ms, calendarConfig);
}

/**
 * Where the session is right now, from this platform's point of view.
 * @returns {{ date: string, tradingDay: boolean, phase: 'CLOSED_DAY'|'PRE_OPEN'|'OPEN'|'ENTRY_CLOSED'|'SQUARED_OFF', reason: string|null }}
 */
export function sessionPhase(cfg, ms = Date.now()) {
    const date = sessionDate(ms);
    if (!isTradingDay(ms)) {
        return { date, tradingDay: false, phase: 'CLOSED_DAY', reason: closedReason(ms) };
    }
    const m = istMinutes(ms);
    if (m < hhmmToMinutes(cfg.SESSION_OPEN)) return { date, tradingDay: true, phase: 'PRE_OPEN', reason: 'before 09:15 IST' };
    if (m < hhmmToMinutes(cfg.ENTRY_CUTOFF)) return { date, tradingDay: true, phase: 'OPEN', reason: null };
    if (m < hhmmToMinutes(cfg.EOD_SQUARE_OFF)) return { date, tradingDay: true, phase: 'ENTRY_CLOSED', reason: `no new entries after ${cfg.ENTRY_CUTOFF}` };
    return { date, tradingDay: true, phase: 'SQUARED_OFF', reason: `square-off at ${cfg.EOD_SQUARE_OFF}` };
}
