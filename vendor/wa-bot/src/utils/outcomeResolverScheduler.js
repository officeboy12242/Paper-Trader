/**
 * Daily job: grade posted alerts, then let the graded results move the gates.
 *
 * Runs after the close so the session an alert was posted into is complete.
 * Two steps, in order — resolving first is what gives `reviewRecentOutcomes()`
 * anything to read. Before this job existed the review had never once seen a
 * resolved row, so the confidence floor never moved off its default.
 */

import { logger } from './logger.js';
import { msUntilTimeInTimezone } from './newsScheduler.js';
import { createTradeOutcomeResolver } from '../services/TradeOutcomeResolver.js';
import { createTradeOutcomeService } from '../services/TradeOutcomeService.js';

function parseTime(timeStr, fallback = '16:15') {
    const [h, m = '0'] = String(timeStr || fallback).trim().split(':');
    return { hour: Number(h), minute: Number(m) };
}

/**
 * @param {{ mongoDb: object|null, config: object }} options
 */
export function startOutcomeResolverScheduler({ mongoDb, config = {} }) {
    if (!mongoDb) {
        logger.info('📊 Outcome resolver: no database — alerts will stay PENDING');
        return { stop() {}, runNow: async () => null };
    }
    if (config.TRADE_OUTCOME_RESOLVER_ENABLED === false) {
        return { stop() {}, runNow: async () => null };
    }

    const timezone = config.TRADE_ALERT_TIMEZONE || 'Asia/Kolkata';
    const { hour, minute } = parseTime(config.TRADE_OUTCOME_RESOLVE_TIME, '16:15');
    const resolver = createTradeOutcomeResolver(mongoDb, config);
    const outcomes = createTradeOutcomeService(mongoDb, config);

    let timer = null;
    let stopped = false;

    const runNow = async () => {
        try {
            const res = await resolver.resolvePending({});
            // Only worth re-tuning when something actually got graded.
            if (res.resolved > 0) {
                await outcomes.reviewRecentOutcomes({ lookbackDays: 30 }).catch((err) =>
                    logger.debug(`Calibration review skipped: ${err.message}`)
                );
            }
            return res;
        } catch (err) {
            logger.warn(`Outcome resolver run failed: ${err.message}`);
            return null;
        }
    };

    const scheduleNext = () => {
        if (stopped) return;
        const delay = msUntilTimeInTimezone(hour, minute, timezone);
        timer = setTimeout(async () => {
            await runNow();
            scheduleNext();
        }, delay);
        if (typeof timer.unref === 'function') timer.unref();
    };

    logger.info(
        `📊 Outcome resolver scheduled daily at ${String(hour).padStart(2, '0')}:` +
            `${String(minute).padStart(2, '0')} ${timezone}`
    );
    scheduleNext();

    return {
        stop() {
            stopped = true;
            if (timer) clearTimeout(timer);
            timer = null;
        },
        runNow,
    };
}
