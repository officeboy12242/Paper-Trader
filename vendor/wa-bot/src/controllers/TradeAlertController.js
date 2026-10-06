/**
 * F&O trade analysis via NVIDIA DeepSeek — AI discovery, live news, filtered alerts.
 */

import { logger } from '../utils/logger.js';
import { formatDateLabelIST, formatNowLabelIST, getTodayDateStrIST } from '../utils/dateIST.js';
import NvidiaDeepSeekService from '../services/NvidiaDeepSeekService.js';
import TradeLlmRouterService, { isTradeLlmRateLimitError } from '../services/TradeLlmRouterService.js';
import { createTradeResearchService } from '../services/TradeResearchService.js';
import { marketScanService } from '../services/MarketScanService.js';
import { createTradeDiscoveryEngine } from '../services/TradeDiscoveryEngine.js';
import { scoreConfluence, getMinConfluenceScore } from '../utils/tradeConfluenceScore.js';
import {
    getIndiaMarketMode,
    checkQuoteFreshness,
} from '../utils/indianMarketCalendar.js';
import { computeEntryState, ENTRY_STATES } from '../utils/tradeEntryState.js';
import {
    formatDailyScanIntro,
    formatAlertMetaFooter,
    withSentStamp,
} from '../utils/tradeScanFormatter.js';
import { parsePremium, parseTargets } from '../utils/tradePlanFormatter.js';
import {
    TRADE_ANALYSIS_SYSTEM_PROMPT,
    buildTradeUserPrompt,
    wrapTradeAlertMessage,
} from '../prompts/tradeAnalysisPrompt.js';
import {
    STOCK_DISCOVERY_SYSTEM_PROMPT,
    buildDiscoveryUserPrompt,
} from '../prompts/stockDiscoveryPrompt.js';
import { parseTradeSignal, parseDiscoveryResult } from '../utils/tradeSignalParser.js';
import { enforceLiveSpotPrice, enforceLiveOptionPremiums } from '../utils/tradeQuoteUtils.js';
import { startMorningPick, formatMorningPickCard } from '../utils/tradeMorningPick.js';
import { injectTradePlans } from '../utils/tradePlanFormatter.js';
import {
    getIndianMarketClosedReason,
    isIndianEquityTradingDay,
} from '../utils/indianMarketCalendar.js';
import { normalizeDiscoverySource, isPrescriptiveSource } from '../utils/discoverySource.js';
import { createTradeOutcomeService } from '../services/TradeOutcomeService.js';

function parseAlertTime(timeStr) {
    const [h, m = '0'] = String(timeStr || '09:20').trim().split(':');
    return { hour: Number(h), minute: Number(m) };
}

class TradeAlertController {
    constructor(groupManager, config = {}, mongoDb = null) {
        this.groupManager = groupManager;
        this.config = config;
        this.mongoDb = mongoDb;
        this.nvidia = new NvidiaDeepSeekService(config);
        this.tradeLlm = new TradeLlmRouterService(config);
        this.research = createTradeResearchService(config);
        this.twoStepResearch = config.TRADE_TWO_STEP_RESEARCH !== false;
        this.enabled = config.TRADE_ALERT_ENABLED !== false;
        const { hour, minute } = parseAlertTime(config.TRADE_ALERT_TIME);
        this.alertHour = hour;
        this.alertMinute = minute;
        this.defaultSymbols = config.TRADE_ALERT_STOCKS || [];
        this.defaultMode = config.TRADE_ALERT_MODE || 'auto';
        this.defaultDiscoverySource = normalizeDiscoverySource(config.TRADE_ALERT_DISCOVERY_SOURCE);
        this.nseGlEach = config.TRADE_ALERT_NSE_GL_EACH || 5;
        this.onlyBuySignals = config.TRADE_ALERT_ONLY_BUY_SIGNALS !== false;
        this.maxSendsPerGroup = config.TRADE_ALERT_MAX_SENDS || 5;
        this.discoveryCount = config.TRADE_ALERT_DISCOVERY_COUNT || 8;
        this.tradePlansEnabled = config.TRADE_PLAN_ENABLED !== false;
        this.tradePlanPartials = config.TRADE_PLAN_PARTIALS || [50, 30, 20];
        this._sock = null;
        this._sentCollection = null;
        this._discoveryCollection = null;
        this._discoveryCache = {
            date: null,
            source: null,
            symbols: [],
            hiddenGem: null,
            hiddenGemReason: null,
            movers: null,
            moversBrief: '',
            marketNews: '',
            scannedAt: null,
            intelligence: null,
        };
        this.discoveryEngine = null;
        this.minConfluence = getMinConfluenceScore(config);
        this.softDailyFallback = config.TRADE_ALERT_DAILY_SOFT_FALLBACK !== false;
        this.softMinConfluence = Number.isFinite(config.TRADE_ALERT_DAILY_SOFT_MIN_CONFLUENCE)
            ? config.TRADE_ALERT_DAILY_SOFT_MIN_CONFLUENCE
            : 25;
        /** Repeat `/tradenow SYMBOL` reuses a recent result instead of re-running the pipeline. */
        this.liveCacheTtlMs = Number.isFinite(config.TRADENOW_CACHE_TTL_MS)
            ? config.TRADENOW_CACHE_TTL_MS
            : 120_000;
        /** @type {Map<string, { text: string, expiresAt: number }>} */
        this._liveCache = new Map();
        /** @type {Map<string, Promise<string>>} concurrent callers share one run */
        this._liveInflight = new Map();
    }

