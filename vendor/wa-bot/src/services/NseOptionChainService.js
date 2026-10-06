/**
 * Live NSE option chain (v3 API) — PCR, OI, IV, top CE/PE strikes.
 */

import axios from 'axios';
import { logger } from '../utils/logger.js';
import { stockSymbolResolverService } from './StockSymbolResolverService.js';
import { niftyTraderChainService } from './NiftyTraderChainService.js';
import {
    DIRECT,
    egressOrder,
    egressRequestConfig,
    egressTimeout,
    egressUrl,
    isBlockError,
    scrubSecrets,
    maskProxy,
    noteDirectBlocked,
    noteDirectOk,
} from '../utils/nseEgress.js';

/**
 * Browser-consistent header set, matching what the jugaad-data Python client
 * sends — that client keeps working against NSE from hosts where our old
 * headers were being challenged.
 *
 * The point is internal consistency, not any single header: NSE's WAF
 * fingerprints the whole request. Claiming to be Chrome in the User-Agent while
 * sending none of the Sec-CH-UA / Sec-Fetch-* client hints a real Chrome always
 * sends is a giveaway, and it was earning us the HTML challenge page. Keep the
 * Chrome version in UA and Sec-CH-UA in step if you bump either.
 */
const UA =
    'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.6998.166 Safari/537.36';

const WARMUP_URL = 'https://www.nseindia.com/get-quotes/equity?symbol=LT';

const BASE_HEADERS = {
    Host: 'www.nseindia.com',
    Referer: 'https://www.nseindia.com/get-quotes/equity?symbol=SBIN',
    'X-Requested-With': 'XMLHttpRequest',
    pragma: 'no-cache',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'User-Agent': UA,
    'Sec-CH-UA': '"Google Chrome";v="134", "Chromium";v="134", "Not?A_Brand";v="99"',
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': '"Windows"',
    DNT: '1',
    'Upgrade-Insecure-Requests': '1',
    Accept: '*/*',
    'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
};

const TIMEOUT_MS = 22_000;
const COOKIE_TTL_MS = 5 * 60 * 1000;

/** Oldest cached chain still worth serving when NSE is unreachable. */
const CHAIN_STALE_MS = 60 * 60 * 1000;
const CHAIN_CACHE_MAX = 64;

/** symbol -> { at, result } */
const _chainCache = new Map();

export function _resetChainCache() {
    _chainCache.clear();
}
const NSE_MAX_RETRIES = 3;
const NSE_RETRY_DELAY_MS = 2000;

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

const INDEX_SYMBOLS = new Set([
    'NIFTY',
    'BANKNIFTY',
    'FINNIFTY',
    'MIDCPNIFTY',
    'NIFTYIT',
    'NIFTYNXT50',
]);

/**
 * Cookies are keyed by egress: NSE ties its session to the requesting IP, so a
 * cookie obtained directly is rejected when replayed through a proxy (and vice
 * versa). One cache entry and one warm-up lock per egress.
 */
const _cookieCaches = new Map();   // egress -> { value, at }
const _cookieLocks = new Map();    // egress -> Promise

export function _resetCookies() {
    _cookieCaches.clear();
    _cookieLocks.clear();
}

async function getNseCookie(egress) {
    const prev = _cookieLocks.get(egress) || Promise.resolve();
    const run = prev.then(async () => {
        const cached = _cookieCaches.get(egress);
        if (cached?.value && Date.now() - cached.at < COOKIE_TTL_MS) {
            return cached.value;
        }
        // Warm up on the same page jugaad-data uses. NSE hands out its session
        // cookies here; hitting the API without them earns a challenge page.
        const home = await axios.get(egressUrl(egress, WARMUP_URL), {
            headers: {
                ...BASE_HEADERS,
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'sec-fetch-dest': 'document',
                'sec-fetch-mode': 'navigate',
                'sec-fetch-site': 'none',
            },
            timeout: egressTimeout(egress, TIMEOUT_MS),
            ...egressRequestConfig(egress),
        });
        const cookie = home.headers['set-cookie']?.map((c) => c.split(';')[0]).join('; ') || '';
        if (cookie) {
            _cookieCaches.set(egress, { value: cookie, at: Date.now() });
        }
        return cookie;
    });
    _cookieLocks.set(egress, run.then(() => undefined, () => undefined));
    return run;
}

