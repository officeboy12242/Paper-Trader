/**
 * SweepAlertService — auto-alerts for liquidity sweeps.
 *
 * Scans NIFTY and SENSEX every 5 minutes during market hours. A sweep is a
 * single-bar event: price runs the stops under a level and closes back above
 * it. The scan interval matches the candle interval on purpose, because a
 * setup detected two bars late is not the setup that was measured.
 *
 * Each alert carries a confidence percent derived from measured win rates —
 * the grade's, blended with that index's own. NIFTY and SENSEX do not score
 * the same and the number says so:
 *
 *   NIFTY  A+ 56%   A 53%   (PF 1.48)
 *   SENSEX A+ 50%   A 46%   (PF 0.95)
 *
 * SENSEX is alerted because it is traded here on request, but its profit
 * factor is below 1 in testing, so its alerts are labelled as such rather than
 * presented as equal to NIFTY's.
 *
 * Cooldown is per index and per pool level: a sweep of the SAME level inside
 * the window is the same trade being re-detected, while a sweep of a new level
 * is a genuinely new setup and goes out immediately.
 */

import { logger } from '../utils/logger.js';
import { F_AND_O_INDICES } from '../data/indexUniverse.js';
import { fetchBseOptionChain, pickStrike } from './BseOptionChainService.js';
import { nseOptionChainService } from './NseOptionChainService.js';
import {
    formatSweepAlert,
    isTradeableTime,
    scanIndexForSweep,
} from './LiquiditySweepScanService.js';

const SCAN_INTERVAL_MS = 5 * 60 * 1000; // matches the 5m candle
const COOLDOWN_MS = 20 * 60 * 1000; // per index+level
const FIRST_SCAN_DELAY_MS = 20_000;

/** Only these are auto-alerted. Others remain available on demand. */
export const ALERT_INDICES = (process.env.SWEEP_ALERT_INDICES || 'NIFTY,SENSEX')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

/** Skip anything below this confidence. */
export const MIN_CONFIDENCE = Number(process.env.SWEEP_MIN_CONFIDENCE || 45);

/** Short reuse window on the NSE chain: a sweep alert quotes a live premium. */
const CHAIN_REUSE_MS = 60_000;

/** Premium band for the suggested strike, in rupees. */
const PREMIUM_MIN = Number(process.env.SWEEP_PREMIUM_MIN || 50);
const PREMIUM_MAX = Number(process.env.SWEEP_PREMIUM_MAX || 400);

class SweepAlertService {
    constructor() {
        this._timer = null;
        this._enabled = false;
        this._sent = new Map(); // `${index}:${level}` -> timestamp
        this._getGroups = null;
        this._sendMessage = null;
    }

    start({ getGroups, sendMessage } = {}) {
        if (this._timer) return;
        this._getGroups = getGroups;
        this._sendMessage = sendMessage;
        this._enabled = true;

        logger.info(
            `⚡ SweepAlertService started — ${ALERT_INDICES.join(', ')} every 5 min, ` +
                `min confidence ${MIN_CONFIDENCE}%`,
        );

        this._timer = setInterval(() => void this._scan(), SCAN_INTERVAL_MS);
        setTimeout(() => void this._scan(), FIRST_SCAN_DELAY_MS);
    }

    stop() {
        if (this._timer) clearInterval(this._timer);
        this._timer = null;
        this._enabled = false;
        logger.info('⚡ SweepAlertService stopped');
    }

    /**
     * Same level inside the cooldown means the same trade being re-detected,
     * not a second opportunity. A different level is a new setup.
     */
    _isDuplicate(indexKey, level) {
        const key = `${indexKey}:${Math.round(level)}`;
        const at = this._sent.get(key);
        if (at && Date.now() - at < COOLDOWN_MS) return true;
        this._sent.set(key, Date.now());

        // Keep the map from growing across a long session.
        if (this._sent.size > 200) {
            const cutoff = Date.now() - COOLDOWN_MS;
            for (const [k, t] of this._sent) if (t < cutoff) this._sent.delete(k);
        }
        return false;
    }

