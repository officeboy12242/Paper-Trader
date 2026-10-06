/**
 * Schedule daily group chat recap at a fixed local time.
 */

import { logger } from './logger.js';
import { formatSlotKey, msUntilTimeInTimezone } from './newsScheduler.js';
import { createDurableSlotStore } from './durableSlots.js';

function parseSummaryTime(timeStr) {
    const [h, m = '0'] = String(timeStr || '00:00').trim().split(':');
    return { hour: Number(h), minute: Number(m) };
}

/**
 * @param {object} options
 * @param {() => import('baileys').WASocket | null} options.getSock
 * @param {object} options.botState
 * @param {import('../controllers/GroupSummaryController.js').default} options.groupSummaryController
 * @param {object} options.config
 * @param {import('../models/BotSettings.js').default} [options.botSettings]
 */
export function startGroupSummaryScheduler({
    getSock,
    botState,
    groupSummaryController,
    config,
    botSettings = null,
}) {
    let postTimeout = null;
    let stopped = false;
    const slots = createDurableSlotStore(botSettings, 'summary');

    if (config.GROUP_SUMMARY_ENABLED === false) {
        return { stop() {} };
    }

    const timezone = config.GROUP_SUMMARY_TIMEZONE || 'Asia/Kolkata';
    const { hour, minute } = parseSummaryTime(config.GROUP_SUMMARY_TIME);

    const scheduleNext = () => {
        if (stopped) {
            return;
        }

        const delay = msUntilTimeInTimezone(hour, minute, timezone);
        const nextAt = new Date(Date.now() + delay).toLocaleString('en-IN', {
            timeZone: timezone,
            dateStyle: 'medium',
            timeStyle: 'short',
        });

        logger.info(
            `🗓️ Next group day recap at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} ` +
                `→ ${nextAt} (${timezone})`
        );

        postTimeout = setTimeout(async () => {
            try {
                const sock = getSock();
                const slotKey = formatSlotKey(new Date(), timezone, hour, minute);
                if (await slots.isDone(botState, slotKey, 'lastGroupSummarySlot')) {
                    return;
                }
                if (!sock) return;
                await groupSummaryController.postDailySummaries(sock);
                await slots.markDone(botState, slotKey, 'lastGroupSummarySlot');
            } catch (error) {
                logger.error(`Group summary scheduled send failed: ${error.message}`);
            } finally {
                scheduleNext();
            }
        }, delay);
    };

    scheduleNext();

    // Catch up if bot restarted after midnight and missed the scheduled run
    if (config.GROUP_SUMMARY_CATCHUP_ENABLED !== false) {
        setTimeout(() => {
            void groupSummaryController.runCatchUpIfNeeded(getSock()).catch((err) => {
                logger.error(`Group summary catch-up failed: ${err.message}`);
            });
        }, 60_000);
    }

    return {
        stop() {
            stopped = true;
            if (postTimeout) {
                clearTimeout(postTimeout);
                postTimeout = null;
            }
        },
    };
}
