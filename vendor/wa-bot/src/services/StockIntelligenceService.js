/**
 * Aggregate live quote + news + market context for AI trade analysis.
 */

import { indianStockQuoteService } from './IndianStockQuoteService.js';
import { stockNewsService } from './StockNewsService.js';
import { nseOptionChainService } from './NseOptionChainService.js';
import { marketScanService } from './MarketScanService.js';

function withTimeout(promise, ms, fallback) {
    return Promise.race([
        promise,
        new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
    ]);
}

class StockIntelligenceService {
    /**
     * @param {string} symbol
     * @param {{ includeMarketBrief?: boolean }} [opts]
     */
    async gatherForSymbol(symbol, opts = {}) {
        const sym = String(symbol || '').trim().toUpperCase();

        const quotePack = await indianStockQuoteService.fetchQuoteContext(sym);
        const displayName = quotePack?.displayName || sym;

        const [news, optionsNews, optionChain] = await Promise.all([
            stockNewsService.fetchForSymbol(sym, displayName),
            stockNewsService.fetchOptionsNews(sym, displayName),
            withTimeout(nseOptionChainService.fetchOptionContext(sym), 18_000, null),
        ]);

        let marketBrief = null;
        if (opts.includeMarketBrief) {
            const snap = await marketScanService.buildDiscoverySnapshot();
            marketBrief = snap.context;
        }

        return {
            symbol: sym,
            displayName,
            quoteContext: quotePack?.context || null,
            quote: quotePack?.quote || null,
            newsContext: news.context,
            newsHeadlines: news.headlines,
            optionsNewsContext: optionsNews.context,
            optionsNewsHeadlines: optionsNews.headlines,
            optionChainContext: optionChain?.context || null,
            optionChainSnapshot: optionChain?.snapshot || null,
            marketBrief,
        };
    }
}

export const stockIntelligenceService = new StockIntelligenceService();
export default StockIntelligenceService;
