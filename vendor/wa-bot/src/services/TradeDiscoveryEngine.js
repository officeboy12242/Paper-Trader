/**
 * Enhanced trade discovery — combines IMT scanning + copilot gates.
 */

import { logger } from '../utils/logger.js';
import { marketScanService, FNO_UNIVERSE } from './MarketScanService.js';
import { nseMarketDataService } from './NseMarketDataService.js';
import { smartMoneyScanService } from './SmartMoneyScanService.js';
import { catalystRadarService } from './CatalystRadarService.js';
import { stockNewsService } from './StockNewsService.js';
import { scoreConfluence, getMinConfluenceScore, adjustConfidenceFloor } from '../utils/tradeConfluenceScore.js';
import { getIndiaMarketMode, checkQuoteFreshness } from '../utils/indianMarketCalendar.js';
import { createMarketDeltaService } from './MarketDeltaService.js';
import { createTradeOutcomeService } from './TradeOutcomeService.js';
import { heatmapBreakoutScanService } from './HeatmapBreakoutScanService.js';
import { heatmapV2ScanService } from './HeatmapV2ScanService.js';
import { preOpenScanService } from './PreOpenScanService.js';
import { turnoverBandScanService } from './TurnoverBandScanService.js';
import { normalizeDiscoverySource } from '../utils/discoverySource.js';

const MOMENTUM_RS_MIN = 1.5;
const MOMENTUM_TURNOVER_MIN_CR = 500;

function estimateTurnoverCr(price, volume) {
    const p = Number(price);
    const v = Number(volume);
    if (!Number.isFinite(p) || !Number.isFinite(v)) return null;
    return Number(((p * v) / 1e7).toFixed(0));
}

function buildPhase4Picks(hotSectors, universeRows, macro, limit = 5) {
    const niftyPct = Number(macro?.nifty?.pct) || 0;
    const picks = [];
    const seen = new Set();

    for (const sec of hotSectors?.hot || []) {
        for (const stock of sec.gainers || []) {
            const sym = stock.symbol;
            if (!sym || seen.has(sym)) continue;
            seen.add(sym);

            let score = 50;
            if (sec.indexPct != null && sec.indexPct > 0) score += 15;
            const chg = Number(stock.changePct) || 0;
            const rs = chg - niftyPct;
            if (rs >= MOMENTUM_RS_MIN) score += 20;
            if (macro?.bias?.label === 'BULLISH') score += 10;

            picks.push({
                symbol: sym,
                sector: sec.label,
                score: Math.min(100, score),
                changePct: stock.changePct,
                reason: `hot ${sec.label} + momentum`,
            });
        }
    }

    for (const row of universeRows || []) {
        const sym = row.symbol;
        if (!sym || seen.has(sym)) continue;
        const chg = Number(row.changePct);
        if (!Number.isFinite(chg)) continue;
        const rs = chg - niftyPct;
        if (rs < MOMENTUM_RS_MIN) continue;
        const turnover = estimateTurnoverCr(row.price, row.volume);
        if (turnover != null && turnover < MOMENTUM_TURNOVER_MIN_CR) continue;

        seen.add(sym);
        picks.push({
            symbol: sym,
            sector: null,
            score: 45 + Math.min(30, rs * 8),
            changePct: chg,
            reason: 'momentum RS + volume',
        });
    }

    return picks.sort((a, b) => b.score - a.score).slice(0, limit);
}

function buildMomentumAlerts(universeRows, niftyPct) {
    const out = [];
    for (const row of universeRows || []) {
        const chg = Number(row.changePct);
        if (!Number.isFinite(chg) || chg <= 0) continue;
        const rs = chg - (Number(niftyPct) || 0);
        if (rs < MOMENTUM_RS_MIN) continue;
        const turnoverCr = estimateTurnoverCr(row.price, row.volume);
        if (turnoverCr != null && turnoverCr < MOMENTUM_TURNOVER_MIN_CR) continue;
        out.push({
            symbol: row.symbol,
            changePct: chg,
            rs,
            turnoverCr,
        });
    }
    return out.sort((a, b) => b.rs - a.rs).slice(0, 6);
}

