/**
 * Group handlers: activate, deactivate, instaon, instaoff, groups, setwc, welcome event
 */

import { jidNormalizedUser } from 'baileys';
import { logger, describeError } from '../../utils/logger.js';
import { sendTextWithLinkPreview } from '../../utils/linkPreview.js';
import { extractPhoneNumber, normalizePhoneNumber } from '../../utils/permissions.js';
import { scheduleAutoDelete, AUTO_DELETE_2_MIN } from '../../utils/autoDelete.js';
import {
    DEFAULT_HEADER_TEMPLATE,
    formatWelcomeStatus,
    isValidParticipantJid,
    mentionDisplayToken,
    normalizeCustomWelcomePart,
    normalizeParticipantEntry,
    previewWelcomeMessage,
    renderWelcomeMessage,
    resolveMentionIdentity,
} from '../../utils/welcomeMessage.js';
import {
    dedupeParticipantRecords,
    groupParticipantSnapshot,
} from '../../utils/groupParticipantSnapshot.js';
import { config } from '../../config/config.js';
import { getYesterdayDateStrIST } from '../../utils/dateIST.js';
import { getPrimaryOwnerPhone } from '../../utils/ownerProfile.js';
import { formatClockLabel, DEFAULT_OPEN_TIME, DEFAULT_CLOSE_TIME } from '../AutoChatController.js';

/** Dedupe welcome when both stub message + participants.update fire */
const recentWelcomes = new Map();
const WELCOME_DEDUPE_MS = 45_000;
const WELCOME_JOIN_DELAY_MS = 2500;

/** WhatsApp stub types that indicate someone joined */
const JOIN_STUB_TYPES = new Set([
    27, // GROUP_PARTICIPANT_ADD
    31, // GROUP_PARTICIPANT_INVITE
    32, // GROUP_PARTICIPANT_ADD_REQUEST
    172, // GROUP_MEMBERSHIP_JOIN_APPROVAL
]);

const JOIN_ACTIONS = new Set(['add', 'linked', 'invite']);

/** WhatsApp stub types for leave/remove — never welcome these */
const LEAVE_STUB_TYPES = new Set([
    28, // GROUP_PARTICIPANT_REMOVE
    29, // GROUP_PARTICIPANT_LEAVE
]);

const LEAVE_ACTIONS = new Set(['remove', 'leave', 'left']);

/** @type {Map<string, { timer: NodeJS.Timeout, baseline: { keys: Set<string>, memberCount: number } }>} */
const pendingWelcomeJobs = new Map();

/**
 * A WhatsApp group JID is either the modern all-digit form (`1203630…@g.us`,
 * 15+ digits) or the legacy `creatorPhone-timestamp@g.us`. Anything shorter is
 * malformed — usually a stale or hand-edited database row — and every
 * groupMetadata call for it will fail forever. Catching the shape here turns a
 * recurring mystery warning into one that names the cause.
 */
const GROUP_JID_RE = /^(?:\d{15,25}|\d{8,15}-\d{8,14})@g\.us$/;

export function isPlausibleGroupJid(groupId) {
    return GROUP_JID_RE.test(String(groupId || ''));
}

