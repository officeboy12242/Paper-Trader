/**
 * PronoobDrive Scraper Service
 * Scrapes movie download links from self-hosted Render instances.
 * Rotates through configured base URLs with health checks.
 */

import https from 'https';
import http from 'http';
import { logger } from '../utils/logger.js';
import { audioFromFilename, filenameToDisplayTitle, qualityFromFilename, LANGUAGE_ALIASES } from '../utils/movieMetadata.js';
import { fetchMonthlyBandwidthMB, formatBandwidth } from '../utils/renderMetrics.js';
import { config } from '../config/config.js';

const DEFAULT_BASE_URL = 'https://pronoobdrive-7w2p.onrender.com';
const REQUEST_TIMEOUT = 15000;
const HEALTH_TIMEOUT = 8000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_PARSED_CARDS = 20;

const CARD_RE =
    /<!-- Card\s+-->\s*<div title="\s*[^|]+\|\s*([^"]+?)\s*"[^>]*>[\s\S]*?<div class="p-2">([\s\S]*?)<\/div>[\s\S]*?<a href="(Sct\/\d+\/[^"]+)"[\s\S]*?<button title="([^"]+)"/g;

function normalizeCardAudio(raw) {
    if (!raw) return '';
    return raw
        .replace(/^[-:\s]+/, '')
        .split('+')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => LANGUAGE_ALIASES[part.toLowerCase()] || part)
        .join(' + ');
}

function parseCardLabel(raw) {
    const text = decodeHtmlEntities(String(raw || '')).replace(/\s+/g, ' ').trim();
    const match = text.match(/[➪⇨]\s*(.+?)\s*[➪⇨]\s*Audio\s*[:-]\s*(.+)$/i);
    if (!match) {
        return { title: text, audio: '' };
    }
    return {
        title: match[1].trim(),
        audio: normalizeCardAudio(match[2].trim()),
    };
}

function decodeHtmlEntities(str) {
    return str
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"');
}

function normalizeBaseUrl(raw) {
    let u = String(raw || '').trim();
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
    try {
        const parsed = new URL(u);
        return `${parsed.protocol}//${parsed.host}`.replace(/\/$/, '');
    } catch {
        return '';
    }
}

function normalizeDriveSource(entry) {
    if (typeof entry === 'string') {
        const url = normalizeBaseUrl(entry);
        return url ? { url } : null;
    }
    if (entry && typeof entry === 'object') {
        const url = normalizeBaseUrl(entry.url);
        if (!url) return null;
        const renderServiceId = String(entry.renderServiceId || '').trim();
        const renderApiKey = String(entry.renderApiKey || '').trim();
        const out = { url };
        if (renderServiceId) out.renderServiceId = renderServiceId;
        if (renderApiKey) out.renderApiKey = renderApiKey;
        return out;
    }
    return null;
}

function parseAddDriveArgs(raw) {
    const text = String(raw || '').trim();
    if (!text) return { url: '', renderServiceId: '', renderApiKey: '' };

    let renderServiceId = '';
    let renderApiKey = '';
    const urlParts = [];

    for (const part of text.split(/\s+/)) {
        if (/^srv-[a-z0-9]+$/i.test(part)) {
            renderServiceId = part;
        } else if (/^rnd_[a-z0-9]+$/i.test(part)) {
            renderApiKey = part;
        } else {
            urlParts.push(part);
        }
    }

    return {
        url: urlParts.join(' ').trim(),
        renderServiceId,
        renderApiKey,
    };
}

function sourceUrl(source) {
    return typeof source === 'string' ? source : source?.url || '';
}

function sourcesEqual(a, b) {
    return sourceUrl(a) === sourceUrl(b);
}

function serializeSources(sources) {
    return sources.map((s) => {
        if (typeof s === 'string') return s;
        const out = { url: s.url };
        if (s.renderServiceId) out.renderServiceId = s.renderServiceId;
        if (s.renderApiKey) out.renderApiKey = s.renderApiKey;
        if (!s.renderServiceId && !s.renderApiKey) return s.url;
        return out;
    });
}

function dedupeSources(sources) {
    const seen = new Set();
    return sources.filter((s) => {
        const url = sourceUrl(s);
        if (seen.has(url)) return false;
        seen.add(url);
        return true;
    });
}

