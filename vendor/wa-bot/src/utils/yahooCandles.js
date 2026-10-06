/**
 * Intraday OHLC candles from Yahoo's chart API.
 *
 * yahooChartFetch.js only returns `meta` (last price, previous close), which is
 * enough for a quote but not for anything that reads price *action*. The
 * liquidity sweep needs the bars themselves: where price wicked, where it
 * closed, and in what order.
 *
 * Yahoo caps intraday history — roughly 60 days at 5m — and returns nulls for
 * halted or untraded bars, which are dropped here so callers never index into a
 * hole.
 */

import axios from 'axios';

import { logger } from './logger.js';
import { YAHOO_CHART_HOSTS } from './yahooChartFetch.js';

const CHROME_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

const TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 2;

/**
 * @typedef {{ t: Date, o: number, h: number, l: number, c: number, v: number }} Candle
 */

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch intraday candles for a Yahoo symbol.
 *
 * @param {string} yahooSymbol e.g. '^BSESN'
 * @param {{ interval?: string, range?: string }} [opts]
 * @returns {Promise<Candle[]>} chronological; empty array when unavailable
 */
export async function fetchYahooCandles(yahooSymbol, opts = {}) {
    const interval = opts.interval || '5m';
    const range = opts.range || '5d';
    let lastErr;

    for (const host of YAHOO_CHART_HOSTS) {
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
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
                const stamps = result?.timestamp;
                const q = result?.indicators?.quote?.[0];
                if (!Array.isArray(stamps) || !q) {
                    lastErr = new Error('no candle arrays');
                    continue;
                }

                const out = [];
                for (let i = 0; i < stamps.length; i++) {
                    const o = q.open?.[i];
                    const h = q.high?.[i];
                    const l = q.low?.[i];
                    const c = q.close?.[i];
                    // Yahoo pads halted or untraded bars with null. Keeping them
                    // would put holes in the middle of a pattern scan.
                    if (o == null || h == null || l == null || c == null) continue;
                    out.push({
                        t: new Date(stamps[i] * 1000),
                        o: Number(o),
                        h: Number(h),
                        l: Number(l),
                        c: Number(c),
                        v: Number(q.volume?.[i] ?? 0),
                    });
                }
                if (out.length) return out;
                lastErr = new Error('all candles null');
            } catch (err) {
                lastErr = err;
                if (attempt < MAX_ATTEMPTS - 1) await sleep(400 * (attempt + 1));
            }
        }
    }

    logger.debug(`yahooCandles ${yahooSymbol}: ${lastErr?.message || 'unavailable'}`);
    return [];
}

/**
 * Wilder-style ATR over the candle array.
 *
 * Returned per-index so a scan can read the ATR that was current at the bar it
 * is judging, rather than today's ATR applied to last week's bar.
 *
 * @param {Candle[]} candles
 * @param {number} [period]
 * @returns {number[]} same length as `candles`; NaN until the period fills
 */
export function computeAtrSeries(candles, period = 14) {
    const out = new Array(candles.length).fill(NaN);
    if (candles.length < period + 1) return out;

    const tr = new Array(candles.length).fill(NaN);
    for (let i = 1; i < candles.length; i++) {
        const c = candles[i];
        const prevClose = candles[i - 1].c;
        tr[i] = Math.max(
            c.h - c.l,
            Math.abs(c.h - prevClose),
            Math.abs(c.l - prevClose),
        );
    }

    let sum = 0;
    for (let i = 1; i <= period; i++) sum += tr[i];
    out[period] = sum / period;
    for (let i = period + 1; i < candles.length; i++) {
        out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
    }
    return out;
}

/** IST calendar day key for a candle, so sessions can be split. */
export function istDayKey(date) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(date);
}

/** Minutes since midnight IST — used for session-window gating. */
export function istMinutes(date) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).formatToParts(date);
    const h = Number(parts.find((p) => p.type === 'hour')?.value || 0);
    const m = Number(parts.find((p) => p.type === 'minute')?.value || 0);
    return h * 60 + m;
}

export default { fetchYahooCandles, computeAtrSeries, istDayKey, istMinutes };