/** Prefer cached metadata — raw groupMetadata is brutal in 500–1000+ member groups. */
async function getGroupMeta(sock, groupId, groupManager = null) {
    if (!isPlausibleGroupJid(groupId)) {
        throw new Error(`malformed group id "${groupId}" — not a WhatsApp group JID`);
    }
    if (!sock?.groupMetadata && !groupManager?.getGroupMetadataCached) {
        throw new Error('WhatsApp socket not ready');
    }
    if (groupManager?.getGroupMetadataCached) {
        return groupManager.getGroupMetadataCached(sock, groupId);
    }
    return sock.groupMetadata(groupId);
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isBotAccountJid(sock, memberJid) {
    const botRaw = sock?.user?.id;
    if (!botRaw || !memberJid) {
        return false;
    }
    const botNorm = jidNormalizedUser(String(botRaw).replace(/:\d+(?=@)/, '')) || '';
    const memberNorm = normalizeParticipantEntry(memberJid);
    if (botNorm && memberNorm === botNorm) {
        return true;
    }
    const botPhone = extractPhoneNumber(botNorm);
    const memberPhone = extractPhoneNumber(memberNorm);
    return Boolean(botPhone && memberPhone && botPhone === memberPhone);
}

function welcomeDedupeKey(groupId, memberJid) {
    const phone = extractPhoneNumber(memberJid);
    if (phone) {
        return `${groupId}:p:${phone}`;
    }
    return `${groupId}:j:${memberJid}`;
}

function shouldSendWelcome(groupId, memberJid) {
    const key = welcomeDedupeKey(groupId, memberJid);
    const now = Date.now();
    const until = recentWelcomes.get(key);
    if (until && until > now) {
        return false;
    }
    recentWelcomes.set(key, now + WELCOME_DEDUPE_MS);
    if (recentWelcomes.size > 500) {
        for (const [k, exp] of recentWelcomes) {
            if (exp <= now) recentWelcomes.delete(k);
        }
    }
    return true;
}

/**
 * Find the group's own participant record for a joiner, so the welcome can show a
 * phone number and tag both its addressing forms.
 *
 * Returning the record (not just a JID) is the fix: the previous version returned
 * `p.id`, which Baileys documents as "lid or jid format" — in a LID-addressed
 * group that is the @lid, and the welcome then printed its 15-digit privacy id
 * instead of the member's number.
 *
 * @returns {Promise<{ displayJid: string, phoneJid: string, lidJid: string, mentions: string[] }>}
 */
async function resolveWelcomeMentionIdentity(sock, groupId, memberJid, groupManager = null) {
    const normalized = normalizeParticipantEntry(memberJid);
    if (!normalized) {
        return resolveMentionIdentity('');
    }

    try {
        const meta = await getGroupMeta(sock, groupId, groupManager);
        const targetPhone = extractPhoneNumber(normalized);
        for (const p of meta.participants || []) {
            const candidates = [
                normalizeParticipantEntry(p.id),
                normalizeParticipantEntry(p.lid),
                normalizeParticipantEntry(p.phoneNumber),
            ].filter(Boolean);

            const sameJid = candidates.includes(normalized);
            const samePhone =
                targetPhone && candidates.some((c) => extractPhoneNumber(c) === targetPhone);
            if (sameJid || samePhone) {
                const identity = resolveMentionIdentity(p);
                // The event's own JID may carry a form the metadata record lacks.
                if (identity.displayJid) {
                    return {
                        ...identity,
                        mentions: [...new Set([...identity.mentions, normalized])],
                    };
                }
            }
        }
    } catch (err) {
        logger.debug(`Welcome mention resolve failed: ${describeError(err)}`);
    }

    return resolveMentionIdentity(normalized);
}

async function captureWelcomeBaseline(sock, groupId) {
    let keys = groupParticipantSnapshot.cloneGroupKeys(groupId);
    if (!keys.size) {
        await groupParticipantSnapshot.seedGroup(sock, groupId);
        keys = groupParticipantSnapshot.cloneGroupKeys(groupId);
    }

    return { keys };
}

async function sendWelcomeForMember(sock, groupManager, groupId, rawParticipant, config) {
    const memberJid = normalizeParticipantEntry(rawParticipant);
    if (!memberJid || !isValidParticipantJid(memberJid) || isBotAccountJid(sock, memberJid)) {
        return;
    }

    const [verified] = await filterCurrentGroupMembers(sock, groupId, [rawParticipant], groupManager);
    if (!verified) {
        logger.debug(`Welcome skipped — ${memberJid} is not in ${groupId}`);
        return;
    }

    if (!shouldSendWelcome(groupId, memberJid)) {
        return;
    }

    if (!config) {
        config = await groupManager.getWelcomeConfig(groupId);
        if (!config) {
            return;
        }
    }

    let groupName = config.group_name || 'this group';
    try {
        const meta = await groupManager.getGroupMetadataCached(sock, groupId);
        groupName = meta.subject || groupName;
    } catch (err) {
        logger.warn(`Welcome: could not fetch group name for ${groupId}: ${describeError(err)}`);
    }

    const identity = await resolveWelcomeMentionIdentity(sock, groupId, memberJid, groupManager);
    if (!isValidParticipantJid(identity.displayJid)) {
        logger.debug(`Welcome skipped — invalid mention JID for ${groupId}`);
        return;
    }

    const { text, mentions } = renderWelcomeMessage(
        config.welcome_message || '',
        groupName,
        identity.displayJid,
        { extraMentions: identity.mentions },
    );

    const sent = await sock.sendMessage(groupId, {
        text,
        mentions: mentions.length ? mentions : undefined,
    });

    if (sent?.key) {
        scheduleAutoDelete(sock, sent.key.remoteJid || groupId, sent.key, AUTO_DELETE_2_MIN);
    }

    logger.info(
        `👋 Welcome sent in ${groupName} to ${identity.displayJid}` +
            `${identity.lidJid && identity.phoneJid ? ' (+lid tagged)' : ''} (auto-delete in 2m)`
    );
}

/**
 * Send welcome to one or more new members.
 */
export async function handleParticipantJoin(sock, groupId, participants, { groupManager }) {
    if (!groupId?.endsWith('@g.us') || !participants?.length) {
        return;
    }

    const config = await groupManager.getWelcomeConfig(groupId);
    if (!config) {
        logger.debug(`Welcome skipped for ${groupId} — not enabled (use /setwc on)`);
        return;
    }

    const unique = dedupeParticipantRecords(participants);
    for (const entry of unique) {
        try {
            await sendWelcomeForMember(sock, groupManager, groupId, entry, config);
        } catch (err) {
            logger.error(`Welcome failed for ${groupId}: ${describeError(err)}`);
        }
        await delay(400);
    }
}

export function cancelPendingWelcome(groupId) {
    const prev = pendingWelcomeJobs.get(groupId);
    if (prev?.timer) {
        clearTimeout(prev.timer);
    }
    pendingWelcomeJobs.delete(groupId);
}

async function filterCurrentGroupMembers(sock, groupId, entries, groupManager = null) {
    if (!entries?.length) {
        return [];
    }

    let meta;
    try {
        meta = await getGroupMeta(sock, groupId, groupManager);
    } catch (err) {
        logger.warn(`Welcome member filter failed for ${groupId}: ${describeError(err)}`);
        return [];
    }

    const memberKeys = groupParticipantSnapshot.buildMemberKeySet(meta.participants || []);
    const verified = [];

    for (const entry of entries) {
        const jid = normalizeParticipantEntry(entry);
        if (!jid) {
            continue;
        }
        if (groupParticipantSnapshot.isKeyInMemberSet(jid, memberKeys)) {
            verified.push(entry);
        } else {
            logger.debug(`Welcome skipped non-member ${jid} in ${groupId}`);
        }
    }

    return verified;
}

async function runWelcomeAfterJoin(sock, groupManager, groupId, baseline) {
    const config = await groupManager.getWelcomeConfig(groupId);
    if (!config || !baseline?.keys?.size) {
        return;
    }

    // Detect new members via participant key diff. The baseline keys are
    // captured from the snapshot at event time, before the delayed check,
    // so they reliably represent the pre-join participant set. We used to
    // also gate on a member-count comparison, but the baseline count was
    // fetched from metadata *after* the join (the event fires post-join),
    // making the gate always see "no increase" and skip the welcome.
    let newParticipants = [];
    try {
        newParticipants = await groupParticipantSnapshot.detectNewSince(sock, groupId, baseline.keys);
    } catch (err) {
        logger.warn(`Welcome participant diff failed for ${groupId}: ${describeError(err)}`);
        return;
    }

    const toWelcome = dedupeParticipantRecords(newParticipants);
    if (!toWelcome.length) {
        logger.debug(`Welcome: no new members detected for ${groupId}`);
        return;
    }

    logger.info(`👋 Welcoming ${toWelcome.length} member(s) in ${groupId}`);
    await handleParticipantJoin(sock, groupId, toWelcome, { groupManager });
}

async function captureAndScheduleWelcome(sock, groupManager, groupId) {
    const baseline = await captureWelcomeBaseline(sock, groupId);
    if (!baseline.keys.size) {
        logger.debug(`Welcome skipped for ${groupId} — no participant baseline`);
        return;
    }

    const prev = pendingWelcomeJobs.get(groupId);
    if (prev?.timer) {
        clearTimeout(prev.timer);
    }

    const timer = setTimeout(() => {
        pendingWelcomeJobs.delete(groupId);
        void runWelcomeAfterJoin(sock, groupManager, groupId, baseline).catch((err) => {
            logger.error(`Welcome after join failed for ${groupId}: ${describeError(err)}`);
        });
    }, WELCOME_JOIN_DELAY_MS);

    pendingWelcomeJobs.set(groupId, { timer, baseline });
}

export function scheduleWelcomeAfterJoin(sock, groupManager, groupId) {
    if (!groupId?.endsWith('@g.us')) {
        return;
    }

    void captureAndScheduleWelcome(sock, groupManager, groupId).catch((err) => {
        logger.error(`Welcome schedule failed for ${groupId}: ${describeError(err)}`);
    });
}

export async function handleActivate(sock, chatId, senderJid, { groupManager, originalMsg }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        let groupName = 'Unknown Group';
        try {
            const groupMetadata = await getGroupMeta(sock, chatId, groupManager);
            groupName = groupMetadata.subject;
        } catch (err) {
            logger.error(`Error fetching group metadata: ${err.message}`);
        }

        await groupManager.activateGroup(chatId, groupName, senderPhone);

        const ownerPhone = getPrimaryOwnerPhone();
        const ownerJid = `${ownerPhone}@s.whatsapp.net`;
        const ownerMention = mentionDisplayToken(ownerJid);

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '✅ *GROUP ACTIVATED* ✅\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += `📢 *Group:* ${groupName}\n`;
        r += `👑 *Owner:* ${ownerMention}\n`;
        r += '_Tap the name above to open DM_\n\n';
        r += '🎓 This group will now receive free course updates!\n';
        r += '📰 Tech news digests at *10:00 AM* & *10:00 PM* (IST)!\n';
        r += '🐙 GitHub repos daily at *9:00, 11:30, 2:00, 4:30 & 7:00 PM* (IST) — *Saturdays* = college/resume projects only!\n\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '💡 Use `/newsoff`, `/githuboff`, or `/coursesoff` to turn off individually\n';
        r += '💡 Use `/instaon` for auto Instagram downloads\n';
        r += '💡 Use `/deactivate` to stop all updates';

        await sock.sendMessage(chatId, {
            text: r,
            mentions: [ownerJid],
        }, { quoted: originalMsg });
        logger.info(`✅ Group activated: ${groupName} (${chatId}) by ${senderPhone}`);
    } catch (error) {
        logger.error(`Error activating group: ${error.message}`);
    }
}

export async function handleDeactivate(sock, chatId, senderJid, { groupManager, originalMsg }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        const success = await groupManager.deactivateGroup(chatId);

        if (success) {
            let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            r += '🛑 *GROUP DEACTIVATED* 🛑\n';
            r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
            r += '📢 This group will no longer receive courses or tech news.\n\n';
            r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            r += '💡 Use `/activate` to start receiving updates again';
            await sock.sendMessage(chatId, { text: r }, { quoted: originalMsg });
            logger.info(`🛑 Group deactivated: ${chatId} by ${senderPhone}`);
        } else {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\nℹ️ *NOT ACTIVATED* ℹ️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'This group is not activated.',
            }, { quoted: originalMsg });
        }
    } catch (error) {
        logger.error(`Error deactivating group: ${error.message}`);
    }
}

export async function handleInstaOn(sock, chatId, senderJid, { groupManager, originalMsg }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        let groupName = 'Unknown Group';
        try {
            const groupMetadata = await getGroupMeta(sock, chatId, groupManager);
            groupName = groupMetadata.subject;
        } catch (err) {
            logger.error(`Error fetching group metadata: ${err.message}`);
        }

        await groupManager.setInstaAuto(chatId, groupName, true, senderPhone);

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '✅ *INSTA AUTO ON* ✅\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += `📢 *Group:* ${groupName}\n\n`;
        r += '📸 Instagram links pasted here will download automatically.\n';
        r += '_No `/i` command needed — just send the link._\n\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '💡 Use `/instaoff` to turn this off';

        await sock.sendMessage(chatId, { text: r }, { quoted: originalMsg });
        logger.info(`📸 Insta auto enabled: ${groupName} (${chatId}) by ${senderPhone}`);
    } catch (error) {
        logger.error(`Error enabling insta auto: ${error.message}`);
    }
}

export async function handleInstaOff(sock, chatId, senderJid, { groupManager, originalMsg }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        const wasEnabled = await groupManager.isInstaAutoEnabled(chatId);
        if (!wasEnabled) {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\nℹ️ *INSTA AUTO OFF* ℹ️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'Auto Instagram download is not enabled in this group.\n\nUse `/instaon` to enable it.',
            }, { quoted: originalMsg });
            return;
        }

        let groupName = 'Unknown Group';
        try {
            const groupMetadata = await getGroupMeta(sock, chatId, groupManager);
            groupName = groupMetadata.subject;
        } catch (err) {
            logger.error(`Error fetching group metadata: ${err.message}`);
        }

        await groupManager.setInstaAuto(chatId, groupName, false, senderPhone);

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '🛑 *INSTA AUTO OFF* 🛑\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += `📢 *Group:* ${groupName}\n\n`;
        r += 'Links will no longer auto-download.\n';
        r += 'Members can still use `/i <url>` manually.\n\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '💡 Use `/instaon` to enable again';

        await sock.sendMessage(chatId, { text: r }, { quoted: originalMsg });
        logger.info(`📸 Insta auto disabled: ${chatId} by ${senderPhone}`);
    } catch (error) {
        logger.error(`Error disabling insta auto: ${error.message}`);
    }
}