    async init() {
        if (!this.mongoDb) return;
        this.discoveryEngine = createTradeDiscoveryEngine(this.config, this.mongoDb);
        this._sentCollection = this.mongoDb.collection('trade_alert_sent');
        this._discoveryCollection = this.mongoDb.collection('trade_discovery_cache');
        await this._sentCollection.createIndex(
            { group_id: 1, alert_date: 1, symbol: 1 },
            { unique: true, name: 'trade_alert_sent_unique' }
        );
        await this._discoveryCollection.createIndex(
            { alert_date: 1 },
            { unique: true, name: 'trade_discovery_date_unique' }
        );
    }

    setSock(sock) {
        this._sock = sock;
    }

    isReady() {
        return this.enabled && this.tradeLlm.isConfigured();
    }

    async _runAnalysis(symbol, { mode = 'live', skipResearch = false, isHiddenGem = false } = {}) {
        const startedAt = Date.now();
        const intel = await this.research.gatherIntel(symbol, { includeMarketBrief: false });

        let researchBrief = null;
        // Daily batch: skip research brief (1 LLM call/symbol) so alerts land near open.
        // Live /tradenow: skip unless caller opts in via two-step.
        const wantResearch =
            this.twoStepResearch && !skipResearch && mode === 'daily' && this.config.TRADE_DAILY_RESEARCH === true;
        if (wantResearch) {
            researchBrief = await this.research.runResearchBrief(intel);
        }

        const userPrompt = buildTradeUserPrompt({
            symbol: intel.symbol,
            displayName: intel.displayName,
            quoteContext: intel.quoteContext,
            quote: intel.quote,
            newsContext: intel.newsContext,
            optionsNewsContext: intel.optionsNewsContext,
            optionChainContext: intel.optionChainContext,
            researchBrief,
            marketBrief: null,
            mode,
        });

        logger.info(
            `Trade analysis LLM for ${intel.symbol} (${this.tradeLlm.getPrimaryLabel()}, ` +
                `prompt ${userPrompt.length} chars, research=${researchBrief ? 'yes' : 'no'})…`
        );

        // 16k so a full analysis + verdict + why + trade plan never truncates
        // mid-JSON on the OrcaRouter (DeepSeek V4 Flash, free) primary path.
        // Fallback providers cap this internally to what they support.
        let body = await this.tradeLlm.completeTradeAnalysis(TRADE_ANALYSIS_SYSTEM_PROMPT, userPrompt, {
            maxTokens: 16_384,
        });

        body = enforceLiveSpotPrice(body, intel.quote);
        body = enforceLiveOptionPremiums(body, intel.optionChainSnapshot);

        if (this.tradePlansEnabled) {
            body = injectTradePlans(body, intel.symbol, { partials: this.tradePlanPartials });
        }

        logger.info(`Trade analysis done for ${intel.symbol} in ${Date.now() - startedAt}ms`);

        const signal = parseTradeSignal(body);
        const marketMode = getIndiaMarketMode();
        const entryState = this._computeEntryStateFromBody(body, intel.quote, marketMode);
        const text = wrapTradeAlertMessage(intel.symbol, body, {
            isDaily: mode === 'daily',
            isHiddenGem: isHiddenGem && mode === 'daily',
            meta: {
                entryState,
                confluence: null,
                freshness: intel.quote?.price != null ? 'live quote' : null,
                timings: {
                    scannedAt: startedAt,
                    // NSE's own clock for these premiums — the number that says how
                    // stale the entry price is by the time the card is read.
                    chainTimestamp: intel.optionChainSnapshot?.chainTimestamp || null,
                    pricedAt: intel.optionChainSnapshot?.fetchedAt || null,
                },
            },
        });
        return { text, body, signal, symbol: intel.symbol, entryState };
    }

    _computeEntryStateFromBody(body, quote, marketMode) {
        const text = String(body || '');
        const ceBlock = text.match(/━━━\s*CALL\s*\(CE\)\s*SETUP[\s\S]*?(?=━━━\s*PUT|Primary Pick:|$)/i)?.[0] || '';
        const entryRaw = ceBlock.match(/Entry:\s*(.+)/i)?.[1] || '';
        const entryNums = entryRaw.match(/(\d+(?:\.\d+)?)/g)?.map(Number) || [];
        const entryLow = entryNums.length ? Math.min(...entryNums) : null;
        const entryHigh = entryNums.length ? Math.max(...entryNums) : null;
        const premiumMatch = ceBlock.match(/Premium:\s*([\d,.]+)/i);
        const entry = premiumMatch ? parsePremium(premiumMatch[1]) : entryLow;
        const targets = parseTargets(ceBlock, entry);
        return computeEntryState({
            marketMode: marketMode.mode,
            quote,
            entryLow: entryLow ?? entry,
            entryHigh: entryHigh ?? entry,
            target1: targets.t1,
        });
    }

    _passesSendGates({ signal, confluence, entryState, marketMode, discovery }) {
        const gates = discovery?.gates || {};
        const minConf = gates.minConfidence ?? 70;
        const minConv = gates.minConfluence ?? this.minConfluence;

        if (marketMode.watchOnly && gates.allowsLiveEntry === false) {
            return { pass: false, reason: 'watch-only session' };
        }
        if (discovery?.freshness?.ok === false) {
            return { pass: false, reason: discovery.freshness.message || 'stale data' };
        }
        if (!signal.isActionable || signal.confidence < minConf) {
            return { pass: false, reason: `AI < ${minConf}%` };
        }
        if (confluence?.blocked) {
            return { pass: false, reason: `catalyst AVOID (${confluence.blockReason})` };
        }
        if (confluence && confluence.score < minConv) {
            return { pass: false, reason: `confluence ${confluence.score} < ${minConv}` };
        }
        if (
            entryState?.state === ENTRY_STATES.ENTRY_MISSED ||
            entryState?.state === ENTRY_STATES.NO_ACTIVE_ENTRY
        ) {
            return { pass: false, reason: entryState.label };
        }
        return { pass: true, reason: null };
    }

