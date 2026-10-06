/**
 * Two-slot expiry-day scheduler.
 *
 *   09:35 IST — directional setup, once the 15m opening range is complete
 *   13:15 IST — hero-zero window, once decay has done its work
 *
 * Both slots fire only on an actual expiry day, so the timers wake daily and
 * usually do nothing. Posting targets the same groups as the daily trade alert.
 */

import { logger } from './logger.js';
import { formatSlotKey, msUntilTimeInTimezone } from './newsScheduler.js';
import { createDurableSlotStore } from './durableSlots.js';
import { getExpiriesOn } from './expiryCalendar.js';

function parseTime(str, fallback) {
    const [h, m = '0'] = String(str || fallback).trim().split(':');
    return { hour: Number(h), minute: Number(m) };
}

/**
 * @param {object} o
 * @param {() => import('baileys').WASocket | null} o.getSock
 * @param {object} o.botState
 * @param {object} o.config
 * @param {(sock: object, slot: 'morning'|'afternoon') => Promise<void>} o.postExpiryAlerts
 * @param {object} [o.botSettings]
 */
export function startExpiryAlertScheduler({
    getSock,
    botState,
    config,
    postExpiryAlerts,
    botSettings = null,
}) {
    if (config.EXPIRY_ALERT_ENABLED === false) {
        return { stop() {} };
    }

    const timezone = config.TRADE_ALERT_TIMEZONE || 'Asia/Kolkata';
    const slots = createDurableSlotStore(botSettings, 'expiry');
    const timers = [];
    let stopped = false;

    const schedule = (name, timeStr, fallback) => {
        const { hour, minute } = parseTime(timeStr, fallback);
        if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
            logger.warn(`Expiry scheduler: bad time for ${name} (${timeStr})`);
            return;
        }

        const next = () => {
            if (stopped) return;
            const delay = msUntilTimeInTimezone(hour, minute, timezone);
            const t = setTimeout(async () => {
                try {
                    const expiry = getExpiriesOn(Date.now(), config);
                    if (!expiry.isExpiry) return; // quiet on non-expiry days

                    const slotKey = `${name}:${formatSlotKey(new Date(), timezone, hour, minute)}`;
                    if (await slots.isDone(botState, slotKey, 'lastExpiryAlertSlot')) return;

                    const sock = getSock();
                    if (!sock) return;

                    logger.info(
                        `📅 Expiry ${name} slot firing — ${expiry.kind} expiry: ${expiry.indices.join(', ')}`
                    );
                    await postExpiryAlerts(sock, name);
                    await slots.markDone(botState, slotKey, 'lastExpiryAlertSlot');
                } catch (err) {
                    logger.error(`Expiry ${name} alert failed: ${err.message}`);
                } finally {
                    next();
                }
            }, delay);
            timers.push(t);
        };
        next();
        logger.info(
            `📅 Expiry ${name} slot armed for ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} ${timezone}`
        );
    };

    schedule('morning', config.EXPIRY_MORNING_TIME, '09:35');
    schedule('afternoon', config.EXPIRY_AFTERNOON_TIME, '13:15');

    return {
        stop() {
            stopped = true;
            for (const t of timers) clearTimeout(t);
            timers.length = 0;
        },
    };
}
