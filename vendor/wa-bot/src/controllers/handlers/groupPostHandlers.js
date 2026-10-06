/**
 * Owner-only group post handler — posts a message inside WhatsApp groups the
 * bot participates in. Kept after the member-DM broadcast subsystem was
 * removed; group selection uses the live participating-group list from the
 * socket, so nothing depends on scraped member data.
 */

import { logger } from '../../utils/logger.js';
import { resolvePostMessage } from '../../utils/waMessage.js';

const GROUPPOST_CMDS = ['grouppost', 'groupmsg'];
const GROUP_POST_DELAY_MS = 2500;

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(err) {
    if (!err) {
        return 'Unknown error';
    }
    if (typeof err === 'string') {
        return err;
    }
    return err.message || err.output?.payload?.message || String(err);
}

function resolveSock(getSock, fallbackSock) {
    return (typeof getSock === 'function' ? getSock() : null) || fallbackSock;
}

/** Every group the bot is currently in, sorted by name. */
async function fetchParticipatingGroups(sock) {
    if (!sock?.groupFetchAllParticipating) {
        return [];
    }
    try {
        const participating = await sock.groupFetchAllParticipating();
        return Object.entries(participating)
            .map(([groupId, meta]) => ({
                group_id: groupId,
                group_name: meta.subject || 'Unknown Group',
                member_count: meta.participants?.length ?? meta.size ?? 0,
            }))
            .sort((a, b) => a.group_name.localeCompare(b.group_name));
    } catch (err) {
        logger.error(`Failed to list participating groups: ${err.message}`);
        return [];
    }
}

export async function handleGroupPost(sock, chatId, senderJid, args, { isOwnerFromJid, getSock, originalMsg, fullCommand }) {
    try {
        const isOwner = await isOwnerFromJid(sock, chatId, senderJid);
        if (!isOwner) {
            await sock.sendMessage(chatId, { text: '❌ Only bot owners can post to groups.' }, { quoted: originalMsg });
            return;
        }

        const firstArg = args[0]?.toLowerCase();
        const isAll = firstArg === 'all';
        const message = resolvePostMessage(
            fullCommand || '',
            GROUPPOST_CMDS,
            isAll ? { type: 'all' } : { type: 'index' },
            originalMsg,
        ).trim();

        const groups = await fetchParticipatingGroups(sock);
        if (!groups.length) {
            await sock.sendMessage(chatId, { text: '📭 No groups found that the bot is in.' }, { quoted: originalMsg });
            return;
        }

        if (isAll) {
            if (!message) {
                await sock.sendMessage(chatId, {
                    text:
                        '❌ Usage: `/grouppost all <message>`\n\n' +
                        'Posts the same message in every group the bot is in.\n' +
                        'Multiline format is kept. Or *reply* to a message with `/grouppost all`.',
                }, { quoted: originalMsg });
                return;
            }

            await sock.sendMessage(chatId, {
                text:
                    `📤 Posting to *${groups.length}* group(s)...\n\n` +
                    '_Running in background — other bot commands keep working._',
            }, { quoted: originalMsg });

            void runGroupPostAllJob(getSock, sock, chatId, groups, message).catch((err) => {
                logger.error(`Grouppost-all job error: ${formatError(err)}`);
            });
            return;
        }

        const groupIndex = parseInt(args[0], 10);

        if (!Number.isFinite(groupIndex) || groupIndex < 1 || !message) {
            const list = groups
                .map((g, i) => `*${i + 1}.* ${g.group_name} (${g.member_count})`)
                .join('\n');
            await sock.sendMessage(chatId, {
                text:
                    '❌ Usage:\n' +
                    '• `/grouppost <group#> <message>`\n' +
                    '• `/grouppost all <message>`\n\n' +
                    'Multiline format is kept. Or *reply* to a message with `/grouppost <#>`.\n' +
                    'Posts in the WhatsApp group (everyone including LID users).\n\n' +
                    `*Groups (${groups.length}):*\n${list}`,
            }, { quoted: originalMsg });
            return;
        }

        const selected = groups[groupIndex - 1];
        if (!selected) {
            await sock.sendMessage(chatId, {
                text: `❌ Invalid group number. Choose 1–${groups.length}.`,
            }, { quoted: originalMsg });
            return;
        }

        await sock.sendMessage(selected.group_id, { text: message });
        await sock.sendMessage(chatId, {
            text: `✅ Posted to group *${selected.group_name}*.\n\n_All members in that group can see it._`,
        }, { quoted: originalMsg });

        logger.info(`Group post sent to ${selected.group_name} (${selected.group_id})`);
    } catch (err) {
        logger.error(`Group post failed: ${formatError(err)}`);
        await sock.sendMessage(chatId, {
            text: `❌ Group post failed: ${formatError(err)}`,
        }, { quoted: originalMsg });
    }
}

async function runGroupPostAllJob(getSock, fallbackSock, chatId, groups, message) {
    let sent = 0;
    let failed = 0;
    const failedNames = [];

    try {
        for (const group of groups) {
            const sock = resolveSock(getSock, fallbackSock);
            if (!sock) {
                throw new Error('WhatsApp disconnected during group post');
            }

            try {
                await sock.sendMessage(group.group_id, { text: message });
                sent++;
                logger.info(`Grouppost-all sent to ${group.group_name}`);
            } catch (err) {
                failed++;
                failedNames.push(group.group_name);
                logger.warn(`Grouppost-all failed for ${group.group_name}: ${formatError(err)}`);
            }

            await delay(GROUP_POST_DELAY_MS);
        }

        const notifySock = resolveSock(getSock, fallbackSock);
        if (notifySock) {
            let text =
                `✅ Grouppost-all done\n\n` +
                `📤 Posted: *${sent}* / ${groups.length}\n` +
                `❌ Failed: *${failed}*`;
            if (failedNames.length) {
                text += `\n\n_Failed:_ ${failedNames.slice(0, 8).join(', ')}`;
                if (failedNames.length > 8) text += ` +${failedNames.length - 8} more`;
            }
            await notifySock.sendMessage(chatId, { text });
        }
    } catch (err) {
        logger.error(`Grouppost-all job failed: ${formatError(err)}`);
    }
}