async function nseGet(path, cookie, egress) {
    const res = await axios.get(egressUrl(egress, `https://www.nseindia.com/api/${path}`), {
        headers: { ...BASE_HEADERS, Cookie: cookie },
        timeout: egressTimeout(egress, TIMEOUT_MS),
        validateStatus: (s) => s >= 200 && s < 400,
        ...egressRequestConfig(egress),
    });

    // NSE rotates session cookies on API responses too. A real browser session
    // carries those forward; dropping them makes later calls look stale.
    const rotated = res.headers?.['set-cookie'];
    if (rotated?.length) {
        const merged = new Map(
            String(cookie || '')
                .split('; ')
                .filter(Boolean)
                .map((c) => [c.split('=')[0], c])
        );
        for (const c of rotated) {
            const pair = c.split(';')[0];
            merged.set(pair.split('=')[0], pair);
        }
        _cookieCaches.set(egress, { value: [...merged.values()].join('; '), at: Date.now() });
    }

    const data = res.data;
    // NSE sometimes returns HTML (rate-limit page) instead of JSON
    if (typeof data === 'string' && (data.includes('<!DOCTYPE') || data.includes('<html'))) {
        throw new Error('NSE returned HTML (rate limit / bot detection)');
    }
    return data;
}

function resolveNseType(nseSymbol) {
    const s = String(nseSymbol || '').trim().toUpperCase().replace(/\.NS$/, '');
    if (INDEX_SYMBOLS.has(s) || s === 'NIFTY50') return 'Indices';
    return 'Equity';
}

function topStrikes(rows, leg, n = 5) {
    const list = [];
    for (const row of rows) {
        const legData = row[leg];
        const oi = legData?.openInterest || 0;
        if (!oi) continue;
        list.push({
            strike: row.strikePrice,
            oi,
            changeOi: legData.changeinOpenInterest ?? 0,
            pChangeOi: legData.pchangeinOpenInterest ?? null,
            iv: legData.impliedVolatility ?? null,
            ltp: legData.lastPrice ?? null,
            volume: legData.totalTradedVolume ?? null,
        });
    }
    list.sort((a, b) => b.oi - a.oi);
    return list.slice(0, n);
}

function findAtmRow(rows, spot) {
    if (!rows?.length || spot == null) return null;
    return rows.reduce((best, row) => {
        if (!best) return row;
        return Math.abs(row.strikePrice - spot) < Math.abs(best.strikePrice - spot) ? row : best;
    }, null);
}

function formatLegLine(label, item) {
    const coi =
        item.pChangeOi != null
            ? `, COI ${item.changeOi >= 0 ? '+' : ''}${item.changeOi} (${item.pChangeOi.toFixed(1)}%)`
            : '';
    const iv = item.iv != null ? `, IV ${item.iv}%` : '';
    const ltp = item.ltp != null ? `, LTP ₹${item.ltp}` : '';
    return `  ${label} ${item.strike}: OI ${item.oi}${coi}${iv}${ltp}`;
}

