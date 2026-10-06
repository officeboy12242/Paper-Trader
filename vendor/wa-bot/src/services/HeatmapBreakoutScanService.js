/**
 * NSE Heatmap + 15m Opening-Range breakout + 8 EMA
 * (TradeMoves-style intraday selection — educational implementation).
 */

import { logger } from '../utils/logger.js';
import { nseMarketDataService } from './NseMarketDataService.js';
import { marketScanService } from './MarketScanService.js';
import { NSE_SECTOR_STOCKS } from '../data/nseSectorStocks.js';
import { computeEma, emaSlope } from '../utils/ema.js';
import {
    fetchYahooIntradayCandles,
    findOpeningRangeCandle,
} from '../utils/yahooIntradayCandles.js';

const CONCURRENCY = 4;
const MIN_MOVE_PCT = 2;
const EMA_PERIOD = 8;
const BODY_RATIO_MIN = 0.55;
const VOL_SPIKE_MULT = 1.4;

function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function bodyRatio(c) {
    const range = c.high - c.low;
    if (range <= 0) return 0;
    return Math.abs(c.close - c.open) / range;
}

function isSolidGreen(c) {
    return c.close > c.open && bodyRatio(c) >= BODY_RATIO_MIN;
}

function isSolidRed(c) {
    return c.close < c.open && bodyRatio(c) >= BODY_RATIO_MIN;
}

function avgVolume(candles, endIdx, lookback = 8) {
    const start = Math.max(0, endIdx - lookback);
    const slice = candles.slice(start, endIdx).filter((c) => c.volume > 0);
    if (!slice.length) return null;
    return slice.reduce((s, c) => s + c.volume, 0) / slice.length;
}

/**
 * Heatmap sentiment from sector index colors (green/red majority).
 */
export function computeHeatmapSentiment(sectorRows = []) {
    let green = 0;
    let red = 0;
    for (const s of sectorRows) {
        const pct = Number(s.indexPct);
        if (!Number.isFinite(pct)) continue;
        if (pct > 0.05) green += 1;
        else if (pct < -0.05) red += 1;
    }
    let bias = 'NEUTRAL';
    if (green > red) bias = 'BULLISH';
    else if (red > green) bias = 'BEARISH';
    return { green, red, bias, label: bias === 'BULLISH' ? '🟢 GREEN' : bias === 'BEARISH' ? '🔴 RED' : '⚪ MIXED' };
}

/**
 * Pick stocks from strongest sectors matching heatmap bias, |%| ≥ minMovePct.
 */
export function pickHeatmapCandidates(hotSectors, sentiment, { minMovePct = MIN_MOVE_PCT, topSectors = 3, maxCandidates = 14 } = {}) {
    const all = hotSectors?.all || [];
    const bias = sentiment?.bias || 'NEUTRAL';

    let rankedSectors;
    if (bias === 'BEARISH') {
        rankedSectors = [...all]
            .filter((s) => Number.isFinite(s.indexPct))
            .sort((a, b) => a.indexPct - b.indexPct);
    } else {
        // Bullish or neutral → strongest green sectors
        rankedSectors = [...all]
            .filter((s) => Number.isFinite(s.indexPct) && s.indexPct > 0)
            .sort((a, b) => b.indexPct - a.indexPct);
        if (!rankedSectors.length) {
            rankedSectors = [...all]
                .filter((s) => Number.isFinite(s.indexPct))
                .sort((a, b) => Math.abs(b.indexPct) - Math.abs(a.indexPct));
        }
    }

    const sectors = rankedSectors.slice(0, topSectors);
    // Bearish: also include extra cold sectors (strongest red momentum)
    if (bias === 'BEARISH') {
        for (const sec of rankedSectors.slice(topSectors, topSectors + 2)) {
            if (!sectors.find((s) => s.key === sec.key)) sectors.push(sec);
        }
    }

    const out = [];
    const seen = new Set();

    for (const sec of sectors) {
        const wantLong = bias !== 'BEARISH';
        const pool = wantLong
            ? [...(sec.gainers || [])]
            : [...(sec.losers || [])];

        // Fallback static list when API movers thin
        if (pool.length < 2) {
            for (const sym of NSE_SECTOR_STOCKS[sec.key] || []) {
                pool.push({ symbol: sym, changePct: sec.indexPct, last: null });
            }
        }

        for (const row of pool) {
            const sym = String(row.symbol || '').trim().toUpperCase();
            if (!sym || seen.has(sym)) continue;
            const chg = Number(row.changePct);
            if (!Number.isFinite(chg)) continue;
            if (Math.abs(chg) < minMovePct) continue;
            if (wantLong && chg < minMovePct) continue;
            if (!wantLong && chg > -minMovePct) continue;

            seen.add(sym);
            out.push({
                symbol: sym,
                sector: sec.label,
                sectorPct: sec.indexPct,
                changePct: chg,
                side: wantLong ? 'long' : 'short',
                last: row.last ?? null,
            });
        }
    }

    return out
        .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
        .slice(0, maxCandidates);
}