export async function handleStickerOn(sock, chatId, senderJid, { groupManager, stickerForwarder, originalMsg }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        let groupName = 'Unknown Group';
        try {
            const groupMetadata = await getGroupMeta(sock, chatId, groupManager);
            groupName = groupMetadata.subject;
        } catch (err) {
            logger.error(`Error fetching group metadata: ${err.message}`);
        }

        await groupManager.setStickerAuto(chatId, groupName, true, senderPhone);
        if (stickerForwarder) {
            await stickerForwarder.refreshTargetGroups();
        }

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '✅ *STICKER AUTO ON* ✅\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += `📢 *Group:* ${groupName}\n\n`;
        r += '🎨 Stickers from configured channels & source groups will be posted here automatically.\n\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '💡 Use `/stickeroff` to turn this off';

        await sock.sendMessage(chatId, { text: r }, { quoted: originalMsg });
        logger.info(`🎨 Sticker auto enabled: ${groupName} (${chatId}) by ${senderPhone}`);
    } catch (error) {
        logger.error(`Error enabling sticker auto: ${error.message}`);
    }
}

export async function handleStickerOff(sock, chatId, senderJid, { groupManager, stickerForwarder, originalMsg }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        const wasEnabled = await groupManager.isStickerAutoEnabled(chatId);
        if (!wasEnabled) {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\nℹ️ *STICKER AUTO OFF* ℹ️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'Auto sticker forwarding is not enabled in this group.\n\nUse `/stickeron` to enable it.',
            }, { quoted: originalMsg });
            return;
        }

        let groupName = 'Unknown Group';
        try {
            const groupMetadata = await getGroupMeta(sock, chatId, groupManager);
            groupName = groupMetadata.subject;
        } catch (err) {
            logger.error(`Error fetching group metadata: ${err.message}`);
        }

        await groupManager.setStickerAuto(chatId, groupName, false, senderPhone);
        if (stickerForwarder) {
            await stickerForwarder.refreshTargetGroups();
        }

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '🛑 *STICKER AUTO OFF* 🛑\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += `📢 *Group:* ${groupName}\n\n`;
        r += 'This group will no longer receive auto-forwarded stickers.\n\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '💡 Use `/stickeron` to enable again';

        await sock.sendMessage(chatId, { text: r }, { quoted: originalMsg });
        logger.info(`🎨 Sticker auto disabled: ${chatId} by ${senderPhone}`);
    } catch (error) {
        logger.error(`Error disabling sticker auto: ${error.message}`);
    }
}

export async function handleGroups(sock, chatId, senderJid, { groupManager }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);

        const [activeGroups, courseGroups, newsGroups, githubGroups, awesomeGroups, interviewQGroups, instaAutoGroups, stickerAutoGroups, welcomeGroups, movieGroups, trendingGroups, groupCount, memberCounts] =
            await Promise.all([
                groupManager.getActiveGroups(),
                groupManager.getCourseEnabledGroups(),
                groupManager.getNewsEnabledGroups(),
                groupManager.getGithubTrendingGroups(),
                groupManager.getAwesomeListsGroups(),
                groupManager.getInterviewQGroups(),
                groupManager.getInstaAutoGroups(),
                groupManager.getStickerAutoGroups(),
                groupManager.getWelcomeEnabledGroups(),
                groupManager.getMovieEnabledGroups(),
                groupManager.getWeeklyTrendingGroups(),
                groupManager.getGroupCount(),
                groupManager.getParticipatingGroupMemberCounts(sock),
            ]);

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '📋 *GROUPS OVERVIEW* 📋\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += `📊 *Groups:* ${groupCount.active} active / ${groupCount.total} tracked\n`;
        r += `🎓 *Courses:* ${courseGroups.length} ON\n`;
        r += `📰 *Tech news:* ${newsGroups.length} ON\n`;
        r += `🐙 *GitHub trending:* ${githubGroups.length} ON\n`;
        r += `⭐ *Awesome lists:* ${awesomeGroups.length} ON\n`;
        r += `🧠 *Interview Q:* ${interviewQGroups.length} ON\n`;
        r += `📸 *Insta auto:* ${instaAutoGroups.length} group(s)\n`;
        r += `🎨 *Sticker auto:* ${stickerAutoGroups.length} group(s)\n`;
        r += `🎬 *Movie:* ${movieGroups.length} ON\n`;
        r += `🔥 *Trending:* ${trendingGroups.length} ON\n`;
        r += `👋 *Welcome:* ${welcomeGroups.length} ON\n\n`;

        r += '🎓 *Groups — course / news status*\n';
        r += '_(courses: `/courson` `/coursesoff` · news: `/newson`)_\n\n';

        if (!activeGroups.length) {
            r += '📭 None yet. Use `/activate` in a group.\n\n';
        } else {
            activeGroups.forEach((group, index) => {
                const activatedDate = new Date(group.activated_at).toLocaleDateString();
                const members = groupManager.formatMemberCount(memberCounts, group.group_id);
                const coursesOn = group.courses_enabled !== false;
                const newsOn = group.news_enabled !== false;
                const githubOn = group.github_trending !== false;
                r += `${index + 1}. *${group.group_name}*\n`;
                r += `   👥 Members: ${members}\n`;
                r += `   🎓 Courses: ${coursesOn ? '✅ ON' : '❌ OFF'} · 📰 News: ${newsOn ? '✅ ON' : '❌ OFF'} · 🐙 GitHub: ${githubOn ? '✅ ON' : '❌ OFF'}\n`;
                r += `   📅 Activated: ${activatedDate}\n\n`;
            });
        }

        r += '📰 *Tech news ON — groups*\n';
        r += '_(scheduled digests via `/newson` · off with `/newsoff`)_\n\n';

        if (!newsGroups.length) {
            r += '📭 None yet. Use `/activate` then `/newson` in a group.\n\n';
        } else {
            newsGroups.forEach((group, index) => {
                const members = groupManager.formatMemberCount(memberCounts, group.group_id);
                r += `${index + 1}. *${group.group_name}*\n`;
                r += `   👥 Members: ${members}\n`;
                if (group.news_set_at) {
                    r += `   📅 Since: ${new Date(group.news_set_at).toLocaleDateString()}\n`;
                }
                r += '\n';
            });
        }

        r += '🐙 *GitHub trending ON — groups*\n';
        r += '_(daily top 5 repos — one post each via `/githubon` · off with `/githuboff`)_\n\n';

        if (!githubGroups.length) {
            r += '📭 None yet. Use `/activate` then `/githubon` in a group.\n\n';
        } else {
            githubGroups.forEach((group, index) => {
                const members = groupManager.formatMemberCount(memberCounts, group.group_id);
                r += `${index + 1}. *${group.group_name}*\n`;
                r += `   👥 Members: ${members}\n`;
                if (group.github_trending_at) {
                    r += `   📅 Since: ${new Date(group.github_trending_at).toLocaleDateString()}\n`;
                }
                r += '\n';
            });
        }

        r += '⭐ *Awesome lists ON — groups*\n';
        r += '_(1 random awesome-* list per slot via `/awesomeon` · off with `/awesomeoff`)_\n\n';

        if (!awesomeGroups.length) {
            r += '📭 None yet. Use `/activate` then `/awesomeon` in a group.\n\n';
        } else {
            awesomeGroups.forEach((group, index) => {
                const members = groupManager.formatMemberCount(memberCounts, group.group_id);
                r += `${index + 1}. *${group.group_name}*\n`;
                r += `   👥 Members: ${members}\n`;
                if (group.awesome_lists_at) {
                    r += `   📅 Since: ${new Date(group.awesome_lists_at).toLocaleDateString()}\n`;
                }
                r += '\n';
            });
        }

        r += '📸 *Insta auto ON — groups*\n';
        r += '_(auto-download Instagram links via `/instaon`)_\n\n';

        if (!instaAutoGroups.length) {
            r += '📭 None yet. Use `/instaon` in a group.\n\n';
        } else {
            instaAutoGroups.forEach((group, index) => {
                const members = groupManager.formatMemberCount(memberCounts, group.group_id);
                r += `${index + 1}. *${group.group_name}*\n`;
                r += `   👥 Members: ${members}\n`;
                if (group.insta_auto_at) {
                    r += `   📸 Since: ${new Date(group.insta_auto_at).toLocaleDateString()}\n`;
                }
                r += '\n';
            });
        }

        r += '🎨 *Sticker auto ON — groups*\n';
        r += '_(channel/source stickers via `/stickeron`)_\n\n';

        if (!stickerAutoGroups.length) {
            r += '📭 None yet. Use `/stickeron` in a group.\n\n';
        } else {
            stickerAutoGroups.forEach((group, index) => {
                const members = groupManager.formatMemberCount(memberCounts, group.group_id);
                r += `${index + 1}. *${group.group_name}*\n`;
                r += `   👥 Members: ${members}\n`;
                if (group.sticker_auto_at) {
                    r += `   🎨 Since: ${new Date(group.sticker_auto_at).toLocaleDateString()}\n`;
                }
                r += '\n';
            });
        }

        r += '👋 *Welcome ON — groups*\n';
        r += '_(new member greeting via `/setwc`)_\n\n';

        if (!welcomeGroups.length) {
            r += '📭 None yet. Use `/setwc` in a group.\n\n';
        } else {
            welcomeGroups.forEach((group, index) => {
                const members = groupManager.formatMemberCount(memberCounts, group.group_id);
                const extra = group.welcome_message
                    ? group.welcome_message.slice(0, 60) + (group.welcome_message.length > 60 ? '…' : '')
                    : 'default header only';
                r += `${index + 1}. *${group.group_name}*\n`;
                r += `   🔘 Status: ${formatWelcomeStatus(true)}\n`;
                r += `   👥 Members: ${members}\n`;
                r += `   💬 Extra: ${extra}\n`;
                if (group.welcome_set_at) {
                    r += `   📅 Since: ${new Date(group.welcome_set_at).toLocaleDateString()}\n`;
                }
                r += '\n';
            });
        }

        r += '🎬 *Movie ON — groups*\n';
        r += '_(daily recap via `/movieon`)_\n\n';

        if (!movieGroups.length) {
            r += '📭 None yet. Use `/movieon` in a group.\n\n';
        } else {
            movieGroups.forEach((group, index) => {
                const members = groupManager.formatMemberCount(memberCounts, group.group_id);
                const trending = group.weekly_trending ? ' · 🔥 Trending ON' : '';
                r += `${index + 1}. *${group.group_name}*\n`;
                r += `   👥 Members: ${members}${trending}\n\n`;
            });
        }

        r += '🧠 *Interview Q ON — groups*\n';
        r += '_(MCQ polls via `/interviewqon` · `/interviewqoff`)_\n\n';
        if (!interviewQGroups.length) {
            r += '📭 None yet. Use `/activate` then `/interviewqon`.\n\n';
        } else {
            interviewQGroups.forEach((group, index) => {
                const members = groupManager.formatMemberCount(memberCounts, group.group_id);
                r += `${index + 1}. *${group.group_name}*\n`;
                r += `   👥 Members: ${members}\n\n`;
            });
        }

        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '💡 `/activate` `/deactivate` · `/newson` `/newsoff`\n';
        r += '💡 `/githubon` `/githuboff` · `/autochat` · `/awesomeon` `/awesomeoff` · `/interviewqon` `/interviewqoff` · `/aiupdateson` `/aiupdatesoff` · `/instaon` `/instaoff` · `/stickeron` `/stickeroff` · `/movieon` `/movieoff` · `/trending on/off` · `/setwc`';

        await sock.sendMessage(chatId, { text: r });
        logger.info(`📋 Group list sent to ${senderPhone}`);
    } catch (error) {
        logger.error(`Error sending group list: ${error.message}`);
    }
}

