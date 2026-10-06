/**
 * Lightweight NSE/BSE spot quotes — Yahoo Finance with AI symbol resolution on failure.
 */

import { logger } from '../utils/logger.js';
import { fetchYahooChartMeta } from '../utils/yahooChartFetch.js';
import { stockSymbolResolverService } from './StockSymbolResolverService.js';
import { getIndexSpec } from '../data/indexUniverse.js';

/**
 * @param {object} meta Yahoo chart meta
 * @returns {import('./IndianStockQuoteService.js').StockQuote | null}
 */
function metaToQuote(meta, yahooSymbol, rawSymbol) {
    if (!meta) return null;

    const price = meta.regularMarketPrice ?? meta.previousClose;
    if (price == null) return null;

    const prev = meta.chartPreviousClose ?? meta.previousClose;
    const change = prev != null ? price - prev : null;
    const changePct = change != null && prev ? Number(((change / prev) * 100).toFixed(2)) : null;

    return {
        symbol: String(rawSymbol).trim().toUpperCase(),
        yahooSymbol,
        displayName: meta.longName || meta.shortName || rawSymbol,
        price: Number(price),
        change: change != null ? Number(change.toFixed(2)) : null,
        changePct,
        open: meta.regularMarketDayOpen ?? null,
        high: meta.regularMarketDayHigh ?? null,
        low: meta.regularMarketDayLow ?? null,
        prevClose: prev != null ? Number(prev) : null,
        volume: meta.regularMarketVolume ?? null,
        currency: meta.currency || 'INR',
        fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? null,
        fiftyTwoWeekLow: meta.fiftyTwoWeekLow ?? null,
        exchange: meta.fullExchangeName || meta.exchangeName || 'NSE',
        marketState: meta.marketState || '',
    };
}

function formatQuoteContext(quote) {
    const lines = [
        `Symbol (Yahoo): ${quote.yahooSymbol}`,
        `Exchange: ${quote.exchange}`,
        `Last price: ${quote.price} ${quote.currency}`,
    ];

    if (quote.change != null && quote.changePct != null) {
        const sign = quote.change >= 0 ? '+' : '';
        lines.push(`Change today: ${sign}${quote.change} (${sign}${quote.changePct}%)`);
    }
    if (quote.open != null) lines.push(`Open: ${quote.open}`);
    if (quote.high != null) lines.push(`Day high: ${quote.high}`);
    if (quote.low != null) lines.push(`Day low: ${quote.low}`);
    if (quote.prevClose != null) lines.push(`Previous close: ${quote.prevClose}`);
    if (quote.volume != null) lines.push(`Volume: ${quote.volume}`);
    if (quote.fiftyTwoWeekHigh != null) lines.push(`52W high: ${quote.fiftyTwoWeekHigh}`);
    if (quote.fiftyTwoWeekLow != null) lines.push(`52W low: ${quote.fiftyTwoWeekLow}`);
    if (quote.marketState) lines.push(`Market state: ${quote.marketState}`);

    return lines.join('\n');
}

export function normalizeYahooSymbol(raw) {
    const s = String(raw || '').trim().toUpperCase().replace(/\.NS$|\.BO$/i, '').replace(/\s+/g, '');
    if (!s) return '';
    // Already a Yahoo index ticker (^NSEI, ^NSEBANK) — appending .NS breaks it.
    if (s.startsWith('^')) return s;
    // Index tickers come from the shared map. This used to know only NIFTY and
    // BANKNIFTY, so MIDCPNIFTY became MIDCPNIFTY.NS — a nonexistent ticker that
    // hung for minutes instead of failing.
    const spec = getIndexSpec(s);
    if (spec) return spec.yahoo;
    if (s.endsWith('.NS') || s.endsWith('.BO')) return s;
    return `${s}.NS`;
}

class IndianStockQuoteService {
    /**
     * @param {string} rawSymbol
     * @returns {Promise<StockQuote | null>}
     */
    async fetchQuote(rawSymbol) {
        const raw = String(rawSymbol || '').trim().toUpperCase();
        if (!raw) return null;

        try {
            return await this._fetchWithMapping(raw, false);
        } catch (err) {
            try {
                return await this._fetchWithMapping(raw, true);
            } catch (retryErr) {
                logger.warn(`Stock quote failed for ${rawSymbol}: ${retryErr.message}`);
                return null;
            }
        }
    }

    async _fetchWithMapping(raw, forceRefresh) {
        const mapping = await stockSymbolResolverService.resolve(raw, { forceRefresh });
        const meta = await fetchYahooChartMeta(mapping.yahooSymbol);
        return metaToQuote(meta, mapping.yahooSymbol, mapping.userSymbol || raw);
    }

    /**
     * @param {string} rawSymbol
     * @returns {Promise<{ yahooSymbol: string, displayName: string, context: string, quote: StockQuote } | null>}
     */
    async fetchQuoteContext(rawSymbol) {
        const quote = await this.fetchQuote(rawSymbol);
        if (!quote) return null;

        return {
            yahooSymbol: quote.yahooSymbol,
            displayName: quote.displayName,
            context: formatQuoteContext(quote),
            quote,
        };
    }
}

/** @typedef {object} StockQuote */
export default IndianStockQuoteService;
export const indianStockQuoteService = new IndianStockQuoteService();
