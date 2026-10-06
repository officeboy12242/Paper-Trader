/**
 * Resolve user NSE symbols → live NSE + Yahoo tickers (AI on failure, cached).
 */

import { logger } from '../utils/logger.js';
import { config } from '../config/config.js';
import NvidiaDeepSeekService from './NvidiaDeepSeekService.js';
import { fetchYahooChartMeta, yahooSymbolHasQuote } from '../utils/yahooChartFetch.js';
import {
    SYMBOL_RESOLVE_SYSTEM_PROMPT,
    buildSymbolResolveUserPrompt,
} from '../prompts/symbolResolvePrompt.js';

const INDEX_NSE = new Set(['NIFTY', 'NIFTY50', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50', 'SENSEX']);

const INDEX_YAHOO = {
    NIFTY: '^NSEI',
    NIFTY50: '^NSEI',
    BANKNIFTY: '^NSEBANK',
    SENSEX: '^BSESN',
    FINNIFTY: 'NIFTY_FIN_SERVICE.NS',
};

/** @typedef {{ userSymbol: string, nseSymbol: string, yahooSymbol: string, notes?: string }} SymbolMapping */

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function normalizeUserSymbol(raw) {
    return String(raw || '').trim().toUpperCase().replace(/\.NS$|\.BO$/i, '').replace(/\s+/g, '');
}

function defaultYahooCandidates(userSymbol) {
    if (INDEX_YAHOO[userSymbol]) return [INDEX_YAHOO[userSymbol]];
    return [`${userSymbol}.NS`];
}

function parseResolveJson(raw) {
    const text = String(raw || '').trim();
    const jsonBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    const candidate = jsonBlock || text;
    try {
        return JSON.parse(candidate);
    } catch {
        const m = candidate.match(/\{[\s\S]*\}/);
        if (m) {
            try {
                return JSON.parse(m[0]);
            } catch {
                return null;
            }
        }
    }
    return null;
}

class StockSymbolResolverService {
    constructor(cfg = config) {
        this.nvidia = new NvidiaDeepSeekService(cfg);
        /** @type {Map<string, { mapping: SymbolMapping, at: number }>} */
        this._cache = new Map();
        /** @type {Map<string, Promise<SymbolMapping>>} */
        this._inflight = new Map();
    }

    /** @returns {SymbolMapping|null} */
    _getCached(userSymbol) {
        const row = this._cache.get(userSymbol);
        if (!row) return null;
        if (Date.now() - row.at > CACHE_TTL_MS) {
            this._cache.delete(userSymbol);
            return null;
        }
        return row.mapping;
    }

    _setCache(mapping) {
        this._cache.set(mapping.userSymbol, { mapping, at: Date.now() });
    }

    resolveNseType(nseSymbol) {
        const s = normalizeUserSymbol(nseSymbol);
        if (INDEX_NSE.has(s) || s === 'NIFTY50') return 'Indices';
        return 'Equity';
    }

    resolveNseFromUser(userSymbol) {
        const s = normalizeUserSymbol(userSymbol);
        if (s === 'NIFTY50') return 'NIFTY';
        return s;
    }

    /** @returns {Promise<SymbolMapping|null>} */
    async tryYahooCandidates(userSymbol, candidates) {
        for (const yahooSymbol of candidates) {
            if (!yahooSymbol) continue;
            try {
                await fetchYahooChartMeta(yahooSymbol);
                const nseSymbol = this.resolveNseFromUser(userSymbol);
                return {
                    userSymbol,
                    nseSymbol,
                    yahooSymbol,
                };
            } catch {
                // try next
            }
        }
        return null;
    }

    /** @returns {Promise<SymbolMapping|null>} */
    async resolveWithAi(userSymbol, opts = {}) {
        if (!this.nvidia.isConfigured()) return null;

        const failedYahoo = [...(opts.failedYahoo || [])];
        const maxAttempts = 3;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                const raw = await this.nvidia.completeTrade(
                    SYMBOL_RESOLVE_SYSTEM_PROMPT,
                    buildSymbolResolveUserPrompt(userSymbol, { ...opts, failedYahoo }),
                    { maxTokens: 400, timeoutMs: 45_000 }
                );

                const parsed = parseResolveJson(raw);
                if (!parsed) {
                    logger.warn(`Symbol AI resolve: invalid JSON for ${userSymbol} (attempt ${attempt + 1})`);
                    continue;
                }

                const nseFromAi = parsed.nse_symbol
                    ? normalizeUserSymbol(parsed.nse_symbol)
                    : null;
                const yahooList = Array.isArray(parsed.yahoo_symbols)
                    ? parsed.yahoo_symbols.map((s) => String(s).trim()).filter(Boolean)
                    : nseFromAi
                      ? [`${nseFromAi}.NS`]
                      : [];

                if (!yahooList.length && INDEX_YAHOO[userSymbol]) {
                    yahooList.push(INDEX_YAHOO[userSymbol]);
                }

                for (const yahooSymbol of yahooList) {
                    if (failedYahoo.includes(yahooSymbol)) continue;
                    if (await yahooSymbolHasQuote(yahooSymbol)) {
                        const inferredNse = yahooSymbol.replace(/\.NS$|\.BO$/i, '').toUpperCase();
                        const mapping = {
                            userSymbol,
                            nseSymbol: nseFromAi || inferredNse || this.resolveNseFromUser(userSymbol),
                            yahooSymbol,
                            notes: parsed.notes || undefined,
                        };
                        logger.info(
                            `🔎 Symbol resolved (AI): ${userSymbol} → NSE ${mapping.nseSymbol}, Yahoo ${mapping.yahooSymbol}`
                        );
                        return mapping;
                    }
                    failedYahoo.push(yahooSymbol);
                }
            } catch (err) {
                logger.warn(`Symbol AI resolve failed for ${userSymbol}: ${err.message}`);
            }
        }
        return null;
    }

    /**
     * Resolve user symbol to working NSE + Yahoo tickers.
     * @param {string} rawSymbol
     * @param {{ forceRefresh?: boolean, optionChainFailed?: boolean, attemptedNse?: string }} [opts]
     * @returns {Promise<SymbolMapping>}
     */
    async resolve(rawSymbol, opts = {}) {
        const userSymbol = normalizeUserSymbol(rawSymbol);
        if (!userSymbol) {
            return { userSymbol: '', nseSymbol: '', yahooSymbol: '' };
        }

        if (!opts.forceRefresh) {
            const cached = this._getCached(userSymbol);
            if (cached) return cached;
        }

        if (this._inflight.has(userSymbol) && !opts.forceRefresh) {
            return this._inflight.get(userSymbol);
        }

        const work = this._resolveInternal(userSymbol, opts);
        this._inflight.set(userSymbol, work);
        try {
            return await work;
        } finally {
            this._inflight.delete(userSymbol);
        }
    }

    /** @returns {Promise<SymbolMapping>} */
    async _resolveInternal(userSymbol, opts) {
        const direct = await this.tryYahooCandidates(userSymbol, defaultYahooCandidates(userSymbol));
        if (direct && !opts.optionChainFailed) {
            this._setCache(direct);
            return direct;
        }

        const aiMapping = await this.resolveWithAi(userSymbol, {
            optionChainFailed: opts.optionChainFailed,
            attemptedNse: opts.attemptedNse,
        });
        if (aiMapping) {
            this._setCache(aiMapping);
            return aiMapping;
        }

        logger.warn(`Symbol resolve: could not map ${userSymbol} — using best-effort defaults`);
        return {
            userSymbol,
            nseSymbol: this.resolveNseFromUser(userSymbol),
            yahooSymbol: defaultYahooCandidates(userSymbol)[0] || `${userSymbol}.NS`,
        };
    }
}

export const stockSymbolResolverService = new StockSymbolResolverService();
export default StockSymbolResolverService;