export async function handleSetWelcome(sock, chatId, senderJid, fullCommand, { groupManager }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        const body = fullCommand.replace(/^\/setwc\s*/i, '').trim();

        let groupName = 'this group';
        try {
            const groupMetadata = await getGroupMeta(sock, chatId, groupManager);
            groupName = groupMetadata.subject || groupName;
        } catch (err) {
            logger.error(`Error fetching group metadata: ${err.message}`);
        }

        const current = await groupManager.getWelcomeConfig(chatId);
        const isOn = Boolean(current);

        if (!body || body.toLowerCase() === 'help' || body.toLowerCase() === 'status') {
            let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            r += '👋 *WELCOME MESSAGE* 👋\n';
            r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
            r += `📢 *Group:* ${groupName}\n`;
            r += `🔘 *Status:* ${formatWelcomeStatus(isOn)}\n\n`;
            r += '*Default (always added):*\n';
            r += `${DEFAULT_HEADER_TEMPLATE.split('{group}').join(groupName)}\n\n`;
            r += '*Set your extra line:*\n';
            r += '`/setwc this group is for stickers`\n\n';
            r += '*Sends as:*\n';
            r += `${previewWelcomeMessage('this group is for stickers', groupName)}\n\n`;
            r += '*Commands:*\n';
            r += '• `/setwc <your text>` — turn ON + set extra line\n';
            r += '• `/setwc on` — turn ON (default header only)\n';
            r += '• `/setwc off` — turn OFF\n';
            r += '• `/setwc` — this status\n\n';

            if (isOn) {
                const custom = current.welcome_message || '(default header only)';
                r += '*Your extra line:*\n';
                r += `${custom}\n\n`;
                r += '*Full preview now:*\n';
                r += `${previewWelcomeMessage(current.welcome_message || '', groupName)}\n\n`;
                if (current.welcome_set_at) {
                    r += `_Updated ${new Date(current.welcome_set_at).toLocaleDateString()}_`;
                }
            } else {
                r += '_Welcome is OFF in this group._';
            }

            await sock.sendMessage(chatId, { text: r });
            return;
        }

        if (body.toLowerCase() === 'off') {
            if (!isOn) {
                await sock.sendMessage(chatId, {
                    text:
                        '━━━━━━━━━━━━━━━━━━━━━━━━━━━\nℹ️ *WELCOME ALREADY OFF* ℹ️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                        `📢 *Group:* ${groupName}\n🔘 *Status:* ${formatWelcomeStatus(false)}\n\n` +
                        'Use `/setwc your message` to enable welcome.',
                });
                return;
            }

            await groupManager.clearWelcomeMessage(chatId);
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n✅ *WELCOME OFF* ✅\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    `📢 *Group:* ${groupName}\n🔘 *Status:* ${formatWelcomeStatus(false)}\n\n` +
                    'New members will not get a welcome message here.',
            });
            logger.info(`👋 Welcome disabled: ${chatId} by ${senderPhone}`);
            return;
        }

        const customPart = body.toLowerCase() === 'on' ? '' : normalizeCustomWelcomePart(body);
        await groupManager.setWelcomeMessage(chatId, groupName, customPart, senderPhone);
        await groupParticipantSnapshot.seedGroup(sock, chatId);
        const preview = previewWelcomeMessage(customPart, groupName);

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '✅ *WELCOME ON* ✅\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += `📢 *Group:* ${groupName}\n`;
        r += `🔘 *Status:* ${formatWelcomeStatus(true)}\n\n`;
        if (customPart) {
            r += `*Your extra line:*\n${customPart}\n\n`;
        }
        r += '*New members will see:*\n';
        r += `${preview}\n\n`;
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '💡 `/setwc off` to disable · `/setwc` for status\n';
        r += '_Welcome messages auto-delete after 2 minutes._';

        await sock.sendMessage(chatId, { text: r });
        logger.info(`👋 Welcome set for ${groupName} (${chatId}) by ${senderPhone}`);
    } catch (error) {
        logger.error(`Error setting welcome message: ${error.message}`);
        await sock.sendMessage(chatId, { text: 'Could not save the welcome message. Try again.' });
    }
}

const INVITE_LINK_BASE = 'https://chat.whatsapp.com/';

async function fetchLiveInviteCode(sock, chatId) {
    try {
        return (await sock.groupInviteCode(chatId)) || '';
    } catch (err) {
        logger.warn(`Group link: live fetch failed for ${chatId}: ${err.message}`);
        return '';
    }
}

async function groupDisplayName(sock, chatId, groupManager) {
    try {
        const meta = await getGroupMeta(sock, chatId, groupManager);
        return meta.subject || 'this group';
    } catch (err) {
        logger.debug(`Group link: could not fetch group name for ${chatId}: ${err.message}`);
        return 'this group';
    }
}

/**
 * `/link` — admins fetch a fresh invite code (and save it for members);
 * anyone in the group can then request the saved link.
 */