    _isSoftDailyEligible({ signal, confluence, gate, discovery }) {
        if (!this.softDailyFallback) return false;
        if (!signal?.isActionable) return false;
        const minConf = discovery?.gates?.minConfidence ?? 70;
        if ((signal.confidence || 0) < minConf) return false;
        if (confluence?.blocked) return false;
        if ((confluence?.score ?? 0) < this.softMinConfluence) return false;
        // Only fill from confluence misses — not watch-only / stale / entry-missed
        return /confluence\s+\d+\s*</i.test(String(gate?.reason || ''));
    }

    _wrapSoftDailyAlert(text, { symbol, confluence, strictMin }) {
        const score = confluence?.score ?? '?';
        return (
            `⚡ *DAILY ALERT (soft gate)* — *${symbol}*\n` +
            `_AI ≥70% · confluence ${score} (strict ≥${strictMin}). Size smaller / manage risk._\n\n` +
            String(text || '').trim()
        );
    }

    async _runDailyAnalysis(symbol, { isHiddenGem = false } = {}) {
        try {
            // Always skip research on daily path — one LLM call per symbol.
            return await this._runAnalysis(symbol, { mode: 'daily', skipResearch: true, isHiddenGem });
        } catch (err) {
            if (this.isTimeoutError(err) || isTradeLlmRateLimitError(err)) {
                logger.warn(`Daily scan retry for ${symbol}: ${err.message}`);
                await new Promise((r) => setTimeout(r, isTradeLlmRateLimitError(err) ? 2500 : 400));
                return await this._runAnalysis(symbol, {
                    mode: 'daily',
                    skipResearch: true,
                    isHiddenGem,
                });
            }
            throw err;
        }
    }

    /**
     * Run async work over items with limited concurrency (keeps daily scan near 09:22 IST).
     * @template T, R
     * @param {T[]} items
     * @param {number} limit
     * @param {(item: T, index: number) => Promise<R>} worker
     * @returns {Promise<R[]>}
     */
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
     * Pick alerts to post: 4 standard + 1 gem when gem is actionable, else up to 5 standard.
     * @param {{ symbol: string, text: string, signal: object, resultEntry: object }[]} actionableRegular
     * @param {{ symbol: string, text: string, signal: object, resultEntry: object }|null} actionableGem
     */
    _selectDailyPosts(actionableRegular, actionableGem) {
        const maxTotal = this.maxSendsPerGroup;
        const sortedRegular = [...actionableRegular].sort(
            (a, b) => (b.signal.confidence || 0) - (a.signal.confidence || 0)
        );

        if (actionableGem) {
            return [actionableGem, ...sortedRegular.slice(0, maxTotal - 1)];
        }
        return sortedRegular.slice(0, maxTotal);
    }

    /**
     * On-demand analysis for `/tradenow`.
     *
     * Repeat calls for the same symbol are the main source of 429s, so two
     * guards sit in front of the pipeline: concurrent calls share one in-flight
     * run, and a completed run is reused for TRADENOW_CACHE_TTL_MS.
     */
    async analyzeSymbol(rawSymbol, { mode = 'live', skipResearch = false, forceRefresh = false } = {}) {
        const symbol = String(rawSymbol || '').trim().toUpperCase();
        if (!symbol) throw new Error('Stock symbol required');
        if (!this.tradeLlm.isConfigured()) throw new Error('No trade LLM configured (GEMINI, GROQ, or NVIDIA API key)');

        const cacheKey = `${mode}:${symbol}`;
        if (!forceRefresh) {
            const cached = this._liveCache.get(cacheKey);
            if (cached && cached.expiresAt > Date.now()) {
                logger.info(`Trade analysis cache hit for ${symbol} (${mode})`);
                return cached.text;
            }
            const inflight = this._liveInflight.get(cacheKey);
            if (inflight) {
                logger.info(`Trade analysis already running for ${symbol} — joining in-flight request`);
                return inflight;
            }
        }

        const run = this._analyzeSymbolUncached(symbol, { mode, skipResearch })
            .then((text) => {
                if (this.liveCacheTtlMs > 0) {
                    this._liveCache.set(cacheKey, {
                        text,
                        expiresAt: Date.now() + this.liveCacheTtlMs,
                    });
                    this._pruneLiveCache();
                }
                return text;
            })
            .finally(() => {
                if (this._liveInflight.get(cacheKey) === run) this._liveInflight.delete(cacheKey);
            });

        this._liveInflight.set(cacheKey, run);
        return run;
    }

    /** Drop expired entries; the bot is memory-capped at 450MB. */
    _pruneLiveCache() {
        if (this._liveCache.size < 40) return;
        const now = Date.now();
        for (const [key, entry] of this._liveCache) {
            if (entry.expiresAt <= now) this._liveCache.delete(key);
        }
    }

    async _analyzeSymbolUncached(symbol, { mode, skipResearch }) {
        try {
            const result = await this._runAnalysis(symbol, { mode, skipResearch });
            return result.text;
        } catch (err) {
            // The router already walked every provider; only retry when dropping
            // research could make the request itself cheaper.
            if (!skipResearch && this.isTimeoutError(err)) {
                logger.warn(`Trade analysis retry for ${symbol} (skip research): ${err.message}`);
                const result = await this._runAnalysis(symbol, { mode, skipResearch: true });
                return result.text;
            }
            if (isTradeLlmRateLimitError(err)) {
                throw new Error('All trade LLM providers rate limited — wait 30–60 seconds and try `/tradenow` again.');
            }
            throw err;
        }
    }

