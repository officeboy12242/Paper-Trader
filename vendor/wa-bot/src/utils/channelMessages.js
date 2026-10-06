/**
 * Fetch and parse sticker messages from WhatsApp newsletter channels.
 */

import {
    decryptMessageNode,
    getAllBinaryNodeChildren,
    getBinaryNodeChild,
    proto,
} from 'baileys';
import pino from 'pino';
import { logger } from './logger.js';
import { extractStickerFromMessage } from './stickerExtract.js';

const baileysLogger = pino({ level: 'silent' });

function bufferFromNodeContent(content) {
    if (!content) {
        return null;
    }
    if (Buffer.isBuffer(content)) {
        return content;
    }
    if (content instanceof Uint8Array) {
        return Buffer.from(content);
    }
    if (typeof content === 'string') {
        return Buffer.from(content, 'binary');
    }
    return null;
}

/**
 * @param {import('baileys').WASocket} sock
 * @param {object} node
 * @param {string} channelJid
 * @returns {Promise<import('baileys').proto.IWebMessageInfo | null>}
 */
async function parseNewsletterMessageNode(sock, node, channelJid) {
    const plaintextNode = getBinaryNodeChild(node, 'plaintext');
    const plaintextBuf = bufferFromNodeContent(plaintextNode?.content);
    if (plaintextBuf) {
        try {
            const messageProto = proto.Message.decode(plaintextBuf);
            return proto.WebMessageInfo.fromObject({
                key: {
                    remoteJid: channelJid,
                    id: node.attrs?.id || node.attrs?.message_id || node.attrs?.server_id,
                    fromMe: false,
                },
                message: messageProto,
                messageTimestamp: Number(node.attrs?.t || Math.floor(Date.now() / 1000)),
            });
        } catch (error) {
            logger.warn(`Plaintext channel message decode failed: ${error.message}`);
        }
    }

    if (node.tag !== 'message' || !sock?.authState?.creds?.me?.id) {
        return null;
    }

    try {
        const { fullMessage, decrypt } = decryptMessageNode(
            node,
            sock.authState.creds.me.id,
            sock.authState.creds.me.lid || '',
            sock.signalRepository,
            baileysLogger
        );
        await decrypt();
        if (fullMessage?.message) {
            fullMessage.key.remoteJid = channelJid;
            return fullMessage;
        }
    } catch (error) {
        logger.warn(`Encrypted channel message decode failed: ${error.message}`);
    }

    return null;
}

/**
 * @param {import('baileys').WASocket} sock
 * @param {string} channelJid
 * @param {number} count
 * @returns {Promise<import('baileys').proto.IWebMessageInfo[]>}
 */
export async function fetchNewsletterMessages(sock, channelJid, count = 20) {
    if (!sock?.newsletterFetchMessages) {
        return [];
    }

    try {
        const result = await sock.newsletterFetchMessages(channelJid, count);
        if (!result || typeof result !== 'object') {
            return [];
        }

        const roots = [];

        const updatesNode =
            getBinaryNodeChild(result, 'message_updates') ||
            getBinaryNodeChild(result, 'messages');
        if (updatesNode) {
            roots.push(...getAllBinaryNodeChildren(updatesNode));
        }
        roots.push(...getAllBinaryNodeChildren(result));

        const seenIds = new Set();
        const parsed = [];

        for (const node of roots) {
            if (node.tag !== 'message' && !getBinaryNodeChild(node, 'plaintext')) {
                continue;
            }

            const waMessage = await parseNewsletterMessageNode(sock, node, channelJid);
            if (!waMessage?.key?.id || seenIds.has(waMessage.key.id)) {
                continue;
            }
            seenIds.add(waMessage.key.id);
            parsed.push(waMessage);
        }

        return parsed;
    } catch (error) {
        logger.debug(`fetchNewsletterMessages skipped for ${channelJid}: ${error.message}`);
        return [];
    }
}

/**
 * Latest sticker messages from a channel (newest first).
 * @param {import('baileys').WASocket} sock
 * @param {string} channelJid
 * @param {number} count
 * @returns {Promise<import('baileys').proto.IWebMessageInfo[]>}
 */
export async function fetchNewsletterStickerMessages(sock, channelJid, count = 20) {
    const messages = await fetchNewsletterMessages(sock, channelJid, count);
    return messages.filter((msg) => extractStickerFromMessage(msg.message));
}