/**
 * Evaluate 15m OR breakout + 8 EMA confirmations on candle series.
 * @returns {object|null} setup or null if only watchlist-worthy
 */
export function evaluateOrEmaSetup(candles, { side = 'long', emaPeriod = EMA_PERIOD } = {}) {
    if (!candles?.length || candles.length < emaPeriod + 2) {
        return { status: 'watch', reason: 'insufficient 15m candles', score: 20 };
    }

    const or = findOpeningRangeCandle(candles);
    if (!or) return { status: 'watch', reason: 'no opening-range candle', score: 15 };

    const orIdx = candles.indexOf(or);
    const closes = candles.map((c) => c.close);
    const emas = computeEma(closes, emaPeriod);

    let best = null;

    for (let i = orIdx + 1; i < candles.length; i++) {
        const c = candles[i];
        const ema = emas[i];
        const slope = emaSlope(emas, i);
        if (!Number.isFinite(ema)) continue;

        const checks = {
            solidBody: false,
            aboveOrBelowOr: false,
            emaAlign: false,
            emaSlope: false,
            volumeSpike: false,
            consolidation: false,
            followThrough: false,
        };

        let direction = null;

        if (side === 'long' || side === 'either') {
            const longOk =
                c.close > or.high &&
                isSolidGreen(c) &&
                c.close > ema &&
                (slope == null || slope >= 0);
            if (longOk) {
                direction = 'long';
                checks.solidBody = isSolidGreen(c);
                checks.aboveOrBelowOr = c.close > or.high;
                checks.emaAlign = c.close > ema;
                checks.emaSlope = slope == null || slope >= 0;
            }
        }
        if (!direction && (side === 'short' || side === 'either')) {
            const shortOk =
                c.close < or.low &&
                isSolidRed(c) &&
                c.close < ema &&
                (slope == null || slope <= 0);
            if (shortOk) {
                direction = 'short';
                checks.solidBody = isSolidRed(c);
                checks.aboveOrBelowOr = c.close < or.low;
                checks.emaAlign = c.close < ema;
                checks.emaSlope = slope == null || slope <= 0;
            }
        }
        if (!direction) continue;

        const avgVol = avgVolume(candles, i, 8);
        checks.volumeSpike =
            avgVol != null && c.volume > 0 ? c.volume >= avgVol * VOL_SPIKE_MULT : false;

        // Prior 2–3 candles consolidating near OR level
        if (i >= 2) {
            const prior = candles.slice(Math.max(orIdx + 1, i - 3), i);
            if (direction === 'long') {
                checks.consolidation = prior.length >= 2 && prior.every((p) => p.high <= or.high * 1.004);
            } else {
                checks.consolidation = prior.length >= 2 && prior.every((p) => p.low >= or.low * 0.996);
            }
        }

        // Follow-through: next candle breaches breakout extreme
        if (i + 1 < candles.length) {
            const next = candles[i + 1];
            checks.followThrough =
                direction === 'long' ? next.high > c.high : next.low < c.low;
        }

        const entry =
            direction === 'long'
                ? checks.followThrough && candles[i + 1]
                    ? candles[i + 1].high
                    : c.high
                : checks.followThrough && candles[i + 1]
                  ? candles[i + 1].low
                  : c.low;
        const stop = direction === 'long' ? Math.min(c.low, ema) : Math.max(c.high, ema);
        const risk = Math.abs(entry - stop);
        const t1 = direction === 'long' ? entry + risk * 1.5 : entry - risk * 1.5;
        const t2 = direction === 'long' ? entry + risk * 2 : entry - risk * 2;

        let score = 40;
        if (checks.solidBody) score += 12;
        if (checks.aboveOrBelowOr) score += 12;
        if (checks.emaAlign) score += 10;
        if (checks.emaSlope) score += 8;
        if (checks.volumeSpike) score += 10;
        if (checks.consolidation) score += 8;
        if (checks.followThrough) score += 10;
        score = Math.min(100, score);

        const setup = {
            status: checks.followThrough ? 'triggered' : 'breakout',
            direction,
            score,
            checks,
            orHigh: or.high,
            orLow: or.low,
            breakoutHigh: c.high,
            breakoutLow: c.low,
            breakoutClose: c.close,
            ema8: Number(ema.toFixed(2)),
            entry: Number(entry.toFixed(2)),
            stop: Number(stop.toFixed(2)),
            target15: Number(t1.toFixed(2)),
            target20: Number(t2.toFixed(2)),
            candleTs: c.ts,
        };

        if (!best || setup.score > best.score) best = setup;
    }

    if (best) return best;

    // Near OR — watch for break
    const last = candles[candles.length - 1];
    const lastEma = emas[emas.length - 1];
    return {
        status: 'watch',
        direction: side === 'short' ? 'short' : 'long',
        score: 28,
        reason: 'awaiting OR break + 8 EMA confirm',
        orHigh: or.high,
        orLow: or.low,
        lastClose: last?.close,
        ema8: Number.isFinite(lastEma) ? Number(lastEma.toFixed(2)) : null,
        checks: null,
    };
}

