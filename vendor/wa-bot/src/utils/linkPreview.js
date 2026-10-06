/**
 * WhatsApp link preview helpers (requires link-preview-js peer dep).
 */

import { getUrlInfo } from 'baileys';
import { logger } from './logger.js';

const PREVIEW_OPTS = {
    thumbnailWidth: 640,
    fetchOpts: { timeout: 20000 },
};

/**
 * Fetch link preview metadata for a URL.
 * @param {string} url
 * @returns {Promise<object | undefined>}
 */
export async function buildLinkPreview(url) {
    if (!url) {
        return undefined;
    }
    try {
        const preview = await getUrlInfo(url, PREVIEW_OPTS);
        if (preview?.title) {
            logger.debug(`Link preview ready: ${preview.title.slice(0, 80)}`);
        }
        return preview;
    } catch (err) {
        logger.warn(`Link preview failed for ${url}: ${err.message}`);
        return undefined;
    }
}

/**
 * Send text with an explicit link preview card when possible.
 * @param {import('baileys').WASocket} sock
 * @param {string} chatId
 * @param {string} text
 * @param {string} url
 * @param {object} [sendOpts] extra sendMessage options (e.g. { quoted })
 */
export async function sendTextWithLinkPreview(sock, chatId, text, url, sendOpts = {}) {
    const linkPreview = await buildLinkPreview(url);
    await sock.sendMessage(chatId, linkPreview ? { text, linkPreview } : { text }, sendOpts);
}
