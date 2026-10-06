/**
 * Schedule daily F&O trade alerts.
 *
 * One clock by default: every source posts at TRADE_ALERT_TIME (09:20). A
 * breakout entry decays quickly, so posting later means filling above the level
 * and giving up the move — early beats complete.
 *
 * What that costs heatmap2: at 09:20 only the forming 09:15 bar exists, so v2
 * contributes its SELECTION (live movers in leading sectors, beating NIFTY —
 * still better than v1's pre-open auction snapshot) but not breakout levels,
 * which need the opening range closed plus a confirming bar.
 *
 * Setting TRADE_ALERT_HEATMAP2_TIMES adds later slots for heatmap2 groups that
 * do carry levels. When it is set, those groups move off the main slot so
 * nobody gets two morning posts; same-symbol dedupe (`trade_alert_sent`) means
 * a second slot adds new names rather than repeating the first.
 */

import { logger } from './logger.js';
import { formatSlotKey, msUntilTimeInTimezone } from './newsScheduler.js';
import { createDurableSlotStore } from './durableSlots.js';

const HEATMAP2 = 'heatmap2';
const PREOPEN = 'preopen';
const TURNOVER = 'turnover';

/**
 * Sources that have their own clock and must therefore be EXCLUDED from the
 * shared slot, or their groups would post twice.
 *
 * The inverse mistake is worse: excluding a source here that has no clock of its
 * own means those groups never fire at all. So this is derived strictly from
 * which times are configured, and is exported so that contract is testable.
 *
 * @returns {string[]}
 */
export function computeMovedOffSources(config = {}) {
    const v2Times = Array.isArray(config.TRADE_ALERT_HEATMAP2_TIMES)
        ? config.TRADE_ALERT_HEATMAP2_TIMES
        : [];
    return [
        ...(v2Times.length ? [HEATMAP2] : []),
        ...(config.TRADE_ALERT_PREOPEN_TIME ? [PREOPEN] : []),
        ...(config.TRADE_ALERT_TURNOVER_TIME ? [TURNOVER] : []),
    ];
}

/**
 * The morning volatility slot does NOT move sources off the shared clock.
 * It is an ADDITIONAL scan at 09:35 that re-runs discovery with fresh data.
 * Groups already posted at 09:20 skip duplicate symbols via trade_alert_sent dedup.
 * This is a pure additive clock — it never excludes sources from other slots.
 */

function parseAlertTime(timeStr) {
    const [h, m = '0'] = String(timeStr || '09:20').trim().split(':');
    return { hour: Number(h), minute: Number(m) };
}

/**
 * @param {object} options
 * @param {() => import('baileys').WASocket | null} options.getSock
 * @param {object} options.botState
 * @param {import('../controllers/TradeAlertController.js').default} options.tradeAlertController
 * @param {object} options.config
 * @param {import('../models/BotSettings.js').default} [options.botSettings]
 * @param {{ enqueue: Function }|null} [options.jobQueue]
 */
