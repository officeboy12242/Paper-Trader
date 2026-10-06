/**
 * Yahoo Finance chart API — shared by quote service and symbol resolver.
 */

import axios from 'axios';
import { logger } from '../utils/logger.js';

export const YAHOO_CHART_HOSTS = [
    'https://query1.finance.yahoo.com/v8/finance/chart',
    'https://query2.finance.yahoo.com/v8/finance/chart',
];

const CHROME_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const TIMEOUT_MS = 18_000;
const MAX_ATTEMPTS = 3;

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {string} yahooSymbol
 * @returns {Promise<object>}
 */
export async function fetchYahooChartMeta(yahooSymbol) {
    let lastErr;

    for (const host of YAHOO_CHART_HOSTS) {
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            try {
                const url = `${host}/${encodeURIComponent(yahooSymbol)}`;
                const { data } = await axios.get(url, {
                    params: { interval: '1d', range: '5d', includePrePost: false },
                    timeout: TIMEOUT_MS,
                    headers: {
                        'User-Agent': CHROME_UA,
                        Accept: 'application/json,text/plain,*/*',
                        'Accept-Language': 'en-IN,en;q=0.9',
                    },
                });

                const meta = data?.chart?.result?.[0]?.meta;
                if (meta?.regularMarketPrice != null || meta?.previousClose != null) {
                    return meta;
                }
                lastErr = new Error('empty chart meta');
            } catch (err) {
                lastErr = err;
                logger.debug(`Yahoo chart ${yahooSymbol} @ ${host}: ${err.message}`);
                await sleep(400 * (attempt + 1));
            }
        }
    }

    throw lastErr || new Error(`No Yahoo quote for ${yahooSymbol}`);
}

/** @returns {Promise<boolean>} */
export async function yahooSymbolHasQuote(yahooSymbol) {
    try {
        await fetchYahooChartMeta(yahooSymbol);
        return true;
    } catch {
        return false;
    }
}
