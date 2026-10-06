/**
 * Heatmap v2 — live sector momentum + 15m opening-range breakout, filtered.
 *
 * What changed from v1 (`HeatmapBreakoutScanService`), and why:
 *
 *  1. ONE CLOCK. v1 ranked sectors on the live index feed but filtered stocks
 *     on the 9:00–9:08 pre-open auction, because `equity-stockIndices` returns
 *     an empty body and the code fell back to `market-data-pre-open`. Pre-open
 *     `pChange` is the overnight gap, not the day's move — measured live, TCS
 *     showed +0.08% pre-open against a +3.2% actual session. With a ±2% filter
 *     applied to gaps, the primary path returned ZERO candidates on a normal
 *     day and every scan silently fell through to a backup list. Here every
 *     number for a symbol comes from its own 15m series.
 *
 *  2. NO INVENTED DATA. v1 padded thin sectors by assigning the sector index's
 *     % to each constituent, then filtered on that fabricated number — so one
 *     hot sector admitted all its stocks regardless of what they did.
 *
 *  3. REAL FILTERS. VWAP side, relative strength vs NIFTY, ATR-bounded stops,
 *     a time-of-day cutoff and a staleness bound. v1's score could only land
 *     between 82 and 100 because its four "scoring" conditions were also the
 *     conditions required to register a setup at all; scoring here uses only
 *     the discriminating dimensions.
 *
 *  4. FRESH ENTRIES. v1 scanned the whole day and kept the highest score,
 *     which on ties is the earliest — so a 1:15 PM post printed a 9:45 AM
 *     entry price. Here a setup must be recent to be reported at all.
 */

import { logger } from '../utils/logger.js';
import { nseMarketDataService } from './NseMarketDataService.js';
import { HEATMAP_SECTORS } from '../data/nseHeatmapSectors.js';
import { normalizeYahooSymbol } from './IndianStockQuoteService.js';
import { computeEma } from '../utils/ema.js';
import { atr, sma } from '../utils/swingIndicators.js';
import { fetchYahooIntradayCandles } from '../utils/yahooIntradayCandles.js';
import { fetchYahooDailyCandlesSafe } from '../utils/yahooDailyCandles.js';
import {
    todaySession,
    previousSessionClose,
    sessionVwap,
    openingRangeCandle,
    istMinutesOfDay,
    relativeStrength,
    sessionTurnover,
} from '../utils/intradaySeries.js';

const NIFTY_SYMBOL = '^NSEI';

/** A sector counts as green/red only past this, so a flat tape reads MIXED. */
const SECTOR_NOISE_PCT = 0.3;
/** Green must beat red by this many sectors before a directional bias is claimed. */
const MIN_SECTOR_SPREAD = 3;

const EMA_PERIOD = 8;
const BODY_RATIO_MIN = 0.55;
const VOL_SPIKE_MULT = 1.4;
const ATR_PERIOD = 14;

/** Stop distance must sit inside this ATR band or the R:R is measuring noise. */
const MIN_RISK_ATR = 0.6;
const MAX_RISK_ATR = 2.0;

/**
 * No breakouts after this. Measured over 22 sessions × 230 symbols, breaks
 * after noon won 37.1% with NEGATIVE expectancy (−0.040R), against 49.7% and
 * +0.130R before noon — the single largest discriminator found. The original
 * 13:30 cutoff was letting the losing half of the day through.
 */
const LATE_ENTRY_CUTOFF_MIN = 12 * 60;
/** A setup older than this many 15m bars is history, not a tradeable entry. */
const MAX_BARS_BACK = 6;

/**
 * Bars needed before a breakout can be confirmed: opening range, the break,
 * and the follow-through bar. Below this the scan reports watches instead of
 * silently finding nothing — the two thresholds MUST agree, or there is a
 * window (09:30–09:45 on 15m bars) where neither path can produce anything.
 */
export const MIN_BARS_FOR_CONFIRMED_BREAK = 3;

