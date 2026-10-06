/**
 * WA incoming message helpers (aligned with Baileys unwrap rules).
 */

import { normalizeMessageContent, jidNormalizedUser, WAMessageStatus } from 'baileys';
import { extractPhoneNumber, isDirectMessage, normalizePhoneNumber } from './permissions.js';
import { resolveReplyChatJid } from './lid.js';
import { messageQueue } from './messageQueue.js';
import { logger } from './logger.js';

/** Strip linked-device suffix (:0) but keep user@domain intact. */
function normalizeWaJid(raw) {
    if (!raw) return '';
    const jid = String(raw).replace(/:\d+(?=@)/, '');
    return jidNormalizedUser(jid) || jid;
}

function isLidJid(jid) {
    return Boolean(jid && (jid.endsWith('@lid') || jid.endsWith('@hosted.lid')));
}

/** Baileys DM keys expose phone on senderPn (not remoteJidAlt). */
function normalizePhoneJid(raw) {
    if (!raw) return '';
    const s = String(raw).trim();
    if (s.includes('@')) return normalizeWaJid(s);
    const digits = s.replace(/\D/g, '');
    if (/^\d{10,15}$/.test(digits)) {
        return `${digits}@s.whatsapp.net`;
    }
    return '';
}

/** DM phone fallback — Baileys 7 puts sender phone on remoteJidAlt for @lid chats. */
function collectDmPhoneCandidates(key) {
    if (!key) return [];
    const out = [];
    const add = (raw) => {
        const jid = normalizePhoneJid(raw);
        if (jid && jid.endsWith('@s.whatsapp.net') && !out.includes(jid)) out.push(jid);
    };
    add(key.remoteJidAlt);
    add(key.senderPn);
    return out;
}

function withLinkPreviewDisabled(content) {
    if (!content || typeof content !== 'object') return content;
    if (typeof content.text === 'string') {
        return { ...content, linkPreview: false };
    }
    return content;
}

const SEND_TIMEOUT_MS = 20000;
const DELETE_TIMEOUT_MS = 5000;

/**
 * Outbound target — use msg.key.remoteJid directly (reference bot pattern).
 * Baileys 7 handles LID addressing and encryption internally.
 */
export function resolveOutboundJid(key, chatId) {
    const conversationJid = chatId || resolveConversationChatId(key);
    return resolveReplyChatJid(key, conversationJid);
}

function participantToPhone(participant) {
    if (!participant) {
        return '';
    }
    const fromPn = extractPhoneNumber(participant.phoneNumber || participant.pn || '');
    if (/^\d{10,15}$/.test(fromPn)) {
        return fromPn;
    }
    const fromId = extractPhoneNumber(participant.id || '');
    if (/^\d{10,15}$/.test(fromId)) {
        return fromId;
    }
    return fromId || fromPn;
}

/**
 * Text the user actually typed, after unwrapping ephemeral / view-once / edits / document-with-caption, etc.
 * @param {import('baileys').proto.Message | null | undefined} message
 * @returns {string}
 */
export function getTextFromWAMessage(message) {
    if (!message) {
        return '';
    }
    const c = normalizeMessageContent(message);
    if (!c) {
        return '';
    }
    if (typeof c.conversation === 'string' && c.conversation) {
        return c.conversation;
    }
    if (c.extendedTextMessage?.text) {
        return c.extendedTextMessage.text;
    }
    if (c.imageMessage?.caption) {
        return c.imageMessage.caption;
    }
    if (c.videoMessage?.caption) {
        return c.videoMessage.caption;
    }
    if (c.documentMessage?.caption) {
        return c.documentMessage.caption;
    }
    return '';
}

/**
 * Broader text extraction for URL detection. Link previews often put the URL in
 * `matchedText` (not `text`), and descriptions/titles can hold link metadata.
 * @param {import('baileys').proto.Message | null | undefined} message
 * @returns {string}
 */
export function getTextForUrlScan(message) {
    if (!message) {
        return '';
    }
    const c = normalizeMessageContent(message);
    if (!c) {
        return '';
    }
    const parts = [];
    if (typeof c.conversation === 'string' && c.conversation) {
        parts.push(c.conversation);
    }
    const et = c.extendedTextMessage;
    if (et?.text) {
        parts.push(et.text);
    }
    if (et?.matchedText) {
        parts.push(et.matchedText);
    }
    if (et?.description) {
        parts.push(et.description);
    }
    if (et?.title) {
        parts.push(et.title);
    }
    if (c.imageMessage?.caption) {
        parts.push(c.imageMessage.caption);
    }
    if (c.videoMessage?.caption) {
        parts.push(c.videoMessage.caption);
    }
    if (c.documentMessage?.caption) {
        parts.push(c.documentMessage.caption);
    }
    return parts.join('\n');
}