    isTimeoutError(err) {
        return /timeout|ETIMEDOUT|ECONNABORTED/i.test(String(err?.message || err));
    }

    async discoverSymbolsForToday({ forceRefresh = false, source = null } = {}) {
        const result = await this.runDiscovery({ forceRefresh, persist: !forceRefresh, source });
        return result.symbols;
    }

    async resolveDiscoverySourceForGroup(groupId) {
        const fromGroup = await this.groupManager.getTradeAlertDiscoverySource?.(groupId);
        return normalizeDiscoverySource(fromGroup || this.defaultDiscoverySource);
    }

    /**
     * @param {{ forceRefresh?: boolean, persist?: boolean, source?: string }} opts
     * persist=false for manual /tradelert scan so it does not lock in stale all-day cache
     */
    async runDiscovery({ forceRefresh = false, persist = true, source = null } = {}) {
        const dateStr = getTodayDateStrIST();
        const discoverySource = normalizeDiscoverySource(source || this.defaultDiscoverySource);

        if (!forceRefresh) {
            if (
                this._discoveryCache.date === dateStr &&
                this._discoveryCache.source === discoverySource &&
                this._discoveryCache.symbols.length
            ) {
                return this._discoveryResultFromCache();
            }

            if (this._discoveryCollection) {
                const row = await this._discoveryCollection.findOne({
                    alert_date: dateStr,
                    discovery_source: discoverySource,
                });
                if (row?.symbols?.length) {
                    this._discoveryCache = {
                        date: dateStr,
                        source: discoverySource,
                        symbols: row.symbols,
                        hiddenGem: row.hidden_gem || null,
                        hiddenGemReason: row.hidden_gem_reason || null,
                        movers: row.movers || null,
                        moversBrief: row.movers_brief || '',
                        marketNews: row.market_news || '',
                        scannedAt: row.created_at || null,
                        intelligence: row.intelligence || null,
                        niftyGl: row.intelligence?.niftyGl || null,
                        discoverySource,
                    };
                    return this._discoveryResultFromCache();
                }
            }
        }

        if (!this.discoveryEngine) {
            this.discoveryEngine = createTradeDiscoveryEngine(this.config, this.mongoDb);
        }

        logger.info(
            forceRefresh
                ? `📡 Fresh trade scan (${discoverySource})…`
                : `🤖 Trade discovery (${discoverySource})…`
        );

        const intel = await this.discoveryEngine.run({ forceRefresh, source: discoverySource });

        let symbols = [...(intel.symbols || [])];
        let gemPick = { hiddenGem: null, hiddenGemReason: null };

        // Heatmap / NSE lists are authoritative — skip AI overlay / hidden-gem rewrite.
        if (!isPrescriptiveSource(discoverySource)) {
            let discovery = { symbols: [], hiddenGem: null, hiddenGemReason: null };
            if (this.tradeLlm.isConfigured()) {
                const userPrompt = buildDiscoveryUserPrompt(intel.context, this.discoveryCount);
                try {
                    const raw = await this.tradeLlm.completeTrade(STOCK_DISCOVERY_SYSTEM_PROMPT, userPrompt, {
                        maxTokens: 900,
                        timeoutMs: 90_000,
                    });
                    discovery = parseDiscoveryResult(raw);
                } catch (err) {
                    logger.warn(`AI discovery overlay skipped: ${err.message}`);
                }
            }

            const baseRows = intel.universeRows || [];
            gemPick = marketScanService.pickHiddenGem(
                baseRows,
                intel.movers,
                intel.marketNews,
                discovery.hiddenGem,
                discovery.hiddenGemReason
            );

            if (gemPick.hiddenGem && !symbols.includes(gemPick.hiddenGem)) {
                symbols = [gemPick.hiddenGem, ...symbols].slice(0, this.discoveryCount);
            }
            symbols = marketScanService.finalizeWatchlist(symbols, baseRows, this.discoveryCount);
        }

        const scannedAt = intel.scannedAt || new Date();
        const result = {
            symbols,
            hiddenGem: gemPick.hiddenGem,
            hiddenGemReason: gemPick.hiddenGemReason,
            movers: intel.movers,
            moversBrief: intel.moversBrief,
            marketNews: intel.marketNews,
            scannedAt,
            macro: intel.macro,
            hotSectors: intel.hotSectors,
            phase4Picks: intel.phase4Picks,
            momentumAlerts: intel.momentumAlerts,
            smartMoney: intel.smartMoney,
            catalystHighlights: intel.catalystHighlights,
            symbolMeta: intel.symbolMeta,
            delta: intel.delta,
            marketMode: intel.marketMode,
            marketModeLabel: intel.marketModeLabel,
            freshness: intel.freshness,
            gates: intel.gates,
            niftyGl: intel.niftyGl || null,
            heatmap: intel.heatmap || null,
            discoverySource,
            intelligence: intel,
        };

        this._discoveryCache = { date: dateStr, source: discoverySource, ...result };

        if (persist && this._discoveryCollection) {
            await this._discoveryCollection.updateOne(
                { alert_date: dateStr, discovery_source: discoverySource },
                {
                    $set: {
                        symbols,
                        discovery_source: discoverySource,
                        hidden_gem: gemPick.hiddenGem,
                        hidden_gem_reason: gemPick.hiddenGemReason,
                        movers: intel.movers,
                        movers_brief: intel.moversBrief,
                        market_news: intel.marketNews,
                        intelligence: {
                            macro: intel.macro,
                            hotSectors: intel.hotSectors,
                            phase4Picks: intel.phase4Picks,
                            momentumAlerts: intel.momentumAlerts,
                            catalystHighlights: intel.catalystHighlights,
                            delta: intel.delta,
                            gates: intel.gates,
                            marketMode: intel.marketMode,
                            niftyGl: intel.niftyGl || null,
                            // `version` must survive the round-trip: the scan
                            // card picks its layout from it, so dropping it made
                            // a cached v2 scan render through v1's branch and
                            // lose its targets.
                            heatmap: intel.heatmap
                                ? {
                                      version: intel.heatmap.version || null,
                                      sentiment: intel.heatmap.sentiment,
                                      regime: intel.heatmap.regime || null,
                                      preOpeningRange: intel.heatmap.preOpeningRange || false,
                                      candidatesScanned: intel.heatmap.candidatesScanned || 0,
                                      rejects: intel.heatmap.rejects || null,
                                      picks: (intel.heatmap.picks || []).map((p) => ({
                                          symbol: p.symbol,
                                          sector: p.sector,
                                          sectorPct: p.sectorPct,
                                          changePct: p.changePct,
                                          relStrength: p.relStrength ?? null,
                                          side: p.side,
                                          setup: p.setup,
                                      })),
                                  }
                                : null,
                        },
                        created_at: scannedAt,
                    },
                },
                { upsert: true }
            );
        }

        const gemNote = gemPick.hiddenGem ? ` · 💎 ${gemPick.hiddenGem}` : '';
        logger.info(
            `🤖 Watchlist [${discoverySource}] (${symbols.length}): ${symbols.join(', ')}${gemNote}`
        );
        return result;
    }

