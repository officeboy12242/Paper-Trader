/**
 * Shared owner identity for activate mentions + AI / "who is the owner" replies.
 */

import { config } from '../config/config.js';
import { isBotSelfTarget } from './permissions.js';
import { getMentionedJids } from './waMessage.js';
import { mentionDisplayToken } from './welcomeMessage.js';

export function getPrimaryOwnerPhone() {
    const phones = (config.OWNER_NUMBERS || [])
        .map((n) => String(n || '').replace(/\D/g, ''))
        .filter((n) => /^\d{10,15}$/.test(n));
    if (phones[0]) return phones[0];
    return '917887499710';
}

export function getOwnerDisplayName() {
    return (config.ASSIST_OWNER_NAME || 'Jacky').trim() || 'Jacky';
}

export function getOwnerAbout() {
    const custom = (config.ASSIST_OWNER_ABOUT || '').trim();
    if (custom) return custom;
    const name = getOwnerDisplayName();
    return (
        `${name} — creator and owner of this WhatsApp bot. ` +
        'Builds tools for movies, Instagram downloads, horoscope, trade alerts, and group utilities.'
    );
}

export function getOwnerMentionJid() {
    return `${getPrimaryOwnerPhone()}@s.whatsapp.net`;
}

/** Facts for assist / LLM system prompts. */
export function buildOwnerFactsForPrompt() {
    const name = getOwnerDisplayName();
    const phone = getPrimaryOwnerPhone();
    const about = getOwnerAbout();
    return [
        'ABOUT YOU (share when asked who you are, about you, contact, or who owns/runs this bot):',
        `- Name: ${name}`,
        `- WhatsApp: +${phone} (tell them they can message this number to reach you)`,
        `- Bio: ${about}`,
        '- When they ask for contact / owner / creator, mention the WhatsApp number clearly so they can DM.',
        '- Do not invent extra private details (address, family, exact schedule) beyond this bio.',
    ].join('\n');
}

export function formatOwnerAboutReply() {
    const name = getOwnerDisplayName();
    const jid = getOwnerMentionJid();
    const mention = mentionDisplayToken(jid);
    const about = getOwnerAbout();
    const text =
        `👑 *Bot owner:* ${mention}\n` +
        `${about}\n\n` +
        `_Tap the name to open DM_`;
    return { text, mentions: [jid], name };
}

/** Drop leading @mentions so "@Bot who is ur owner" still matches. */
function normalizeOwnerQuestionText(text) {
    return String(text || '')
        .replace(/^(?:@\S+\s*)+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Clear “who is the owner / who made this bot” style questions. */
export function looksLikeOwnerAboutQuestion(text) {
    const t = normalizeOwnerQuestionText(text);
    if (!t || t.startsWith('/')) return false;
    return (
        /\bwho\s+is\s+(ur|your)\s+owner\b/i.test(t)
        || /\bwho\s+is\s+the\s+owner(\s+(of\s+(this|the)\s+bot|here))?\s*\??\s*$/i.test(t)
        || /\bwho\s+is\s+owner\s*\??\s*$/i.test(t)
        || /\bwho\s*(?:'s|s)\s+(ur|your)\s+owner\b/i.test(t)
        || /\bwho\s+(made|created|built|runs|owns)\s+(this|the)\s+bot\b/i.test(t)
        || /\bwho\s+(made|created|built)\s+(this|you|u)\b/i.test(t)
        || /\babout\s+(the\s+)?(owner|creator)\b/i.test(t)
        || /\bcontact\s+(the\s+)?owner\b/i.test(t)
        || /\bwhose\s+bot\s+is\s+this\b/i.test(t)
        || /\b(ur|your)\s+owner\s*(kaun|hai|kon)?\b/i.test(t)
        || /\b(owner\s+kaun|kisne\s+banaya|bot\s+ka\s+owner|creator\s+kaun|maalik\s+kaun)\b/i.test(t)
        || /\b(मालिक कौन|किसने बनाया|ओनर कौन)\b/.test(t)
    );
}

/** “Your/ur owner” / “who made you” — clearly aimed at the bot, even without @mention. */
export function isBotDirectedOwnerQuestion(text) {
    const t = normalizeOwnerQuestionText(text);
    if (!t) return false;
    return (
        /\bwho\s+is\s+(ur|your)\s+owner\b/i.test(t)
        || /\bwho\s+(made|created|built)\s+you\b/i.test(t)
        || /\bwho\s*(?:'s|s)\s+your\s+owner\b/i.test(t)
    );
}

/** True when the message @mentions the connected bot (phone or LID). */
export function messageMentionsBot(sock, waMessage) {
    if (!sock?.user || !waMessage) return false;
    return getMentionedJids(waMessage).some((jid) => isBotSelfTarget(sock, jid));
}

// ponytail: one assert check — fails if owner-about detector regresses
if (process.argv[1] && /ownerProfile\.js$/.test(String(process.argv[1]).replace(/\\/g, '/'))) {
    const ok =
        looksLikeOwnerAboutQuestion('who is the owner?')
        && looksLikeOwnerAboutQuestion('who is ur owner')
        && looksLikeOwnerAboutQuestion('@BotName who is ur owner')
        && isBotDirectedOwnerQuestion('who is ur owner')
        && looksLikeOwnerAboutQuestion('who made this bot')
        && looksLikeOwnerAboutQuestion('bot ka owner kaun hai')
        && !looksLikeOwnerAboutQuestion('who is the owner of Tesla stock')
        && !isBotDirectedOwnerQuestion('who is the owner');
    if (!ok) {
        console.error('ownerProfile self-check failed');
        process.exit(1);
    }
    console.log('ownerProfile self-check ok');
}
