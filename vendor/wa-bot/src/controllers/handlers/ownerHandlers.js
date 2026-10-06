/**
 * Owner-only handlers: premium, moderator, channel management
 */

import { logger } from '../../utils/logger.js';
import { extractPhoneNumber } from '../../utils/permissions.js';
import { resolveTargetPhone } from '../../utils/waMessage.js';
import { config } from '../../config/config.js';

export async function handleAddPremium(sock, chatId, senderJid, args, quotedMessage, { groupManager, isOwnerFromJid }) {
    const isOwner = await isOwnerFromJid(sock, chatId, senderJid);
    if (!isOwner) {
        await sock.sendMessage(chatId, { text: '❌ Only owners can manage premium users.' });
        return;
    }
    const targetPhone = await resolveTargetPhone(sock, chatId, args, quotedMessage, senderJid);
    if (!targetPhone) {
        await sock.sendMessage(chatId, { text: '❌ Specify a phone number, @tag someone, or reply to their message.\n\n_Example: `/addpremium 919876543210`_' });
        return;
    }
    const result = await groupManager.addPremiumUser(targetPhone, extractPhoneNumber(senderJid));
    if (result.ok) {
        const targetJid = `${result.phone_number}@s.whatsapp.net`;
        const groupAnnounce =
            '┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n' +
            '┃   ⭐ *PREMIUM UPGRADE!* ⭐    ┃\n' +
            '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n' +
            `🎉 @${result.phone_number} has been upgraded to *Premium*!\n\n` +
            '🎬 Unlimited movie searches unlocked\n' +
            '🚀 No daily limits anymore\n' +
            '─────────────────────────────\n' +
            '_Upgraded by owner_ 👑';
        await sock.sendMessage(chatId, { text: groupAnnounce, mentions: [targetJid] });

        const dmText =
            '┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n' +
            '┃  ⭐ *CONGRATULATIONS!* ⭐   ┃\n' +
            '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n' +
            "🎉 You've been upgraded to *Premium Member*!\n\n" +
            '✅ *What you get:*\n' +
            '• 🎬 *Unlimited* movie searches (no daily limit)\n' +
            '• ⚡ Priority access to all features\n' +
            '• 🌟 Premium badge on your profile\n\n' +
            '─────────────────────────────\n' +
            'Try it now → `/movie Avengers`\n' +
            '─────────────────────────────\n' +
            '_Thank you for being awesome!_ 🤖⭐';
        try { await sock.sendMessage(targetJid, { text: dmText }); } catch {}
    } else if (result.reason === 'already') {
        await sock.sendMessage(chatId, { text: `ℹ️ ${result.phone_number} is already a premium user.` });
    } else {
        await sock.sendMessage(chatId, { text: '❌ Invalid phone number.' });
    }
}

export async function handleRemovePremium(sock, chatId, senderJid, args, quotedMessage, { groupManager, isOwnerFromJid }) {
    const isOwner = await isOwnerFromJid(sock, chatId, senderJid);
    if (!isOwner) {
        await sock.sendMessage(chatId, { text: '❌ Only owners can manage premium users.' });
        return;
    }
    const targetPhone = await resolveTargetPhone(sock, chatId, args, quotedMessage, senderJid);
    if (!targetPhone) {
        await sock.sendMessage(chatId, { text: '❌ Specify a phone number, @tag someone, or reply to their message.\n\n_Example: `/removepremium 919876543210`_' });
        return;
    }
    const result = await groupManager.removePremiumUser(targetPhone);
    if (result.ok) {
        const targetJid = `${result.phone_number}@s.whatsapp.net`;
        await sock.sendMessage(chatId, {
            text: `⭐ *Premium revoked* for @${result.phone_number}\n\n🎬 Back to 5 daily movie searches.`,
            mentions: [targetJid],
        });
        const dmText =
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n⭐ *Premium Status Update*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
            'Your premium membership has been removed.\n🎬 You now have *5 free searches/day*.\n💡 Contact the owner to renew!\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━';
        try { await sock.sendMessage(targetJid, { text: dmText }); } catch {}
    } else if (result.reason === 'not_found') {
        await sock.sendMessage(chatId, { text: 'ℹ️ That user is not a premium member.' });
    } else {
        await sock.sendMessage(chatId, { text: '❌ Invalid phone number.' });
    }
}

export async function handleListPremium(sock, chatId, senderJid, { groupManager, isOwnerFromJid }) {
    const isOwner = await isOwnerFromJid(sock, chatId, senderJid);
    if (!isOwner) {
        await sock.sendMessage(chatId, { text: '❌ Only owners can view premium users.' });
        return;
    }
    const users = await groupManager.getAllPremiumUsers();
    let text = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n⭐ *PREMIUM USERS*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
    if (!users.length) {
        text += '📭 No premium users yet.\n\n_Use `/addpremium` to add one._';
    } else {
        text += `📊 *Total:* ${users.length}\n\n`;
        users.forEach((u, i) => {
            const date = u.added_at ? new Date(u.added_at).toLocaleDateString() : '';
            text += `${i + 1}. 📱 ${u.phone_number}\n`;
            if (date) text += `   📅 ${date}\n`;
            text += '\n';
        });
    }
    text += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💡 `/addpremium` `/removepremium`';
    await sock.sendMessage(chatId, { text });
}