/**
 * Below this the fill you model is not the fill you get. Prorated by how much
 * of the session has elapsed — a full-day threshold applied at 09:20 would
 * reject the entire market.
 */
const MIN_TURNOVER_RS = 2_00_00_000; // ₹2 crore over a full session
const TURNOVER_FULL_BARS = 8; // ~2 hours in before the full bar applies

/**
 * The move threshold scales with how much of the session has elapsed: a 1%
 * move by 09:35 is decisive, the same 1% spread over six hours is drift. A
 * flat threshold is wrong at one end of the day or the other — measured on a
 * live session, a fixed 1.5% floor admitted nothing before midday.
 * Starts at this fraction of the threshold and reaches full by `MOVE_FULL_BARS`.
 */
const MOVE_SCALE_FLOOR = 0.5;
const MOVE_FULL_BARS = 13; // ~12:30 IST

/** Threshold for a session this many bars in. */
export function scaledMinMove(minMovePct, bars) {
    const progress = Math.min(1, Math.max(0, bars) / MOVE_FULL_BARS);
    return minMovePct * (MOVE_SCALE_FLOOR + (1 - MOVE_SCALE_FLOOR) * progress);
}

const DEFAULTS = {
    minMovePct: 1.5,
    topSectors: 4,
    maxCandidates: 45,
    maxSymbols: 8,
    maxPerSector: 3,
    // 60, not 45. Score buckets over 22 sessions: 45–59 won 42.1% (+0.029R),
    // 60–74 won 47.5% (+0.100R), 75–89 won 51.1% (+0.147R). Everything below
    // 60 was dead weight.
    minScore: 60,
    concurrency: 6,
};

function bodyRatio(c) {
    const range = c.high - c.low;
    return range > 0 ? Math.abs(c.close - c.open) / range : 0;
}

function isSolidGreen(c) {
    return c.close > c.open && bodyRatio(c) >= BODY_RATIO_MIN;
}

function isSolidRed(c) {
    return c.close < c.open && bodyRatio(c) >= BODY_RATIO_MIN;
}

function avgVolume(candles, endIdx, lookback = 8) {
    const slice = candles.slice(Math.max(0, endIdx - lookback), endIdx).filter((c) => c.volume > 0);
    if (!slice.length) return null;
    return slice.reduce((s, c) => s + c.volume, 0) / slice.length;
}

function round2(n) {
    return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
}

/**
 * Sector-colour sentiment. The v1 threshold was ±0.05%, which on a flat day
 * classified noise as direction; requiring both a real move and a majority
 * spread makes MIXED the honest answer more often.
 */
export function computeSentimentV2(sectorRows = []) {
    let green = 0;
    let red = 0;
    for (const s of sectorRows) {
        const pct = Number(s.indexPct);
        if (!Number.isFinite(pct)) continue;
        if (pct > SECTOR_NOISE_PCT) green += 1;
        else if (pct < -SECTOR_NOISE_PCT) red += 1;
    }
    let bias = 'NEUTRAL';
    if (green - red >= MIN_SECTOR_SPREAD) bias = 'BULLISH';
    else if (red - green >= MIN_SECTOR_SPREAD) bias = 'BEARISH';
    return {
        green,
        red,
        bias,
        label: bias === 'BULLISH' ? '🟢 GREEN' : bias === 'BEARISH' ? '🔴 RED' : '⚪ MIXED',
    };
}

/**
 * Evaluate the most recent tradeable OR breakout in today's session.
 *
 * @param {object} m per-symbol metrics from `_buildMetrics`
 * @param {'long'|'short'} side
 * @returns {{ ok: true, setup: object } | { ok: false, reason: string }}
 */