function mergeWatchlist({
    phase4Picks,
    momentumAlerts,
    smartMoneyDeals,
    hiddenGem,
    moversWatchlist,
    targetCount,
}) {
    const ordered = [];
    const seen = new Set();
    const meta = new Map();

    const add = (symbol, source) => {
        const sym = String(symbol || '').trim().toUpperCase();
        if (!sym || seen.has(sym)) {
            if (sym && meta.has(sym)) {
                const m = meta.get(sym);
                if (!m.sources.includes(source)) m.sources.push(source);
            }
            return;
        }
        seen.add(sym);
        ordered.push(sym);
        meta.set(sym, { symbol: sym, sources: [source] });
    };

    if (hiddenGem) add(hiddenGem, 'hidden gem');
    for (const p of phase4Picks || []) add(p.symbol, 'phase4');
    for (const m of momentumAlerts || []) add(m.symbol, 'momentum');
    for (const d of smartMoneyDeals || []) add(d.symbol, 'smart money');
    for (const sym of moversWatchlist || []) add(sym, 'mover');

    return {
        symbols: ordered.slice(0, targetCount),
        symbolMeta: ordered.slice(0, targetCount).map((s) => meta.get(s) || { symbol: s, sources: ['mover'] }),
    };
}

class TradeDiscoveryEngine {
    constructor(config = {}, mongoDb = null) {
        this.config = config;
        this.delta = createMarketDeltaService(mongoDb);
        this.outcomes = createTradeOutcomeService(mongoDb, config);
        this.discoveryCount = config.TRADE_ALERT_DISCOVERY_COUNT || 10;
        this.nseGlEach = config.TRADE_ALERT_NSE_GL_EACH || 5;
        this.heatmapMax = config.TRADE_ALERT_HEATMAP_MAX || 8;
        this.heatmapMinMove = config.TRADE_ALERT_HEATMAP_MIN_MOVE_PCT || 2;
    }

    async run({ forceRefresh = false, source = null } = {}) {
        const discoverySource = normalizeDiscoverySource(
            source ?? this.config.TRADE_ALERT_DISCOVERY_SOURCE
        );
        if (discoverySource === 'heatmap2') {
            return this.runHeatmapV2();
        }
        if (discoverySource === 'heatmap') {
            return this.runHeatmapBreakout();
        }
        if (discoverySource === 'preopen') {
            return this.runPreOpen();
        }
        if (discoverySource === 'turnover') {
            return this.runTurnoverBand();
        }
        if (discoverySource === 'nse') {
            return this.runNseGainersLosers();
        }
        return this.runLegacy({ forceRefresh });
    }

