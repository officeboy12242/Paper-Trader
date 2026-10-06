/**
 * Daily auto open/close scheduler for /autochat groups.
 *
 * Fires at AUTOCHAT_OPEN_TIME (default 09:00) and AUTOCHAT_CLOSE_TIME
 * (default 23:55) in AUTOCHAT_TIMEZONE, plus a startup catch-up for
 * transitions missed while the bot was offline.
 */

import { logger } from './logger.js';
import { msUntilTimeInTimezone, formatSlotKey } from './newsScheduler.js';
import { createDurableSlotStore } from './durableSlots.js';

function parseClockTime(timeStr) {
    const [h, m = '0'] = String(timeStr || '').trim().split(':');
    return { hour: Number(h), minute: Number(m) };
}

/**
 * @param {object} options
 * @param {() => import('baileys').WASocket | null} options.getSock
 * @param {object} options.botState
 * @param {import('../controllers/AutoChatController.js').default} options.autoChatController
 * @param {object} options.config
 * @param {import('../models/BotSettings.js').default} [options.botSettings]
 */
export function startAutoChatScheduler({
    getSock,
    botState,
    autoChatController,
    config,
    botSettings = null,
}) {
    let transitionTimeout = null;
    let catchUpTimer = null;
    let stopped = false;
    const slots = createDurableSlotStore(botSettings, 'autochat');

    if (config.AUTOCHAT_ENABLED === false) {
        logger.info('🔕 Auto open/close chat disabled (AUTOCHAT_ENABLED=false)');
        return { stop() {} };
    }

    const timezone = config.AUTOCHAT_TIMEZONE || 'Asia/Kolkata';
    const open = parseClockTime(config.AUTOCHAT_OPEN_TIME || '09:00');
    const close = parseClockTime(config.AUTOCHAT_CLOSE_TIME || '23:55');

    const scheduleNext = () => {
        if (stopped) {
            return;
        }

        const nowMs = Date.now();
        const msToOpen = msUntilTimeInTimezone(open.hour, open.minute, timezone, nowMs);
        const msToClose = msUntilTimeInTimezone(close.hour, close.minute, timezone, nowMs);
        const isOpen = msToOpen <= msToClose;
        const delay = Math.min(msToOpen, msToClose);
        const nextAt = new Date(nowMs + delay).toLocaleString('en-IN', {
            timeZone: timezone,
            dateStyle: 'medium',
            timeStyle: 'short',
        });

        logger.info(
            `🔓 Auto chat: next ${isOpen ? 'open' : 'close'} at ` +
                `${String(isOpen ? open.hour : close.hour).padStart(2, '0')}:` +
                `${String(isOpen ? open.minute : close.minute).padStart(2, '0')} → ${nextAt} (${timezone})`
        );

        transitionTimeout = setTimeout(async () => {
            try {
                const sock = getSock();
                if (!sock) return;
                const slot = formatSlotKey(
                    new Date(),
                    timezone,
                    isOpen ? open.hour : close.hour,
                    isOpen ? open.minute : close.minute
                );
                if (await slots.isDone(botState, slot, isOpen ? 'lastAutoChatOpenSlot' : 'lastAutoChatCloseSlot')) {
                    return;
                }
                if (isOpen) {
                    await autoChatController.runOpenTransition(sock);
                } else {
                    await autoChatController.runCloseTransition(sock);
                }
                await slots.markDone(botState, slot, isOpen ? 'lastAutoChatOpenSlot' : 'lastAutoChatCloseSlot');
            } catch (error) {
                logger.error(`Auto chat scheduled transition failed: ${error.message}`);
            } finally {
                scheduleNext();
            }
        }, delay);
    };

    scheduleNext();

    // Catch up on a missed transition after a restart/deploy.
    if (config.AUTOCHAT_CATCHUP_ENABLED !== false) {
        catchUpTimer = setTimeout(() => {
            void autoChatController.runCatchUpIfNeeded(getSock()).catch((err) => {
                logger.error(`Auto chat catch-up failed: ${err.message}`);
            });
        }, 60_000);
    }

    return {
        stop() {
            stopped = true;
            if (transitionTimeout) {
                clearTimeout(transitionTimeout);
                transitionTimeout = null;
            }
            if (catchUpTimer) {
                clearTimeout(catchUpTimer);
                catchUpTimer = null;
            }
        },
    };
}
