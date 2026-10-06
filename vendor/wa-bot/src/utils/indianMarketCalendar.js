/**
 * NSE/BSE equity trading-day checks (IST).
 * Skips weekends + exchange holidays for scheduled trade alerts.
 */

import { getTodayDateStrIST } from './dateIST.js';

/** Official NSE equity holidays (YYYY-MM-DD). Extend yearly. */
const NSE_HOLIDAYS = new Set([
    // 2025
    '2025-01-26',
    '2025-02-26',
    '2025-03-14',
    '2025-03-31',
    '2025-04-10',
    '2025-04-14',
    '2025-04-18',
    '2025-05-01',
    '2025-08-15',
    '2025-08-27',
    '2025-10-02',
    '2025-10-21',
    '2025-10-22',
    '2025-11-05',
    '2025-12-25',
    // 2026 — NSE circular
    '2026-01-15',
    '2026-01-26',
    '2026-03-03',
    '2026-03-26',
    '2026-03-31',
    '2026-04-03',
    '2026-04-14',
    '2026-05-01',
    '2026-05-28',
    '2026-06-26',
    '2026-09-14',
    '2026-10-02',
    '2026-10-20',
    '2026-11-10',
    '2026-11-24',
    '2026-12-25',
    // 2027 — placeholder core set (update when NSE publishes)
    '2027-01-26',
    '2027-03-22',
    '2027-04-02',
    '2027-04-14',
    '2027-05-01',
    '2027-08-15',
    '2027-10-02',
    '2027-11-08',
    '2027-12-25',
]);

/** Weekends when NSE opened for special sessions (still run alerts). */
const FORCE_OPEN_DAYS = new Set([
    '2026-02-01', // Union Budget 2026 (Sunday)
]);

function parseDateSet(raw) {
    if (!raw) {
        return new Set();
    }
    return new Set(
        String(raw)
            .split(',')
            .map((s) => s.trim())
            .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s))
    );
}

function getIstWeekday(dateMs) {
    return new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Kolkata',
        weekday: 'short',
    }).format(new Date(dateMs));
}

function isWeekendIST(dateMs) {
    const day = getIstWeekday(dateMs);
    return day === 'Sat' || day === 'Sun';
}

/**
 * @param {number} [dateMs]
 * @param {object} [config]
 */
export function isIndianEquityTradingDay(dateMs = Date.now(), config = {}) {
    if (config.TRADE_ALERT_SKIP_NON_TRADING_DAYS === false) {
        return true;
    }

    const dateStr = getTodayDateStrIST(dateMs);
    const extraClosed = parseDateSet(config.TRADE_ALERT_EXTRA_HOLIDAYS);
    const extraOpen = parseDateSet(config.TRADE_ALERT_FORCE_TRADING_DAYS);

    if (FORCE_OPEN_DAYS.has(dateStr) || extraOpen.has(dateStr)) {
        return true;
    }

    if (extraClosed.has(dateStr) || NSE_HOLIDAYS.has(dateStr)) {
        return false;
    }

    if (config.TRADE_ALERT_SKIP_WEEKENDS !== false && isWeekendIST(dateMs)) {
        return false;
    }

    return true;
}

/**
 * @param {number} [dateMs]
 * @param {object} [config]
 * @returns {string | null}
 */
export function getIndianMarketClosedReason(dateMs = Date.now(), config = {}) {
    if (isIndianEquityTradingDay(dateMs, config)) {
        return null;
    }

    const dateStr = getTodayDateStrIST(dateMs);
    const extraClosed = parseDateSet(config.TRADE_ALERT_EXTRA_HOLIDAYS);

    if (extraClosed.has(dateStr) || NSE_HOLIDAYS.has(dateStr)) {
        return `NSE holiday (${dateStr})`;
    }

    if (isWeekendIST(dateMs)) {
        return `weekend (${getIstWeekday(dateMs)})`;
    }

    return 'market closed';
}

/** @typedef {'PREMARKET'|'PREOPEN'|'MARKET_HOURS'|'AFTER_HOURS'|'RESEARCH'} MarketMode */

/**
 * India session mode (trading-copilot + IMT style).
 * @param {number} [dateMs]
 * @returns {{ mode: MarketMode, label: string, allowsLiveEntry: boolean, watchOnly: boolean }}
 */
export function getIndiaMarketMode(dateMs = Date.now()) {
    if (!isIndianEquityTradingDay(dateMs, {})) {
        return {
            mode: 'RESEARCH',
            label: '🔬 Research (market closed)',
            allowsLiveEntry: false,
            watchOnly: true,
        };
    }

    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).formatToParts(new Date(dateMs));
    const hour = Number(parts.find((p) => p.type === 'hour')?.value || 0);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value || 0);
    const mins = hour * 60 + minute;

    if (mins >= 7 * 60 + 45 && mins < 9 * 60 + 15) {
        return {
            mode: 'PREMARKET',
            label: '🌅 Premarket (watch only)',
            allowsLiveEntry: false,
            watchOnly: true,
        };
    }
    if (mins >= 9 * 60 && mins < 9 * 60 + 15) {
        return {
            mode: 'PREOPEN',
            label: '⏳ Pre-open (no live entry)',
            allowsLiveEntry: false,
            watchOnly: true,
        };
    }
    if (mins >= 9 * 60 + 15 && mins < 15 * 60 + 30) {
        return {
            mode: 'MARKET_HOURS',
            label: '🟢 Market hours',
            allowsLiveEntry: true,
            watchOnly: false,
        };
    }
    if (mins >= 15 * 60 + 30 && mins < 21 * 60) {
        return {
            mode: 'AFTER_HOURS',
            label: '🌙 After hours (next-session watch)',
            allowsLiveEntry: false,
            watchOnly: true,
        };
    }

    return {
        mode: 'RESEARCH',
        label: '🔬 Research mode',
        allowsLiveEntry: false,
        watchOnly: true,
    };
}

/**
 * @param {Date} scannedAt
 * @param {number} [maxAgeMs=5*60*1000]
 */
export function checkQuoteFreshness(scannedAt, maxAgeMs = 5 * 60 * 1000) {
    if (!scannedAt) {
        return { ok: false, message: 'no scan timestamp' };
    }
    const age = Date.now() - new Date(scannedAt).getTime();
    if (age > maxAgeMs) {
        return { ok: false, message: `data ${Math.round(age / 60000)}m old` };
    }
    return { ok: true, message: 'fresh' };
}