    /**
     * Pre-open auction selection, for a 09:15 post.
     *
     * Shape-compatible with `runHeatmapV2()`. The distinguishing property is that
     * it needs no intraday data at all, so it can run before the bell — which is
     * the whole point. See PreOpenScanService for the validation caveat.
     */
    async runPreOpen() {
        const marketMode = getIndiaMarketMode();
        const scannedAt = new Date();

        const [scan, marketNewsPack, calibration] = await Promise.all([
            preOpenScanService.scan({ maxPicks: this.heatmapMax }),
            stockNewsService.fetchMarketHeadlines(),
            this.outcomes.getCalibration(),
        ]);

        const headlines = String(marketNewsPack?.context || '').split('\n').filter(Boolean);
        const picks = scan?.picks || [];
        const symbols = picks.map((p) => p.symbol);

        if (!picks.length) {
            logger.info('📋 Pre-open discovery: no qualifying names in the auction');
        }

        const universeRows = picks.map((p) => ({
            symbol: p.symbol,
            changePct: Number(p.gapPct.toFixed(2)),
            price: p.iep,
            volume: null,
        }));

        const movers = {
            gainers: picks
                .filter((p) => p.side === 'long')
                .map((p) => ({ symbol: p.symbol, changePct: Number(p.gapPct.toFixed(2)), price: p.iep })),
            losers: picks
                .filter((p) => p.side === 'short')
                .map((p) => ({ symbol: p.symbol, changePct: Number(p.gapPct.toFixed(2)), price: p.iep })),
        };

        const catalystItems = catalystRadarService.scanHeadlines(headlines, new Set(symbols));
        const catalystHighlights = catalystRadarService.formatHighlights(catalystItems);

        const symbolMeta = picks.map((p) => {
            const row = universeRows.find((r) => r.symbol === p.symbol);
            const conf = scoreConfluence({
                symbol: p.symbol,
                quote: row,
                movers,
                macro: null,
                catalystItems,
                smartMoneyDeals: [],
                sectorTag: null,
            });
            return {
                symbol: p.symbol,
                sources: [`preopen ${p.side}`, `score ${p.score}`, `book ${(p.imbalance * 100).toFixed(0)}%`],
                confluence: conf.score,
                confluencePass: conf.passes,
                blocked: conf.blocked,
                setup: p.setup,
                sector: null,
                changePct: Number(p.gapPct.toFixed(2)),
                relStrength: Number(p.relGapPct.toFixed(2)),
            };
        });

        const moversBrief = picks
            .map((p) => `${p.symbol} ${p.gapPct >= 0 ? '+' : ''}${p.gapPct.toFixed(2)}% (${p.side} ${p.score})`)
            .join(', ');

        logger.info(`📡 Pre-open discovery: ${symbols.length} symbols from ${scan?.scanned ?? 0} auction rows`);

        return {
            symbols,
            symbolMeta,
            context: preOpenScanService.formatBlock(scan),
            universeRows,
            movers,
            moversBrief,
            marketNews: headlines.slice(0, 6).join('\n'),
            macro: null,
            hotSectors: { hot: [], cold: [], all: [] },
            phase4Picks: [],
            momentumAlerts: [],
            smartMoney: { deals: [] },
            catalystItems,
            catalystHighlights,
            niftyGl: null,
            heatmap: scan,
            delta: null,
            marketMode: marketMode.mode,
            marketModeLabel: marketMode.label,
            freshness: checkQuoteFreshness(scannedAt),
            gates: {
                minConfluence: calibration.minConfluence || getMinConfluenceScore(this.config),
                minConfidence: calibration.minConfidence || adjustConfidenceFloor(null, 70),
                watchOnly: marketMode.watchOnly,
                allowsLiveEntry: marketMode.allowsLiveEntry,
            },
            scannedAt,
            calibration,
            discoverySource: 'preopen',
        };
    }

