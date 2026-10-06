/**
 * Schedule tech news posts at fixed local times (default 10:00 & 22:00 IST).
 */

import { logger } from './logger.js';
import { createDurableSlotStore } from './durableSlots.js';

function zonedParts(date, timezone) {
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        hourCycle: 'h23',
    });
    const parts = formatter.formatToParts(date);
    const get = (type) => parts.find((p) => p.type === type)?.value;
    let hour = Number(get('hour'));
    const minute = Number(get('minute'));
    // en-CA + hour12:false uses 24 for midnight — normalize so 00:00 slots match
    if (hour === 24) {
        hour = 0;
    }
    return {
        year: Number(get('year')),
        month: Number(get('month')),
        day: Number(get('day')),
        hour,
        minute,
    };
}

function parsePostTimes(times) {
    return times
        .map((slot) => {
            const [h, m = '0'] = slot.trim().split(':');
            return { hour: Number(h), minute: Number(m) };
        })
        .filter((slot) => !Number.isNaN(slot.hour) && !Number.isNaN(slot.minute));
}

export function parsePostTimesFromConfig(times) {
    return parsePostTimes(times);
}

export function msUntilTimeInTimezone(hour, minute, timezone, fromMs = Date.now()) {
    for (let addMin = 0; addMin <= 48 * 60; addMin++) {
        const candidate = new Date(fromMs + addMin * 60_000);
        const p = zonedParts(candidate, timezone);
        if (p.hour === hour && p.minute === minute) {
            return Math.max(addMin, 1) * 60_000;
        }
    }
    return 24 * 60 * 60 * 1000;
}

export function getMsUntilNextNewsPost(postTimes, timezone, fromMs = Date.now()) {
    const slots = parsePostTimes(postTimes);
    if (!slots.length) {
        return 24 * 60 * 60 * 1000;
    }
    return Math.min(...slots.map((slot) => msUntilTimeInTimezone(slot.hour, slot.minute, timezone, fromMs)));
}

