/**
 * Pre-open stock selection, for alerts that must go out at 09:15.
 *
 * WHY THIS EXISTS
 * A breakout entry decays fast, so posting after the opening range closes means
 * filling above the level. Everything the other scanners use (opening range,
 * VWAP, intraday relative volume) needs the session to have started, so none of
 * them can produce a 09:15 post. NSE's pre-open auction (09:00-09:08) is the only
 * same-day information available before the bell.
 *
 * WHAT IT USES, AND WHY IT IS NOT THE SAME AS A "GAP"
 * `market-data-pre-open?key=FO` returns ~208 F&O names with:
 *   - IEP: the indicative equilibrium price, i.e. the actual auction clearing
 *     price the stock opens at. This matters -- a gap computed from a vendor's
 *     daily `open` field is not tradable (measured: it matches the first traded
 *     price 1.9% of the time, median 0.394% off), whereas the IEP is the price.
 *   - totalBuyQuantity / totalSellQuantity: order-book imbalance. This is the
 *     one selection input that does not exist in any historical price series.
 *
 * VALIDATION STATUS -- READ THIS BEFORE TRUSTING THE OUTPUT
 * NSE publishes no history for this endpoint, so this ranking is NOT backtested.
 * A 5-year screen of 10 morning-observable factors (149,718 samples) found that
 * prior-day factors and vendor-open gaps carry no out-of-sample edge, which is
 * precisely why this leans on auction data instead. But "untested with a reason
 * to believe" is not "measured". Treat the output as a watchlist with levels
 * until `TradeOutcomeResolver` has graded enough of it to say otherwise.
 *
 * Ranking is self-normalising -- every factor is a percentile computed across
 * today's own rows -- so it needs no historical baseline to function.
 */

import { nseGetSafe } from '../utils/nseClient.js';
import { logger } from '../utils/logger.js';
import { fetchYahooDailyCandlesSafe } from '../utils/yahooDailyCandles.js';
import { normalizeYahooSymbol } from './IndianStockQuoteService.js';

/** Below this the auction is too thin for the imbalance to mean anything. */
export const MIN_PREOPEN_TURNOVER_CR = 1;
/** Below this the move is indistinguishable from the market's own drift. */
export const MIN_REL_GAP_PCT = 0.3;
/** An auction this lopsided is usually a single order, not consensus. */
export const MAX_ABS_IMBALANCE = 0.98;

/**
 * Parse an NSE numeric, which may arrive comma-formatted or absent.
 * Missing MUST map to null, not 0 -- `??` only falls through on null/undefined,
 * so a 0 here would short-circuit every IEP alias fallback below.
 */
const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
};

/**
 * Order-book imbalance in [-1, 1]. Positive means more buy quantity resting.
 * @returns {number|null} null when the book is empty on both sides
 */
export function orderImbalance(buyQty, sellQty) {
    const b = num(buyQty) ?? 0;
    const s = num(sellQty) ?? 0;
    const total = b + s;
    if (total <= 0) return null;
    return (b - s) / total;
}

/**
 * Flatten one NSE pre-open row into the fields we rank on.
 * @returns {object|null} null when the row is unusable
 */
export function parsePreOpenRow(row) {
    const m = row?.metadata || {};
    const d = row?.detail?.preOpenMarket || {};
    const symbol = String(m.symbol || '').trim().toUpperCase();
    if (!symbol) return null;

    // IEP is the auction price; fall back through the aliases NSE has used.
    const iep = num(m.iep) ?? num(d.IEP) ?? num(d.finalPrice) ?? num(m.lastPrice);
    const prevClose = num(m.previousClose) ?? num(d.prevClose);
    if (!iep || !prevClose || iep <= 0 || prevClose <= 0) return null;

    const gapPct = ((iep - prevClose) / prevClose) * 100;
    const imbalance = orderImbalance(d.totalBuyQuantity, d.totalSellQuantity);
    const atoImbalance = orderImbalance(d.atoBuyQty, d.atoSellQty);

    // NSE reports turnover in rupees; carry it as crore to match the rest of the bot.
    const turnoverCr = (num(m.totalTurnover) ?? 0) / 1e7;

    return {
        symbol,
        iep,
        prevClose,
        gapPct,
        imbalance,
        atoImbalance,
        turnoverCr,
        preOpenQty: num(d.finalQuantity) ?? num(m.finalQuantity) ?? 0,
        yearHigh: num(m.yearHigh),
        yearLow: num(m.yearLow),
    };
}

const median = (arr) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/**
 * Percentile rank of each value within the array, in [0, 1].
 * Self-normalising: no historical baseline needed.
 */
export function percentileRanks(values) {
    const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
    return values.map((v) => {
        if (!Number.isFinite(v) || !sorted.length) return 0;
        let lo = 0, hi = sorted.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (sorted[mid] < v) lo = mid + 1; else hi = mid;
        }
        return sorted.length > 1 ? lo / (sorted.length - 1) : 0.5;
    });
}