/**
 * Author JID for permission checks. Groups may only set participantLid (LID mode), not participant.
 * @param {import('baileys').WAMessage['key']} key
 * @returns {string}
 */
export function getMessageSenderJid(key) {
    if (!key?.remoteJid) {
        return '';
    }
    if (key.remoteJid.endsWith('@g.us')) {
        return key.participant || key.participantLid || key.participantPn || '';
    }
    const phone = normalizePhoneJid(key.remoteJidAlt) || normalizePhoneJid(key.senderPn);
    if (phone) return phone;
    return normalizeWaJid(key.remoteJid);
}

/**
 * All sender JIDs from an incoming group message key (LID / phone / legacy participant).
 * Order matches WhatsApp privacy fields — LID and PN are often more reliable than participant alone.
 * @param {import('baileys').WAMessage['key']} key
 * @returns {string[]}
 */
export function collectMessageSenderDmCandidates(key) {
    if (!key) {
        return [];
    }

    const seen = new Set();
    const out = [];
    for (const raw of [key.participantPn, key.participantLid, key.participant]) {
        if (!raw) continue;
        const normalized = normalizeWaJid(raw);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        out.push(normalized);
    }
    return out;
}

export function getContextInfo(message) {
    if (!message) {
        return null;
    }
    const c = normalizeMessageContent(message);
    if (!c) {
        return null;
    }

    for (const value of Object.values(c)) {
        if (value && typeof value === 'object' && value.contextInfo) {
            const ci = value.contextInfo;
            if (ci.quotedMessage || (Array.isArray(ci.mentionedJid) && ci.mentionedJid.length)) {
                return ci;
            }
        }
    }

    return (
        c.extendedTextMessage?.contextInfo ||
        c.imageMessage?.contextInfo ||
        c.videoMessage?.contextInfo ||
        c.documentMessage?.contextInfo ||
        c.stickerMessage?.contextInfo ||
        null
    );
}

/**
 * Build a Baileys message object for downloading quoted media (stickers, images, etc.)
 * @param {import('baileys').proto.IWebMessageInfo | null | undefined} waMessage
 * @returns {import('baileys').proto.IWebMessageInfo | null}
 */
export function buildQuotedTargetMessage(waMessage) {
    if (!waMessage?.message) {
        return null;
    }
    const ctx = getContextInfo(waMessage.message);
    const quotedMsg = ctx?.quotedMessage;
    if (!quotedMsg) {
        return null;
    }

    const result = {
        ...waMessage,
        message: quotedMsg,
    };

    if (ctx?.stanzaId) {
        result.key = {
            ...waMessage.key,
            id: ctx.stanzaId,
            remoteJid: ctx.remoteJid || waMessage.key?.remoteJid,
            ...(ctx.participant ? { participant: ctx.participant } : {}),
            ...(ctx.participantLid ? { participantLid: ctx.participantLid } : {}),
            ...(ctx.participantPn ? { participantPn: ctx.participantPn } : {}),
        };
    }

    return result;
}

/**
 * @param {import('baileys').proto.IWebMessageInfo | null | undefined} waMessage
 * @returns {string}
 */
export function getQuotedParticipantJid(waMessage) {
    const ctx = getContextInfo(waMessage?.message);
    return ctx?.participantPn || ctx?.participantLid || ctx?.participant || '';
}

/**
 * Get pushName from quoted message
 * @param {import('baileys').proto.IWebMessageInfo | null | undefined} waMessage
 * @returns {string}
 */
export function getQuotedPushName(waMessage) {
    const ctx = getContextInfo(waMessage?.message);
    // Try different possible locations for the quoted sender's name
    return ctx?.pushName || 
           ctx?.quotedMessage?.pushName || 
           ctx?.pushname || 
           ctx?.quotedMessage?.pushname ||
           '';
}

/**
 * Text from a quoted/replied message (preserves newlines).
 * @param {import('baileys').proto.IWebMessageInfo | null | undefined} waMessage
 * @returns {string}
 */
