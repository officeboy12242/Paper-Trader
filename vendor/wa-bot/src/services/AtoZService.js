/**
 * AtoZ Cinemas — prefer movies API (NullDrop mirrors); scrape only as fallback.
 */

import https from 'https';
import { logger } from '../utils/logger.js';
import { audioFromFilename } from '../utils/movieMetadata.js';
import { hdHubMoviesService } from './HdHubMoviesService.js';

const BASE_URL = 'https://atoz.cinemaz.workers.dev';
const REQUEST_TIMEOUT = 15000;

class AtoZService {
    constructor() {
        this.name = 'AtoZ Cinemas';
    }

    async _fetch(urlStr) {
        return new Promise((resolve, reject) => {
            const url = new URL(urlStr);
            const req = https.request(
                {
                    hostname: url.hostname,
                    path: url.pathname + url.search,
                    method: 'GET',
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    },
                },
                (res) => {
                    let data = '';
                    res.on('data', (chunk) => (data += chunk));
                    res.on('end', () => resolve({ status: res.statusCode, data }));
                }
            );
            req.on('error', reject);
            req.setTimeout(REQUEST_TIMEOUT, () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });
            req.end();
        });
    }

    _parseMoviePage(html) {
        const files = [];
        const fileIds = [...html.matchAll(/\\?"file_id\\?":\\?"([^"\\]+)\\?"/g)].map((m) => m[1]);
        const filenames = [...html.matchAll(/\\?"file_name\\?":\\?"([^"\\]+)\\?"/g)].map((m) => m[1]);
        const sizes = [...html.matchAll(/(\d+(?:\.\d+)?\s*(?:GB|MB))/gi)].map((m) => m[1]);

        for (let i = 0; i < fileIds.length; i++) {
            const filename = filenames[i] || '';
            let quality = 'Unknown';
            if (filename.includes('1080p')) quality = '1080p';
            else if (filename.includes('720p') && filename.toLowerCase().includes('hevc')) quality = '720p HEVC';
            else if (filename.includes('720p')) quality = '720p';
            else if (filename.includes('480p')) quality = '480p';
            else if (filename.includes('2160p') || filename.includes('4K')) quality = '4K';

            files.push({
                quality,
                filename,
                size: sizes[i] || 'N/A',
                file_id: fileIds[i],
                url: `${BASE_URL}/links/${fileIds[i]}`,
            });
        }

        return files;
    }

    async search(query) {
        try {
            const searchUrl = `${BASE_URL}/search?q=${encodeURIComponent(query)}`;
            const result = await this._fetch(searchUrl);

            if (result.status !== 200) {
                logger.warn(`AtoZ search returned status ${result.status}`);
                return [];
            }

            const slugPattern = /href="\/([a-z0-9-]+-\d{4}-[^"]+)"/gi;
            return [...new Set([...result.data.matchAll(slugPattern)].map((m) => m[1]))];
        } catch (err) {
            logger.error(`AtoZ search error: ${err.message}`);
            return [];
        }
    }

    async getMovieBySlug(slug) {
        try {
            const url = `${BASE_URL}/${slug}`;
            const result = await this._fetch(url);

            if (result.status !== 200) {
                logger.warn(`AtoZ movie page returned status ${result.status}`);
                return null;
            }

            const titleMatch = result.data.match(/<title>([^<]+)<\/title>/i);
            let title = titleMatch ? titleMatch[1].replace(/\s*[-|].*$/, '').trim() : slug;
            title = title.replace(/\s*—\s*AtoZ\s*Cinemas/i, '').trim();

            return {
                title,
                slug,
                pageUrl: url,
                files: this._parseMoviePage(result.data),
            };
        } catch (err) {
            logger.error(`AtoZ getMovie error: ${err.message}`);
            return null;
        }
    }

    /**
     * Prefer movies API (has NullDrop). Scrape only if API returns no AtoZ rows.
     */
    async searchMovies(query, maxResults = 5) {
        try {
            const fromApi = await hdHubMoviesService.searchMovies(query, Math.max(maxResults * 3, 12));
            const atozOnly = fromApi
                .filter((r) => /^atoz$/i.test(String(r?.source || '').trim()))
                .slice(0, maxResults);
            if (atozOnly.length) {
                logger.info(`AtoZ via movies API: ${atozOnly.length} result(s) for "${query}"`);
                return atozOnly;
            }

            const slugs = await this.search(query);
            if (!slugs.length) return [];

            const movies = await Promise.all(
                slugs.slice(0, maxResults).map((slug) => this.getMovieBySlug(slug))
            );

            const results = [];
            for (const movie of movies) {
                if (!movie || !movie.files.length) continue;
                results.push({
                    title: movie.title,
                    source: 'AtoZ',
                    links: movie.files.map((f) => ({
                        size: `${f.quality} • ${f.size}`,
                        audio: audioFromFilename(f.filename),
                        url: f.url,
                    })),
                });
            }

            return results;
        } catch (err) {
            logger.error(`AtoZ searchMovies error: ${err.message}`);
            return [];
        }
    }

    _headCheck() {
        return new Promise((resolve) => {
            let settled = false;
            const finish = (ok) => {
                if (!settled) {
                    settled = true;
                    resolve(ok);
                }
            };
            try {
                const url = new URL(BASE_URL);
                const req = https.request(
                    { hostname: url.hostname, path: url.pathname || '/', method: 'HEAD' },
                    (res) => {
                        res.resume();
                        finish(res.statusCode >= 200 && res.statusCode < 400);
                    }
                );
                req.on('error', () => finish(false));
                req.setTimeout(8000, () => {
                    req.destroy();
                    finish(false);
                });
                req.end();
            } catch {
                finish(false);
            }
        });
    }

    startKeepAlive(intervalMs = 4 * 60 * 1000) {
        this.stopKeepAlive();
        const ping = async () => {
            const ok = await this._headCheck();
            if (ok) {
                logger.info(`🏓 AtoZ keep-alive OK (${BASE_URL})`);
            } else {
                logger.warn(`🏓 AtoZ keep-alive failed (${BASE_URL})`);
            }
        };
        void ping();
        this._keepAliveTimer = setInterval(() => {
            void ping();
        }, intervalMs);
    }

    stopKeepAlive() {
        if (this._keepAliveTimer) {
            clearInterval(this._keepAliveTimer);
            this._keepAliveTimer = null;
        }
    }
}

export const atozService = new AtoZService();
export default AtoZService;
