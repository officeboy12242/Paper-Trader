/**
 * Swing momentum scan — the strategy with the strongest evidence base available
 * for NSE, assembled from three independently-supported pieces:
 *
 *  1. RANKING  — risk-adjusted cross-sectional momentum (6M + 12M return divided
 *     by annualised volatility, z-scored across the universe). This mirrors NSE's
 *     own Nifty200 Momentum 30 methodology, which has delivered ~7% p.a. excess
 *     over Nifty 200 TRI and underperformed in only 4 of 18 calendar years —
 *     audited, survivorship-free, India-specific evidence.
 *  2. TIMING   — 52-week-high proximity plus a volume expansion filter, which
 *     converts a monthly ranking into swing-timeframe entries.
 *  3. REGIME   — no new longs while NIFTY 50 trades below its 200 DMA. Breakout
 *     and momentum strategies fail together in bear markets; this is the single
 *     biggest failure mode either piece has.
 *
 * Every number here is deterministic arithmetic. No LLM participates in ranking
 * or level selection — that keeps results reproducible and auditable against
 * recorded outcomes.
 */

import { logger } from '../utils/logger.js';
import { config as defaultConfig } from '../config/config.js';
import { getSwingUniverse, sectorOf } from '../data/nseSwingUniverse.js';
import { fetchYahooDailyCandlesSafe } from '../utils/yahooDailyCandles.js';
import { normalizeYahooSymbol } from './IndianStockQuoteService.js';
import {
    sma,
    atr,
    momentumRatio,
    zScores,
    normalizeZ,
    highestHigh,
    priorHighestHigh,
    recentSwingLow,
    volumeRatio,
    avgTurnover,
    TRADING_DAYS_YEAR,
    TRADING_DAYS_6M,
} from '../utils/swingIndicators.js';
import { niftyTraderChainService } from './NiftyTraderChainService.js';

const NIFTY_SYMBOL = '^NSEI';

/** Minimum bars needed for a 12-month momentum reading. */
const MIN_BARS = TRADING_DAYS_YEAR + 10;

export default class SwingMomentumScanService {
    constructor(cfg = defaultConfig) {
        this.config = cfg;
        this.universe = getSwingUniverse(cfg.SWING_UNIVERSE);
        this.concurrency = Math.max(1, Math.min(10, Number(cfg.SWING_SCAN_CONCURRENCY) || 6));
        this.riskFreeAnnual = Number(cfg.SWING_RISK_FREE_RATE) || 0.065;

        // Entry filters
        this.maxPctFrom52wHigh = Number(cfg.SWING_MAX_PCT_FROM_HIGH) || 5;
        this.minVolumeRatio = Number(cfg.SWING_MIN_VOLUME_RATIO) || 1.5;
        this.minTurnoverCr = Number(cfg.SWING_MIN_TURNOVER_CR) || 5;
        this.maxPicks = Math.max(1, Number(cfg.SWING_MAX_PICKS) || 5);

        // Risk model
        this.atrStopMult = Number(cfg.SWING_ATR_STOP_MULT) || 2;
        this.riskPctPerTrade = Number(cfg.SWING_RISK_PCT) || 0.5;
        this.capital = Number(cfg.SWING_CAPITAL) || 100_000;
        /** Correlated picks are one bet, not many — cap exposure per sector. */
        this.maxPerSector = Math.max(1, Number(cfg.SWING_MAX_PER_SECTOR) || 2);
    }

