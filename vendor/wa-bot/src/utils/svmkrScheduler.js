/**
 * The live SVMKR loop — the only continuously-running market scanner in the bot.
 *
 * Every other trade alert here fires on a fixed clock (09:20, expiry 09:35 /
 * 13:15). This one wakes on every 5m bar close during the session, because a
 * trailing-stop cross happens when it happens.
 *
 * Three things keep it from becoming a spam machine:
 *   1. It only acts on CLOSED bars, so a signal cannot appear and vanish.
 *   2. A cross must be NEW on the last closed bar — "price is still above the
 *      stop" is not a signal.
 *   3. A per-index+side cooldown, so a choppy stretch that crosses repeatedly
 *      cannot post five cards in twenty minutes.
 *
 * Trades are unlimited per day by design (the user's call): there is no daily
 * cap, and stacking on the same side is allowed once the cooldown clears.
 */

import { logger } from './logger.js';
import { isIndianEquityTradingDay, getIndiaMarketMode } from './indianMarketCalendar.js';
import { formatSvmkrCard } from './svmkrCard.js';
import { svmkrLlmVerdictService } from '../services/SvmkrLlmVerdictService.js';
import { safeSendMessage } from './waMessage.js';

const BAR_MS = 5 * 60 * 1000;
/** Yahoo publishes a bar a beat after it closes; wait before asking for it. */
const BAR_SETTLE_MS = 25_000;

/** ms until the next 5m boundary plus the settle delay. */
export function msToNextBarClose(nowMs = Date.now(), settleMs = BAR_SETTLE_MS) {
    const sinceBar = nowMs % BAR_MS;
    let wait = BAR_MS - sinceBar + settleMs;
    // Already inside this bar's settle window — go at the next one.
    if (wait > BAR_MS + settleMs) wait -= BAR_MS;
    return wait;
}

/**
 * @param {object} o
 * @param {() => object|null} o.getSock
 * @param {import('../services/SvmkrScanService.js').default} o.scanService
 * @param {import('../services/SvmkrPositionTracker.js').default} o.tracker
 * @param {import('../models/GroupManager.js').default} o.groupManager
 * @param {object} o.config
 */
export function startSvmkrScheduler({ getSock, scanService, tracker, groupManager, config = {} }) {
    // SVMKR_ENABLED=false is a kill switch. Otherwise the real switch is per
    // group (`/svmkr on`): with no group opted in, a tick costs one indexed
    // count query and makes no Yahoo or NSE calls at all.
    if (config.SVMKR_ENABLED === false) {
        logger.info('⚡ SVMKR live scanner is disabled by SVMKR_ENABLED=false');
        return { stop() {}, tick: async () => ({ skipped: 'disabled by config' }) };
    }

    const indices = (config.SVMKR_INDICES || ['NIFTY']).filter(Boolean);
    const cooldownMs = config.SVMKR_COOLDOWN_MS || 15 * 60_000;
    /** @type {Map<string, number>} `INDEX:SIDE` → last posted at */
    const lastPosted = new Map();
    let timer = null;
    let stopped = false;
    let running = false;

    const cooledDown = (key, side, nowMs) => {
        const at = lastPosted.get(`${key}:${side}`);
        return at == null || nowMs - at >= cooldownMs;
    };

    /**
     * One pass: scan each index, post fresh setups, then poll open positions.
     * Exported through the returned handle so it can be driven manually.
     */
    const tick = async ({ nowMs = Date.now(), force = false } = {}) => {
        if (running) return { skipped: 'already running' };
        running = true;
        try {
            if (!force && !isIndianEquityTradingDay(nowMs, config)) {
                return { skipped: 'not a trading day' };
            }
            const mode = getIndiaMarketMode(nowMs);
            if (!force && mode.mode !== 'MARKET_HOURS') {
                return { skipped: `market mode ${mode.mode}` };
            }

            // Nobody opted in → do no work. Open positions are still followed to
            // their exit, so turning a group off mid-trade cannot orphan a trade.
            const listeners = await groupManager.countSvmkrGroups();
            if (!listeners) {
                const orphaned = await tracker.openPositions();
                if (!orphaned.length) {
                    return { skipped: 'no group has /svmkr on' };
                }
            }

            const sock = getSock();
            const utPosByIndex = {};
            let posted = 0;

            for (const raw of indices) {
                let scan;
                try {
                    scan = await scanService.scan(raw, { nowMs });
                } catch (err) {
                    logger.warn(`SVMKR scan ${raw} failed: ${err.message}`);
                    continue;
                }
                if (scan.tech?.pos != null) utPosByIndex[scan.key] = scan.tech.pos;

                if (!scan.setup?.fresh) {
                    logger.debug(`SVMKR ${scan.key}: ${scan.noneReason || 'no fresh cross'}`);
                    continue;
                }
                const { side } = scan.setup;
                if (!cooledDown(scan.key, side, nowMs)) {
                    logger.info(`⚡ SVMKR ${scan.key} ${side} suppressed — inside the ${Math.round(cooldownMs / 60000)}m cooldown`);
                    continue;
                }
                if (!scan.setup.plan || scan.setup.plan.lots < 1) {
                    logger.info(`⚡ SVMKR ${scan.key} ${side} skipped — ${scan.setup.plan?.blocked || 'not sizeable'}`);
                    continue;
                }

                const groups = await groupManager.getSvmkrGroups();
                if (!groups.length) {
                    logger.info('SVMKR: a setup fired but no group has `/svmkr on`');
                    continue;
                }

                // LLM verdict once per fired signal, shared across all group posts.
                scan.verdict = await svmkrLlmVerdictService.verdict(scan);
                const text = formatSvmkrCard(scan, { nowMs });
                let opened = 0;
                for (const group of groups) {
                    if (!sock) break;
                    try {
                        const sent = await safeSendMessage(sock, group.group_id, { text });
                        // Only the first group's message anchors the follow-ups;
                        // one position per group keeps each group's thread correct.
                        const pos = await tracker.open({ scan, groupId: group.group_id, sentMessage: sent });
                        if (pos) opened += 1;
                    } catch (err) {
                        logger.warn(`SVMKR post to ${group.group_id} failed: ${err.message}`);
                    }
                    await new Promise((r) => setTimeout(r, 600));
                }

                if (opened) {
                    lastPosted.set(`${scan.key}:${side}`, nowMs);
                    posted += opened;
                    logger.info(
                        `⚡ SVMKR ${scan.key} ${scan.setup.strike}${side} posted to ${opened} group(s) ` +
                            `— entry ₹${scan.setup.plan.premEntry}, SL ₹${scan.setup.plan.premStop}`
                    );
                }
            }

            const tracked = await tracker.poll(sock, { utPosByIndex });
            return { posted, tracked };
        } finally {
            running = false;
        }
    };

    const loop = () => {
        if (stopped) return;
        const delay = msToNextBarClose();
        timer = setTimeout(async () => {
            try {
                await tick();
            } catch (err) {
                logger.error(`SVMKR tick failed: ${err.message}`);
            } finally {
                loop();
            }
        }, delay);
        if (timer.unref) timer.unref();
    };

    logger.info(
        `⚡ SVMKR live scanner armed — ${indices.join(', ')} on 5m bar close, ` +
            `${Math.round(cooldownMs / 60000)}m cooldown per side. ` +
            'Idle until a group runs `/svmkr on`.'
    );
    loop();

    return {
        tick,
        stop() {
            stopped = true;
            if (timer) clearTimeout(timer);
            timer = null;
        },
    };
}
