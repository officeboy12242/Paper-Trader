/**
 * Extract sticker payloads from WhatsApp messages (groups, DMs, channels).
 */

import { normalizeMessageContent } from 'baileys';

/**
 * @param {string | null | undefined} chatId
 * @returns {boolean}
 */
export function isNewsletterChat(chatId) {
    return Boolean(chatId && typeof chatId === 'string' && chatId.includes('@newsletter'));
}

/**
 * Map a webp document to a sticker-shaped object for downloadContentFromMessage.
 * @param {import('baileys').proto.IDocumentMessage} doc
 */
function mediaAsSticker(media) {
    return {
        url: media.url,
        directPath: media.directPath,
        mediaKey: media.mediaKey,
        fileEncSha256: media.fileEncSha256,
        fileSha256: media.fileSha256,
        fileLength: media.fileLength,
        mimetype: media.mimetype || 'image/webp',
    };
}

/**
 * @param {import('baileys').proto.Message | null | undefined} message
 * @returns {object | null}
 */
export function extractStickerFromMessage(message) {
    if (!message) {
        return null;
    }

    const content = normalizeMessageContent(message);
    if (!content) {
        return null;
    }

    if (content.stickerMessage) {
        return content.stickerMessage;
    }

    const doc = content.documentMessage;
    if (doc && (doc.mimetype === 'image/webp' || doc.mimetype?.includes('webp'))) {
        return mediaAsSticker(doc);
    }

    const image = content.imageMessage;
    if (image && (image.mimetype === 'image/webp' || image.mimetype?.includes('webp'))) {
        return mediaAsSticker(image);
    }

    return null;
}