export function getQuotedMessageText(waMessage) {
    const quoted = buildQuotedTargetMessage(waMessage);
    if (!quoted?.message) {
        return '';
    }
    return getTextFromWAMessage(quoted.message);
}

/**
 * Extract command body after the command name and optional first arg, preserving newlines.
 * @param {string} fullCommand raw message text e.g. "/grouppost all\\nLine1\\nLine2"
 * @param {string|string[]} commandNames without leading slash
 * @param {{ skipAllToken?: boolean, skipFirstToken?: boolean }} opts
 * @returns {string}
 */
export function extractCommandPayload(fullCommand, commandNames, opts = {}) {
    let rest = String(fullCommand || '').trim();
    const names = (Array.isArray(commandNames) ? commandNames : [commandNames])
        .map((n) => String(n).replace(/^\//, ''));

    const cmdPattern = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const cmdRe = new RegExp(`^(?:\\/(?:${cmdPattern}))(?:\\s+|$)`, 'i');
    if (!cmdRe.test(rest)) {
        return '';
    }
    rest = rest.replace(cmdRe, '');

    if (opts.skipAllToken) {
        rest = rest.replace(/^all(?:\s+|$)/i, '');
    } else if (opts.skipFirstToken) {
        rest = rest.replace(/^\S+(?:\s+|$)/, '');
    }

    return rest.replace(/^\s+/, '');
}

/**
 * Message body for /broadcast and /grouppost — inline text (multiline) or replied message.
 * @param {string} fullCommand
 * @param {string|string[]} commandNames
 * @param {{ type: 'all' | 'index' }} mode
 * @param {import('baileys').proto.IWebMessageInfo | null | undefined} originalMsg
 * @returns {string}
 */
export function resolvePostMessage(fullCommand, commandNames, mode, originalMsg) {
    const extractOpts = mode.type === 'all'
        ? { skipAllToken: true }
        : { skipFirstToken: true };

    const inline = extractCommandPayload(fullCommand, commandNames, extractOpts);
    if (inline.trim()) {
        return inline;
    }

    const quoted = getQuotedMessageText(originalMsg);
    if (quoted.trim()) {
        return quoted;
    }

    return inline;
}

/**
 * @param {import('baileys').proto.IWebMessageInfo | null | undefined} waMessage
 * @returns {string[]}
 */
export function getMentionedJids(waMessage) {
    const ctx = getContextInfo(waMessage?.message);
    return Array.isArray(ctx?.mentionedJid) ? ctx.mentionedJid : [];
}

function looksLikePhone(value) {
    return /^\d{10,15}$/.test(value);
}

/**
 * Resolve a participant JID to a phone number using group metadata when needed.
 * @param {import('baileys').WASocket} sock
 * @param {string} chatId
 * @param {string} jid
 * @returns {Promise<string>}
 */
/** Optional fast metadata provider (GroupManager cache) — avoids full WA fetch in big groups. */
let _groupMetaProvider = null;
/** Optional O(1) phone resolver from cached participant index. */
let _groupPhoneResolver = null;

export function setGroupMetaProvider(provider) {
    _groupMetaProvider = typeof provider === 'function' ? provider : null;
}

export function setGroupPhoneResolver(resolver) {
    _groupPhoneResolver = typeof resolver === 'function' ? resolver : null;
}

export async function resolveJidToPhone(sock, chatId, jid) {
    if (!jid) {
        return '';
    }
    const direct = extractPhoneNumber(jid);
    if (looksLikePhone(direct)) {
        return direct;
    }
    if (!chatId?.endsWith('@g.us') || !sock) {
        return direct;
    }
    try {
        if (_groupPhoneResolver) {
            const phone = await _groupPhoneResolver(sock, chatId, jid);
            if (looksLikePhone(String(phone || '').replace(/\D/g, ''))) {
                return String(phone).replace(/\D/g, '');
            }
        }
        const meta = _groupMetaProvider
            ? await _groupMetaProvider(sock, chatId)
            : await sock.groupMetadata(chatId);
        const hit = (meta?.participants || []).find(
            (p) =>
                p.id === jid ||
                p.lid === jid ||
                p.phoneNumber === jid ||
                p.pn === jid ||
                p.id?.includes(direct),
        );
        if (!hit) {
            return direct;
        }
        const fromPn = extractPhoneNumber(hit.phoneNumber || hit.pn || '');
        if (looksLikePhone(fromPn)) {
            return fromPn;
        }
        const fromId = extractPhoneNumber(hit.id);
        return looksLikePhone(fromId) ? fromId : fromId || fromPn;
    } catch {
        return direct;
    }
}

/**
 * Target user for /addadmin /removeadmin: args, @mention, or reply.
 * @param {import('baileys').WASocket} sock
 * @param {string} chatId
 * @param {string[]} args
 * @param {import('baileys').proto.IWebMessageInfo | null} waMessage
 * @param {string} senderJid
 * @returns {Promise<string>}
 */
export async function resolveTargetPhone(sock, chatId, args, waMessage, senderJid) {
    const fromArgs = args.join('').replace(/\D/g, '');
    if (fromArgs.length >= 10) {
        return fromArgs;
    }

    if (waMessage) {
        const quoted = getQuotedParticipantJid(waMessage);
        if (quoted && quoted !== senderJid) {
            const phone = await resolveJidToPhone(sock, chatId, quoted);
            if (phone) {
                return phone.replace(/\D/g, '');
            }
        }

        for (const jid of getMentionedJids(waMessage)) {
            if (!jid || jid === senderJid) {
                continue;
            }
            const phone = await resolveJidToPhone(sock, chatId, jid);
            if (phone && looksLikePhone(phone.replace(/\D/g, ''))) {
                return phone.replace(/\D/g, '');
            }
        }
    }

    return '';
}

/**
 * Target member for moderation commands: reply, @mention, or phone in args.
 * @param {import('baileys').WASocket} sock
 * @param {string} chatId
 * @param {string[]} args
 * @param {import('baileys').proto.IWebMessageInfo | null} waMessage
 * @param {string} senderJid
 * @returns {Promise<{ jid: string, phone: string } | null>}
 */
export async function resolveTargetParticipant(sock, chatId, args, waMessage, senderJid) {
    if (waMessage) {
        const quoted = getQuotedParticipantJid(waMessage);
        if (quoted && quoted !== senderJid) {
            const phone = (await resolveJidToPhone(sock, chatId, quoted)).replace(/\D/g, '');
            return { jid: quoted, phone };
        }

        for (const jid of getMentionedJids(waMessage)) {
            if (!jid || jid === senderJid) {
                continue;
            }
            const phone = (await resolveJidToPhone(sock, chatId, jid)).replace(/\D/g, '');
            return { jid, phone };
        }
    }

    const fromArgs = args.join('').replace(/\D/g, '');
    if (fromArgs.length >= 10 && chatId?.endsWith('@g.us') && sock) {
        try {
            const meta = _groupMetaProvider
                ? await _groupMetaProvider(sock, chatId)
                : await sock.groupMetadata(chatId);
            for (const p of meta?.participants || []) {
                const pPhone = participantToPhone(p);
                const normalized = normalizePhoneNumber(pPhone);
                if (
                    normalized === normalizePhoneNumber(fromArgs) ||
                    p.id.includes(fromArgs) ||
                    (p.lid && p.lid.includes(fromArgs))
                ) {
                    return { jid: p.id, phone: normalized || fromArgs };
                }
            }
        } catch {
            // fall through
        }
        return { jid: `${fromArgs}@s.whatsapp.net`, phone: fromArgs };
    }

    return null;
}

/**
 * Whether the message targets someone other than the sender (reply / @tag / phone).
 * @param {import('baileys').proto.IWebMessageInfo | null} waMessage
 * @param {string} senderJid
 * @param {string[]} [args]
 * @returns {boolean}
 */
export function hasModerationTarget(waMessage, senderJid, args = []) {
    if (args.join('').replace(/\D/g, '').length >= 10) {
        return true;
    }
    if (!waMessage) {
        return false;
    }
    const quoted = getQuotedParticipantJid(waMessage);
    if (quoted && quoted !== senderJid) {
        return true;
    }
    return getMentionedJids(waMessage).some((jid) => jid && jid !== senderJid);
}

/**
 * Normalize the conversation JID from an incoming message key.
 * @param {import('baileys').WAMessage['key']} key
 * @returns {string}
 */
export function resolveConversationChatId(key) {
    if (!key?.remoteJid) {
        return '';
    }
    return normalizeWaJid(key.remoteJid);
}

/**
 * DM send targets — @lid first (reference bot pattern), then phone fallback.
 * Sends to both so we can diagnose which route actually delivers.
 */
export function collectDirectMessageSendTargets(key, chatId) {
    const seen = new Set();
    const out = [];
    const add = (raw) => {
        if (!raw) return;
        const jid = normalizePhoneJid(raw) || normalizeWaJid(raw);
        if (!jid || seen.has(jid)) return;
        seen.add(jid);
        out.push(jid);
    };

    if (key?.remoteJid) add(key.remoteJid);
    add(chatId);
    if (key?.remoteJidAlt) add(key.remoteJidAlt);

    return out;
}

function shouldQuoteReply(waMessage, content) {
    if (!waMessage?.key?.id || !waMessage?.message) return false;
    const text = typeof content?.text === 'string' ? content.text : '';
    // Keep the quote under WhatsApp's practical message limit. (A former
    // "no quoting when >2 URLs" rule was dropped: link previews are forced
    // off on these sends, so URLs are harmless, and callers that need it can
    // forceQuote past the policy anyway.)
    if (text.length > 3500) return false;
    return true;
}

async function simulateDmTyping(sock, jid) {
    if (!sock || jid.endsWith('@g.us')) return;
    try {
        await sock.presenceSubscribe(jid);
        await new Promise((r) => setTimeout(r, 300));
        await sock.sendPresenceUpdate('composing', jid);
        await new Promise((r) => setTimeout(r, 500));
    } catch {
        // non-fatal
    }
}

async function pauseDmTyping(sock, jid) {
    if (!sock || jid.endsWith('@g.us')) return;
    try {
        await sock.sendPresenceUpdate('paused', jid);
    } catch {
        // non-fatal
    }
}

/**
 * Build sendMessage options — quote user message when safe (reference bot pattern + getMessage cache).
 * @param {import('baileys').proto.IWebMessageInfo | null | undefined} waMessage
 * @param {object} [extra]
 * @param {object} [content]
 * @param {{ forceQuote?: boolean }} [opts] forceQuote=true tags even long/multi-URL replies
 * @returns {object}
 */
export function getSafeSendOptions(waMessage, extra = {}, content = null, opts = {}) {
    const sendOpts = { linkPreview: false, ...extra };
    if (waMessage && (opts.forceQuote || shouldQuoteReply(waMessage, content || {}))) {
        sendOpts.quoted = waMessage;
    }
    return sendOpts;
}

async function sendWithTimeout(sock, jid, content, opts, timeoutMs = SEND_TIMEOUT_MS) {
    const payload = withLinkPreviewDisabled(content);
    const sendOpts = { linkPreview: false, ...opts };
    return Promise.race([
        sock.sendMessage(jid, payload, sendOpts),
        new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`send timeout (${jid})`)), timeoutMs);
        }),
    ]);
}

