/**
 * Extract first Twitter/X post URL from free text.
 * Supports twitter.com and x.com, with or without https:// (WhatsApp often strips the scheme in matchedText).
 */
const TW_URL_RE = /((?:https?:\/\/)?(?:www\.|mobile\.|m\.)?(?:twitter\.com|x\.com)\/[^\s<>"']+)/i;

export function extractTwitterUrl(text) {
    if (!text || typeof text !== 'string') {
        return null;
    }
    const m = text.trim().match(TW_URL_RE);
    if (!m) {
        return null;
    }
    let url = m[1];
    url = url.replace(/[.,;:!?)]+$/u, '');
    if (!/^https?:\/\//i.test(url)) {
        url = `https://${url}`;
    }
    if (url.includes('?')) {
        url = url.split('?')[0];
    }
    return url;
}

export function isSupportedTwitterUrl(url) {
    if (!url) return false;
    const hostOk = /(?:twitter\.com|x\.com)\//i.test(url);
    return hostOk && url.includes('/status/');
}