class HeatmapBreakoutScanService {
    /**
     * Full heatmap → ±2% filter → 15m OR + 8 EMA scan.
     */
    async scan({
        minMovePct = MIN_MOVE_PCT,
        emaPeriod = EMA_PERIOD,
        topSectors = 3,
        maxCandidates = 14,
        maxSymbols = 8,
    } = {}) {
        const [macro, hotSectors] = await Promise.all([
            nseMarketDataService.fetchMacroSnapshot(),
            nseMarketDataService.fetchHotSectors({ topSectors: 8, stocksPerSector: 6 }),
        ]);

        const sentiment = computeHeatmapSentiment(hotSectors.all || []);
        // Prefer heatmap sector majority; fall back to macro bias if mixed
        if (sentiment.bias === 'NEUTRAL' && macro?.bias?.label === 'BULLISH') {
            sentiment.bias = 'BULLISH';
            sentiment.label = '🟢 GREEN (macro)';
        } else if (sentiment.bias === 'NEUTRAL' && macro?.bias?.label === 'BEARISH') {
            sentiment.bias = 'BEARISH';
            sentiment.label = '🔴 RED (macro)';
        }

        let candidates = pickHeatmapCandidates(hotSectors, sentiment, {
            minMovePct,
            topSectors,
            maxCandidates,
        });

        // If sector movers thin (pre-open / API gaps), pad from liquid F&O movers in bias direction
        if (candidates.length < 5) {
            try {
                const snap = await marketScanService.buildDiscoverySnapshot();
                const rows = snap.universeRows || [];
                const wantLong = sentiment.bias !== 'BEARISH';
                const seen = new Set(candidates.map((c) => c.symbol));
                const extras = rows
                    .filter((r) => {
                        const chg = Number(r.changePct);
                        if (!Number.isFinite(chg) || seen.has(r.symbol)) return false;
                        return wantLong ? chg >= minMovePct : chg <= -minMovePct;
                    })
                    .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
                    .slice(0, maxCandidates - candidates.length)
                    .map((r) => ({
                        symbol: r.symbol,
                        sector: 'F&O movers',
                        sectorPct: null,
                        changePct: r.changePct,
                        side: wantLong ? 'long' : 'short',
                        last: r.price ?? null,
                    }));
                candidates = [...candidates, ...extras].slice(0, maxCandidates);
            } catch (err) {
                logger.debug(`Heatmap F&O pad skipped: ${err.message}`);
            }
        }

        logger.info(
            `🔥 Heatmap: ${sentiment.label} (G${sentiment.green}/R${sentiment.red}) · ` +
                `${candidates.length} candidates ±${minMovePct}%`
        );

        const evaluated = [];
        for (let i = 0; i < candidates.length; i += CONCURRENCY) {
            const batch = candidates.slice(i, i + CONCURRENCY);
            const rows = await Promise.all(
                batch.map(async (cand) => {
                    try {
                        const candles = await fetchYahooIntradayCandles(`${cand.symbol}.NS`, {
                            interval: '15m',
                            range: '1d',
                        });
                        const setup = evaluateOrEmaSetup(candles, {
                            side: cand.side,
                            emaPeriod,
                        });
                        return { ...cand, setup, candleCount: candles.length };
                    } catch (err) {
                        logger.debug(`Heatmap candle skip ${cand.symbol}: ${err.message}`);
                        return {
                            ...cand,
                            setup: { status: 'watch', score: 18, reason: 'no 15m data' },
                            candleCount: 0,
                        };
                    }
                })
            );
            evaluated.push(...rows);
            if (i + CONCURRENCY < candidates.length) await delay(120);
        }

        const ranked = [...evaluated].sort((a, b) => {
            const sa = a.setup?.score || 0;
            const sb = b.setup?.score || 0;
            if (sb !== sa) return sb - sa;
            return Math.abs(b.changePct) - Math.abs(a.changePct);
        });

        const picked = ranked.slice(0, maxSymbols);
        const symbols = picked.map((p) => p.symbol);

        const setups = picked.filter(
            (p) => p.setup?.status === 'triggered' || p.setup?.status === 'breakout'
        );

        return {
            sentiment,
            macro,
            hotSectors,
            candidates: evaluated,
            picks: picked,
            setups,
            symbols,
            minMovePct,
            emaPeriod,
            scannedAt: new Date(),
        };
    }

