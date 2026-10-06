/**
 * Spot gold (XAUTUSD) 1-minute candles from Delta Exchange India's public
 * REST API. Yahoo has no intraday series for XAUUSD=X, and GC=F is a futures
 * price, so this is the live spot-gold feed for the paper strategies.
 *
 * GET https://api.india.delta.exchange/v2/history/candles?symbol=XAUTUSD&resolution=1m&start&end
 * Returns up to 4000 bars, NEWEST FIRST: [{close, high, low, open, time, volume}].
 */

import axios from 'axios';

const BASE = 'https://api.india.delta.exchange/v2/history/candles';

const rangeToMs = (range) => {
    if (range === '1d') return 24 * 3600_000;
    if (range === '5d') return 5 * 24 * 3600_000;
    if (typeof range === 'number') return range;
    return 24 * 3600_000;
};

/** Compatible with the vendor fetchYahooIntradayCandles return shape. */
export async function fetchGoldSpotCandles(symbol = 'XAUTUSD', { interval = '1m', range = '1d' } = {}) {
    if (interval !== '1m') throw new Error('delta gold feed only serves 1m bars');
    const end = Math.floor(Date.now() / 1000);
    const start = end - Math.floor(rangeToMs(range) / 1000);
    const url = `${BASE}?symbol=${symbol}&resolution=1m&start=${start}&end=${end}`;
    const { data } = await axios.get(url, { timeout: 15_000 });
    if (!data?.success) throw new Error(`delta gold feed: ${data?.error || 'bad response'}`);
    return (data.result || [])
        .map((b) => ({ ts: b.time * 1000, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 }))
        .sort((a, b) => a.ts - b.ts);
}
