/**
 * Expiring movie links: self-hosted /d/:code (7h TTL) → display shortener.
 * Koyeb: zip1.io / clck.ru (TinyURL blocks *.koyeb.app). Render: TinyURL first.
 */

import https from 'https';
import { logger } from './logger.js';
import { isTinyUrlBlockedHost } from './publicBaseUrl.js';
import { LINK_TTL_MS } from '../services/ShortLinkService.js';

const SHORTENER_TIMEOUT_MS = 2500;
const SHORTEN_CONCURRENCY = 14;
/** Hosts we wrap /d/ links with for WhatsApp display (all still expire via /d/ TTL). */
export const DISPLAY_SHORT_RE = /(?:tinyurl\.com|zip1\.io|clck\.ru)\//i;

const KOYEB_DISPLAY_CHAIN = [
    {
        name: 'zip1.io',
        post: true,
        url: 'https://zip1.io/api/create',
        parse: (status, raw) => {
            if (status !== 200) return null;
            try {
                const short = JSON.parse(raw)?.short_url;
                return typeof short === 'string' && short.startsWith('https://zip1.io/') ? short : null;
            } catch {
                return null;
            }
        },
    },
    {
        name: 'clck.ru',
        build: (u) => `https://clck.ru/--?url=${encodeURIComponent(u)}`,
        ok: (status, data) => status === 200 && /^https:\/\/clck\.ru\/\S+/.test(data),
    },
];

// clck.ru is the default everywhere now (TinyURL blocks *.koyeb.app and is
// flaky for movie hosts) — zip1.io stays as the second fallback.
const RENDER_DISPLAY_CHAIN = [
    { name: 'clck.ru', ...KOYEB_DISPLAY_CHAIN[1] },
    KOYEB_DISPLAY_CHAIN[0],
];

const MAX_CACHE_SIZE = 500;
/** Keep display cache under short-link TTL (buffer so display short never outlives /d/). */
const MEMORY_CACHE_TTL_MS = Math.max(60 * 60 * 1000, LINK_TTL_MS - 60 * 60 * 1000);

/** Sticky provider — skip failed ones after first success this process lifetime. */
let _displayProviderHint = null;

function displayChainFor(url) {
    const chain = isTinyUrlBlockedHost(url) ? KOYEB_DISPLAY_CHAIN : RENDER_DISPLAY_CHAIN;
    if (!_displayProviderHint) return chain;
    const hit = chain.find((p) => p.name === _displayProviderHint);
    return hit ? [hit, ...chain.filter((p) => p !== hit)] : chain;
}

async function mapPool(items, fn, concurrency, deadline) {
    const out = new Map();
    let idx = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (idx < items.length) {
            if (deadline && Date.now() >= deadline) return;
            const i = idx++;
            const item = items[i];
            out.set(item, await fn(item));
        }
    });
    await Promise.all(workers);
    return out;
}

class UrlShortener {
    constructor() {
        this._service = null;
        this._cache = new Map();
    }

    setService(service) {
        this._service = service;
    }

    needsShortening(url) {
        if (typeof url !== 'string' || !url.startsWith('http')) return false;
        if (DISPLAY_SHORT_RE.test(url)) return false;
        return true;
    }

    _fetchShortenerApi(apiUrl) {
        return new Promise((resolve, reject) => {
            const parsed = new URL(apiUrl);
            const req = https.request(
                { hostname: parsed.hostname, path: parsed.pathname + parsed.search, method: 'GET' },
                (res) => {
                    let data = '';
                    res.on('data', (c) => { data += c; });
                    res.on('end', () => resolve({ status: res.statusCode, data: data.trim() }));
                },
            );
            req.on('error', reject);
            req.setTimeout(SHORTENER_TIMEOUT_MS, () => {
                req.destroy();
                reject(new Error('shortener timeout'));
            });
            req.end();
        });
    }

