/**
 * India VIX — the real one.
 *
 * /scalp hardcoded `vix: 13` at five call sites, which froze 20% of every
 * confidence score. VIX is not a constant: measured 52-week range on ^INDIAVIX
 * is 8.86 to 28.91, and it read 11.34 at the time this was written.
 *
 * TICKER CHOICE MATTERS. Yahoo answers two symbols and they disagree badly:
 *
 *   ^INDIAVIX     name "INDIA VIX", exchange NSE, currency INR,
 *                 52w 8.86-28.91, price 11.34 / prevClose 10.68   <- real
 *   INDIAVIX.NS   no name, no currency, 52w 0-0, price == prevClose (18.53)
 *
 * The second looks live and is a stale placeholder. Reading it would have put
 * VIX ~7 points too high and flipped the low-vol/high-vol regime call every day,
 * which is worse than the hardcode it replaces.
 *
 * Returns null rather than a made-up number when the fetch fails: a caller that
 * knows VIX is unavailable can neutralise that term, while a silent default
 * reintroduces exactly the constant this exists to remove.
 */

import { fetchYahooChartMeta } from '../utils/yahooChartFetch.js';
import { logger } from '../utils/logger.js';

const VIX_SYMBOL = '^INDIAVIX';
/** VIX moves slowly enough that a 5-minute read is live for a scalp card. */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Observed 52-week bounds, used to reject a garbage print rather than trade on it. */
export const VIX_FLOOR = 5;
export const VIX_CEILING = 60;

let _cache = { at: 0, value: null };

export function _resetVixCache() {
    _cache = { at: 0, value: null };
}

/**
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<number|null>} live India VIX, or null if unavailable
 */
export async function fetchIndiaVix({ force = false } = {}) {
    if (!force && _cache.value != null && Date.now() - _cache.at < CACHE_TTL_MS) {
        return _cache.value;
    }
    try {
        const meta = await fetchYahooChartMeta(VIX_SYMBOL);
        const raw = Number(meta?.regularMarketPrice ?? meta?.previousClose);
        if (!Number.isFinite(raw) || raw < VIX_FLOOR || raw > VIX_CEILING) {
            logger.warn(`India VIX out of range (${raw}) — ignoring`);
            return null;
        }
        _cache = { at: Date.now(), value: raw };
        return raw;
    } catch (err) {
        logger.debug(`India VIX fetch failed: ${err.message}`);
        return null;
    }
}

/**
 * Volatility fit for a setup type, 0-100.
 *
 * The old pair of formulas were asymmetric and unbounded in opposite directions:
 *   directional  min(100, (vix - 10) * 8)      -> NEGATIVE below vix 10
 *   theta        max(0, 100 - (vix - 12) * 5)  -> ABOVE 100 below vix 12
 * Across the real 8.86-28.91 range that gave directional -9..100 against theta
 * 103..16, so theta out-scored directional almost everywhere regardless of the
 * actual regime. This is the same judgement — high vol suits buying direction,
 * low vol suits selling premium — expressed symmetrically and bounded.
 *
 * @param {number|null} vix
 * @param {'theta'|'directional'} kind
 * @returns {number|null} null when VIX is unknown, so the caller can drop the term
 */
export function vixFitScore(vix, kind) {
    if (!Number.isFinite(vix)) return null;
    const LOW = 10;
    const HIGH = 25;
    const norm = Math.max(0, Math.min(1, (vix - LOW) / (HIGH - LOW)));
    return Math.round((kind === 'theta' ? 1 - norm : norm) * 100);
}

export default { fetchIndiaVix, vixFitScore, _resetVixCache };