export function startTradeAlertScheduler({
    getSock,
    botState,
    tradeAlertController,
    config,
    botSettings = null,
    jobQueue = null,
}) {
    const timers = [];
    let stopped = false;
    const slots = createDurableSlotStore(botSettings, 'trade');

    if (config.TRADE_ALERT_ENABLED === false) {
        return { stop() {} };
    }

    const timezone = config.TRADE_ALERT_TIMEZONE || 'Asia/Kolkata';

    /**
     * @param {string} name distinct slot id, so two clocks cannot share a
     *   "already ran today" marker and silently cancel each other
     * @param {string} timeStr
     * @param {object} postOpts forwarded to postDailyAlerts
     */
    const scheduleSlot = (name, timeStr, postOpts) => {
        const { hour, minute } = parseAlertTime(timeStr);
        if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
            logger.warn(`Trade alert scheduler: bad time for ${name} (${timeStr})`);
            return;
        }
        const hhmm = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

        const next = () => {
            if (stopped) return;

            const delay = msUntilTimeInTimezone(hour, minute, timezone);
            const nextAt = new Date(Date.now() + delay).toLocaleString('en-IN', {
                timeZone: timezone,
                dateStyle: 'medium',
                timeStyle: 'short',
            });
            logger.info(`📈 Next trade alert [${name}] at ${hhmm} → ${nextAt} (${timezone})`);

            const t = setTimeout(async () => {
                try {
                    const sock = getSock();
                    const slotKey = `${name}:${formatSlotKey(new Date(), timezone, hour, minute)}`;
                    if (await slots.isDone(botState, slotKey, 'lastTradeAlertSlot')) {
                        return;
                    }
                    if (!sock && !jobQueue) return;

                    if (jobQueue) {
                        await jobQueue.enqueue(
                            'trade.daily_alerts',
                            { slotKey, ...postOpts },
                            { jobKey: `trade.daily:${slotKey}`, maxAttempts: 2 }
                        );
                        logger.info(`📈 Trade alert enqueued [${name}] (${slotKey})`);
                    } else {
                        if (!sock) return;
                        await tradeAlertController.postDailyAlerts(sock, postOpts);
                    }
                    await slots.markDone(botState, slotKey, 'lastTradeAlertSlot');
                } catch (error) {
                    logger.error(`Trade alert [${name}] failed: ${error.message}`);
                } finally {
                    next();
                }
            }, delay);
            timers.push(t);
        };

        next();
    };

    const v2Times = Array.isArray(config.TRADE_ALERT_HEATMAP2_TIMES)
        ? config.TRADE_ALERT_HEATMAP2_TIMES
        : [];

    // With no extra slots configured, every source shares the main clock.
    const movedOff = computeMovedOffSources(config);
    scheduleSlot('default', config.TRADE_ALERT_TIME, {
        excludeSources: movedOff.length ? movedOff : null,
        slotLabel: movedOff.length ? 'pre-market' : null,
    });

    // Only when explicitly configured: a later post for heatmap2 groups that
    // carries confirmed breakout levels the main slot is too early to produce.
    v2Times.forEach((time, i) => {
        scheduleSlot(`heatmap2-${i + 1}`, time, {
            onlySources: [HEATMAP2],
            slotLabel: i === 0 ? 'v2 morning' : 'v2 midday',
        });
    });

    // Pre-open groups need their own earlier clock: the NSE auction closes at
    // 09:08, so 09:15 is the earliest post that carries same-day information and
    // the latest that still beats the open. Empty by default — a group only lands
    // here once it is explicitly switched to the `preopen` source.
    const preOpenTime = config.TRADE_ALERT_PREOPEN_TIME;
    if (preOpenTime) {
        scheduleSlot('preopen', preOpenTime, {
            onlySources: [PREOPEN],
            slotLabel: 'pre-open auction',
        });
    }

    // Turnover-band groups can also post early — that source reads only the
    // PREVIOUS session's daily data, so unlike heatmap2 it has nothing to gain by
    // waiting for the opening range. Its own clock, empty by default, so a group
    // stays on the shared 09:20 slot unless this is set.
    const turnoverTime = config.TRADE_ALERT_TURNOVER_TIME;
    if (turnoverTime) {
        scheduleSlot('turnover', turnoverTime, {
            onlySources: [TURNOVER],
            slotLabel: 'turnover band',
        });
    }

    // Morning volatility scan — runs AFTER market opens (default 09:35 IST).
    // Only for heatmap2 groups: at 09:20 the opening range hasn't closed yet,
    // so v2 can only show live movers (selection) but not breakout levels.
    // At 09:35 the 09:15 range is closed + confirming bar exists — this is when
    // heatmap2's VWAP/RS/ATR filters actually work.
    //
    // Other sources (heatmap, nse, legacy, preopen, turnover) keep their single
    // 09:20 slot — they don't benefit from a second scan.
    // Groups already posted at 09:20 skip duplicate symbols via trade_alert_sent.
    const morningVolatilityTime = config.TRADE_ALERT_MORNING_VOLATILITY_TIME;
    if (morningVolatilityTime) {
        scheduleSlot('morning-volatility', morningVolatilityTime, {
            onlySources: [HEATMAP2],
            slotLabel: 'morning volatility',
            forceRefresh: true,
        });
    }

    return {
        stop() {
            stopped = true;
            for (const t of timers) clearTimeout(t);
            timers.length = 0;
        },
    };
}
