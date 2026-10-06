/**
 * Welcome message helpers.
 *
 * Default header (always included when welcome is ON):
 *   hey @username , welcome to "{group}"
 *
 * Custom text from /setwc is appended on the next line.
 */

import { jidNormalizedUser } from 'baileys';

const USERNAME_PLACEHOLDER = '@username';
const GROUP_PLACEHOLDER = '{group}';

const JID_DOMAIN_RE = /@(s\.whatsapp\.net|lid(?:\.\w+)?|g\.us)$/i;
const LID_DOMAIN_RE = /@lid(?:\.\w+)?$/i;

export const DEFAULT_HEADER_TEMPLATE = `hey ${USERNAME_PLACEHOLDER} , welcome to "${GROUP_PLACEHOLDER}"`;

/**
 * @param {string} [customPart]
 * @returns {string}
 */
export function buildWelcomeTemplate(customPart = '') {
    const custom = (customPart || '').trim();
    if (!custom) {
        return DEFAULT_HEADER_TEMPLATE;
    }
    return `${DEFAULT_HEADER_TEMPLATE}\n${custom}`;
}

/**
 * Strip the default header if an admin pasted the full template.
 * @param {string} input
 * @returns {string}
 */
export function normalizeCustomWelcomePart(input) {
    let text = (input || '').trim();
    if (!text) {
        return '';
    }

    text = text.replace(
        /^hey\s+@username\s*,\s*welcome\s+to\s+"(\{group\}|[^"]+)"\s*/i,
        ''
    ).trim();

    return text;
}

/**
 * @param {string} jid
 * @returns {boolean}
 */
export function isValidParticipantJid(jid) {
    const normalized = typeof jid === 'string' ? jid.replace(/:\d+(?=@)/, '').trim() : '';
    if (!normalized || !normalized.includes('@')) {
        return false;
    }
    return JID_DOMAIN_RE.test(normalized);
}