    _discoveryResultFromCache() {
        return {
            symbols: this._discoveryCache.symbols,
            hiddenGem: this._discoveryCache.hiddenGem || null,
            hiddenGemReason: this._discoveryCache.hiddenGemReason || null,
            movers: this._discoveryCache.movers || null,
            moversBrief: this._discoveryCache.moversBrief || 'n/a',
            marketNews: this._discoveryCache.marketNews || 'n/a',
            scannedAt: this._discoveryCache.scannedAt || null,
            macro: this._discoveryCache.intelligence?.macro || this._discoveryCache.macro || null,
            hotSectors: this._discoveryCache.intelligence?.hotSectors || this._discoveryCache.hotSectors || null,
            phase4Picks: this._discoveryCache.intelligence?.phase4Picks || this._discoveryCache.phase4Picks || [],
            momentumAlerts: this._discoveryCache.intelligence?.momentumAlerts || this._discoveryCache.momentumAlerts || [],
            smartMoney: this._discoveryCache.smartMoney || null,
            catalystHighlights: this._discoveryCache.intelligence?.catalystHighlights || this._discoveryCache.catalystHighlights || [],
            symbolMeta: this._discoveryCache.symbolMeta || [],
            delta: this._discoveryCache.intelligence?.delta || this._discoveryCache.delta || null,
            marketMode: this._discoveryCache.intelligence?.marketMode || this._discoveryCache.marketMode,
            marketModeLabel: this._discoveryCache.marketModeLabel,
            freshness: this._discoveryCache.freshness,
            gates: this._discoveryCache.intelligence?.gates || this._discoveryCache.gates,
            niftyGl: this._discoveryCache.niftyGl || this._discoveryCache.intelligence?.niftyGl || null,
            heatmap: this._discoveryCache.heatmap || this._discoveryCache.intelligence?.heatmap || null,
            discoverySource: this._discoveryCache.discoverySource || this._discoveryCache.source || this.defaultDiscoverySource,
        };
    }

    _formatScanResultLine(entry) {
        const gemTag = entry.isHiddenGem ? ' 💎' : '';
        const confTag = entry.confluence != null ? ` · conf ${entry.confluence}` : '';
        if (entry.posted) {
            const softTag = entry.softGate ? ' ⚡soft' : '';
            return `✅ *${entry.symbol}*${gemTag}${softTag} — ${entry.recommendation} (${entry.confidence}%)${confTag}`;
        }
        if (entry.isActionable) {
            return `⚠️ ${entry.symbol}${gemTag} — ${entry.recommendation} (${entry.confidence}%)${confTag} · not posted (daily limit)`;
        }
        const why = entry.gateReason ? ` · ${entry.gateReason}` : '';
        return `— ${entry.symbol}${gemTag} — NO TRADE (CE ${entry.ceConfidence}% / PE ${entry.peConfidence}%)${why}`;
    }

    async wasDailySent(groupId, symbol, dateStr) {
        if (!this._sentCollection) return false;
        const row = await this._sentCollection.findOne({
            group_id: groupId,
            alert_date: dateStr,
            symbol,
        });
        return Boolean(row);
    }

    async markDailySent(groupId, symbol, dateStr, extra = {}) {
        if (!this._sentCollection) return;
        await this._sentCollection.updateOne(
            { group_id: groupId, alert_date: dateStr, symbol },
            { $set: { sent_at: new Date(), ...extra } },
            { upsert: true }
        );
    }

    async resolveModeForGroup(group) {
        const mode = await this.groupManager.getTradeAlertMode(group.group_id);
        return mode || this.defaultMode;
    }

    async resolveSymbolsForGroup(group) {
        const mode = await this.resolveModeForGroup(group);
        if (mode === 'manual') {
            const groupSymbols = await this.groupManager.getTradeAlertSymbols(group.group_id);
            if (groupSymbols.length) return groupSymbols;
            return this.defaultSymbols;
        }
        return this.discoverSymbolsForToday();
    }

