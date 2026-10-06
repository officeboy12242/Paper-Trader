/**
 * SENSEX / BANKEX option chain from BSE.
 *
 * This was previously written off: indexUniverse called SENSEX "a BSE index —
 * the NSE option chain does not cover it" and expiryCalendar said BSE "exposes
 * no usable public API". Both are now out of date.
 *
 * The endpoint is DerivOptionChain_IV/w, named in the Angular controller behind
 * beta.bseindia.com's option-chain page:
 *
 *   https://api.bseindia.com/BseIndiaAPI/api/DerivOptionChain_IV/w
 *       ?scrip_cd=1&Expiry=03%20Sep%202026&strprice=
 *
 * Three things make this easy to get wrong, all found the hard way:
 *
 *   1. The old Derivative/getOptionChain/w path 302s to error_Bse.html with
 *      "The Page you are looking for has been moved". It returns HTTP 200, so a
 *      status check passes and the JSON parse is what fails.
 *   2. www.bseindia.com answers "Access Denied" to non-browser clients, which
 *      makes this look like IP blocking. api.bseindia.com is fine.
 *   3. The payload is ASYMMETRIC. Call fields carry a C_ prefix
 *      (C_Last_Trd_Price, C_BidPrice, C_Open_Interest); the put fields for the
 *      same strike are UNPREFIXED (Last_Trd_Price, BidPrice, Open_Interest).
 *      Reading P_* returns zeros for every put and looks like a quiet market
 *      rather than a bug.
 *
 * Expiry must be passed exactly as ddlExpiry returns it ("03 Sep 2026").
 * Reformatting to DD/MM/YYYY makes the request fail.
 *
 * The snapshot shape mirrors NseOptionChainService so downstream consumers do
 * not care which exchange a chain came from.
 */

import axios from 'axios';

import { logger } from '../utils/logger.js';
import {
    DIRECT,
    egressOrder,
    egressRequestConfig,
    egressTimeout,
    egressUrl,
    isBlockError,
    maskProxy,
    noteDirectBlocked,
    noteDirectOk,
    scrubSecrets,
} from '../utils/nseEgress.js';

const API_BASE = 'https://api.bseindia.com/BseIndiaAPI/api';

// Referer/Origin must look like the beta site; the API rejects bare requests.
const HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-IN,en;q=0.9',
    Referer: 'https://beta.bseindia.com/',
    Origin: 'https://beta.bseindia.com',
};

/**
 * Parse BSE's "as on" stamp, e.g. "02 Sep 2026 | 19:01", into a real Date.
 *
 * This matters more than it looks. The chain endpoint keeps serving the last
 * snapshot after the session ends, with no field that says "this is old" other
 * than this string. A premium read straight off it looks live and is not: the
 * 19:01 stamp is a post-close settlement figure, so a 76600 CE quoted at 153.15
 * from that snapshot can sit well away from the broker's screen.
 */
const MONTHS = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

export function parseBseAsOf(stamp) {
    const s = String(stamp || '').trim();
    const m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})\s*\|\s*(\d{1,2}):(\d{2})/);
    if (!m) return null;
    const mon = MONTHS[m[2].toLowerCase()];
    if (mon == null) return null;
    // The stamp is IST wall-clock; build the UTC instant it corresponds to.
    const utcMs = Date.UTC(
        Number(m[3]), mon, Number(m[1]), Number(m[4]), Number(m[5]),
    ) - 5.5 * 3600 * 1000;
    const d = new Date(utcMs);
    return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * How usable a chain snapshot is right now.
 *
 * `live` is only true when the market is open AND the snapshot is recent. Once
 * the session closes the data is legitimately final rather than stale, so it is
 * reported as `closed` — a different thing from a feed that has gone silent
 * mid-session, which is the case worth refusing to trade on.
 *
 * @param {Date|null} asOf
 * @param {Date} [now]
 */
export function chainFreshness(asOf, now = new Date()) {
    if (!asOf) return { state: 'unknown', ageMinutes: null, live: false };

    const ageMinutes = Math.round((now.getTime() - asOf.getTime()) / 60000);
    const mins = istMinutesOf(now);
    const marketOpen = mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30 && isWeekday(now);

    if (!marketOpen) return { state: 'closed', ageMinutes, live: false };
    if (ageMinutes <= 15) return { state: 'live', ageMinutes, live: true };
    return { state: 'stale', ageMinutes, live: false };
}

function istMinutesOf(date) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(date);
    const h = Number(parts.find((p) => p.type === 'hour')?.value || 0);
    const m = Number(parts.find((p) => p.type === 'minute')?.value || 0);
    return h * 60 + m;
}

function isWeekday(date) {
    const wd = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Kolkata', weekday: 'short',
    }).format(date);
    return !['Sat', 'Sun'].includes(wd);
}

/** BSE scrip codes for the index derivatives. */
export const BSE_SCRIP_CODES = { SENSEX: 1, BANKEX: 12 };

