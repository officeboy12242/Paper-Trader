/**
 * Continuous /tradenow auto-trigger.
 *
 * Re-runs the /tradenow analysis for the configured indices through the trading
 * session and posts a card the moment a side clears TRADENOW_AUTO_MIN_CONF.
 *
 * ── What this trigger actually is ────────────────────────────────────────────
 * The gate is the *model's own* "Primary Confidence" figure from
 * tradeAnalysisPrompt.js. It is a self-assessment produced fresh on every call,
 * not a measured win rate, and nothing has calibrated it against outcomes. Two
 * runs a minute apart can disagree. Treat these as prompts to go look, not as
 * a system with a known edge.
 *
 * Because of that, every firing is journalled to `trade_alert_outcomes` via the
 * same path the daily alerts use, so /tradelert stats accumulates a real hit
 * rate for this trigger over time. That measured number — not the 65 — is what
 * should eventually decide the threshold.
 *
 * ── Keeping it from becoming a spam machine ──────────────────────────────────
 *   1. Per index+side cooldown, so a sideways stretch that keeps re-crossing
 *      the threshold cannot post repeatedly.
 *   2. A daily cap on posted alerts.
 *   3. A daily cap on LLM calls — each scan is a full analysis, and the free
 *      provider tiers are per-day budgets that the rest of the bot shares.
 *   4. Nothing fires on a stale option chain: entry premiums come from the
 *      chain, and a cached premium reads exactly like a live one.
 */

import { logger } from './logger.js';
import { isIndianEquityTradingDay, getIndiaMarketMode } from './indianMarketCalendar.js';
import { parseTradeSignal } from './tradeSignalParser.js';
import { safeSendMessage } from './waMessage.js';

const BAR_MS = 5 * 60 * 1000;
/** Analysis is slow (~60-120s); start a beat after the bar so data is settled. */
const BAR_SETTLE_MS = 20_000;

export function msToNextScan(nowMs = Date.now(), intervalMs = BAR_MS, settleMs = BAR_SETTLE_MS) {
    const since = nowMs % intervalMs;
    let wait = intervalMs - since + settleMs;
    if (wait > intervalMs + settleMs) wait -= intervalMs;
    return wait;
}

