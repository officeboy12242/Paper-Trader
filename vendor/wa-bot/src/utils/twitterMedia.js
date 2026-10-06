/**
 * Twitter/X media resolver backed by the fxtwitter API.
 *
 * snapsave scrapes the X web page and returns a blank entry for GIF tweets
 * (`{ url: '', type: 'image' }`), so /tw dead-ends with "No media URLs in the
 * response". fxtwitter proxies the public syndication API and returns real
 * URLs for photos, videos and GIFs — including `/i/status/<id>` links.
 */

import axios from 'axios';

const FX_TIMEOUT_MS = 12_000;
const FX_ENDPOINT = 'https://api.fxtwitter.com/status';

const HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    Accept: 'application/json',
};

/** Pull the numeric status id out of any X/Twitter permalink shape. */
export function extractTweetId(url) {
    const m = String(url || '').match(/\/status(?:es)?\/(\d{5,25})/);
    return m ? m[1] : null;
}

/** Highest-bitrate mp4 variant, falling back to the item's own url. */
function pickBestVariant(item) {
    const variants = Array.isArray(item?.variants) ? item.variants : [];
    const mp4s = variants.filter((v) => v?.url && (v.content_type === 'video/mp4' || /\.mp4(?:\?|$)/i.test(v.url)));
    if (!mp4s.length) {
        return item?.url || null;
    }
    mp4s.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    return mp4s[0].url;
}

/**
 * @param {string} url tweet permalink
 * @returns {Promise<Array<{ url: string, type: 'image'|'video', gif?: boolean }>>}
 */
export async function fetchTwitterMedia(url, { timeoutMs = FX_TIMEOUT_MS } = {}) {
    const id = extractTweetId(url);
    if (!id) {
        throw new Error('No tweet id in the URL.');
    }

    const res = await axios.get(`${FX_ENDPOINT}/${id}`, {
        timeout: timeoutMs,
        headers: HEADERS,
        // 401/404 come back as JSON with a code — read them instead of throwing.
        validateStatus: (status) => status >= 200 && status < 500,
    });

    const body = res.data;
    if (res.status !== 200 || body?.code !== 200) {
        throw new Error(body?.message || `Upstream returned HTTP ${res.status}.`);
    }

    const all = body?.tweet?.media?.all || [];
    const media = [];
    for (const item of all) {
        const type = String(item?.type || '').toLowerCase();
        if (type === 'photo' || type === 'image') {
            if (item?.url) {
                media.push({ url: item.url, type: 'image' });
            }
            continue;
        }
        const best = pickBestVariant(item);
        if (best) {
            // GIFs are mp4s on X — flag them so WhatsApp loops them like a GIF.
            media.push({ url: best, type: 'video', gif: type === 'gif' });
        }
    }
    return media;
}
