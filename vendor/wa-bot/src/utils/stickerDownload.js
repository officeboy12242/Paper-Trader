/**
 * Download sticker bytes from group or channel WAMessages.
 * Simplified: no longer uses newsletterFetchMessages (times out).
 * Relies on direct download + updateMediaMessage for channels.
 */

import {
    downloadContentFromMessage,
    downloadMediaMessage,
    normalizeMessageContent,
} from 'baileys';
import pino from 'pino';
import { logger } from './logger.js';
import { extractStickerFromMessage, isNewsletterChat } from './stickerExtract.js';

const baileysLogger = pino({ level: 'silent' });
const DOWNLOAD_TIMEOUT_MS = 30000; // Increased to 30 seconds
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
    ]);
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** Valid WebP files start with RIFF....WEBP */
export function isValidWebpBuffer(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 16) {
        return false;
    }
    return buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
}

export function isStickerDownloadReady(sticker) {
    return hasMediaKey(sticker);
}

function hasDirectMediaUrl(sticker) {
    return Boolean(sticker?.url || sticker?.directPath);
}

/** Channel stickers often ship with a CDN url before mediaKey is available. */
export function isChannelStickerReady(sticker) {
    if (!sticker) {
        return false;
    }
    return hasMediaKey(sticker) || hasDirectMediaUrl(sticker);
}

/** Gate sticker forwarding — channels accept url/directPath; groups need mediaKey. */
export function isStickerForwardReady(chatId, sticker) {
    if (!sticker) {
        return false;
    }
    if (isNewsletterChat(chatId)) {
        return isChannelStickerReady(sticker);
    }
    return isStickerDownloadReady(sticker);
}

function assertValidWebp(buffer, context) {
    if (!isValidWebpBuffer(buffer)) {
        throw new Error(`${context}: not valid WebP (encrypted or incomplete media)`);
    }
    return buffer;
}

async function tryDirectDownload(url, directPath) {
    const downloadUrl = url || (directPath ? `https://mmg.whatsapp.net${directPath}` : null);
    if (!downloadUrl) return null;
    
    const https = await import('https');
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('timeout')), 15000); // 15 second timeout
        
        const req = https.default.get(downloadUrl, { timeout: 15000 }, (res) => {
            if (res.statusCode !== 200) {
                clearTimeout(timeout);
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                clearTimeout(timeout);
                resolve(Buffer.concat(chunks));
            });
            res.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });
        });
        
        req.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });
        
        req.on('timeout', () => {
            req.destroy();
            clearTimeout(timeout);
            reject(new Error('request timeout'));
        });
    });
}

function hasMediaKey(media) {
    if (!media?.mediaKey) {
        return false;
    }
    if (Buffer.isBuffer(media.mediaKey)) {
        return media.mediaKey.length > 0;
    }
    if (media.mediaKey instanceof Uint8Array) {
        return media.mediaKey.length > 0;
    }
    return true;
}

function downloadContext(sock) {
    return {
        logger: baileysLogger,
        reuploadRequest: sock?.updateMediaMessage
            ? sock.updateMediaMessage.bind(sock)
            : undefined,
    };
}

/** @param {import('baileys').WASocket} sock */
export function createDownloadContext(sock) {
    return downloadContext(sock);
}

/**
 * @param {import('baileys').WASocket} sock
 * @param {import('baileys').proto.IWebMessageInfo} waMessage
 * @returns {Promise<Buffer>}
 */
async function tryDownloadMediaMessage(sock, waMessage) {
    const buffer = await withTimeout(
        downloadMediaMessage(waMessage, 'buffer', {}, downloadContext(sock)),
        DOWNLOAD_TIMEOUT_MS,
        'downloadMediaMessage'
    );
    if (!buffer?.length) {
        throw new Error('empty sticker buffer');
    }
    return buffer;
}

/**
 * @param {import('baileys').WASocket} sock
 * @param {object} stickerPayload
 * @returns {Promise<Buffer>}
 */
async function tryDownloadContent(sock, stickerPayload) {
    const downloadPromise = (async () => {
        const stream = await downloadContentFromMessage(
            stickerPayload,
            'sticker',
            downloadContext(sock)
        );
        const chunks = [];
        for await (const chunk of stream) {
            chunks.push(chunk);
        }
        return Buffer.concat(chunks);
    })();
    return withTimeout(downloadPromise, DOWNLOAD_TIMEOUT_MS, 'downloadContentFromMessage');
}


/**
 * @param {import('baileys').WASocket} sock
 * @param {import('baileys').proto.IWebMessageInfo} waMessage
 * @returns {Promise<Buffer>}
 */
export async function downloadStickerBuffer(sock, waMessage) {
    const chatId = waMessage?.key?.remoteJid;
    const isChannel = isNewsletterChat(chatId);
    const sticker = extractStickerFromMessage(waMessage.message);

    if (isChannel && sticker) {
        // Every reason a channel sticker fails used to be logger.debug, so at the
        // default level a skipped sticker left no trace at all — which is why
        // "channels skip most" was undiagnosable. Reasons are collected and
        // reported once, at warn, on the throw.
        const why = [];

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                const directBuffer = await tryDirectDownload(sticker.url, sticker.directPath);
                if (isValidWebpBuffer(directBuffer)) {
                    return directBuffer;
                }
                why.push(`direct#${attempt}: not WebP (${directBuffer ? `${directBuffer.length}B` : 'no url/directPath'})`);
            } catch (err) {
                why.push(`direct#${attempt}: ${err.message}`);
            }
            if (attempt < MAX_RETRIES) {
                await delay(RETRY_DELAY_MS * attempt);
            }
        }

        if (hasMediaKey(sticker)) {
            try {
                return assertValidWebp(await tryDownloadContent(sock, sticker), 'channel encrypted');
            } catch (err) {
                why.push(`encrypted: ${err.message}`);
            }
            try {
                return assertValidWebp(await tryDownloadMediaMessage(sock, waMessage), 'channel media');
            } catch (err) {
                why.push(`reupload: ${err.message}`);
            }
        } else {
            // The common channel case: CDN pointer present but no key yet. Naming it
            // explicitly separates "waiting for the key" from "genuinely broken".
            why.push('no mediaKey yet (awaiting media update / reupload)');
        }

        throw new Error(`Channel sticker download failed — ${why.join(' | ')}`);
    }

    if (!isStickerDownloadReady(sticker)) {
        throw new Error('Sticker media not ready (missing mediaKey)');
    }

    // Group stickers — encrypted download only (direct URLs are encrypted)
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            if (sticker && hasMediaKey(sticker)) {
                try {
                    return assertValidWebp(await tryDownloadMediaMessage(sock, waMessage), 'group media');
                } catch (err) {
                    lastError = err;
                }
            }

            if (sticker) {
                try {
                    return assertValidWebp(await tryDownloadContent(sock, sticker), 'group content');
                } catch (err) {
                    lastError = err;
                }
            }

            if (sticker) {
                return assertValidWebp(await tryDownloadMediaMessage(sock, waMessage), 'group media fallback');
            }
        } catch (err) {
            lastError = err;
            logger.debug(`Sticker download attempt ${attempt} failed: ${err.message}`);
        }

        if (attempt < MAX_RETRIES) {
            logger.debug(`Retrying sticker download in ${RETRY_DELAY_MS * attempt}ms...`);
            await delay(RETRY_DELAY_MS * attempt);
        }
    }

    throw lastError || new Error('No sticker found');
}