export async function handleGroupLink(sock, chatId, senderJid, { groupManager, originalMsg }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        const groupName = await groupDisplayName(sock, chatId, groupManager);
        const isAdmin = await groupManager.isPrivilegedAsync(sock, chatId, senderJid);

        let inviteCode = '';

        // Admins/staff refresh the live invite code and save it for everyone
        if (isAdmin) {
            inviteCode = await fetchLiveInviteCode(sock, chatId);
            if (inviteCode) {
                await groupManager.setGroupInviteCode(chatId, inviteCode, senderPhone);
            }
        }

        // Members (and admin fallback) use the last saved invite code
        if (!inviteCode) {
            inviteCode = await groupManager.getGroupInviteCode(chatId);
        }

        if (!inviteCode) {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                    '🔒 *NO SAVED LINK YET* 🔒\n' +
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'There is no saved invite link for this group yet.\n\n' +
                    (isAdmin
                        ? '_Make sure the bot is a group admin, then try again._'
                        : '_Ask a group admin to run `/link` to save it — then anyone here can get it._'),
            }, { quoted: originalMsg });
            return;
        }

        const link = `${INVITE_LINK_BASE}${inviteCode}`;

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '🔗 *GROUP INVITE LINK* 🔗\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += `📢 *Group:* ${groupName}\n\n`;
        r += `${link}\n\n`;
        r += isAdmin
            ? '_Saved for members — `/revokelink` regenerates it._'
            : '_Saved by an admin. Admins can refresh it with `/link`._';

        await sendTextWithLinkPreview(sock, chatId, r, link, { quoted: originalMsg });
        logger.info(`🔗 Group link served: ${groupName} (${chatId}) by ${senderPhone} (${isAdmin ? 'admin' : 'member'})`);
    } catch (error) {
        logger.error(`Error fetching group link for ${chatId}: ${error.message}`);
        await sock.sendMessage(chatId, {
            text:
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                '❌ *FAILED* ❌\n' +
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                'Could not get the group link. Make sure the bot is a group admin.',
        }, { quoted: originalMsg });
    }
}

/**
 * `/revokelink` — admins regenerate the group invite link, killing the old one.
 */
export async function handleRevokeLink(sock, chatId, senderJid, { groupManager, originalMsg }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        const groupName = await groupDisplayName(sock, chatId, groupManager);

        const inviteCode = await sock.groupRevokeInvite(chatId);
        if (!inviteCode) {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                    '❌ *REVOKE FAILED* ❌\n' +
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'Could not revoke the invite link.\n' +
                    '_Make sure the bot is a group admin._',
            }, { quoted: originalMsg });
            return;
        }

        await groupManager.setGroupInviteCode(chatId, inviteCode, senderPhone);

        const link = `${INVITE_LINK_BASE}${inviteCode}`;

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '🔄 *LINK REVOKED* 🔄\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += `📢 *Group:* ${groupName}\n\n`;
        r += 'The old invite link is dead. New link:\n\n';
        r += `${link}\n\n`;
        r += '_Saved for members — they get this new link with `/link`._';

        await sendTextWithLinkPreview(sock, chatId, r, link, { quoted: originalMsg });
        logger.info(`🔄 Invite link revoked: ${groupName} (${chatId}) by ${senderPhone}`);
    } catch (error) {
        logger.error(`Error revoking group link for ${chatId}: ${error.message}`);
        await sock.sendMessage(chatId, {
            text:
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                '❌ *REVOKE FAILED* ❌\n' +
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                'Could not revoke the invite link. Make sure the bot is a group admin.',
        }, { quoted: originalMsg });
    }
}

export async function handleGroupParticipantsUpdate(sock, update, { groupManager, banDatabase }) {
    try {
        const groupId = update?.id || update?.jid || update?.groupId;
        const action = String(update?.action || '').toLowerCase();
        const participants = update?.participants;

        if (!groupId?.endsWith('@g.us')) {
            return;
        }

        logger.info(`👋 group-participants.update ${action} in ${groupId} (${participants?.length ?? 0})`);

        if (LEAVE_ACTIONS.has(action) || action === 'promote' || action === 'demote') {
            cancelPendingWelcome(groupId);
            await groupParticipantSnapshot.refresh(sock, groupId);
            return;
        }

        if (JOIN_ACTIONS.has(action)) {
            await enforceBansOnJoin(sock, { groupManager, banDatabase }, groupId, participants);
            scheduleWelcomeAfterJoin(sock, groupManager, groupId);
        }
    } catch (error) {
        logger.error(`Welcome message error: ${error.message}`);
    }
}

/**
 * Durable ban enforcement — remove banned members the moment they (re)join.
 * Fail-soft: a ban-check failure must never break welcomes or the snapshot.
 */
export async function enforceBansOnJoin(sock, { groupManager, banDatabase }, groupId, participants = []) {
    if (!banDatabase || !participants?.length) return;
    try {
        const keys = [];
        for (const p of participants) {
            const phone = normalizePhoneNumber(extractPhoneNumber(p?.phoneNumber || p?.pn || p?.id || ''));
            if (phone) keys.push(phone);
            if (p?.id) keys.push(String(p.id));
        }
        if (!keys.length) return;

        const banned = await banDatabase.filterBanned(groupId, keys);
        if (!banned.size) return;

        const toRemove = participants.filter((p) => {
            const phone = normalizePhoneNumber(extractPhoneNumber(p?.phoneNumber || p?.pn || p?.id || ''));
            return (phone && banned.has(phone)) || (p?.id && banned.has(String(p.id)));
        });
        const removeJids = toRemove.map((p) => p.id).filter(Boolean);
        if (!removeJids.length) return;

        try {
            await sock.groupParticipantsUpdate(groupId, removeJids, 'remove');
            logger.warn(`🛡️ Ban enforcement: removed ${removeJids.length} banned member(s) from ${groupId}`);
            await sock.sendMessage(groupId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🛡️ *BAN ENFORCED* 🛡️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    `${removeJids.length} banned member(s) tried to rejoin and were removed.\n\n` +
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━',
            });
        } catch (err) {
            logger.error(`Ban enforcement kick failed in ${groupId}: ${err.message}`);
        }
    } catch (err) {
        logger.error(`Ban enforcement check failed in ${groupId}: ${err.message}`);
    }
}

/**
 * Fallback when join arrives as a system stub message instead of participants.update.
 */
export async function handleJoinStubMessage(sock, msg, { groupManager, banDatabase }) {
    try {
        const groupId = msg?.key?.remoteJid;
        if (!groupId?.endsWith('@g.us')) {
            return;
        }

        const stubType = Number(msg.messageStubType);

        if (LEAVE_STUB_TYPES.has(stubType) || isLeaveStubMessage(msg)) {
            logger.debug(`Leave stub type ${stubType} in ${groupId} — refreshing snapshot`);
            cancelPendingWelcome(groupId);
            await groupParticipantSnapshot.refresh(sock, groupId);
            return;
        }

        if (!JOIN_STUB_TYPES.has(stubType)) {
            return;
        }

        logger.info(`👋 Join stub type ${stubType} in ${groupId}`);

        // Stub joins carry the participant JIDs in messageStubParameters —
        // enforce bans here too so the stub path can't be used to slip past /ban.
        const stubJids = (msg.messageStubParameters || []).filter((p) => String(p).includes('@'));
        if (stubJids.length) {
            await enforceBansOnJoin(sock, { groupManager, banDatabase }, groupId, stubJids.map((j) => ({ id: j })));
        }

        scheduleWelcomeAfterJoin(sock, groupManager, groupId);
    } catch (error) {
        logger.error(`Join stub welcome error: ${error.message}`);
    }
}

function isLeaveStubMessage(msg) {
    const stubType = Number(msg.messageStubType);
    if (JOIN_STUB_TYPES.has(stubType)) {
        return false;
    }

    const params = (msg.messageStubParameters || [])
        .filter((p) => typeof p === 'string')
        .join(' ')
        .toLowerCase();

    return (
        params.includes(' left')
        || params.endsWith(' left')
        || params.includes('removed')
        || params.includes('was removed')
        || params.includes('left the group')
    );
}

export async function handleNewsOn(sock, chatId, senderJid, { groupManager, originalMsg }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        const isActive = await groupManager.isGroupActive(chatId);
        if (!isActive) {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\nℹ️ *GROUP NOT ACTIVATED* ℹ️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'Tech news requires an activated group.\n\nUse `/activate` first, then `/newson`.',
            }, { quoted: originalMsg });
            return;
        }

        let groupName = 'Unknown Group';
        try {
            const meta = await getGroupMeta(sock, chatId, groupManager);
            groupName = meta.subject;
        } catch (err) {
            logger.error(`Error fetching group metadata: ${err.message}`);
        }

        await groupManager.setNewsEnabled(chatId, groupName, true, senderPhone);

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '✅ *TECH NEWS ON* ✅\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += `📢 *Group:* ${groupName}\n\n`;
        r += '📰 This group will receive tech news at *10:00 AM* & *10:00 PM* (IST).\n';
        r += '🎓 Courses continue as normal.\n\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '💡 Use `/newsoff` to stop tech news only';

        await sock.sendMessage(chatId, { text: r }, { quoted: originalMsg });
        logger.info(`📰 Tech news enabled: ${groupName} (${chatId}) by ${senderPhone}`);
    } catch (error) {
        logger.error(`Error enabling tech news: ${error.message}`);
    }
}