    formatBlock(scan) {
        if (!scan) return '';
        const lines = ['=== NSE HEATMAP + 15m OR / 8 EMA ==='];
        lines.push(`Heatmap: ${scan.sentiment?.label || 'n/a'} (sectors G${scan.sentiment?.green ?? '?'} / R${scan.sentiment?.red ?? '?'})`);
        lines.push(`Filter: |Δ| ≥ ${scan.minMovePct}% in top momentum sectors · EMA ${scan.emaPeriod}`);
        for (const p of scan.picks || []) {
            const s = p.setup || {};
            const chg = p.changePct != null ? `${p.changePct >= 0 ? '+' : ''}${p.changePct}%` : '';
            const dir = s.direction || p.side || '';
            const st = s.status || 'watch';
            let detail = `${p.symbol} ${chg} [${p.sector}] ${dir} · ${st} score ${s.score ?? 0}`;
            if (s.orHigh != null) detail += ` · OR ${s.orLow?.toFixed?.(2) ?? s.orLow}-${s.orHigh?.toFixed?.(2) ?? s.orHigh}`;
            if (s.entry != null) detail += ` · entry ${s.entry} SL ${s.stop} T1 ${s.target15}`;
            lines.push(detail);
        }
        return lines.join('\n');
    }
}

export const heatmapBreakoutScanService = new HeatmapBreakoutScanService();
export default HeatmapBreakoutScanService;