    /**
     * @param {object} sock
     * @param {{ onlySources?: string[], excludeSources?: string[], slotLabel?: string }} [opts]
     */
    async postDailyAlerts(sock = this._sock, opts = {}) {
        const { onlySources = null, excludeSources = null, slotLabel = null } = opts;
        if (!this.enabled) {
            logger.info('Trade alert: disabled (TRADE_ALERT_ENABLED=false)');
            return;
        }

        if (!isIndianEquityTradingDay(Date.now(), this.config)) {
            const reason = getIndianMarketClosedReason(Date.now(), this.config);
            logger.info(`Trade alert: skipped — ${reason}`);
            return;
        }

        if (!sock) {
            logger.warn('Trade alert: no socket');
            return;
        }
        if (!this.tradeLlm.isConfigured()) {
            logger.warn('Trade alert: no trade LLM API key (GEMINI, GROQ, or NVIDIA)');
            return;
        }

        let groups = await this.groupManager.getTradeAlertGroups();
        if (!groups.length) {
            logger.info('Trade alert: no /tradelert on groups');
            return;
        }

        /**
         * Slots are per-strategy. heatmap2 cannot confirm a breakout before
         * ~09:45, so it runs on its own later clock while v1/legacy/nse keep
         * the 09:20 pre-market slot. Filtering here rather than in the
         * scheduler keeps one source of truth for a group's discovery source.
         */
        if (onlySources?.length || excludeSources?.length) {
            const resolved = await Promise.all(
                groups.map(async (g) => ({
                    group: g,
                    source:
                        (await this.resolveModeForGroup(g)) === 'manual'
                            ? 'manual'
                            : await this.resolveDiscoverySourceForGroup(g.group_id),
                }))
            );
            groups = resolved
                .filter(({ source }) => {
                    if (onlySources?.length) return onlySources.includes(source);
                    return !excludeSources.includes(source);
                })
                .map(({ group }) => group);

            if (!groups.length) {
                logger.info(
                    `Trade alert [${slotLabel || 'slot'}]: no groups match ` +
                        (onlySources?.length ? `sources ${onlySources.join(',')}` : `excluding ${excludeSources.join(',')}`)
                );
                return;
            }
        }

        const dateStr = getTodayDateStrIST();
        const dateLabel = formatNowLabelIST();
        logger.info(
            `📈 Daily trade alerts${slotLabel ? ` [${slotLabel}]` : ''} for ${groups.length} group(s) — ${dateLabel}`
        );

        /** @type {Map<string, object>} */
        const discoveriesBySource = new Map();

        for (const group of groups) {
            const mode = await this.resolveModeForGroup(group);
            let symbols;
            let autoDiscovery = null;
            let source = this.defaultDiscoverySource;
            if (mode === 'manual') {
                const groupSymbols = await this.groupManager.getTradeAlertSymbols(group.group_id);
                symbols = groupSymbols.length ? groupSymbols : this.defaultSymbols;
            } else {
                source = await this.resolveDiscoverySourceForGroup(group.group_id);
                if (!discoveriesBySource.has(source)) {
                    try {
                        discoveriesBySource.set(
                            source,
                            await this.runDiscovery({ forceRefresh: true, persist: true, source })
                        );
                    } catch (err) {
                        logger.error(`Daily discovery (${source}) failed, using fallback: ${err.message}`);
                        discoveriesBySource.set(source, {
                            symbols: this.defaultSymbols.slice(0, this.discoveryCount),
                            hiddenGem: null,
                            hiddenGemReason: null,
                            moversBrief: 'Discovery unavailable — using default watchlist',
                            marketNews: '',
                            scannedAt: new Date(),
                            discoverySource: source,
                        });
                    }
                }
                autoDiscovery = discoveriesBySource.get(source);
                symbols = autoDiscovery.symbols;
                if (autoDiscovery.movers && !isPrescriptiveSource(source)) {
                    symbols = marketScanService.orderSymbolsByMovers(symbols, autoDiscovery.movers);
                }
            }

            if (!symbols.length) {
                logger.warn(`Trade alert: no symbols for ${group.group_name || group.group_id}`);
                continue;
            }

            const hiddenGemSymbol = mode === 'auto' ? (autoDiscovery?.hiddenGem || null) : null;
            const hiddenGemReason = mode === 'auto' ? (autoDiscovery?.hiddenGemReason || null) : null;

            let sentCount = 0;
            const skipped = [];
            const actionableSent = [];
            const scanResults = [];
            const actionableRegular = [];
            const softRegular = [];
            let actionableGem = null;
            let softGem = null;

            if (mode === 'auto') {
                const intro = formatDailyScanIntro(autoDiscovery, {
                    symbols,
                    hiddenGem: hiddenGemSymbol,
                    hiddenGemReason,
                    maxSends: this.maxSendsPerGroup,
                });
                // Fire-and-forget — don't block analysis for ~9:22 posts
                sock.sendMessage(group.group_id, { text: intro }).catch(() => {});
            }

            const marketMode = getIndiaMarketMode();
            const discoveryFreshness = checkQuoteFreshness(autoDiscovery?.scannedAt);
            const strictMinConv = autoDiscovery?.gates?.minConfluence ?? this.minConfluence;
            const concurrency = Math.max(1, Math.min(3, Number(this.config.TRADE_ALERT_SCAN_CONCURRENCY) || 2));

            const scanRows = await this._mapPool(symbols, concurrency, async (symbol) => {
                try {
                    if (await this.wasDailySent(group.group_id, symbol, dateStr)) {
                        return { kind: 'already' };
                    }

                    const isHiddenGem = Boolean(hiddenGemSymbol && symbol === hiddenGemSymbol);
                    const { text, signal, entryState } = await this._runDailyAnalysis(symbol, { isHiddenGem });

                    const metaRow = autoDiscovery?.symbolMeta?.find((m) => m.symbol === symbol);
                    const confluence = metaRow
                        ? {
                              score: metaRow.confluence,
                              blocked: metaRow.blocked,
                              blockReason: metaRow.blocked ? 'catalyst' : null,
                              passes: metaRow.confluencePass,
                          }
                        : scoreConfluence({
                              symbol,
                              movers: autoDiscovery?.movers,
                              macro: autoDiscovery?.macro,
                          });

                    const discoveryForGates = {
                        ...autoDiscovery,
                        freshness: discoveryFreshness,
                    };
                    const gate = this._passesSendGates({
                        signal,
                        confluence,
                        entryState,
                        marketMode,
                        discovery: discoveryForGates,
                    });

                    const resultEntry = {
                        symbol,
                        recommendation: signal.recommendation,
                        confidence: signal.confidence,
                        ceConfidence: signal.ceConfidence,
                        peConfidence: signal.peConfidence,
                        isActionable: signal.isActionable && gate.pass,
                        confluence: confluence.score,
                        gateReason: gate.pass ? null : gate.reason,
                        isHiddenGem,
                        posted: false,
                        softGate: false,
                    };

                    if (this.onlyBuySignals && !resultEntry.isActionable) {
                        const softOk = this._isSoftDailyEligible({
                            signal,
                            confluence,
                            gate,
                            discovery: discoveryForGates,
                        });
                        const cePe = `CE ${signal.ceConfidence}% / PE ${signal.peConfidence}%`;
                        const why = gate.pass ? '' : ` · ${gate.reason}`;
                        const skipLine = `${symbol} (${gate.pass ? 'NO TRADE' : 'blocked'} · ${cePe}${why})`;

                        if (softOk) {
                            const softItem = {
                                symbol,
                                text: this._wrapSoftDailyAlert(text, {
                                    symbol,
                                    confluence,
                                    strictMin: strictMinConv,
                                }),
                                body: text,
                                signal,
                                resultEntry,
                                softGate: true,
                            };
                            return { kind: 'soft', softItem, isHiddenGem, skipLine, resultEntry };
                        }
                        await this.markDailySent(group.group_id, symbol, dateStr, {
                            skipped: true,
                            signal: signal.recommendation,
                            confidence: signal.confidence,
                        });
                        return { kind: 'skip', skipLine, resultEntry };
                    }

                    const item = { symbol, text, body: text, signal, resultEntry, softGate: false };
                    return { kind: 'actionable', item, isHiddenGem, resultEntry };
                } catch (err) {
                    logger.error(`Trade alert failed ${symbol} in ${group.group_id}: ${err.message}`);
                    const short = isTradeLlmRateLimitError(err)
                        ? 'rate limit'
                        : this.isTimeoutError(err)
                          ? 'timeout'
                          : 'error';
                    return { kind: 'error', skipLine: `${symbol} (scan error · ${short})` };
                }
            });

            for (const row of scanRows) {
                if (!row || row.kind === 'already') continue;
                if (row.skipLine) skipped.push(row.skipLine);
                if (row.resultEntry) scanResults.push(row.resultEntry);
                if (row.kind === 'soft') {
                    if (row.isHiddenGem) softGem = row.softItem;
                    else softRegular.push(row.softItem);
                } else if (row.kind === 'actionable') {
                    if (row.isHiddenGem) actionableGem = row.item;
                    else actionableRegular.push(row.item);
                }
            }

            let toPost = this._selectDailyPosts(actionableRegular, actionableGem);
            let usedSoftFallback = false;

            if (!toPost.length && this.softDailyFallback) {
                softRegular.sort(
                    (a, b) =>
                        (b.signal.confidence || 0) - (a.signal.confidence || 0) ||
                        (b.resultEntry.confluence || 0) - (a.resultEntry.confluence || 0)
                );
                toPost = this._selectDailyPosts(softRegular, softGem);
                usedSoftFallback = toPost.length > 0;
                if (usedSoftFallback) {
                    logger.info(
                        `📈 Daily soft fallback: posting ${toPost.length} AI≥70% alert(s) (confluence ≥${this.softMinConfluence})`
                    );
                }
            }

            // Soft candidates not selected → mark skipped
            for (const item of [...softRegular, ...(softGem ? [softGem] : [])]) {
                if (toPost.some((p) => p.symbol === item.symbol)) continue;
                await this.markDailySent(group.group_id, item.symbol, dateStr, {
                    skipped: true,
                    reason: usedSoftFallback ? 'soft_not_selected' : 'confluence',
                    signal: item.signal.recommendation,
                    confidence: item.signal.confidence,
                }).catch(() => {});
            }

            const postSymbols = new Set(toPost.map((p) => p.symbol));

            // Kick live ATM premium for morning pick while alerts send (no extra wait after scan).
            const morning = toPost.length
                ? startMorningPick(
                      toPost.map((p) => ({
                          symbol: p.symbol,
                          signal: p.signal,
                          resultEntry: p.resultEntry,
                          softGate: p.softGate,
                          body: p.body || p.text,
                          text: p.text,
                      })),
                      { discoverySource: source }
                  )
                : { pick: null, livePromise: Promise.resolve(null) };

            for (const item of toPost) {
                try {
                    // Stamp the send moment, so a delayed delivery is visible.
                    await sock.sendMessage(group.group_id, { text: withSentStamp(item.text) });
                    item.resultEntry.posted = true;
                    item.resultEntry.softGate = Boolean(item.softGate);
                    item.resultEntry.isActionable = true;
                    await this.markDailySent(group.group_id, item.symbol, dateStr, {
                        skipped: false,
                        soft_gate: Boolean(item.softGate),
                        signal: item.signal.recommendation,
                        confidence: item.signal.confidence,
                        hidden_gem: item.resultEntry.isHiddenGem,
                    });
                    sentCount += 1;
                    await this._logPostedAlert({
                        symbol: item.symbol,
                        signal: item.signal,
                        resultEntry: item.resultEntry,
                        source,
                        meta: autoDiscovery?.symbolMeta?.find((m) => m.symbol === item.symbol),
                        groupId: group.group_id,
                    });
                    const softTag = item.softGate ? ' ⚡' : '';
                    actionableSent.push(
                        `${item.resultEntry.isHiddenGem ? `${item.symbol} 💎` : item.symbol}${softTag}`
                    );
                    logger.info(
                        `✅ Trade alert sent: ${item.symbol}${item.resultEntry.isHiddenGem ? ' 💎' : ''}${item.softGate ? ' (soft)' : ''} → ${group.group_name || group.group_id}`
                    );
                    await new Promise((r) => setTimeout(r, 800));
                } catch (err) {
                    logger.error(`Trade alert send failed ${item.symbol} in ${group.group_id}: ${err.message}`);
                }
            }

            for (const item of [...actionableRegular, ...(actionableGem ? [actionableGem] : [])]) {
                if (postSymbols.has(item.symbol)) continue;
                await this.markDailySent(group.group_id, item.symbol, dateStr, {
                    skipped: true,
                    reason: 'daily_limit',
                    signal: item.signal.recommendation,
                    confidence: item.signal.confidence,
                }).catch(() => {});
            }

            const scanSummary = scanResults.length
                ? `\n\n📋 *Scan summary*\n${scanResults.map((e) => this._formatScanResultLine(e)).join('\n')}`
                : '';

            if (sentCount > 0) {
                const gemPosted = toPost.some((p) => p.resultEntry.isHiddenGem && p.resultEntry.posted);
                const gemNote = gemPosted
                    ? '\n_💎 Hidden gem included in today\'s posts._'
                    : hiddenGemSymbol
                      ? `\n_No hidden gem posted — ${hiddenGemSymbol} did not reach ≥70%._`
                      : '';
                const softNote = usedSoftFallback
                    ? `\n_⚡ Soft gate day — AI ≥70% with confluence ≥${this.softMinConfluence} (strict ≥${strictMinConv})._`
                    : '';
                await sock.sendMessage(group.group_id, {
                    text:
                        `📈 *Daily F&O scan complete*\n` +
                        `Posted *${sentCount}* alert(s): *${actionableSent.join(', ')}*` +
                        softNote +
                        gemNote +
                        scanSummary +
                        `\n\n_Use \`/tradenow SYMBOL\` anytime for full analysis._`,
                }).catch(() => {});

                // Morning pick of day — Format B + fresh NSE ATM premium (fetched in parallel above)
                try {
                    const live = await morning.livePromise;
                    const pickText = formatMorningPickCard(morning.pick, {
                        live,
                        discoverySource: source,
                    });
                    if (pickText) {
                        await sock.sendMessage(group.group_id, { text: pickText }).catch(() => {});
                        logger.info(
                            `🏆 Morning pick ${morning.pick?.winner?.symbol} ${morning.pick?.winner?.side}` +
                                (live?.entry != null ? ` @ ₹${live.entry}` : ' (alert premium)') +
                                ` → ${group.group_name || group.group_id}`
                        );
                    }
                } catch (err) {
                    logger.warn(`Morning pick card failed: ${err.message}`);
                }
            } else if (this.onlyBuySignals) {
                const skipNote = skipped.length
                    ? `\n_Scanned: ${skipped.slice(0, 8).join('; ')}_`
                    : '';
                await sock.sendMessage(group.group_id, {
                    text:
                        `📈 *Daily F&O scan complete*\n` +
                        `No BUY setups today (AI ≥70% + confluence ≥${this.softMinConfluence}).${skipNote}` +
                        scanSummary +
                        `\n\nUse \`/tradenow SYMBOL\` for full analysis including NO TRADE.`,
                }).catch(() => {});
            }
        }
    }

