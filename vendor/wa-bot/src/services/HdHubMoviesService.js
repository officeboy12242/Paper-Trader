/**
 * HDHub4u movie search via free-udemy-courses-bot API.
 * Each result groups all quality/download links under one title (like AtoZ).
 *
 * HDHub4u rows are additionally ENRICHED: intermediate pages (hubcloud/hubcdn/
 * hubdrive) are bypassed into direct server links (R2 / 10Gbps / FSLv2 /
 * PixelDrain / FuckingFast) by HdHubBypassService — in parallel, time-budgeted.
 */

import axios from 'axios';
import { logger } from '../utils/logger.js';
import { audioFromFilename } from '../utils/movieMetadata.js';
import { config } from '../config/config.js';
import { enrichResultsWithDirectLinks } from './HdHubBypassService.js';

const DEFAULT_API_URL = 'https://free-udemy-courses-bot2.onrender.com/api/movies';
const SEARCH_CACHE_MAX = 80;

// Labels produced by the bypass for direct server links
const SERVER_LABEL_RE = /(R2|10Gbps|FSLv2|FuckingFast)/i;
const REAL_SIZE_RE = /\d+(?:\.\d+)?\s*(?:gb|mb)\b/i;

function sourceLabel(raw) {
    const s = String(raw || 'hdhub4u').trim();
    if (!s) return 'HDHub4u';
    if (s.toLowerCase() === 'hdhub4u') return 'HDHub4u';
    return s.charAt(0).toUpperCase() + s.slice(1);
}

function isZipOrPackLink(link) {
    const label = String(link?.label || '');
    const size = String(link?.size || '');
    const quality = String(link?.quality || '');
    const blob = `${label} ${size} ${quality}`;
    return /\bzip\b/i.test(blob) || /\bpack\b/i.test(blob) || /\bfull\s*season\b/i.test(blob);
}

function isNullDropLink(link) {
    return /null-drop\.onrender\.com/i.test(String(link?.url || ''));
}

function isTelegramLink(link) {
    return /(?:^|\.)t\.me\//i.test(String(link?.url || '')) || /telegram/i.test(String(link?.label || ''));
}

/**
 * Prefer season Zip/pack links (often listed after episode links in API).
 * For AtoZ: always keep every NullDrop mirror; drop Telegram when NullDrop exists.
 */
function prioritizeLinks(links, maxLinks, { preferNullDrop = false } = {}) {
    if (!links.length) return links;

    if (preferNullDrop) {
        const nullDrop = links.filter(isNullDropLink);
        let rest = links.filter((l) => !isNullDropLink(l));
        if (nullDrop.length) {
            // Telegram is redundant when NullDrop is present (and eats WhatsApp length)
            rest = rest.filter((l) => !isTelegramLink(l));
        }
        // Never drop NullDrop — raise the cap if needed
        const cap = Math.max(maxLinks, nullDrop.length);
        const room = Math.max(0, cap - nullDrop.length);
        return [...nullDrop, ...rest.slice(0, room)];
    }

    if (links.length <= maxLinks) return links;

    const zips = [];
    const rest = [];
    for (const link of links) {
        if (isZipOrPackLink(link)) zips.push(link);
        else rest.push(link);
    }

    const zipTake = Math.min(zips.length, maxLinks);
    const episodeTake = Math.max(0, maxLinks - zipTake);
    return [...zips.slice(0, zipTake), ...rest.slice(0, episodeTake)];
}

/**
 * Cap an enriched link list for WhatsApp:
 *  - at most `maxServersPerQuality` direct server links per quality entry
 *  - exact-duplicate URLs dropped
 *  - total capped at `maxPerResult` (server links win over leftover mirrors)
 */