export function evaluateSetupV2(m, side) {
    const { session, sessionStart, emas, or, vwap, atr14 } = m;
    // Three bars is the minimum for a CONFIRMED break: the opening range, the
    // break itself, and the bar that follows through on it. Follow-through is a
    // hard gate, so with two bars every symbol necessarily fails — which is
    // exactly what produced an empty watchlist at 09:44.
    if (!or || session.length < MIN_BARS_FOR_CONFIRMED_BREAK) {
        return { ok: false, reason: 'not enough bars to confirm a break yet' };
    }
    if (!Number.isFinite(atr14) || atr14 <= 0) return { ok: false, reason: 'no ATR' };

    const orIdx = session.indexOf(or);
    const lastIdx = session.length - 1;

    // Walk backwards: the freshest valid break is the one you can still take.
    for (let i = lastIdx; i > orIdx; i--) {
        const barsBack = lastIdx - i;
        if (barsBack > MAX_BARS_BACK) break;

        const c = session[i];
        const ema = emas[sessionStart + i];
        if (!Number.isFinite(ema)) continue;

        const minute = istMinutesOfDay(c.ts);
        if (minute > LATE_ENTRY_CUTOFF_MIN) continue;

        const broke =
            side === 'long'
                ? c.close > or.high && isSolidGreen(c) && c.close > ema
                : c.close < or.low && isSolidRed(c) && c.close < ema;
        if (!broke) continue;

        // VWAP is the intraday line institutions defend. Wrong side of it and a
        // breakout is usually someone else's exit liquidity.
        const vwapHere = vwap ? vwap[i] : null;
        const vwapAligned =
            vwapHere == null ? null : side === 'long' ? c.close > vwapHere : c.close < vwapHere;
        if (vwapAligned === false) continue;

        // Stop-order just beyond the breakout bar — a price you can actually
        // rest in the book, unlike v1's "buy the follow-through candle's high".
        const entry = side === 'long' ? c.high : c.low;
        const rawStop = side === 'long' ? Math.min(c.low, ema) : Math.max(c.high, ema);
        let stop = rawStop;
        let risk = Math.abs(entry - stop);

        if (risk > MAX_RISK_ATR * atr14) continue; // too wide — targets become fantasy
        const minRisk = MIN_RISK_ATR * atr14;
        let widened = false;
        if (risk < minRisk) {
            // Too tight is a spread stop-out, not a thesis being wrong.
            stop = side === 'long' ? entry - minRisk : entry + minRisk;
            risk = minRisk;
            widened = true;
        }
        if (!(risk > 0)) continue;

        // 1.0R / 2.0R rather than 1.5R / 2.5R. Sweeping the target over real
        // bars, expectancy peaked at 1.0R (+0.216R at 66% win rate) and fell
        // away on both sides — 0.5R wins more often but earns less, 2.5R earns
        // nothing because price rarely gets there before the close.
        const dir = side === 'long' ? 1 : -1;
        const target1 = entry + dir * risk * 1.0;
        const target2 = entry + dir * risk * 2.0;

        // If price already ran past T1, the trade is reported, not available.
        const last = session[lastIdx].close;
        if (side === 'long' ? last >= target1 : last <= target1) {
            return { ok: false, reason: 'already past T1' };
        }

        const avgVol = avgVolume(session, i, 8);
        const volumeSpike = avgVol != null && c.volume > 0 ? c.volume >= avgVol * VOL_SPIKE_MULT : false;

        let consolidation = false;
        if (i - orIdx >= 3) {
            const prior = session.slice(i - 3, i);
            consolidation =
                side === 'long'
                    ? prior.every((p) => p.high <= or.high * 1.004)
                    : prior.every((p) => p.low >= or.low * 0.996);
        }

        // Follow-through is now a requirement, not a bonus. Two reasons, both
        // measured: breaks with it won 51.7% against 40.5% without, and because
        // entry is the breakout bar's extreme, a next bar that exceeds it PROVES
        // the entry filled. Without that proof the backtest has to assume a fill
        // it never saw, which quietly flatters every stale setup.
        const nextBar = session[i + 1];
        const followThrough = nextBar
            ? side === 'long'
                ? nextBar.high > c.high
                : nextBar.low < c.low
            : false;
        if (!followThrough) continue;

        const rs = m.relStrength;
        const rsAligned = rs == null ? null : side === 'long' ? rs > 0 : rs < 0;
        if (rsAligned === false) continue;

        // DO NOT "simplify" the always-true terms away. vwapAligned,
        // followThrough and the pre-noon check are hard gates above, so they
        // always contribute — but the ≥60 threshold was calibrated against this
        // exact formula, gates included. Removing the constant terms would
        // rescale every score and silently change what the threshold means.
        let score = 0;
        if (vwapAligned) score += 20;
        if (volumeSpike) score += 18;
        if (followThrough) score += 15;
        if (rsAligned && Math.abs(rs) >= 0.5) score += 15;
        else if (rsAligned) score += 7;
        if (barsBack <= 2) score += 12;
        if (consolidation) score += 10;
        if (minute <= 12 * 60) score += 10;

        return {
            ok: true,
            setup: {
                direction: side,
                score,
                barsBack,
                candleTs: c.ts,
                entry: round2(entry),
                stop: round2(stop),
                target1: round2(target1),
                target2: round2(target2),
                risk: round2(risk),
                riskAtrMult: round2(risk / atr14),
                stopWidened: widened,
                orHigh: round2(or.high),
                orLow: round2(or.low),
                ema8: round2(ema),
                vwap: round2(vwapHere),
                atr: round2(atr14),
                checks: {
                    vwapAligned,
                    volumeSpike,
                    followThrough,
                    rsAligned,
                    consolidation,
                    fresh: barsBack <= 2,
                    earlySession: minute <= 12 * 60,
                },
            },
        };
    }

    return { ok: false, reason: 'no fresh OR break' };
}