/** Fill missing Render credentials from DRIVE_SOURCES_JSON matched by URL. */
function mergeEnvCredentials(sources) {
    const envSources = (config.DRIVE_SOURCES || [])
        .map(normalizeDriveSource)
        .filter(Boolean);
    if (!envSources.length) return sources;

    const envByUrl = new Map(envSources.map((s) => [s.url, s]));
    return sources.map((entry) => {
        const source = normalizeDriveSource(entry);
        if (!source) return entry;
        const env = envByUrl.get(source.url);
        if (!env) return source;
        return {
            ...source,
            renderServiceId: source.renderServiceId || env.renderServiceId,
            renderApiKey: source.renderApiKey || env.renderApiKey,
        };
    });
}

function mergeAudioLabels(...parts) {
    const seen = new Set();
    const out = [];
    for (const part of parts) {
        if (!part) continue;
        for (const token of String(part).split(/\s*\+\s*|\s*•\s*/)) {
            const label = token.trim();
            if (!label) continue;
            const key = label.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(label);
        }
    }
    return out.join(' + ');
}

class PronoobDriveService {
    constructor() {
        this.name = 'Drive';
        this._settings = null;
        this._sources = [{ url: DEFAULT_BASE_URL }];
        this._rotateIndex = 0;
        this._lastHealthyUrl = null;
    }

    setSettings(botSettings) {
        this._settings = botSettings;
    }

    async loadUrls() {
        let sources = null;

        if (this._settings) {
            const stored = (await this._settings.getDriveSources())
                .map(normalizeDriveSource)
                .filter(Boolean);
            if (stored.length) {
                sources = dedupeSources(stored);
            }
        }

        if (!sources) {
            const fromEnv = (config.DRIVE_SOURCES || [])
                .map(normalizeDriveSource)
                .filter(Boolean);
            sources = fromEnv.length ? fromEnv : [{ url: DEFAULT_BASE_URL }];
        } else {
            sources = mergeEnvCredentials(sources);
        }

        this._sources = sources;
    }

    getUrls() {
        return this._sources.map(sourceUrl);
    }

    getSources() {
        return this._sources.map((s) => ({ ...s }));
    }

    async addUrl(rawUrl, renderServiceId = '', renderApiKey = '') {
        const parsed = typeof rawUrl === 'string' && !renderServiceId && !renderApiKey
            ? parseAddDriveArgs(rawUrl)
            : { url: rawUrl, renderServiceId, renderApiKey };
        const url = normalizeBaseUrl(parsed.url);
        if (!url) throw new Error('Invalid URL');
        const svcId = String(parsed.renderServiceId || renderServiceId || '').trim();
        const apiKey = String(parsed.renderApiKey || renderApiKey || '').trim();

        await this.loadUrls();
        const existing = this._sources.find((s) => sourceUrl(s) === url);
        if (existing) {
            let updated = false;
            if (svcId && existing.renderServiceId !== svcId) {
                existing.renderServiceId = svcId;
                updated = true;
            }
            if (apiKey && existing.renderApiKey !== apiKey) {
                existing.renderApiKey = apiKey;
                updated = true;
            }
            if (updated && this._settings) {
                await this._settings.setDriveSources(serializeSources(this._sources));
            }
            return { added: false, updated, urls: this.getUrls(), sources: this.getSources() };
        }

        const entry = { url };
        if (svcId) entry.renderServiceId = svcId;
        if (apiKey) entry.renderApiKey = apiKey;
        this._sources.push(entry);
        if (this._settings) {
            await this._settings.setDriveSources(serializeSources(this._sources));
        }
        return { added: true, urls: this.getUrls(), sources: this.getSources() };
    }

    async removeUrl(indexOneBased) {
        await this.loadUrls();
        const idx = indexOneBased - 1;
        if (idx < 0 || idx >= this._sources.length) {
            throw new Error('Invalid index');
        }
        const removed = sourceUrl(this._sources.splice(idx, 1)[0]);
        if (!this._sources.length) {
            this._sources = [{ url: DEFAULT_BASE_URL }];
        }
        if (this._settings) {
            const isDefaultOnly = this._sources.length === 1 && sourceUrl(this._sources[0]) === DEFAULT_BASE_URL;
            await this._settings.setDriveSources(isDefaultOnly ? [] : serializeSources(this._sources));
        }
        this._rotateIndex = 0;
        return { removed, urls: this.getUrls(), sources: this.getSources() };
    }

