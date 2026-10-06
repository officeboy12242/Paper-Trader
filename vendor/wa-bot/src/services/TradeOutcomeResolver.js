/**
 * Resolve posted alerts to WIN / LOSS against what price actually did.
 *
 * Until this existed, `logPostedAlert` wrote `outcome: 'PENDING'` and nothing
 * ever changed it. So `reviewRecentOutcomes()` always saw zero resolved rows,
 * `winRate` was always null, and the adaptive confidence floor sat on its
 * defaults forever. Every claim about how the alerts perform was unfalsifiable.
 *
 * ── What can and cannot be resolved ──────────────────────────────────────────
 *
 * Rows whose entry/stop/target are EQUITY prices (swing picks, heatmap v2
 * breakouts) resolve exactly: walk the candles after the post and see which
 * level printed first. That is `basis: 'levels'`.
 *
 * Rows whose levels are OPTION PREMIUMS (the CE/PE cards, expiry legs) cannot
 * be resolved that way — historical option premiums are not retrievable from
 * any feed here. Where the underlying and its spot at post time were recorded,
 * those resolve on direction instead (`basis: 'direction'`): did the underlying
 * move the way the alert said. That is a weaker claim than "the option made
 * money" and is reported separately so the two are never averaged together.
 * Rows with neither are marked NO_DATA rather than silently counted as losses.
 *
 * Intrabar ambiguity: when a single candle's range covers both the stop and the
 * target, which came first is unknowable at this resolution. Those resolve as
 * LOSS — the pessimistic reading — so the win rate is a floor, not a flatter.
 */

import { logger } from '../utils/logger.js';
import { fetchYahooIntradayCandles } from '../utils/yahooIntradayCandles.js';
import { fetchYahooDailyCandlesSafe } from '../utils/yahooDailyCandles.js';
import { normalizeYahooSymbol } from './IndianStockQuoteService.js';

/** Swing picks are 2–6 week holds; stop looking after this. */
const SWING_HORIZON_DAYS = 30;
/** Intraday alerts are done at the close of the session they were posted in. */
const INTRADAY_HORIZON_HOURS = 8;

export const OUTCOMES = {
    WIN: 'WIN',
    LOSS: 'LOSS',
    EXPIRED: 'EXPIRED',
    NO_DATA: 'NO_DATA',
};

/** Long unless the side says otherwise. */
export function directionOf(side) {
    const s = String(side || '').toUpperCase();
    if (s.includes('SHORT') || s.includes('PE') || s.includes('BEAR') || s.includes('DOWN')) return -1;
    return 1;
}

/** Alerts whose levels are option premiums, not tradeable equity prices. */
export function isPremiumBased(side) {
    const s = String(side || '').toUpperCase();
    return s.startsWith('EXPIRY_') || s === 'BUY_CE' || s === 'BUY_PE' || s === 'CE' || s === 'PE';
}

/**
 * Walk candles in order and report which level printed first.
 *
 * @param {object[]} candles bars strictly after the post, oldest first
 * @param {{ dir: 1|-1, entry: number, stop: number, target: number }} plan
 * @returns {{ outcome: string, at: number|null, bars: number }}
 */
export function walkToOutcome(candles, { dir, entry, stop, target }) {
    let entered = entry == null;
    let bars = 0;

    for (const c of candles) {
        bars += 1;

        // A stop-order entry only fills once price trades through it.
        if (!entered) {
            const filled = dir > 0 ? c.high >= entry : c.low <= entry;
            if (!filled) continue;
            entered = true;
        }

        const hitStop = dir > 0 ? c.low <= stop : c.high >= stop;
        const hitTarget = dir > 0 ? c.high >= target : c.low <= target;

        // Both inside one bar: sequence is unknowable here, so assume the worst.
        if (hitStop) return { outcome: OUTCOMES.LOSS, at: c.ts, bars };
        if (hitTarget) return { outcome: OUTCOMES.WIN, at: c.ts, bars };
    }

    return { outcome: entered ? OUTCOMES.EXPIRED : OUTCOMES.NO_DATA, at: null, bars };
}

