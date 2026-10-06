/**
 * HDHub4u direct-link bypass service.
 *
 * Resolves intermediate pages into DIRECT download links:
 *   - hubcdn.<tld>/file/ID  → reurl (b64 or ad-wrapped ?r=) → hubcdn.club/dl/?link=<R2>
 *   - hubcloud.<tld>/drive/ID → a#download → gamerxyt.com/hubcloud.php → final servers
 *   - hubdrive.<tld>/file/ID → hubcloud /drive page (same as above)
 *   - nexdrive.you/genxfmID → ad-lockered — best-effort only
 *   - gdflix.<tld>/file/ID  → pre-generated mirrors only (DDL is Turnstile-gated)
 *
 * Final servers surfaced: R2 cloudflarestorage (presigned + r2.dev), 10Gbps,
 * FSLv2, FuckingFast, PixelDrain (/bypass command only). Telegram mirrors skipped.
 *
 * Architecture:
 *   - Pure extractors (*FromHtml) take already-fetched HTML — the /bypass path
 *     fetches each page ONCE (title + links from the same response).
 *   - bypassManyLinks runs a worker pool of parallel "agents", one per link,
 *     shared across ALL users/chats → multi-group, multi-user requests are
 *     handled concurrently without stampeding the target hosts.
 */

import axios from 'axios';
import https from 'https';
import { logger } from '../utils/logger.js';
import { config } from '../config/config.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const DEFAULT_HEADERS = {
    'User-Agent': UA,
    Referer: 'https://new6.hdhub4u.cl/',
};

function hostOf(urlStr) {
    try {
        return new URL(urlStr).hostname.toLowerCase();
    } catch {
        return '';
    }
}

function decodeB64(s) {
    try {
        return Buffer.from(String(s), 'base64').toString('utf-8');
    } catch {
        return '';
    }
}

