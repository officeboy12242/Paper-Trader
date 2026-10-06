import axios from 'axios';

const DEFAULT_HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    Accept: '*/*',
};

/**
 * Download remote media into a Buffer (Instagram CDN / proxy URLs).
 */
export async function downloadMediaBuffer(url, timeoutMs = 120_000) {
    const res = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: timeoutMs,
        maxRedirects: 10,
        headers: DEFAULT_HEADERS,
        validateStatus: (status) => status >= 200 && status < 300,
    });
    const buffer = Buffer.from(res.data);
    if (!buffer.length) {
        throw new Error('empty response');
    }
    return buffer;
}
