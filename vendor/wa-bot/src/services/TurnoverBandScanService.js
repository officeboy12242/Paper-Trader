/**
 * Turnover-band selection for a NEXT-DAY INTRADAY post.
 *
 * WHY A BAND AND NOT THE TOP
 * Ranking the F&O universe by prior-day turnover finds the names money actually
 * moved through. But the very top of that list is the wrong place to fish for an
 * intraday trade: measured over 21 sessions on 5m bars with real traded prices,
 * ranks 1-10 came out NEGATIVE intraday while everything below was positive.
 *
 *   band        intraday (EMA-filtered)      intraday (no filter)
 *   ranks 1-10  47.8% / -0.035R  (n=46)      42.0% / -0.139R  (n=50)
 *   ranks 11-20 47.4% / +0.038R  (n=38)      52.0% / +0.065R  (n=50)
 *   ranks 21-30 51.2% / +0.141R  (n=43)      50.0% / +0.162R  (n=50)
 *   ranks 31-50 54.8% / +0.089R  (n=84)      53.0% / +0.090R  (n=100)
 *
 * The reason both this and the opposite result are true: close-to-close over 5
 * years favours ranks 1-10 (+0.035R out-of-sample) and penalises 11-20 (-0.027R).
 * The difference between the two tests is the overnight gap. The top of the list
 * spends its move overnight, so by 09:20 it is already in the price. A next-day
 * intraday alert never captures that gap, which is why it wants the band below.
 *
 * EVIDENCE STRENGTH -- READ BEFORE TRUSTING THE OUTPUT
 * n is 38-100 per band. At n=50 the 95% interval around a 50% win rate is about
 * +/-14 points, so no single band here is individually distinguishable from noise.
 * What makes it more than one lucky cell is that the ordering is consistent across
 * four bands and two independent specifications, and there is a mechanism that
 * explains it. That is a reason to collect data, not a reason to claim an edge.
 * Yahoo caps 5m history at one month, so 21 sessions is the ceiling until this
 * runs forward and TradeOutcomeResolver grades it.
 *
 * NOTE ON THE DATA SOURCE
 * This does NOT read nseindia's most-active-equities page. That page returns only
 * 20 rows -- the best-performing bands are not on it -- and it is a cash list, so
 * it surfaces names with no options (a live sample gave GLAND, CHENNPETRO, NAUKRI
 * and AARTIPHARM in its top 10).
 *
 * F&O ELIGIBILITY IS ENFORCED, NOT ASSUMED
 * Our scan universe is 247 names but only ~180 of them actually have options --
 * 67 do not. An early run of this service ranked FINCABLES first, which has no
 * option chain at all, so the pick was untradeable as a CE/PE card. The eligible
 * set is therefore resolved from NSE's live F&O list each day, falling back to the
 * static FNO_UNIVERSE (small but certain) if that request fails. Never fall back
 * to the unfiltered universe: silently proposing a name with no options is worse
 * than proposing fewer names.
 */

import { fetchYahooDailyCandlesSafe } from '../utils/yahooDailyCandles.js';
import { normalizeYahooSymbol } from './IndianStockQuoteService.js';
import { HEATMAP_UNIVERSE } from '../data/nseHeatmapSectors.js';
import { NSE_SWING_UNIVERSE } from '../data/nseSwingUniverse.js';
import { FNO_UNIVERSE } from './MarketScanService.js';
import { nseGetSafe } from '../utils/nseClient.js';
import { getTodayDateStrIST } from '../utils/dateIST.js';
import { logger } from '../utils/logger.js';

export const UNIVERSE = [...new Set([...HEATMAP_UNIVERSE, ...NSE_SWING_UNIVERSE])];

let _fnoCache = { day: null, set: null };

/**
 * Symbols that actually have options today.
 * @returns {Promise<{ set: Set<string>, source: 'nse'|'static' }>}
 */
export async function fetchFnoSymbols() {
    const day = getTodayDateStrIST();
    if (_fnoCache.day === day && _fnoCache.set?.size) {
        return { set: _fnoCache.set, source: 'nse' };
    }
    try {
        const res = await nseGetSafe('market-data-pre-open?key=FO');
        const rows = res?.data;
        if (Array.isArray(rows) && rows.length > 50) {
            const set = new Set(
                rows.map((r) => String(r?.metadata?.symbol || '').trim().toUpperCase()).filter(Boolean)
            );
            _fnoCache = { day, set };
            return { set, source: 'nse' };
        }
    } catch {
        /* fall through */
    }
    logger.warn('Turnover band: live F&O list unavailable — falling back to static FNO_UNIVERSE');
    return { set: new Set(FNO_UNIVERSE.map((s) => s.toUpperCase())), source: 'static' };
}