/**
 * Send a message with DM fallbacks, per-chat queue, and optional quote reply.
 * Pass `queuePriority` in extraOpts (lower = sooner). Default: DM 0, group 1.
 */
export async function safeSendMessage(sock, chatId, content, waMessage = null, extraOpts = {}) {
    if (!sock?.sendMessage) {
        throw new Error('WhatsApp socket not ready');
    }

    const { queuePriority, forceQuote, sendTimeoutMs, ...sendExtra } = extraOpts || {};
    const key = waMessage?.key;
    const conversationJid = chatId || resolveConversationChatId(key);
    const primaryJid = resolveOutboundJid(key, conversationJid);
    if (!primaryJid) {
        throw new Error('No chat id for reply');
    }

    const isDm = isDirectMessage(conversationJid) || isDirectMessage(primaryJid);
    const priority = Number.isFinite(queuePriority)
        ? queuePriority
        : (isDm ? 0 : 1);

    const doSend = async () => {
        if (isDm) {
            const dmJid = key?.remoteJid || conversationJid;
            const sendOpts = waMessage ? { quoted: waMessage } : {};
            logger.info(`DM reply → ${dmJid} (conversation=${conversationJid})`);
            const sent = await sock.sendMessage(dmJid, content, sendOpts);
            if (sent) {
                logger.info(`Reply sent to ${dmJid}${sent.key?.id ? ` (id=${sent.key.id})` : ''}`);
                return sent;
            }
            throw new Error(`Send returned empty for ${dmJid}`);
        }

        const primaryOpts = getSafeSendOptions(waMessage, sendExtra, content, { forceQuote });
        const bareOpts = { linkPreview: false };
        let lastErr;
        for (const opts of [primaryOpts, bareOpts]) {
            try {
                const sent = await sendWithTimeout(sock, primaryJid, content, opts, sendTimeoutMs);
                if (!sent) {
                    throw new Error('sendMessage returned empty result');
                }
                logger.info(`Reply sent to ${primaryJid}${sent.key?.id ? ` (id=${sent.key.id})` : ''}`);
                return sent;
            } catch (err) {
                lastErr = err;
                logger.warn(`Send failed for ${primaryJid}: ${err?.message || err}`);
            }
        }
        throw lastErr || new Error(`Send failed for ${primaryJid}`);
    };

    return messageQueue.enqueue(conversationJid || primaryJid, doSend, priority);
}

