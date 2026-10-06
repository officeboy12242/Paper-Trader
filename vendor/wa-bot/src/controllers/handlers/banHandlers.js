/**
 * Group moderation handlers: /kick, /ban, /unban, /banlist
 *
 * Targets work exactly like /warn: reply to a message, @tag the member, or
 * pass a phone number. Bans are per group and durable — banned members who
 * rejoin are auto-removed again by the group-participants hook.
 */

import { logger } from '../../utils/logger.js';
import { extractPhoneNumber, normalizePhoneNumber } from '../../utils/permissions.js';
import { resolveTargetParticipant, resolveJidToPhone, getSafeSendOptions } from '../../utils/waMessage.js';
import { kickFromGroup, isTargetGroupAdmin } from './warnHandlers.js';

function memberKeyFromTarget({ phone, jid }) {
    const normalized = normalizePhoneNumber(phone);
    return normalized || jid || '';
}

async function sendBox(sock, chatId, lines, mentionJid, quoted) {
    let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    r += `${lines.header}\n`;
    r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
    r += lines.body;
    r += '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━';

    const payload = { text: r };
    if (mentionJid) payload.mentions = [mentionJid];
    await sock.sendMessage(chatId, payload, getSafeSendOptions(quoted));
}

function fmtDate(date) {
    try {
        return new Date(date).toLocaleString('en-IN', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    } catch {
        return String(date);
    }
}

/** Bot's own participant JID for self-target checks. */
function botJidOf(sock) {
    return sock?.user?.id ? String(sock.user.id).split(':')[0] : '';
}

/**
 * Shared moderation preflight: resolve target, block self/bot/admin targets.
 * @returns {{ ok: true, target: object } | { ok: false }}
 */
async function resolveModerationTarget(sock, chatId, senderJid, args, waMessage, ctx, verb) {
    const { groupManager, originalMsg } = ctx;

    const target = await resolveTargetParticipant(sock, chatId, args, waMessage, senderJid);
    if (!target?.jid && !target?.phone) {
        await sock.sendMessage(
            chatId,
            {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n❌ *NO TARGET* ❌\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    `Reply to a member, @tag them, or pass a phone number.\n\n*Example:* Reply + \`/${verb}\``,
            },
            { quoted: originalMsg },
        );
        return { ok: false };
    }

    const botJid = botJidOf(sock);
    const botPhone = botJid ? normalizePhoneNumber(botJid.split('@')[0]) : '';

    // Resolve REAL phones through participant records — LID privacy makes raw
    // JID/phone comparisons unreliable (mention reports the LID, sender is PN).
    const targetRecord = await findParticipantRecord(sock, chatId, target.jid, target.phone, groupManager);
    const senderRecord = await findParticipantRecord(sock, chatId, senderJid, extractPhoneNumber(senderJid), groupManager);
    const targetReal =
        normalizePhoneNumber(targetRecord?.phoneNumber || targetRecord?.pn || '') ||
        normalizePhoneNumber(target.phone);
    const senderReal =
        normalizePhoneNumber(senderRecord?.phoneNumber || senderRecord?.pn || '') ||
        normalizePhoneNumber(extractPhoneNumber(senderJid));

    if (
        target.jid === senderJid ||
        target.jid === botJid ||
        (targetReal && senderReal && targetReal === senderReal) ||
        (targetReal && botPhone && targetReal === botPhone)
    ) {
        await sendBox(sock, chatId, {
            header: `❌ *INVALID TARGET* ❌`,
            body: `You cannot ${verb} yourself or the bot.`,
        }, '', originalMsg);
        return { ok: false };
    }

    if (await isTargetGroupAdmin(sock, chatId, target.jid, target.phone, groupManager)) {
        await sendBox(sock, chatId, {
            header: `❌ *PROTECTED* ❌`,
            body: 'Group admins cannot be moderated by the bot.',
        }, '', originalMsg);
        return { ok: false };
    }

    return { ok: true, target };
}

/** Resolve display name + mention JID via the warnHandlers display path. */
async function displayFor(sock, chatId, target, waMessage, ctx) {
    const { userManager } = ctx;
    const participant = await findParticipantRecord(sock, chatId, target.jid, target.phone, ctx.groupManager);

    let displayName = '';
    if (userManager?.resolveUserName) {
        const possible = [target.jid, participant?.id, participant?.lid, participant?.pn, participant?.phoneNumber]
            .filter(Boolean);
        displayName = await userManager.resolveUserName(possible);
    }
    if (!displayName && target.phone) displayName = target.phone;

    const mentionJid =
        participant?.lid || participant?.id || target.jid ||
        (target.phone ? `${target.phone}@s.whatsapp.net` : '');

    return { displayName: displayName || 'Member', mentionJid };
}

async function findParticipantRecord(sock, chatId, jid, phone, groupManager) {
    try {
        const meta = await groupManager.getGroupMetadataCached(sock, chatId);
        for (const p of meta.participants || []) {
            const pPhone = normalizePhoneNumber(extractPhoneNumber(p.phoneNumber || p.pn || p.id || ''));
            const matchJid =
                jid && (p.id === jid || p.lid === jid || p.pn === jid || p.phoneNumber === jid);
            const matchPhone = phone && pPhone && pPhone === normalizePhoneNumber(phone);
            if (matchJid || matchPhone) return p;
        }
    } catch (err) {
        logger.debug(`findParticipantRecord: ${err.message}`);
    }
    return null;
}

/**
 * Kick + report. Returns true when the member is out of the group.
 */
async function kickAndReport(sock, chatId, target, ctx, verbLabel) {
    const kick = await kickFromGroup(sock, chatId, target.jid, target.phone, ctx.groupManager);
    if (!kick.ok && kick.reason === 'bot_not_admin') {
        await sendBox(sock, chatId, {
            header: '⚠️ *BOT NOT ADMIN* ⚠️',
            body: 'I need to be a *group admin* to remove members.',
        }, '', ctx.originalMsg);
        return false;
    }
    if (!kick.ok) {
        await sendBox(sock, chatId, {
            header: '⚠️ *REMOVE FAILED* ⚠️',
            body: `Could not ${verbLabel.toLowerCase()} that member. They may already be gone.`,
        }, '', ctx.originalMsg);
        return false;
    }
    return true;
}

/**
 * Resolve the member's REAL phone digits for a durable ban key. LID-privacy
 * members resolve through the participant record; falls back to target.phone.
 */
async function durableBanKey(sock, chatId, target, groupManager) {
    const record = await findParticipantRecord(sock, chatId, target.jid, target.phone, groupManager);
    const realPhone =
        normalizePhoneNumber(record?.phoneNumber || record?.pn || '') ||
        normalizePhoneNumber(target.phone);
    return {
        memberKey: realPhone || target.jid || '',
        memberPhone: realPhone,
        memberJid: record?.id || target.jid || '',
    };
}

/**
 * /kick — remove a member now (no ban).
 * Reply + `/kick spam`, `/kick @user`, `/kick 9198…`
 */
export async function handleKick(sock, chatId, senderJid, args, waMessage, ctx) {
    try {
        const resolved = await resolveModerationTarget(sock, chatId, senderJid, args, waMessage, ctx, 'kick');
        if (!resolved.ok) return;

        const { target } = resolved;
        const { displayName, mentionJid } = await displayFor(sock, chatId, target, waMessage, ctx);
        const out = await kickAndReport(sock, chatId, target, ctx, 'Kick');
        if (!out) return;

        await sendBox(sock, chatId, {
            header: '🚪 *MEMBER KICKED* 🚪',
            body: `👤 *Member:* @${displayName}\n\n_They can rejoin via invite link._`,
        }, mentionJid, ctx.originalMsg);
        logger.info(`🚪 Kicked ${displayName} from ${chatId}`);
    } catch (error) {
        logger.error(`Error in /kick: ${error.message}`);
    }
}

/**
 * /ban — kick AND blacklist from this group.
 */
export async function handleBan(sock, chatId, senderJid, args, waMessage, ctx) {
    const { banDatabase, originalMsg } = ctx;

    if (!banDatabase) {
        logger.error('/ban: banDatabase not initialized');
        return;
    }

    try {
        const resolved = await resolveModerationTarget(sock, chatId, senderJid, args, waMessage, ctx, 'ban');
        if (!resolved.ok) return;

        const { target } = resolved;
        const { memberKey, memberPhone, memberJid } = await durableBanKey(sock, chatId, target, ctx.groupManager);
        if (!memberKey) {
            await sendBox(sock, chatId, {
                header: '❌ *INVALID TARGET* ❌',
                body: 'Could not identify that member.',
            }, '', originalMsg);
            return;
        }

        const { displayName, mentionJid } = await displayFor(sock, chatId, target, waMessage, ctx);
        const out = await kickAndReport(sock, chatId, target, ctx, 'Ban');
        if (!out) return;

        const senderPhone = extractPhoneNumber(senderJid) || (await resolveJidToPhone(sock, chatId, senderJid));
        const reason = args.join(' ').trim() || 'Banned by group admin';
        const { existed } = await banDatabase.addBan({
            groupId: chatId,
            memberKey,
            memberPhone,
            memberJid,
            reason,
            bannedByPhone: String(senderPhone).replace(/\D/g, ''),
            bannedByJid: senderJid,
        });

        await sendBox(sock, chatId, {
            header: '🔨 *MEMBER BANNED* 🔨',
            body:
                `👤 *Member:* @${displayName}\n` +
                `📝 *Reason:* ${reason}\n\n` +
                (existed
                    ? '_They were already on the ban list — refreshed._\n'
                    : '') +
                '_If they rejoin, the bot will remove them again._',
        }, mentionJid, originalMsg);
        logger.info(`🔨 Banned ${displayName} (${memberKey}) from ${chatId} by ${senderPhone}`);
    } catch (error) {
        logger.error(`Error in /ban: ${error.message}`);
    }
}

/**
 * /unban — remove a member from this group's ban list.
 */
export async function handleUnban(sock, chatId, senderJid, args, waMessage, ctx) {
    const { banDatabase, originalMsg } = ctx;

    if (!banDatabase) {
        logger.error('/unban: banDatabase not initialized');
        return;
    }

    try {
        const resolved = await resolveModerationTarget(sock, chatId, senderJid, args, waMessage, ctx, 'unban');
        if (!resolved.ok) return;

        const { target } = resolved;
        const { memberKey } = await durableBanKey(sock, chatId, target, ctx.groupManager);
        const { displayName, mentionJid } = await displayFor(sock, chatId, target, waMessage, ctx);

        // Try the durable phone key, then raw JID variants (member may have left).
        let removed = await banDatabase.removeBan(chatId, memberKey);
        if (!removed && target.jid && target.jid !== memberKey) {
            removed = await banDatabase.removeBan(chatId, target.jid);
        }
        const phoneKey = memberKeyFromTarget(target);
        if (!removed && phoneKey && phoneKey !== memberKey) {
            removed = await banDatabase.removeBan(chatId, phoneKey);
        }

        await sendBox(sock, chatId, {
            header: removed ? '✅ *MEMBER UNBANNED* ✅' : 'ℹ️ *NOT ON BAN LIST* ℹ️',
            body: removed
                ? `👤 *Member:* @${displayName}\n\n_They can join this group again._`
                : `@${displayName} is not on this group's ban list.`,
        }, mentionJid, originalMsg);
        logger.info(`✅ Unbanned ${displayName} in ${chatId} (removed=${removed})`);
    } catch (error) {
        logger.error(`Error in /unban: ${error.message}`);
    }
}

/**
 * /banlist — show this group's banned members.
 */
export async function handleBanList(sock, chatId, senderJid, args, waMessage, ctx) {
    const { banDatabase, groupManager, userManager, originalMsg } = ctx;

    if (!banDatabase) {
        logger.error('/banlist: banDatabase not initialized');
        return;
    }

    try {
        const bans = await banDatabase.listBans(chatId, 50);
        if (!bans.length) {
            await sendBox(sock, chatId, {
                header: '🛡️ *BAN LIST* 🛡️',
                body: 'No banned members in this group.',
            }, '', originalMsg);
            return;
        }

        const lines = [];
        for (const b of bans) {
            let label = b.member_phone ? `+${b.member_phone}` : b.member_jid;
            if (!label) {
                const key = String(b.member_key || '');
                label = /^\d+$/.test(key) ? `+${key}` : key || 'Unknown';
            }
            if (userManager?.resolveUserName && (b.member_jid || b.member_phone)) {
                const resolved = await userManager.resolveUserName(
                    [b.member_jid, b.member_phone ? `${b.member_phone}@s.whatsapp.net` : ''].filter(Boolean),
                );
                if (resolved) label = resolved;
            }
            const by = b.banned_by_phone ? `+${b.banned_by_phone}` : 'Admin';
            lines.push(`*•* ${label}\n   _${b.reason} · by ${by} · ${fmtDate(b.banned_at)}_`);
        }

        await sendBox(sock, chatId, {
            header: `🛡️ *BAN LIST* (${bans.length})`,
            body: `${lines.join('\n')}\n\n_Use \`/unban\` (reply/@tag/phone) to remove._`,
        }, '', originalMsg);
    } catch (error) {
        logger.error(`Error in /banlist: ${error.message}`);
    }
}
