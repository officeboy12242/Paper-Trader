/**
 * Find / download WhatsApp document attachments (current msg or quoted).
 *
 * Quoted docs often arrive as stubs (fileName/mimetype only, no mediaKey/url).
 * We hydrate those from the bot's short message cache, then ask Baileys to
 * reupload if needed before downloadMediaMessage.
 */

import { downloadMediaMessage, normalizeMessageContent } from 'baileys';
import pino from 'pino';
import { buildQuotedTargetMessage, getContextInfo } from './waMessage.js';
import { logger } from './logger.js';

const baileysLogger = pino({ level: 'silent' });
const DOWNLOAD_TIMEOUT_MS = 45_000;

function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Document download timed out')), ms)),
    ]);
}

export function hasDocumentMediaFields(doc) {
    if (!doc || typeof doc !== 'object') return false;
    return Boolean(doc.url || doc.directPath || doc.mediaKey || doc.thumbnailDirectPath);
}

/**
 * Walk wrappers looking for a documentMessage (handles nested caption / view-once / etc.).
 * @param {import('baileys').proto.IMessage | null | undefined} message
 * @param {number} [depth]
 * @returns {{ document: object, wrapperMessage: object } | null}
 */
export function findDocumentInMessage(message, depth = 0) {
    if (!message || depth > 6) return null;
    const c = normalizeMessageContent(message) || message;

    const doc =
        c.documentMessage ||
        c.documentWithCaptionMessage?.message?.documentMessage ||
        null;
    if (doc) {
        return {
            document: doc,
            wrapperMessage: c.documentMessage ? c : { documentMessage: doc },
        };
    }

    // Deep walk — interactive headers, templates, leftover wrappers
    for (const value of Object.values(c)) {
        if (!value || typeof value !== 'object' || Buffer.isBuffer(value)) continue;
        if (value.documentMessage) {
            return {
                document: value.documentMessage,
                wrapperMessage: { documentMessage: value.documentMessage },
            };
        }
        if (value.message && typeof value.message === 'object') {
            const nested = findDocumentInMessage(value.message, depth + 1);
            if (nested) return nested;
        }
        // header / hydratedTemplate style nests
        if (value.header || value.hydratedTemplate) {
            const nested = findDocumentInMessage(value, depth + 1);
            if (nested) return nested;
        }
    }
    return null;
}

/**
 * Prefer attached document; else quoted document.
 * @param {import('baileys').proto.IWebMessageInfo | null | undefined} waMessage
 */
export function resolveDocumentTarget(waMessage) {
    if (!waMessage?.message) return null;

    const attached = findDocumentInMessage(waMessage.message);
    if (attached) {
        return {
            waMessage: { ...waMessage, message: attached.wrapperMessage },
            document: attached.document,
            source: 'attached',
        };
    }

    const quoted = buildQuotedTargetMessage(waMessage);
    if (!quoted?.message) return null;
    const qDoc = findDocumentInMessage(quoted.message);
    if (!qDoc) return null;
    return {
        waMessage: { ...quoted, message: qDoc.wrapperMessage },
        document: qDoc.document,
        source: 'quoted',
    };
}

/**
 * Replace a thin quoted stub with the full cached original message (has mediaKey).
 */
export function hydrateDocumentTarget(sock, waMessage, target) {
    if (!target || target.source !== 'quoted') return target;
    if (hasDocumentMediaFields(target.document)) return target;

    const ctx = getContextInfo(waMessage?.message);
    const stanzaId = ctx?.stanzaId;
    const remoteJid = ctx?.remoteJid || waMessage?.key?.remoteJid;
    if (!stanzaId || !remoteJid) return target;

    const cached =
        sock?.__getCachedMessage?.({ remoteJid, id: stanzaId }) ||
        null;
    if (!cached) return target;

    const full = findDocumentInMessage(cached);
    if (!full || !hasDocumentMediaFields(full.document)) return target;

    return {
        waMessage: {
            key: {
                remoteJid,
                id: stanzaId,
                fromMe: false,
                ...(ctx.participant ? { participant: ctx.participant } : {}),
                ...(ctx.participantLid ? { participantLid: ctx.participantLid } : {}),
                ...(ctx.participantPn ? { participantPn: ctx.participantPn } : {}),
            },
            message: full.wrapperMessage,
        },
        document: full.document,
        source: 'quoted-hydrated',
    };
}