/** Best-effort message delete — never blocks the caller for long. */
export async function safeDeleteMessage(sock, chatId, messageKey) {
    if (!sock?.sendMessage || !chatId || !messageKey) return;
    const jid = resolveOutboundJid(messageKey, chatId);
    try {
        await Promise.race([
            sock.sendMessage(jid, { delete: messageKey }),
            new Promise((_, reject) => {
                setTimeout(() => reject(new Error('delete timeout')), DELETE_TIMEOUT_MS);
            }),
        ]);
    } catch {
        // Message may already be gone or chat unavailable
    }
}

/**
 * Edit a bot message in place (e.g. loading → result).
 * @param {import('baileys').WASocket} sock
 * @param {string} chatId
 * @param {import('baileys').proto.IMessageKey} messageKey
 * @param {string} text
 * @param {{ fallback?: boolean }} [opts] fallback=true sends a new message if edit fails
 */
export async function editMessageText(sock, chatId, messageKey, text, { fallback = true } = {}) {
    if (!sock?.sendMessage || !messageKey?.id) {
        return fallback ? plainSendMessage(sock, chatId, { text }) : null;
    }
    const jid = resolveOutboundJid(messageKey, chatId);
    try {
        const sent = await Promise.race([
            sock.sendMessage(jid, { text, edit: messageKey, linkPreview: false }),
            new Promise((_, reject) => {
                setTimeout(() => reject(new Error('edit timeout')), SEND_TIMEOUT_MS);
            }),
        ]);
        if (sent) return sent;
        throw new Error('edit returned empty');
    } catch (err) {
        if (!fallback) {
            logger.warn(`Message edit failed for ${jid} (no fallback): ${err?.message || err}`);
            return null;
        }
        logger.warn(`Message edit failed for ${jid}, sending new: ${err?.message || err}`);
        return plainSendMessage(sock, chatId, { text }, messageKey);
    }
}