/** Risk bounds mirror HeatmapV2 so stops stay comparable across sources. */
export const MIN_RISK_ATR = 0.6;
export const MAX_RISK_ATR = 2.0;
const RISK_ATR_MULT = 0.75;

export const DEFAULTS = {
    bandFrom: 11,       // rank 1-10 measured negative intraday
    bandTo: 30,
    emaFast: 8,
    emaSlow: 21,
    maxPicks: 8,
    minTurnoverCr: 20,
    concurrency: 6,
};

export function ema(values, period) {
    if (!Array.isArray(values) || !values.length) return null;
    const k = 2 / (period + 1);
    let e = values[0];
    for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
    return e;
}

/** Wilder-style ATR over the last `n` completed candles. */
export function atr(candles, n = 14) {
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
    const a = sum / n;
    return a > 0 ? a : null;
}

/**
 * Trend direction from EMA stacking. Requires close, fast and slow to agree --
 * price above the fast EMA while the fast sits BELOW the slow is an ambiguous
 * trend, and is reported as 0 rather than guessed either way.
 *
 * @returns {{ dir: -1|0|1, fast: number, slow: number, close: number }|null}
 */
export function emaDirection(closes, fast = 8, slow = 21) {
    if (!Array.isArray(closes) || closes.length < slow + 5) return null;
    const ef = ema(closes.slice(-(fast * 4)), fast);
    const es = ema(closes.slice(-(slow * 4)), slow);
    if (ef == null || es == null) return null;
    const close = closes[closes.length - 1];
    let dir = 0;
    if (close > ef && ef > es) dir = 1;
    else if (close < ef && ef < es) dir = -1;
    return { dir, fast: ef, slow: es, close };
}

/**
 * How committed the trend is, in ATR units so a Rs 700 stock and a Rs 3000 one
 * are comparable: distance of price beyond the fast EMA plus the EMA separation.
 */
export function trendStrength({ close, fast, slow, atr: a }) {
    if (!a || a <= 0) return 0;
    return (Math.abs(close - fast) + Math.abs(fast - slow)) / a;
}

/** Levels for a pick. ATR-bounded so the stop is an invalidation, not a round number. */
export function buildSetup({ close, dir, atr: a, score }) {
    if (!a || a <= 0 || !close || !dir) return null;
    const risk = Math.min(Math.max(RISK_ATR_MULT * a, MIN_RISK_ATR * a), MAX_RISK_ATR * a);
    return {
        direction: dir === 1 ? 'LONG' : 'SHORT',
        entry: Number(close.toFixed(2)),
        stop: Number((close - dir * risk).toFixed(2)),
        target1: Number((close + dir * risk).toFixed(2)),
        target2: Number((close + dir * risk * 2).toFixed(2)),
        atr: Number(a.toFixed(2)),
        riskAtr: Number((risk / a).toFixed(2)),
        score,
    };
}

/**
 * Rank pre-computed rows into picks.
 * @param {{symbol:string,turnoverCr:number,closes:number[],candles:object[]}[]} rows
 */
export function rankTurnoverBand(rows, opts = {}) {
    const {
        bandFrom = DEFAULTS.bandFrom,
        bandTo = DEFAULTS.bandTo,
        emaFast = DEFAULTS.emaFast,
        emaSlow = DEFAULTS.emaSlow,
        maxPicks = DEFAULTS.maxPicks,
        minTurnoverCr = DEFAULTS.minTurnoverCr,
    } = opts;

    const rejects = { illiquid: 0, outsideBand: 0, emaFlat: 0, noAtr: 0, noData: 0 };

    const liquid = [];
    for (const r of rows) {
        if (!r || !Array.isArray(r.closes) || r.closes.length < emaSlow + 5) { rejects.noData++; continue; }
        if (!(r.turnoverCr >= minTurnoverCr)) { rejects.illiquid++; continue; }
        liquid.push(r);
    }
    liquid.sort((a, b) => b.turnoverCr - a.turnoverCr);

    // 1-indexed inclusive band, matching how the measurement was reported.
    const band = liquid.slice(bandFrom - 1, bandTo);
    rejects.outsideBand = Math.max(0, liquid.length - band.length);

    const picks = [];
    band.forEach((r, i) => {
        const a = atr(r.candles);
        if (!a) { rejects.noAtr++; return; }
        const e = emaDirection(r.closes, emaFast, emaSlow);
        if (!e) { rejects.noData++; return; }
        if (e.dir === 0) { rejects.emaFlat++; return; }

        const strength = trendStrength({ close: e.close, fast: e.fast, slow: e.slow, atr: a });
        const score = Math.round(Math.min(100, strength * 20));
        picks.push({
            symbol: r.symbol,
            rank: bandFrom + i,
            turnoverCr: Number(r.turnoverCr.toFixed(2)),
            side: e.dir === 1 ? 'long' : 'short',
            close: Number(e.close.toFixed(2)),
            ema8: Number(e.fast.toFixed(2)),
            ema21: Number(e.slow.toFixed(2)),
            strength: Number(strength.toFixed(2)),
            score,
            changePct: r.changePct ?? 0,
            setup: buildSetup({ close: e.close, dir: e.dir, atr: a, score }),
        });
    });

    picks.sort((a, b) => b.strength - a.strength);
    return {
        picks: picks.slice(0, maxPicks),
        rejects,
        scanned: liquid.length,
        bandFrom,
        bandTo,
        bandSize: band.length,
    };
}