class NseOptionChainService {
    /** One full chain fetch over a single egress (direct or one proxy). */
    async _fetchViaEgress(nseSymbol, type, egress) {
        let lastErr = null;
        for (let attempt = 1; attempt <= NSE_MAX_RETRIES; attempt++) {
            try {
                const cookie = await getNseCookie(egress);
                const contract = await nseGet(`option-chain-contract-info?symbol=${nseSymbol}`, cookie, egress);
                const expiries = contract?.expiryDates || contract?.records?.expiryDates;
                const expiry = expiries?.[0];
                if (!expiry) {
                    logger.debug(`NSE option chain: no expiry for ${nseSymbol}`);
                    return null;
                }

                const chain = await nseGet(
                    `option-chain-v3?type=${type}&symbol=${encodeURIComponent(nseSymbol)}&expiry=${encodeURIComponent(expiry)}`,
                    cookie,
                    egress
                );

                const records = chain?.records;
                const rows = records?.data;
                if (!rows?.length) return null;

                // Success — build and return the result
                return this._buildResult(nseSymbol, type, chain, rows);
            } catch (err) {
                lastErr = err;
                const retryable = /rate limit|429|bot detection|HTML|ECONNRESET|ETIMEDOUT|timeout/i.test(err.message);
                logger.warn(
                    `NSE option chain attempt ${attempt}/${NSE_MAX_RETRIES} for ${nseSymbol} `
                    + `via ${maskProxy(egress)}: ${scrubSecrets(err.message)}`
                );
                if (retryable && attempt < NSE_MAX_RETRIES) {
                    const delay = NSE_RETRY_DELAY_MS * attempt;
                    logger.debug(`Retrying NSE in ${delay}ms…`);
                    await sleep(delay);
                    // Invalidate this egress's cookie so the next try re-warms.
                    if (/rate limit|429|bot detection|HTML/i.test(err.message)) {
                        _cookieCaches.delete(egress);
                    }
                    continue;
                }
                throw err;
            }
        }
        throw lastErr || new Error('NSE option chain failed after retries');
    }

    /**
     * Fetch a chain, trying each configured egress in turn.
     *
     * NSE blocks foreign datacenter IPs, so when the bot's own address is
     * refused we fall through to India-resident proxies (NSE_PROXY_URL). A
     * direct block is remembered so later calls try proxies first instead of
     * paying the timeout every time.
     */
    async _fetchChainForNse(nseSymbol, type) {
        const egresses = egressOrder();
        let lastErr = null;

        for (const egress of egresses) {
            try {
                const result = await this._fetchViaEgress(nseSymbol, type, egress);
                if (egress === DIRECT) noteDirectOk();
                if (result) {
                    if (egress !== DIRECT) {
                        logger.info(`NSE option chain for ${nseSymbol} served via ${maskProxy(egress)}`);
                    }
                    return result;
                }
                // A clean "no data" (e.g. symbol has no F&O) is not an egress
                // problem — trying another IP would return the same thing.
                return null;
            } catch (err) {
                lastErr = err;
                if (egress === DIRECT && isBlockError(err)) noteDirectBlocked();
                if (egresses.length > 1) {
                    logger.warn(`NSE egress ${maskProxy(egress)} failed for ${nseSymbol}: ${scrubSecrets(err.message)}`);
                }
            }
        }

        if (lastErr) throw lastErr;
        return null;
    }