/**
 * Last-resort plain send — no quotes, no fallbacks. Used for error notices.
 * @param {import('baileys').WASocket} sock
 * @param {string} chatId
 * @param {object} content
 */
export async function plainSendMessage(sock, chatId, content, key = null) {
    if (!sock?.sendMessage || !chatId) return null;
    const jid = resolveOutboundJid(key, chatId);
    try {
        return await sendWithTimeout(sock, jid, content, { linkPreview: false });
    } catch (err) {
        logger.warn(`plainSendMessage failed for ${jid}: ${err?.message || err}`);
        return null;
    }
}

/**
 * Watch async delivery verdicts for sent messages. sendMessage resolves on
 * socket write; failures (e.g. 463 privacy-token drops) arrive later as
 * messages.update with status ERROR keyed by the sent message id.
 * Attach ONE verifier per run, reuse it across sends, detach when done.
 */
export function createDeliveryVerifier(sock) {
    const statusByMsgId = new Map();
    const onMsgUpdate = (updates) => {
        for (const u of updates) {
            if (!u.key?.fromMe || !u.key?.id) continue;
            statusByMsgId.set(u.key.id, u.update?.status);
            if (statusByMsgId.size > 1000) {
                const oldest = statusByMsgId.keys().next().value;
                if (oldest !== undefined) statusByMsgId.delete(oldest);
            }
        }
    };
    if (sock?.ev?.on) sock.ev.on('messages.update', onMsgUpdate);

    return {
        /** 'ERROR' if the server rejects the sent message id within timeoutMs, else 'OK'. */
        wait: (msgId, timeoutMs) =>
            new Promise((resolve) => {
                const isError = (s) => s === WAMessageStatus.ERROR;
                const isGood = (s) => (
                    s === WAMessageStatus.SERVER_ACK ||
                    s === WAMessageStatus.DELIVERY_ACK ||
                    s === WAMessageStatus.READ
                );
                const started = Date.now();
                const tick = () => {
                    const cur = statusByMsgId.get(msgId);
                    if (isError(cur)) return resolve('ERROR');
                    if (isGood(cur)) return resolve('OK');
                    if (Date.now() - started >= timeoutMs) return resolve('OK'); // no news — assume delivered
                    setTimeout(tick, 150);
                };
                tick();
            }),
        detach: () => {
            if (sock?.ev?.off) sock.ev.off('messages.update', onMsgUpdate);
        },
    };
}