export function formatSlotKey(date, timezone, hour, minute) {
    const p = zonedParts(date, timezone);
    const hh = String(hour).padStart(2, '0');
    const mm = String(minute).padStart(2, '0');
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}T${hh}:${mm}`;
}

/** Day-only key (for once-per-day jobs with random wall-clock times). */
export function formatDayKey(date, timezone) {
    const p = zonedParts(date, timezone);
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Short weekday in timezone: 'Sun'..'Sat' (en-US). */
export function weekdayShortInTimezone(date = new Date(), timezone = 'Asia/Kolkata') {
    return new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(date);
}

export function isSaturdayInTimezone(date = new Date(), timezone = 'Asia/Kolkata') {
    return weekdayShortInTimezone(date, timezone) === 'Sat';
}

export function getCurrentDueSlot(postTimes, timezone, now = new Date()) {
    const p = zonedParts(now, timezone);
    const slots = parsePostTimes(postTimes);
    return slots.find((slot) => slot.hour === p.hour && slot.minute === p.minute) || null;
}

/**
 * Slots whose wall-clock time has already passed today (inclusive of current minute).
 * @returns {{ hour: number, minute: number, index: number }[]}
 */
export function getPastDueSlotsToday(postTimes, timezone, now = new Date()) {
    const p = zonedParts(now, timezone);
    const nowMinutes = p.hour * 60 + p.minute;
    return parsePostTimes(postTimes)
        .map((slot, index) => ({ ...slot, index }))
        .filter((slot) => slot.hour * 60 + slot.minute <= nowMinutes);
}

/**
 * Past-due slots still inside a catch-up grace window (same calendar day).
 * Stops a missed 13:00 interview Q from dumping alongside 18:00 after long downtime.
 * @param {string[]} postTimes
 * @param {string} timezone
 * @param {Date} [now]
 * @param {number} [graceMs] default 90 minutes
 * @returns {{ hour: number, minute: number, index: number, ageMs: number }[]}
 */
export function getCatchUpSlotsToday(postTimes, timezone, now = new Date(), graceMs = 90 * 60 * 1000) {
    const p = zonedParts(now, timezone);
    const nowMinutes = p.hour * 60 + p.minute;
    const graceMinutes = Math.max(0, Math.floor(Number(graceMs) / 60_000));
    return parsePostTimes(postTimes)
        .map((slot, index) => {
            const due = slot.hour * 60 + slot.minute;
            const ageMin = nowMinutes - due;
            return { ...slot, index, ageMs: ageMin * 60_000 };
        })
        .filter((slot) => slot.ageMs >= 0 && slot.ageMs <= graceMinutes * 60_000);
}

/**
 * Past-due slots that are older than the grace window (skip without posting).
 */
export function getExpiredSlotsToday(postTimes, timezone, now = new Date(), graceMs = 90 * 60 * 1000) {
    const p = zonedParts(now, timezone);
    const nowMinutes = p.hour * 60 + p.minute;
    const graceMinutes = Math.max(0, Math.floor(Number(graceMs) / 60_000));
    return parsePostTimes(postTimes)
        .map((slot, index) => {
            const due = slot.hour * 60 + slot.minute;
            const ageMin = nowMinutes - due;
            return { ...slot, index, ageMs: ageMin * 60_000 };
        })
        .filter((slot) => slot.ageMs > graceMinutes * 60_000);
}

/**
 * @param {object} options
 * @param {() => import('baileys').WASocket | null} options.getSock
 * @param {object} options.botState
 * @param {{ checkAndPostNews: Function, scrapeAndQueueOnly: Function }} options.newsController
 * @param {{ NEWS_POST_TIMES: string[], NEWS_TIMEZONE: string, NEWS_SCRAPE_INTERVAL: number }} options.config
 * @param {import('../models/BotSettings.js').default} [options.botSettings]
 * @param {{ enqueue: Function }|null} [options.jobQueue]
 * @returns {{ stop: () => void }}
 */
export function startNewsScheduler({
    getSock,
    botState,
    newsController,
    config,
    botSettings = null,
    jobQueue = null,
}) {
    let postTimeout = null;
    let scrapeInterval = null;
    let stopped = false;
    const slots = createDurableSlotStore(botSettings, 'news');

    const scheduleNextPost = () => {
        if (stopped) {
            return;
        }
        const delay = getMsUntilNextNewsPost(config.NEWS_POST_TIMES, config.NEWS_TIMEZONE);
        const nextAt = new Date(Date.now() + delay).toLocaleString('en-IN', {
            timeZone: config.NEWS_TIMEZONE,
            dateStyle: 'medium',
            timeStyle: 'short',
        });
        logger.info(
            `📰 Next tech news post scheduled at ${nextAt} (${config.NEWS_TIMEZONE})`
        );

        postTimeout = setTimeout(async () => {
            try {
                const sock = getSock();
                const due = getCurrentDueSlot(config.NEWS_POST_TIMES, config.NEWS_TIMEZONE);
                if (due) {
                    const slotKey = formatSlotKey(new Date(), config.NEWS_TIMEZONE, due.hour, due.minute);
                    if (await slots.isDone(botState, slotKey, 'lastNewsPostSlot')) {
                        return;
                    }
                    if (!sock) return;
                    await newsController.checkAndPostNews(sock, botState);
                    await slots.markDone(botState, slotKey, 'lastNewsPostSlot');
                }
            } catch (error) {
                logger.error(`News scheduled post failed: ${error.message}`);
            } finally {
                scheduleNextPost();
            }
        }, delay);
    };

    scrapeInterval = setInterval(async () => {
        try {
            if (jobQueue) {
                await jobQueue.enqueue('news.scrape', {}, { jobKey: 'news.scrape', maxAttempts: 2 });
            } else {
                await newsController.scrapeAndQueueOnly();
            }
        } catch (error) {
            logger.error(`News background scrape failed: ${error.message}`);
        }
    }, config.NEWS_SCRAPE_INTERVAL * 1000);

    if (jobQueue) {
        void jobQueue.enqueue('news.scrape', {}, { jobKey: 'news.scrape', maxAttempts: 2 }).catch((err) => {
            logger.error(`News scrape enqueue failed: ${err.message}`);
        });
    } else {
        void newsController.scrapeAndQueueOnly();
    }
    scheduleNextPost();

    return {
        stop() {
            stopped = true;
            if (postTimeout) {
                clearTimeout(postTimeout);
                postTimeout = null;
            }
            if (scrapeInterval) {
                clearInterval(scrapeInterval);
                scrapeInterval = null;
            }
        },
    };
}
