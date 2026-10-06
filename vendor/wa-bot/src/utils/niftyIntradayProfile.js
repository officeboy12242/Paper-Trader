/**
 * Real intraday session bars for NIFTY, assembled for Volume Profile / VWAP.
 *
 * Why this file exists: the Auction Market Theory layer was originally fed
 * option-chain rows shaped to look like candles (`{close: strike, volume: OI}`).
 * That yields the OI-weighted average *strike* — a static positioning snapshot,
 * not where the market actually transacted. POC, VAH, VAL and VWAP all mean
 * "where trade happened over time", so they need real intraday bars.
 *
 * ─── The volume problem ──────────────────────────────────────────────────────
 * Yahoo returns ^NSEI 5m bars with volume === 0 on EVERY bar (measured: 0 of 376
 * bars carried volume). An index has no traded volume of its own, so a genuine
 * volume profile on ^NSEI alone is impossible from this source.
 *
 * NIFTYBEES — the NIFTY 50 ETF — trades on the same 5m timestamps and does carry
 * volume (371 of 376 bars). So we take PRICES from the index and VOLUME from the
 * ETF, matched by timestamp. The ETF is a liquid proxy for basket activity, not
 * the index's true turnover, so treat the profile as a good approximation of
 * where activity concentrated rather than an exact market-wide volume profile.
 *
 * If the ETF fetch fails we still return index bars with volume 0. Downstream,
 * buildVolumeProfile() substitutes 1 per bar, which degrades the result to a
 * TPO / time-at-price profile — the original Market Profile construction, and a
 * perfectly sound fallback. `volumeSource` says which one you got, so callers can
 * label the card honestly instead of claiming volume that was not there.
 */

import { fetchYahooIntradayCandles, candlePartsIST } from './yahooIntradayCandles.js';
import { logger } from './logger.js';

const DEFAULT_INDEX = '^NSEI';
const DEFAULT_VOLUME_PROXY = 'NIFTYBEES.NS';

/** 5m bars only change every 5 minutes; /scalp and its 3-min alert scan share this. */
const CACHE_TTL_MS = 150_000;
/** Keyed per index — NIFTY and SENSEX must not share one slot. */
const _cache = new Map();

function istDateKey(ts) {
    const p = candlePartsIST(ts);
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/**
 * Latest completed trading session's 5m bars, price from the index and volume
 * from the ETF proxy.
 *
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<{ bars: object[], sessionDate: string, volumeSource: 'etf-proxy'|'time-at-price' }|null>}
 */
export async function fetchIndexSessionBars({
    index = DEFAULT_INDEX,
    volumeProxy = DEFAULT_VOLUME_PROXY,
    force = false,
} = {}) {
    const cacheKey = `${index}|${volumeProxy}`;
    const hit = _cache.get(cacheKey);
    if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

    let indexBars;
    try {
        indexBars = await fetchYahooIntradayCandles(index, { interval: '5m', range: '5d' });
    } catch (err) {
        logger.warn(`${index} session bars: index fetch failed — ${err.message}`);
        return null;
    }
    if (!indexBars?.length) return null;

    // Volume proxy is best-effort: a failure degrades the profile, never blocks it.
    let volByTs = null;
    try {
        const etf = await fetchYahooIntradayCandles(volumeProxy, { interval: '5m', range: '5d' });
        if (etf?.length) {
            volByTs = new Map();
            for (const b of etf) if (b.volume > 0) volByTs.set(b.ts, b.volume);
        }
    } catch (err) {
        logger.debug(`${index} session bars: volume proxy unavailable — ${err.message}`);
    }

    // Session profile, not a multi-day one: keep only the most recent IST date.
    const sessionDate = istDateKey(indexBars[indexBars.length - 1].ts);
    const sessionBars = indexBars.filter((b) => istDateKey(b.ts) === sessionDate);
    if (!sessionBars.length) return null;

    let matched = 0;
    const bars = sessionBars.map((b) => {
        const v = volByTs?.get(b.ts) || 0;
        if (v > 0) matched++;
        return { ts: b.ts, open: b.open, high: b.high, low: b.low, close: b.close, volume: v };
    });

    // A handful of matched bars is not a volume profile — call it what it is.
    const volumeSource = matched >= Math.max(5, bars.length * 0.5) ? 'etf-proxy' : 'time-at-price';

    const value = { bars, sessionDate, volumeSource, barCount: bars.length, volumeBars: matched, index };
    _cache.set(cacheKey, { at: Date.now(), value });
    return value;
}

/** Back-compat wrapper — NIFTY was the only index when this was written. */
export async function fetchNiftySessionBars(opts = {}) {
    return fetchIndexSessionBars(opts);
}

export function clearNiftySessionBarsCache() {
    _cache.clear();
}