    /**
     * Heatmap v2 — live intraday selection with VWAP / RS / ATR filters.
     *
     * Shape-compatible with `runHeatmapBreakout()` so every downstream consumer
     * (confluence scoring, the scan card, the morning pick) works unchanged.
     */
    async runHeatmapV2() {
        const marketMode = getIndiaMarketMode();
        const scannedAt = new Date();

        const [scan, marketNewsPack, calibration] = await Promise.all([
            heatmapV2ScanService.scan({ maxSymbols: this.heatmapMax }),
            stockNewsService.fetchMarketHeadlines(),
            this.outcomes.getCalibration(),
        ]);

        const macro = scan.macro;
        const headlines = String(marketNewsPack?.context || '').split('\n').filter(Boolean);
        const symbols = [...(scan.symbols || [])];

        const universeRows = (scan.picks || []).map((p) => ({
            symbol: p.symbol,
            changePct: p.changePct,
            price: p.last,
            volume: null,
        }));

        const movers = {
            gainers: (scan.picks || [])
                .filter((p) => p.side === 'long')
                .map((p) => ({ symbol: p.symbol, changePct: p.changePct, price: p.last })),
            losers: (scan.picks || [])
                .filter((p) => p.side === 'short')
                .map((p) => ({ symbol: p.symbol, changePct: p.changePct, price: p.last })),
        };

        const catalystItems = catalystRadarService.scanHeadlines(headlines, new Set(symbols));
        const catalystHighlights = catalystRadarService.formatHighlights(catalystItems);

        const symbolMeta = (scan.picks || []).map((p) => {
            const row = universeRows.find((r) => r.symbol === p.symbol);
            const conf = scoreConfluence({
                symbol: p.symbol,
                quote: row,
                movers,
                macro,
                catalystItems,
                smartMoneyDeals: [],
                sectorTag: p.sector,
            });
            return {
                symbol: p.symbol,
                sources: p.setup
                    ? [`heatmap2 ${p.setup.direction}`, `score ${p.setup.score}`]
                    : [`heatmap2 ${p.side}`, 'pre-breakout watch'],
                confluence: conf.score,
                confluencePass: conf.passes,
                blocked: conf.blocked,
                setup: p.setup,
                sector: p.sector,
                changePct: p.changePct,
                relStrength: p.relStrength,
            };
        });

        const moversBrief = (scan.picks || [])
            .map(
                (p) =>
                    `${p.symbol} ${p.changePct >= 0 ? '+' : ''}${p.changePct}% ` +
                    `(${p.side}${p.setup ? ` ${p.setup.score}` : ' watch'})`
            )
            .join(', ');

        const context = [
            nseMarketDataService.formatMacroBlock(macro),
            heatmapV2ScanService.formatBlock(scan),
            scan.preOpeningRange
                ? 'Strategy rules: the opening range has not closed, so these are ' +
                  'direction-confirmed watches, not entries. They are already filtered for ' +
                  'live move, sector agreement and relative strength vs NIFTY. Trade only ' +
                  'in the listed direction, and only after the 15m opening range breaks.'
                : 'Strategy rules: every level below is already filtered for VWAP side, ' +
                  'relative strength vs NIFTY and an ATR-bounded stop. Trade only in the ' +
                  'listed direction. Entry is a stop order beyond the breakout bar; SL and ' +
                  'targets are given — do not widen them.',
        ]
            .filter(Boolean)
            .join('\n\n');

        logger.info(
            `📡 Heatmap v2 discovery: ${symbols.length} symbols from ${scan.candidatesScanned} scanned · ` +
                `${scan.sentiment?.label} · ${scan.regime?.label}`
        );

        return {
            symbols,
            symbolMeta,
            context,
            universeRows,
            movers,
            moversBrief,
            marketNews: headlines.slice(0, 6).join('\n'),
            macro,
            hotSectors: { hot: scan.longSectors, cold: scan.shortSectors, all: scan.sectors },
            phase4Picks: [],
            momentumAlerts: [],
            smartMoney: { deals: [] },
            catalystItems,
            catalystHighlights,
            niftyGl: null,
            heatmap: scan,
            delta: null,
            marketMode: marketMode.mode,
            marketModeLabel: marketMode.label,
            freshness: checkQuoteFreshness(scannedAt),
            gates: {
                minConfluence: calibration.minConfluence || getMinConfluenceScore(this.config),
                minConfidence: calibration.minConfidence || adjustConfidenceFloor(macro, 70),
                watchOnly: marketMode.watchOnly,
                allowsLiveEntry: marketMode.allowsLiveEntry,
            },
            scannedAt,
            calibration,
            discoverySource: 'heatmap2',
        };
    }