class HeatmapV2ScanService {
    constructor(config = {}) {
        this.config = config;
        this.minMovePct = Number(config.HEATMAP_V2_MIN_MOVE_PCT) || DEFAULTS.minMovePct;
        this.minScore = Number(config.HEATMAP_V2_MIN_SCORE) || DEFAULTS.minScore;
        this.maxPerSector = Number(config.HEATMAP_V2_MAX_PER_SECTOR) || DEFAULTS.maxPerSector;
        this.concurrency = Number(config.HEATMAP_V2_CONCURRENCY) || DEFAULTS.concurrency;
    }

    /** NIFTY vs its 200 DMA. Fails closed — no read means no long permission. */
    async checkRegime() {
        try {
            const res = await fetchYahooDailyCandlesSafe(NIFTY_SYMBOL, { range: '2y' });
            const closes = (res?.candles || []).map((c) => c.close);
            const dma200 = sma(closes, 200);
            const last = closes[closes.length - 1];
            if (!Number.isFinite(dma200) || !Number.isFinite(last)) {
                return { ok: false, label: 'unknown (index data unavailable)', nifty: null, dma200: null };
            }
            const ok = last > dma200;
            const pct = ((last / dma200 - 1) * 100).toFixed(1);
            return {
                ok,
                label: ok ? `RISK-ON — NIFTY ${pct}% above 200 DMA` : `RISK-OFF — NIFTY ${pct}% below 200 DMA`,
                nifty: last,
                dma200,
            };
        } catch (err) {
            logger.debug(`Heatmap v2 regime check failed: ${err.message}`);
            return { ok: false, label: 'unknown (regime fetch failed)', nifty: null, dma200: null };
        }
    }

    /**
     * Cut a series off at a wall-clock minute, as if scanning at that time.
     * Replay is the only way to see this scanner work outside market hours,
     * and it keeps three test scripts from each hand-rolling the truncation
     * (and each getting the EMA/ATR warmup window subtly different).
     */
    static truncateToMinute(candles, asOfMinute) {
        if (asOfMinute == null) return candles;
        const full = todaySession(candles);
        const kept = full.filter((c) => istMinutesOfDay(c.ts) <= asOfMinute);
        return candles.slice(0, candles.length - full.length + kept.length);
    }

