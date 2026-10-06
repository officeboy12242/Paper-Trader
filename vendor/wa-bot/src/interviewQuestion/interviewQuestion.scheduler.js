/**
 * Schedule Interview Q of the Day at fixed times (default 13:00 & 18:00 IST),
 * plus Saturday 22:00 IST weekly learning recap.
 *
 * Uses a 30s ticker (reliable vs long setTimeouts). Catch-up only within a
 * grace window (~90m) so a missed 1pm Q does not dump together with 6pm.
 */

import { logger } from '../utils/logger.js';
import {
    formatSlotKey,
    getCatchUpSlotsToday,
    getExpiredSlotsToday,
    parsePostTimesFromConfig,
} from '../utils/newsScheduler.js';

/** Poll slots are skipped on these weekdays (short names from Intl weekday:'short'). */
function skipWeekdays(config) {
    return new Set(config?.INTERVIEW_Q_SKIP_SUNDAY === false ? [] : ['Sun']);
}

/**
 * Weekday short name ('Sun'..'Sat') of the calendar date embedded in a slot key
 * (e.g. '2026-09-07T11:00'). A calendar date's weekday is timezone-independent,
 * so the noon-UTC anchor is exact for any tz. Returns null when the key has no
 * date prefix — and never throws (a bad key must not kill the scheduler tick).
 */
export function slotWeekday(slotKey) {
    try {
        const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(slotKey || ''));
        if (!m) return null;
        return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' })
            .format(new Date(`${m[1]}T12:00:00Z`));
    } catch {
        return null;
    }
}

const RETRY_MS = 45_000;
const MAX_RETRIES = 3;
const CATCHUP_GAP_MS = 2_500;
const TICK_MS = 30_000;
/** Missed slot still posts if bot wakes within this window; after that skip (no dump at 6pm). */
const DEFAULT_CATCHUP_GRACE_MS = 90 * 60 * 1000;

function zonedNow(timezone, fromMs = Date.now()) {
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        hourCycle: 'h23',
    });
    const parts = formatter.formatToParts(new Date(fromMs));
    const get = (type) => parts.find((p) => p.type === type)?.value;
    let hour = Number(get('hour'));
    if (hour === 24) hour = 0;
    return {
        year: Number(get('year')),
        month: Number(get('month')),
        day: Number(get('day')),
        weekday: String(get('weekday') || ''),
        hour,
        minute: Number(get('minute')),
    };
}

function parseHm(raw) {
    const [h, m = '0'] = String(raw || '').trim().split(':');
    const hour = Number(h);
    const minute = Number(m);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return { hour, minute };
}

/** ms until next Saturday at hour:minute in timezone. */
export function msUntilNextSaturday(hour, minute, timezone, fromMs = Date.now()) {
    for (let addMin = 0; addMin <= 8 * 24 * 60; addMin++) {
        const candidate = new Date(fromMs + addMin * 60_000);
        const p = zonedNow(timezone, candidate.getTime());
        if (p.weekday === 'Sat' && p.hour === hour && p.minute === minute) {
            return Math.max(addMin, 1) * 60_000;
        }
    }
    return 7 * 24 * 60 * 60 * 1000;
}