    /**
     * Turnover-band selection for a next-day intraday post.
     *
     * Shape-compatible with `runHeatmapV2()`. Needs no intraday data, so it can
     * run pre-market. See TurnoverBandScanService for why the band sits BELOW the
     * top of the turnover list, and for how thin the supporting sample is.
     */
    async runTurnoverBand() {
        const marketMode = getIndiaMarketMode();
        const scannedAt = new Date();

        const [scan, marketNewsPack, calibration] = await Promise.all([
            turnoverBandScanService.scan({
                maxPicks: this.heatmapMax,
                bandFrom: this.config.TURNOVER_BAND_FROM,
                bandTo: this.config.TURNOVER_BAND_TO,
            }),
            stockNewsService.fetchMarketHeadlines(),
            this.outcomes.getCalibration(),
        ]);

        const headlines = String(marketNewsPack?.context || '').split('\n').filter(Boolean);
        const picks = scan?.picks || [];
        const symbols = picks.map((p) => p.symbol);

        if (!picks.length) logger.info('📊 Turnover-band discovery: no qualifying names');

        const universeRows = picks.map((p) => ({
            symbol: p.symbol,
            changePct: p.changePct,
            price: p.close,
            volume: null,
        }));
        const movers = {
            gainers: picks.filter((p) => p.side === 'long').map((p) => ({ symbol: p.symbol, changePct: p.changePct, price: p.close })),
            losers: picks.filter((p) => p.side === 'short').map((p) => ({ symbol: p.symbol, changePct: p.changePct, price: p.close })),
        };

        const catalystItems = catalystRadarService.scanHeadlines(headlines, new Set(symbols));
        const catalystHighlights = catalystRadarService.formatHighlights(catalystItems);

        const symbolMeta = picks.map((p) => {
            const row = universeRows.find((r) => r.symbol === p.symbol);
            const conf = scoreConfluence({
                symbol: p.symbol,
                quote: row,
                movers,
                macro: null,
                catalystItems,
                smartMoneyDeals: [],
                sectorTag: null,
            });
            return {
                symbol: p.symbol,
                sources: [`turnover ${p.side}`, `rank #${p.rank}`, `trend ${p.strength} ATR`],
                confluence: conf.score,
                confluencePass: conf.passes,
                blocked: conf.blocked,
                setup: p.setup,
                sector: null,
                changePct: p.changePct,
                relStrength: null,
            };
        });

        logger.info(`📡 Turnover-band discovery: ${symbols.length} symbols from ranks ${scan?.bandFrom}-${scan?.bandTo}`);

        return {
            symbols,
            symbolMeta,
            context: turnoverBandScanService.formatBlock(scan),
            universeRows,
            movers,
            moversBrief: picks.map((p) => `${p.symbol} #${p.rank} (${p.side} ${p.score})`).join(', '),
            marketNews: headlines.slice(0, 6).join('\n'),
            macro: null,
            hotSectors: { hot: [], cold: [], all: [] },
            phase4Picks: [],
            momentumAlerts: [],
            smartMoney: { deals: [] },
            catalystItems,
            catalystHighlights,
            niftyGl: null,
            heatmap: scan,
            delta: null,
            marketMode: marketMode.mode,
            marketModeLabel: marketMode.label,
            freshness: checkQuoteFreshness(scannedAt),
            gates: {
                minConfluence: calibration.minConfluence || getMinConfluenceScore(this.config),
                minConfidence: calibration.minConfidence || adjustConfidenceFloor(null, 70),
                watchOnly: marketMode.watchOnly,
                allowsLiveEntry: marketMode.allowsLiveEntry,
            },
            scannedAt,
            calibration,
            discoverySource: 'turnover',
        };
    }

