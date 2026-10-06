/**
 * Owner: /assist on|off|status — DM assistant mode (Gemini as Jacky)
 */

import { extractPhoneNumber } from '../../utils/permissions.js';
import { logger } from '../../utils/logger.js';
import { config } from '../../config/config.js';

export async function handleAssist(sock, chatId, senderJid, args, { groupManager, assistService }) {
    const senderPhone = extractPhoneNumber(senderJid);
    if (!groupManager.isOwner(senderPhone)) {
        await sock.sendMessage(chatId, { text: '❌ Only bot owners can control assist mode.' });
        return;
    }

    if (!assistService) {
        await sock.sendMessage(chatId, { text: '❌ Assist service not available.' });
        return;
    }

    const action = String(args[0] || '').toLowerCase();
    const ownerName = config.ASSIST_OWNER_NAME || 'Jacky';
    const llmOk = assistService.isConfigured();
    const llmChain = assistService.getProviderChain?.()?.join(' → ') || 'none';

    if (!action || action === 'status') {
        const on = await assistService.isEnabled();
        await sock.sendMessage(chatId, {
            text:
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                '🤖 *DM ASSIST MODE* 🤖\n' +
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                `👤 *Persona:* ${ownerName}\n` +
                `🔘 *Status:* ${on ? '✅ ON' : '❌ OFF'}\n` +
                `🧠 *AI chain:* ${llmOk ? llmChain : '❌ set GEMINI / GROQ / NVIDIA key on Render'}\n\n` +
                'When ON, personal DMs get smart replies *as you* (same language as them).\n' +
                '*Groups are never affected.*\n\n' +
                '*Commands:*\n' +
                '• `/assist on` — start auto-reply in DMs\n' +
                '• `/assist off` — stop\n' +
                '• `/assist clear` — wipe assist chat memory\n\n' +
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        });
        return;
    }

    if (action === 'on' || action === 'enable') {
        if (!llmOk) {
            await sock.sendMessage(chatId, {
                text: '❌ Cannot enable assist — set `GEMINI_API_KEY`, `GROQ_API_KEY`, or `NVIDIA_API_KEY` on the server.',
            });
            return;
        }
        const wasOn = await assistService.isEnabled();
        if (wasOn) {
            await sock.sendMessage(chatId, { text: `ℹ️ Assist mode is already *ON* (replying as ${ownerName} in DMs).` });
            return;
        }
        await assistService.setEnabled(true);
        await sock.sendMessage(chatId, {
            text:
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                '✅ *ASSIST MODE ON* ✅\n' +
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                `🤖 Personal DMs will get replies as *${ownerName}*.\n` +
                '🌐 Language auto-matched (English, Hindi, Hinglish, etc.)\n' +
                '📵 Groups are *not* affected.\n\n' +
                'Use `/assist off` to stop.\n' +
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        });
        logger.info(`Assist mode enabled by owner ${senderPhone}`);
        return;
    }

    if (action === 'off' || action === 'disable') {
        const wasOn = await assistService.isEnabled();
        await assistService.setEnabled(false);
        await sock.sendMessage(chatId, {
            text: wasOn
                ? '🛑 *Assist mode OFF* — DMs will no longer get auto-replies.'
                : 'ℹ️ Assist mode was already off.',
        });
        logger.info(`Assist mode disabled by owner ${senderPhone}`);
        return;
    }

    if (action === 'clear' || action === 'reset') {
        await assistService.clearHistory(chatId);
        await sock.sendMessage(chatId, { text: '🧹 Assist conversation memory cleared for this chat.' });
        return;
    }

    await sock.sendMessage(chatId, {
        text: '❌ Usage: `/assist on` · `/assist off` · `/assist status` · `/assist clear`',
    });
}
