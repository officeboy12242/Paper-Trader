/**
 * Extract first Instagram post/reel/TV/share URL from free text.
 * Supports URLs with or without https:// (WhatsApp often strips the scheme in matchedText).
 */
const IG_URL_RE = /((?:https?:\/\/)?(?:www\.)?instagram\.com\/[^\s<>"']+)/i;

export function extractInstagramUrl(text) {
    if (!text || typeof text !== 'string') {
        return null;
    }
    const m = text.trim().match(IG_URL_RE);
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

export function isSupportedInstagramUrl(url) {
    if (!url) return false;
    return (
        url.includes('instagram.com/p/') ||
        url.includes('instagram.com/reel/') ||
        url.includes('instagram.com/reels/') ||
        url.includes('instagram.com/tv/') ||
        url.includes('instagram.com/share/') ||
        /^https?:\/\/(www\.)?instagram\.com\//i.test(url)
    );
}