export async function handleAddMod(sock, chatId, senderJid, args, quotedMessage, { groupManager, isOwnerFromJid }) {
    const isOwner = await isOwnerFromJid(sock, chatId, senderJid);
    if (!isOwner) {
        await sock.sendMessage(chatId, { text: '❌ Only owners can manage moderators.' });
        return;
    }
    const targetPhone = await resolveTargetPhone(sock, chatId, args, quotedMessage, senderJid);
    if (!targetPhone) {
        await sock.sendMessage(chatId, { text: '❌ Specify a phone number, @tag someone, or reply to their message.\n\n_Example: `/addmod 919876543210`_' });
        return;
    }
    const result = await groupManager.addDynamicModerator(targetPhone, extractPhoneNumber(senderJid));
    if (result.ok) {
        const targetJid = `${result.phone_number}@s.whatsapp.net`;
        const groupMsg =
            '┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n' +
            '┃  🛡️ *NEW MODERATOR!* 🛡️     ┃\n' +
            '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n' +
            `🎉 @${result.phone_number} is now a *Moderator*!\n\n` +
            '✅ Staff commands unlocked\n🎬 Unlimited movie searches\n' +
            '─────────────────────────────\n_Promoted by owner_ 👑';
        await sock.sendMessage(chatId, { text: groupMsg, mentions: [targetJid] });

        const dmText =
            '┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n' +
            "┃  🛡️ *YOU'RE A MODERATOR!* 🛡️ ┃\n" +
            '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n' +
            "🎉 You've been promoted to *Moderator*!\n\n" +
            '✅ *Your new powers:*\n' +
            '• 📋 Activate/deactivate groups\n• 📰 Post tech news to groups\n' +
            '• 👥 Manage bot admins\n• 🎬 Unlimited movie searches\n' +
            '• 📸 Toggle Instagram auto-download\n\n' +
            '─────────────────────────────\n_Use /help to see all commands_ 🤖';
        try { await sock.sendMessage(targetJid, { text: dmText }); } catch {}
    } else if (result.reason === 'already') {
        await sock.sendMessage(chatId, { text: `ℹ️ ${result.phone_number} is already a moderator.` });
    } else if (result.reason === 'owner') {
        await sock.sendMessage(chatId, { text: 'ℹ️ That user is already an owner.' });
    } else {
        await sock.sendMessage(chatId, { text: '❌ Invalid phone number.' });
    }
}

export async function handleRemoveMod(sock, chatId, senderJid, args, quotedMessage, { groupManager, isOwnerFromJid }) {
    const isOwner = await isOwnerFromJid(sock, chatId, senderJid);
    if (!isOwner) {
        await sock.sendMessage(chatId, { text: '❌ Only owners can manage moderators.' });
        return;
    }
    const targetPhone = await resolveTargetPhone(sock, chatId, args, quotedMessage, senderJid);
    if (!targetPhone) {
        await sock.sendMessage(chatId, { text: '❌ Specify a phone number, @tag someone, or reply to their message.\n\n_Example: `/removemod 919876543210`_' });
        return;
    }
    const result = await groupManager.removeDynamicModerator(targetPhone);
    if (result.ok) {
        const targetJid = `${result.phone_number}@s.whatsapp.net`;
        await sock.sendMessage(chatId, {
            text: `🛡️ @${result.phone_number} has been removed as *Moderator*.`,
            mentions: [targetJid],
        });
        const dmText =
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🛡️ *Moderator Status Update*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
            'Your moderator role has been removed.\nStaff commands are no longer available.\n\n' +
            '💡 Contact the owner if this was a mistake.\n━━━━━━━━━━━━━━━━━━━━━━━━━━━';
        try { await sock.sendMessage(targetJid, { text: dmText }); } catch {}
    } else if (result.reason === 'not_found') {
        await sock.sendMessage(chatId, { text: 'ℹ️ That user is not a dynamic moderator.\n\n_Note: .env moderators cannot be removed via command._' });
    } else {
        await sock.sendMessage(chatId, { text: '❌ Invalid phone number.' });
    }
}

