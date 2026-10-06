/**
 * Live price feed for open positions and pending orders.
 *
 * Uses the original WA-BOT Yahoo candle fetcher at 1-minute resolution. Bars
 * (not just last price) are used so a stop that was traded through between two
 * polls is still detected, and a restart can replay everything it missed.
 *
 * Connection state:
 *   CONNECTED     last request succeeded
 *   DEGRADED      1-4 consecutive failures (retrying)
 *   DISCONNECTED  5+ consecutive failures; every poll still retries (reconnect)
 */

import { fetchYahooIntradayCandles } from '../../vendor/wa-bot/src/utils/yahooIntradayCandles.js';
import { normalizeYahooSymbol } from '../../vendor/wa-bot/src/services/IndianStockQuoteService.js';
import { sessionDate } from './clock.js';
import { fetchGoldSpotCandles } from './deltaGold.js';
import { SpotSocket } from './spotSocket.js';

/** Spot symbols resolve to Delta India series (Yahoo has no intraday for
 * XAUUSD and a fixed ticker for ETHUSD spot is spottier than Delta's). */
const SPOT_TICKERS = new Map([
    ['XAUUSD', 'XAUTUSD'],
    ['GOLD', 'XAUTUSD'],
    ['ETHUSD', 'ETHUSD'],
    ['ETH', 'ETHUSD'],
]);

const isSpot = (symbol) => SPOT_TICKERS.has(String(symbol).toUpperCase());
const toYahoo = (symbol) => (isSpot(symbol) ? null : normalizeYahooSymbol(symbol));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class MarketDataService {
    /**
     * @param {object} opts
     * @param {object} opts.cfg
     * @param {import('../logger.js').Logger} opts.logger
     * @param {Function} [opts.fetchCandles] injectable for tests
     * @param {() => number} [opts.now]
     */
    constructor({ cfg, logger, fetchCandles = fetchYahooIntradayCandles, now = Date.now, retries = 2, retryDelayMs = 600 }) {
        this.cfg = cfg;
        this.logger = logger;
        this.fetchCandles = fetchCandles;
        this.now = now;
        this.retries = retries;
        this.retryDelayMs = retryDelayMs;
        this.consecutiveFailures = 0;
        this.lastSuccess = null;
        this.lastError = null;
        this.state = 'CONNECTED';
        /** @type {Map<string, { price: number, barTs: number, fetchedAt: number }>} */
        this.quotes = new Map();
        this.spotSocket = null;
    }

    /** Start the real-time spot ticker socket (gold/ETH). No-op when disabled. */
    startSpotSocket() {
        if (!this.cfg.SPOT_SOCKET_ENABLED) return;
        if (this.spotSocket) return;
        this.spotSocket = new SpotSocket({ logger: this.logger, now: () => this.now() });
        this.spotSocket.start();
    }

    stopSpotSocket() {
        this.spotSocket?.close();
        this.spotSocket = null;
    }

    _recordSuccess() {
        if (this.state !== 'CONNECTED') this.logger.info('MARKET', 'RECONNECTED', `price feed restored after ${this.consecutiveFailures} failure(s)`);
        this.consecutiveFailures = 0;
        this.lastSuccess = this.now();
        this.state = 'CONNECTED';
    }

    _recordFailure(err, symbol) {
        this.consecutiveFailures += 1;
        this.lastError = { at: this.now(), message: String(err?.message || err), symbol };
        const prev = this.state;
        this.state = this.consecutiveFailures >= 5 ? 'DISCONNECTED' : 'DEGRADED';
        if (prev !== this.state) {
            this.logger.warn('MARKET', this.state, `price feed ${this.state.toLowerCase()}: ${this.lastError.message}`);
        }
    }

    /**
     * 1-minute bars for one IST session (or continuous across days when
     * `continuous` is set), oldest first.
     * @returns {Promise<{ ts: number, open: number, high: number, low: number, close: number, volume: number }[]>}
     */
    async getBars(symbol, { session = sessionDate(this.now()), continuous = false, range = null } = {}) {
        const today = sessionDate(this.now());
        // 1m history on Yahoo goes back ~7 days; '1d' is enough for the live session.
        const r = range || (continuous || session !== today ? '5d' : '1d');
        let lastErr = null;
        for (let attempt = 0; attempt <= this.retries; attempt++) {
            try {
                const raw = isSpot(symbol)
                    ? await fetchGoldSpotCandles(SPOT_TICKERS.get(String(symbol).toUpperCase()), { interval: '1m', range: r })
                    : await this.fetchCandles(toYahoo(symbol), { interval: '1m', range: r });
                const bars = normalizeBars(continuous ? (raw || []) : (raw || []).filter((b) => sessionDate(b.ts) === session));
                this._recordSuccess();
                const last = bars[bars.length - 1];
                if (last) this.quotes.set(symbol, { price: last.close, barTs: last.ts, fetchedAt: this.now() });
                return bars;
            } catch (err) {
                lastErr = err;
                if (attempt < this.retries) await sleep(this.retryDelayMs * (attempt + 1));
            }
        }
        this._recordFailure(lastErr, symbol);
        this.logger.warn('MARKET', 'API FAILURE', `${symbol}: ${lastErr?.message || lastErr}`);
        throw lastErr || new Error(`no bars for ${symbol}`);
    }

    lastQuote(symbol) {
        return this.quotes.get(symbol) || null;
    }

    /** Real-time quote pushed by the spot WebSocket (overrides bar polling). */
    setSpotQuote(symbol, price, ts = this.now()) {
        this.quotes.set(symbol, { price, barTs: ts, fetchedAt: this.now() });
    }

    /** Latest live-ticker quote from the spot socket, or null. */
    spotQuote(symbol) {
        return this.spotSocket?.quote(symbol) || null;
    }

    /** Record a live quote (used by option-premium and gold/eth monitors). */
    setQuote(symbol, price, barTs = this.now()) {
        this.quotes.set(symbol, { price, barTs, fetchedAt: this.now() });
    }

    isStale(symbol) {
        const q = this.quotes.get(symbol);
        if (!q) return true;
        return this.now() - q.barTs > this.cfg.STALE_PRICE_SECONDS * 1000;
    }

    status() {
        return {
            state: this.state,
            consecutiveFailures: this.consecutiveFailures,
            lastSuccess: this.lastSuccess,
            lastError: this.lastError,
            symbolsTracked: this.quotes.size,
        };
    }
}