class TurnoverBandScanService {
    async scan(opts = {}) {
        const { concurrency = DEFAULTS.concurrency } = opts;
        const { set: fnoSet, source: fnoSource } = await fetchFnoSymbols();

        // Every card is a CE/PE trade, so a name without options is not a pick.
        const eligible = UNIVERSE.filter((s) => fnoSet.has(s.toUpperCase()));
        logger.info(
            `📊 Turnover band: ${eligible.length}/${UNIVERSE.length} names are F&O-eligible (${fnoSource} list)`
        );
        if (!eligible.length) {
            logger.warn('Turnover band: no F&O-eligible symbols — aborting');
            return null;
        }

        const rows = [];
        let i = 0;

        await Promise.all(
            Array.from({ length: concurrency }, async () => {
                while (i < eligible.length) {
                    const symbol = eligible[i++];
                    try {
                        const res = await fetchYahooDailyCandlesSafe(normalizeYahooSymbol(symbol), {
                            range: '6mo',
                        });
                        const candles = res?.candles;
                        if (!candles || candles.length < 40) continue;
                        // Rank on the LAST COMPLETED session -- that is what is known
                        // before the next day's open, which is when this posts.
                        const prev = candles[candles.length - 1];
                        const before = candles[candles.length - 2];
                        rows.push({
                            symbol,
                            candles,
                            closes: candles.map((c) => c.close),
                            turnoverCr: (prev.close * prev.volume) / 1e7,
                            changePct: before
                                ? Number((((prev.close - before.close) / before.close) * 100).toFixed(2))
                                : 0,
                        });
                    } catch {
                        /* symbol skipped */
                    }
                }
            })
        );

        if (!rows.length) {
            logger.warn('Turnover-band scan: no usable symbols');
            return null;
        }

        const ranked = rankTurnoverBand(rows, opts);
        logger.info(
            `📊 Turnover-band scan: ${ranked.picks.length} picks from ranks ` +
            `${ranked.bandFrom}-${ranked.bandTo} of ${ranked.scanned} liquid F&O names`
        );
        return { ...ranked, version: 'turnover', fnoSource, fnoEligible: eligible.length };
    }

    /** Prompt block for the AI. States what the selection is and is not. */
    formatBlock(scan) {
        if (!scan?.picks?.length) return '';
        const lines = [
            `📊 TURNOVER BAND (ranks ${scan.bandFrom}-${scan.bandTo} by previous-session turnover)`,
            '',
        ];
        for (const p of scan.picks) {
            lines.push(
                `${p.symbol} — ${p.side.toUpperCase()} · rank #${p.rank} · ₹${p.turnoverCr}cr turnover · ` +
                `close ₹${p.close} (EMA8 ${p.ema8} / EMA21 ${p.ema21}) · trend ${p.strength} ATR · score ${p.score}`
            );
            const s = p.setup;
            if (s) {
                lines.push(`   levels: E ₹${s.entry} · SL ₹${s.stop} · T1 ₹${s.target1} · T2 ₹${s.target2} (ATR ${s.atr})`);
            }
        }
        lines.push(
            '',
            'What this is: names money actually moved through last session, taken from ' +
            'BELOW the top of the turnover list on purpose — the top ranks spend their ' +
            'move overnight and are already priced in by 09:20. Direction is from daily ' +
            'EMA 8/21 stacking; names where price and the two EMAs disagree were dropped ' +
            'rather than guessed.',
            'What this is NOT: a confirmed intraday trigger. There is no opening range, ' +
            'VWAP or intraday volume behind these — the trend is a daily-timeframe read, ' +
            'and the equity levels are ATR-bounded risk context. Do not widen them.'
        );
        return lines.join('\n');
    }
}

export const turnoverBandScanService = new TurnoverBandScanService();
export default TurnoverBandScanService;
