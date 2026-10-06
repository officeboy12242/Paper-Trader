/**
 * Mkvbase vault API — our own Render service (harvested mkvbase link vault).
 * GET /links?q=<term>&limit=<n> returns newest-first rows from MongoDB.
 * Results are pinned FIRST in /movie output, ahead of the scraped sources.
 *
 * Env:
 *   MKVBASE_API_URL  (default https://pro-movieapidrive.onrender.com)
 *   MKVBASE_API_KEY  (optional — sent as X-API-Key when the API gains auth)
 */

import axios from 'axios';
import { logger } from '../utils/logger.js';
import { audioFromFilename, qualityFromFilename } from '../utils/movieMetadata.js';

const DEFAULT_BASE_URL = 'https://pro-movieapidrive.onrender.com';
const REQUEST_TIMEOUT = 6000;
const SEARCH_CACHE_MAX = 200;
const SEARCH_CACHE_TTL_MS = 60 * 1000;
const MAX_LINKS_PER_TITLE = 8;
const SIZE_RE = /(\d+(?:\.\d+)?\s?(?:GB|MB))\b/i;

/** File size embedded in the title ("1.4GB"), when the source lists one. */
function sizeFromTitle(title) {
    const m = SIZE_RE.exec(String(title || ''));
    return m ? m[1].replace(/\s+/, ' ') : '';
}

class MkvbaseService {
    constructor() {
        this.name = 'Mkvbase';
        /** @type {Map<string, { results: Array, at: number }>} */
        this._searchCache = new Map();
        this._keepAliveTimer = null;
    }

    _apiBase() {
        return (process.env.MKVBASE_API_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    }

    _headers() {
        const key = process.env.MKVBASE_API_KEY;
        return key ? { 'X-API-Key': key } : {};
    }

    async _fetchJson(url) {
        const { data } = await axios.get(url, {
            timeout: REQUEST_TIMEOUT,
            headers: { Accept: 'application/json', ...this._headers() },
            validateStatus: (s) => s >= 200 && s < 300,
        });
        return data;
    }

    /** Word-overlap score of a title against the query (0..1). */
    _score(title, words) {
        if (!words.length) return 0;
        const t = String(title || '').toLowerCase();
        let hits = 0;
        for (const w of words) {
            if (t.includes(w)) hits++;
        }
        return hits / words.length;
    }

    /**
     * Group flat vault rows ({id,title,url,created_at,status}) into
     * MovieController-compatible grouped results, best-matching titles first.
     * @param {object} payload raw /links JSON
     * @param {string} query
     */
    _normalizeResults(payload, query) {
        const rows = Array.isArray(payload?.results) ? payload.results : [];
        const words = String(query || '')
            .toLowerCase()
            .split(/\s+/)
            .map((w) => w.replace(/[^a-z0-9]/g, ''))
            .filter((w) => w.length > 2);

        const byTitle = new Map();
        for (const row of rows) {
            if (!row?.url) continue;
            const title = String(row.title || row.url).trim() || 'Unknown';
            if (!byTitle.has(title)) byTitle.set(title, []);
            byTitle.get(title).push(row);
        }

        const results = [];
        for (const [title, links] of byTitle) {
            // Active links first; user-reported dead ones kept but demoted.
            const active = links.filter((l) => String(l.status ?? '1') !== '0');
            const dead = links.filter((l) => String(l.status) === '0');
            const ordered = [...active, ...dead].slice(0, MAX_LINKS_PER_TITLE);
            if (!ordered.length) continue;

            const quality = qualityFromFilename(title);
            const fileSize = sizeFromTitle(title);
            results.push({
                title,
                source: 'ProNooB Drive',
                links: ordered.map((row) => ({
                    size: quality && fileSize ? `${quality} • ${fileSize}` : (quality || fileSize),
                    audio: audioFromFilename(title),
                    url: row.url,
                    rawFilename: title,
                })),
            });
        }

        results.sort((a, b) => this._score(b.title, words) - this._score(a.title, words));
        return results;
    }

    /**
     * Search the vault API — grouped results compatible with MovieController.
     * @param {string} query
     * @param {number} maxResults
     */
    async searchMovies(query, maxResults = 5) {
        const q = String(query || '').trim();
        if (!q) return [];

        const cacheKey = q.toLowerCase();
        const cached = this._searchCache.get(cacheKey);
        if (cached && Date.now() - cached.at < SEARCH_CACHE_TTL_MS) {
            logger.info(`Mkvbase cache hit for "${q}" (${cached.results.length} results)`);
            return cached.results.slice(0, maxResults);
        }

        const limit = Math.min(100, Math.max(20, maxResults * 10));
        const url = `${this._apiBase()}/links?q=${encodeURIComponent(q)}&limit=${limit}`;

        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const started = Date.now();
                const payload = await this._fetchJson(url);
                const normalized = this._normalizeResults(payload, q);
                const results = normalized.slice(0, maxResults);
                logger.info(
                    `Mkvbase API: ${results.length}/${normalized.length} grouped from ` +
                        `${payload?.count ?? payload?.results?.length ?? 0} rows for "${q}" ` +
                        `in ${Date.now() - started}ms (attempt ${attempt})`,
                );
                if (normalized.length) {
                    if (this._searchCache.size >= SEARCH_CACHE_MAX) {
                        this._searchCache.delete(this._searchCache.keys().next().value);
                    }
                    this._searchCache.set(cacheKey, { results: normalized, at: Date.now() });
                }
                return results;
            } catch (err) {
                const msg = err?.response?.status
                    ? `HTTP ${err.response.status}`
                    : (err?.message || String(err));
                logger.warn(`Mkvbase API attempt ${attempt} failed (${url}): ${msg}`);
                if (attempt < 2) {
                    await new Promise((r) => setTimeout(r, 1200));
                }
            }
        }

        logger.warn('Mkvbase API gave up (vault offline?) — falling through to scraped sources');
        return [];
    }

    async _headCheck() {
        try {
            const res = await axios.get(`${this._apiBase()}/health`, {
                timeout: 8000,
                headers: this._headers(),
                validateStatus: () => true,
            });
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
                logger.info(`🏓 Mkvbase API keep-alive OK (${this._apiBase()})`);
            } else {
                logger.warn(`🏓 Mkvbase API keep-alive failed (${this._apiBase()})`);
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

export const mkvbaseService = new MkvbaseService();