    /**
     * Journal a posted daily alert so it can be graded later.
     *
     * Daily alerts were the one path that never wrote to `trade_alert_outcomes`
     * at all — only /swing and /expiry did — so the main strategy was the one
     * with no record of how it performed.
     *
     * The card's own entry/SL/targets are CE/PE *premiums*, and historical
     * option premiums cannot be fetched from any feed here. Where the scan
     * produced an equity setup (heatmap v1/v2), those underlying levels are
     * recorded too, and that is what makes an exact WIN/LOSS possible.
     */
    async _logPostedAlert({ symbol, signal, resultEntry, source, meta, groupId }) {
        if (!this.mongoDb) return;
        try {
            const outcomes = createTradeOutcomeService(this.mongoDb, this.config);
            const setup = meta?.setup || null;
            const side = signal?.isBuyPut ? 'BUY_PE' : 'BUY_CE';
            await outcomes.logPostedAlert({
                symbol,
                side,
                entry: null,
                stopLoss: null,
                target1: null,
                target2: null,
                confidence: signal?.confidence ?? null,
                confluence: resultEntry?.confluence ?? null,
                groupId,
                strategySource: source,
                setupScore: setup?.score ?? null,
                underlyingSymbol: symbol,
                underlyingEntry: setup?.entry ?? null,
                underlyingStop: setup?.stop ?? null,
                underlyingTarget: setup?.target1 ?? setup?.target15 ?? null,
            });
        } catch (err) {
            // Journalling must never break a send that already succeeded.
            logger.debug(`Daily alert outcome logging failed for ${symbol}: ${err.message}`);
        }
    }

    /** Manual preview — always fresh live scan (does not reuse all-day cache). */
    async previewDiscovery(source = null) {
        const discoverySource = normalizeDiscoverySource(source || this.defaultDiscoverySource);
        return this.runDiscovery({ forceRefresh: true, persist: false, source: discoverySource });
    }
}

export default TradeAlertController;