    /** Nearest tradeable strike, from whichever exchange lists the index. */
    async _resolveStrike(spec, setup) {
        try {
            if (spec.exchange === 'BSE') {
                const snap = await fetchBseOptionChain(spec.nse);
                if (!snap) return null;
                const strike = pickStrike(snap, setup.side, {
                    minPremium: PREMIUM_MIN,
                    maxPremium: PREMIUM_MAX,
                });
                return strike
                    ? {
                          strike,
                          expiry: snap.expiry,
                          chainAsOf: snap.chainTimestamp,
                          chainLive: snap.isLive,
                          chainAgeMinutes: snap.ageMinutes,
                      }
                    : null;
            }

            // `getChainSnapshot` does not exist on NseOptionChainService and never
            // did. Called with `?.()` it resolved to undefined instead of throwing,
            // so this whole branch returned null and every NIFTY sweep alert went
            // out with NO strike, premium, expiry or per-lot cost — while SENSEX,
            // which uses the BSE path above, showed all of it. Silent because an
            // optional call on a missing method is indistinguishable from a chain
            // that simply had nothing usable.
            const ctx = await nseOptionChainService.fetchOptionContext(spec.nse, {
                // Same contract as the BSE branch: take what the chain has and let
                // the formatter label its freshness, rather than dropping the
                // premium entirely. Anything older is reported as a settlement
                // price, never passed off as live.
                allowStale: true,
                maxAgeMs: CHAIN_REUSE_MS,
            });
            const snap = ctx?.snapshot;
            if (!snap?.strikes?.length) return null;

            const leg = setup.side === 'PE' ? 'pe' : 'ce';
            const usable = snap.strikes.filter((s) => {
                const ltp = s[leg]?.ltp;
                return Number.isFinite(ltp) && ltp >= PREMIUM_MIN && ltp <= PREMIUM_MAX;
            });
            if (!usable.length) return null;
            const strike = usable.reduce((best, s) =>
                Math.abs(s.strike - snap.spot) < Math.abs(best.strike - snap.spot) ? s : best,
            );
            return {
                strike,
                expiry: snap.expiry,
                // Mirrors the BSE shape so the formatter's freshness warning works
                // for NIFTY too instead of silently omitting it.
                chainAsOf: snap.chainTimestamp,
                chainLive: snap.stale !== true,
                chainAgeMinutes: Number.isFinite(snap.ageSec) ? Math.round(snap.ageSec / 60) : null,
            };
        } catch (err) {
            // A missing chain costs the strike suggestion, not the alert: the
            // index levels are the tradeable part and they do not need it.
            logger.debug(`sweep strike lookup ${spec.nse}: ${err.message}`);
            return null;
        }
    }

    async _scan() {
        if (!this._enabled) return;
        if (!isTradeableTime(new Date())) return;

        for (const key of ALERT_INDICES) {
            const base = F_AND_O_INDICES[key];
            if (!base) {
                logger.warn(`SweepAlert: unknown index ${key}`);
                continue;
            }

            try {
                const setup = await scanIndexForSweep({ key, ...base });
                if (!setup) continue;
                if ((setup.confidence?.percent ?? 0) < MIN_CONFIDENCE) continue;
                if (this._isDuplicate(key, setup.level)) continue;

                const strikeInfo = await this._resolveStrike({ key, ...base }, setup);
                const text = formatSweepAlert(setup, strikeInfo || {});

                const groups = (await this._getGroups?.()) || [];
                if (!groups.length) {
                    logger.info(`SweepAlert ${key} ${setup.grade} — no groups enabled`);
                    continue;
                }
                // getGroups is wired to getScalpGroups(), which returns group
                // DOCUMENTS, not ids. Iterating them straight into sendMessage
                // passed an object where Baileys wants a JID string. Accept
                // either shape so the alert survives whichever is injected.
                const chatIds = groups
                    .map((g) => (typeof g === 'string' ? g : g?.group_id))
                    .filter(Boolean);
                for (const chatId of chatIds) {
                    try {
                        await this._sendMessage?.(chatId, { text });
                    } catch (err) {
                        logger.error(`Failed to send sweep alert to ${chatId}: ${err.message}`);
                    }
                }
                logger.info(
                    `⚡ Sweep alert sent: ${key} ${setup.grade} ` +
                        `${setup.confidence.percent}% level ${setup.level}`,
                );
            } catch (err) {
                logger.error(`SweepAlert ${key} failed: ${err.message}`);
            }
        }
    }

    /** Force one scan ignoring the time window — for /sweep and self-checks. */
    async scanNow({ ignoreTimeWindow = true } = {}) {
        const out = [];
        for (const key of ALERT_INDICES) {
            const base = F_AND_O_INDICES[key];
            if (!base) continue;
            const setup = await scanIndexForSweep({ key, ...base }, { ignoreTimeWindow });
            if (!setup) continue;
            const strikeInfo = await this._resolveStrike({ key, ...base }, setup);
            out.push({ setup, strikeInfo, text: formatSweepAlert(setup, strikeInfo || {}) });
        }
        return out;
    }
}

export const sweepAlertService = new SweepAlertService();
export default sweepAlertService;
