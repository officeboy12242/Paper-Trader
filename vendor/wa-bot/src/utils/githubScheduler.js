/**
 * Schedule individual GitHub trending repo posts throughout the day.
 *
 * Durable slot tracking + retries so a failed/missed slot can still post
 * instead of being burned in memory before a successful send.
 */

import { logger } from './logger.js';
import {
    formatSlotKey,
    getCurrentDueSlot,
    getMsUntilNextNewsPost,
    getPastDueSlotsToday,
    parsePostTimesFromConfig,
} from './newsScheduler.js';

export { parsePostTimesFromConfig };

const RETRY_MS = 45_000;
const MAX_RETRIES = 3;
const CATCHUP_GAP_MS = 2_500;
const CATCHUP_RETRY_DELAY_MS = 60_000;

/**
 * @param {object} options
 * @param {() => import('baileys').WASocket | null} options.getSock
 * @param {object} options.botState
 * @param {{ checkAndPostRepo: Function, isSlotDone?: Function, markSlotDone?: Function }} options.githubController
 * @param {{ GITHUB_TRENDING_ENABLED: boolean, GITHUB_TRENDING_TIMES: string[], GITHUB_TRENDING_TIMEZONE: string }} options.config
 */
export function startGithubScheduler({ getSock, botState, githubController, config }) {
    let postTimeout = null;
    let stopped = false;
    /** @type {Set<string>} */
    const inFlight = new Set();

    if (!config.GITHUB_TRENDING_ENABLED) {
        logger.info('🐙 GitHub trending scheduler disabled');
        return { stop() {} };
    }

    const slots = parsePostTimesFromConfig(config.GITHUB_TRENDING_TIMES);
    if (!slots.length) {
        logger.warn('🐙 GitHub trending enabled but no post times configured');
        return { stop() {} };
    }

    if (!botState.lastGithubPostSlots) {
        botState.lastGithubPostSlots = {};
    }

    async function isDone(slotKey) {
        if (botState.lastGithubPostSlots[slotKey]) return true;
        if (typeof githubController.isSlotDone === 'function') {
            try {
                if (await githubController.isSlotDone(slotKey)) {
                    botState.lastGithubPostSlots[slotKey] = true;
                    return true;
                }
            } catch (err) {
                logger.warn(`GitHub slot lookup failed: ${err.message}`);
            }
        }
        return false;
    }

    async function markDone(slotKey, meta) {
        botState.lastGithubPostSlots[slotKey] = true;
        if (typeof githubController.markSlotDone === 'function') {
            try {
                await githubController.markSlotDone(slotKey, meta);
            } catch (err) {
                logger.warn(`GitHub slot mark failed: ${err.message}`);
            }
        }
    }

    /**
     * @returns {Promise<boolean>} true if slot is settled (posted or permanently skipped)
     */
    async function runSlot(slotKey, slotIndex, attempt = 0) {
        if (stopped) return true;
        if (await isDone(slotKey)) return true;
        if (inFlight.has(slotKey)) return false;
        inFlight.add(slotKey);

        try {
            const sock = getSock();
            const result = await githubController.checkAndPostRepo(sock, botState, slotIndex);
            const reason = result?.reason || 'unknown';
            const posted = Number(result?.posted) || 0;

            if (posted > 0) {
                await markDone(slotKey, {
                    posted,
                    reason: 'posted',
                    repo: result?.repo || '',
                });
                return true;
            }

            // Permanent skips — don't burn retries forever
            if (reason === 'disabled' || reason === 'no_groups') {
                await markDone(slotKey, { posted: 0, reason });
                return true;
            }

            if (attempt < MAX_RETRIES) {
                logger.warn(
                    `🐙 GitHub slot ${slotKey} not posted (${reason}); retry ${attempt + 1}/${MAX_RETRIES} in ${Math.round(RETRY_MS / 1000)}s`
                );
                setTimeout(() => {
                    void runSlot(slotKey, slotIndex, attempt + 1);
                }, RETRY_MS);
                return false;
            }

            // Exhausted retries for no_repo / no_sock / send_failed — leave unmarked
            // so a later catch-up (or next restart) can still try today.
            if (reason === 'no_repo') {
                // Avoid hammering empty fetches every catch-up for the rest of the day
                await markDone(slotKey, { posted: 0, reason: 'no_repo' });
                return true;
            }

            logger.error(`🐙 GitHub slot ${slotKey} gave up after ${MAX_RETRIES} retries (${reason})`);
            return false;
        } catch (err) {
            logger.error(`GitHub slot ${slotKey} failed: ${err.message}`);
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

    async function catchUpMissedSlots() {
        if (stopped) return;
        const past = getPastDueSlotsToday(
            config.GITHUB_TRENDING_TIMES,
            config.GITHUB_TRENDING_TIMEZONE
        );
        for (const slot of past) {
            if (stopped) return;
            const slotKey = formatSlotKey(
                new Date(),
                config.GITHUB_TRENDING_TIMEZONE,
                slot.hour,
                slot.minute
            );
            if (await isDone(slotKey)) continue;
            logger.info(`🐙 Catching up GitHub slot ${slotKey}`);
            await runSlot(slotKey, slot.index, 0);
            await new Promise((r) => setTimeout(r, CATCHUP_GAP_MS));
        }
    }

    const scheduleNextPost = () => {
        if (stopped) return;

        const delay = getMsUntilNextNewsPost(config.GITHUB_TRENDING_TIMES, config.GITHUB_TRENDING_TIMEZONE);
        const nextAt = new Date(Date.now() + delay).toLocaleString('en-IN', {
            timeZone: config.GITHUB_TRENDING_TIMEZONE,
            dateStyle: 'medium',
            timeStyle: 'short',
        });
        logger.info(
            `🐙 Next GitHub trending repo scheduled at ${nextAt} (${config.GITHUB_TRENDING_TIMEZONE})`
        );

        postTimeout = setTimeout(async () => {
            try {
                const due = getCurrentDueSlot(
                    config.GITHUB_TRENDING_TIMES,
                    config.GITHUB_TRENDING_TIMEZONE
                );
                if (!due) {
                    // Clock skew / minute already rolled — still try catch-up
                    await catchUpMissedSlots();
                    return;
                }

                const slotIndex = slots.findIndex(
                    (slot) => slot.hour === due.hour && slot.minute === due.minute
                );
                if (slotIndex < 0) {
                    return;
                }

                const slotKey = formatSlotKey(
                    new Date(),
                    config.GITHUB_TRENDING_TIMEZONE,
                    due.hour,
                    due.minute
                );
                await runSlot(slotKey, slotIndex, 0);
            } catch (err) {
                logger.error(`GitHub trending scheduled post failed: ${err.message}`);
            } finally {
                scheduleNextPost();
            }
        }, delay);
    };

    // Recover anything missed while the bot was down / reconnecting
    void catchUpMissedSlots().catch((err) => {
        logger.warn(`GitHub catch-up failed: ${err.message}`);
    });
    // Second pass — WA session sometimes not ready on the first tick
    setTimeout(() => {
        void catchUpMissedSlots().catch((err) => {
            logger.warn(`GitHub delayed catch-up failed: ${err.message}`);
        });
    }, CATCHUP_RETRY_DELAY_MS);

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
