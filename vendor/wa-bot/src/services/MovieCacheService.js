/**
 * Persistent movie search cache — stores original download links in MongoDB.
 * Fuzzy lookup + stale-while-revalidate for fast repeat searches.
 */

import { logger } from '../utils/logger.js';
import { config } from '../config/config.js';

export function normalizeMovieQuery(query) {
    return String(query || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function compactMovieQuery(query) {
    return normalizeMovieQuery(query).replace(/\s+/g, '');
}

function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function linkKey(link) {
    return String(link?.url || '').trim().toLowerCase();
}

/** Display shorts + /d/ codes expire — never persist them in the vault. */
export function isEphemeralDisplayUrl(url) {
    const u = String(url || '');
    if (/(?:tinyurl\.com|zip1\.io|clck\.ru|is\.gd|v\.gd)\//i.test(u)) return true;
    if (/\/d\/[A-Za-z0-9_-]+/i.test(u)) return true;
    return false;
}

/** Drop expired-prone display shorts; keep host originals only. */
export function sanitizeMovieResults(results) {
    return (results || [])
        .map((item) => {
            if (!item?.title) return null;
            const links = (item.links || []).filter(
                (l) => l?.url && !isEphemeralDisplayUrl(l.url)
            );
            return { ...item, links };
        })
        .filter((item) => item && item.links.length > 0);
}

function resultKey(item) {
    const title = String(item?.title || '').trim().toLowerCase();
    const source = String(item?.source || '').trim().toLowerCase();
    return `${source}::${title}`;
}

/** Deep clone so URL shortening never mutates cached originals. */
export function cloneMovieResults(results) {
    return sanitizeMovieResults(JSON.parse(JSON.stringify(results || [])));
}

export function mergeMovieResults(existing = [], incoming = []) {
    const byKey = new Map();

    for (const item of sanitizeMovieResults([...(existing || []), ...(incoming || [])])) {
        if (!item?.title) continue;
        const key = resultKey(item);
        const prev = byKey.get(key);
        if (!prev) {
            byKey.set(key, {
                title: item.title,
                source: item.source,
                links: [...(item.links || [])],
            });
            continue;
        }

        const seen = new Set((prev.links || []).map(linkKey));
        for (const link of item.links || []) {
            const k = linkKey(link);
            if (!k || seen.has(k) || isEphemeralDisplayUrl(link.url)) continue;
            seen.add(k);
            prev.links.push(link);
        }
    }

    return [...byKey.values()];
}

function docToEntry(doc, query, { fuzzy = false } = {}) {
    const ageMs = Date.now() - new Date(doc.last_fetched_at || doc.created_at || 0).getTime();
    const freshMs = config.MOVIE_CACHE_FRESH_MS || 24 * 60 * 60 * 1000;
    const staleMs = config.MOVIE_CACHE_STALE_MS || 7 * 24 * 60 * 60 * 1000;
    const fresh = ageMs <= freshMs;
    const stale = ageMs <= staleMs;

    return {
        query: doc.query_display || query,
        queryKey: doc.query_key,
        results: cloneMovieResults(doc.results),
        sources: doc.sources || [],
        fresh,
        stale: !fresh && stale,
        fuzzy,
        ageMs,
        ageHours: Math.round(ageMs / (60 * 60 * 1000)),
        hitCount: doc.hit_count || 0,
    };
}

class MovieCacheService {
    constructor() {
        this.collection = null;
        /** @type {Map<string, Promise<void>>} */
        this._refreshInFlight = new Map();
    }

    async init(mongoDb) {
        this.collection = mongoDb.collection('movie_search_cache');
        await Promise.all([
            this.collection.createIndex({ query_key: 1 }, { unique: true, name: 'movie_cache_query' }),
            this.collection.createIndex({ query_compact: 1 }, { name: 'movie_cache_compact' }),
            this.collection.createIndex({ last_fetched_at: -1 }, { name: 'movie_cache_fetched' }),
            this.collection.createIndex({ hit_count: -1 }, { name: 'movie_cache_hits' }),
        ]);

        await this._ensureTtlIndex();

        // Backfill compact keys for older vault rows
        const missing = await this.collection
            .find({ query_compact: { $exists: false } }, { projection: { query_key: 1 } })
            .limit(500)
            .toArray();
        for (const row of missing) {
            if (!row.query_key) continue;
            await this.collection.updateOne(
                { _id: row._id },
                { $set: { query_compact: compactMovieQuery(row.query_key) } },
            );
        }

        logger.info('Movie vault ready (fuzzy + stale-while-revalidate)');
    }

    _freshMs() {
        return config.MOVIE_CACHE_FRESH_MS || 24 * 60 * 60 * 1000;
    }

    _staleMs() {
        return config.MOVIE_CACHE_STALE_MS || 7 * 24 * 60 * 60 * 1000;
    }

    _ttlMs() {
        return config.MOVIE_CACHE_TTL_MS || 2 * 24 * 60 * 60 * 1000;
    }

    /**
     * Hard 2-day expiry via MongoDB TTL index on expire_at.
     * The TTL monitor runs every ~60s and removes expired docs server-side,
     * so the vault self-clears even across restarts and idle periods.
     */
    async _ensureTtlIndex() {
        try {
            const ttlSeconds = Math.floor(this._ttlMs() / 1000);
            await this.collection.createIndex(
                { expire_at: 1 },
                { name: 'movie_cache_ttl', expireAfterSeconds: 0, sparse: true },
            );
            // Stamp expire_at on legacy rows that predate the TTL field.
            const res = await this.collection.updateMany(
                { expire_at: { $exists: false } },
                [{ $set: {
                    expire_at: { $add: [
                        { $toDate: '$last_fetched_at' },
                        ttlSeconds * 1000,
                    ] },
                } }],
            );
            if (res?.modifiedCount) {
                logger.info(`Movie vault TTL: stamped expire_at on ${res.modifiedCount} legacy row(s)`);
            }
        } catch (err) {
            logger.warn(`Movie vault TTL index setup failed: ${err?.message || err}`);
        }
    }

    _revalidateMs() {
        return config.MOVIE_CACHE_REVALIDATE_MS || 6 * 60 * 60 * 1000;
    }

    enabled() {
        return config.MOVIE_CACHE_ENABLED !== false;
    }

    shouldRevalidate(entry) {
        if (!entry) return false;
        return entry.ageMs >= this._revalidateMs();
    }

    _staleCutoff() {
        return new Date(Date.now() - this._staleMs());
    }

    async _findDoc(query) {
        const queryKey = normalizeMovieQuery(query);
        const queryCompact = compactMovieQuery(query);
        if (!queryKey) return null;

        const staleCutoff = this._staleCutoff();

        let doc = await this.collection.findOne({
            query_key: queryKey,
            last_fetched_at: { $gte: staleCutoff },
            result_count: { $gt: 0 },
        });
        if (doc?.results?.length) return { doc, fuzzy: false };

        if (queryCompact.length >= 3) {
            doc = await this.collection.findOne({
                query_compact: queryCompact,
                last_fetched_at: { $gte: staleCutoff },
                result_count: { $gt: 0 },
            });
            if (doc?.results?.length) return { doc, fuzzy: true };
        }

        const words = queryKey.split(' ').filter((w) => w.length > 2);
        if (words.length >= 1) {
            const pattern = words.map((w) => `(?=.*${escapeRegex(w)})`).join('');
            doc = await this.collection.findOne({
                query_key: { $regex: pattern, $options: 'i' },
                last_fetched_at: { $gte: staleCutoff },
                result_count: { $gt: 0 },
            });
            if (doc?.results?.length) return { doc, fuzzy: true };
        }

        return null;
    }

    /**
     * @returns {Promise<null | ReturnType<typeof docToEntry>>}
     */
    async lookup(query) {
        if (!this.enabled() || !this.collection) return null;

        const found = await this._findDoc(query);
        if (!found) return null;

        return docToEntry(found.doc, query, { fuzzy: found.fuzzy });
    }

    async recordHit(query) {
        if (!this.collection) return;
        const queryKey = normalizeMovieQuery(query);
        if (!queryKey) return;

        await this.collection.updateOne(
            { query_key: queryKey },
            { $set: { last_hit_at: new Date() }, $inc: { hit_count: 1 } },
        );
    }

    async upsert(query, results, sources = []) {
        if (!this.enabled() || !this.collection || !results?.length) return;

        const queryKey = normalizeMovieQuery(query);
        const queryCompact = compactMovieQuery(query);
        if (!queryKey) return;

        const now = new Date();
        const existing = await this.collection.findOne(
            { query_key: queryKey },
            { projection: { results: 1, sources: 1 } },
        );

        const merged = mergeMovieResults(existing?.results || [], cloneMovieResults(results));
        const mergedSources = [...new Set([
            ...(existing?.sources || []),
            ...sources,
        ].filter(Boolean))];

        await this.collection.updateOne(
            { query_key: queryKey },
            {
                $set: {
                    query_key: queryKey,
                    query_compact: queryCompact,
                    query_display: String(query).trim().slice(0, 120),
                    results: merged,
                    sources: mergedSources,
                    result_count: merged.length,
                    last_fetched_at: now,
                    expire_at: new Date(now.getTime() + this._ttlMs()),
                },
                $setOnInsert: {
                    created_at: now,
                    hit_count: 0,
                },
            },
            { upsert: true },
        );

        logger.info(`Movie vault saved "${queryKey}" → ${merged.length} title(s)`);
    }

    /**
     * Dedupe concurrent background refreshes for the same query.
     */
    async runBackgroundRefresh(query, fetchFn) {
        const key = normalizeMovieQuery(query);
        if (!key || typeof fetchFn !== 'function') return;

        if (this._refreshInFlight.has(key)) {
            return this._refreshInFlight.get(key);
        }

        const job = (async () => {
            try {
                const { results, sources } = await fetchFn(query);
                if (results?.length) {
                    await this.upsert(query, results, sources);
                    logger.info(`Movie vault background refresh OK: "${query}" (${results.length} titles)`);
                }
            } catch (err) {
                logger.warn(`Movie vault background refresh failed for "${query}": ${err?.message || err}`);
            }
        })().finally(() => {
            this._refreshInFlight.delete(key);
        });

        this._refreshInFlight.set(key, job);
        return job;
    }

    async getStats() {
        if (!this.collection) {
            return { enabled: false, entries: 0, totalHits: 0 };
        }

        const [entries, top] = await Promise.all([
            this.collection.countDocuments({}),
            this.collection
                .find({}, { projection: { query_display: 1, hit_count: 1, result_count: 1, last_fetched_at: 1 } })
                .sort({ hit_count: -1 })
                .limit(5)
                .toArray(),
        ]);

        const agg = await this.collection.aggregate([
            { $group: { _id: null, totalHits: { $sum: '$hit_count' } } },
        ]).toArray();

        return {
            enabled: this.enabled(),
            entries,
            totalHits: agg[0]?.totalHits || 0,
            top,
            freshHours: Math.round(this._freshMs() / (60 * 60 * 1000)),
            revalidateHours: Math.round(this._revalidateMs() / (60 * 60 * 1000)),
            staleDays: Math.round(this._staleMs() / (24 * 60 * 60 * 1000)),
        };
    }
}

export const movieCacheService = new MovieCacheService();
export default MovieCacheService;