export async function handleNewsOff(sock, chatId, senderJid, { groupManager, originalMsg }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        const isActive = await groupManager.isGroupActive(chatId);
        if (!isActive) {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\nℹ️ *GROUP NOT ACTIVATED* ℹ️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'This group is not activated.\n\nUse `/activate` to enable courses and tech news.',
            }, { quoted: originalMsg });
            return;
        }

        const newsEnabled = await groupManager.isNewsEnabled(chatId);
        if (!newsEnabled) {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\nℹ️ *TECH NEWS ALREADY OFF* ℹ️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'Tech news is not enabled in this group.\n\nUse `/newson` to enable it.',
            }, { quoted: originalMsg });
            return;
        }

        let groupName = 'Unknown Group';
        try {
            const meta = await getGroupMeta(sock, chatId, groupManager);
            groupName = meta.subject;
        } catch (err) {
            logger.error(`Error fetching group metadata: ${err.message}`);
        }

        await groupManager.setNewsEnabled(chatId, groupName, false, senderPhone);

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '🛑 *TECH NEWS OFF* 🛑\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += `📢 *Group:* ${groupName}\n\n`;
        r += '📰 Scheduled tech news digests are disabled here.\n';
        r += '🎓 Course updates will continue as normal.\n\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '💡 Use `/newson` to enable again';

        await sock.sendMessage(chatId, { text: r }, { quoted: originalMsg });
        logger.info(`📰 Tech news disabled: ${chatId} by ${senderPhone}`);
    } catch (error) {
        logger.error(`Error disabling tech news: ${error.message}`);
    }
}

export async function handleCoursesOn(sock, chatId, senderJid, { groupManager, originalMsg }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        const isActive = await groupManager.isGroupActive(chatId);
        if (!isActive) {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\nℹ️ *GROUP NOT ACTIVATED* ℹ️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'Courses require an activated group.\n\nUse `/activate` first, then `/courson`.',
            }, { quoted: originalMsg });
            return;
        }

        let groupName = 'Unknown Group';
        try {
            const meta = await getGroupMeta(sock, chatId, groupManager);
            groupName = meta.subject;
        } catch (err) {
            logger.error(`Error fetching group metadata: ${err.message}`);
        }

        await groupManager.setCoursesEnabled(chatId, groupName, true, senderPhone);

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '✅ *COURSES ON* ✅\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += `📢 *Group:* ${groupName}\n\n`;
        r += '🎓 This group will receive free course updates again.\n';
        r += '📰 Tech news is unchanged.\n\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '💡 Use `/coursesoff` to stop courses in this group only';

        await sock.sendMessage(chatId, { text: r }, { quoted: originalMsg });
        logger.info(`🎓 Courses enabled: ${groupName} (${chatId}) by ${senderPhone}`);
    } catch (error) {
        logger.error(`Error enabling courses: ${error.message}`);
    }
}

export async function handleCoursesOff(sock, chatId, senderJid, { groupManager, originalMsg }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        const isActive = await groupManager.isGroupActive(chatId);
        if (!isActive) {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\nℹ️ *GROUP NOT ACTIVATED* ℹ️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'This group is not activated.\n\nUse `/activate` to enable updates.',
            }, { quoted: originalMsg });
            return;
        }

        const coursesEnabled = await groupManager.isCoursesEnabled(chatId);
        if (!coursesEnabled) {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\nℹ️ *COURSES ALREADY OFF* ℹ️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'Courses are not enabled in this group.\n\nUse `/courson` to enable them.',
            }, { quoted: originalMsg });
            return;
        }

        let groupName = 'Unknown Group';
        try {
            const meta = await getGroupMeta(sock, chatId, groupManager);
            groupName = meta.subject;
        } catch (err) {
            logger.error(`Error fetching group metadata: ${err.message}`);
        }

        await groupManager.setCoursesEnabled(chatId, groupName, false, senderPhone);

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '🛑 *COURSES OFF* 🛑\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += `📢 *Group:* ${groupName}\n\n`;
        r += '🎓 Automatic course posts are disabled here.\n';
        r += '📰 Tech news & other features continue if enabled.\n\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '💡 Use `/courson` to enable courses again';

        await sock.sendMessage(chatId, { text: r }, { quoted: originalMsg });
        logger.info(`🎓 Courses disabled: ${chatId} by ${senderPhone}`);
    } catch (error) {
        logger.error(`Error disabling courses: ${error.message}`);
    }
}

export async function handleGithubOn(sock, chatId, senderJid, { groupManager, originalMsg }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        const isActive = await groupManager.isGroupActive(chatId);
        if (!isActive) {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\nℹ️ *GROUP NOT ACTIVATED* ℹ️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'GitHub trending requires an activated group.\n\nUse `/activate` first, then `/githubon`.',
            }, { quoted: originalMsg });
            return;
        }

        let groupName = 'Unknown Group';
        try {
            const meta = await getGroupMeta(sock, chatId, groupManager);
            groupName = meta.subject;
        } catch (err) {
            logger.error(`Error fetching group metadata: ${err.message}`);
        }

        await groupManager.setGithubTrendingEnabled(chatId, groupName, true, senderPhone);

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '✅ *GITHUB TRENDING ON* ✅\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += `📢 *Group:* ${groupName}\n\n`;
        r += '🐙 Daily GitHub picks — *trending, popular & hidden gems* (5 posts).\n';
        r += '🎓 *Saturdays:* college / resume projects only (no awesome lists that day).\n';
        r += '📚 Courses continue as normal.\n\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '💡 Use `/githuboff` to stop GitHub trending only';

        await sock.sendMessage(chatId, { text: r }, { quoted: originalMsg });
        logger.info(`🐙 GitHub trending enabled: ${groupName} (${chatId}) by ${senderPhone}`);
    } catch (error) {
        logger.error(`Error enabling GitHub trending: ${error.message}`);
    }
}

export async function handleGithubOff(sock, chatId, senderJid, { groupManager, originalMsg }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        const isActive = await groupManager.isGroupActive(chatId);
        if (!isActive) {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\nℹ️ *GROUP NOT ACTIVATED* ℹ️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'This group is not activated.\n\nUse `/activate` to enable updates.',
            }, { quoted: originalMsg });
            return;
        }

        const githubEnabled = await groupManager.isGithubTrendingEnabled(chatId);
        if (!githubEnabled) {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\nℹ️ *GITHUB TRENDING ALREADY OFF* ℹ️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'GitHub trending is not enabled in this group.\n\nUse `/githubon` to enable it.',
            }, { quoted: originalMsg });
            return;
        }

        let groupName = 'Unknown Group';
        try {
            const meta = await getGroupMeta(sock, chatId, groupManager);
            groupName = meta.subject;
        } catch (err) {
            logger.error(`Error fetching group metadata: ${err.message}`);
        }

        await groupManager.setGithubTrendingEnabled(chatId, groupName, false, senderPhone);

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '🛑 *GITHUB TRENDING OFF* 🛑\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += `📢 *Group:* ${groupName}\n\n`;
        r += '🐙 Daily GitHub trending posts are disabled here.\n';
        r += '🎓 Course updates will continue as normal.\n\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '💡 Use `/githubon` to enable again';

        await sock.sendMessage(chatId, { text: r }, { quoted: originalMsg });
        logger.info(`🐙 GitHub trending disabled: ${chatId} by ${senderPhone}`);
    } catch (error) {
        logger.error(`Error disabling GitHub trending: ${error.message}`);
    }
}

export async function handleAiUpdatesOn(sock, chatId, senderJid, { groupManager, originalMsg }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        const isActive = await groupManager.isGroupActive(chatId);
        if (!isActive) {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\nℹ️ *GROUP NOT ACTIVATED* ℹ️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'AI updates requires an activated group.\n\nUse `/activate` first, then `/aiupdateson`.',
            }, { quoted: originalMsg });
            return;
        }

        let groupName = 'Unknown Group';
        try {
            const meta = await getGroupMeta(sock, chatId, groupManager);
            groupName = meta.subject;
        } catch (err) {
            logger.error(`Error fetching group metadata: ${err.message}`);
        }

        await groupManager.setAiUpdatesEnabled(chatId, groupName, true, senderPhone);

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '✅ *AI UPDATES ON* ✅\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += `📢 *Group:* ${groupName}\n\n`;
        r += '🤖 5 posts a day — new AI tools, India-specific AI news, and model releases.\n';
        r += 'One headline per post, straight to the point.\n\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '💡 Use `/aiupdatesoff` to stop';

        await sock.sendMessage(chatId, { text: r }, { quoted: originalMsg });
        logger.info(`🤖 AI updates enabled: ${groupName} (${chatId}) by ${senderPhone}`);
    } catch (error) {
        logger.error(`Error enabling AI updates: ${error.message}`);
    }
}