    _orderedUrlsForRotation() {
        if (!this._sources.length) return [DEFAULT_BASE_URL];
        const ordered = [];
        for (let i = 0; i < this._sources.length; i++) {
            ordered.push(sourceUrl(this._sources[(this._rotateIndex + i) % this._sources.length]));
        }
        return ordered;
    }

    _headCheck(baseUrl) {
        return new Promise((resolve) => {
            let settled = false;
            const finish = (ok) => {
                if (!settled) {
                    settled = true;
                    resolve(ok);
                }
            };
            try {
                const url = new URL(`${baseUrl}/Sct`);
                const mod = url.protocol === 'https:' ? https : http;
                const req = mod.request(
                    { hostname: url.hostname, port: url.port, path: url.pathname, method: 'HEAD' },
                    (res) => {
                        res.resume();
                        finish(res.statusCode >= 200 && res.statusCode < 400);
                    },
                );
                req.on('error', () => finish(false));
                req.setTimeout(HEALTH_TIMEOUT, () => {
                    req.destroy();
                    finish(false);
                });
                req.end();
            } catch {
                finish(false);
            }
        });
    }

    async _pickHealthyBase() {
        await this.loadUrls();
        const candidates = this._orderedUrlsForRotation();

        for (let i = 0; i < candidates.length; i++) {
            const base = candidates[i];
            const ok = await this._headCheck(base);
            if (ok) {
                this._lastHealthyUrl = base;
                const foundAt = this._sources.findIndex((s) => sourceUrl(s) === base);
                if (foundAt >= 0) {
                    this._rotateIndex = (foundAt + 1) % this._sources.length;
                }
                logger.info(`Drive source OK: ${base}`);
                return base;
            }
            logger.warn(`Drive source down: ${base}`);
        }

        return null;
    }

    async testAllSources() {
        await this.loadUrls();
        const results = [];
        for (let i = 0; i < this._sources.length; i++) {
            const source = this._sources[i];
            const url = sourceUrl(source);
            const ok = await this._headCheck(url);
            const row = { index: i + 1, url, ok, renderServiceId: source.renderServiceId || '' };

            if (ok && source.renderServiceId) {
                try {
                    const mb = await fetchMonthlyBandwidthMB(
                        source.renderServiceId,
                        source.renderApiKey || undefined,
                    );
                    row.bandwidthMB = mb;
                    row.bandwidthText = mb == null ? null : formatBandwidth(mb);
                } catch {
                    row.bandwidthText = null;
                }
            }

            results.push(row);
        }
        return results;
    }

