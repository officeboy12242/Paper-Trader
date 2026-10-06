/**
 * Owner-only /cmdlog — recent command usage: who ran what, where (group or DM).
 * Reads from the in-memory bot telemetry feed (and Mongo-persisted events via
 * hydrateToday), so it survives redeploys within the 14-day TTL window.
 */

import { botTelemetry } from '../../utils/botTelemetry.js';
import { extractPhoneNumber, isGroupMessage } from '../../utils/permissions.js';
import { plainSendMessage } from '../../utils/waMessage.js';

const DEFAULT_LIMIT = 15;
const MAX_LIMIT = 50;

function formatTimeIST(iso) {
    try {
        return new Date(iso).toLocaleTimeString('en-IN', {
            timeZone: 'Asia/Kolkata',
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
        });
    } catch {
        return '--:--';
    }
}

function displayName(ev) {
    if (ev.pushName) return ev.pushName;
    const phone = ev.senderJid ? extractPhoneNumber(ev.senderJid) : '';
    return phone || 'unknown';
}

function shortPhone(ev) {
    const phone = ev.senderJid ? extractPhoneNumber(ev.senderJid) : '';
    return phone ? ` (${phone.slice(0, 2)}…${phone.slice(-3)})` : '';
}

export async function handleCmdLog(sock, chatId, args, ctx) {
    const limit = Math.min(
        Math.max(parseInt(args[0], 10) || DEFAULT_LIMIT, 1),
        MAX_LIMIT,
    );
    const filterCmd = args.slice(1).join(' ').trim().toLowerCase().replace(/^\//, '');

    const events = botTelemetry
        .recent(300)
        .filter((ev) => ev.type === 'command')
        .filter((ev) => !filterCmd || String(ev.cmd || '').toLowerCase() === filterCmd)
        .slice(0, limit);

    if (events.length === 0) {
        await plainSendMessage(sock, chatId, {
            text: filterCmd
                ? `📋 No \`/${filterCmd}\` usage found in the recent log.`
                : '📋 No command usage logged yet.',
        });
        return;
    }

    // Resolve group titles once per chat (groupManager uses a metadata cache).
    const groupNameCache = new Map();
    const lines = [];
    for (const ev of events) {
        const time = formatTimeIST(ev.at);
        const user = `${displayName(ev)}${shortPhone(ev)}`;
        const cmd = String(ev.cmd || 'unknown');
        const statusMark = ev.status === 'err' ? ' ❌' : '';
        let where;
        if (isGroupMessage(ev.chatId)) {
            if (!groupNameCache.has(ev.chatId)) {
                groupNameCache.set(
                    ev.chatId,
                    await ctx.groupManager.getGroupSubject(sock, ev.chatId),
                );
            }
            where = `📢 ${groupNameCache.get(ev.chatId)}`;
        } else {
            where = '💬 DM';
        }
        lines.push(`🕐 ${time} · 👤 ${user} · /${cmd}${statusMark}\n   ${where}`);
    }

    const header = `📋 *COMMAND LOG* — last ${lines.length}${filterCmd ? ` of \`/${filterCmd}\`` : ''}\n`;
    await plainSendMessage(sock, chatId, {
        text: header + '────────────────────\n' + lines.join('\n') + '\n\n_Usage: /cmdlog [count] [command] — e.g. /cmdlog 30 scalp_',
    });
}