    /**
     * Build the context + snapshot from raw NSE chain data.
     */
    _buildResult(nseSymbol, type, chain, rows) {
        const records = chain?.records;
        const expiry = (chain?.records?.expiryDates || [])[0] || records?.expiry || '';
        const spot = records?.underlyingValue ?? records?.underlying ?? null;
        let totalCeOi = 0;
        let totalPeOi = 0;
        for (const row of rows) {
            totalCeOi += row.CE?.openInterest || 0;
            totalPeOi += row.PE?.openInterest || 0;
        }
        const pcr = totalCeOi ? totalPeOi / totalCeOi : null;

        const topCe = topStrikes(rows, 'CE');
        const topPe = topStrikes(rows, 'PE');
        const atm = findAtmRow(rows, spot);

        const lines = [];
        lines.push(`Symbol: ${nseSymbol} (${type})`);
        lines.push(`Expiry: ${expiry}`);
        if (spot != null) lines.push(`NSE underlying: ${spot}`);
        if (pcr != null) lines.push(`PCR (Put OI / Call OI): ${pcr.toFixed(2)}`);
        lines.push(`Total Call OI: ${totalCeOi} | Total Put OI: ${totalPeOi}`);

        if (atm) {
            const ce = atm.CE;
            const pe = atm.PE;
            lines.push(`ATM strike: ${atm.strikePrice}`);
            if (ce) {
                lines.push(
                    `  ATM CE: OI ${ce.openInterest ?? 'n/a'}, IV ${ce.impliedVolatility ?? 'n/a'}%, LTP ₹${ce.lastPrice ?? 'n/a'}, COI ${ce.changeinOpenInterest ?? 'n/a'}`
                );
            }
            if (pe) {
                lines.push(
                    `  ATM PE: OI ${pe.openInterest ?? 'n/a'}, IV ${pe.impliedVolatility ?? 'n/a'}%, LTP ₹${pe.lastPrice ?? 'n/a'}, COI ${pe.changeinOpenInterest ?? 'n/a'}`
                );
            }
        }

        lines.push('Top Call (CE) OI strikes:');
        if (topCe.length) {
            for (const item of topCe) lines.push(formatLegLine('CE', item));
        } else {
            lines.push('  n/a');
        }

        lines.push('Top Put (PE) OI strikes:');
        if (topPe.length) {
            for (const item of topPe) lines.push(formatLegLine('PE', item));
        } else {
            lines.push('  n/a');
        }

        const atmCe = atm?.CE
            ? {
                  strike: atm.strikePrice,
                  ltp: atm.CE.lastPrice ?? null,
                  oi: atm.CE.openInterest ?? null,
                  iv: atm.CE.impliedVolatility ?? null,
                  changeOi: atm.CE.changeinOpenInterest ?? null,
              }
            : null;
        const atmPe = atm?.PE
            ? {
                  strike: atm.strikePrice,
                  ltp: atm.PE.lastPrice ?? null,
                  oi: atm.PE.openInterest ?? null,
                  iv: atm.PE.impliedVolatility ?? null,
                  changeOi: atm.PE.changeinOpenInterest ?? null,
              }
            : null;

        const strikes = rows
            .map((row) => ({
                strike: row.strikePrice,
                ce: row.CE ? { ltp: row.CE.lastPrice ?? null, oi: row.CE.openInterest ?? null, iv: row.CE.impliedVolatility ?? null } : null,
                pe: row.PE ? { ltp: row.PE.lastPrice ?? null, oi: row.PE.openInterest ?? null, iv: row.PE.impliedVolatility ?? null } : null,
            }))
            .filter((s) => Number.isFinite(s.strike));

        return {
            context: lines.join('\n'),
            snapshot: {
                symbol: nseSymbol,
                type,
                expiry,
                spot,
                pcr,
                strikes,
                totalCeOi,
                totalPeOi,
                topCe,
                topPe,
                atmStrike: atm?.strikePrice ?? null,
                atmCe,
                atmPe,
                chainTimestamp: records?.timestamp || null,
                fetchedAt: new Date().toISOString(),
            },
        };
    }