    /**
     * NSE Heatmap sector momentum (±2%) + 15m opening-range breakout + 8 EMA.
     * Replaces blind top-gainer/loser lists with setup-qualified names.
     */
    async runHeatmapBreakout() {
        const marketMode = getIndiaMarketMode();
        const scannedAt = new Date();

        const [scan, marketNewsPack, calibration] = await Promise.all([
            heatmapBreakoutScanService.scan({
                minMovePct: this.heatmapMinMove,
                maxSymbols: this.heatmapMax,
                topSectors: 3,
                maxCandidates: 14,
            }),
            stockNewsService.fetchMarketHeadlines(),
            this.outcomes.getCalibration(),
        ]);

        const macro = scan.macro;
        const headlines = String(marketNewsPack?.context || '')
            .split('\n')
            .filter(Boolean);

        const symbols = [...(scan.symbols || [])];
        const universeRows = (scan.picks || []).map((p) => ({
            symbol: p.symbol,
            changePct: p.changePct,
            price: p.last ?? p.setup?.breakoutClose ?? p.setup?.lastClose,
            volume: null,
        }));

        const movers = {
            gainers: (scan.picks || [])
                .filter((p) => (p.changePct || 0) > 0)
                .map((p) => ({ symbol: p.symbol, changePct: p.changePct, price: p.last })),
            losers: (scan.picks || [])
                .filter((p) => (p.changePct || 0) < 0)
                .map((p) => ({ symbol: p.symbol, changePct: p.changePct, price: p.last })),
        };

        const catalystItems = catalystRadarService.scanHeadlines(headlines, new Set(symbols));
        const catalystHighlights = catalystRadarService.formatHighlights(catalystItems);

        const symbolMeta = (scan.picks || []).map((p) => {
            const row = universeRows.find((r) => r.symbol === p.symbol);
            const conf = scoreConfluence({
                symbol: p.symbol,
                quote: row,
                movers,
                macro,
                catalystItems,
                smartMoneyDeals: [],
                sectorTag: p.sector,
            });
            const st = p.setup?.status || 'watch';
            return {
                symbol: p.symbol,
                sources: [`heatmap ${st}`, p.side || p.setup?.direction || ''].filter(Boolean),
                confluence: conf.score,
                confluencePass: conf.passes,
                blocked: conf.blocked,
                setup: p.setup,
                sector: p.sector,
                changePct: p.changePct,
            };
        });

        const moversBrief = (scan.picks || [])
            .map((p) => {
                const st = p.setup?.status || 'watch';
                const chg = p.changePct != null ? `${p.changePct >= 0 ? '+' : ''}${p.changePct}%` : '';
                return `${p.symbol}${chg ? ` ${chg}` : ''} (${st})`;
            })
            .join(', ');

        const freshness = checkQuoteFreshness(scannedAt);
        const minConfluence = calibration.minConfluence || getMinConfluenceScore(this.config);
        const minConfidence = calibration.minConfidence || adjustConfidenceFloor(macro, 70);

        const context = [
            nseMarketDataService.formatMacroBlock(macro),
            heatmapBreakoutScanService.formatBlock(scan),
            'Strategy rules: trade WITH heatmap bias only. Longs need OR high break + solid green close above 8 EMA; shorts need OR low break + solid red close below 8 EMA. Prefer volume spike + follow-through. SL beyond breakout candle / 8 EMA; target ≥1:1.5 R:R.',
        ]
            .filter(Boolean)
            .join('\n\n');

        logger.info(
            `📡 Heatmap OR/EMA discovery: ${symbols.length} symbols · ${scan.sentiment?.label} · ` +
                `${(scan.setups || []).length} active setups`
        );

        return {
            symbols,
            symbolMeta,
            context,
            universeRows,
            movers,
            moversBrief,
            marketNews: headlines.slice(0, 6).join('\n'),
            macro,
            hotSectors: scan.hotSectors,
            phase4Picks: [],
            momentumAlerts: [],
            smartMoney: { deals: [] },
            catalystItems,
            catalystHighlights,
            niftyGl: null,
            heatmap: scan,
            delta: null,
            marketMode: marketMode.mode,
            marketModeLabel: marketMode.label,
            freshness,
            gates: {
                minConfluence,
                minConfidence,
                watchOnly: marketMode.watchOnly,
                allowsLiveEntry: marketMode.allowsLiveEntry,
            },
            scannedAt,
            calibration,
            discoverySource: 'heatmap',
        };
    }

