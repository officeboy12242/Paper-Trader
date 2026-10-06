/**
 * Admin group message deletion: /dellast, /del, /delall
 */

import { logger } from '../../utils/logger.js';
import {
    buildQuotedTargetMessage,
    getSafeSendOptions,
    resolveConversationChatId,
    safeDeleteMessage,
} from '../../utils/waMessage.js';
import { groupMessageTracker } from '../../utils/groupMessageTracker.js';

const DELETE_DELAY_MS = 350;
/** Max messages deleted per `/dellast N` (matches tracker capacity). */
const MAX_BATCH = 500;

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseBatchCount(rawArg) {
    if (!rawArg) {
        return null;
    }
    const trimmed = String(rawArg).trim().toLowerCase();
    if (trimmed === 'all') {
        return 'all';
    }
    const digits = trimmed.match(/^(\d{1,4})/);
    if (!digits) {
        return null;
    }
    const n = parseInt(digits[1], 10);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function buildDeleteKey(chatId, key) {
    const groupJid = resolveConversationChatId({ remoteJid: chatId }) || chatId;
    const remoteJid = resolveConversationChatId(key) || key.remoteJid || groupJid;
    const fromMe = Boolean(key.fromMe);

    const deleteKey = {
        remoteJid,
        id: key.id,
        fromMe,
    };

    if (!fromMe) {
        const participant = key.participant || key.participantLid || key.participantPn;
        if (participant) {
            deleteKey.participant = participant;
        }
    }

    return deleteKey;
}

function usageText() {
    return (
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
        '🗑️ *DELETE MESSAGES* 🗑️\n' +
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
        '*Commands (group admins):*\n' +
        '• `/dellast <number>` — delete the most recent N tracked messages (e.g. `/dellast 20`)\n' +
        '• `/dellast all` or `/delall` — delete all tracked messages (up to 500)\n' +
        '• Reply to a message + `/del` — delete that one message only\n\n' +
        '_Bot must be a WhatsApp group admin._\n' +
        '_Tracks member + bot messages since the last restart (up to 500 per group)._'
    );
}

async function tryDelete(sock, chatId, key) {
    if (!sock?.sendMessage || !key?.id) {
        return false;
    }

    const groupJid = resolveConversationChatId({ remoteJid: chatId }) || chatId;
    const deleteKey = buildDeleteKey(groupJid, key);

    const attempts = fromMeDeleteAttempts(groupJid, deleteKey);
    for (const attempt of attempts) {
        try {
            await sock.sendMessage(attempt.jid, { delete: attempt.key });
            return true;
        } catch (err) {
            logger.debug(`Delete failed for ${deleteKey.id} via ${attempt.jid}: ${err.message}`);
        }
    }

    try {
        await safeDeleteMessage(sock, groupJid, deleteKey);
        return true;
    } catch {
        return false;
    }
}

function fromMeDeleteAttempts(groupJid, deleteKey) {
    const attempts = [];
    const seen = new Set();

    const add = (jid, key) => {
        const j = jid || '';
        const sig = `${j}:${key.id}:${key.fromMe}:${key.participant || ''}`;
        if (!j || seen.has(sig)) {
            return;
        }
        seen.add(sig);
        attempts.push({ jid: j, key });
    };

    add(groupJid, deleteKey);
    if (deleteKey.remoteJid && deleteKey.remoteJid !== groupJid) {
        add(deleteKey.remoteJid, deleteKey);
    }

    if (deleteKey.fromMe) {
        add(groupJid, { remoteJid: groupJid, id: deleteKey.id, fromMe: true });
    }

    return attempts;
}

async function deleteKeys(sock, chatId, entries) {
    let deleted = 0;
    let failed = 0;
    const removedIds = [];

    for (const entry of entries) {
        const ok = await tryDelete(sock, chatId, entry.key);
        if (ok) {
            deleted++;
            removedIds.push(entry.key.id);
        } else {
            failed++;
        }
        await delay(DELETE_DELAY_MS);
    }

    if (removedIds.length) {
        groupMessageTracker.removeByIds(chatId, removedIds);
    }

    return { deleted, failed };
}

export async function handleDelLast(sock, chatId, args, originalMsg, { fullCommand, groupManager } = {}) {
    const sendOpts = getSafeSendOptions(originalMsg);
    const trackerChatId = resolveConversationChatId(originalMsg?.key) || chatId;

    if (!trackerChatId?.endsWith('@g.us')) {
        await sock.sendMessage(chatId, { text: '❌ This command works only in groups.' }, sendOpts);
        return;
    }

    const botAdmin = groupManager
        ? await groupManager.isBotGroupAdminAsync(sock, trackerChatId)
        : false;

    if (!botAdmin) {
        logger.warn(`Bot admin check negative for ${chatId} — attempting delete anyway`);
    }

    const cmdName = String(fullCommand || '').trim().split(/\s+/)[0]?.toLowerCase().replace(/^\//, '').split('@')[0];
    let rawArg = args[0]?.toLowerCase();
    if (!rawArg && cmdName === 'delall') {
        rawArg = 'all';
    }

    const batchCount = parseBatchCount(rawArg);
    const quoted = buildQuotedTargetMessage(originalMsg);

    // Reply + /del (no number) = single-message delete only
    if (quoted?.key?.id && batchCount == null) {
        const ok = await tryDelete(sock, trackerChatId, quoted.key);
        if (ok) {
            groupMessageTracker.removeByIds(trackerChatId, [quoted.key.id]);
            await sock.sendMessage(chatId, { text: '🗑️ Message deleted.' }, sendOpts);
        } else {
            await sock.sendMessage(chatId, {
                text:
                    '❌ Could not delete that message.\n\n' +
                    '_Ensure the bot is promoted to group admin and has permission to delete messages._',
            }, sendOpts);
        }
        return;
    }

    if (batchCount == null) {
        await sock.sendMessage(chatId, { text: usageText() }, sendOpts);
        return;
    }

    const isAll = batchCount === 'all';
    const commandMsgId = originalMsg?.key?.id;
    const tracked = groupMessageTracker.countBefore(trackerChatId, commandMsgId);

    if (!tracked) {
        logger.warn(
            `DelLast: no tracked messages for ${trackerChatId} ` +
            `(raw=${originalMsg?.key?.remoteJid || 'n/a'}, total=${groupMessageTracker.count(trackerChatId)})`
        );
        await sock.sendMessage(chatId, {
            text:
                '📭 No tracked messages to delete in this group.\n\n' +
                '_The bot only tracks messages received after it starts/restarts (up to 500)._',
        }, sendOpts);
        return;
    }

    const take = isAll ? tracked : Math.min(batchCount, MAX_BATCH);

    const entries = isAll
        ? groupMessageTracker.getRecentBefore(trackerChatId, tracked, commandMsgId)
        : groupMessageTracker.getRecentBefore(trackerChatId, take, commandMsgId);

    if (!entries.length) {
        await sock.sendMessage(chatId, { text: '📭 Nothing to delete.' }, sendOpts);
        return;
    }

    const status = await sock.sendMessage(chatId, {
        text: `⏳ Deleting *${entries.length}* message(s)...`,
    }, sendOpts);

    const { deleted, failed } = await deleteKeys(sock, trackerChatId, entries);

    let result =
        `🗑️ *Delete done*\n\n` +
        `✅ Deleted: *${deleted}*\n`;
    if (failed) {
        result += `❌ Failed: *${failed}*\n`;
        if (!botAdmin) {
            result += '\n_If nothing deleted, promote the bot to group admin._';
        } else {
            result += '\n_Some messages may be too old or already removed._';
        }
    }
    if (isAll && tracked > entries.length) {
        result += `\n_Note: only messages tracked since the last bot restart are removed._`;
    }

    try {
        if (status?.key) {
            await safeDeleteMessage(sock, chatId, status.key);
        }
    } catch { /* ignore */ }

    await sock.sendMessage(chatId, { text: result }, sendOpts);
    logger.info(
        `DelLast in ${trackerChatId}: mode=${isAll ? 'all' : take}, ` +
            `requested=${take}, deleted=${deleted}, failed=${failed}, botAdmin=${botAdmin}`
    );
}