export async function handleAiUpdatesOff(sock, chatId, senderJid, { groupManager, originalMsg }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        const isActive = await groupManager.isGroupActive(chatId);
        if (!isActive) {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\nℹ️ *GROUP NOT ACTIVATED* ℹ️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'This group is not activated.\n\nUse `/activate` to enable updates.',
            }, { quoted: originalMsg });
            return;
        }

        const aiUpdatesEnabled = await groupManager.isAiUpdatesEnabled(chatId);
        if (!aiUpdatesEnabled) {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\nℹ️ *AI UPDATES ALREADY OFF* ℹ️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'AI updates is not enabled in this group.\n\nUse `/aiupdateson` to enable it.',
            }, { quoted: originalMsg });
            return;
        }

        let groupName = 'Unknown Group';
        try {
            const meta = await getGroupMeta(sock, chatId, groupManager);
            groupName = meta.subject;
        } catch (err) {
            logger.error(`Error fetching group metadata: ${err.message}`);
        }

        await groupManager.setAiUpdatesEnabled(chatId, groupName, false, senderPhone);

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '🛑 *AI UPDATES OFF* 🛑\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += `📢 *Group:* ${groupName}\n\n`;
        r += '🤖 Daily AI update posts are disabled here.\n\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '💡 Use `/aiupdateson` to enable again';

        await sock.sendMessage(chatId, { text: r }, { quoted: originalMsg });
        logger.info(`🤖 AI updates disabled: ${chatId} by ${senderPhone}`);
    } catch (error) {
        logger.error(`Error disabling AI updates: ${error.message}`);
    }
}

export async function handleAutoChat(sock, chatId, senderJid, args, { groupManager, autoChatController, originalMsg } = {}) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        const mode = String(args?.[0] || '').toLowerCase();
        const openLabel =
            autoChatController?.openLabel || formatClockLabel(config.AUTOCHAT_OPEN_TIME || DEFAULT_OPEN_TIME);
        const closeLabel =
            autoChatController?.closeLabel || formatClockLabel(config.AUTOCHAT_CLOSE_TIME || DEFAULT_CLOSE_TIME);

        let groupName = 'Unknown Group';
        try {
            const meta = await getGroupMeta(sock, chatId, groupManager);
            groupName = meta.subject || groupName;
        } catch {}

        if (!['on', 'off', 'status'].includes(mode)) {
            const current = groupManager ? await groupManager.isAutoChatEnabled(chatId) : false;
            let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            r += current ? '🔓 *AUTO CHAT ON* 🔓' : '🔒 *AUTO CHAT OFF* 🔒';
            r += '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
            r += `📢 *Group:* ${groupName}\n\n`;
            r += `Bot ${current ? 'opens' : 'will open'} this chat daily at *${openLabel}* `;
            r += `and locks it at *${closeLabel}*.\n\n`;
            r += '💡 `/autochat on` — enable\n';
            r += '💡 `/autochat off` — disable\n';
            r += '💡 `/autochat status` — current state';
            await sock.sendMessage(chatId, { text: r }, { quoted: originalMsg });
            return;
        }

        if (mode === 'status') {
            const current = groupManager ? await groupManager.isAutoChatEnabled(chatId) : false;
            let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            r += current ? '🔓 *AUTO CHAT: ON* 🔓' : '🔒 *AUTO CHAT: OFF* 🔒';
            r += '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
            r += `📢 *Group:* ${groupName}\n\n`;
            r += `🔓 Opens daily at *${openLabel}* — short LLM greeting from the group title/description.\n`;
            r += `🔒 Locks daily at *${closeLabel}* — chat reopens next morning.\n\n`;
            r += '💡 Use `/autochat on` or `/autochat off`';
            await sock.sendMessage(chatId, { text: r }, { quoted: originalMsg });
            logger.info(`🔓 Auto chat status: ${chatId} by ${senderPhone}`);
            return;
        }

        const turningOn = mode === 'on';
        if (groupManager) {
            await groupManager.setAutoChatEnabled(chatId, groupName, turningOn, senderPhone);
        }

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += turningOn ? '✅ *AUTO CHAT ON* ✅' : '🛑 *AUTO CHAT OFF* 🛑';
        r += '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += `📢 *Group:* ${groupName}\n\n`;

        if (turningOn) {
            if (config.AUTOCHAT_ENABLED === false) {
                r += '⚠️ Auto chat is globally disabled in the bot env (`AUTOCHAT_ENABLED=false`).\n';
                r += 'It is saved here, but no open/close will run until that is enabled.\n\n';
            } else if (!autoChatController) {
                r += '⚠️ Auto chat service is not available yet — try again in a minute.\n\n';
            } else {
                const aligned = await autoChatController.alignGroupToSchedule(sock, chatId);
                if (aligned === 'opened') {
                    r += '🌅 *Opened now* — the greeting is on its way.\n';
                } else if (aligned === 'already-open') {
                    r += '✔️ Chat is already open for today.\n';
                } else if (aligned === 'closed') {
                    r += `🌙 Chat is *locked* until the ${openLabel} open.\n`;
                } else if (aligned === 'already-closed') {
                    r += `✔️ Chat is already locked — opens at ${openLabel}.\n`;
                } else {
                    r += '✔️ Schedule saved — transitions run automatically.\n';
                }
                r += '\n';
            }
            r += `🔓 Daily open at *${openLabel}* — short LLM greeting from the group title/description.\n`;
            r += `🔒 Daily close at *${closeLabel}* — chat locks until next morning.\n\n`;
            r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            r += '⚠️ Bot must be a *group admin* to lock/unlock the chat.\n';
            r += '💡 Use `/autochat off` to stop';
        } else {
            r += 'No more daily auto open/close here. The chat is left as it is right now.\n\n';
            r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            r += '💡 Use `/autochat on` to enable again';
        }

        await sock.sendMessage(chatId, { text: r }, { quoted: originalMsg });
        logger.info(`🔓 Auto chat ${turningOn ? 'enabled' : 'disabled'}: ${chatId} by ${senderPhone}`);
    } catch (error) {
        logger.error(`Error toggling auto chat: ${error.message}`);
    }
}

export async function handleAwesomeOn(sock, chatId, senderJid, { groupManager, originalMsg }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        const isActive = await groupManager.isGroupActive(chatId);
        if (!isActive) {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\nℹ️ *GROUP NOT ACTIVATED* ℹ️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'Awesome lists require an activated group.\n\nUse `/activate` first, then `/awesomeon`.',
            }, { quoted: originalMsg });
            return;
        }

        let groupName = 'Unknown Group';
        try {
            const meta = await getGroupMeta(sock, chatId, groupManager);
            groupName = meta.subject;
        } catch (err) {
            logger.error(`Error fetching group metadata: ${err.message}`);
        }

        await groupManager.setAwesomeListsEnabled(chatId, groupName, true, senderPhone);

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '✅ *AWESOME LISTS ON* ✅\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += `📢 *Group:* ${groupName}\n\n`;
        r += '⭐ Daily *awesome-* list picks — one random list per slot (times offset from GitHub).\n';
        r += '🐙 GitHub trending continues on its own schedule.\n\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '💡 Use `/awesomeoff` to stop awesome lists only';

        await sock.sendMessage(chatId, { text: r }, { quoted: originalMsg });
        logger.info(`⭐ Awesome lists enabled: ${groupName} (${chatId}) by ${senderPhone}`);
    } catch (error) {
        logger.error(`Error enabling awesome lists: ${error.message}`);
    }
}

export async function handleAwesomeOff(sock, chatId, senderJid, { groupManager, originalMsg }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        const isActive = await groupManager.isGroupActive(chatId);
        if (!isActive) {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\nℹ️ *GROUP NOT ACTIVATED* ℹ️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'This group is not activated.\n\nUse `/activate` to enable updates.',
            }, { quoted: originalMsg });
            return;
        }

        const enabled = await groupManager.isAwesomeListsEnabled(chatId);
        if (!enabled) {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\nℹ️ *AWESOME LISTS ALREADY OFF* ℹ️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'Awesome lists are not enabled in this group.\n\nUse `/awesomeon` to enable it.',
            }, { quoted: originalMsg });
            return;
        }

        let groupName = 'Unknown Group';
        try {
            const meta = await getGroupMeta(sock, chatId, groupManager);
            groupName = meta.subject;
        } catch (err) {
            logger.error(`Error fetching group metadata: ${err.message}`);
        }

        await groupManager.setAwesomeListsEnabled(chatId, groupName, false, senderPhone);

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '🛑 *AWESOME LISTS OFF* 🛑\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += `📢 *Group:* ${groupName}\n\n`;
        r += '⭐ Daily awesome-list posts are disabled here.\n';
        r += '🐙 GitHub trending will continue if enabled.\n\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '💡 Use `/awesomeon` to enable again';

        await sock.sendMessage(chatId, { text: r }, { quoted: originalMsg });
        logger.info(`⭐ Awesome lists disabled: ${chatId} by ${senderPhone}`);
    } catch (error) {
        logger.error(`Error disabling awesome lists: ${error.message}`);
    }
}

