/**
 * Owner commands to manage Drive scrape source URLs (Render instances).
 */

import { pronoobDriveService } from '../../services/PronoobDriveService.js';

function usageText() {
    return (
        '┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n' +
        '┃   🌐 *DRIVE SOURCE URLS*   ┃\n' +
        '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n' +
        '*Commands:*\n' +
        '• `/driveurl add <url> [srv-id] [api-key]` — add Render base URL\n' +
        '• `/driveurl remove <#>` — remove by list number\n' +
        '• `/driveurl list` — show all sources\n' +
        '• `/driveurl test` — health-check all sources\n\n' +
        '_Add optional Render service ID + API key to show bandwidth in test._\n' +
        '_Bot rotates sources one-by-one and uses the first that responds._\n\n' +
        '*Example:*\n' +
        '`/driveurl add https://pronoobdrive-7w2p.onrender.com srv-xxxxx`'
    );
}

export async function handleDriveUrl(sock, chatId, senderJid, args, { isOwnerFromJid, originalMsg }) {
    const isOwner = await isOwnerFromJid(sock, chatId, senderJid);
    if (!isOwner) {
        await sock.sendMessage(chatId, { text: '❌ Only owners can manage Drive sources.' }, { quoted: originalMsg });
        return;
    }

    const action = (args[0] || '').toLowerCase();
    const rest = args.slice(1);

    if (!action || action === 'help') {
        await sock.sendMessage(chatId, { text: usageText() }, { quoted: originalMsg });
        return;
    }

    if (action === 'add') {
        const raw = rest.join(' ').trim();
        if (!raw) {
            await sock.sendMessage(chatId, {
                text: '❌ Provide a URL.\n\n_Example: `/driveurl add https://your-app.onrender.com srv-xxxxx`_',
            }, { quoted: originalMsg });
            return;
        }

        try {
            const { added, urls } = await pronoobDriveService.addUrl(raw);
            if (!added) {
                await sock.sendMessage(chatId, { text: 'ℹ️ That URL is already in the list.' }, { quoted: originalMsg });
                return;
            }
            await sock.sendMessage(chatId, {
                text: `✅ Drive source added.\n\n📋 *Total:* ${urls.length}\n🌐 ${urls[urls.length - 1]}`,
            }, { quoted: originalMsg });
        } catch (err) {
            await sock.sendMessage(chatId, { text: `❌ ${err.message}` }, { quoted: originalMsg });
        }
        return;
    }

    if (action === 'remove' || action === 'rm' || action === 'delete') {
        const idx = parseInt(rest[0], 10);
        if (!Number.isFinite(idx)) {
            await sock.sendMessage(chatId, {
                text: '❌ Provide list number to remove.\n\n_Use `/driveurl list` to see numbers._',
            }, { quoted: originalMsg });
            return;
        }

        try {
            const { removed, urls } = await pronoobDriveService.removeUrl(idx);
            await sock.sendMessage(chatId, {
                text: `✅ Removed:\n🌐 ${removed}\n\n📋 *Remaining:* ${urls.length}`,
            }, { quoted: originalMsg });
        } catch (err) {
            await sock.sendMessage(chatId, { text: `❌ ${err.message}` }, { quoted: originalMsg });
        }
        return;
    }

    if (action === 'list' || action === 'ls') {
        await pronoobDriveService.loadUrls();
        const sources = pronoobDriveService.getSources();
        let text = '┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n';
        text += '┃   🌐 *DRIVE SOURCE URLS*   ┃\n';
        text += '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n';

        if (!sources.length) {
            text += '📭 No custom sources — using default.\n';
        } else {
            sources.forEach((source, i) => {
                text += `*${i + 1}.* ${source.url}`;
                if (source.renderServiceId) {
                    text += `\n   🆔 ${source.renderServiceId}`;
                }
                if (source.renderApiKey) {
                    text += '\n   🔑 Render API key configured';
                }
                text += '\n';
            });
        }

        text += '\n_Rotation: one source per search, skips dead ones._';
        await sock.sendMessage(chatId, { text }, { quoted: originalMsg });
        return;
    }

    if (action === 'test' || action === 'check' || action === 'ping') {
        await sock.sendMessage(chatId, { text: '⏳ Testing all Drive sources...' }, { quoted: originalMsg });
        const results = await pronoobDriveService.testAllSources();

        let text = '┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n';
        text += '┃   🩺 *DRIVE SOURCE TEST*   ┃\n';
        text += '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n';

        if (!results.length) {
            text += '📭 No sources configured.';
        } else {
            for (const r of results) {
                text += `${r.ok ? '🟢' : '🔴'} *${r.index}.* ${r.url}`;
                if (r.bandwidthText) {
                    text += `\n   📊 BW: ${r.bandwidthText} this month`;
                } else if (r.renderServiceId && r.ok) {
                    text += '\n   📊 BW: unavailable';
                } else if (!r.renderServiceId && r.ok) {
                    text += '\n   📊 BW: add srv-id to track';
                }
                text += '\n';
            }
        }

        await sock.sendMessage(chatId, { text }, { quoted: originalMsg });
        return;
    }

    await sock.sendMessage(chatId, { text: usageText() }, { quoted: originalMsg });
}
