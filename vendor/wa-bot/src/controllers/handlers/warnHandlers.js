/**
 * Group warning handlers: /warn, /mywarns, /warns, /clearwarns
 */

import { jidNormalizedUser } from 'baileys';
import { logger } from '../../utils/logger.js';
import { extractPhoneNumber, normalizePhoneNumber } from '../../utils/permissions.js';
import {
    resolveTargetParticipant,
    resolveJidToPhone,
    hasModerationTarget,
    getQuotedPushName,
    getSafeSendOptions,
} from '../../utils/waMessage.js';

export const MAX_WARNS = 5;

function memberKeyFromTarget({ phone, jid }) {
    const normalized = normalizePhoneNumber(phone);
    if (normalized) {
        return normalized;
    }
    return jid || '';
}

function formatWarnDate(date) {
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

function buildWarnListMessage({ title, count, max, warns, memberLabel }) {
    let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    r += `${title}\n`;
    r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
    if (memberLabel) {
        r += `👤 *Member:* ${memberLabel}\n`;
    }
    r += `⚠️ *Warnings:* ${count}/${max}\n\n`;

    if (!warns.length) {
        r += '✅ No warnings on record in this group.\n';
    } else {
        warns.forEach((w, i) => {
            const by = w.warned_by_phone ? `+${w.warned_by_phone}` : 'Admin';
            r += `*${i + 1}.* ${w.reason}\n`;
            r += `   _By ${by} · ${formatWarnDate(w.created_at)}_\n\n`;
        });
    }

    r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━';
    return r;
}

async function resolveMemberDisplay(sock, chatId, target, waMessage, groupManager, userManager) {
    const participant = await findParticipantRecord(sock, chatId, target.jid, target.phone, groupManager);

    const possibleJids = [];
    if (target.jid) possibleJids.push(target.jid);
    if (participant?.id) possibleJids.push(participant.id);
    if (participant?.lid) possibleJids.push(participant.lid);
    if (participant?.pn) possibleJids.push(participant.pn);
    if (participant?.phoneNumber) possibleJids.push(participant.phoneNumber);
    if (target.phone) {
        possibleJids.push(`${target.phone}@s.whatsapp.net`);
        possibleJids.push(`${target.phone}@lid`);
    }

    let displayName = getQuotedPushName(waMessage);
    if (!displayName && userManager) {
        displayName = await userManager.resolveUserName(possibleJids);
    }
    if (!displayName && target.phone) {
        displayName = target.phone;
    }
    if (!displayName) {
        displayName = 'Member';
    }

    const mentionJid =
        participant?.lid ||
        participant?.id ||
        target.jid ||
        (target.phone ? `${target.phone}@s.whatsapp.net` : '');

    return { displayName, mentionJid };
}

function memberLine(displayName) {
    return `@${displayName}`;
}

async function sendWithMention(sock, chatId, text, mentionJid, quoted) {
    const payload = { text };
    if (mentionJid) {
        payload.mentions = [mentionJid];
    }
    await sock.sendMessage(chatId, payload, getSafeSendOptions(quoted));
}

async function findParticipantRecord(sock, chatId, jid, phone, groupManager) {
    try {
        const meta = await groupManager.getGroupMetadataCached(sock, chatId);
        for (const p of meta.participants || []) {
            const pPhone = normalizePhoneNumber(extractPhoneNumber(p.phoneNumber || p.pn || p.id || ''));
            const matchJid =
                jid &&
                (p.id === jid || p.lid === jid || p.pn === jid || p.phoneNumber === jid);
            const matchPhone = phone && pPhone && pPhone === normalizePhoneNumber(phone);
            if (matchJid || matchPhone) {
                return p;
            }
        }
    } catch (err) {
        logger.error(`findParticipantRecord: ${err.message}`);
    }
    return null;
}

export async function isTargetGroupAdmin(sock, chatId, jid, phone, groupManager) {
    const participant = await findParticipantRecord(sock, chatId, jid, phone, groupManager);
    if (participant) {
        return participant.admin === 'admin' || participant.admin === 'superadmin';
    }
    if (phone) {
        return groupManager.isGroupAdmin(sock, chatId, phone);
    }
    return false;
}

export async function kickFromGroup(sock, chatId, jid, phone, groupManager) {
    const participant = await findParticipantRecord(sock, chatId, jid, phone, groupManager);
    const kickJid = participant?.id || jid;
    if (!kickJid || !sock?.groupParticipantsUpdate) {
        return { ok: false, reason: 'no_jid' };
    }

    // Bot-admin preflight. The local participant scan can miss the bot in
    // LID-addressed groups (roster entry may expose only the LID, no phone),
    // producing a false "bot is not admin" — GroupManager.isBotGroupAdmin
    // also matches via creds.me.lid, so treat it as the authoritative retry.
    const botJid = jidNormalizedUser(sock.user?.id?.split(':')[0] || '');
    const botParticipant = await findParticipantRecord(sock, chatId, botJid, '', groupManager);
    const botIsAdmin =
        botParticipant?.admin === 'admin' || botParticipant?.admin === 'superadmin' ||
        (await groupManager?.isBotGroupAdminAsync?.(sock, chatId)) === true;
    if (!botIsAdmin) {
        return { ok: false, reason: 'bot_not_admin' };
    }

    try {
        const results = await sock.groupParticipantsUpdate(chatId, [kickJid], 'remove');
        // Baileys returns per-participant status codes — surface real failures
        // (401 not-authorized / 403 forbidden) instead of reporting success.
        const status = Array.isArray(results)
            ? String(results.find((r) => r?.jid === kickJid || !r?.jid)?.status || '200')
            : '200';
        if (status === '401' || status === '403') {
            logger.warn(`Kick rejected for ${kickJid} in ${chatId} (status=${status})`);
            return { ok: false, reason: status === '403' ? 'bot_not_admin' : 'kick_failed', error: `status ${status}` };
        }
        return { ok: true };
    } catch (err) {
        logger.error(`Failed to kick ${kickJid} from ${chatId}: ${err.message}`);
        return { ok: false, reason: 'kick_failed', error: err.message };
    }
}

export async function handleWarn(sock, chatId, senderJid, args, waMessage, ctx) {
    const { groupManager, warnDatabase, userManager, originalMsg } = ctx;

    if (!warnDatabase) {
        logger.error('/warn: warnDatabase not initialized');
        return;
    }

    try {
        const phoneInFirstArg = args[0]?.replace(/\D/g, '').length >= 10;
        const reasonArgs = phoneInFirstArg && !hasModerationTarget(waMessage, senderJid, []) ? args.slice(1) : args;
        const reason = reasonArgs.join(' ').trim();
        if (!reason) {
            await sock.sendMessage(
                chatId,
                {
                    text:
                        '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n❌ *USAGE* ❌\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                        'Reply to a message, @tag someone, or include a phone number.\n\n' +
                        '*Examples:*\n' +
                        '• Reply + `/warn Spamming links`\n' +
                        '• `/warn @user Off-topic posts`\n' +
                        '• `/warn 919876543210 Repeated violations`',
                },
                { quoted: originalMsg },
            );
            return;
        }

        const target = await resolveTargetParticipant(sock, chatId, args, waMessage, senderJid);
        if (!target?.jid && !target?.phone) {
            await sock.sendMessage(
                chatId,
                {
                    text:
                        '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n❌ *NO TARGET* ❌\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                        'Reply to a member, @tag them, or pass a phone number.',
                },
                { quoted: originalMsg },
            );
            return;
        }

        const botJid = jidNormalizedUser(sock.user?.id?.split(':')[0] || '');
        if (
            target.jid === senderJid ||
            target.jid === botJid ||
            (target.phone && normalizePhoneNumber(target.phone) === normalizePhoneNumber(extractPhoneNumber(senderJid)))
        ) {
            await sock.sendMessage(
                chatId,
                {
                    text:
                        '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n❌ *INVALID TARGET* ❌\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                        'You cannot warn yourself or the bot.',
                },
                { quoted: originalMsg },
            );
            return;
        }

        if (await isTargetGroupAdmin(sock, chatId, target.jid, target.phone, groupManager)) {
            await sock.sendMessage(
                chatId,
                {
                    text:
                        '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n❌ *PROTECTED* ❌\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                        'Group admins cannot be warned.',
                },
                { quoted: originalMsg },
            );
            return;
        }

        const memberKey = memberKeyFromTarget(target);
        if (!memberKey) {
            await sock.sendMessage(
                chatId,
                {
                    text:
                        '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n❌ *INVALID TARGET* ❌\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                        'Could not identify that member.',
                },
                { quoted: originalMsg },
            );
            return;
        }

        const senderPhone = extractPhoneNumber(senderJid) || (await resolveJidToPhone(sock, chatId, senderJid));
        const { count } = await warnDatabase.addWarn({
            groupId: chatId,
            memberKey,
            memberPhone: target.phone,
            memberJid: target.jid,
            reason,
            warnedByPhone: senderPhone.replace(/\D/g, ''),
            warnedByJid: senderJid,
        });

        const { displayName, mentionJid } = await resolveMemberDisplay(
            sock, chatId, target, waMessage, groupManager, userManager,
        );

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '⚠️ *MEMBER WARNED* ⚠️\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += `👤 *Member:* ${memberLine(displayName)}\n`;
        r += `📝 *Reason:* ${reason}\n`;
        r += `🔢 *Warnings:* ${count}/${MAX_WARNS}\n\n`;

        if (count >= MAX_WARNS) {
            const kick = await kickFromGroup(sock, chatId, target.jid, target.phone, groupManager);
            if (kick.ok) {
                r += '🚫 *Auto-kicked* — reached 5 warnings.\n';
                logger.info(`🚫 Auto-kicked ${displayName} from ${chatId} (${count} warns)`);
            } else if (kick.reason === 'bot_not_admin') {
                r += '⚠️ *Limit reached* but bot is not a group admin — could not kick.\n';
            } else {
                r += '⚠️ *Limit reached* but kick failed. Remove them manually.\n';
            }
        } else {
            r += `_${MAX_WARNS - count} warning(s) left before auto-kick._\n`;
        }

        r += '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━';
        await sendWithMention(sock, chatId, r, mentionJid, originalMsg);
        logger.info(`⚠️ Warned ${displayName} in ${chatId} (${count}/${MAX_WARNS}) by ${senderPhone}`);
    } catch (error) {
        logger.error(`Error in /warn: ${error.message}`);
    }
}

async function resolveWarnSubject(sock, chatId, senderJid, args, waMessage, allowOtherTarget) {
    if (allowOtherTarget) {
        const target = await resolveTargetParticipant(sock, chatId, args, waMessage, senderJid);
        if (target?.jid || target?.phone) {
            return target;
        }
    }

    const phone = await resolveJidToPhone(sock, chatId, senderJid);
    return {
        jid: senderJid,
        phone: phone.replace(/\D/g, ''),
    };
}

export async function handleMyWarns(sock, chatId, senderJid, ctx) {
    const { warnDatabase, originalMsg } = ctx;

    try {
        const subject = await resolveWarnSubject(sock, chatId, senderJid, [], null, false);
        const memberKey = memberKeyFromTarget(subject);
        const [count, warns] = await Promise.all([
            warnDatabase.countWarns(chatId, memberKey),
            warnDatabase.getWarns(chatId, memberKey),
        ]);

        const text = buildWarnListMessage({
            title: '⚠️ *YOUR WARNINGS* ⚠️',
            count,
            max: MAX_WARNS,
            warns,
        });

        await sock.sendMessage(chatId, { text }, { quoted: originalMsg });
    } catch (error) {
        logger.error(`Error in /mywarns: ${error.message}`);
    }
}

export async function handleWarns(sock, chatId, senderJid, args, waMessage, ctx) {
    const { warnDatabase, groupManager, userManager, originalMsg } = ctx;

    try {
        const hasTarget = hasModerationTarget(waMessage, senderJid, args);
        const subject = await resolveWarnSubject(sock, chatId, senderJid, args, waMessage, hasTarget);
        const memberKey = memberKeyFromTarget(subject);
        const [count, warns] = await Promise.all([
            warnDatabase.countWarns(chatId, memberKey),
            warnDatabase.getWarns(chatId, memberKey),
        ]);

        const { displayName, mentionJid } = await resolveMemberDisplay(
            sock, chatId, subject, waMessage, groupManager, userManager,
        );
        const text = buildWarnListMessage({
            title: '⚠️ *MEMBER WARNINGS* ⚠️',
            count,
            max: MAX_WARNS,
            warns,
            memberLabel: memberLine(displayName),
        });

        await sendWithMention(sock, chatId, text, mentionJid, originalMsg);
    } catch (error) {
        logger.error(`Error in /warns: ${error.message}`);
    }
}

export async function handleClearWarns(sock, chatId, senderJid, args, waMessage, ctx) {
    const { warnDatabase, groupManager, userManager, originalMsg } = ctx;

    try {
        const target = await resolveTargetParticipant(sock, chatId, args, waMessage, senderJid);
        if (!target?.jid && !target?.phone) {
            await sock.sendMessage(
                chatId,
                {
                    text:
                        '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n❌ *USAGE* ❌\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                        'Reply to a member, @tag them, or pass a phone number.\n\n' +
                        '*Example:* Reply + `/clearwarns`',
                },
                { quoted: originalMsg },
            );
            return;
        }

        const memberKey = memberKeyFromTarget(target);
        const removed = await warnDatabase.clearWarns(chatId, memberKey);
        const { displayName, mentionJid } = await resolveMemberDisplay(
            sock, chatId, target, waMessage, groupManager, userManager,
        );

        const text =
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n✅ *WARNS CLEARED* ✅\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
            `👤 *Member:* ${memberLine(displayName)}\n` +
            `🗑️ *Removed:* ${removed} warning(s)\n\n` +
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━';

        await sendWithMention(sock, chatId, text, mentionJid, originalMsg);
        logger.info(`🗑️ Cleared ${removed} warn(s) for ${displayName} in ${chatId}`);
    } catch (error) {
        logger.error(`Error in /clearwarns: ${error.message}`);
    }
}
