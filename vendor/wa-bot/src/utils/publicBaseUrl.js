/**
 * Resolve the public base URL used for movie /d/:code short links.
 * Prefer platform-injected values — no PUBLIC_URL env required on Koyeb/Render.
 *
 * Priority:
 *   1. PUBLIC_URL (optional override)
 *   2. RENDER_EXTERNAL_URL (Render injects)
 *   3. KOYEB_PUBLIC_DOMAIN (Koyeb injects for public web services)
 *   4. Host learned from inbound HTTP (x-forwarded-host / host)
 *   5. ''  — caller may fall back to localhost for local dev
 */

/** @type {string} */
let learnedPublicBase = '';
/** Render /d/ base when Koyeb host is blocked by TinyURL (shared MongoDB). */
let cachedRenderMovieBase = '';

/** TinyURL returns HTTP 400 for these — mint /d/ on Render instead. */
const TINYURL_BLOCKED_HOST_RE = /\.koyeb\.app$/i;

function stripSlash(s) {
    return String(s || '').trim().replace(/\/$/, '');
}

export function isTinyUrlBlockedHost(baseUrl) {
    try {
        return TINYURL_BLOCKED_HOST_RE.test(new URL(baseUrl).hostname);
    } catch {
        return false;
    }
}

function normalizeDomain(raw) {
    const d = stripSlash(String(raw || '').replace(/^https?:\/\//i, ''));
    if (!d) return '';
    // Reject loopback / private-looking hosts — never mint TinyURLs against these.
    if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/i.test(d)) return '';
    if (/\.internal$/i.test(d)) return '';
    return d;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} https://… or ''
 */
export function resolvePublicBaseUrl(env = process.env) {
    const explicit = stripSlash(env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || '');
    if (explicit) return explicit;

    const koyeb = normalizeDomain(env.KOYEB_PUBLIC_DOMAIN);
    if (koyeb) return `https://${koyeb}`;

    if (learnedPublicBase) return learnedPublicBase;

    return '';
}

/**
 * Public base for expiring movie /d/:code links (native Koyeb/Render host).
 * Render bootstrap is only a fallback when no public URL is known yet.
 */
export function resolveMovieLinkPublicBase(env = process.env) {
    const override = stripSlash(env.MOVIE_LINK_PUBLIC_URL || '');
    if (override) return override;

    const publicBase = resolvePublicBaseUrl(env);
    if (publicBase) return publicBase;

    return cachedRenderMovieBase || '';
}

/**
 * Fallback: fetch Render service URL when Koyeb has no public domain at boot.
 */
export async function bootstrapMovieLinkPublicBase(env = process.env) {
    if (resolveMovieLinkPublicBase(env)) return resolveMovieLinkPublicBase(env);

    const apiKey = env.RENDER_API_KEY?.trim();
    const serviceId = env.RENDER_SERVICE_ID?.trim();
    if (!apiKey || !serviceId) return resolveMovieLinkPublicBase(env);

    try {
        const res = await fetch(`https://api.render.com/v1/services/${serviceId}`, {
            headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        });
        if (!res.ok) return resolveMovieLinkPublicBase(env);
        const svc = await res.json();
        const url = stripSlash(svc?.serviceDetails?.url || '');
        if (url && !isTinyUrlBlockedHost(url)) {
            cachedRenderMovieBase = url;
        }
    } catch {
        // ponytail: Render API optional — MOVIE_LINK_PUBLIC_URL still works
    }
    return resolveMovieLinkPublicBase(env);
}

/** @internal test helper */
export function _setRenderMovieLinkBaseForTests(url) {
    cachedRenderMovieBase = stripSlash(url);
}

/**
 * Remember the public host from an inbound HTTP request (Koyeb/Render proxy).
 * Safe no-op for localhost / internal hosts.
 * @param {import('http').IncomingMessage} req
 */
export function learnPublicBaseFromRequest(req) {
    if (learnedPublicBase) return;
    const xfHost = String(req?.headers?.['x-forwarded-host'] || '')
        .split(',')[0]
        .trim();
    const host = normalizeDomain(xfHost || req?.headers?.host || '');
    if (!host) return;
    const xfProto = String(req?.headers?.['x-forwarded-proto'] || '')
        .split(',')[0]
        .trim()
        .toLowerCase();
    const proto = xfProto === 'http' || xfProto === 'https' ? xfProto : 'https';
    learnedPublicBase = `${proto}://${host}`;
}

/** @internal test helper */
export function _resetLearnedPublicBaseForTests() {
    learnedPublicBase = '';
    cachedRenderMovieBase = '';
}