export async function handleAddChannel(sock, chatId, args, senderJid, { groupManager, isOwnerFromJid, whatsappService }) {
    const senderPhone = extractPhoneNumber(senderJid);
    const isOwner = await isOwnerFromJid(sock, chatId, senderJid);
    if (!isOwner) {
        await sock.sendMessage(chatId, { text: '❌ Only owners can add sticker channels.' });
        return;
    }

    if (!args.length) {
        await sock.sendMessage(chatId, {
            text:
                '📡 *Add Sticker Channel*\n\nUsage: `/addchannel <channel-url-or-jid>`\n\n' +
                'Examples:\n• `/addchannel https://whatsapp.com/channel/0029Va...`\n' +
                '• `/addchannel 120363399411386277@newsletter`',
        });
        return;
    }

    const input = args[0];
    let channelJid = input;
    let channelName = input;

    if (input.includes('whatsapp.com/channel/') || !input.includes('@newsletter')) {
        const code = input.replace(/^https?:\/\/(www\.)?whatsapp\.com\/channel\//i, '').split('/')[0];
        try {
            const meta = await sock.newsletterMetadata('invite', code);
            channelJid = meta?.id || '';
            channelName = meta?.name?.text || meta?.name || code;
        } catch (err) {
            await sock.sendMessage(chatId, { text: `❌ Could not resolve channel: ${err.message}` });
            return;
        }
    }

    if (!channelJid?.includes('@newsletter')) {
        await sock.sendMessage(chatId, { text: '❌ Invalid channel. Provide a valid channel URL or JID.' });
        return;
    }

    const result = await groupManager.addStickerChannel(channelJid, channelName, senderPhone);
    if (result.ok) {
        if (whatsappService?.resolveStickerSourceChannels) {
            await whatsappService.resolveStickerSourceChannels();
        } else {
            try { await sock.subscribeNewsletterUpdates(channelJid); } catch {}
        }
        await sock.sendMessage(chatId, {
            text: `✅ *Channel Added*\n\n📡 ${channelName}\n🆔 ${channelJid}\n\n_Stickers from this channel will be forwarded._`,
        });
    } else {
        await sock.sendMessage(chatId, { text: `❌ Failed: ${result.reason}` });
    }
}

export async function handleRemoveChannel(sock, chatId, args, senderJid, { groupManager, isOwnerFromJid, whatsappService }) {
    const isOwner = await isOwnerFromJid(sock, chatId, senderJid);
    if (!isOwner) {
        await sock.sendMessage(chatId, { text: '❌ Only owners can remove sticker channels.' });
        return;
    }

    if (!args.length) {
        const channels = await groupManager.getStickerChannels();
        if (!channels.length) {
            await sock.sendMessage(chatId, { text: '📭 No sticker channels configured.' });
            return;
        }
        let text = '📡 *Remove Sticker Channel*\n\nUsage: `/removechannel <number>`\n\n*Current channels:*\n\n';
        channels.forEach((ch, i) => { text += `${i + 1}. ${ch.channel_name || ch.channel_jid}\n`; });
        await sock.sendMessage(chatId, { text });
        return;
    }

    const channels = await groupManager.getStickerChannels();
    const input = args[0];
    let targetJid = input;

    const num = parseInt(input, 10);
    if (!isNaN(num) && num >= 1 && num <= channels.length) {
        targetJid = channels[num - 1].channel_jid;
    } else if (!input.includes('@newsletter')) {
        await sock.sendMessage(chatId, { text: '❌ Invalid. Use channel number from `/removechannel` list.' });
        return;
    }

    const result = await groupManager.removeStickerChannel(targetJid);
    if (result.ok) {
        if (whatsappService?.resolveStickerSourceChannels) {
            await whatsappService.resolveStickerSourceChannels();
        }
        await sock.sendMessage(chatId, { text: `✅ Channel removed: ${targetJid}` });
    } else {
        await sock.sendMessage(chatId, { text: `❌ ${result.reason}` });
    }
}

export async function handleChannels(sock, chatId, senderJid, { groupManager, isOwnerFromJid }) {
    const isOwner = await isOwnerFromJid(sock, chatId, senderJid);
    if (!isOwner) {
        await sock.sendMessage(chatId, { text: '❌ Only owners can view sticker channels.' });
        return;
    }

    const dbChannels = await groupManager.getStickerChannels();
    const envChannelJids = config.STICKER_SOURCE_CHANNELS || [];

    let text = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📡 *STICKER SOURCE CHANNELS*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
    let idx = 0;

    if (envChannelJids.length) {
        text += '🔧 *From .env:*\n';
        for (const jid of envChannelJids) {
            idx++;
            let name = jid;
            try {
                if (sock.newsletterMetadata) {
                    const meta = await sock.newsletterMetadata('jid', jid);
                    const rawName = meta?.name || meta?.thread_metadata?.name;
                    name = typeof rawName === 'string' ? rawName : (rawName?.text || jid);
                }
            } catch {}
            text += `${idx}. ${name}\n   🆔 \`${jid}\`\n\n`;
        }
    }

    if (dbChannels.length) {
        text += '💾 *From commands:*\n';
        for (const ch of dbChannels) {
            idx++;
            const date = ch.added_at ? new Date(ch.added_at).toLocaleDateString() : '';
            text += `${idx}. ${ch.channel_name || 'Unnamed'}\n   🆔 \`${ch.channel_jid}\`\n`;
            if (date) text += `   📅 ${date}\n`;
            text += '\n';
        }
    }

    if (!envChannelJids.length && !dbChannels.length) {
        text += '📭 No channels configured.\n\n_Use `/addchannel` to add one._\n';
    } else {
        text += `📊 *Total:* ${idx} channel(s)\n`;
    }

    text += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💡 `/addchannel` `/removechannel`';
    await sock.sendMessage(chatId, { text });
}
