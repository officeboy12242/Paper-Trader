/**
 * LID / phone JID helpers (ported from WhatsAppBotMultiDevice, with Baileys 6 fallback store).
 */

import { jidNormalizedUser } from 'baileys';

/** @type {Map<string, string>} lid -> pn digits */
const lidToPn = new Map();
/** @type {Map<string, string>} pn digits -> lid jid */
const pnToLid = new Map();

export function isLID(jid) {
    return Boolean(jid && jid.includes('@lid'));
}

export function isPN(jid) {
    return Boolean(jid && jid.includes('@s.whatsapp.net'));
}

export function isGroupJid(jid) {
    return Boolean(jid && jid.endsWith('@g.us'));
}

export function extractLidPhoneNumber(jid) {
    if (typeof jid !== 'string' || !jid) return '';
    if (jid.includes(':')) {
        return jid.split(':')[0].split('@')[0];
    }
    return jid.split('@')[0];
}

function normalizePnDigits(pn) {
    if (!pn) return '';
    return String(pn).replace(/\D/g, '');
}

function toPnJid(pn) {
    const digits = normalizePnDigits(pn);
    if (!/^\d{10,15}$/.test(digits)) return '';
    return `${digits}@s.whatsapp.net`;
}

function toLidJid(lid) {
    if (!lid) return '';
    const s = String(lid);
    if (s.includes('@lid')) {
        return jidNormalizedUser(s.replace(/:\d+(?=@)/, '')) || s.replace(/:\d+(?=@)/, '');
    }
    const digits = s.replace(/\D/g, '');
    if (!digits) return '';
    return `${digits}@lid`;
}

/**
 * Persist LID↔PN from an incoming message key (Baileys 7 store + local fallback).
 * @param {import('baileys').WASocket | null | undefined} sock
 * @param {import('baileys').WAMessage['key'] | null | undefined} key
 */
export function rememberLidPnFromMessageKey(sock, key) {
    if (!key?.remoteJid || !isLID(key.remoteJid)) return;

    const pnRaw = key.remoteJidAlt || key.senderPn || '';
    const pnDigits = normalizePnDigits(pnRaw.includes('@') ? extractLidPhoneNumber(pnRaw) : pnRaw);
    if (!/^\d{10,15}$/.test(pnDigits)) return;

    const lid = toLidJid(key.remoteJid);
    void storeLIDPNMapping(sock, lid, pnDigits);
}

export async function storeLIDPNMapping(sock, lid, pn) {
    const lidJid = toLidJid(lid);
    const pnDigits = normalizePnDigits(pn);
    if (!lidJid || !/^\d{10,15}$/.test(pnDigits)) return;

    const pnJid = toPnJid(pnDigits);
    try {
        if (sock?.signalRepository?.lidMapping?.storeLIDPNMappings && pnJid) {
            await sock.signalRepository.lidMapping.storeLIDPNMappings([{ lid: lidJid, pn: pnJid }]);
        }
    } catch {
        // fall through to local cache
    }

    lidToPn.set(lidJid, pnDigits);
    pnToLid.set(pnDigits, lidJid);
}

export async function getPNFromLID(sock, lid) {
    const jid = await getPNJidFromLID(sock, lid);
    if (!jid) return null;
    const digits = normalizePnDigits(extractLidPhoneNumber(jid));
    return /^\d{10,15}$/.test(digits) ? digits : null;
}

/** Full phone JID from LID (preserves device suffix from Baileys store). */
export async function getPNJidFromLID(sock, lid) {
    if (!lid) return null;

    const lidJid = toLidJid(lid);

    try {
        const fromRepo = await sock?.signalRepository?.lidMapping?.getPNForLID?.(lidJid);
        if (fromRepo) return jidNormalizedUser(fromRepo) || fromRepo;
    } catch {
        // ignore
    }

    const digits = lidToPn.get(lidJid);
    return digits ? toPnJid(digits) : null;
}

export async function getLIDFromPN(sock, phoneNumber) {
    const digits = normalizePnDigits(phoneNumber);
    if (!/^\d{10,15}$/.test(digits)) {
        return toPnJid(phoneNumber) || String(phoneNumber);
    }

    try {
        if (sock?.signalRepository?.lidMapping?.getLIDForPN) {
            const lid = await sock.signalRepository.lidMapping.getLIDForPN(digits);
            if (lid) return lid.includes('@') ? lid : `${lid}@lid`;
        }
    } catch {
        // ignore
    }

    const cached = pnToLid.get(digits);
    if (cached) return cached;
    return `${digits}@s.whatsapp.net`;
}

/**
 * Preferred outbound JID — LID when known (reference admin DM pattern), else phone.
 * @param {import('baileys').WASocket | null | undefined} sock
 * @param {string} identifier
 * @returns {Promise<string>}
 */
export async function normalizeJID(sock, identifier) {
    if (!identifier) return '';
    if (identifier.includes('@')) return jidNormalizedUser(identifier.replace(/:\d+(?=@)/, '')) || identifier;

    return getLIDFromPN(sock, identifier);
}

/**
 * Reply target for an incoming chat — use remoteJid (reference: `from = msg.key.remoteJid`).
 * @param {import('baileys').WAMessage['key'] | null | undefined} key
 * @param {string} chatId
 * @returns {string}
 */
export function resolveReplyChatJid(key, chatId) {
    const fromKey = key?.remoteJid ? jidNormalizedUser(String(key.remoteJid).replace(/:\d+(?=@)/, '')) || key.remoteJid : '';
    const fromChat = chatId ? jidNormalizedUser(String(chatId).replace(/:\d+(?=@)/, '')) || chatId : '';
    return fromChat || fromKey || '';
}