/**
 * Rank pre-open rows into candidate picks.
 *
 * Direction comes from the gap relative to the market, and is only kept when the
 * order book agrees with it. A gap up on net selling pressure is the auction
 * disagreeing with itself -- we drop those rather than guess.
 *
 * @param {object[]} rows parsed rows
 * @param {{ maxPicks?: number, minRelGapPct?: number, minTurnoverCr?: number }} [opts]
 */
export function rankPreOpen(rows, opts = {}) {
    const {
        maxPicks = 8,
        minRelGapPct = MIN_REL_GAP_PCT,
        minTurnoverCr = MIN_PREOPEN_TURNOVER_CR,
    } = opts;

    const usable = rows.filter((r) => r && Number.isFinite(r.gapPct));
    if (!usable.length) return { picks: [], marketGapPct: 0, rejects: {} };

    // Median gap across the whole F&O board is a sturdier market proxy than any
    // single index print, and needs no extra request.
    const marketGapPct = median(usable.map((r) => r.gapPct));

    const rejects = { thinAuction: 0, noRelMove: 0, bookDisagrees: 0, lopsided: 0, noBook: 0 };
    const scored = [];

    const turnoverRank = percentileRanks(usable.map((r) => r.turnoverCr));

    usable.forEach((r, i) => {
        const relGapPct = r.gapPct - marketGapPct;

        if (r.turnoverCr < minTurnoverCr) { rejects.thinAuction++; return; }
        if (Math.abs(relGapPct) < minRelGapPct) { rejects.noRelMove++; return; }
        if (r.imbalance == null) { rejects.noBook++; return; }
        if (Math.abs(r.imbalance) > MAX_ABS_IMBALANCE) { rejects.lopsided++; return; }

        const side = relGapPct > 0 ? 'long' : 'short';
        const bookAgrees = side === 'long' ? r.imbalance > 0 : r.imbalance < 0;
        if (!bookAgrees) { rejects.bookDisagrees++; return; }

        // Score: how much is happening (turnover rank), how far it has moved
        // relative to the board, and how one-sided the book is behind it.
        const inPlay = turnoverRank[i];
        const moveStrength = Math.min(1, Math.abs(relGapPct) / 3);
        const bookStrength = Math.min(1, Math.abs(r.imbalance) / 0.5);
        const atoBonus =
            r.atoImbalance != null && (side === 'long' ? r.atoImbalance > 0 : r.atoImbalance < 0) ? 1 : 0;

        const score = Math.round(
            inPlay * 35 + moveStrength * 30 + bookStrength * 25 + atoBonus * 10
        );

        // Round at the source: fmtPct and the prompt block both render these
        // straight through, and a raw float prints as +7.361963190184049%.
        scored.push({
            ...r,
            gapPct: Number(r.gapPct.toFixed(2)),
            side,
            relGapPct: Number(relGapPct.toFixed(2)),
            marketGapPct: Number(marketGapPct.toFixed(2)),
            imbalance: Number(r.imbalance.toFixed(4)),
            turnoverCr: Number(r.turnoverCr.toFixed(2)),
            inPlayPct: Math.round(inPlay * 100),
            score,
        });
    });

    scored.sort((a, b) => b.score - a.score || Math.abs(b.relGapPct) - Math.abs(a.relGapPct));
    return {
        picks: scored.slice(0, maxPicks),
        marketGapPct: Number(marketGapPct.toFixed(2)),
        rejects,
        scanned: usable.length,
    };
}

/** Wilder-style ATR over the last `n` completed daily candles. */
export function dailyAtr(candles, n = 14) {
    if (!Array.isArray(candles) || candles.length < n + 1) return null;
    const c = candles.slice(-(n + 1));
    let sum = 0;
    for (let i = 1; i < c.length; i++) {
        sum += Math.max(
            c[i].high - c[i].low,
            Math.abs(c[i].high - c[i - 1].close),
            Math.abs(c[i].low - c[i - 1].close)
        );
    }
    const atr = sum / n;
    return atr > 0 ? atr : null;
}

/** Risk bounds mirror HeatmapV2 so stops stay comparable across sources. */
export const MIN_RISK_ATR = 0.6;
export const MAX_RISK_ATR = 2.0;
const RISK_ATR_MULT = 0.75;

/**
 * Attach equity levels to a pick.
 *
 * These are CONTEXT, not a validated entry. The 5-year screen found no edge in
 * entering at the open, so the level set exists to bound risk and to give the AI
 * an ATR-anchored stop instead of a round number -- not to assert an entry edge.
 *
 * @param {object} pick from rankPreOpen
 * @param {{ candles: object[] }|null} daily
 */