/** Local (IST) day key, so the daily caps reset with the trading day. */
export function istDayKey(nowMs = Date.now()) {
    return new Date(nowMs).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

/**
 * Decide whether one analysis result should fire.
 * Pure, so the whole gate is testable without a socket or an LLM.
 *
 * @returns {{fire: boolean, side?: 'CE'|'PE', confidence: number, reason?: string}}
 */
export function evaluateSignal(text, {
    minConfidence,
    index,
    nowMs,
    lastPosted = new Map(),
    cooldownMs,
    postedToday = 0,
    maxPerDay,
    chainStale = false,
}) {
    const signal = parseTradeSignal(text, { minConfidence });
    const confidence = signal.confidence || 0;

    if (chainStale) {
        return { fire: false, confidence, reason: 'stale option chain — premiums unreliable' };
    }
    if (postedToday >= maxPerDay) {
        return { fire: false, confidence, reason: `daily cap reached (${maxPerDay})` };
    }
    if (signal.isNoTrade || (!signal.isBuyCall && !signal.isBuyPut)) {
        return { fire: false, confidence, reason: 'no actionable side' };
    }
    if (confidence < minConfidence) {
        return { fire: false, confidence, reason: `below threshold (${confidence}% < ${minConfidence}%)` };
    }

    const side = signal.isBuyPut ? 'PE' : 'CE';
    const last = lastPosted.get(`${index}:${side}`) || 0;
    if (nowMs - last < cooldownMs) {
        const mins = Math.ceil((cooldownMs - (nowMs - last)) / 60_000);
        return { fire: false, side, confidence, reason: `cooling down ${mins}m` };
    }

    return { fire: true, side, confidence };
}

/**
 * @param {object} o
 * @param {() => object|null} o.getSock
 * @param {import('../controllers/TradeAlertController.js').default} o.tradeAlertController
 * @param {import('../models/GroupManager.js').default} o.groupManager
 * @param {object} o.config
 */
export function startTradeNowScheduler({ getSock, tradeAlertController, groupManager, config = {} }) {
    if (!config.TRADENOW_AUTO_ENABLED) {
        logger.info('📉 Continuous /tradenow auto-trigger is off (TRADENOW_AUTO_ENABLED=false)');
        return { stop() {}, tick: async () => ({ skipped: 'disabled' }) };
    }

    const indices = (config.TRADENOW_AUTO_INDICES || ['NIFTY']).filter(Boolean);
    const minConfidence = config.TRADENOW_AUTO_MIN_CONF ?? 65;
    const cooldownMs = config.TRADENOW_AUTO_COOLDOWN_MS ?? 30 * 60_000;
    const maxPerDay = config.TRADENOW_AUTO_MAX_PER_DAY ?? 6;
    const maxScansPerDay = config.TRADENOW_AUTO_MAX_SCANS_PER_DAY ?? 60;
    const intervalMs = config.TRADENOW_AUTO_INTERVAL_MS ?? BAR_MS;

    /** `INDEX:SIDE` → last posted at */
    const lastPosted = new Map();
    let dayKey = istDayKey();
    let postedToday = 0;
    let scansToday = 0;
    let timer = null;
    let stopped = false;

    function rollDayIfNeeded(nowMs) {
        const key = istDayKey(nowMs);
        if (key !== dayKey) {
            dayKey = key;
            postedToday = 0;
            scansToday = 0;
            lastPosted.clear();
        }
    }

    async function tick() {
        const nowMs = Date.now();
        rollDayIfNeeded(nowMs);

        if (!isIndianEquityTradingDay(new Date(nowMs))) {
            return { skipped: 'not a trading day' };
        }
        if (getIndiaMarketMode(new Date(nowMs)) !== 'open') {
            return { skipped: 'market closed' };
        }
        if (scansToday >= maxScansPerDay) {
            return { skipped: `scan budget spent (${maxScansPerDay})` };
        }

        const sock = getSock?.();
        if (!sock) return { skipped: 'no socket' };
        if (!tradeAlertController?.tradeLlm?.isConfigured?.()) {
            return { skipped: 'no trade LLM configured' };
        }

        // No opted-in groups means no reason to spend an LLM call at all.
        const groups = await groupManager.getTradeAlertGroups();
        if (!groups.length) return { skipped: 'no /tradelert on groups' };

        const results = [];
        for (const index of indices) {
            if (stopped) break;
            if (scansToday >= maxScansPerDay) break;

            try {
                scansToday++;
                const text = await tradeAlertController.analyzeSymbol(index, { mode: 'live' });

                // The card is built from the option chain; if that came from
                // cache the premiums are not tradeable.
                const chainStale = /STALE DATA|cached chain/i.test(text || '');

                const verdict = evaluateSignal(text, {
                    minConfidence,
                    index,
                    nowMs: Date.now(),
                    lastPosted,
                    cooldownMs,
                    postedToday,
                    maxPerDay,
                    chainStale,
                });

                // Every evaluation is logged, fired or not — this is the record
                // that lets the threshold be chosen from data later.
                logger.info(
                    `📉 tradenow-auto ${index}: conf=${verdict.confidence}% `
                    + `${verdict.fire ? `FIRE ${verdict.side}` : `hold (${verdict.reason})`}`
                );

                if (!verdict.fire) {
                    results.push({ index, posted: false, ...verdict });
                    continue;
                }

                const header =
                    `⚡ *AUTO SIGNAL* · ${index} ${verdict.side}\n`
                    + `_Fired at ${verdict.confidence}% model confidence (threshold ${minConfidence}%)._\n`
                    + `_Self-reported by the model, not a measured win rate — verify before entering._\n\n`;

                for (const groupId of groups) {
                    await safeSendMessage(sock, groupId, { text: header + text }).catch((err) =>
                        logger.warn(`tradenow-auto post to ${groupId} failed: ${err.message}`)
                    );
                }

                lastPosted.set(`${index}:${verdict.side}`, Date.now());
                postedToday++;
                results.push({ index, posted: true, ...verdict });

                // Journal it so /tradelert stats can grade this trigger.
                await tradeAlertController._logPostedAlert?.({
                    symbol: index,
                    signal: parseTradeSignal(text, { minConfidence }),
                    resultEntry: null,
                    source: 'tradenow-auto',
                    meta: { setup: 'tradenow-auto', confidence: verdict.confidence },
                    groupId: groups[0],
                }).catch(() => {});
            } catch (err) {
                logger.warn(`tradenow-auto ${index} failed: ${err.message}`);
                results.push({ index, posted: false, error: err.message });
            }
        }

        return { results, postedToday, scansToday };
    }

    function schedule() {
        if (stopped) return;
        timer = setTimeout(async () => {
            try {
                await tick();
            } catch (err) {
                logger.error(`tradenow-auto tick failed: ${err.message}`);
            }
            schedule();
        }, msToNextScan(Date.now(), intervalMs));
        timer.unref?.();
    }

    logger.info(
        `📉 Continuous /tradenow auto-trigger ON — ${indices.join(', ')} every `
        + `${Math.round(intervalMs / 60000)}m, fires at ≥${minConfidence}%, `
        + `cooldown ${Math.round(cooldownMs / 60000)}m, max ${maxPerDay}/day`
    );
    schedule();

    return {
        tick,
        stop() {
            stopped = true;
            if (timer) clearTimeout(timer);
        },
    };
}

export default { startTradeNowScheduler, evaluateSignal, msToNextScan, istDayKey };
