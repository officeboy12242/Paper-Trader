/**
 * Outcome tracking for /scalp.
 *
 * Until now /scalp logged nothing. Every setup it has ever fired went out
 * ungraded, so the "75% confidence" on the card was a model output with no
 * measured win rate behind it — and no way to tell whether any change to the
 * strategy helped or hurt. This is the missing half.
 *
 * ─── Why it resolves forward instead of using the daily resolver ─────────────
 * TradeOutcomeService's own note says it: option PREMIUMS are not retrievable
 * historically from any feed here, which is why every other premium card logs
 * the UNDERLYING and grades a spot move instead. That proxy is wrong for a scalp
 * — an 8-point premium target is not a fixed number of index points, it depends
 * on the strike's delta, and a 2-5 minute hold is far below daily-candle
 * resolution.
 *
 * But the alert scanner already refetches every chain every 3 minutes. So the
 * real premium of the exact strike we quoted IS available, live, for as long as
 * the trade is open. Grading forward off that scan costs zero extra requests and
 * grades the ACTUAL number the card printed, not a proxy for it.
 *
 * ─── Why rows are written as SCALP_OPEN, not PENDING ─────────────────────────
 * TradeOutcomeResolver.resolvePending() claims every row with outcome
 * 'PENDING' and grades it against daily candles. A scalp row would be walked
 * against the wrong instrument on the wrong timeframe and stamped with a
 * fabricated result. SCALP_OPEN keeps them out of its query until this tracker
 * settles them into WIN / LOSS / TIMEOUT.
 */

import { logger } from '../utils/logger.js';
import { getTodayDateStrIST } from '../utils/dateIST.js';

/** Give up on an unresolved scalp after this long — it is not a scalp any more. */
const MAX_HOLD_MS = 30 * 60 * 1000;
/** Open rows carry this until settled, so the daily resolver ignores them. */
export const SCALP_OPEN = 'SCALP_OPEN';

class ScalpOutcomeTracker {
    constructor() {
        /** @type {Map<string, object>} live positions keyed by fingerprint */
        this._open = new Map();
        this._col = null;
    }

    /** @param {import('mongodb').Db|null} mongoDb */
    attach(mongoDb) {
        try {
            this._col = mongoDb?.collection('trade_alert_outcomes') || null;
        } catch (err) {
            logger.warn(`Scalp outcome tracking unavailable: ${err.message}`);
            this._col = null;
        }
    }

    /** Positions still open — exposed for checks and diagnostics. */
    get openCount() {
        return this._open.size;
    }

    _reset() {
        this._open.clear();
    }

    /**
     * Record a setup at the moment it is alerted.
     *
     * @param {object} setup   parsed from the card (type/strike/entry/fingerprint)
     * @param {object} cfg     the index config
     * @param {object} [meta]  { expiry, confidence, groupIds }
     */
    async record(setup, cfg, meta = {}) {
        const entry = Number(setup?.entry);
        const strike = Number(String(setup?.strike ?? '').replace(/,/g, ''));
        if (!(entry > 0)) return;

        // A short-premium setup profits when the premium FALLS, so its target sits
        // below entry and its stop above. Getting this backwards would grade every
        // straddle exactly inverted.
        const isShort = String(setup.type || '').startsWith('SHORT');
        const target = isShort ? entry - cfg.straddleTargetPts : entry + cfg.targetPts;
        const stop = isShort ? entry + cfg.straddleStopPts : entry - cfg.stopPts;

        const row = {
            fingerprint: setup.fingerprint,
            index: cfg.key,
            type: setup.type,
            side: setup.type,
            strike: Number.isFinite(strike) ? strike : null,
            optionType: setup.type.includes('CE') ? 'CE' : setup.type.includes('PE') ? 'PE' : null,
            isShort,
            entry,
            target,
            stop,
            confidence: meta.confidence ?? null,
            expiry: meta.expiry ?? null,
            openedAt: Date.now(),
        };
        this._open.set(setup.fingerprint, row);

        if (!this._col) return;
        try {
            const res = await this._col.insertOne({
                alert_date: getTodayDateStrIST(),
                symbol: cfg.key,
                side: setup.type,
                entry,
                stop_loss: stop,
                target1: target,
                target2: null,
                confidence: meta.confidence ?? null,
                confluence: null,
                group_id: meta.groupId ?? null,
                strategy_source: 'scalp',
                setup_score: null,
                scalp_index: cfg.key,
                scalp_strike: row.strike,
                scalp_option_type: row.optionType,
                scalp_is_short: isShort,
                scalp_expiry: row.expiry,
                underlying_symbol: cfg.key,
                underlying_entry: meta.spot ?? null,
                underlying_stop: null,
                underlying_target: null,
                outcome: SCALP_OPEN,
                posted_at: new Date(),
            });
            row._id = res.insertedId;
        } catch (err) {
            logger.warn(`Scalp outcome insert failed: ${err.message}`);
        }
    }