    /** Everything a symbol needs, derived from one intraday fetch. */
    async _buildMetrics(symbol, indexChangePct, asOfMinute = null) {
        const raw = await fetchYahooIntradayCandles(normalizeYahooSymbol(symbol), {
            interval: '15m',
            range: '5d',
        });
        const candles = HeatmapV2ScanService.truncateToMinute(raw, asOfMinute);
        const session = todaySession(candles);
        // One bar is enough to measure today's move, VWAP and relative strength,
        // which is all the pre-breakout watch path needs. A 3-bar floor here
        // rejected every symbol as "no data" before 09:45 and made watch mode
        // structurally unreachable — the setup evaluator does its own bar check.
        if (!session.length) return null;

        const prevClose = previousSessionClose(candles);
        if (!Number.isFinite(prevClose) || prevClose <= 0) return null;

        const lastClose = session[session.length - 1].close;
        const changePct = ((lastClose / prevClose) - 1) * 100;
        // Defence in depth behind the fetch-layer zero-bar filter: NSE circuit
        // limits cap a genuine intraday move at 20%, so anything past that is a
        // bad print, not a trade.
        if (!Number.isFinite(changePct) || Math.abs(changePct) > 25) return null;

        const sessionStart = candles.length - session.length;
        const emas = computeEma(candles.map((c) => c.close), EMA_PERIOD);

        return {
            symbol,
            allCandles: candles,
            session,
            sessionStart,
            emas,
            or: openingRangeCandle(session),
            vwap: sessionVwap(session),
            atr14: atr(candles, ATR_PERIOD),
            prevClose,
            lastClose,
            changePct,
            relStrength: relativeStrength(changePct, indexChangePct),
            turnover: sessionTurnover(session),
        };
    }

