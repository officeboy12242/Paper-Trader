/**
 * Shared NSE India HTTP client (cookie session).
 * Cookie warmup uses option-chain page (homepage often 403s).
 */

import axios from 'axios';

const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

const WARMUP_URL = 'https://www.nseindia.com/option-chain';
const DEFAULT_REFERER = 'https://www.nseindia.com/option-chain';

const BASE_HEADERS = {
    'User-Agent': UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: DEFAULT_REFERER,
};

const TIMEOUT_MS = 22_000;
const COOKIE_TTL_MS = 5 * 60 * 1000;

let _cookieCache = { value: '', at: 0 };

export async function getNseCookie({ force = false } = {}) {
    if (!force && _cookieCache.value && Date.now() - _cookieCache.at < COOKIE_TTL_MS) {
        return _cookieCache.value;
    }
    const home = await axios.get(WARMUP_URL, {
        headers: { ...BASE_HEADERS, Accept: 'text/html,application/xhtml+xml' },
        timeout: TIMEOUT_MS,
    });
    const cookie = home.headers['set-cookie']?.map((c) => c.split(';')[0]).join('; ') || '';
    if (cookie) {
        _cookieCache = { value: cookie, at: Date.now() };
    }
    return cookie;
}

function refererForPath(path) {
    const match = path.match(/equity-stockIndices\?index=([^&]+)/);
    if (match) {
        const index = decodeURIComponent(match[1]);
        const encoded = index.replace(/&/g, '%26').replace(/ /g, '%20');
        return `https://www.nseindia.com/market-data/live-equity-market?symbol=${encoded}`;
    }
    return DEFAULT_REFERER;
}

export async function nseGet(path, { cookie, referer } = {}) {
    const c = cookie || (await getNseCookie());
    const ref = referer || refererForPath(path);
    const headers = { ...BASE_HEADERS, Cookie: c, Referer: ref };

    try {
        const { data } = await axios.get(`https://www.nseindia.com/api/${path}`, {
            headers,
            timeout: TIMEOUT_MS,
        });
        return data;
    } catch (err) {
        if (err?.response?.status === 403) {
            const fresh = await getNseCookie({ force: true });
            const { data } = await axios.get(`https://www.nseindia.com/api/${path}`, {
                headers: { ...headers, Cookie: fresh },
                timeout: TIMEOUT_MS,
            });
            return data;
        }
        throw err;
    }
}

export async function nseGetSafe(path) {
    try {
        return await nseGet(path);
    } catch {
        return null;
    }
}