/** Bump any known-moved host to its current TLD before fetching. */
function canonicalizeHost(urlStr) {
    return String(urlStr || '')
        .replace(/\/\/hubcdn\.(wiki|club)\//i, '//hubcdn.wiki/');
}

let _relaxedAgent = null;
function relaxedHttpsAgent() {
    if (!_relaxedAgent) _relaxedAgent = new https.Agent({ rejectUnauthorized: false });
    return _relaxedAgent;
}

const TLS_CERT_ERR = /unable to verify|self.signed|cert(ificate)? (has expired|chain)|depth_zero|err_tls/i;

/** GET a page as text (axios). Several scrape targets (hubcloud.ist et al)
 * serve an incomplete TLS chain that browsers tolerate but Node rejects;
 * retry once with a relaxed agent when that exact failure happens. */
async function fetchPage(urlStr, { referer, timeoutMs } = {}) {
    const headers = { ...DEFAULT_HEADERS, ...(referer ? { Referer: referer } : {}) };
    const opts = {
        timeout: timeoutMs,
        maxRedirects: 5,
        maxContentLength: 3 * 1024 * 1024,
        headers,
        // hubcloud.ist et al serve full page HTML with status 403 (WAF quirk) —
        // accept it; extraction simply finds nothing when the body is junk.
        validateStatus: (s) => (s >= 200 && s < 400) || s === 403,
    };
    try {
        const { data } = await axios.get(urlStr, opts);
        return typeof data === 'string' ? data : String(data);
    } catch (err) {
        const msg = String(err?.message || err?.code || '');
        if (!TLS_CERT_ERR.test(msg)) throw err;
        logger.warn(`[HdHubBypass] ${hostOf(urlStr)} TLS chain issue, retrying relaxed`);
        const { data } = await axios.get(urlStr, { ...opts, httpsAgent: relaxedHttpsAgent() });
        return typeof data === 'string' ? data : String(data);
    }
}

/** Server classification from the hubcloud.php page (order = user priority). */
const SERVER_PATTERNS = [
    { key: 'r2', re: /\.cloudflarestorage\.com/i, label: 'R2 ⚡' },
    { key: '10gbps', re: /gpdl\.hubcloud\.|pixel\.hubcloud\.|10\s*gbps/i, label: '10Gbps ⚡' },
    { key: 'fslv2', re: /lenin\.buzz|fslv?2/i, label: 'FSLv2 ⚡' },
    { key: 'pixeldrain', re: /pixeldrain/i, label: 'PixelDrain' },
    { key: 'fuckingfast', re: /fuckingfast/i, label: 'FuckingFast' },
];

function classifyServer(urlStr, labelText = '') {
    const hay = `${urlStr} ${labelText}`;
    for (const p of SERVER_PATTERNS) {
        if (p.re.test(hay)) return p;
    }
    return null;
}

/** Server pages embed filenames with raw spaces/unicode in URLs. Those
 * break shorteners and 302 Location headers downstream ('redirect failed'),
 * so normalize every extracted URL: encode unsafe path chars, strip junk. */
function sanitizeUrl(urlStr) {
    let u = String(urlStr || '').trim().replace(/[\u0000-\u001f\u007f]/g, '');
    if (!/^https?:\/\//i.test(u)) return u;
    try {
        return new URL(u).href;
    } catch {
        try {
            return new URL(encodeURI(u)).href;
        } catch {
            return u.replace(/ /g, '%20');
        }
    }
}

function dedupeLinks(links) {
    const seen = new Set();
    const out = [];
    for (const l of links) {
        const k = String(l.url).replace(/[?#].*$/, '');
        if (!seen.has(k)) {
            seen.add(k);
            out.push(l);
        }
    }
    return out;
}

/** Extract classified server links from a hubcloud.php-style page. */
function extractServerLinks(html) {
    const out = [];
    const anchorRe = /<a\b[^>]*href="https?:[^"]*"[^>]*>/gi;
    const seen = new Set();
    let am;
    let dbgCount = 0;
    while ((am = anchorRe.exec(html)) !== null) {
        dbgCount++;
        const tag = am[0];
        const hrefM = tag.match(/href="(https?:[^"]+)"/i);
        if (!hrefM) continue;
        const href = hrefM[1];
        const afterOpen = html.slice(am.index + tag.length);
        const closeIdx = afterOpen.search(/<\/a>/i);
        const text = closeIdx === -1 ? '' : afterOpen.slice(0, closeIdx).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (/t\.me|telegram|watch online|login|winexch|a-ads|snvhost|tinyurl|one\.one\.one|google\./i.test(`${href} ${text}`)) continue;
        if (/hubcloud\.[a-z.]+\/(drive|tg)\//i.test(href)) continue;
        const cls = classifyServer(href, text);
        if (!cls) continue;
        const idM = tag.match(/id="([^"]+)"/i);
        let finalUrl = href;
        if (idM) {
            const BS = String.fromCharCode(92);
            const esc = idM[1].replace(/[^a-zA-Z0-9]/g, (c) => BS + c);
            const jsRe = new RegExp(`var${BS}s+${BS}w+${BS}s*=${BS}s*"([^"]+)"[^<]*document${BS}.getElementById${BS}("${esc}"${BS})`, 'i');
            const js = html.match(jsRe);
            if (js && /^https?:\/\//i.test(js[1])) finalUrl = js[1];
        }
        finalUrl = sanitizeUrl(finalUrl);
        const k = finalUrl.replace(/[?#].*$/, '');
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ label: cls.label, serverKey: cls.key, url: finalUrl });
    }
    return out;
}

/* ────────────────────────── Pure HTML extractors ────────────────────────── */

/** hubcdn /file/ page HTML → direct R2 URL from the reurl param (both forms). */
function bypassHubcdnFromHtml(html) {
    const m = html.match(/reurl\s*=\s*"([^"]+)"/i);
    if (!m) return [];
    let decoded = m[1];
    // Form A (old): reurl is itself base64 of hubcdn.club/dl/?link=<R2>
    if (!/^https?:\/\//i.test(decoded)) decoded = decodeB64(decoded);
    // Form B (new): reurl is an ad-wrapped URL like https://inventoryidea.com/?r=<b64>
    const rParam = decoded.match(/[?&]r=([A-Za-z0-9+/=_-]+)/);
    if (rParam) {
        const inner = decodeB64(rParam[1]);
        if (inner.startsWith('http')) decoded = inner;
    }
    // unwrap the final hop: hubcdn.club/dl/?link=<R2 url>
    const linkParam = decoded.match(/[?&]link=([^&]+)/i);
    const target = linkParam ? decodeURIComponent(linkParam[1]) : (decoded.startsWith('http') ? decoded : '');
    if (!target || !/^https?:\/\//i.test(target)) return [];
    return [{ label: 'R2 ⚡', serverKey: 'r2', url: sanitizeUrl(target) }];
}

/** GDFlix page mirrors, classified by host. */
function gdflixMirrorLabel(urlStr) {
    if (/instant\.busycdn/i.test(urlStr)) return 'Instant ⚡';
    if (/filesgram/i.test(urlStr)) return 'Filesgram';
    if (/multiup/i.test(urlStr)) return 'MultiUp';
    if (/drivebot\.sbs/i.test(urlStr)) return 'DriveBot';
    if (/tgredirect/i.test(urlStr)) return 'Telegram';
    return '';
}

/** GDFlix /file/ HTML → pre-generated mirror links (DDL itself is Turnstile-gated). */
function bypassGdflixFromHtml(html) {
    const out = [];
    const seen = new Set();
    const push = (u) => {
        u = sanitizeUrl(u);
        const label = gdflixMirrorLabel(u);
        if (!label) return;
        const k = u.replace(/[?#].*$/, '');
        if (!seen.has(k)) {
            seen.add(k);
            out.push({ label, serverKey: 'mirror', url: u });
        }
    };
    for (const m of html.matchAll(/(?:data-url|data-href|href)="(https?:[^"\s]+)"/gi)) push(m[1]);
    for (const m of html.matchAll(/["'](https?:[^"'\s]*?(?:busycdn|filesgram|multiup|drivebot|tgredirect)[^"'\s]*)["']/gi)) push(m[1]);
    return out;
}

/** hubcloud.php URL from a /drive/ page's a#download anchor (or null). */
function downloadAnchorFromHtml(html, pageUrl) {
    const dn = html.match(/<a[^>]+id="download"[^>]+href="([^"]+)"/i);
    if (!dn) return null;
    const href = dn[1];
    if (!/^https?:\/\//i.test(href)) {
        try {
            return new URL(href, pageUrl).href;
        } catch {
            return null;
        }
    }
    return href;
}

/**
 * hubcloud.php worker URL from a /video/ page: a button anchor pointing at
 * hubcloud.php on ANY domain (e.g. sportverse.cc/hubcloud.php?host=hubvid&id=…
 * &token=…). /video/ pages have no a#download — this is their worker link.
 */
function workerAnchorFromHtml(html) {
    const anchors = html.matchAll(/<a[^>]+href="(https?:[^"\s]*hubcloud\.php\?[^"]*)"[^>]*>/gi);
    for (const a of anchors) {
        const tag = a[0];
        const href = a[1];
        // skip obvious ad buttons (btn2 class rows are ads on these pages)
        if (/class="[^"]*btn2/i.test(tag)) continue;
        if (/rel="[^"]*nofollow/i.test(tag) && !/btn-primary/i.test(tag)) continue;
        return href;
    }
    return null;
}

/** hubdrive HTML → direct servers (some pages embed them) or the hubcloud.php hop. */
async function bypassHubdriveFromHtml(html, pageUrl, timeoutMs) {
    const direct = extractServerLinks(html);
    if (direct.length) return direct;
    const hrefs = [...html.matchAll(/href="(https?:\/\/[^"]*hubcloud[^"]*)"/gi)].map((mm) => mm[1]);
    const pick = hrefs.find((u) => /hubcloud\.[a-z.]+\/drive\//i.test(u))
        || hrefs.find((u) => !/\/(tg|admin)\//i.test(u))
        || hrefs[0];
    if (pick) {
        const php = await hubcloudDriveToPhp(pick, timeoutMs);
        if (php) {
            const html2 = await fetchPage(php, { referer: pick, timeoutMs });
            return extractServerLinks(html2);
        }
    }
    return [];
}

/** hubcloud /drive/ or /video/ HTML → hubcloud.php fetch → final servers. */
async function bypassHubcloudFromHtml(html, pageUrl, timeoutMs) {
    const php = downloadAnchorFromHtml(html, pageUrl) || workerAnchorFromHtml(html);
    if (!php) return [];
    const html2 = await fetchPage(php, { referer: pageUrl, timeoutMs });
    return extractServerLinks(html2);
}

/* ────────────────── Fetching wrappers (enrichment path) ────────────────── */

/** hubcdn /file/ page → R2 link. */
async function bypassHubcdn(urlStr, timeoutMs) {
    const html = await fetchPage(urlStr, { timeoutMs });
    return bypassHubcdnFromHtml(html);
}

/** hubcloud.ist /drive/ or /video/ page → the hubcloud.php worker URL (or null). */
async function hubcloudDriveToPhp(urlStr, timeoutMs) {
    const html = await fetchPage(urlStr, { timeoutMs });
    return downloadAnchorFromHtml(html, urlStr) || workerAnchorFromHtml(html);
}

/** hubdrive /file/ page → direct servers. */
async function bypassHubdrive(urlStr, timeoutMs) {
    const html = await fetchPage(urlStr, { timeoutMs });
    return bypassHubdriveFromHtml(html, urlStr, timeoutMs);
}

/** Pull every plausible absolute URL out of arbitrary text/markdown. */
function extractUrlsFromText(text) {
    const out = [];
    const seen = new Set();
    for (const m of String(text || '').matchAll(/https?:\/\/[^\s)\]"'<>]+/g)) {
        const u = m[0].replace(/[),.]+$/, '');
        if (!seen.has(u)) { seen.add(u); out.push(u); }
    }
    return out;
}

/** Classified server links from any text (HTML or markdown). */
function serverLinksFromText(text) {
    const out = [];
    const seen = new Set();
    for (const raw of extractUrlsFromText(text)) {
        const u = sanitizeUrl(raw);
        if (/t\.me|telegram|winexch|a-ads|snvhost|tinyurl|google\.\//i.test(u)) continue;
        if (/hubcloud\.[a-z.]+\/(drive|tg)\//i.test(u)) continue;
        const cls = classifyServer(u);
        if (!cls) continue;
        const k = u.replace(/[?#].*$/, '');
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ label: cls.label, serverKey: cls.key, url: u });
    }
    return out;
}

/** r.jina.ai renders pages through headless browsers — rides out Cloudflare
 * challenges and datacenter-IP blocks that hit Koyeb/Render egress. Must use
 * native fetch with a MINIMAL header set: axios's default Accept/Accept-Encoding
 * headers change jina's cache key and pin a stale CF-challenge page. */
async function fetchViaJina(urlStr, timeoutMs) {
    for (let attempt = 0; attempt < 2; attempt++) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), Math.max(6_000, timeoutMs));
        let text = '';
        try {
            const res = await fetch(`https://r.jina.ai/${urlStr}`, {
                headers: { 'User-Agent': UA },
                signal: ctrl.signal,
            });
            text = await res.text();
        } catch {
            text = '';
        } finally {
            clearTimeout(t);
        }
        if (!/just a moment|challenge-platform/i.test(text) || attempt === 1) return text;
        await new Promise((r) => setTimeout(r, 900));
    }
    return '';
}

/** urltomarkdown.herokuapp.com renders a page to markdown — second reader
 * option that currently clears hubdrive.pics's Cloudflare when jina can't. */
async function fetchViaUrltomarkdown(urlStr, timeoutMs) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), Math.max(8_000, timeoutMs));
    try {
        const res = await fetch(`https://urltomarkdown.herokuapp.com/?url=${encodeURIComponent(urlStr)}`, {
            headers: { 'User-Agent': UA },
            signal: ctrl.signal,
        });
        return await res.text();
    } finally {
        clearTimeout(t);
    }
}

/** Render a page to readable text via whichever reader proxy currently works
 * (their headless egress pools get CF-flagged at different times). */
async function renderPageText(urlStr, timeoutMs) {
    for (const reader of [fetchViaUrltomarkdown, fetchViaJina]) {
        try {
            const text = await reader(urlStr, timeoutMs);
            if (text && !/just a moment|challenge-platform/i.test(text)) return text;
        } catch {}
    }
    return '';
}

/** Last-resort resolution through the reader proxies: page → hubcloud hop → php. */
async function resolveViaJina(pageUrl, timeoutMs) {
    const page = await renderPageText(pageUrl, timeoutMs);
    if (!page) return [];
    const urls = extractUrlsFromText(page);
    const hub = urls.find((u) => /hubcloud\.[a-z.]+\/drive\//i.test(u))
        || urls.find((u) => /hubcloud\.[a-z.]+/i.test(u) && !/r\.jina\.ai/.test(u));
    let servers = serverLinksFromText(page);
    const php = urls.find((u) => /hubcloud\.php\?/i.test(u));
    if (php) {
        const phpText = await renderPageText(php, timeoutMs);
        servers = servers.concat(serverLinksFromText(phpText));
    } else if (hub) {
        const hubText = await renderPageText(hub, timeoutMs);
        const hubUrls = extractUrlsFromText(hubText);
        const php2 = hubUrls.find((u) => /hubcloud\.php\?/i.test(u));
        if (php2) {
            const phpText2 = await renderPageText(php2, timeoutMs);
            servers = servers.concat(serverLinksFromText(phpText2));
        } else {
            servers = servers.concat(serverLinksFromText(hubText));
        }
    }
    return dedupeLinks(servers);
}

/** hubcloud /drive/ page → final servers. */
async function bypassHubcloud(urlStr, timeoutMs) {
    const php = await hubcloudDriveToPhp(urlStr, timeoutMs);
    if (!php) return [];
    const html2 = await fetchPage(php, { referer: urlStr, timeoutMs });
    return extractServerLinks(html2);
}

/**
 * nexdrive.you pages are ad-lockered. Best-effort: only return a link when the
 * page embeds one of our target servers directly.
 */
async function bypassNexdrive(urlStr, timeoutMs) {
    const html = await fetchPage(urlStr, { timeoutMs });
    return extractServerLinks(html);
}

/** Build a per-link timeout from the global budget. */
function perAttemptTimeout(budgetMs) {
    return Math.max(3_000, Math.min(9_000, Math.floor(budgetMs)));
}

/** Append a throwaway query param so edge caches (CF caches these pages even
 * with no-store) and per-IP rate limits serve us a FRESH variant on retry. */
function cacheBust(urlStr) {
    try {
        const u = new URL(urlStr);
        u.searchParams.set('r', String(Date.now() % 1_000_000));
        return u.href;
    } catch {
        return urlStr;
    }
}

/** True when the page family is worth one retry on an empty extraction
 * (hubcloud/hubdrive edges intermittently serve rate-limit/WAF junk pages). */
const RETRY_ON_EMPTY_RE = /hubdrive\.|hubcloud\./i;

/** True when the URL host is one of the bypassable file-page families. */
export function isBypassableUrl(urlStr) {
    const host = hostOf(String(urlStr || ''));
    return /(^|\.)(hubcloud|hubdrive|hubcdn|hubstream|hdhubdrive|driveseed|hdstream4u|nexdrive|gdflix)\.[a-z.]+$/i.test(host);
}

/** Resolve ONE intermediate link to direct server links (enrichment path). Never throws. */
async function resolveLink(rawUrl, budgetMs) {
    const urlStr = canonicalizeHost(String(rawUrl || ''));
    if (!/^https?:\/\//i.test(urlStr)) return [];
    const timeoutMs = perAttemptTimeout(budgetMs);
    const host = hostOf(urlStr);

    try {
        if (/gdflix\./i.test(host)) {
            const html = await fetchPage(urlStr, { timeoutMs });
            return bypassGdflixFromHtml(html);
        }
        if (/hubcdn\./i.test(host)) return await bypassHubcdn(urlStr, timeoutMs);
        if (/hubdrive\.|hdstream4u\./i.test(host)) return await bypassHubdrive(urlStr, timeoutMs);
        if (/hubcloud\.|hubstream\.|driveseed\./i.test(host)) return await bypassHubcloud(urlStr, timeoutMs);
        if (/nexdrive\./i.test(host)) return await bypassNexdrive(urlStr, timeoutMs);
        // Unknown host → maybe it's already one of our final servers
        const cls = classifyServer(urlStr);
        return cls ? [{ label: cls.label, serverKey: cls.key, url: urlStr }] : [];
    } catch (err) {
        logger.warn(`[HdHubBypass] ${host} resolve failed: ${err?.message || err}`);
        return [];
    }
}

/* ─────────────────────── /bypass command (user path) ────────────────────── */

/**
 * Step-by-step diagnostics for one link (debug endpoint): per-hop status,
 * size, title, extracted counts. Never throws.
 */
export async function debugResolve(rawUrl, timeoutMs = 9_000) {
    const steps = [];
    const grab = async (label, urlStr, referer) => {
        const step = { label, url: urlStr };
        try {
            const res = await axios.get(canonicalizeHost(urlStr), {
                timeout: timeoutMs,
                maxRedirects: 5,
                maxContentLength: 3 * 1024 * 1024,
                headers: { ...DEFAULT_HEADERS, ...(referer ? { Referer: referer } : {}) },
                validateStatus: () => true,
            });
            const html = typeof res.data === 'string' ? res.data : String(res.data || '');
            step.status = res.status;
            step.bytes = html.length;
            step.title = (html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || '').trim().slice(0, 80);
            step.serverLinks = extractServerLinks(html).length;
            step.phpAnchor = downloadAnchorFromHtml(html, urlStr) || workerAnchorFromHtml(html) || null;
            step.cfChallenge = /just a moment|cf-browser-verification|challenge-platform|attention required/i.test(html);
            step.head = html.replace(/\s+/g, ' ').slice(0, 200);
            steps.push(step);
            return step.phpAnchor || (/hubdrive/i.test(hostOf(urlStr))
                ? ([...html.matchAll(/href="([^"]+)"/gi)].map((m2) => m2[1]).find((u2) => u2.includes('hubcloud')) || null)
                : null);
        } catch (e) {
            step.error = String(e?.message || e).slice(0, 150);
            steps.push(step);
            return null;
        }
    };
    const url = canonicalizeHost(String(rawUrl || '').trim());
    const h = hostOf(url);
    if (/hubdrive|hdstream4u/i.test(h)) {
        const hub = await grab('hubdrive-page', url);
        if (hub) {
            const php = await grab('hubcloud-drive', hub, url);
            if (php) await grab('hubcloud-php', php, hub);
        }
    } else if (/hubcloud|hubstream|driveseed/i.test(h)) {
        const php = await grab('hubcloud-drive', url);
        if (php) await grab('hubcloud-php', php, url);
    }
    const proxy = await (async () => {
        try { return await resolveViaJina(url, timeoutMs); } catch { return []; }
    })();
    let hybrid = [];
    if (/hubdrive|hdstream4u/i.test(h)) {
        const hs = { label: 'hybrid(reader→direct)' };
        steps.push(hs);
        try {
            const md = await renderPageText(url, timeoutMs);
            hs.mdBytes = String(md || '').length;
            const driveUrl = extractUrlsFromText(md).find((u) => /hubcloud\.[a-z.]+\/drive\//i.test(u));
            hs.driveUrl = driveUrl || null;
            if (driveUrl) {
                const php = await hubcloudDriveToPhp(driveUrl, timeoutMs);
                hs.php = php || null;
                if (php) {
                    const html2 = await fetchPage(php, { referer: driveUrl, timeoutMs });
                    hybrid = extractServerLinks(html2);
                    hs.servers = hybrid.length;
                }
            }
        } catch (e) {
            hs.error = String(e?.message || e).slice(0, 120);
        }
    }
    return {
        steps,
        jinaFallbackLinks: proxy.length,
        jinaLabels: proxy.map((l) => l.label),
        hybridLinks: hybrid.length,
        hybridLabels: hybrid.map((l) => l.label),
    };
}

/**
 * Resolve ONE user-supplied link: ONE page fetch yields title AND links.
 * @returns {Promise<{title:string, links:Array<{label:string, url:string}>}>}
 */
export async function bypassSingleLink(rawUrl, budgetMs = 12_000) {
    const urlStr = canonicalizeHost(String(rawUrl || '').trim());
    if (!/^https?:\/\//i.test(urlStr)) return { title: '', links: [] };
    return resolveForUser(urlStr, hostOf(urlStr), perAttemptTimeout(budgetMs));
}

/**
 * One user-facing resolution: fetch the page once, extract title AND links,
 * routing by host family. Never throws.
 */
async function resolveForUser(urlStr, host, timeoutMs) {
    let html = '';
    try {
        html = await fetchPage(urlStr, { timeoutMs });
    } catch (err) {
        logger.warn(`[HdHubBypass] ${host} page fetch failed: ${err?.message || err}`);
        return { title: '', links: [] };
    }
    const title = (html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || '').trim().slice(0, 90);
    const extract = (h) => {
        if (/gdflix\./i.test(host)) return bypassGdflixFromHtml(h);
        if (/hubcdn\./i.test(host)) return bypassHubcdnFromHtml(h);
        if (/hubdrive\.|hdstream4u\./i.test(host)) return bypassHubdriveFromHtml(h, urlStr, timeoutMs);
        return bypassHubcloudFromHtml(h, urlStr, timeoutMs);
    };
    let links = [];
    try {
        links = await extract(html);
        // Up to 2 backoff + cache-bust retries when a hubdrive/hubcloud page
        // yields nothing — recovers transient rate-limit/WAF/cache-junk and
        // short network-filter blocks on the hubcloud hop.
        for (const waitMs of [900, 1800]) {
            if (links.length || !RETRY_ON_EMPTY_RE.test(host)) break;
            await new Promise((r) => setTimeout(r, waitMs));
            const html2 = await fetchPage(cacheBust(urlStr), { timeoutMs });
            links = await extract(html2);
            if (links.length) logger.info(`[HdHubBypass] ${host} recovered on retry`);
        }
        // Final fallback: render the chain through the jina proxy (Cloudflare
        // challenges / datacenter-IP blocks defeat direct fetches).
        if (!links.length && RETRY_ON_EMPTY_RE.test(host)) {
            // Hybrid (hubdrive-family): hubdrive.pics CF-challenges datacenter
            // IPs, but the hubcloud hop is reachable — render ONLY the hubdrive
            // page via jina, then fetch the hubcloud chain directly.
            if (/hubdrive\.|hdstream4u\./i.test(host)) {
                try {
                    const md = await renderPageText(urlStr, timeoutMs);
                    const driveUrl = extractUrlsFromText(md).find((u) => /hubcloud\.[a-z.]+\/drive\//i.test(u));
                    if (driveUrl) {
                        const php = await hubcloudDriveToPhp(driveUrl, timeoutMs);
                        if (php) {
                            const html2 = await fetchPage(php, { referer: driveUrl, timeoutMs });
                            links = extractServerLinks(html2);
                            if (links.length) logger.info(`[HdHubBypass] ${host} resolved via jina+direct hybrid`);
                        }
                    }
                } catch (e) {
                    logger.warn(`[HdHubBypass] ${host} hybrid fallback failed: ${e?.message || e}`);
                }
            }
            // Hail-mary for the other families: full chain through the proxy.
            if (!links.length) {
                try {
                    links = await resolveViaJina(urlStr, timeoutMs);
                    if (links.length) logger.info(`[HdHubBypass] ${host} resolved via jina proxy`);
                } catch (e) {
                    logger.warn(`[HdHubBypass] ${host} jina fallback failed: ${e?.message || e}`);
                }
            }
        }
    } catch (err) {
        logger.warn(`[HdHubBypass] ${host} extract failed: ${err?.message || err}`);
        links = [];
    }
    return { title, links: dedupeLinks(links) };
}

/**
 * Bypass several user links at once — a pool of parallel "agents", one per link.
 * Cross-user concurrency is bounded by this pool, so many users bypassing at
 * the same time share the same workers instead of stampeding the targets.
 * @param {string[]} urls user-supplied links
 * @param {object} [opts]
 * @param {number} [opts.maxLinks] hard cap per command (default 5)
 * @param {number} [opts.budgetMs] per-link resolution budget
 * @param {number} [opts.concurrency] worker pool size (default config.MOVIE_BYPASS_MAX_CONCURRENT || 6)
 * @returns {Promise<Array<{url:string, title:string, links:Array<{label:string,url:string}>}>>}
 */
export async function bypassManyLinks(urls, { maxLinks = 5, budgetMs = 12_000, concurrency } = {}) {
    const seen = new Set();
    const list = [];
    for (const u of urls || []) {
        const s = canonicalizeHost(String(u || '').trim());
        if (!/^https?:\/\//i.test(s) || seen.has(s)) continue;
        seen.add(s);
        list.push(s);
    }
    const capped = list.slice(0, maxLinks);
    if (!capped.length) return [];
    const workers = Math.max(1, Math.min(capped.length, concurrency || config.MOVIE_BYPASS_MAX_CONCURRENT || 6));
    const results = new Array(capped.length).fill(null);
    let idx = 0;
    const pool = Array.from({ length: workers }, async () => {
        while (idx < capped.length) {
            const i = idx++;
            const urlStr = capped[i];
            try {
                results[i] = {
                    url: urlStr,
                    ...(await resolveForUser(urlStr, hostOf(urlStr), perAttemptTimeout(budgetMs))),
                };
            } catch (err) {
                logger.warn(`[HdHubBypass] pool link failed (${hostOf(urlStr)}): ${err?.message || err}`);
            }
        }
    });
    await Promise.all(pool);
    return results.filter(Boolean);
}

/* ────────────────── Enrichment path (/movie vault & HDHub rows) ────────────────── */

/**
 * Resolve many intermediate links at once (parallel) under a shared time budget.
 * @param {string[]} urls intermediate links from API results
 * @param {object} opts
 * @param {number} [opts.budgetMs] total wall-clock budget for the whole batch
 * @param {number} [opts.maxLinks] cap on how many links to resolve
 * @returns {Promise<Map<string, {label:string, url:string}[]>>} url → direct links
 */
export async function resolveManyLinks(urls, { budgetMs = 12_000, maxLinks = 8 } = {}) {
    const seen = new Set();
    const all = [];
    for (const u of urls || []) {
        const s = String(u);
        if (!/^https?:\/\//i.test(s) || seen.has(s)) continue;
        seen.add(s);
        all.push(s);
    }
    // Resolve real file pages first; ad-lockered nexdrive pages last (best-effort)
    const rank = (u) => (/nexdrive\./i.test(hostOf(u)) ? 1 : 0);
    const list = all.sort((a, b) => rank(a) - rank(b)).slice(0, maxLinks);
    if (!list.length) return new Map();

    const started = Date.now();
    const entries = list.map((u) => ({
        url: u,
        promise: Promise.race([
            resolveLink(u, budgetMs),
            new Promise((resolve) => setTimeout(() => resolve([]), budgetMs + 1_000)),
        ]),
    }));

    const settled = await Promise.allSettled(entries.map((e) => e.promise));
    const map = new Map();
    for (let i = 0; i < entries.length; i++) {
        const direct = settled[i].status === 'fulfilled' ? settled[i].value : [];
        if (direct.length) {
            map.set(entries[i].url, dedupeLinks(direct));
        }
    }

    logger.info(`[HdHubBypass] ${map.size}/${list.length} link(s) resolved in ${Date.now() - started}ms`);
    return map;
}

/**
 * Rewrite one result's links: attach direct server links to each quality entry,
 * keep unresolved links (other sources' mirrors, telegram, pages) untouched.
 */
export function applyResolvedLinks(result, resolvedMap) {
    if (!result || !resolvedMap?.size || !Array.isArray(result.links)) return result;

    const out = [];
    for (const link of result.links) {
        const direct = resolvedMap.get(String(link.url || ''));
        if (direct?.length) {
            for (const d of direct) {
                out.push({
                    ...link,
                    label: d.label,
                    url: d.url,
                    // keep size/quality/audio from the quality entry
                });
            }
        } else {
            out.push(link);
        }
    }
    return { ...result, links: out };
}

/** True if any link in the result is bypassable by this service. */
export function hasBypassableLinks(result) {
    return Array.isArray(result?.links) && result.links.some((l) => isBypassableUrl(String(l?.url || '')));
}

// Labels produced by the bypass for direct server links
const SERVER_LABEL_RE = /(R2|10Gbps|FSLv2|FuckingFast|PixelDrain)/i;

/**
 * Cap an enriched link list for WhatsApp: at most 2 direct servers per quality,
 * dedupe exact URLs, cap total per result (servers win over mirrors).
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

/**
 * Enrich ANY set of grouped results (HDHub API rows, ProNooB Drive vault rows, ...)
 * by resolving bypassable intermediate links in ONE parallel batch under budgetMs.
 * Non-bypassable results/links pass through untouched. Never throws.
 */
export async function enrichResultsWithDirectLinks(results, budgetMs = 8_000) {
    try {
        if (config.MOVIE_HD_BYPASS_ENABLED === false) return results;
        if (!budgetMs || budgetMs < 4_000) return results;
        if (!Array.isArray(results) || !results.length) return results;

        const maxLinks = config.MOVIE_HD_BYPASS_MAX_LINKS || 10;
        const candidates = [];
        for (const r of results) {
            for (const l of r?.links || []) {
                const u = String(l?.url || '');
                if (isBypassableUrl(u)) candidates.push(u);
            }
        }
        if (!candidates.length) return results;

        const started = Date.now();
        const resolvedMap = await resolveManyLinks(candidates, { budgetMs, maxLinks });
        if (!resolvedMap.size) return results;

        let touched = false;
        const enriched = results.map((r) => {
            const urls = (r?.links || []).map((l) => String(l?.url || ''));
            if (!urls.some((u) => resolvedMap.has(u))) return r;
            touched = true;
            const withDirect = applyResolvedLinks(r, resolvedMap);
            return { ...withDirect, links: trimEnrichedLinks(withDirect.links) };
        });

        logger.info(
            `[HdHubBypass] enriched ${resolvedMap.size} link(s) across ${enriched.length} result(s)`
            + ` in ${Date.now() - started}ms`,
        );
        return touched ? enriched : results;
    } catch (err) {
        logger.warn(`[HdHubBypass] enrich failed (non-fatal): ${err?.message || err}`);
        return results;
    }
}

export const hdHubBypassService = { resolveManyLinks, applyResolvedLinks, enrichResultsWithDirectLinks, hasBypassableLinks };
export default hdHubBypassService;