async function maybeReupload(sock, target) {
    if (!sock?.updateMediaMessage || hasDocumentMediaFields(target.document)) {
        return target;
    }
    try {
        const updated = await sock.updateMediaMessage(target.waMessage);
        if (!updated?.message) return target;
        const found = findDocumentInMessage(updated.message);
        if (!found) return target;
        return {
            waMessage: { ...updated, message: found.wrapperMessage },
            document: found.document,
            source: `${target.source}+reupload`,
        };
    } catch (err) {
        logger.debug(`Document reupload skipped: ${err.message}`);
        return target;
    }
}

function downloadCtx(sock) {
    return {
        logger: baileysLogger,
        reuploadRequest: sock?.updateMediaMessage
            ? sock.updateMediaMessage.bind(sock)
            : undefined,
        getMessage: async (key) => {
            if (typeof sock?.__getCachedMessage === 'function') {
                const hit = sock.__getCachedMessage(key);
                if (hit) return hit;
            }
            return undefined;
        },
    };
}

/**
 * @param {import('baileys').WASocket} sock
 * @param {import('baileys').proto.IWebMessageInfo} waMessage
 * @returns {Promise<{ buffer: Buffer, fileName: string, mimetype: string }>}
 */
export async function downloadWaDocument(sock, waMessage) {
    let target = resolveDocumentTarget(waMessage);
    if (target) {
        target = hydrateDocumentTarget(sock, waMessage, target);
        if (!hasDocumentMediaFields(target.document)) {
            target = await maybeReupload(sock, target);
        }
    }

    if (!target) {
        const topKeys = waMessage?.message ? Object.keys(waMessage.message) : [];
        const ctxQuoted = (() => {
            try {
                const c = normalizeMessageContent(waMessage?.message);
                for (const value of Object.values(c || {})) {
                    if (value?.contextInfo?.quotedMessage) {
                        return Object.keys(value.contextInfo.quotedMessage);
                    }
                }
            } catch {
                /* ignore */
            }
            return null;
        })();
        logger.warn(
            `Roast: no document resolved — msgId=${waMessage?.key?.id || '?'} topKeys=${JSON.stringify(topKeys)} quotedKeys=${JSON.stringify(ctxQuoted)}`
        );
        throw new Error('No document found');
    }

    if (!hasDocumentMediaFields(target.document)) {
        logger.warn(
            `Roast: document stub has no media fields (source=${target.source}, file=${target.document?.fileName || '?'})`
        );
        throw new Error(
            'Document media unavailable — send the PDF again with /roast as the caption (don\'t reply to an old file)'
        );
    }

    const buffer = await withTimeout(
        downloadMediaMessage(target.waMessage, 'buffer', {}, downloadCtx(sock)),
        DOWNLOAD_TIMEOUT_MS
    ).catch((err) => {
        logger.warn(
            `Roast: document download failed (source=${target.source}, fileName=${target.document?.fileName || target.document?.title || '?'}): ${err?.message || err}`
        );
        throw err;
    });

    if (!Buffer.isBuffer(buffer) || !buffer.length) {
        throw new Error('Empty document download');
    }

    return {
        buffer,
        fileName: String(target.document.fileName || target.document.title || ''),
        mimetype: String(target.document.mimetype || ''),
    };
}

export function hasWaDocument(waMessage) {
    return Boolean(resolveDocumentTarget(waMessage));
}