    /**
     * Grade open positions against a freshly fetched chain.
     *
     * Called from the alert scan, which already has the chain in hand.
     *
     * @param {string} indexKey
     * @param {object} snapshot the same snapshot the card was built from
     */
    async resolveAgainst(indexKey, snapshot) {
        if (!this._open.size) return [];
        const strikes = snapshot?.strikes;
        if (!Array.isArray(strikes) || !strikes.length) return [];

        const now = Date.now();
        const settled = [];

        for (const [fp, pos] of [...this._open]) {
            if (pos.index !== indexKey) continue;

            let ltp = null;
            if (pos.optionType && pos.strike != null) {
                const row = strikes.find((s) => Number(s.strike) === pos.strike);
                const leg = pos.optionType === 'PE' ? row?.pe : row?.ce;
                ltp = Number(leg?.ltp);
            } else if (pos.isShort && snapshot.atmCe && snapshot.atmPe) {
                // Straddle: the position is the combined premium.
                const a = Number(snapshot.atmCe.ltp);
                const b = Number(snapshot.atmPe.ltp);
                if (Number.isFinite(a) && Number.isFinite(b)) ltp = a + b;
            }

            const aged = now - pos.openedAt >= MAX_HOLD_MS;
            if (!Number.isFinite(ltp) || ltp <= 0) {
                // No quote. Only give up once it has aged out, so a single bad
                // read does not close a live position.
                if (aged) settled.push(this._settle(fp, pos, null, 'NO_DATA', now));
                continue;
            }

            let outcome = null;
            if (pos.isShort) {
                if (ltp <= pos.target) outcome = 'WIN';
                else if (ltp >= pos.stop) outcome = 'LOSS';
            } else if (ltp >= pos.target) outcome = 'WIN';
            else if (ltp <= pos.stop) outcome = 'LOSS';

            if (!outcome && aged) outcome = 'TIMEOUT';
            if (outcome) settled.push(this._settle(fp, pos, ltp, outcome, now));
        }

        const rows = await Promise.all(settled);
        return rows.filter(Boolean);
    }

    async _settle(fingerprint, pos, exit, outcome, now) {
        this._open.delete(fingerprint);
        const heldMin = Math.round((now - pos.openedAt) / 60000);
        // Signed against the direction actually traded.
        const pts = exit == null
            ? null
            : Math.round((pos.isShort ? pos.entry - exit : exit - pos.entry) * 100) / 100;

        logger.info(
            `📊 Scalp ${pos.index} ${pos.type} ${pos.strike ?? ''} `
            + `${outcome} @ ${exit ?? 'n/a'} (${pts ?? '?'} pts, ${heldMin}m)`
        );

        if (this._col && pos._id) {
            try {
                await this._col.updateOne(
                    { _id: pos._id },
                    {
                        $set: {
                            outcome,
                            scalp_exit: exit,
                            scalp_points: pts,
                            scalp_held_minutes: heldMin,
                            resolved_at: new Date(),
                        },
                    }
                );
            } catch (err) {
                logger.warn(`Scalp outcome update failed: ${err.message}`);
            }
        }
        return { fingerprint, index: pos.index, type: pos.type, outcome, exit, pts, heldMin };
    }

    /**
     * Measured record so far. This is the number that did not exist before —
     * and it stays honest: it reports the sample size next to the rate, and
     * returns null rather than 0% when nothing has resolved yet.
     */
    async stats({ days = 30, index = null } = {}) {
        if (!this._col) return null;
        const since = new Date(Date.now() - days * 24 * 3600 * 1000);
        const q = {
            strategy_source: 'scalp',
            posted_at: { $gte: since },
            outcome: { $in: ['WIN', 'LOSS', 'TIMEOUT', 'NO_DATA'] },
        };
        if (index) q.scalp_index = index;

        let rows;
        try {
            rows = await this._col.find(q).toArray();
        } catch (err) {
            logger.warn(`Scalp stats query failed: ${err.message}`);
            return null;
        }

        // TIMEOUT and NO_DATA are not wins and not losses; counting them either
        // way would misstate the rate, so they are reported separately.
        const graded = rows.filter((r) => r.outcome === 'WIN' || r.outcome === 'LOSS');
        const wins = graded.filter((r) => r.outcome === 'WIN').length;
        const pts = graded.reduce((s, r) => s + (Number(r.scalp_points) || 0), 0);

        return {
            days,
            index: index || 'ALL',
            total: rows.length,
            graded: graded.length,
            wins,
            losses: graded.length - wins,
            timeouts: rows.filter((r) => r.outcome === 'TIMEOUT').length,
            noData: rows.filter((r) => r.outcome === 'NO_DATA').length,
            winRate: graded.length ? Math.round((wins / graded.length) * 1000) / 10 : null,
            netPoints: Math.round(pts * 100) / 100,
            open: this._open.size,
        };
    }
}

export const scalpOutcomeTracker = new ScalpOutcomeTracker();
export default ScalpOutcomeTracker;
export { ScalpOutcomeTracker };