    /** NIFTY 50 top N gainers + top N losers → analyze those only. */
    async runNseGainersLosers() {
        const marketMode = getIndiaMarketMode();
        const scannedAt = new Date();
        const each = this.nseGlEach;

        const [niftyGl, macro, marketNewsPack, calibration] = await Promise.all([
            nseMarketDataService.fetchNiftyTopGainersLosers({ each }),
            nseMarketDataService.fetchMacroSnapshot(),
            stockNewsService.fetchMarketHeadlines(),
            this.outcomes.getCalibration(),
        ]);

        const headlines = String(marketNewsPack?.context || '')
            .split('\n')
            .filter(Boolean);

        const seen = new Set();
        const symbols = [];
        const symbolMeta = [];
        const universeRows = [];

        const pushSide = (rows, side) => {
            for (const row of rows || []) {
                const sym = row.symbol;
                if (!sym || seen.has(sym)) continue;
                seen.add(sym);
                symbols.push(sym);
                symbolMeta.push({ symbol: sym, sources: [`nse ${side}`] });
                universeRows.push({
                    symbol: sym,
                    changePct: row.changePct,
                    price: row.last,
                    volume: row.volume,
                });
            }
        };
        pushSide(niftyGl.gainers, 'gainer');
        pushSide(niftyGl.losers, 'loser');

        const movers = {
            gainers: (niftyGl.gainers || []).map((r) => ({
                symbol: r.symbol,
                changePct: r.changePct,
                price: r.last,
            })),
            losers: (niftyGl.losers || []).map((r) => ({
                symbol: r.symbol,
                changePct: r.changePct,
                price: r.last,
            })),
        };

        const catalystItems = catalystRadarService.scanHeadlines(headlines, new Set(symbols));
        const catalystHighlights = catalystRadarService.formatHighlights(catalystItems);

        const enrichedMeta = symbols.map((sym) => {
            const base = symbolMeta.find((m) => m.symbol === sym) || { symbol: sym, sources: ['nse'] };
            const row = universeRows.find((r) => r.symbol === sym);
            const conf = scoreConfluence({
                symbol: sym,
                quote: row,
                movers,
                macro,
                catalystItems,
                smartMoneyDeals: [],
                sectorTag: null,
            });
            return {
                ...base,
                confluence: conf.score,
                confluencePass: conf.passes,
                blocked: conf.blocked,
            };
        });

        const moversBrief = [
            movers.gainers.length
                ? `G: ${movers.gainers.map((x) => `${x.symbol}${x.changePct != null ? ` +${x.changePct}%` : ''}`).join(', ')}`
                : '',
            movers.losers.length
                ? `L: ${movers.losers.map((x) => `${x.symbol}${x.changePct != null ? ` ${x.changePct}%` : ''}`).join(', ')}`
                : '',
        ]
            .filter(Boolean)
            .join(' · ');

        const freshness = checkQuoteFreshness(scannedAt);
        const minConfluence = calibration.minConfluence || getMinConfluenceScore(this.config);
        const minConfidence = calibration.minConfidence || adjustConfidenceFloor(macro, 70);

        const context = [
            nseMarketDataService.formatMacroBlock(macro),
            nseMarketDataService.formatNiftyGlBlock(niftyGl),
        ]
            .filter(Boolean)
            .join('\n\n');

        logger.info(
            `📡 NSE G/L discovery: ${symbols.length} symbols (${each}G+${each}L) · bias ${macro?.bias?.label}`
        );

        return {
            symbols,
            symbolMeta: enrichedMeta,
            context,
            universeRows,
            movers,
            moversBrief,
            marketNews: headlines.slice(0, 6).join('\n'),
            macro,
            hotSectors: { hot: [], cold: [] },
            phase4Picks: [],
            momentumAlerts: [],
            smartMoney: { deals: [] },
            catalystItems,
            catalystHighlights,
            niftyGl,
            delta: null,
            marketMode: marketMode.mode,
            marketModeLabel: marketMode.label,
            freshness,
            gates: {
                minConfluence,
                minConfidence,
                watchOnly: marketMode.watchOnly,
                allowsLiveEntry: marketMode.allowsLiveEntry,
            },
            scannedAt,
            calibration,
            discoverySource: 'nse',
        };
    }

