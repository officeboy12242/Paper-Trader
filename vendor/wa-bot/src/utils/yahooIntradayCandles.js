/**
 * Yahoo Finance intraday OHLC candles (NSE via .NS).
 */

import axios from 'axios';
import { logger } from './logger.js';
import { YAHOO_CHART_HOSTS } from './yahooChartFetch.js';

const CHROME_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TIMEOUT_MS = 18_000;

/**
 * @param {string} yahooSymbol e.g. RELIANCE.NS
 * @param {{ interval?: string, range?: string }} opts
 * @returns {Promise<{ ts: number, open: number, high: number, low: number, close: number, volume: number }[]>}
 */
export async function fetchYahooIntradayCandles(yahooSymbol, { interval = '15m', range = '1d' } = {}) {
    let lastErr;
    for (const host of YAHOO_CHART_HOSTS) {
        try {
            const url = `${host}/${encodeURIComponent(yahooSymbol)}`;
            const { data } = await axios.get(url, {
                params: { interval, range, includePrePost: false },
                timeout: TIMEOUT_MS,
                headers: {
                    'User-Agent': CHROME_UA,
                    Accept: 'application/json,text/plain,*/*',
                    'Accept-Language': 'en-IN,en;q=0.9',
                },
            });
            const result = data?.chart?.result?.[0];
            const ts = result?.timestamp || [];
            const q = result?.indicators?.quote?.[0];
            if (!ts.length || !q) {
                lastErr = new Error('empty intraday candles');
                continue;
            }

            const candles = [];
            for (let i = 0; i < ts.length; i++) {
                const open = Number(q.open?.[i]);
                const high = Number(q.high?.[i]);
                const low = Number(q.low?.[i]);
                const close = Number(q.close?.[i]);
                const volume = Number(q.volume?.[i]) || 0;
                // Yahoo pads some series with an all-zero final bar (seen on the
                // 15:15 IST candle for SBIN, HAL and others). Zero is finite, so a
                // plain isFinite check lets it through — and one zero close turns
                // today's change into −100%, flips the trade direction and blows
                // up ATR. Prices are never legitimately ≤ 0.
                if (![open, high, low, close].every((v) => Number.isFinite(v) && v > 0)) continue;
                candles.push({ ts: ts[i] * 1000, open, high, low, close, volume });
            }
            if (candles.length) return candles;
            lastErr = new Error('no valid candles');
        } catch (err) {
            lastErr = err;
            logger.debug(`Yahoo intraday ${yahooSymbol} @ ${host}: ${err.message}`);
        }
    }
    throw lastErr || new Error(`No intraday candles for ${yahooSymbol}`);
}

/** IST wall-clock parts for a candle timestamp. */
export function candlePartsIST(tsMs) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(new Date(tsMs));
    const get = (t) => Number(parts.find((p) => p.type === t)?.value);
    return {
        year: get('year'),
        month: get('month'),
        day: get('day'),
        hour: get('hour'),
        minute: get('minute'),
    };
}

/** First 15m session candle (09:15 IST) = Opening Range. */
export function findOpeningRangeCandle(candles) {
    for (const c of candles || []) {
        const p = candlePartsIST(c.ts);
        if (p.hour === 9 && p.minute === 15) return c;
    }
    return candles?.[0] || null;
}
