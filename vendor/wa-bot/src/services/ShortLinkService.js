/**
 * Self-hosted short links with TTL (stored in MongoDB).
 */

import crypto from 'crypto';
import { config } from '../config/config.js';
import { logger } from '../utils/logger.js';
import { resolveMovieLinkPublicBase } from '../utils/publicBaseUrl.js';

/** Public so UrlShortener can align its memory cache under this TTL. */
export const LINK_TTL_MS = 7 * 60 * 60 * 1000; // 7 hours
/** Reuse an existing /d/ code only if it still has at least this long left. */
const MIN_REUSE_REMAINING_MS = 60 * 60 * 1000; // 1 hour

class ShortLinkService {
    constructor() {
        this.collection = null;
        this._warnedLocalhost = false;
    }

    async init(mongoDb) {
        this.collection = mongoDb.collection('short_links');
        await this.collection.createIndex({ code: 1 }, { unique: true });
        await this.collection.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
        logger.info('Short link store ready (7h expiry)');
    }

    getPublicBaseUrl() {
        // Koyeb .koyeb.app is blocked by TinyURL — resolveMovieLinkPublicBase uses Render when needed.
        const base =
            resolveMovieLinkPublicBase() ||
            config.PUBLIC_URL ||
            (process.env.NODE_ENV === 'production'
                ? ''
                : `http://localhost:${process.env.PORT || 3000}`);
        if (!base) {
            if (!this._warnedLocalhost) {
                this._warnedLocalhost = true;
                logger.warn(
                    'Movie /d/ links unavailable — set PUBLIC_URL or deploy as a public web service ' +
                        '(Koyeb injects KOYEB_PUBLIC_DOMAIN)',
                );
            }
            return '';
        }
        if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(base) && !this._warnedLocalhost) {
            this._warnedLocalhost = true;
            logger.warn(
                'Movie short links using localhost — waiting for KOYEB_PUBLIC_DOMAIN / RENDER_EXTERNAL_URL ' +
                    'or an inbound public request to learn the host',
            );
        }
        return String(base).replace(/\/$/, '');
    }

    async _generateCode() {
        return crypto.randomBytes(4).toString('base64url');
    }

    _meta(base, doc) {
        return {
            url: `${base}/d/${doc.code}`,
            code: doc.code,
            expiresAt: new Date(doc.expires_at).getTime(),
        };
    }

    /**
     * Batch mint /d/ codes — one Mongo read + one insert for many links.
     * @returns {Map<string, { url: string, code: string, expiresAt: number }>}
     */
    async shortenMany(longUrls) {
        const base = this.getPublicBaseUrl();
        if (!base) {
            throw new Error('Public base URL not ready for expiring movie links');
        }

        const unique = [...new Set(longUrls.filter(Boolean))];
        if (!unique.length) return new Map();

        const now = new Date();
        const reuseAfter = new Date(now.getTime() + MIN_REUSE_REMAINING_MS);
        const existing = await this.collection
            .find({ long_url: { $in: unique }, expires_at: { $gt: reuseAfter } })
            .toArray();

        const out = new Map();
        for (const doc of existing) {
            out.set(doc.long_url, this._meta(base, doc));
        }

        const toCreate = unique.filter((u) => !out.has(u));
        if (!toCreate.length) return out;

        const expiresAt = new Date(Date.now() + LINK_TTL_MS);
        const usedCodes = new Set();
        const docs = toCreate.map((long_url) => {
            let code;
            do {
                code = crypto.randomBytes(4).toString('base64url');
            } while (usedCodes.has(code));
            usedCodes.add(code);
            return { code, long_url, expires_at: expiresAt, created_at: now };
        });

        try {
            await this.collection.insertMany(docs, { ordered: false });
            for (const doc of docs) {
                out.set(doc.long_url, this._meta(base, doc));
            }
        } catch (err) {
            for (const long_url of toCreate) {
                if (out.has(long_url)) continue;
                try {
                    out.set(long_url, await this.shorten(long_url));
                } catch {
                    // skip — urlShortener will log
                }
            }
        }
        return out;
    }

    /**
     * @returns {{ url: string, code: string, expiresAt: number }}
     */
    async shorten(longUrl) {
        const base = this.getPublicBaseUrl();
        if (!base) {
            throw new Error('Public base URL not ready for expiring movie links');
        }

        const now = new Date();
        const reuseAfter = new Date(now.getTime() + MIN_REUSE_REMAINING_MS);
        const existing = await this.collection.findOne({
            long_url: longUrl,
            expires_at: { $gt: reuseAfter },
        });
        if (existing) {
            return {
                url: `${base}/d/${existing.code}`,
                code: existing.code,
                expiresAt: new Date(existing.expires_at).getTime(),
            };
        }

        const code = await this._generateCode();
        const expiresAt = new Date(Date.now() + LINK_TTL_MS);
        try {
            await this.collection.insertOne({
                code,
                long_url: longUrl,
                expires_at: expiresAt,
                created_at: now,
            });
        } catch (err) {
            if (err.code === 11000) return this.shorten(longUrl);
            throw err;
        }

        return {
            url: `${base}/d/${code}`,
            code,
            expiresAt: expiresAt.getTime(),
        };
    }

    async resolve(code) {
        if (!code || !this.collection) return null;
        const doc = await this.collection.findOne({ code });
        if (!doc || doc.expires_at <= new Date()) return null;
        return doc.long_url;
    }
}

export const shortLinkService = new ShortLinkService();
export default ShortLinkService;
