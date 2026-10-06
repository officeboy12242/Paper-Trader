/**
 * Live premium tracking for posted SVMKR trades.
 *
 * WHY THIS EXISTS: TradeOutcomeResolver documents that historical option
 * premiums are not retrievable from any feed in this project, so CE/PE alerts
 * could only ever be graded on whether the underlying moved the right way. That
 * is not the same claim as "the trade made money" — a call can be directionally
 * right and still lose to theta.
 *
 * The only way to get a real premium result is to record the premium WHILE the
 * trade is open. So this polls the traded strike, replies to the original card
 * with hold/trail/exit, and closes the row with a realized ₹ P&L. That makes the
 * win rate honest, and it means the number can only start accumulating from the
 * day this goes live — there is nothing to backfill.
 *
 * Its stats are kept in their own collection so they never mix with the existing
 * `/tradelert stats` series.
 */

import { logger } from '../utils/logger.js';
import { nseOptionChainService, findStrikeLeg } from './NseOptionChainService.js';
import { formatSvmkrUpdate, formatSvmkrClose } from '../utils/svmkrCard.js';
import { istMinutesOfDay } from '../utils/intradaySeries.js';
import { safeSendMessage } from '../utils/waMessage.js';

/** Flat premium move that counts as "going nowhere". */
const STALE_BAND_PCT = 8;
/** How long a position may sit inside that band before it is called stale. */
const STALE_AFTER_MIN = 45;
/** Everything is closed out by this IST minute — no overnight option carries. */
const FORCED_EXIT_MIN = 15 * 60 + 15;

export const STAGES = {
    HOLD: 'HOLD',
    T1: 'T1',
    T2: 'T2',
    SL: 'SL',
    FLIP: 'FLIP',
    STALE: 'STALE',
    TIME: 'TIME',
};

/** Stages that end the trade. */
const CLOSING = new Set([STAGES.T2, STAGES.SL, STAGES.FLIP, STAGES.TIME]);

class SvmkrPositionTracker {
    /**
     * @param {import('mongodb').Db|null} mongoDb
     * @param {object} config
     */
    constructor(mongoDb = null, config = {}) {
        this.config = config;
        this._col = mongoDb ? mongoDb.collection('svmkr_positions') : null;
    }

    async init() {
        if (!this._col) return;
        await this._col.createIndex({ status: 1, opened_at: -1 }, { name: 'svmkr_status_opened' });
        await this._col.createIndex(
            { index: 1, side: 1, strike: 1, signal_bar_ts: 1 },
            { unique: true, name: 'svmkr_signal_unique' }
        );
    }

    /**
     * Record a posted trade so it can be followed.
     * The unique index on (index, side, strike, signal_bar_ts) is what stops the
     * same 5m bar being opened twice if a poll overlaps or the bot restarts.
     * @returns {Promise<object|null>} the stored position, or null if duplicate
     */
    async open({ scan, groupId, sentMessage = null }) {
        if (!this._col) return null;
        const { setup: s, tech, key } = scan;
        const plan = s.plan && s.plan.lots > 0 ? s.plan : null;

        // Baileys needs a quotable stub ({key, message}) to render a reply, not a
        // bare key — store exactly that so follow-ups thread under the card.
        const quoteMsg = sentMessage?.key
            ? { key: sentMessage.key, message: sentMessage.message || { conversation: 'SVMKR signal' } }
            : null;

        const doc = {
            index: key,
            side: s.side,
            strike: s.strike,
            expiry: s.expiry,
            signal_bar_ts: tech.barTs,
            prem_entry: plan ? plan.premEntry : s.premium,
            // sizeIndexTrade calls it premStop, not premSl — getting this wrong
            // silently leaves prem_sl null, and a position that can never stop out.
            prem_sl: plan ? plan.premStop : null,
            prem_t1: plan ? plan.premT1 : null,
            prem_t2: plan ? plan.premT2 : null,
            lots: plan ? plan.lots : 0,
            qty: plan ? plan.qty : 0,
            underlying_entry: tech.close,
            underlying_stop: tech.trailingStop,
            group_id: groupId,
            message_key: sentMessage?.key || null,
            quote_msg: quoteMsg,
            status: 'OPEN',
            stage: STAGES.HOLD,
            stages_sent: [],
            prem_high: plan ? plan.premEntry : s.premium,
            prem_low: plan ? plan.premEntry : s.premium,
            timeline: [{ at: new Date(), premium: plan ? plan.premEntry : s.premium }],
            opened_at: new Date(),
        };

        try {
            await this._col.insertOne(doc);
            return doc;
        } catch (err) {
            if (err?.code === 11000) {
                logger.debug(`SVMKR: position already open for ${key} ${s.strike}${s.side} @ ${tech.barTs}`);
                return null;
            }
            throw err;
        }
    }