/**
 * One message through the shared outbound pipeline: per-chat serialization,
 * send timeout, quoting policy, and OPTIONAL async delivery verification.
 * This is the single path every queued send should flow through.
 *
 * @param {import('baileys').WASocket} sock
 * @param {string} chatId
 * @param {object} content sendMessage content ({ text, image, ... })
 * @param {object} [opts]
 * @param {import('baileys').proto.IWebMessageInfo | import('baileys').proto.IMessageKey} [opts.waMessage] quote the original message
 * @param {number} [opts.priority=0] messageQueue priority (lower = sooner)
 * @param {boolean} [opts.forceQuote] quote even long/multi-URL replies
 * @param {{ wait: Function }} [opts.verifier] from createDeliveryVerifier — verify the async outcome
 * @param {number} [opts.verifyWaitMs=4000] how long to await the server verdict
 * @param {boolean} [opts.typing=false] send a brief composing indicator before a DM (human-like)
 * @returns {Promise<{ sent: object|null, outcome?: 'OK'|'ERROR' }>} rejects if the send fails entirely
 */
export async function deliverMessage(sock, chatId, content, opts = {}) {
    const { waMessage = null, priority = 0, forceQuote = false, verifier = null, verifyWaitMs = 4000, typing = false } = opts;
    if (!sock?.sendMessage || !chatId) return { sent: null };

    // Accept either a full WA message (preferred) or just a key (JID resolution only)
    const key = waMessage?.key || waMessage;
    const conversationJid = chatId || resolveConversationChatId(key);
    const jid = resolveOutboundJid(key, conversationJid);
    if (!jid) return { sent: null };

    const primaryOpts = getSafeSendOptions(waMessage?.key ? waMessage : null, { linkPreview: false }, content, { forceQuote });
    const bareOpts = { linkPreview: false };
    // Only retry unquoted when the first attempt carried a quote — otherwise the
    // retry is an identical duplicate send (a wasted attempt on failure).
    const attempts = primaryOpts.quoted ? [primaryOpts, bareOpts] : [primaryOpts];

    const doSend = async () => {
        let lastErr;
        const isDm = jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');
        if (typing && isDm) await simulateDmTyping(sock, jid);
        for (const sendOpts of attempts) {
            try {
                const sent = await sendWithTimeout(sock, jid, content, sendOpts);
                if (typing && isDm) await pauseDmTyping(sock, jid);
                if (verifier && sent?.key?.id) {
                    const outcome = await verifier.wait(sent.key.id, verifyWaitMs);
                    return { sent, outcome };
                }
                return { sent };
            } catch (err) {
                lastErr = err;
                logger.warn(`deliverMessage failed for ${jid}: ${err?.message || err}`);
            }
        }
        throw lastErr || new Error(`deliverMessage failed for ${jid}`);
    };

    return messageQueue.enqueue(conversationJid || jid, doSend, priority);
}

/**
 * Queued group/DM send. Pass a full WA message to tag the reply to it (quote);
 * pass only a key (or nothing) to send without a quote. Falls back to an
 * unquoted send if quoting fails (e.g. the original message was deleted).
 * @param {import('baileys').proto.IWebMessageInfo | import('baileys').proto.IMessageKey | null} [waMessage]
 * @param {number} [priority=0] lower = sooner (0 = jump ahead of normal group cmds)
 * @param {{ forceQuote?: boolean }} [opts] forceQuote=true tags even long/multi-URL replies
 */
export async function fastSendMessage(sock, chatId, content, waMessage = null, priority = 0, opts = {}) {
    try {
        const { sent } = await deliverMessage(sock, chatId, content, { waMessage, priority, ...opts });
        return sent ?? null;
    } catch (err) {
        logger.warn(`fastSendMessage failed for ${chatId}: ${err?.message || err}`);
        return null;
    }
}
