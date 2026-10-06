/**
 * Permission Utilities
 * Helper functions for permission checks
 */

import { jidNormalizedUser } from 'baileys';

/**
 * Extract phone number from WhatsApp JID
 * @param {string} jid - WhatsApp JID (e.g., "919876543210@s.whatsapp.net")
 * @returns {string} - Phone number
 */
export function extractPhoneNumber(jid) {
    if (!jid) return '';
    // Extract number before @ symbol, also handle :0 suffix in newer WhatsApp
    const beforeAt = jid.split('@')[0];
    // Remove :0 or :XX device suffix if present
    return beforeAt.split(':')[0];
}

/**
 * Digits-only phone for DB lookups and comparisons.
 * @param {string} value
 * @returns {string}
 */
export function normalizePhoneNumber(value) {
    if (!value) {
        return '';
    }
    return String(value).replace(/\D/g, '');
}

/**
 * Check if message is from a group
 * @param {string} jid - WhatsApp JID
 * @returns {boolean}
 */
export function isGroupMessage(jid) {
    return jid && jid.endsWith('@g.us');
}

/**
 * Direct (1:1) chat — includes phone JIDs and WhatsApp LID privacy chats.
 * @param {string} jid
 * @returns {boolean}
 */
export function isDirectMessage(jid) {
    if (!jid || isGroupMessage(jid)) {
        return false;
    }
    if (jid === 'status@broadcast' || jid.endsWith('@broadcast')) {
        return false;
    }
    if (jid.includes('newsletter')) {
        return false;
    }
    return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid') || jid.endsWith('@hosted.lid');
}

/**
 * Extract group ID from JID
 * @param {string} jid - WhatsApp JID
 * @returns {string}
 */
export function extractGroupId(jid) {
    return jid;
}

function getConfiguredBotPhone() {
    const fromEnv = normalizePhoneNumber(process.env.BOT_PHONE || '');
    if (/^\d{10,15}$/.test(fromEnv)) return fromEnv;

    const chatId = process.env.WHATSAPP_CHAT_ID || '';
    const match = chatId.match(/^(\d{10,15})-/);
    return match ? match[1] : '';
}

function getBotLinkedLid(sock) {
    const raw = sock?.authState?.creds?.me?.lid || sock?.user?.lid || '';
    if (raw) {
        return jidNormalizedUser(String(raw)) || String(raw);
    }
    for (const value of [sock?.authState?.creds?.me?.id, sock?.user?.id]) {
        if (!value) continue;
        const id = String(value);
        if (id.includes('@lid')) {
            return jidNormalizedUser(id.split(':')[0]) || id.split(':')[0];
        }
    }
    return '';
}

/**
 * Best-effort phone number for the connected bot account.
 * @param {import('baileys').WASocket | null | undefined} sock
 * @returns {string}
 */
export function getBotAccountPhone(sock) {
    const configured = getConfiguredBotPhone();
    if (/^\d{10,15}$/.test(configured)) return configured;

    const candidates = [
        sock?.authState?.creds?.me?.phoneNumber,
        sock?.authState?.creds?.me?.id,
        sock?.user?.id,
    ].filter(Boolean);

    for (const raw of candidates) {
        const value = String(raw);
        if (value.includes('@lid')) continue;
        const phone = normalizePhoneNumber(extractPhoneNumber(value));
        if (/^\d{10,15}$/.test(phone)) return phone;
    }
    return configured;
}

/**
 * True when jid is the connected bot account (phone or LID) — DMs to self won't show up.
 * @param {import('baileys').WASocket | null | undefined} sock
 * @param {string} jid
 */
export function isBotSelfTarget(sock, jid) {
    if (!jid || !sock?.user?.id) return false;

    const botPhone = getBotAccountPhone(sock);
    const selfJid = jidNormalizedUser(sock.user.id.split(':')[0]) || sock.user.id.split(':')[0];
    const botLid = getBotLinkedLid(sock);

    const targetBare = jid.split(':')[0];
    const targetJid = jidNormalizedUser(targetBare) || targetBare;
    const targetPhone = normalizePhoneNumber(extractPhoneNumber(jid));

    if (botPhone && targetPhone && targetPhone === botPhone) return true;
    if (targetJid === selfJid) return true;
    if (botLid && targetJid === botLid) return true;
    return false;
}

/** WhatsApp "Message yourself" chat — same account as the connected bot. */
export function isBotSelfChat(sock, chatId) {
    if (!chatId || isGroupMessage(chatId)) return false;
    if (chatId === 'status@broadcast' || chatId.endsWith('@broadcast')) return false;
    return isBotSelfTarget(sock, chatId);
}

/** Sender JID for commands sent in the bot account's self-chat. */
export function getBotSelfSenderJid(sock) {
    const phone = getBotAccountPhone(sock);
    if (/^\d{10,15}$/.test(phone)) {
        return `${phone}@s.whatsapp.net`;
    }
    if (!sock?.user?.id) return '';
    const bare = sock.user.id.split(':')[0];
    return jidNormalizedUser(bare) || bare;
}

/** JID for WhatsApp "Message yourself" on the connected bot account. */
export function getBotSelfChatJid(sock) {
    const phone = getBotAccountPhone(sock);
    if (/^\d{10,15}$/.test(phone)) {
        return `${phone}@s.whatsapp.net`;
    }
    return getBotSelfSenderJid(sock);
}

/**
 * Pick a DM JID for notifications that is not the bot's own account.
 * @param {import('baileys').WASocket | null | undefined} sock
 * @param {string[]} preferredNumbers
 * @returns {string | null}
 */
export function resolveExternalNotificationJid(sock, preferredNumbers = []) {
    const botPhone = getBotAccountPhone(sock);
    for (const raw of preferredNumbers) {
        const phone = normalizePhoneNumber(raw);
        if (!/^\d{10,15}$/.test(phone)) continue;
        if (botPhone && phone === botPhone) continue;
        const jid = `${phone}@s.whatsapp.net`;
        if (!isBotSelfTarget(sock, jid)) return jid;
    }
    return null;
}

/**
 * Notification target: external owner phone first, else bot self-chat ("Message yourself").
 */
export function resolveNotificationJid(sock, preferredNumbers = []) {
    const external = resolveExternalNotificationJid(sock, preferredNumbers);
    if (external) return external;

    const selfChat = getBotSelfChatJid(sock);
    if (selfChat && sock?.user?.id) return selfChat;
    return null;
}
