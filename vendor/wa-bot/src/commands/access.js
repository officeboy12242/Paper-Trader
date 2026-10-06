/**
 * Central permission checks for registry-defined commands.
 */

import { isGroupMessage, extractPhoneNumber } from '../utils/permissions.js';

/**
 * @param {import('baileys').WASocket} sock
 * @param {string} chatId
 * @param {string} senderJid
 * @param {import('./registry.js').CommandDefinition} def
 * @param {import('../models/GroupManager.js')} groupManager
 * @returns {Promise<{ ok: true } | { ok: false, message: string }>}
 */
export async function checkCommandAccess(sock, chatId, senderJid, def, groupManager) {
    const inGroup = isGroupMessage(chatId);

    if (def.scope === 'group_only' && !inGroup) {
        return {
            ok: false,
            message:
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                '❌ *GROUPS ONLY* ❌\n' +
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                'This command works only in a group chat.',
        };
    }

    if (def.scope === 'dm_only' && inGroup) {
        return {
            ok: false,
            message:
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                '❌ *DM ONLY* ❌\n' +
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                'Use this command in a private chat with the bot.',
        };
    }

    if (def.role === 'staff') {
        const allowed = await groupManager.isStaffAsync(sock, chatId, senderJid);
        if (!allowed) {
            return {
                ok: false,
                message:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                    '🔒 *PERMISSION DENIED* 🔒\n' +
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'Only owners, moderators, bot admins, or WhatsApp group admins can use this command.',
            };
        }
    }

    if (def.role === 'welcome_setters') {
        const [privileged, canManage] = await Promise.all([
            groupManager.isPrivilegedAsync(sock, chatId, senderJid),
            groupManager.canManageBotAdminsAsync(senderJid),
        ]);
        if (!privileged && !canManage) {
            return {
                ok: false,
                message:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                    '🔒 *PERMISSION DENIED* 🔒\n' +
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'Only owners, moderators, bot admins, or WhatsApp group admins can set welcome messages.',
            };
        }
    }

    if (def.role === 'admin_managers') {
        const allowed = await groupManager.canManageBotAdminsAsync(senderJid);
        if (!allowed) {
            return {
                ok: false,
                message:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                    '🔒 *PERMISSION DENIED* 🔒\n' +
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'Only owners, moderators, or bot admins can add/remove bot admins.',
            };
        }
    }

    if (def.role === 'group_admins') {
        const allowed = await groupManager.isSenderGroupAdminAsync(sock, chatId, senderJid);
        if (!allowed) {
            return {
                ok: false,
                message:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                    '🔒 *PERMISSION DENIED* 🔒\n' +
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'Only WhatsApp group admins in this group can use this command.',
            };
        }
    }

    if (def.role === 'admins') {
        const allowed = await groupManager.isPrivilegedAsync(sock, chatId, senderJid);
        if (!allowed) {
            return {
                ok: false,
                message:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                    '🔒 *PERMISSION DENIED* 🔒\n' +
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'Only owners, bot admins, or WhatsApp group admins (in this group) can use this command.',
            };
        }
    }

    if (def.role === 'owner') {
        const senderPhone = extractPhoneNumber(senderJid);
        if (groupManager.isOwner(senderPhone)) {
            return { ok: true };
        }
        // LID owners: O(1) lookup through the cached phoneByKey index rather than
        // scanning every participant (900+ iterations per command in big groups).
        if (senderJid?.includes('@lid') && chatId?.endsWith('@g.us')) {
            try {
                const phone = await groupManager.resolveParticipantPhoneCached(
                    sock,
                    chatId,
                    senderJid
                );
                if (phone && groupManager.isOwner(phone)) {
                    return { ok: true };
                }
            } catch {
                // fall through
            }
        }
        return {
            ok: false,
            message:
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                '🔒 *OWNER ONLY* 🔒\n' +
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                'Only bot owners can use this command.',
        };
    }

    return { ok: true };
}