const r2 = (n) => Math.round(n * 100) / 100;

/**
 * Align bars to minute boundaries and merge duplicates.
 *
 * Yahoo stamps the still-forming 1m bar with the last trade time (e.g. 11:45:26)
 * and the same minute later arrives aligned (11:45:00). Without alignment the
 * finished bar would sort before a cursor set from the forming one and be skipped.
 */
export function normalizeBars(raw) {
    const byMinute = new Map();
    for (const b of [...raw].sort((a, c) => a.ts - c.ts)) {
        const ts = Math.floor(b.ts / 60_000) * 60_000;
        const prev = byMinute.get(ts);
        if (!prev) {
            byMinute.set(ts, { ts, open: r2(b.open), high: r2(b.high), low: r2(b.low), close: r2(b.close), volume: b.volume || 0 });
        } else {
            prev.high = Math.max(prev.high, r2(b.high));
            prev.low = Math.min(prev.low, r2(b.low));
            prev.close = r2(b.close);
            prev.volume = Math.max(prev.volume, b.volume || 0);
        }
    }
    return [...byMinute.values()].sort((a, c) => a.ts - c.ts);
}

/** Run `worker` over `items` with at most `limit` in flight. Errors are returned, not thrown. */
export async function mapPool(items, limit, worker) {
    const out = new Array(items.length);
    let next = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            try {
                out[i] = { ok: true, value: await worker(items[i], i) };
            } catch (error) {
                out[i] = { ok: false, error };
            }
        }
    });
    await Promise.all(runners);
    return out;
}