class TradeOutcomeResolver {
    /**
     * @param {object|null} mongoDb
     * @param {object} config
     */
    constructor(mongoDb = null, config = {}) {
        this._col = mongoDb ? mongoDb.collection('trade_alert_outcomes') : null;
        this.config = config;
    }

    /** Bars after `since`, at whichever resolution suits the horizon. */
    async _candlesAfter(symbol, since, { intraday }) {
        const yahoo = normalizeYahooSymbol(symbol);
        if (intraday) {
            // 15m over 1 month is the longest intraday window Yahoo serves.
            const c = await fetchYahooIntradayCandles(yahoo, { interval: '15m', range: '1mo' });
            return c.filter((k) => k.ts > since);
        }
        const res = await fetchYahooDailyCandlesSafe(yahoo, { range: '3mo' });
        return (res?.candles || []).filter((k) => k.ts > since);
    }

    /** Resolve one row. Returns the `$set` patch, or null to leave it pending. */
    async resolveRow(row, now = Date.now()) {
        const postedAt = row.posted_at ? new Date(row.posted_at).getTime() : null;
        if (!postedAt) return { outcome: OUTCOMES.NO_DATA, resolution_note: 'no posted_at' };

        const side = row.side || '';
        const dir = directionOf(side);
        const isSwing = String(side).toUpperCase().includes('SWING');
        const horizonMs = isSwing
            ? SWING_HORIZON_DAYS * 24 * 3600 * 1000
            : INTRADAY_HORIZON_HOURS * 3600 * 1000;

        // Still live — say nothing rather than guess.
        if (now - postedAt < horizonMs && !row.force_resolve) {
            const probe = await this._probe(row, postedAt, { isSwing, dir });
            // An early WIN/LOSS is final; only EXPIRED has to wait for the horizon.
            if (probe && (probe.outcome === OUTCOMES.WIN || probe.outcome === OUTCOMES.LOSS)) {
                return probe;
            }
            return null;
        }

        return (await this._probe(row, postedAt, { isSwing, dir })) || {
            outcome: OUTCOMES.NO_DATA,
            resolution_note: 'no price data',
        };
    }

    async _probe(row, postedAt, { isSwing, dir }) {
        const premium = isPremiumBased(row.side);
        // Premium rows can ONLY be judged through their underlying. Equity rows
        // prefer their own levels but fall back to the underlying_* copies, so a
        // caller that filled in only one of the two pairs still resolves.
        const pick = (own, under) => (premium ? under : own ?? under);
        const symbol = premium ? row.underlying_symbol : row.symbol || row.underlying_symbol;
        const entry = pick(row.entry, row.underlying_entry);
        const stop = pick(row.stop_loss, row.underlying_stop);
        const target = pick(row.target1, row.underlying_target);

        if (!symbol) {
            return {
                outcome: OUTCOMES.NO_DATA,
                resolution_basis: 'none',
                resolution_note: premium
                    ? 'option premium levels, no underlying recorded'
                    : 'no symbol',
            };
        }

        let candles;
        try {
            candles = await this._candlesAfter(symbol, postedAt, { intraday: !isSwing });
        } catch (err) {
            logger.debug(`Outcome resolve ${symbol}: ${err.message}`);
            return null;
        }
        if (!candles.length) return null;

        // Full levels present → exact resolution.
        if ([entry, stop, target].every((v) => Number.isFinite(v))) {
            const res = walkToOutcome(candles, { dir, entry, stop, target });
            return {
                outcome: res.outcome,
                resolved_at: new Date(),
                resolution_basis: premium ? 'direction' : 'levels',
                resolution_bars: res.bars,
                hit_at: res.at ? new Date(res.at) : null,
            };
        }

        // Levels missing → the weakest honest read: did it close favourably.
        if (Number.isFinite(entry)) {
            const last = candles[candles.length - 1].close;
            const moved = (last - entry) * dir;
            return {
                outcome: moved > 0 ? OUTCOMES.WIN : OUTCOMES.LOSS,
                resolved_at: new Date(),
                resolution_basis: 'direction',
                resolution_note: 'no stop/target recorded — direction only',
                resolution_bars: candles.length,
            };
        }

        return {
            outcome: OUTCOMES.NO_DATA,
            resolution_basis: 'none',
            resolution_note: 'no entry level recorded',
        };
    }