function trimEnrichedLinks(links, { maxPerResult = 14, maxServersPerQuality = 2 } = {}) {
    const seen = new Set();
    const out = [];
    let runCount = 0; // consecutive server links for the current quality entry

    for (const link of links) {
        const key = String(link?.url || '');
        if (!key || seen.has(key)) continue;
        const isServer = SERVER_LABEL_RE.test(String(link?.label || ''));

        if (isServer) {
            runCount += 1;
            if (runCount > maxServersPerQuality) continue;
        } else {
            runCount = 0;
        }

        seen.add(key);
        out.push(link);
    }

    if (out.length <= maxPerResult) return out;

    // Over cap: keep all direct server links first, then mirrors in original order
    const servers = out.filter((l) => SERVER_LABEL_RE.test(String(l?.label || '')));
    const mirrors = out.filter((l) => !SERVER_LABEL_RE.test(String(l?.label || '')));
    return [...servers.slice(0, maxPerResult), ...mirrors].slice(0, maxPerResult);
}

function formatLinkEntry(link) {
    const quality = String(link?.quality || '').trim();
    const size = String(link?.size || '').trim();
    const label = String(link?.label || '').trim();
    const url = String(link?.url || '').trim();

    if (!url) return null;

    const isZip = isZipOrPackLink({ label, size, quality });

    let sizeLine;
    if (isZip && size && label) {
        // "Zip [2.14GB] (HubCloud)" + size "2.14GB" → keep label as primary
        sizeLine = label.includes(size) ? label : `${label} • ${size}`;
    } else if (quality && size) {
        sizeLine = `${quality} • ${size}`;
    } else if (quality && label) {
        sizeLine = `${quality} • ${label}`;
    } else if (label) {
        sizeLine = label;
    } else if (size) {
        sizeLine = size;
    } else if (quality) {
        sizeLine = quality;
    } else {
        sizeLine = 'Download';
    }

    return {
        label: label || (isZip ? `Zip${size ? ` [${size}]` : ''}` : ''),
        size: sizeLine,
        audio: link?.audio || audioFromFilename(label || quality || size),
        quality: quality || undefined,
        rawFilename: label || url,
        url,
    };
}

function pageUrlAsLink(pageUrl) {
    const url = String(pageUrl || '').trim();
    if (!url.startsWith('http')) {
        return null;
    }
    return {
        label: 'Movie page',
        size: 'Open page',
        audio: '',
        rawFilename: 'page',
        url,
    };
}

class HdHubMoviesService {
    constructor() {
        this.name = 'HDHub4u';
        /** @type {Map<string, { results: object[], at: number }>} */
        this._searchCache = new Map();
    }

    _requestTimeoutMs() {
        return config.MOVIE_HD_TIMEOUT_MS || 28_000;
    }

    _cacheTtlMs() {
        return config.MOVIE_SEARCH_CACHE_TTL_MS || 5 * 60_000;
    }

    _apiBase() {
        const raw = config.MOVIES_API_URL || DEFAULT_API_URL;
        return String(raw).replace(/\/$/, '');
    }

    /**
     * Resolve intermediate pages (hubcloud/hubcdn/hubdrive) into direct server
     * links (R2 / 10Gbps / FSLv2 / FuckingFast) via the shared bypass enricher.
     */
    async _enrichWithDirectLinks(results, budgetMs) {
        return enrichResultsWithDirectLinks(results, budgetMs);
    }

    async _fetchJson(urlStr) {
        const { data } = await axios.get(urlStr, {
            timeout: this._requestTimeoutMs(),
            headers: {
                Accept: 'application/json',
                'User-Agent': 'Mozilla/5.0 (compatible; SassyBot/1.0)',
            },
            validateStatus: (status) => status >= 200 && status < 300,
        });
        return data;
    }

    _normalizeResults(payload) {
        const rows = Array.isArray(payload?.results) ? payload.results : [];
        const results = [];
        // Episode lists can be long; zip/pack links are prioritized so they are never dropped.
        const maxLinksPerResult = 16;

        for (const row of rows) {
            const title = String(row?.title || '').trim();
            let links = (Array.isArray(row?.links) ? row.links : [])
                .map(formatLinkEntry)
                .filter(Boolean);

            if (!links.length) {
                const pageLink = pageUrlAsLink(row?.page_url);
                if (pageLink) {
                    links = [pageLink];
                }
            }

            if (!title || !links.length) continue;

            const isAtoz = /^atoz$/i.test(String(row?.source || '').trim());
            links = prioritizeLinks(links, maxLinksPerResult, { preferNullDrop: isAtoz });

            results.push({
                title,
                source: sourceLabel(row?.source),
                pageUrl: row?.page_url || null,
                links,
            });
        }

        const rawCount = rows.length;
        if (rawCount && !results.length) {
            logger.warn(`HDHub API: ${rawCount} raw row(s) but none had links or page_url`);
        }

        return results;
    }