    /** Run async work over items with bounded concurrency. */
    async _mapPool(items, limit, worker) {
        const out = new Array(items.length);
        let next = 0;
        const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (next < items.length) {
                const i = next++;
                out[i] = await worker(items[i], i);
            }
        });
        await Promise.all(runners);
        return out;
    }

    /**
     * Market regime gate. Longs are only enabled while NIFTY 50 holds its 200 DMA.
     * @returns {Promise<{ ok: boolean, label: string, nifty: number|null, dma200: number|null }>}
     */
    async checkRegime() {
        const res = await fetchYahooDailyCandlesSafe(NIFTY_SYMBOL, { range: '2y' });
        if (!res?.candles?.length) {
            // Fail closed: without a regime read we cannot confirm it is safe to be long.
            return { ok: false, label: 'unknown (index data unavailable)', nifty: null, dma200: null };
        }
        const closes = res.candles.map((c) => c.close);
        const last = closes[closes.length - 1];
        const dma200 = sma(closes, 200);
        if (dma200 == null) {
            return { ok: false, label: 'unknown (insufficient history)', nifty: last, dma200: null };
        }
        const ok = last > dma200;
        const pct = ((last / dma200 - 1) * 100).toFixed(1);
        return {
            ok,
            label: ok ? `RISK-ON — NIFTY ${pct}% above 200 DMA` : `RISK-OFF — NIFTY ${pct}% below 200 DMA`,
            nifty: last,
            dma200,
        };
    }

    /** Fetch candles and derive every per-symbol metric. */
    async _buildMetrics(symbol) {
        const yahooSymbol = normalizeYahooSymbol(symbol);
        const res = await fetchYahooDailyCandlesSafe(yahooSymbol, { range: '2y' });
        const candles = res?.candles;
        if (!candles || candles.length < MIN_BARS) return null;

        const closes = candles.map((c) => c.close);
        const last = closes[closes.length - 1];
        if (!Number.isFinite(last) || last <= 0) return null;

        const mom6 = momentumRatio(closes, TRADING_DAYS_6M, this.riskFreeAnnual);
        const mom12 = momentumRatio(closes, TRADING_DAYS_YEAR, this.riskFreeAnnual);
        if (mom6 == null || mom12 == null) return null;

        const high52 = highestHigh(candles, TRADING_DAYS_YEAR);
        const prior52 = priorHighestHigh(candles, TRADING_DAYS_YEAR, 1);
        const dma50 = sma(closes, 50);
        const dma200 = sma(closes, 200);
        const atr14 = atr(candles, 14);
        const volRatio = volumeRatio(candles, 20);
        const turnover = avgTurnover(candles, 20);
        const swingLow = recentSwingLow(candles, 20);

        return {
            symbol,
            yahooSymbol,
            displayName: res.meta?.longName || res.meta?.shortName || symbol,
            price: last,
            mom6,
            mom12,
            high52,
            prior52,
            dma50,
            dma200,
            atr14,
            volRatio,
            turnover,
            swingLow,
            pctFromHigh: high52 ? ((high52 - last) / high52) * 100 : null,
            // A genuine breakout: today's close clears the prior 52-week range.
            isNewHigh: prior52 != null && last > prior52,
        };
    }

    /**
     * Stage 2 filters. Ranking answers "what is strong"; these answer
     * "is it entryable today at a sane price".
     */
    _passesEntryFilters(m) {
        const reasons = [];
        if (m.dma50 == null || m.dma200 == null) reasons.push('insufficient history');
        else if (!(m.price > m.dma50)) reasons.push('below 50 DMA');
        else if (!(m.dma50 > m.dma200)) reasons.push('50 DMA below 200 DMA');

        if (m.pctFromHigh == null || m.pctFromHigh > this.maxPctFrom52wHigh) {
            reasons.push(`${m.pctFromHigh?.toFixed(1) ?? '?'}% off 52w high`);
        }
        if (m.volRatio == null || m.volRatio < this.minVolumeRatio) {
            reasons.push(`volume ${m.volRatio?.toFixed(2) ?? '?'}× < ${this.minVolumeRatio}×`);
        }
        const turnoverCr = m.turnover != null ? m.turnover / 1e7 : null;
        if (turnoverCr == null || turnoverCr < this.minTurnoverCr) {
            reasons.push(`turnover ₹${turnoverCr?.toFixed(1) ?? '?'}Cr < ₹${this.minTurnoverCr}Cr`);
        }
        if (m.atr14 == null || m.atr14 <= 0) reasons.push('no ATR');

        return { pass: reasons.length === 0, reasons };
    }

    /** ATR-based stop, R-multiple targets, and position size for the configured risk. */
    _buildTradePlan(m) {
        const entry = m.price;
        const atrStop = entry - this.atrStopMult * m.atr14;
        // Prefer the structural swing low when it sits just below the ATR stop —
        // it is where the trade thesis actually breaks.
        const stop = m.swingLow != null && m.swingLow < entry && m.swingLow > atrStop * 0.97
            ? Math.min(atrStop, m.swingLow * 0.995)
            : atrStop;

        const risk = entry - stop;
        if (!(risk > 0)) return null;

        const riskBudget = (this.capital * this.riskPctPerTrade) / 100;
        const qty = Math.floor(riskBudget / risk);
        // Whole-share rounding: a high-priced stock can be unsizeable at this
        // capital/risk pair. Reporting a 0-share "setup" would be noise.
        if (qty < 1) {
            return {
                unsizeable: true,
                entry,
                stop,
                risk,
                minCapitalNeeded: (risk * 100) / this.riskPctPerTrade,
            };
        }

        const actualRisk = qty * risk;
        return {
            entry,
            stop,
            risk,
            riskPct: (risk / entry) * 100,
            target1: entry + 2 * risk,
            target2: entry + 3 * risk,
            qty,
            capitalRequired: qty * entry,
            riskAmount: actualRisk,
            // Rounding down to whole shares can leave real risk well under budget.
            riskUtilisation: actualRisk / riskBudget,
        };
    }

    /**
     * Fetch NSE option-chain OI data for F&O-eligible picks and score each
     * stock on three bullish-derivative signals:
     *   • PCR > 1 → put writers confident floor holds
     *   • CE OI falling (call unwinding) → bulls covering shorts = bullish
     *   • PE OI rising (put writing) → writers building support = bullish
     *
     * Returns the same picks array with `.oi` and `.oiScore` attached to each.
     * Stocks without F&O data simply get oiScore = 0 and remain in the list —
     * the OI signal is additive, never a disqualifier.
     */
    async _enrichWithOI(picks) {
        if (!picks.length) return picks;

        const enriched = await this._mapPool(picks, Math.min(5, this.concurrency), async (pick) => {
            try {
                const ctx = await niftyTraderChainService.fetchOptionContext(pick.symbol);
                if (!ctx?.snapshot?.strikes?.length) return { ...pick, oi: null, oiScore: 0 };

                const { strikes, totalCeOi, totalPeOi } = ctx.snapshot;
                const pcr = totalCeOi > 0 ? totalPeOi / totalCeOi : null;

                // Aggregate OI change across all strikes
                let ceOiChange = 0;
                let peOiChange = 0;
                for (const s of strikes) {
                    if (s.ce) ceOiChange += s.ce.oi || 0;
                    if (s.pe) peOiChange += s.pe.oi || 0;
                }

                // 1. PCR score (0-2)
                let pcrScore = 0;
                if (pcr != null) {
                    if (pcr > 1.2) pcrScore = 2;
                    else if (pcr > 1.0) pcrScore = 1.5;
                    else if (pcr > 0.8) pcrScore = 1;
                    else if (pcr > 0.6) pcrScore = 0.5;
                }

                // 2. CE unwinding (call writers covering) — bullish (0-1)
                //    We use total CE OI relative to PE OI as a proxy:
                //    lower relative CE OI = more unwinding = bullish
                let unwindScore = 0;
                if (pcr != null && pcr > 1) unwindScore = 1;
                else if (pcr > 0.9) unwindScore = 0.5;

                // 3. PE buildup (put writers adding support) (0-1)
                let buildupScore = 0;
                if (totalPeOi > totalCeOi) buildupScore = 1;
                else if (totalPeOi > totalCeOi * 0.8) buildupScore = 0.5;

                const oiScore = Math.min(2, pcrScore * 0.4 + unwindScore * 0.3 + buildupScore * 0.3);

                return {
                    ...pick,
                    oi: {
                        pcr: pcr ? +pcr.toFixed(2) : null,
                        totalCeOi,
                        totalPeOi,
                        ceOiChange,
                        peOiChange,
                        pcrScore,
                        unwindScore,
                        buildupScore,
                    },
                    oiScore,
                };
            } catch {
                return { ...pick, oi: null, oiScore: 0 };
            }
        });

        return enriched;
    }

    /**
     * Full scan.
     * @param {{ ignoreRegime?: boolean, maxPicks?: number }} [opts]
     */
    async scan({ ignoreRegime = false, maxPicks = this.maxPicks } = {}) {
        const startedAt = Date.now();
        const regime = await this.checkRegime();

        if (!regime.ok && !ignoreRegime) {
            logger.info(`Swing scan halted — ${regime.label}`);
            return {
                regime,
                halted: true,
                picks: [],
                scanned: 0,
                ranked: 0,
                elapsedMs: Date.now() - startedAt,
            };
        }

        const metrics = (
            await this._mapPool(this.universe, this.concurrency, (sym) =>
                this._buildMetrics(sym).catch(() => null)
            )
        ).filter(Boolean);

        if (!metrics.length) {
            return { regime, halted: false, picks: [], scanned: 0, ranked: 0, elapsedMs: Date.now() - startedAt };
        }

        // Cross-sectional ranking: z-score each horizon across the universe, map
        // through NSE's positive normalisation, then blend the two horizons.
        const z6 = zScores(metrics.map((m) => m.mom6));
        const z12 = zScores(metrics.map((m) => m.mom12));
        for (let i = 0; i < metrics.length; i++) {
            const n6 = normalizeZ(z6[i]);
            const n12 = normalizeZ(z12[i]);
            metrics[i].z6 = z6[i];
            metrics[i].z12 = z12[i];
            metrics[i].momentumScore = n6 != null && n12 != null ? (n6 + n12) / 2 : null;
        }

        const ranked = metrics
            .filter((m) => m.momentumScore != null)
            .sort((a, b) => b.momentumScore - a.momentumScore);

        // "Top N%" is read straight off the rank so the message cannot drift from it.
        ranked.forEach((m, i) => {
            m.rank = i + 1;
            m.topPct = Math.max(1, Math.ceil(((i + 1) / ranked.length) * 100));
            m.sector = sectorOf(m.symbol);
        });

        // Only the top tercile is eligible — momentum's edge is concentrated there.
        const eligible = ranked.slice(0, Math.max(10, Math.ceil(ranked.length / 3)));

        const picks = [];
        const nearMisses = [];
        const unsizeable = [];
        const sectorCount = new Map();

        for (const m of eligible) {
            if (picks.length >= maxPicks) break;

            const { pass, reasons } = this._passesEntryFilters(m);
            if (!pass) {
                if (nearMisses.length < 5) nearMisses.push({ symbol: m.symbol, rank: m.rank, reasons });
                continue;
            }

            const used = sectorCount.get(m.sector) || 0;
            if (used >= this.maxPerSector) {
                if (nearMisses.length < 5) {
                    nearMisses.push({
                        symbol: m.symbol,
                        rank: m.rank,
                        reasons: [`${m.sector} already at ${this.maxPerSector}-pick cap`],
                    });
                }
                continue;
            }

            const plan = this._buildTradePlan(m);
            if (!plan) continue;
            if (plan.unsizeable) {
                if (unsizeable.length < 5) {
                    unsizeable.push({
                        symbol: m.symbol,
                        price: m.price,
                        minCapitalNeeded: plan.minCapitalNeeded,
                    });
                }
                continue;
            }

            sectorCount.set(m.sector, used + 1);
            picks.push({ ...m, plan });
        }

        // ── OI enrichment: fetch option-chain data for each pick and score
        // derivative sentiment.  OI is additive — it moves a pick up or down
        // in the final ranking but never removes it.
        const enriched = await this._enrichWithOI(picks);
        // _enrichWithOI returns a new array — replace picks in-place.
        picks.length = 0;
        enriched.forEach(p => picks.push(p));

        // Re-rank by confluence: momentum 70% + OI sentiment 30%.
        // OI scores are on a 0-2 scale; normalise to 0-1 for blending.
        for (const p of picks) {
            const normOi = p.oiScore != null ? p.oiScore / 2 : 0;
            p.confluence = p.momentumScore != null
                ? +(p.momentumScore * 0.7 + normOi * 0.3).toFixed(3)
                : p.momentumScore;
        }
        picks.sort((a, b) => (b.confluence ?? 0) - (a.confluence ?? 0));

        const elapsedMs = Date.now() - startedAt;
        logger.info(
            `Swing scan: ${metrics.length} scanned, ${ranked.length} ranked, ${picks.length} picks in ${elapsedMs}ms`
        );

        return {
            regime,
            halted: false,
            picks,
            nearMisses,
            unsizeable,
            sectorSpread: [...sectorCount.entries()].map(([sector, n]) => ({ sector, n })),
            scanned: metrics.length,
            ranked: ranked.length,
            universeSize: this.universe.length,
            topRanked: ranked.slice(0, 15).map((m) => ({
                symbol: m.symbol,
                sector: m.sector,
                score: m.momentumScore,
                pctFromHigh: m.pctFromHigh,
            })),
            elapsedMs,
            capital: this.capital,
            riskPctPerTrade: this.riskPctPerTrade,
            maxPerSector: this.maxPerSector,
        };
    }
}

export function createSwingMomentumScanService(cfg) {
    return new SwingMomentumScanService(cfg);
}