export function buildPreOpenSetup(pick, daily) {
    const candles = daily?.candles || daily;
    const atr = dailyAtr(candles);
    if (!atr || !pick?.iep) return null;

    const prev = candles[candles.length - 1];
    const dir = pick.side === 'long' ? 1 : -1;
    const risk = Math.min(Math.max(RISK_ATR_MULT * atr, MIN_RISK_ATR * atr), MAX_RISK_ATR * atr);
    const entry = pick.iep;

    return {
        direction: pick.side === 'long' ? 'LONG' : 'SHORT',
        entry: Number(entry.toFixed(2)),
        stop: Number((entry - dir * risk).toFixed(2)),
        target1: Number((entry + dir * risk).toFixed(2)),
        target2: Number((entry + dir * risk * 2).toFixed(2)),
        atr: Number(atr.toFixed(2)),
        riskAtr: Number((risk / atr).toFixed(2)),
        prevHigh: prev ? Number(prev.high.toFixed(2)) : null,
        prevLow: prev ? Number(prev.low.toFixed(2)) : null,
        score: pick.score,
    };
}

class PreOpenScanService {
    /**
     * @param {{ maxPicks?: number, key?: string }} [opts]
     * @returns {Promise<{ picks: object[], marketGapPct: number, rejects: object, scanned: number, asOf: string }|null>}
     */
    async scan(opts = {}) {
        const { key = 'FO' } = opts;
        const res = await nseGetSafe(`market-data-pre-open?key=${key}`);
        const rows = res?.data;
        if (!Array.isArray(rows) || !rows.length) {
            logger.warn('Pre-open scan: NSE returned no rows');
            return null;
        }

        const parsed = rows.map(parsePreOpenRow).filter(Boolean);
        if (!parsed.length) {
            logger.warn(`Pre-open scan: ${rows.length} rows but none parsable`);
            return null;
        }

        const ranked = rankPreOpen(parsed, opts);
        const asOf =
            rows.find((r) => r?.detail?.preOpenMarket?.lastUpdateTime)?.detail?.preOpenMarket
                ?.lastUpdateTime || '';

        // Levels for the shortlist only -- one daily fetch per pick, not per row.
        const withLevels = await Promise.all(
            ranked.picks.map(async (p) => {
                try {
                    const daily = await fetchYahooDailyCandlesSafe(normalizeYahooSymbol(p.symbol), {
                        range: '3mo',
                    });
                    return { ...p, setup: buildPreOpenSetup(p, daily) };
                } catch {
                    return { ...p, setup: null };
                }
            })
        );

        logger.info(
            `📋 Pre-open scan: ${withLevels.length}/${ranked.scanned} picks ` +
            `(board ${ranked.marketGapPct >= 0 ? '+' : ''}${ranked.marketGapPct.toFixed(2)}%)`
        );
        return { ...ranked, picks: withLevels, asOf, version: 'preopen' };
    }

    /** Prompt block for the AI. States plainly what this data is and is not. */
    formatBlock(scan) {
        if (!scan?.picks?.length) return '';
        const lines = [
            `📋 PRE-OPEN AUCTION (NSE, ${scan.asOf || 'today'}) — board median ` +
            `${scan.marketGapPct >= 0 ? '+' : ''}${scan.marketGapPct.toFixed(2)}%`,
            '',
        ];
        for (const p of scan.picks) {
            const s = p.setup;
            lines.push(
                `${p.symbol} — ${p.side.toUpperCase()} · IEP ₹${p.iep} ` +
                `(${p.relGapPct >= 0 ? '+' : ''}${p.relGapPct.toFixed(2)}% vs board) · ` +
                `book ${p.imbalance >= 0 ? '+' : ''}${(p.imbalance * 100).toFixed(0)}% ` +
                `· auction ₹${p.turnoverCr.toFixed(1)}cr (pctile ${p.inPlayPct}) · score ${p.score}`
            );
            if (s) {
                lines.push(
                    `   levels: E ₹${s.entry} · SL ₹${s.stop} · T1 ₹${s.target1} · T2 ₹${s.target2} ` +
                    `(ATR ${s.atr}, prev H/L ${s.prevHigh}/${s.prevLow})`
                );
            }
        }
        lines.push(
            '',
            'What this is: the NSE pre-open auction has closed (09:00–09:08) and these names ' +
            'cleared at a price meaningfully away from the board, with the resting order book ' +
            'agreeing with that direction. IEP is the actual opening price, not an estimate.',
            'What this is NOT: the session has not started, so there is no opening range, no ' +
            'VWAP and no intraday volume. Direction is from auction consensus only. The equity ' +
            'levels are ATR-bounded risk context — do not widen them, and do not present them ' +
            'as a confirmed breakout.'
        );
        return lines.join('\n');
    }
}

export const preOpenScanService = new PreOpenScanService();
export default PreOpenScanService;