    _fetch(urlStr) {
        return new Promise((resolve, reject) => {
            const url = new URL(urlStr);
            const mod = url.protocol === 'https:' ? https : http;
            let settled = false;
            const done = (val) => { if (!settled) { settled = true; resolve(val); } };
            const fail = (err) => { if (!settled) { settled = true; reject(err); } };

            const req = mod.request(
                { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: 'GET' },
                (res) => {
                    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        const redirect = new URL(res.headers.location, urlStr).href;
                        res.resume();
                        return this._fetch(redirect).then(done, fail);
                    }
                    let size = 0;
                    const chunks = [];
                    res.on('data', (c) => {
                        if (settled) return;
                        size += c.length;
                        if (size > MAX_RESPONSE_BYTES) {
                            res.destroy();
                            done({ status: res.statusCode, data: Buffer.concat(chunks).toString() });
                            return;
                        }
                        chunks.push(c);
                    });
                    res.on('end', () => done({ status: res.statusCode, data: Buffer.concat(chunks).toString() }));
                    res.on('error', () => done({ status: res.statusCode, data: Buffer.concat(chunks).toString() }));
                },
            );
            req.on('error', fail);
            req.setTimeout(REQUEST_TIMEOUT, () => { req.destroy(); fail(new Error('Request timeout')); });
            req.end();
        });
    }

    _parseHtml(html, baseUrl) {
        const files = [];
        let match;
        CARD_RE.lastIndex = 0;
        while ((match = CARD_RE.exec(html)) !== null) {
            const size = match[1].trim();
            const cardLabel = match[2];
            const relUrl = match[3];
            const rawFilename = decodeHtmlEntities(match[4]);
            const { title: cardTitle, audio: cardAudio } = parseCardLabel(cardLabel);
            // Caption (p-2) is the human movie name; filename is the release name
            const description = cardTitle || '';
            const title = description || filenameToDisplayTitle(rawFilename) || rawFilename;
            const parsedAudio = audioFromFilename(rawFilename);
            files.push({
                rawFilename,
                title,
                description,
                quality: qualityFromFilename(rawFilename),
                size,
                audio: mergeAudioLabels(cardAudio, parsedAudio),
                url: `${baseUrl}/${relUrl}`,
            });
            if (files.length >= MAX_PARSED_CARDS) break;
        }
        return files;
    }

    /**
     * Keep files that match the query in filename OR card description.
     * Falls back to all files if nothing matches (API may still be right).
     */
    _filterByQuery(files, query) {
        const words = String(query || '')
            .toLowerCase()
            .split(/\s+/)
            .map((w) => w.replace(/[^a-z0-9]/g, ''))
            .filter((w) => w.length > 2);
        if (!words.length || !files?.length) return files || [];

        const scored = files
            .map((f) => {
                const hay = `${f.rawFilename || ''} ${f.description || ''} ${f.title || ''}`.toLowerCase();
                const hits = words.filter((w) => hay.includes(w)).length;
                return { f, hits };
            })
            .filter((row) => row.hits > 0)
            .sort((a, b) => b.hits - a.hits);

        return scored.length ? scored.map((row) => row.f) : files;
    }

    async _searchSingleBase(baseUrl, query, maxResults, sourceLabel) {
        const searchUrl = `${baseUrl}/Sct?search=${encodeURIComponent(query)}`;
        let status;
        let data;
        try {
            ({ status, data } = await this._fetch(searchUrl));
        } catch (err) {
            throw new Error(`unreachable: ${err.message}`);
        }

        if (status !== 200) {
            throw new Error(`HTTP ${status}`);
        }

        const files = this._filterByQuery(this._parseHtml(data, baseUrl), query);
        if (!files.length) return [];

        const groups = new Map();
        for (const file of files) {
            const key = (file.description || file.title).toLowerCase();
            if (!groups.has(key)) {
                groups.set(key, {
                    title: file.title,
                    description: file.description || '',
                    links: [],
                });
            }
            const label = file.quality ? `${file.quality} • ${file.size}` : file.size;
            groups.get(key).links.push({
                size: label,
                audio: file.audio || audioFromFilename(file.rawFilename),
                quality: file.quality || qualityFromFilename(file.rawFilename),
                rawFilename: file.rawFilename,
                url: file.url,
            });
        }

        const results = [];
        for (const [, group] of groups) {
            results.push({
                title: group.title,
                description: group.description,
                source: sourceLabel,
                links: group.links,
            });
            if (results.length >= maxResults) break;
        }

        return results;
    }

    async searchMovies(query, maxResults = 5) {
        try {
            await this.loadUrls();
            const urls = this._orderedUrlsForRotation();

            for (let i = 0; i < urls.length; i++) {
                const baseUrl = urls[i];
                try {
                    const results = await this._searchSingleBase(baseUrl, query, maxResults, 'Drive');
                    if (results.length > 0) {
                        logger.info(`Drive ${baseUrl}: ${results.length} result(s) for "${query}"`);
                        return results;
                    }
                    logger.warn(`Drive ${baseUrl}: no results for "${query}"${i < urls.length - 1 ? ', trying next source' : ''}`);
                } catch (err) {
                    logger.warn(`Drive ${baseUrl} unavailable (${err.message})${i < urls.length - 1 ? ', trying next source' : ''}`);
                }
            }

            return [];
        } catch (err) {
            logger.error(`PronoobDrive searchMovies error: ${err.message}`);
            return [];
        } finally {
            if (this._sources.length) {
                this._rotateIndex = (this._rotateIndex + 1) % this._sources.length;
            }
        }
    }

    startKeepAlive(intervalMs = 4 * 60 * 1000) {
        this.stopKeepAlive();
        const ping = async () => {
            await this.loadUrls();
            const urls = this.getUrls();
            if (!urls.length) return;

            await Promise.allSettled(urls.map(async (base) => {
                const ok = await this._headCheck(base);
                if (ok) {
                    logger.info(`🏓 Drive keep-alive OK (${base})`);
                } else {
                    logger.warn(`🏓 Drive keep-alive failed (${base})`);
                }
            }));
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

export const pronoobDriveService = new PronoobDriveService();
export default PronoobDriveService;