const TIMEOUT_MS = 25_000;
const CACHE_TTL_MS = 60_000;
const EXPIRY_TTL_MS = 60 * 60_000;

const chainCache = new Map();
const expiryCache = new Map();

/** Strip thousands separators; empty strings mean "not traded", not zero-ish. */
function num(v) {
    if (v == null || v === '') return null;
    const n = Number(String(v).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
}

/** BSE sends IV to ~14 decimal places; nobody needs that on a phone. */
function pct(v) {
    const n = num(v);
    return n == null ? null : Math.round(n * 100) / 100;
}

function intOrNull(v) {
    const n = num(v);
    return n == null ? null : Math.round(n);
}

/**
 * BSE is stricter about burst traffic than NSE, and a scan can ask for expiries
 * and a chain back to back. One second between calls, as the sibling tgbot2
 * project does.
 */
const MIN_GAP_MS = 1000;
let _lastFetchAt = 0;
async function rateLimit() {
    const wait = MIN_GAP_MS - (Date.now() - _lastFetchAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    _lastFetchAt = Date.now();
}

/**
 * GET from BSE, trying each egress in turn.
 *
 * BSE blocks non-India and cloud IPs, which is how SENSEX "works locally, and is
 * silently missing in production" — this bot runs on Render (Singapore). NSE has
 * had a proxy/ScraperAPI ladder for exactly this; BSE was still direct-only, so
 * a blocked host lost SENSEX entirely with nothing but a debug line. Same ladder,
 * same SCRAPER_API_KEY (country_code=in), shared with tgbot2.
 */
async function bseGet(path, params) {
    // The query has to be baked into the URL: ScraperAPI takes the target as a
    // URL parameter, so an axios `params` object would be attached to the
    // WRAPPER request and never reach BSE.
    const qs = new URLSearchParams(params || {}).toString();
    const target = `${API_BASE}/${path}${qs ? `?${qs}` : ''}`;

    let lastErr;
    for (const egress of egressOrder()) {
        try {
            await rateLimit();
            const { data } = await axios.get(egressUrl(egress, target), {
                timeout: egressTimeout(egress, TIMEOUT_MS),
                headers: HEADERS,
                // BSE sometimes emits a header with trailing whitespace, which
                // Node's strict parser rejects outright: "Parse Error: Unexpected
                // whitespace after header value". It is intermittent, so without
                // this the chain fails at random and an alert silently loses its
                // premium.
                insecureHTTPParser: true,
                // The moved endpoint redirects to an HTML error page; following
                // it and then failing on the parse is more confusing than seeing
                // it here.
                maxRedirects: 3,
                validateStatus: (s) => s >= 200 && s < 400,
                ...egressRequestConfig(egress),
            });
            if (typeof data === 'string') {
                throw new Error('BSE returned HTML (endpoint moved or blocked)');
            }
            if (egress === DIRECT) noteDirectOk();
            return data;
        } catch (err) {
            lastErr = err;
            if (egress === DIRECT && isBlockError(err)) noteDirectBlocked();
            logger.debug(`BSE ${path} via ${egress === DIRECT ? 'direct' : maskProxy(egress)}: ${scrubSecrets(err.message)}`);
        }
    }
    throw lastErr || new Error(`BSE ${path}: every egress failed`);
}

/**
 * Expiries for a BSE index, nearest first.
 * @param {number} scripCd
 * @returns {Promise<string[]>} e.g. ['03 Sep 2026', '10 Sep 2026']
 */
export async function fetchBseExpiries(scripCd = 1) {
    const hit = expiryCache.get(scripCd);
    if (hit && Date.now() - hit.at < EXPIRY_TTL_MS) return hit.value;

    try {
        const data = await bseGet('ddlExpiry/w', {
            scrip_cd: String(scripCd),
            ProductType: 'IO',
        });
        const rows = data?.Table;
        if (!Array.isArray(rows)) return [];
        // The field is spelled eXPIRY in BSE's payload.
        const out = rows
            .map((r) => String(r?.eXPIRY || r?.Expiry || r?.EXPIRY || '').trim())
            .filter(Boolean);
        if (out.length) expiryCache.set(scripCd, { at: Date.now(), value: out });
        return out;
    } catch (err) {
        logger.debug(`BSE expiries ${scripCd}: ${err.message}`);
        return [];
    }
}

/**
 * Option chain snapshot for a BSE index.
 *
 * @param {string} [symbol] SENSEX or BANKEX
 * @param {string} [expiry] defaults to the nearest
 * @returns {Promise<object|null>} snapshot matching NseOptionChainService's shape
 */
export async function fetchBseOptionChain(symbol = 'SENSEX', expiry = null) {
    const key = String(symbol || '').toUpperCase();
    const scripCd = BSE_SCRIP_CODES[key];
    if (!scripCd) {
        logger.debug(`BSE chain: unknown symbol ${symbol}`);
        return null;
    }

    const cacheKey = `${key}:${expiry || 'near'}`;
    const hit = chainCache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

    let useExpiry = expiry;
    if (!useExpiry) {
        const expiries = await fetchBseExpiries(scripCd);
        useExpiry = expiries[0];
    }
    if (!useExpiry) return null;

    let data;
    try {
        data = await bseGet('DerivOptionChain_IV/w', {
            scrip_cd: String(scripCd),
            Expiry: useExpiry, // exactly as BSE gave it; do not reformat
            strprice: '',
        });
    } catch (err) {
        logger.warn(`BSE option chain ${key}: ${err.message}`);
        return null;
    }

    const rows = data?.Table;
    if (!Array.isArray(rows) || !rows.length) return null;

    let spot = null;
    const strikes = [];
    let totalCeOi = 0;
    let totalPeOi = 0;

    for (const r of rows) {
        const strike = intOrNull(r?.Strike_Price);
        if (!strike) continue;
        // The underlying is repeated on every row rather than sent once.
        if (spot == null) spot = num(r?.UlaValue);

        const ceOi = intOrNull(r?.C_Open_Interest);
        const peOi = intOrNull(r?.Open_Interest);
        totalCeOi += ceOi || 0;
        totalPeOi += peOi || 0;

        strikes.push({
            strike,
            ce: {
                ltp: num(r?.C_Last_Trd_Price),
                bid: num(r?.C_BidPrice),
                ask: num(r?.C_OfferPrice),
                oi: ceOi,
                changeOi: intOrNull(r?.C_Absolute_Change_OI),
                iv: pct(r?.C_IV),
                volume: intOrNull(r?.C_Vol_Traded),
                symbol: r?.C_Series_Code || '',
            },
            // Unprefixed half of the same row.
            pe: {
                ltp: num(r?.Last_Trd_Price),
                bid: num(r?.BidPrice),
                ask: num(r?.OfferPrice),
                oi: peOi,
                changeOi: intOrNull(r?.Absolute_Change_OI),
                iv: pct(r?.IV),
                volume: intOrNull(r?.Vol_Traded),
                symbol: r?.p_Series_Code || '',
            },
        });
    }

    if (!strikes.length) return null;
    strikes.sort((a, b) => a.strike - b.strike);

    const atm = spot
        ? strikes.reduce((best, s) =>
              Math.abs(s.strike - spot) < Math.abs(best.strike - spot) ? s : best,
          )
        : null;

    const asOf = parseBseAsOf(data?.ASON?.DT_TM);
    const fresh = chainFreshness(asOf);

    const snapshot = {
        symbol: key,
        exchange: 'BSE',
        type: 'Index',
        expiry: useExpiry,
        spot,
        pcr: totalCeOi > 0 ? Number((totalPeOi / totalCeOi).toFixed(2)) : null,
        strikes,
        totalCeOi,
        totalPeOi,
        atmStrike: atm?.strike ?? null,
        atmCe: atm?.ce ?? null,
        atmPe: atm?.pe ?? null,
        chainTimestamp: data?.ASON?.DT_TM?.trim() || null,
        asOf: asOf ? asOf.toISOString() : null,
        // Callers must be able to tell a live quote from a settlement figure.
        freshness: fresh.state,
        ageMinutes: fresh.ageMinutes,
        isLive: fresh.live,
        fetchedAt: new Date().toISOString(),
    };

    chainCache.set(cacheKey, { at: Date.now(), value: snapshot });
    return snapshot;
}

/**
 * Nearest strike on the requested side that trades within a premium band.
 *
 * Untraded strikes carry a null LTP rather than 0, so they are skipped instead
 * of being treated as free.
 *
 * @param {object} snapshot
 * @param {'CE'|'PE'} side
 * @param {{ minPremium?: number, maxPremium?: number }} [opts]
 */
export function pickStrike(snapshot, side = 'CE', opts = {}) {
    if (!snapshot?.strikes?.length || !snapshot.spot) return null;
    const min = opts.minPremium ?? 0;
    const max = opts.maxPremium ?? Number.POSITIVE_INFINITY;
    const leg = side === 'PE' ? 'pe' : 'ce';

    const usable = snapshot.strikes.filter((s) => {
        const ltp = s[leg]?.ltp;
        return Number.isFinite(ltp) && ltp >= min && ltp <= max;
    });
    if (!usable.length) return null;

    return usable.reduce((best, s) =>
        Math.abs(s.strike - snapshot.spot) < Math.abs(best.strike - snapshot.spot)
            ? s
            : best,
    );
}

export function _resetBseChainCache() {
    chainCache.clear();
    expiryCache.clear();
}

export default {
    fetchBseOptionChain,
    fetchBseExpiries,
    pickStrike,
    parseBseAsOf,
    chainFreshness,
    BSE_SCRIP_CODES,
};