export async function handleMovieOn(sock, chatId, senderJid, { groupManager }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        let groupName = 'Unknown Group';
        try {
            const meta = await getGroupMeta(sock, chatId, groupManager);
            groupName = meta.subject;
        } catch {}

        await groupManager.setMovieEnabled(chatId, groupName, true, senderPhone);

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '✅ *MOVIE FEATURES ON* ✅\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += `📢 *Group:* ${groupName}\n\n`;
        r += '🎬 Movie search is now enabled here!\n';
        r += '📊 Daily movie recap at *11:55 PM* IST\n\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '💡 Use `/movie <name>` to search\n';
        r += '💡 Use `/movieoff` to disable\n';
        r += '💡 Use `/trending on` for weekly trending';
        await sock.sendMessage(chatId, { text: r });
        logger.info(`🎬 Movie enabled: ${groupName} (${chatId}) by ${senderPhone}`);
    } catch (error) {
        logger.error(`Error enabling movie: ${error.message}`);
    }
}

export async function handleMovieOff(sock, chatId, senderJid, { groupManager }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        const wasEnabled = await groupManager.isMovieEnabled(chatId);
        if (!wasEnabled) {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\nℹ️ *MOVIE ALREADY OFF* ℹ️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'Movie features are not enabled in this group.\nUse `/movieon` to enable.',
            });
            return;
        }

        let groupName = 'Unknown Group';
        try {
            const meta = await getGroupMeta(sock, chatId, groupManager);
            groupName = meta.subject;
        } catch {}

        await groupManager.setMovieEnabled(chatId, groupName, false, senderPhone);
        await sock.sendMessage(chatId, {
            text:
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🛑 *MOVIE FEATURES OFF* 🛑\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                `📢 *Group:* ${groupName}\n\n` +
                'Movie search and daily recaps are disabled.\nUse `/movieon` to enable again.',
        });
        logger.info(`🎬 Movie disabled: ${chatId} by ${senderPhone}`);
    } catch (error) {
        logger.error(`Error disabling movie: ${error.message}`);
    }
}

export async function handleSummaryOn(sock, chatId, senderJid, { groupManager, groupChatLogService }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        let groupName = 'Unknown Group';
        try {
            const meta = await getGroupMeta(sock, chatId, groupManager);
            groupName = meta.subject;
        } catch {}

        await groupManager.setSummaryEnabled(chatId, groupName, true, senderPhone);
        if (groupChatLogService) {
            await groupChatLogService.refreshEnabledGroups();
        }

        const recapTime = config.GROUP_SUMMARY_TIME || '00:00';
        const recapLabel = recapTime === '00:00' ? '12:00 AM (midnight)' : recapTime;
        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '✅ *GROUP DAY RECAP ON* ✅\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += `📢 *Group:* ${groupName}\n\n`;
        r += '🗓️ Member messages are logged through the day (IST).\n';
        r += `🕐 Recap posts at *${recapLabel}* — covers that calendar day.\n\n`;
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '💡 Use `/summaryoff` to disable\n';
        r += '💡 Movie search recap (`/movieon`) is separate';

        await sock.sendMessage(chatId, { text: r });
        logger.info(`🗓️ Group recap enabled: ${groupName} (${chatId}) by ${senderPhone}`);
    } catch (error) {
        logger.error(`Error enabling group recap: ${error.message}`);
    }
}

export async function handleSummaryOff(sock, chatId, senderJid, { groupManager, groupChatLogService }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        const wasEnabled = await groupManager.isSummaryEnabled(chatId);
        if (!wasEnabled) {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\nℹ️ *GROUP RECAP OFF* ℹ️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'Daily group recap is not enabled here.\nUse `/summaryon` to enable.',
            });
            return;
        }

        let groupName = 'Unknown Group';
        try {
            const meta = await getGroupMeta(sock, chatId, groupManager);
            groupName = meta.subject;
        } catch {}

        await groupManager.setSummaryEnabled(chatId, groupName, false, senderPhone);
        if (groupChatLogService) {
            await groupChatLogService.refreshEnabledGroups();
        }

        await sock.sendMessage(chatId, {
            text:
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🛑 *GROUP DAY RECAP OFF* 🛑\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                `📢 *Group:* ${groupName}\n\n` +
                'No more daily chat recaps will be posted here.\nUse `/summaryon` to enable again.',
        });
        logger.info(`🗓️ Group recap disabled: ${chatId} by ${senderPhone}`);
    } catch (error) {
        logger.error(`Error disabling group recap: ${error.message}`);
    }
}

export async function handleSummaryNow(sock, chatId, senderJid, { groupManager, groupSummaryController }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        const enabled = await groupManager.isSummaryEnabled(chatId);
        if (!enabled) {
            await sock.sendMessage(chatId, {
                text: 'ℹ️ Group recap is not enabled here. Use `/summaryon` first.',
            });
            return;
        }

        if (!groupSummaryController) {
            await sock.sendMessage(chatId, { text: '❌ Recap service not available.' });
            return;
        }

        await sock.sendMessage(chatId, { text: '🗓️ _Generating recap…_' });

        const dateStr = getYesterdayDateStrIST();
        await groupSummaryController.postRecapForGroup(sock, chatId, { dateStr, force: true });
        logger.info(`🗓️ Manual recap triggered in ${chatId} by ${senderPhone} for ${dateStr}`);
    } catch (error) {
        logger.error(`Error running manual recap: ${error.message}`);
        const msg = /timeout/i.test(error.message)
            ? '❌ Recap timed out. Try again — prompt size is now capped. Remove NVIDIA_TIMEOUT_MS=900000 from Render if set.'
            : `❌ Recap failed: ${error.message}`;
        await sock.sendMessage(chatId, { text: msg }).catch(() => {});
    }
}

export async function handleTrending(sock, chatId, senderJid, args, { groupManager }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        const action = (args[0] || '').toLowerCase();

        let groupName = 'Unknown Group';
        try {
            const meta = await getGroupMeta(sock, chatId, groupManager);
            groupName = meta.subject;
        } catch {}

        const currentlyOn = await groupManager.isWeeklyTrendingEnabled(chatId);

        if (!action || action === 'status') {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🔥 *WEEKLY TRENDING* 🔥\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    `📢 *Group:* ${groupName}\n` +
                    `🔘 *Status:* ${currentlyOn ? '✅ ON' : '❌ OFF'}\n\n` +
                    'Posts top 10 trending movies every *Sunday 12 PM* IST\n\n' +
                    '*Commands:*\n' +
                    '• `/trending on` — enable\n' +
                    '• `/trending off` — disable\n\n' +
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━',
            });
            return;
        }

        if (action === 'on') {
            if (currentlyOn) {
                await sock.sendMessage(chatId, { text: 'ℹ️ Weekly trending is already *ON* in this group.' });
                return;
            }
            await groupManager.setWeeklyTrendingEnabled(chatId, groupName, true, senderPhone);
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n✅ *WEEKLY TRENDING ON* ✅\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    `📢 *Group:* ${groupName}\n\n` +
                    '🔥 Top 10 trending movies will be posted every *Sunday 12 PM* IST\n\n' +
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                    '💡 Use `/trending off` to disable',
            });
            logger.info(`🔥 Trending enabled: ${groupName} (${chatId}) by ${senderPhone}`);
        } else if (action === 'off') {
            if (!currentlyOn) {
                await sock.sendMessage(chatId, { text: 'ℹ️ Weekly trending is already *OFF* in this group.' });
                return;
            }
            await groupManager.setWeeklyTrendingEnabled(chatId, groupName, false, senderPhone);
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🛑 *WEEKLY TRENDING OFF* 🛑\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    `📢 *Group:* ${groupName}\n\n` +
                    'Weekly trending posts are disabled.\n\n' +
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                    '💡 Use `/trending on` to enable again',
            });
            logger.info(`🔥 Trending disabled: ${chatId} by ${senderPhone}`);
        } else {
            await sock.sendMessage(chatId, { text: '❌ Usage: `/trending on` or `/trending off`' });
        }
    } catch (error) {
        logger.error(`Error handling trending toggle: ${error.message}`);
    }
}