    /**
     * Resolve every pending row that is old enough to judge.
     * @returns {Promise<{ checked: number, resolved: number, byOutcome: object }>}
     */
    async resolvePending({ limit = 400, concurrency = 4 } = {}) {
        if (!this._col) return { checked: 0, resolved: 0, byOutcome: {} };

        let rows;
        try {
            rows = await this._col
                .find({ outcome: 'PENDING' })
                .sort({ posted_at: 1 })
                .limit(limit)
                .toArray();
        } catch (err) {
            logger.warn(`Outcome resolve query failed: ${err.message}`);
            return { checked: 0, resolved: 0, byOutcome: {} };
        }
        if (!rows.length) return { checked: 0, resolved: 0, byOutcome: {} };

        const now = Date.now();
        const byOutcome = {};
        let resolved = 0;
        let next = 0;

        const worker = async () => {
            while (next < rows.length) {
                const row = rows[next++];
                let patch = null;
                try {
                    patch = await this.resolveRow(row, now);
                } catch (err) {
                    logger.debug(`Outcome resolve ${row.symbol}: ${err.message}`);
                }
                if (!patch) continue;
                try {
                    await this._col.updateOne({ _id: row._id }, { $set: patch });
                    resolved += 1;
                    byOutcome[patch.outcome] = (byOutcome[patch.outcome] || 0) + 1;
                } catch (err) {
                    logger.debug(`Outcome write ${row.symbol}: ${err.message}`);
                }
            }
        };

        await Promise.all(
            Array.from({ length: Math.min(concurrency, rows.length) }, worker)
        );

        if (resolved) {
            logger.info(
                `📊 Outcomes resolved: ${resolved}/${rows.length} — ` +
                    Object.entries(byOutcome).map(([k, v]) => `${k} ${v}`).join(', ')
            );
        }
        return { checked: rows.length, resolved, byOutcome };
    }

    /**
     * Win rate broken out by strategy source. Only rows resolved on real levels
     * count toward `winRate`; direction-only rows are reported beside it so the
     * two measures are never silently averaged.
     */
    async stats({ lookbackDays = 30 } = {}) {
        if (!this._col) return null;
        const since = new Date(Date.now() - lookbackDays * 24 * 3600 * 1000);

        let rows;
        try {
            rows = await this._col.find({ posted_at: { $gte: since } }).toArray();
        } catch (err) {
            logger.warn(`Outcome stats failed: ${err.message}`);
            return null;
        }

        const bucket = () => ({
            posted: 0, win: 0, loss: 0, expired: 0, pending: 0, noData: 0, directional: 0,
        });
        const bySource = new Map();
        const overall = bucket();

        for (const r of rows) {
            const src = r.strategy_source || r.side || 'unknown';
            if (!bySource.has(src)) bySource.set(src, bucket());
            for (const b of [overall, bySource.get(src)]) {
                b.posted += 1;
                if (r.outcome === 'PENDING') b.pending += 1;
                else if (r.outcome === OUTCOMES.WIN) b.win += 1;
                else if (r.outcome === OUTCOMES.LOSS) b.loss += 1;
                else if (r.outcome === OUTCOMES.EXPIRED) b.expired += 1;
                else b.noData += 1;
                if (r.resolution_basis === 'direction') b.directional += 1;
            }
        }

        const rate = (b) => {
            const decided = b.win + b.loss;
            return decided ? b.win / decided : null;
        };

        return {
            lookbackDays,
            overall: { ...overall, winRate: rate(overall) },
            bySource: [...bySource.entries()]
                .map(([source, b]) => ({ source, ...b, winRate: rate(b) }))
                .sort((a, b) => b.posted - a.posted),
        };
    }
}

export function createTradeOutcomeResolver(mongoDb, config) {
    return new TradeOutcomeResolver(mongoDb, config);
}

export default TradeOutcomeResolver;