    /**
     * Search movies — returns grouped results compatible with MovieController.
     * @param {string} query
     * @param {number} maxResults
     */
    async searchMovies(query, maxResults = 5) {
        const q = String(query || '').trim();
        if (!q) return [];

        const cacheKey = q.toLowerCase();
        const cached = this._searchCache.get(cacheKey);
        if (cached && Date.now() - cached.at < this._cacheTtlMs()) {
            logger.info(`HDHub cache hit for "${q}" (${cached.results.length} results)`);
            return cached.results.slice(0, maxResults);
        }

        const apiUrl = `${this._apiBase()}?q=${encodeURIComponent(q)}`;
        let lastErr = null;

        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const started = Date.now();
                const payload = await this._fetchJson(apiUrl);
                const normalized = this._normalizeResults(payload);
                let results = normalized.slice(0, maxResults);

                // Bypass intermediate pages — but never blow the overall HD timeout:
                // budget = min(bypass budget, remaining time before controller cancels us)
                const elapsed = Date.now() - started;
                const remainMs = this._requestTimeoutMs() - elapsed - 1_500;
                const bypassBudget = Math.min(
                    config.MOVIE_HD_BYPASS_BUDGET_MS || 8_000,
                    Math.max(0, remainMs),
                );
                results = await this._enrichWithDirectLinks(results, bypassBudget);

                logger.info(
                    `HDHub API: ${results.length}/${normalized.length} normalized from `
                        + `${payload?.count ?? payload?.results?.length ?? 0} raw for "${q}" `
                        + `in ${Date.now() - started}ms (attempt ${attempt})`,
                );
                if (results.length) {
                    if (this._searchCache.size >= SEARCH_CACHE_MAX) {
                        this._searchCache.delete(this._searchCache.keys().next().value);
                    }
                    // Cache the enriched results so cache hits serve direct links too
                    this._searchCache.set(cacheKey, { results, at: Date.now() });
                }
                return results;
            } catch (err) {
                lastErr = err;
                const msg = err?.response?.status
                    ? `HTTP ${err.response.status}`
                    : (err?.message || String(err));
                logger.warn(`HDHub movies API attempt ${attempt} failed (${apiUrl}): ${msg}`);
                if (attempt < 2) {
                    await new Promise((r) => setTimeout(r, 1500));
                }
            }
        }

        logger.warn(`HDHub movies API gave up for "${q}": ${lastErr?.message || lastErr}`);
        return [];
    }

    async _headCheck() {
        try {
            const base = this._apiBase().replace(/\/api\/movies$/, '') || 'https://free-udemy-courses-bot2.onrender.com';
            const res = await axios.head(base, { timeout: 8000, validateStatus: () => true });
            return res.status >= 200 && res.status < 400;
        } catch {
            return false;
        }
    }

    startKeepAlive(intervalMs = 4 * 60 * 1000) {
        this.stopKeepAlive();
        const ping = async () => {
            const ok = await this._headCheck();
            if (ok) {
                logger.info(`🏓 HDHub movies API keep-alive OK (${this._apiBase()})`);
            } else {
                logger.warn(`🏓 HDHub movies API keep-alive failed (${this._apiBase()})`);
            }
        };
        void ping();
        this._keepAliveTimer = setInterval(() => { void ping(); }, intervalMs);
    }

    stopKeepAlive() {
        if (this._keepAliveTimer) {
            clearInterval(this._keepAliveTimer);
            this._keepAliveTimer = null;
        }
    }
}

export const hdHubMoviesService = new HdHubMoviesService();
export default HdHubMoviesService;