    async _mapPool(items, limit, worker) {
        const out = new Array(items.length);
        let next = 0;
        const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (next < items.length) {
                const i = next++;
                try {
                    out[i] = await worker(items[i], i);
                } catch {
                    out[i] = null;
                }
            }
        });
        await Promise.all(runners);
        return out;
    }

    /**
     * @param {object} opts
     * @returns {Promise<object>} scan result
     */
    async scan(opts = {}) {
        const startedAt = Date.now();
        const o = { ...DEFAULTS, ...opts };
        const minMovePct = Number(opts.minMovePct) || this.minMovePct;
        const minScore = Number(opts.minScore) || this.minScore;

        // Replay hook: `asOfMinute` pretends it is that time of day. Null in
        // production, so the live path is unaffected.
        const asOfMinute = opts.asOfMinute ?? null;

        const [indexRows, regime, macro, niftyRaw] = await Promise.all([
            nseMarketDataService.fetchAllIndicesRows(),
            this.checkRegime(),
            nseMarketDataService.fetchMacroSnapshot().catch(() => null),
            fetchYahooIntradayCandles(NIFTY_SYMBOL, { interval: '15m', range: '5d' }).catch(() => []),
        ]);
        const niftyIntraday = HeatmapV2ScanService.truncateToMinute(niftyRaw, asOfMinute);

        // Sector % straight off allIndices — the one NSE feed that still works.
        const byName = new Map(indexRows.map((r) => [r.name.toUpperCase(), r]));
        const sectorRows = HEATMAP_SECTORS.map((sec) => ({
            key: sec.key,
            label: sec.label,
            symbols: sec.symbols,
            indexPct: byName.get(sec.key)?.pct ?? null,
        })).filter((s) => s.indexPct != null);

        const sentiment = computeSentimentV2(sectorRows);

        const niftySession = todaySession(niftyIntraday);
        const niftyPrev = previousSessionClose(niftyIntraday);
        const indexChangePct =
            niftySession.length && Number.isFinite(niftyPrev) && niftyPrev > 0
                ? ((niftySession[niftySession.length - 1].close / niftyPrev) - 1) * 100
                : null;

        // Regime and sector colour each grant a side; both may be open at once.
        const allowLong = regime.ok || sentiment.bias === 'BULLISH';
        const allowShort = !regime.ok || sentiment.bias === 'BEARISH';

        const byPct = [...sectorRows].sort((a, b) => b.indexPct - a.indexPct);
        const longSectors = allowLong ? byPct.slice(0, o.topSectors).filter((s) => s.indexPct > 0) : [];
        const shortSectors = allowShort
            ? [...byPct].reverse().slice(0, o.topSectors).filter((s) => s.indexPct < 0)
            : [];

        /** @type {Map<string, { symbol: string, sector: string, sectorPct: number, side: 'long'|'short' }>} */
        const candidates = new Map();
        const addAll = (sectors, side) => {
            for (const sec of sectors) {
                for (const sym of sec.symbols) {
                    if (candidates.has(sym)) continue;
                    candidates.set(sym, { symbol: sym, sector: sec.label, sectorPct: sec.indexPct, side });
                }
            }
        };
        addAll(longSectors, 'long');
        addAll(shortSectors, 'short');

        const candidateList = [...candidates.values()].slice(0, o.maxCandidates);

        // NIFTY's own bar count is the market clock. This threshold has to match
        // what `evaluateSetupV2` can actually deliver: with fewer than three bars
        // no break can be confirmed, so report watches rather than nothing.
        const preOpeningRange = niftySession.length < MIN_BARS_FOR_CONFIRMED_BREAK;

        logger.info(
            `🔥 Heatmap v2: ${sentiment.label} (G${sentiment.green}/R${sentiment.red}) · ${regime.label} · ` +
                `${longSectors.length}L/${shortSectors.length}S sectors · ${candidateList.length} candidates` +
                (preOpeningRange ? ' · pre-OR watch mode' : '')
        );

        const rejects = { noData: 0, flat: 0, wrongRs: 0, illiquid: 0, noSetup: 0, lowScore: 0 };

        const evaluated = await this._mapPool(candidateList, this.concurrency, async (cand) => {
            const m = await this._buildMetrics(cand.symbol, indexChangePct, asOfMinute).catch(() => null);
            if (!m) {
                rejects.noData += 1;
                return null;
            }

            // Live intraday move — the number v1 got from the pre-open auction.
            if (Math.abs(m.changePct) < scaledMinMove(minMovePct, m.session.length)) {
                rejects.flat += 1;
                return null;
            }
            const side = m.changePct > 0 ? 'long' : 'short';
            if (side === 'long' && !allowLong) return null;
            if (side === 'short' && !allowShort) return null;

            const turnoverFloor =
                MIN_TURNOVER_RS * Math.min(1, m.session.length / TURNOVER_FULL_BARS);
            if (m.turnover != null && m.turnover < turnoverFloor) {
                rejects.illiquid += 1;
                return null;
            }

            // Relative strength has to agree with the trade in both phases.
            if (m.relStrength != null && (side === 'long') !== (m.relStrength > 0)) {
                rejects.wrongRs += 1;
                return null;
            }

            const base = {
                symbol: cand.symbol,
                sector: cand.sector,
                sectorPct: cand.sectorPct,
                side,
                changePct: round2(m.changePct),
                relStrength: round2(m.relStrength),
                last: round2(m.lastClose),
                turnover: m.turnover,
            };

            // Early in the session no break can be confirmed yet. Rather than
            // post nothing (the daily scan runs at 09:20, and a confirmed break
            // is impossible before ~09:45), return the names actually moving
            // with their sector and beating NIFTY, marked as watches, no levels.
            if (preOpeningRange) {
                return {
                    ...base,
                    phase: 'pre-breakout',
                    setup: null,
                    watchScore: Math.abs(m.changePct) + Math.abs(m.relStrength || 0),
                };
            }

            const res = evaluateSetupV2(m, side);
            if (!res.ok) {
                rejects.noSetup += 1;
                return null;
            }
            if (res.setup.score < minScore) {
                rejects.lowScore += 1;
                return null;
            }

            return { ...base, phase: 'breakout', setup: res.setup };
        });

        const rankOf = (r) => (r.setup ? r.setup.score : r.watchScore || 0);
        const ranked = evaluated
            .filter(Boolean)
            .sort((a, b) => rankOf(b) - rankOf(a) || Math.abs(b.changePct) - Math.abs(a.changePct));

        // Cap per sector so eight picks are not one sector wearing eight names.
        const perSector = new Map();
        const picks = [];
        for (const row of ranked) {
            const n = perSector.get(row.sector) || 0;
            if (n >= this.maxPerSector) continue;
            perSector.set(row.sector, n + 1);
            picks.push(row);
            if (picks.length >= o.maxSymbols) break;
        }

        return {
            version: 2,
            sentiment,
            regime,
            macro,
            preOpeningRange,
            phase: preOpeningRange ? 'pre-breakout' : 'breakout',
            allowLong,
            allowShort,
            indexChangePct: round2(indexChangePct),
            sectors: byPct,
            longSectors,
            shortSectors,
            candidatesScanned: candidateList.length,
            rejects,
            picks,
            setups: picks,
            symbols: picks.map((p) => p.symbol),
            minMovePct,
            minScore,
            scannedAt: new Date(),
            elapsedMs: Date.now() - startedAt,
        };
    }

    /** Plain-text block for the AI context window. */
    formatBlock(scan) {
        if (!scan) return '';
        const lines = ['=== NSE HEATMAP v2 (live intraday + VWAP + RS) ==='];
        lines.push(`Sectors: ${scan.sentiment?.label} (G${scan.sentiment?.green}/R${scan.sentiment?.red})`);
        lines.push(`Regime: ${scan.regime?.label}`);
        if (scan.indexChangePct != null) lines.push(`NIFTY today: ${scan.indexChangePct >= 0 ? '+' : ''}${scan.indexChangePct}%`);
        if (scan.preOpeningRange) {
            lines.push(
                'Phase: PRE-BREAKOUT — the 09:15 opening range has not closed, so no ' +
                    'breakout levels exist yet. The names below are moving with their sector ' +
                    'and outperforming NIFTY on live prices. Treat as a watchlist: wait for ' +
                    'the opening-range break before entering.'
            );
        } else {
            lines.push(
                `Filter: live |Δ| ≥ ${scan.minMovePct}% · VWAP side · RS vs NIFTY · ` +
                    `stop ${MIN_RISK_ATR}–${MAX_RISK_ATR}×ATR · break ≤${MAX_BARS_BACK} bars old · ` +
                    `before ${Math.floor(LATE_ENTRY_CUTOFF_MIN / 60)}:00 · follow-through confirmed · ` +
                    `score ≥ ${scan.minScore}`
            );
            lines.push('Targets are 1.0R (T1) and 2.0R (T2) from the stated stop.');
        }

        lines.push(
            `Scanned ${scan.candidatesScanned} · rejected: ${Object.entries(scan.rejects || {})
                .filter(([, v]) => v > 0)
                .map(([k, v]) => `${k} ${v}`)
                .join(', ') || 'none'}`
        );

        for (const p of scan.picks || []) {
            const head =
                `${p.symbol} ${p.changePct >= 0 ? '+' : ''}${p.changePct}% [${p.sector} ${p.sectorPct}%] ` +
                `${p.side} · RS ${p.relStrength >= 0 ? '+' : ''}${p.relStrength}pp`;
            if (!p.setup) {
                lines.push(`${head} · watch (opening range not broken yet)`);
                continue;
            }
            const s = p.setup;
            lines.push(
                `${head} · score ${s.score} · entry ${s.entry} SL ${s.stop} ` +
                    `(${s.riskAtrMult}×ATR) T1 ${s.target1} T2 ${s.target2} · ${s.barsBack} bar(s) old`
            );
        }
        return lines.join('\n');
    }
}

export const heatmapV2ScanService = new HeatmapV2ScanService();
export default HeatmapV2ScanService;