    async _callDisplayShortener(provider, targetUrl) {
        if (provider.post) {
            const res = await fetch(provider.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: targetUrl }),
                signal: AbortSignal.timeout(SHORTENER_TIMEOUT_MS),
            });
            const raw = (await res.text()).trim();
            const url = provider.parse(res.status, raw);
            if (url) return url;
            throw new Error(`${provider.name} HTTP ${res.status}`);
        }

        const { status, data } = await this._fetchShortenerApi(provider.build(targetUrl));
        if (provider.ok(status, data)) return data;
        throw new Error(`${provider.name} HTTP ${status}`);
    }

    async _toDisplayShortUrl(url) {
        for (const provider of displayChainFor(url)) {
            try {
                const short = await this._callDisplayShortener(provider, url);
                _displayProviderHint = provider.name;
                return short;
            } catch (err) {
                logger.warn(`${provider.name} failed for ${url.slice(0, 60)}…: ${err.message}`);
            }
        }
        return null;
    }

    /** @deprecated tests stub this — production uses _toDisplayShortUrl */
    async _toTinyUrl(url) {
        return this._toDisplayShortUrl(url);
    }

    _isDisplayShort(url) {
        return typeof url === 'string' && DISPLAY_SHORT_RE.test(url);
    }

    _isExpiringLink(link, original) {
        return typeof link === 'string' && link !== original && /\/d\/[A-Za-z0-9_-]+/.test(link);
    }

    _readCache(original) {
        const cached = this._cache.get(original);
        if (cached && cached.expiresAt > Date.now() && cached.finalUrl) {
            return cached.finalUrl;
        }
        if (cached) this._cache.delete(original);
        return null;
    }

    _writeCache(original, finalUrl, shortMeta) {
        if (finalUrl === original) return;
        if (!this._isDisplayShort(finalUrl) && !finalUrl.includes('/d/')) return;

        const expiresAt = Math.min(
            shortMeta?.expiresAt || Date.now() + MEMORY_CACHE_TTL_MS,
            Date.now() + MEMORY_CACHE_TTL_MS,
        );
        if (this._cache.size >= MAX_CACHE_SIZE) {
            this._cache.delete(this._cache.keys().next().value);
        }
        this._cache.set(original, {
            finalUrl,
            code: shortMeta?.code || null,
            expiresAt,
        });
    }

    async _finalizeShortUrl(original, expiringLink, shortMeta) {
        if (!this._isExpiringLink(expiringLink, original)) {
            logger.warn(
                `No expiring /d/ link for ${original.slice(0, 60)}… — check KOYEB_PUBLIC_DOMAIN / PUBLIC_URL`,
            );
            return original;
        }

        const display = await this._toDisplayShortUrl(expiringLink);
        const finalUrl = display || expiringLink;
        this._writeCache(original, finalUrl, shortMeta);
        return finalUrl;
    }

    async shorten(url) {
        if (!this.needsShortening(url)) return url;

        const hit = this._readCache(url);
        if (hit) return hit;

        let shortMeta = null;
        let expiringLink = url;
        if (this._service) {
            try {
                const minted = await this._service.shorten(url);
                if (typeof minted === 'string') {
                    expiringLink = minted;
                } else if (minted?.url) {
                    expiringLink = minted.url;
                    shortMeta = minted;
                }
            } catch (err) {
                logger.warn(`Expiring link failed: ${err.message}`);
            }
        }

        return this._finalizeShortUrl(url, expiringLink, shortMeta);
    }

    async shortenMovieResults(results, maxMs = 45000) {
        const entries = [];
        for (const item of results) {
            for (const link of item.links || []) {
                if (this.needsShortening(link.url)) {
                    entries.push({ link, original: link.url });
                }
            }
        }
        if (!entries.length) return results;

        const t0 = Date.now();
        const deadline = t0 + maxMs;
        const unique = [...new Set(entries.map((e) => e.original))];

        const mintedMap = new Map();
        if (this._service?.shortenMany) {
            try {
                for (const [k, v] of await this._service.shortenMany(unique)) {
                    mintedMap.set(k, v);
                }
            } catch (err) {
                logger.warn(`Batch /d/ mint failed: ${err.message}`);
            }
        }

        const resolved = await mapPool(
            unique,
            async (original) => {
                const cached = this._readCache(original);
                if (cached) return cached;

                let shortMeta = mintedMap.get(original);
                let expiringLink = shortMeta?.url || original;

                if (!shortMeta && this._service) {
                    try {
                        const minted = await this._service.shorten(original);
                        if (typeof minted === 'string') {
                            expiringLink = minted;
                        } else if (minted?.url) {
                            expiringLink = minted.url;
                            shortMeta = minted;
                        }
                    } catch (err) {
                        logger.warn(`Expiring link failed: ${err.message}`);
                    }
                }

                return this._finalizeShortUrl(original, expiringLink, shortMeta);
            },
            SHORTEN_CONCURRENCY,
            deadline,
        );

        let shortened = 0;
        let failed = 0;
        let skipped = 0;

        for (const { link, original } of entries) {
            const finalUrl = resolved.get(original);
            if (finalUrl) {
                link.url = finalUrl;
                if (this._isDisplayShort(finalUrl) || finalUrl.includes('/d/')) {
                    shortened++;
                } else if (this.needsShortening(finalUrl)) {
                    failed++;
                }
            } else {
                skipped++;
            }
        }

        logger.info(
            `URL shorten done: ${shortened}/${entries.length} short, ${failed} long, ${skipped} skipped (${Date.now() - t0}ms)`,
        );
        return results;
    }
}

export const urlShortener = new UrlShortener();
export default UrlShortener;
