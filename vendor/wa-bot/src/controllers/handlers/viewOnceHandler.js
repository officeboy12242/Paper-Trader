/**
 * View-once message revealer — reply to a view-once image/video/audio
 * with /vv to re-send it as a normal message.
 */

import { downloadContentFromMessage } from 'baileys';
import { logger } from '../../utils/logger.js';
import { buildQuotedTargetMessage, safeSendMessage } from '../../utils/waMessage.js';

async function streamToBuffer(stream) {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

/**
 * Walk ephemeral / view-once wrappers and detect media with viewOnce flag.
 * Modern WA often quotes view-once as plain imageMessage { viewOnce: true }.
 * @param {object|null|undefined} quoted
 * @returns {{ ok: true, kind: 'image'|'video'|'audio', media: object, caption: string } | { ok: false, reason: string }}
 */
export function extractViewOnceMedia(quoted) {
    if (!quoted || typeof quoted !== 'object') {
        return { ok: false, reason: 'missing' };
    }

    let cur = quoted;
    let sawWrapper = false;

    for (let i = 0; i < 8 && cur; i++) {
        if (cur.ephemeralMessage?.message) {
            cur = cur.ephemeralMessage.message;
            continue;
        }
        if (cur.viewOnceMessage?.message) {
            sawWrapper = true;
            cur = cur.viewOnceMessage.message;
            continue;
        }
        if (cur.viewOnceMessageV2?.message) {
            sawWrapper = true;
            cur = cur.viewOnceMessageV2.message;
            continue;
        }
        if (cur.viewOnceMessageV2Extension?.message) {
            sawWrapper = true;
            cur = cur.viewOnceMessageV2Extension.message;
            continue;
        }
        if (cur.documentWithCaptionMessage?.message) {
            cur = cur.documentWithCaptionMessage.message;
            continue;
        }
        break;
    }

    if (!cur || typeof cur !== 'object') {
        return { ok: false, reason: 'empty' };
    }

    const image = cur.imageMessage;
    const video = cur.videoMessage;
    const audio = cur.audioMessage;
    const flagOf = (m) => m && (m.viewOnce === true || m.viewOnce === 1 || m.viewOnce === '1');
    const flagged = flagOf(image) || flagOf(video) || flagOf(audio);
    const downloadable = (m) =>
        Boolean(m && (m.mediaKey || m.directPath || m.url || m.mediaKeyTimestamp));

    if (!sawWrapper && !flagged) {
        // DM quotes often strip the viewOnce flag but still leave downloadable media.
        // /vv is explicitly a reveal command — accept downloadable image/video/audio.
        if (downloadable(image) || downloadable(video) || downloadable(audio)) {
            sawWrapper = true;
        } else if (!image && !video && !audio) {
            return { ok: false, reason: 'opened_or_missing' };
        } else {
            return { ok: false, reason: 'not_view_once' };
        }
    }

    if (image) {
        return {
            ok: true,
            kind: 'image',
            media: image,
            caption: String(image.caption || ''),
        };
    }
    if (video) {
        return {
            ok: true,
            kind: 'video',
            media: video,
            caption: String(video.caption || ''),
        };
    }
    if (audio) {
        return {
            ok: true,
            kind: 'audio',
            media: audio,
            caption: '',
        };
    }

    return { ok: false, reason: 'unsupported' };
}

function resolveQuotedMessage(originalMsg) {
    const viaHelper = buildQuotedTargetMessage(originalMsg)?.message;
    if (viaHelper) return viaHelper;

    const msg = originalMsg?.message;
    return (
        msg?.extendedTextMessage?.contextInfo?.quotedMessage ||
        msg?.imageMessage?.contextInfo?.quotedMessage ||
        msg?.videoMessage?.contextInfo?.quotedMessage ||
        msg?.documentMessage?.contextInfo?.quotedMessage ||
        msg?.buttonsResponseMessage?.contextInfo?.quotedMessage ||
        msg?.templateButtonReplyMessage?.contextInfo?.quotedMessage ||
        msg?.listResponseMessage?.contextInfo?.quotedMessage ||
        null
    );
}

export async function handleViewOnce(sock, chatId, senderJid, originalMsg) {
    const quoted = resolveQuotedMessage(originalMsg);

    if (!quoted) {
        await safeSendMessage(
            sock,
            chatId,
            {
                text:
                    '📸 *View Once Revealer* 🔓\n\n' +
                    '❌ Reply to a view-once photo/video/voice with `/vv`.\n' +
                    '_Works in groups and DMs (including chats with the bot number)._',
            },
            originalMsg
        );
        return;
    }

    const extracted = extractViewOnceMedia(quoted);
    if (!extracted.ok) {
        const text =
            extracted.reason === 'opened_or_missing'
                ? '❌ View-once media is gone (already opened or expired). Reply before opening it.'
                : extracted.reason === 'unsupported'
                  ? '❌ Unsupported view-once media type.'
                  : '❌ That is not a view-once message.\n_Reply to the view-once media itself (before opening it)._';
        await safeSendMessage(sock, chatId, { text }, originalMsg);
        return;
    }

    await safeSendMessage(sock, chatId, { text: '⏳ Processing view-once media…' }, originalMsg);

    try {
        let mediaMsg;
        if (extracted.kind === 'image') {
            const buf = await streamToBuffer(
                await downloadContentFromMessage(extracted.media, 'image')
            );
            mediaMsg = {
                image: buf,
                caption: extracted.caption || '📸 *View-once image revealed* 🔓',
            };
        } else if (extracted.kind === 'video') {
            const buf = await streamToBuffer(
                await downloadContentFromMessage(extracted.media, 'video')
            );
            mediaMsg = {
                video: buf,
                caption: extracted.caption || '🎥 *View-once video revealed* 🔓',
            };
        } else {
            const buf = await streamToBuffer(
                await downloadContentFromMessage(extracted.media, 'audio')
            );
            mediaMsg = {
                audio: buf,
                ptt: extracted.media.ptt === true,
                mimetype: extracted.media.mimetype || 'audio/ogg; codecs=opus',
            };
        }

        await safeSendMessage(sock, chatId, mediaMsg, originalMsg);
    } catch (err) {
        logger.error(`ViewOnce download failed: ${err.message}`);
        await safeSendMessage(
            sock,
            chatId,
            { text: `❌ Failed to reveal view-once: ${err.message}` },
            originalMsg
        );
    }
}