function parseEmbeddedParticipantId(raw) {
    if (typeof raw !== 'string') {
        return '';
    }
    const trimmed = raw.trim();
    if (!trimmed.startsWith('{') || !trimmed.includes('id')) {
        return '';
    }
    try {
        const parsed = JSON.parse(trimmed.replace(/'/g, '"'));
        if (parsed?.id) {
            return normalizeParticipantEntry(parsed.id);
        }
    } catch {
        const match = trimmed.match(/['"]?id['"]?\s*[:=]\s*['"]?([^'"},\s]+)/i);
        if (match?.[1]) {
            return normalizeParticipantEntry(match[1]);
        }
    }
    return '';
}

/**
 * Normalize Baileys participant entry (string JID or { id, lid, ... } object).
 * Rejects display names and other non-JID strings.
 * @param {string | object | null | undefined} entry
 * @returns {string}
 */
export function normalizeParticipantEntry(entry) {
    if (!entry) {
        return '';
    }
    if (typeof entry === 'string') {
        let cleaned = entry.replace(/:\d+(?=@)/, '').trim();
        if (!cleaned) {
            return '';
        }

        const embedded = parseEmbeddedParticipantId(cleaned);
        if (embedded) {
            return embedded;
        }

        if (!cleaned.includes('@')) {
            const digits = cleaned.replace(/\D/g, '');
            if (/^\d{10,15}$/.test(digits)) {
                cleaned = `${digits}@s.whatsapp.net`;
            } else {
                return '';
            }
        }

        const normalized = jidNormalizedUser(cleaned) || cleaned;
        return isValidParticipantJid(normalized) ? normalized : '';
    }
    if (typeof entry === 'object') {
        const raw = entry.id || entry.jid || entry.lid || entry.phoneNumber || entry.pn;
        if (typeof raw === 'string' && raw) {
            return normalizeParticipantEntry(raw);
        }
        if (raw && typeof raw === 'object' && raw.user) {
            const server = raw.server || 's.whatsapp.net';
            return normalizeParticipantEntry(`${raw.user}@${server}`);
        }
    }
    return '';
}

/** A `@lid` JID's user part is an internal privacy id, never a phone number. */
export function isLidJid(jid) {
    return LID_DOMAIN_RE.test(String(jid || ''));
}

/**
 * @param {string} jid
 * @returns {string}
 */
export function mentionDisplayToken(jid) {
    if (!jid || !isValidParticipantJid(jid)) {
        return '@member';
    }
    const user = String(jid).split('@')[0].split(':')[0];
    return `@${user}`;
}

/**
 * Split "who to show" from "who to tag" for a group participant.
 *
 * THE BUG THIS FIXES: Baileys documents `Contact.id` as "either in lid or jid
 * format", so in a LID-addressed group `participant.id` IS the @lid. The welcome
 * used that id for the visible token, so the message read
 * `hey @209476153887421 , welcome to "X"` — a 15-digit privacy id that matches
 * nobody's phone and reads as garbage to the group.
 *
 * So: display the phone-number JID whenever one is known, and put BOTH the phone
 * and LID forms in `mentions` so the tag resolves whichever way the group
 * addresses its members.
 *
 * @param {string | object} participant Baileys participant record or a raw JID
 * @returns {{ displayJid: string, phoneJid: string, lidJid: string, mentions: string[] }}
 */
export function resolveMentionIdentity(participant) {
    const fromField = (v) => normalizeParticipantEntry(v);
    const isObject = participant && typeof participant === 'object';

    const pn = isObject ? fromField(participant.phoneNumber ?? participant.pn) : '';
    const lid = isObject ? fromField(participant.lid) : '';
    const id = fromField(isObject ? (participant.id ?? participant.jid) : participant);

    // Anything that is not a @lid is a usable phone JID.
    const phoneJid = [pn, id, lid].find((j) => j && !isLidJid(j)) || '';
    const lidJid = [lid, id].find((j) => j && isLidJid(j)) || '';
    const displayJid = phoneJid || lidJid;

    return {
        displayJid,
        phoneJid,
        lidJid,
        mentions: [...new Set([displayJid, phoneJid, lidJid].filter(Boolean))],
    };
}

/**
 * Index a group's participants by every digit form they can be addressed with
 * (id / lid / pn / phoneNumber, stripped of domain and device suffix).
 *
 * A bare digit string saved earlier (e.g. from `extractPhoneNumber(senderJid)`)
 * doesn't record which domain it came from — in a LID-addressed group that's
 * often `@lid`, not `@s.whatsapp.net`. Tagging it with the wrong domain always
 * produces an unresolvable mention: WhatsApp just prints the digits back as
 * plain text, which reads exactly like a stray JID. Looking the digits up here
 * against the group's *current* participant list recovers the participant
 * record regardless of which form was originally captured, so
 * `resolveMentionIdentity()` can build a mention that actually resolves.
 *
 * @param {Array<object>} participants
 * @returns {Map<string, object>}
 */
export function indexParticipantsByDigits(participants) {
    const index = new Map();
    for (const p of participants || []) {
        const keys = [p.id, p.lid, p.pn, p.phoneNumber]
            .filter(Boolean)
            .map((v) => String(v).split('@')[0].split(':')[0]);
        for (const k of keys) {
            if (k) index.set(k, p);
        }
    }
    return index;
}

/**
 * @param {string} customPart
 * @param {string} groupName
 * @param {string|object} member participant record, or the JID to display
 * @param {{ extraMentions?: string[] }} [opts] additional JIDs to tag — used to
 *   include the LID form alongside the phone form of the same person
 * @returns {{ text: string, mentions: string[] }}
 */
export function renderWelcomeMessage(customPart, groupName, member, { extraMentions = [] } = {}) {
    const safeGroup = groupName || 'this group';
    const template = buildWelcomeTemplate(customPart);

    // Accepts either a bare JID (old callers, previews) or a participant record.
    const identity = resolveMentionIdentity(member);
    const safeJid = identity.displayJid;
    const mentionToken = mentionDisplayToken(safeJid);

    let text = template
        .split(USERNAME_PLACEHOLDER)
        .join(mentionToken)
        .split(GROUP_PLACEHOLDER)
        .join(safeGroup)
        .split('"Group Name"')
        .join(safeGroup);

    const mentions = [...new Set([...identity.mentions, ...extraMentions].filter(Boolean))];
    return { text, mentions };
}

/**
 * @param {string} customPart
 * @param {string} groupName
 * @returns {string}
 */
export function previewWelcomeMessage(customPart, groupName) {
    const { text } = renderWelcomeMessage(
        customPart,
        groupName,
        '919999999999@s.whatsapp.net'
    );
    return text.replace('@919999999999', '@NewMember');
}

/**
 * @param {boolean} enabled
 * @returns {string}
 */
export function formatWelcomeStatus(enabled) {
    return enabled ? '✅ ON' : '❌ OFF';
}

export { USERNAME_PLACEHOLDER, GROUP_PLACEHOLDER };