    /**
     * @param {string} rawSymbol
     * @returns {Promise<{ context: string, snapshot: object } | null>}
     */
    /**
     * @param {string} rawSymbol
     * @param {object} [opts]
     * @param {boolean} [opts.allowStale=false]
     *   Serve the last cached chain when NSE is unreachable.
     *   OFF BY DEFAULT, and it must stay that way for anything that prices a
     *   trade. Option premiums move every tick: handing a cached LTP to entry
     *   pricing or to the position tracker's target/stop-loss checks silently
     *   quotes a price that no longer exists. Only advisory surfaces that
     *   render the stale banner may opt in.
     * @param {number} [opts.maxAgeMs=0]
     *   Reuse a cached chain this recent instead of refetching. Also 0 by
     *   default for the same reason — dedup is the caller's business.
     */
    async fetchOptionContext(rawSymbol, { allowStale = false, maxAgeMs = 0 } = {}) {
        const userSymbol = String(rawSymbol || '').trim().toUpperCase();
        if (!userSymbol) return null;

        if (maxAgeMs > 0) {
            const fresh = this._cacheGet(userSymbol, maxAgeMs);
            if (fresh) return fresh;
        }

        try {
            let mapping = await stockSymbolResolverService.resolve(userSymbol);
            let nseSymbol = mapping.nseSymbol;
            let type = resolveNseType(nseSymbol);

            let result = await this._fetchChainForNse(nseSymbol, type);
            if (result) return this._cachePut(userSymbol, result);

            mapping = await stockSymbolResolverService.resolve(userSymbol, {
                forceRefresh: true,
                optionChainFailed: true,
                attemptedNse: nseSymbol,
            });
            if (mapping.nseSymbol && mapping.nseSymbol !== nseSymbol) {
                nseSymbol = mapping.nseSymbol;
                type = resolveNseType(nseSymbol);
                result = await this._fetchChainForNse(nseSymbol, type);
                if (result) return this._cachePut(userSymbol, result);
            }
        } catch (err) {
            logger.warn(`NSE option chain failed for ${rawSymbol}: ${scrubSecrets(err.message)}`);
        }

        // NSE refused us on every egress. Try the second source before giving
        // up: it is live data (not cache), so pricing callers may use it — but
        // it is tagged source:'niftytrader' and its premiums can differ from
        // NSE's by a couple of rupees, so cards are expected to say where it
        // came from.
        try {
            const alt = await niftyTraderChainService.fetchOptionContext(userSymbol);
            if (alt?.snapshot?.strikes?.length) {
                logger.warn(
                    `NSE unreachable for ${userSymbol} — using niftytrader fallback `
                    + `(spot ${alt.snapshot.spot}, expiry ${alt.snapshot.expiry})`
                );
                return this._cachePut(userSymbol, alt, { source: 'niftytrader' });
            }
        } catch (err) {
            logger.warn(`niftytrader fallback failed for ${userSymbol}: ${scrubSecrets(err.message)}`);
        }

        // Both sources are down. Only advisory callers that display the
        // staleness may fall back to cache; pricing callers get null and skip,
        // exactly as they did before caching existed — a wrong premium is
        // worse than none.
        if (allowStale) {
            const stale = this._cacheGet(userSymbol, CHAIN_STALE_MS, { markStale: true });
            if (stale) {
                logger.warn(
                    `NSE option chain for ${userSymbol} unavailable — serving cached chain `
                    + `from ${stale.snapshot.ageSec}s ago (advisory only)`
                );
                return stale;
            }
        }
        return null;
    }

    /** @returns {{context,snapshot}|null} */
    _cacheGet(symbol, maxAgeMs, { markStale = false } = {}) {
        const hit = _chainCache.get(symbol);
        if (!hit) return null;
        const ageMs = Date.now() - hit.at;
        if (ageMs > maxAgeMs) return null;

        const ageSec = Math.round(ageMs / 1000);
        const snapshot = { ...hit.result.snapshot, ageSec, stale: markStale };
        const context = markStale
            ? `${hit.result.context}\n\n[cached chain — ${ageSec}s old, NSE unreachable right now]`
            : hit.result.context;
        return { context, snapshot };
    }

    _cachePut(symbol, result, { source = 'nse' } = {}) {
        _chainCache.set(symbol, { at: Date.now(), result });
        // Bound the cache; the bot scans a lot of symbols over a session.
        if (_chainCache.size > CHAIN_CACHE_MAX) {
            const oldest = [..._chainCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
            if (oldest) _chainCache.delete(oldest[0]);
        }
        return {
            context: result.context,
            snapshot: { ...result.snapshot, ageSec: 0, stale: false, source: result.snapshot.source || source },
        };
    }
}

/**
 * Live premium for one strike out of a snapshot.
 * @param {object|null} snapshot from fetchOptionContext
 * @param {number} strike
 * @param {'CE'|'PE'} side
 * @returns {{ ltp: number|null, iv: number|null, oi: number|null }|null}
 */
export function findStrikeLeg(snapshot, strike, side) {
    const row = (snapshot?.strikes || []).find((s) => Number(s.strike) === Number(strike));
    if (!row) return null;
    return (String(side).toUpperCase() === 'PE' ? row.pe : row.ce) || null;
}

export const nseOptionChainService = new NseOptionChainService();
export default NseOptionChainService;
