/**
 * Stream remote media to a temp file instead of a full in-memory Buffer.
 *
 * Large downloads (up to the WhatsApp document cap) otherwise blow up RAM on
 * small Render instances — we already fight OOM there. Sizes over `maxBytes`
 * abort the stream and delete the partial file (no RAM was consumed).
 */

import axios from 'axios';
import { createWriteStream, promises as fsp } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';

const DEFAULT_HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    Accept: '*/*',
};

export function createMediaTempFile(prefix = 'media_') {
    return path.join(tmpdir(), `${prefix}${Date.now()}_${Math.random().toString(36).slice(2, 8)}.bin`);
}

/**
 * @param {string} url
 * @param {string} filePath target temp file path (see createMediaTempFile)
 * @param {{ maxBytes?: number, timeoutMs?: number }} [opts]
 * @returns {Promise<string>} filePath on success
 */
export async function downloadMediaToFile(url, filePath, { maxBytes = 300 * 1024 * 1024, timeoutMs = 300_000 } = {}) {
    const writer = createWriteStream(filePath);
    const res = await axios.get(url, {
        responseType: 'stream',
        timeout: timeoutMs,
        maxRedirects: 10,
        headers: DEFAULT_HEADERS,
        validateStatus: (status) => status >= 200 && status < 300,
    });

    let bytes = 0;
    let tooBig = false;
    if (res.data?.on) {
        res.data.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > maxBytes) {
                tooBig = true;
                res.data.destroy(new Error('MEDIA_TOO_LARGE'));
            }
        });
    }

    try {
        await pipeline(res.data, writer);
    } catch (err) {
        await fsp.rm(filePath, { force: true }).catch(() => {});
        if (tooBig || err?.message === 'MEDIA_TOO_LARGE') {
            const big = new Error(`Media exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit`);
            big.code = 'MEDIA_TOO_LARGE';
            throw big;
        }
        throw err;
    }

    if (tooBig || bytes > maxBytes) {
        await fsp.rm(filePath, { force: true }).catch(() => {});
        const big = new Error(`Media exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit`);
        big.code = 'MEDIA_TOO_LARGE';
        throw big;
    }

    return filePath;
}