    async openPositions() {
        if (!this._col) return [];
        return this._col.find({ status: 'OPEN' }).toArray();
    }

    /**
     * Decide what to say about a position at the current premium.
     * Pure so it can be tested without a database or a socket.
     *
     * @param {object} pos
     * @param {{ premium: number, nowMs: number, utPos?: number|null }} live
     *   utPos is the CURRENT UT Bot position (1 long / -1 short); a flip against
     *   the trade invalidates it regardless of where the premium is.
     */
    static evaluate(pos, { premium, nowMs, utPos = null }) {
        const entry = Number(pos.prem_entry);
        const qty = Number(pos.qty) || 0;
        const pnlRs = qty > 0 ? (premium - entry) * qty : 0;
        const pnlPct = entry > 0 ? ((premium - entry) / entry) * 100 : 0;
        const base = { premium, pnlRs, pnlPct };

        const heldMin = Math.round((nowMs - new Date(pos.opened_at).getTime()) / 60_000);
        const wanted = pos.side === 'CE' ? 1 : -1;

        if (Number.isFinite(pos.prem_sl) && premium <= pos.prem_sl) {
            return { ...base, stage: STAGES.SL, note: `Premium broke the ₹${pos.prem_sl} stop.` };
        }
        if (Number.isFinite(pos.prem_t2) && premium >= pos.prem_t2) {
            return { ...base, stage: STAGES.T2, note: 'Runner target reached — take it off.' };
        }
        if (istMinutesOfDay(nowMs) >= FORCED_EXIT_MIN) {
            return { ...base, stage: STAGES.TIME, note: 'Session is ending — no overnight carry on a bought option.' };
        }
        // A flip only closes a trade that is not already in profit at T1; taking a
        // flip exit on a winner would throw away the runner for a noise cross.
        if (utPos != null && utPos !== 0 && utPos !== wanted) {
            const atT1 = Number.isFinite(pos.prem_t1) && premium >= pos.prem_t1;
            if (!atT1) {
                return { ...base, stage: STAGES.FLIP, note: 'UT Bot flipped the other way — the reason for the trade is gone.' };
            }
        }
        if (Number.isFinite(pos.prem_t1) && premium >= pos.prem_t1) {
            return { ...base, stage: STAGES.T1, note: 'Book part here and move the stop to entry; the rest rides to T2.' };
        }
        if (heldMin >= STALE_AFTER_MIN && Math.abs(pnlPct) < STALE_BAND_PCT) {
            return {
                ...base,
                stage: STAGES.STALE,
                note: `${heldMin} min in and still flat — decay is the only thing moving. Consider cutting it.`,
            };
        }
        return { ...base, stage: STAGES.HOLD, note: null };
    }