export function saturdaySummaryKey(timezone, fromMs = Date.now()) {
    const p = zonedNow(timezone, fromMs);
    return `summary-${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/**
 * @param {object} options
 * @param {() => import('baileys').WASocket | null} options.getSock
 * @param {object} options.botState
 * @param {import('./interviewQuestion.service.js').default} options.service
 * @param {object} options.config
 */
export function startInterviewQuestionScheduler({ getSock, botState, service, config }) {
    let tickInterval = null;
    const skippedDays = skipWeekdays(config);
    let summaryTimeout = null;
    let stopped = false;
    /** @type {Set<string>} */
    const inFlight = new Set();

    if (!config.INTERVIEW_Q_ENABLED) {
        logger.info('🧠 Interview Q scheduler disabled');
        return { stop() {} };
    }

    const slots = parsePostTimesFromConfig(config.INTERVIEW_Q_TIMES);
    if (!slots.length) {
        logger.warn('🧠 Interview Q enabled but no post times configured');
        return { stop() {} };
    }

    const tz = config.INTERVIEW_Q_TIMEZONE || 'Asia/Kolkata';
    const graceMs = Math.max(
        15 * 60_000,
        Number(config.INTERVIEW_Q_CATCHUP_GRACE_MS) || DEFAULT_CATCHUP_GRACE_MS
    );

    if (!botState.lastInterviewQSlots) {
        botState.lastInterviewQSlots = {};
    }
    if (!botState.lastInterviewQSummaries) {
        botState.lastInterviewQSummaries = {};
    }

    void service.recoverPendingAnswers().catch((err) => {
        logger.warn(`Interview Q recover failed: ${err.message}`);
    });

    async function isDone(slotKey) {
        if (botState.lastInterviewQSlots[slotKey]) return true;
        if (typeof service.isSlotFullyPosted === 'function') {
            try {
                if (await service.isSlotFullyPosted(slotKey)) {
                    botState.lastInterviewQSlots[slotKey] = true;
                    return true;
                }
            } catch (err) {
                logger.warn(`Interview Q slot lookup failed: ${err.message}`);
            }
        }
        return false;
    }

    function markDone(slotKey) {
        botState.lastInterviewQSlots[slotKey] = true;
    }

    /**
     * @returns {Promise<boolean>} true if slot settled
     */
    async function runSlot(slotKey, slotIndex, attempt = 0) {
        if (stopped) return true;
        if (await isDone(slotKey)) return true;
        // Days off (e.g. Sunday): mark the slot done so retries/catch-up never post it.
        if (isSkippedDay(slotKey)) {
            markDone(slotKey);
            logger.info(`🧠 Interview Q slot ${slotKey}: skipped — ${[...skippedDays].join('/')} is a day off`);
            return true;
        }
        if (inFlight.has(slotKey)) return false;
        inFlight.add(slotKey);

        try {
            const sock = getSock();
            if (!sock) {
                logger.info(`🧠 Interview Q slot ${slotKey}: waiting for WhatsApp…`);
                if (attempt < MAX_RETRIES) {
                    setTimeout(() => {
                        void runSlot(slotKey, slotIndex, attempt + 1);
                    }, RETRY_MS);
                }
                return false;
            }

            const { posted, groups, skipped } = await service.postSlotToGroups(sock, {
                slotKey,
                slotIndex,
            });
            const covered = (posted || 0) + (skipped || 0);

            if (groups === 0) {
                markDone(slotKey);
                return true;
            }

            if (covered >= groups) {
                markDone(slotKey);
                logger.info(
                    `🧠 Interview Q slot ${slotKey}: ${posted} posted, ${skipped || 0} already done (${groups} groups)`
                );
                return true;
            }

            if (posted > 0) {
                logger.warn(
                    `🧠 Interview Q slot ${slotKey}: partial ${covered}/${groups}; will retry remaining`
                );
            }

            if (attempt < MAX_RETRIES) {
                logger.warn(
                    `🧠 Interview Q slot ${slotKey} incomplete (${covered}/${groups}); retry ${attempt + 1}/${MAX_RETRIES}`
                );
                setTimeout(() => {
                    void runSlot(slotKey, slotIndex, attempt + 1);
                }, RETRY_MS);
                return false;
            }

            logger.error(`🧠 Interview Q slot ${slotKey} gave up after ${MAX_RETRIES} retries`);
            return false;
        } catch (err) {
            logger.error(`Interview Q slot ${slotKey} failed: ${err.message}`);
            if (attempt < MAX_RETRIES) {
                setTimeout(() => {
                    void runSlot(slotKey, slotIndex, attempt + 1);
                }, RETRY_MS);
            }
            return false;
        } finally {
            inFlight.delete(slotKey);
        }
    }

    /** True when a slot's date falls on a configured day off (Sunday by default). */
    function isSkippedDay(slotKey) {
        if (!skippedDays.size) return false;
        const wd = slotWeekday(slotKey);
        return wd !== null && skippedDays.has(wd);
    }

    /**
     * On-time + short-grace catch-up. Expired slots (e.g. missed 13:00 when it's 18:00)
     * are marked done without posting so both Qs do not dump at 6pm.
     */
    async function tickSlots() {
        if (stopped) return;

        const expired = getExpiredSlotsToday(config.INTERVIEW_Q_TIMES, tz, new Date(), graceMs);
        for (const slot of expired) {
            // Per-slot guard: one bad slot must never starve the rest of the tick.
            try {
                const slotKey = formatSlotKey(new Date(), tz, slot.hour, slot.minute);
                if (await isDone(slotKey)) continue;
                markDone(slotKey);
                logger.info(
                    `🧠 Interview Q slot ${slotKey} missed (outside ${Math.round(graceMs / 60_000)}m grace) — skipped`
                );
            } catch (err) {
                logger.error(`Interview Q expired-slot check failed: ${err.message}`);
            }
        }

        const due = getCatchUpSlotsToday(config.INTERVIEW_Q_TIMES, tz, new Date(), graceMs);
        for (const slot of due) {
            if (stopped) return;
            // Per-slot guard: one bad slot must never starve the rest of the tick.
            try {
                const slotKey = formatSlotKey(new Date(), tz, slot.hour, slot.minute);
                if (await isDone(slotKey)) continue;
                const slotIndex =
                    slot.index >= 0
                        ? slot.index
                        : slots.findIndex((s) => s.hour === slot.hour && s.minute === slot.minute);
                logger.info(
                    `🧠 Interview Q due ${slotKey}` +
                        (slot.ageMs > 60_000
                            ? ` (catch-up +${Math.round(slot.ageMs / 60_000)}m)`
                            : '')
                );
                await runSlot(slotKey, Math.max(0, slotIndex), 0);
            } catch (err) {
                logger.error(`Interview Q slot ${slot?.hour}:${slot?.minute} tick failed: ${err.message}`);
            }
            await new Promise((r) => setTimeout(r, CATCHUP_GAP_MS));
        }
    }

    async function runWeeklySummary(attempt = 0) {
        if (stopped) return;
        const hm = parseHm(config.INTERVIEW_Q_SUMMARY_TIME);
        if (!hm) return;

        const now = zonedNow(tz);
        if (now.weekday !== 'Sat') return;
        if (now.hour !== hm.hour || now.minute !== hm.minute) return;

        const summaryKey = saturdaySummaryKey(tz);
        if (botState.lastInterviewQSummaries[summaryKey]) return;
        if (inFlight.has(summaryKey)) return;
        inFlight.add(summaryKey);

        try {
            const sock = getSock();
            if (!sock) {
                if (attempt < MAX_RETRIES) {
                    setTimeout(() => {
                        void runWeeklySummary(attempt + 1);
                    }, RETRY_MS);
                }
                return;
            }

            const sinceMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
            const { posted, groups, skipped } = await service.postWeeklySummaryToGroups(sock, {
                summaryKey,
                sinceMs,
            });
            botState.lastInterviewQSummaries[summaryKey] = true;
            logger.info(
                `📚 Interview Q weekly summary ${summaryKey}: ${posted} posted, ${skipped || 0} skipped (${groups} groups)`
            );
        } catch (err) {
            logger.error(`Interview Q weekly summary failed: ${err.message}`);
            if (attempt < MAX_RETRIES) {
                setTimeout(() => {
                    void runWeeklySummary(attempt + 1);
                }, RETRY_MS);
            }
        } finally {
            inFlight.delete(summaryKey);
        }
    }

    const scheduleNextSummary = () => {
        if (stopped) return;
        const hm = parseHm(config.INTERVIEW_Q_SUMMARY_TIME);
        if (!hm) {
            logger.info('📚 Interview Q weekly summary disabled (empty INTERVIEW_Q_SUMMARY_TIME)');
            return;
        }

        const delay = msUntilNextSaturday(hm.hour, hm.minute, tz);
        const nextAt = new Date(Date.now() + delay).toLocaleString('en-IN', {
            timeZone: tz,
            dateStyle: 'medium',
            timeStyle: 'short',
        });
        logger.info(`📚 Next Interview Q weekly summary at ${nextAt} (${tz})`);

        summaryTimeout = setTimeout(async () => {
            try {
                await runWeeklySummary(0);
            } catch (err) {
                logger.error(`Interview Q summary tick failed: ${err.message}`);
            } finally {
                scheduleNextSummary();
            }
        }, delay);
    };

    const timesLabel = slots
        .map((s) => `${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`)
        .join(', ');
    logger.info(
        `🧠 Interview Q scheduler: ${timesLabel} ${tz} · tick ${TICK_MS / 1000}s · catch-up grace ${Math.round(graceMs / 60_000)}m`
    );

    void tickSlots().catch((err) => {
        logger.warn(`Interview Q startup tick failed: ${err.message}`);
    });
    tickInterval = setInterval(() => {
        void tickSlots().catch((err) => {
            logger.warn(`Interview Q tick failed: ${err.message}`);
        });
    }, TICK_MS);

    // Saturday summary: also check on the minute ticker so we don't miss exact 22:00
    const summaryTick = setInterval(() => {
        const hm = parseHm(config.INTERVIEW_Q_SUMMARY_TIME);
        if (!hm) return;
        const now = zonedNow(tz);
        if (now.weekday !== 'Sat') return;
        if (now.hour !== hm.hour || now.minute !== hm.minute) return;
        void runWeeklySummary(0);
    }, TICK_MS);

    scheduleNextSummary();

    return {
        stop() {
            stopped = true;
            if (tickInterval) {
                clearInterval(tickInterval);
                tickInterval = null;
            }
            clearInterval(summaryTick);
            if (summaryTimeout) {
                clearTimeout(summaryTimeout);
                summaryTimeout = null;
            }
        },
    };
}
