/**
 * Schedule one random awesome-list post per slot (offset from GitHub times).
 */

import { logger } from './logger.js';
import {
    formatSlotKey,
    getCurrentDueSlot,
    getMsUntilNextNewsPost,
    isSaturdayInTimezone,
    parsePostTimesFromConfig,
} from './newsScheduler.js';
import { createDurableSlotStore } from './durableSlots.js';

export { parsePostTimesFromConfig };

/**
 * @param {object} options
 * @param {() => import('baileys').WASocket | null} options.getSock
 * @param {object} options.botState
 * @param {{ checkAndPostList: Function }} options.awesomeController
 * @param {{ AWESOME_LISTS_ENABLED: boolean, AWESOME_LISTS_TIMES: string[], AWESOME_LISTS_TIMEZONE: string }} options.config
 * @param {import('../models/BotSettings.js').default} [options.botSettings]
 */
export function startAwesomeScheduler({ getSock, botState, awesomeController, config, botSettings = null }) {
    let postTimeout = null;
    let stopped = false;
    const slots = createDurableSlotStore(botSettings, 'awesome');

    if (!config.AWESOME_LISTS_ENABLED) {
        logger.info('⭐ Awesome lists scheduler disabled');
        return { stop() {} };
    }

    const slotList = parsePostTimesFromConfig(config.AWESOME_LISTS_TIMES);
    if (!slotList.length) {
        logger.warn('⭐ Awesome lists enabled but no post times configured');
        return { stop() {} };
    }

    const scheduleNextPost = () => {
        if (stopped) return;

        const delay = getMsUntilNextNewsPost(config.AWESOME_LISTS_TIMES, config.AWESOME_LISTS_TIMEZONE);
        const nextAt = new Date(Date.now() + delay).toLocaleString('en-IN', {
            timeZone: config.AWESOME_LISTS_TIMEZONE,
            dateStyle: 'medium',
            timeStyle: 'short',
        });
        logger.info(
            `⭐ Next awesome list scheduled at ${nextAt} (${config.AWESOME_LISTS_TIMEZONE})`
        );

        postTimeout = setTimeout(async () => {
            try {
                const sock = getSock();
                const due = getCurrentDueSlot(config.AWESOME_LISTS_TIMES, config.AWESOME_LISTS_TIMEZONE);
                if (!due) return;

                const slotIndex = slotList.findIndex(
                    (slot) => slot.hour === due.hour && slot.minute === due.minute
                );
                if (slotIndex < 0) return;

                const slotKey = formatSlotKey(
                    new Date(),
                    config.AWESOME_LISTS_TIMEZONE,
                    due.hour,
                    due.minute
                );
                if (await slots.isDone(botState, slotKey, 'lastAwesomePostSlots')) return;

                // Mark Saturday slots done without posting (college/resume day).
                if (
                    config.GITHUB_COLLEGE_SATURDAY !== false
                    && isSaturdayInTimezone(new Date(), config.AWESOME_LISTS_TIMEZONE)
                ) {
                    logger.info(`⭐ Awesome slot ${slotKey}: skipped — Saturday college/resume day`);
                    await slots.markDone(botState, slotKey, 'lastAwesomePostSlots');
                    return;
                }

                if (!sock) return;

                await awesomeController.checkAndPostList(sock, botState, slotIndex);
                await slots.markDone(botState, slotKey, 'lastAwesomePostSlots');
            } catch (err) {
                logger.error(`Awesome lists scheduled post failed: ${err.message}`);
            } finally {
                scheduleNextPost();
            }
        }, delay);
    };

    scheduleNextPost();

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