    /**
     * Poll every open position and post the updates that are new.
     *
     * @param {object} sock
     * @param {{ utPosByIndex?: Record<string, number> }} [ctx] current UT Bot
     *   position per index, so a flip can close a trade
     */
    async poll(sock, { utPosByIndex = {} } = {}) {
        if (!this._col) return { checked: 0, updated: 0, closed: 0 };
        const positions = await this.openPositions();
        if (!positions.length) return { checked: 0, updated: 0, closed: 0 };

        // One chain fetch per index, shared by every position on it.
        const chains = new Map();
        const nowMs = Date.now();
        let updated = 0;
        let closed = 0;

        for (const pos of positions) {
            try {
                if (!chains.has(pos.index)) {
                    const res = await nseOptionChainService.fetchOptionContext(pos.index).catch(() => null);
                    chains.set(pos.index, res?.snapshot || null);
                }
                const snapshot = chains.get(pos.index);
                const leg = snapshot ? findStrikeLeg(snapshot, pos.strike, pos.side) : null;
                const premium = Number(leg?.ltp);
                if (!Number.isFinite(premium) || premium <= 0) {
                    logger.debug(`SVMKR poll: no premium for ${pos.index} ${pos.strike}${pos.side}`);
                    continue;
                }

                const verdict = SvmkrPositionTracker.evaluate(pos, {
                    premium,
                    nowMs,
                    utPos: utPosByIndex[pos.index] ?? null,
                });
                const isClosing = CLOSING.has(verdict.stage);

                // Say each non-closing thing once. Without this the group gets the
                // same "HOLD" line every five minutes for an hour.
                const alreadySaid = (pos.stages_sent || []).includes(verdict.stage);
                const shouldPost = isClosing || (verdict.stage !== STAGES.HOLD && !alreadySaid);

                const patch = {
                    stage: verdict.stage,
                    prem_last: premium,
                    prem_high: Math.max(Number(pos.prem_high) || premium, premium),
                    prem_low: Math.min(Number(pos.prem_low) || premium, premium),
                    updated_at: new Date(nowMs),
                };
                const push = { timeline: { at: new Date(nowMs), premium, stage: verdict.stage } };

                if (isClosing) {
                    patch.status = 'CLOSED';
                    patch.outcome = verdict.pnlRs > 0 ? 'WIN' : 'LOSS';
                    patch.exit_premium = premium;
                    patch.pnl_rs = Math.round(verdict.pnlRs);
                    patch.pnl_pct = Number(verdict.pnlPct.toFixed(2));
                    patch.closed_at = new Date(nowMs);
                    patch.close_reason = verdict.stage;
                }

                const update = { $set: patch, $push: push };
                if (shouldPost && !isClosing) {
                    update.$addToSet = { stages_sent: verdict.stage };
                }
                await this._col.updateOne({ _id: pos._id }, update);

                if (shouldPost && sock && pos.group_id) {
                    const text = isClosing
                        ? formatSvmkrClose(pos, verdict, { nowMs })
                        : formatSvmkrUpdate(pos, verdict, { nowMs });
                    // Quoted against the original card so the update reads as a
                    // reply to that trade rather than a loose message.
                    await safeSendMessage(sock, pos.group_id, { text }, pos.quote_msg || null).catch((err) =>
                        logger.warn(`SVMKR update send failed: ${err.message}`)
                    );
                }

                if (isClosing) closed += 1;
                else if (shouldPost) updated += 1;
            } catch (err) {
                logger.warn(`SVMKR poll failed for ${pos.index} ${pos.strike}${pos.side}: ${err.message}`);
            }
        }

        if (updated || closed) {
            logger.info(`⚡ SVMKR tracker: ${positions.length} open, ${updated} update(s), ${closed} closed`);
        }
        return { checked: positions.length, updated, closed };
    }

    /** True premium-based results. Null when nothing has closed yet. */
    async stats({ lookbackDays = 30 } = {}) {
        if (!this._col) return null;
        const since = new Date(Date.now() - lookbackDays * 24 * 3600 * 1000);
        const rows = await this._col.find({ opened_at: { $gte: since } }).toArray();

        const closedRows = rows.filter((r) => r.status === 'CLOSED' && Number.isFinite(r.pnl_rs));
        const open = rows.filter((r) => r.status === 'OPEN').length;
        if (!closedRows.length) return { closed: 0, open, lookbackDays };

        const wins = closedRows.filter((r) => r.pnl_rs > 0);
        const losses = closedRows.filter((r) => r.pnl_rs <= 0);
        const sum = (list) => list.reduce((a, r) => a + r.pnl_rs, 0);

        const sides = ['CE', 'PE'].map((side) => {
            const list = closedRows.filter((r) => r.side === side);
            if (!list.length) return null;
            return {
                side,
                closed: list.length,
                winRate: list.filter((r) => r.pnl_rs > 0).length / list.length,
                netRs: sum(list),
            };
        }).filter(Boolean);

        return {
            lookbackDays,
            open,
            closed: closedRows.length,
            wins: wins.length,
            losses: losses.length,
            winRate: wins.length / closedRows.length,
            netRs: sum(closedRows),
            avgWinRs: wins.length ? sum(wins) / wins.length : null,
            avgLossRs: losses.length ? sum(losses) / losses.length : null,
            bySide: sides,
        };
    }
}

export default SvmkrPositionTracker;
