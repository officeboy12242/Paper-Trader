/**
 * Yahoo Finance daily OHLCV candles (NSE via .NS) for swing scans.
 *
 * Daily bars only change once per session, so results are memoised per trading
 * day. A ~200 symbol scan is ~200 requests on the first run of the day and
 * near-zero afterwards.
 */

import axios from 'axios';
import { logger } from './logger.js';
import { YAHOO_CHART_HOSTS } from './yahooChartFetch.js';
import { getTodayDateStrIST } from './dateIST.js';

const CHROME_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TIMEOUT_MS = 20_000;

/** @type {Map<string, { day: string, candles: object[], meta: object }>} */
const _dayCache = new Map();

export function clearDailyCandleCache() {
    _dayCache.clear();
}

/**
 * @param {string} yahooSymbol e.g. RELIANCE.NS
 * @param {{ range?: string, force?: boolean }} [opts]
 * @returns {Promise<{ candles: { ts: number, open: number, high: number, low: number, close: number, volume: number }[], meta: object }>}
 */
export async function fetchYahooDailyCandles(yahooSymbol, { range = '2y', force = false } = {}) {
    const day = getTodayDateStrIST();
    const key = `${yahooSymbol}:${range}`;
    if (!force) {
        const hit = _dayCache.get(key);
        if (hit && hit.day === day) return { candles: hit.candles, meta: hit.meta };
    }

    let lastErr;
    for (const host of YAHOO_CHART_HOSTS) {
        try {
            const { data } = await axios.get(`${host}/${encodeURIComponent(yahooSymbol)}`, {
                params: { interval: '1d', range, includePrePost: false },
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
                lastErr = new Error('empty daily candles');
                continue;
            }

            const candles = [];
            for (let i = 0; i < ts.length; i++) {
                const open = Number(q.open?.[i]);
                const high = Number(q.high?.[i]);
                const low = Number(q.low?.[i]);
                const close = Number(q.close?.[i]);
                const volume = Number(q.volume?.[i]) || 0;
                // Yahoo pads holidays and the not-yet-formed session with nulls, and
                // Number(null) is 0 — which Number.isFinite accepts. An all-zero bar
                // reads as a -100% move: it flips direction, inflates ATR, and makes
                // the outcome resolver grade every open long as a stop-out. Require
                // positive prices, not merely finite ones.
                if (![open, high, low, close].every((v) => Number.isFinite(v) && v > 0)) continue;
                candles.push({ ts: ts[i] * 1000, open, high, low, close, volume });
            }

            if (candles.length) {
                const meta = result.meta || {};
                _dayCache.set(key, { day, candles, meta });
                return { candles, meta };
            }
            lastErr = new Error('no valid daily candles');
        } catch (err) {
            lastErr = err;
            logger.debug(`Yahoo daily ${yahooSymbol} @ ${host}: ${err.message}`);
        }
    }
    throw lastErr || new Error(`No daily candles for ${yahooSymbol}`);
}

/** Never throws — returns null so one dead symbol cannot abort a universe scan. */
export async function fetchYahooDailyCandlesSafe(yahooSymbol, opts) {
    try {
        return await fetchYahooDailyCandles(yahooSymbol, opts);
    } catch {
        return null;
    }
}
