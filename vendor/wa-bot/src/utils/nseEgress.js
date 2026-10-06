/**
 * Egress routing for NSE India requests.
 *
 * NSE blocks and bot-challenges foreign datacenter IPs, so the bot's own
 * address (Render runs in `singapore`) frequently gets an HTML challenge page
 * instead of JSON. Routing those requests through an India-resident proxy
 * makes NSE see a domestic IP.
 *
 * Configure with env:
 *   NSE_PROXY_URL   comma-separated proxy URLs, tried in order. Any scheme
 *                   proxy-agent understands: http://, https://, socks5://,
 *                   socks4://, with optional user:pass@ credentials.
 *                   e.g. "http://user:pass@1.2.3.4:8080,socks5://5.6.7.8:1080"
 *   NSE_PROXY_MODE  auto (default) — try direct first, fall back to proxies,
 *                                    and prefer proxies for a while after a
 *                                    direct block (avoids paying the timeout
 *                                    on every call once we know we're blocked)
 *                   always        — never go direct
 *                   off           — never use proxies
 */

import { createRequire } from 'module';
import { logger } from './logger.js';

const require = createRequire(import.meta.url);

/** Signatures that mean "NSE refused us", as opposed to a transient error. */
const BLOCK_PATTERN = /rate limit|bot detection|HTML|403|401|429|ECONNREFUSED|EAI_AGAIN/i;

/** How long a direct-egress block is remembered before we retry direct. */
const DIRECT_BLOCK_TTL_MS = 30 * 60 * 1000;

export const DIRECT = 'direct';
/** Egress token for the ScraperAPI URL-wrapping service. */
export const SCRAPERAPI = 'scraperapi';
const SCRAPER_API_URL = 'https://api.scraperapi.com';

/**
 * Rewrite a target URL for an egress that fetches on our behalf.
 * Proxy egresses leave the URL alone; ScraperAPI wraps it.
 */
export function egressUrl(egress, url, cfg = {}) {
    if (egress !== SCRAPERAPI) return url;
    const key = (cfg.scraperKey ?? process.env.SCRAPER_API_KEY ?? '').trim();
    if (!key) return url;
    const q = new URLSearchParams({ api_key: key, url, country_code: 'in' });
    return `${SCRAPER_API_URL}?${q.toString()}`;
}

/** ScraperAPI fetches the page itself, so it needs a longer ceiling. */
export function egressTimeout(egress, baseMs) {
    return egress === SCRAPERAPI ? Math.max(baseMs, 70_000) : baseMs;
}

let _agentCache = new Map();
let _directBlockedAt = 0;

/** Reset memoised state — for tests. */
export function _resetEgressState() {
    _agentCache = new Map();
    _directBlockedAt = 0;
}

export function isBlockError(err) {
    return BLOCK_PATTERN.test(String(err?.message || err));
}

function parseProxyList(raw) {
    return String(raw || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

/**
 * Build the ordered list of egresses to try for one request.
 * @param {{ proxyUrls?: string, mode?: string }} [cfg]
 * @returns {string[]} e.g. ['direct', 'http://…'] — DIRECT means no proxy
 */
export function egressOrder(cfg = {}) {
    const proxies = parseProxyList(cfg.proxyUrls ?? process.env.NSE_PROXY_URL);

    // ScraperAPI fetches the target from an India IP (country_code=in). It is
    // a URL-wrapping API rather than an HTTP proxy, so it gets its own egress
    // token and is handled in egressRequestConfig/egressUrl. Same env var name
    // as the sibling tgbot2 project, so one key serves both.
    const scraperKey = (cfg.scraperKey ?? process.env.SCRAPER_API_KEY ?? '').trim();
    if (scraperKey) proxies.push(SCRAPERAPI);

    const mode = String(cfg.mode ?? process.env.NSE_PROXY_MODE ?? 'auto').toLowerCase();

    if (mode === 'off' || !proxies.length) return [DIRECT];
    if (mode === 'always') return proxies;

    // auto: skip the direct attempt while a recent block is still remembered,
    // so we don't burn a full timeout per call on a blocked host.
    const directRecentlyBlocked = Date.now() - _directBlockedAt < DIRECT_BLOCK_TTL_MS;
    return directRecentlyBlocked ? [...proxies, DIRECT] : [DIRECT, ...proxies];
}

/** Remember that the bot's own IP is being refused, so proxies go first. */
export function noteDirectBlocked() {
    if (!_directBlockedAt) {
        logger.warn('NSE refused our direct IP — preferring proxies for the next 30 min');
    }
    _directBlockedAt = Date.now();
}

export function noteDirectOk() {
    _directBlockedAt = 0;
}

/**
 * Axios request config for one egress. Returns {} for DIRECT.
 * Agents are cached — building one per request leaks sockets.
 */
export function egressRequestConfig(egress) {
    // ScraperAPI is reached over a normal connection — the routing lives in the
    // wrapped URL, not in an agent.
    if (!egress || egress === DIRECT || egress === SCRAPERAPI) return {};

    let agent = _agentCache.get(egress);
    if (!agent) {
        try {
            // Required lazily so a missing/broken proxy dep can never stop the
            // bot from booting — it just means no proxy support.
            const { ProxyAgent } = require('proxy-agent');
            /* eslint-disable-next-line new-cap */
            agent = new ProxyAgent({ getProxyForUrl: () => egress });
            _agentCache.set(egress, agent);
        } catch (err) {
            logger.warn(`Proxy agent unavailable for ${maskProxy(egress)}: ${err?.message || err}`);
            return {};
        }
    }
    // `proxy: false` stops axios also applying its own env-based proxy handling.
    return { httpAgent: agent, httpsAgent: agent, proxy: false };
}

/**
 * Strip credentials out of a message before logging it.
 *
 * The ScraperAPI key travels inside the request URL, so any error that echoes
 * the URL (DNS failures, some axios messages) would otherwise write the key
 * straight into the log file.
 */
export function scrubSecrets(text) {
    return String(text ?? '')
        .replace(/api_key=[^&\s"']+/gi, 'api_key=***')
        .replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, '//***:***@');
}

/** Hide credentials before a proxy URL reaches the logs. */
export function maskProxy(url) {
    if (!url || url === DIRECT) return DIRECT;
    if (url === SCRAPERAPI) return 'scraperapi(in)';
    try {
        const u = new URL(url);
        if (u.username || u.password) {
            u.username = '***';
            u.password = '';
        }
        return u.toString();
    } catch {
        return '(proxy)';
    }
}

export default { egressOrder, egressRequestConfig, noteDirectBlocked, noteDirectOk, isBlockError, maskProxy, DIRECT };