    async runLegacy({ forceRefresh = false } = {}) {
        const marketMode = getIndiaMarketMode();
        const scannedAt = new Date();

        const [baseSnapshot, macro, hotSectors, smartMoney, marketNewsPack, calibration] = await Promise.all([
            marketScanService.buildDiscoverySnapshot(),
            nseMarketDataService.fetchMacroSnapshot(),
            nseMarketDataService.fetchHotSectors({ topSectors: 5, stocksPerSector: 4 }),
            smartMoneyScanService.fetchTodayDeals(),
            stockNewsService.fetchMarketHeadlines(),
            this.outcomes.getCalibration(),
        ]);

        const universeRows = baseSnapshot.universeRows || [];
        const niftyPct = macro?.nifty?.pct;

        const headlines = String(marketNewsPack?.context || baseSnapshot.marketNews || '')
            .split('\n')
            .filter(Boolean);
        const symbolUniverse = new Set([
            ...FNO_UNIVERSE,
            ...universeRows.map((r) => r.symbol),
            ...(hotSectors.hot || []).flatMap((s) => (s.gainers || []).map((g) => g.symbol)),
        ]);
        const catalystItems = catalystRadarService.scanHeadlines(headlines, symbolUniverse);
        const catalystHighlights = catalystRadarService.formatHighlights(catalystItems);

        const phase4Picks = buildPhase4Picks(hotSectors, universeRows, macro, 5);
        const momentumAlerts = buildMomentumAlerts(universeRows, niftyPct);

        const moversWatchlist = marketScanService.buildFreshMoversWatchlist(
            universeRows,
            this.discoveryCount,
            { hiddenGem: null }
        );

        const { symbols, symbolMeta } = mergeWatchlist({
            phase4Picks,
            momentumAlerts,
            smartMoneyDeals: smartMoney.deals,
            hiddenGem: null,
            moversWatchlist,
            targetCount: this.discoveryCount,
        });

        const finalized = marketScanService.finalizeWatchlist(symbols, universeRows, this.discoveryCount);

        const sectorBySymbol = new Map();
        for (const sec of hotSectors.hot || []) {
            for (const g of sec.gainers || []) {
                sectorBySymbol.set(g.symbol, sec.label);
            }
        }

        const enrichedMeta = [];
        for (const sym of finalized) {
            const base = symbolMeta.find((m) => m.symbol === sym) || { symbol: sym, sources: ['mover'] };
            const row = universeRows.find((r) => r.symbol === sym);
            const conf = scoreConfluence({
                symbol: sym,
                quote: row,
                movers: baseSnapshot.movers,
                macro,
                catalystItems,
                smartMoneyDeals: smartMoney.deals,
                sectorTag: sectorBySymbol.get(sym),
            });
            enrichedMeta.push({
                ...base,
                confluence: conf.score,
                confluencePass: conf.passes,
                blocked: conf.blocked,
            });
        }

        const snapshotPayload = { macro, hotSectors, phase4Picks, momentumAlerts };
        const prev = await this.delta.loadLastSnapshot();
        const delta = this.delta.computeDelta(prev, snapshotPayload);
        await this.delta.saveSnapshot(snapshotPayload);

        const freshness = checkQuoteFreshness(scannedAt);
        const minConfluence = calibration.minConfluence || getMinConfluenceScore(this.config);
        const minConfidence = calibration.minConfidence || adjustConfidenceFloor(macro, 70);

        const context = [
            nseMarketDataService.formatMacroBlock(macro),
            nseMarketDataService.formatHotSectorsBlock(hotSectors),
            baseSnapshot.context,
        ].join('\n\n');

        logger.info(
            `📡 Enhanced discovery: ${finalized.length} symbols · bias ${macro?.bias?.label} · ` +
                `hot ${(hotSectors.hot || []).map((s) => s.label).join(',')}`
        );

        return {
            symbols: finalized,
            symbolMeta: enrichedMeta,
            context,
            universeRows,
            movers: baseSnapshot.movers,
            moversBrief: marketScanService.formatMoversBrief(baseSnapshot.movers),
            marketNews: headlines.slice(0, 6).join('\n'),
            macro,
            hotSectors,
            phase4Picks,
            momentumAlerts,
            smartMoney,
            catalystItems,
            catalystHighlights,
            niftyGl: null,
            delta,
            marketMode: marketMode.mode,
            marketModeLabel: marketMode.label,
            freshness,
            gates: {
                minConfluence,
                minConfidence,
                watchOnly: marketMode.watchOnly,
                allowsLiveEntry: marketMode.allowsLiveEntry,
            },
            scannedAt,
            calibration,
            discoverySource: 'legacy',
        };
    }
}

export function createTradeDiscoveryEngine(config, mongoDb) {
    return new TradeDiscoveryEngine(config, mongoDb);
}

export default TradeDiscoveryEngine;
