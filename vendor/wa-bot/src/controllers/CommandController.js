/**
 * Command Controller — thin dispatcher
 * All handler logic lives in ./handlers/*
 */

import path from 'path';
import { checkCommandAccess } from '../commands/access.js';
import { bypassController } from './BypassController.js';
import { findCommand, findSimilarCommands } from '../commands/registry.js';
import { ImportProgressStore } from '../utils/importProgress.js';
import { logger } from '../utils/logger.js';
import { sendAndDelete } from '../utils/autoDelete.js';
import { extractPhoneNumber, isGroupMessage } from '../utils/permissions.js';
import { getSafeSendOptions, safeSendMessage, plainSendMessage, editMessageText } from '../utils/waMessage.js';
import { botTelemetry } from '../utils/botTelemetry.js';

import {
    handlePing,
    handlePosted,
    handleClear,
    handleConfirm,
    handleCancel,
    handlePause,
    handleResume,
    handleStatus,
    handleFacts,
    handleHelp,
} from './handlers/coreHandlers.js';

import {
    handleActivate,
    handleDeactivate,
    handleInstaOn,
    handleInstaOff,
    handleStickerOn,
    handleStickerOff,
    handleNewsOn,
    handleNewsOff,
    handleCoursesOn,
    handleCoursesOff,
    handleGithubOn,
    handleGithubOff,
    handleAiUpdatesOn,
    handleAiUpdatesOff,
    handleAutoChat,
    handleAwesomeOn,
    handleAwesomeOff,
    handleGroups,
    handleSetWelcome,
    handleGroupParticipantsUpdate as _handleGroupParticipantsUpdate,
    handleJoinStubMessage as _handleJoinStubMessage,
    handleMovieOn,
    handleMovieOff,
    handleSummaryOn,
    handleSummaryOff,
    handleSummaryNow,
    handleTrending,
    handleGroupLink,
    handleRevokeLink,
} from './handlers/groupHandlers.js';

import { handleTradelert, handleTradenow, handleSwing, handleExpiry, handleIndex, handleSvmkr, handleChainAi } from './handlers/tradeHandlers.js';
import ScalpService from '../services/ScalpService.js';
import {
    SCALP_INDICES,
    SCALP_INDEX_KEYS,
    resolveScalpIndex,
    parseScalpIndexArgs,
} from '../data/scalpIndexConfig.js';
import { handleAssist } from './handlers/assistHandlers.js';
import IpoController from './IpoController.js';
import BacktestController from './BacktestController.js';
import {
    telegramStickerService,
    abortImport,
    isImportActive,
    activeImports,
    MAX_CONCURRENT_IMPORTS,
} from '../services/TelegramStickerService.js';

import {
    handleAddAdmin,
    handleRemoveAdmin,
    handleAdmins,
    handleIncreaseLimit,
    handleCheckLimit,
} from './handlers/adminHandlers.js';

import {
    handleAddPremium,
    handleRemovePremium,
    handleListPremium,
    handleAddMod,
    handleRemoveMod,
    handleAddChannel,
    handleRemoveChannel,
    handleChannels,
} from './handlers/ownerHandlers.js';

import {
    handleInsta as _handleInsta,
    handleTwitter,
    handleNews,
    handleGithub,
    handlePendingGithubConfirmation,
    createGithubPostSessionStore,
    handleAwesome,
    handlePendingAwesomeConfirmation,
    createAwesomePostSessionStore,
} from './handlers/instaHandlers.js';

import { handleGroupPost } from './handlers/groupPostHandlers.js';

import { horoscopeService } from '../services/HoroscopeService.js';
import { adviceService } from '../services/AdviceService.js';
import { handleDriveUrl } from './handlers/driveHandlers.js';
import { handleViewOnce } from './handlers/viewOnceHandler.js';
import { handleDeploy } from './handlers/deployHandler.js';
import { handleCmdLog } from './handlers/cmdlogHandler.js';
import {
    handleWarn,
    handleMyWarns,
    handleWarns,
    handleClearWarns,
} from './handlers/warnHandlers.js';

import {
    handleKick,
    handleBan,
    handleUnban,
    handleBanList,
} from './handlers/banHandlers.js';

import { handleDelLast } from './handlers/deleteHandlers.js';
import {
    handleCv,
    handleTailor,
    handleCover,
    handlePendingResumeInput,
    createResumeSessionStore,
} from './handlers/resumeHandlers.js';
import {
    handleInterviewQ,
    handleInterviewQOn,
    handleInterviewQOff,
    handleInterviewQBoard,
    handleTagMeOn,
    handleTagMeOff,
    handleCheckTagStatus,
} from '../interviewQuestion/interviewQuestion.commands.js';
import {
    handleRoast,
    handleBirthday,
} from './handlers/roastBirthdayHandlers.js';

/**
 * Import a Telegram sticker pack and send as WhatsApp stickers.
 * Supports abort via /tgstop. Handles static, animated (TGS→animated WebP), and video (MP4) stickers.
 */
/**
 * Resume checkpoints for sticker-pack imports. Lives outside the sticker temp
 * dir, which TelegramStickerService sweeps on an age timer.
 */
const importProgress = new ImportProgressStore(
    path.join(process.cwd(), 'tmp', 'tg-import-progress.json')
);

/** How long one sticker upload may take before we treat it as wedged. */
const STICKER_SEND_TIMEOUT_MS = 60_000;
const STICKER_SEND_ATTEMPTS = 3;

/**
 * Send one sticker without letting the import hang.
 *
 * `sock.sendMessage` has no built-in timeout: if the socket wedges (a dropped
 * connection that hasn't surfaced yet, a stalled media upload) the await never
 * settles and the whole import freezes with no error — which is exactly how
 * these imports were "pausing". Every send is now bounded, retried, and
 * re-resolved against the live socket so a reconnect mid-pack doesn't leave us
 * writing into a dead one.
 *
 * @returns {Promise<boolean>} whether the sticker was delivered
 */
export async function sendStickerResiliently(
    sock, chatId, content, quotedMessage, getSock, signal,
    { timeoutMs = STICKER_SEND_TIMEOUT_MS, attempts = STICKER_SEND_ATTEMPTS, backoffMs = 1000 } = {}
) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
        if (signal?.aborted) return false;

        // Re-resolve each attempt: after a reconnect the original handle is stale.
        const active = (typeof getSock === 'function' && getSock()) || sock;

        try {
            const result = await Promise.race([
                active.sendMessage(chatId, content, {
                    // Only quote the triggering message on the first sticker's
                    // first try; a stale quote can itself make sends fail.
                    ...(attempt === 1 && quotedMessage ? { quoted: quotedMessage } : {}),
                    mediaUploadTimeoutMs: 90_000,
                }),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('sticker send timeout')), timeoutMs)
                ),
            ]);
            if (result) return true;
            throw new Error('send returned empty');
        } catch (err) {
            const last = attempt === attempts;
            logger.warn(
                `Sticker send attempt ${attempt}/${attempts} failed: ${err?.message || err}`
                + (last ? ' — giving up on this sticker' : ', retrying')
            );
            if (last) return false;
            // Back off before retrying; a wedged socket often needs a moment.
            await new Promise((r) => setTimeout(r, backoffMs * attempt));
        }
    }
    return false;
}

async function handleTgStickers(sock, chatId, args, quotedMessage, stickerForwarder = null, getSock = null) {
    if (!telegramStickerService.isConfigured) {
        await safeSendMessage(sock, chatId, {
            text: '❌ Telegram Bot token not configured.\nSet `TELEGRAM_BOT_TOKEN` in .env (create a bot via @BotFather on Telegram).',
        }, quotedMessage);
        return;
    }

    if (!args.length) {
        await safeSendMessage(sock, chatId, {
            text:
                '🎭 *Import Telegram Stickers*\n\n' +
                'Usage: `/tgstickers <pack-name-or-url>`\n\n' +
                '*Examples:*\n' +
                '• `/tgstickers PupperStickers`\n' +
                '• `/tgstickers https://t.me/addstickers/PupperStickers`\n\n' +
                '*Types supported:*\n' +
                '• Static (WebP) — resized + compressed\n' +
                '• Animated (TGS) — animated sticker with transparency\n' +
                '• Video (WEBM/MP4) — animated sticker with transparency\n\n' +
                '_Send `/tgstop` to cancel import at any time._',
        }, quotedMessage);
        return;
    }

    if (isImportActive(chatId)) {
        await safeSendMessage(sock, chatId, {
            text: '⚠️ An import is already running in this chat. Send `/tgstop` to cancel it first.',
        }, quotedMessage);
        return;
    }

    // Packs in different chats convert concurrently, but the total is capped —
    // conversion is CPU-bound and the bot runs on a small heap.
    if (activeImports.size >= MAX_CONCURRENT_IMPORTS) {
        await safeSendMessage(sock, chatId, {
            text:
                `⚠️ ${activeImports.size} sticker imports are already running elsewhere ` +
                `(limit ${MAX_CONCURRENT_IMPORTS}).\n\n_Try again in a moment._`,
        }, quotedMessage);
        return;
    }

    const input = args.join(' ');
    const packName = telegramStickerService.parsePackInput(input);
    if (!packName) {
        await safeSendMessage(sock, chatId, {
            text: '❌ Could not parse pack name. Use `/tgstickers <t.me/addstickers/PackName>` or just `/tgstickers PackName`.',
        }, quotedMessage);
        return;
    }

    let statusMsg = null;
    const abortController = new AbortController();
    const { signal } = abortController;
    const chatKey = String(chatId);
    activeImports.set(chatKey, abortController);

    try {
        const { createProgressBar } = await import('../utils/progressBar.js');
        const { editMessageText } = await import('../utils/waMessage.js');

        // Progress ticks are frequent (one per conversion, one per send) and
        // purely cosmetic. Two guards matter here:
        //   - fallback:false — a failed/timed-out edit must NOT turn into a new
        //     chat message, which is what was spamming the chat mid-import.
        //   - throttling — coalesce bursts so we don't outrun WhatsApp's edit
        //     rate and cause those failures in the first place.
        // Terminal states pass force:true so the final text always lands.
        const PROGRESS_MIN_INTERVAL_MS = 2500;
        let lastProgressAt = 0;
        let progressInFlight = false;

        const updateProgress = async (text, { force = false } = {}) => {
            if (!statusMsg?.key) return;
            const now = Date.now();
            if (!force && (progressInFlight || now - lastProgressAt < PROGRESS_MIN_INTERVAL_MS)) return;

            progressInFlight = true;
            lastProgressAt = now;
            try {
                await editMessageText(sock, chatId, statusMsg.key, text, { fallback: false });
            } catch {
                // Best-effort — a dropped progress frame is not worth reporting.
            } finally {
                progressInFlight = false;
            }
        };

        statusMsg = await safeSendMessage(sock, chatId, {
            text: `🎭 *Importing Telegram Stickers*\n\n📡 Fetching pack: *${packName}*…\n_Send /tgstop to cancel._`,
        }, quotedMessage);

        const pack = await telegramStickerService.getStickerSet(packName);
        const total = pack.stickers?.length || 0;

        const counts = { static: 0, animated: 0, video: 0 };
        for (const s of (pack.stickers || [])) {
            if (s.is_video) counts.video++;
            else if (s.is_animated) counts.animated++;
            else counts.static++;
        }
        const typeBreakdown = [];
        if (counts.static) typeBreakdown.push(`${counts.static} static`);
        if (counts.animated) typeBreakdown.push(`${counts.animated} animated`);
        if (counts.video) typeBreakdown.push(`${counts.video} video`);

        await updateProgress(
            `🎭 *Importing Telegram Stickers*\n\n📦 *${pack.title || packName}* — ${total} sticker(s)\n` +
            `_Types: ${typeBreakdown.join(', ') || 'unknown'}_\n\n` +
            `${createProgressBar(0)} 0/${total}\n⏳ Preparing downloads…\n\n_Send /tgstop to cancel._`,
            { force: true }
        );

        if (!total) {
            await updateProgress(`❌ Empty sticker pack: *${packName}*`, { force: true });
            return;
        }

        // Pick up where a previous run stopped, if it left a checkpoint.
        const alreadyDone = importProgress.getDone(chatId, packName);
        const resumeCount = [...alreadyDone].filter((i) => i < total).length;

        if (resumeCount >= total) {
            importProgress.clear(chatId, packName);
            await updateProgress(
                `✅ *${pack.title || packName}* was already fully imported here.\n`
                + `_Run it again to start over._`,
                { force: true }
            );
            return;
        }

        if (resumeCount) {
            await updateProgress(
                `🎭 *Resuming Import*\n\n📦 *${pack.title || packName}*\n`
                + `↩️ ${resumeCount}/${total} already sent — continuing with the remaining ${total - resumeCount}.\n\n`
                + `_Send /tgstop to cancel._`,
                { force: true }
            );
        }

        const { stickers, errors, skipped } = await telegramStickerService.fetchAndConvertPack(
            packName,
            async (converted, failed, phase) => {
                if (signal.aborted) return;
                const done = converted + failed + resumeCount;
                const pct = Math.round((done / total) * 100);
                const bar = createProgressBar(pct);
                await updateProgress(
                    `🎭 *Importing Telegram Stickers*\n\n📦 *${pack.title || packName}*\n` +
                    `\n${bar} ${done}/${total}\n🔄 Processing… ${done}/${total}` +
                    (resumeCount ? `\n_(${resumeCount} carried over from last run)_` : '') +
                    `\n\n_Send /tgstop to cancel._`
                );
            },
            signal,
            { skipIndices: alreadyDone }
        );

        if (signal.aborted) {
            await updateProgress(
                `🛑 *Import cancelled.*\n_${resumeCount}/${total} done so far — run the same command to resume._`,
                { force: true }
            );
            return;
        }

        if (!stickers.length) {
            const reasons = [];
            if (errors?.length) reasons.push(`${errors.length} failed`);
            await updateProgress(
                `❌ No stickers converted from *${pack.title || packName}*.\n${reasons.join('\n') || 'Empty pack.'}`
                + (resumeCount ? `\n\n_${resumeCount}/${total} were already sent previously._` : ''),
                { force: true }
            );
            return;
        }

        let sent = 0;
        let sendFailed = 0;
        let animatedSent = 0;
        for (let i = 0; i < stickers.length; i++) {
            if (signal.aborted) {
                importProgress.flush();
                await updateProgress(
                    `🛑 *Import cancelled mid-send.*\n`
                    + `_${resumeCount + sent}/${total} sent — run \`/tgstk ${packName}\` again to resume._`,
                    { force: true }
                );
                return;
            }

            const sticker = stickers[i];
            // Everything is a WebP sticker — animated ones carry an ANIM chunk
            // and the isAnimated flag so WhatsApp plays them.
            const stickerMsg = { sticker: sticker.buffer };
            if (sticker.isAnimated) stickerMsg.isAnimated = true;

            const ok = await sendStickerResiliently(
                sock, chatId, stickerMsg, quotedMessage, getSock, signal
            );

            if (ok) {
                if (sticker.isAnimated) animatedSent++;
                sent++;
                // Checkpoint by the sticker's index in the Telegram pack, so a
                // crash or /tgstop mid-pack resumes here instead of restarting.
                importProgress.markDone(chatId, packName, sticker.index);
            } else {
                sendFailed++;
            }

            const done = resumeCount + i + 1;
            const pct = Math.round((done / total) * 100);
            const bar = createProgressBar(pct);
            await updateProgress(
                `🎭 *Importing Telegram Stickers*\n\n📦 *${pack.title || packName}*\n` +
                `\n${bar} ${done}/${total}\n` +
                `📤 Sending… ${sent} sent${sendFailed ? `, ${sendFailed} failed` : ''}` +
                (animatedSent ? ` · ${animatedSent} animated` : '') +
                `\n\n_Send /tgstop to cancel._`
            );

            await new Promise((r) => setTimeout(r, sticker.isAnimated ? 500 : 300));
        }
        importProgress.flush();

        // Mirror the pack into the configured sticker-forwarding groups, so an
        // import run from any chat lands in the shared collection too. Skipped
        // when the command was already run inside a target group — no point
        // sending the same pack twice into the same chat.
        let broadcast = null;
        if (stickerForwarder?.broadcastStickerBuffers && stickers.length) {
            try {
                await updateProgress(
                    `🎭 *${pack.title || packName}*\n\n✅ Sent ${sent} sticker(s) here\n📤 Forwarding to sticker group(s)…`,
                    { force: true }
                );
                broadcast = await stickerForwarder.broadcastStickerBuffers(
                    sock,
                    stickers.map((s) => ({ buffer: s.buffer, isAnimated: s.isAnimated })),
                    { signal, exclude: [chatId] }
                );
            } catch (err) {
                logger.warn(`Sticker pack broadcast failed: ${err?.message || err}`);
            }
        }

        // Anything not delivered stays checkpointed so the next run retries
        // only those; a fully delivered pack drops its checkpoint entirely.
        const totalDelivered = resumeCount + sent;
        const complete = totalDelivered >= total;
        if (complete) {
            importProgress.clear(chatId, packName);
        }
        importProgress.flush();

        const parts = [`✅ *${pack.title || packName}* — sent *${sent}* sticker(s)`];
        if (resumeCount) parts.push(`↩️ ${resumeCount} carried over from a previous run`);
        if (animatedSent) parts.push(`🎞️ ${animatedSent} animated`);
        if (sendFailed) parts.push(`❌ ${sendFailed} failed to send`);
        if (errors?.length) parts.push(`⚠️ ${errors.length} conversion errors`);
        if (broadcast?.sent) {
            parts.push(`📤 Forwarded to ${broadcast.targets.length} sticker group(s) — ${broadcast.sent} sent`
                + (broadcast.failed ? `, ${broadcast.failed} failed` : ''));
        }
        parts.push(`\n_Pack: ${totalDelivered}/${total} stickers sent_`);
        if (!complete) {
            parts.push(`_Run \`/tgstk ${packName}\` again to resume the remaining ${total - totalDelivered}._`);
        }

        await updateProgress(parts.join('\n'), { force: true });
        logger.info(`TG sticker pack imported: ${packName} — ${sent} sent, ${sendFailed} failed, ${animatedSent} animated`);
    } catch (err) {
        logger.error(`TG stickers error: ${err.message}`);
        await safeSendMessage(sock, chatId, {
            text: `❌ Failed to import stickers: ${err.message}`
                + (packName ? `\n\n_Progress was saved — run \`/tgstk ${packName}\` again to resume._` : ''),
        }, quotedMessage);
    } finally {
        // Persist whatever was delivered before the failure, so the retry
        // resumes instead of starting over.
        importProgress.flush();
        activeImports.delete(chatKey);
    }
}

/**
 * Data-driven dispatch table — command key (from the registry) -> handler.
 *
 * Every handler receives one params object:
 *   { sock, chatId, senderJid, args, originalMsg, pushName, ctx, fullCommand }
 * and returns a promise (or void). A registered key with NO entry here fails
 * loudly at dispatch time instead of silently no-oping — adding a command now
 * means adding one registry entry + one table entry, nothing else.
 */
/**
 * Enable scalp alerts here and set which indices they cover.
 *
 * Backs both `/scalpon [indices]` and `/scalp alert [indices]` — the second is
 * how this was asked for, and supporting one spelling only would make the other
 * silently build a scalp card for an index named "alert".
 *
 * No indices given keeps whatever the group already had (NIFTY for groups that
 * predate SENSEX), so a bare `/scalpon` never quietly changes a selection.
 */
async function scalpAlertPrefs({ sock, chatId, senderJid, argStr, ctx }) {
    const groupManager = ctx?.groupManager;
    if (!isGroupMessage(chatId)) {
        await safeSendMessage(sock, chatId, { text: 'Use `/scalpon` in a group.' });
        return;
    }
    if (!groupManager) {
        await safeSendMessage(sock, chatId, { text: '⚠️ Group manager not available.' });
        return;
    }
    const isActive = await groupManager.isGroupActive(chatId);
    if (!isActive) {
        await safeSendMessage(sock, chatId, { text: '⚠️ Group not activated. Use `/activate` first.' });
        return;
    }

    const { keys, unknown } = parseScalpIndexArgs(argStr);
    if (unknown.length && !keys.length) {
        await safeSendMessage(sock, chatId, {
            text: `⚠️ Unknown index: ${unknown.join(', ')}\n`
                + `Supported: ${SCALP_INDEX_KEYS.join(', ').toLowerCase()}\n`
                + 'Example: `/scalpon nifty sensex`',
        });
        return;
    }

    let groupName = 'Unknown Group';
    try { groupName = (await sock.groupMetadata(chatId)).subject; } catch {}
    const senderPhone = extractPhoneNumber(senderJid);

    await groupManager.setScalpEnabled(chatId, groupName, true, senderPhone, keys.length ? keys : undefined);
    const active = keys.length ? keys : await groupManager.getScalpIndices(chatId);
    const labels = active.map((k) => SCALP_INDICES[k]?.label || k).join(' + ');

    const lines = [
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        '✅ *SCALP ON*',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        '',
        `📢 *Group:* ${groupName}`,
        '',
        `⚡ Alerts: *${labels}*`,
    ];
    for (const k of active) {
        const c = SCALP_INDICES[k];
        if (c) lines.push(`   ${c.label}: +${c.targetPts} / −${c.stopPts} pts · lot ${c.lot}`);
    }
    lines.push('');
    lines.push('Usage: `/scalp` · `/scalp sensex` for a live card');
    lines.push('Change: `/scalpon nifty sensex`');
    if (unknown.length) lines.push(`\n⚠️ Ignored: ${unknown.join(', ')}`);
    lines.push('');
    lines.push('💡 `/scalpoff` to disable');

    await safeSendMessage(sock, chatId, { text: lines.join('\n') });
}


export const COMMAND_HANDLERS = {
    /* ── Core ── */
    ping: ({ sock, chatId, ctx }) => handlePing(sock, chatId, ctx),
    posted: ({ sock, chatId, ctx }) => handlePosted(sock, chatId, ctx),
    clear: ({ sock, chatId, ctx }) => handleClear(sock, chatId, ctx),
    confirm: ({ sock, chatId, ctx }) => handleConfirm(sock, chatId, ctx),
    cancel: ({ sock, chatId, senderJid, ctx }) => handleCancel(sock, chatId, senderJid, ctx),
    pause: ({ sock, chatId, ctx }) => handlePause(sock, chatId, ctx),
    resumecourses: ({ sock, chatId, ctx }) => handleResume(sock, chatId, ctx),
    status: ({ sock, chatId, ctx }) => handleStatus(sock, chatId, ctx),
    facts: ({ sock, chatId, ctx }) => handleFacts(sock, chatId, ctx),
    help: ({ sock, chatId, senderJid, ctx }) => handleHelp(sock, chatId, senderJid, ctx),

    /* ── Group management ── */
    activate: ({ sock, chatId, senderJid, ctx }) => handleActivate(sock, chatId, senderJid, ctx),
    deactivate: ({ sock, chatId, senderJid, ctx }) => handleDeactivate(sock, chatId, senderJid, ctx),
    instaon: ({ sock, chatId, senderJid, ctx }) => handleInstaOn(sock, chatId, senderJid, ctx),
    instaoff: ({ sock, chatId, senderJid, ctx }) => handleInstaOff(sock, chatId, senderJid, ctx),
    stickeron: ({ sock, chatId, senderJid, ctx }) => handleStickerOn(sock, chatId, senderJid, ctx),
    stickeroff: ({ sock, chatId, senderJid, ctx }) => handleStickerOff(sock, chatId, senderJid, ctx),
    newson: ({ sock, chatId, senderJid, ctx }) => handleNewsOn(sock, chatId, senderJid, ctx),
    newsoff: ({ sock, chatId, senderJid, ctx }) => handleNewsOff(sock, chatId, senderJid, ctx),
    courson: ({ sock, chatId, senderJid, ctx }) => handleCoursesOn(sock, chatId, senderJid, ctx),
    coursesoff: ({ sock, chatId, senderJid, ctx }) => handleCoursesOff(sock, chatId, senderJid, ctx),
    githubon: ({ sock, chatId, senderJid, ctx }) => handleGithubOn(sock, chatId, senderJid, ctx),
    githuboff: ({ sock, chatId, senderJid, ctx }) => handleGithubOff(sock, chatId, senderJid, ctx),
    aiupdateson: ({ sock, chatId, senderJid, ctx }) => handleAiUpdatesOn(sock, chatId, senderJid, ctx),
    aiupdatesoff: ({ sock, chatId, senderJid, ctx }) => handleAiUpdatesOff(sock, chatId, senderJid, ctx),
    autochat: ({ sock, chatId, senderJid, args, ctx }) => handleAutoChat(sock, chatId, senderJid, args, ctx),

    awesomeon: ({ sock, chatId, senderJid, ctx }) => handleAwesomeOn(sock, chatId, senderJid, ctx),
    awesomeoff: ({ sock, chatId, senderJid, ctx }) => handleAwesomeOff(sock, chatId, senderJid, ctx),
    interviewqon: ({ sock, chatId, senderJid, ctx }) => handleInterviewQOn(sock, chatId, senderJid, ctx),
    interviewqoff: ({ sock, chatId, senderJid, ctx }) => handleInterviewQOff(sock, chatId, senderJid, ctx),
    interviewq: ({ sock, chatId, senderJid, args, ctx }) => handleInterviewQ(sock, chatId, senderJid, args, ctx),
    iqboard: ({ sock, chatId, senderJid, ctx }) => handleInterviewQBoard(sock, chatId, senderJid, ctx),
    tagme: ({ sock, chatId, senderJid, args, ctx, pushName }) => handleTagMeOn(sock, chatId, senderJid, args, { ...ctx, pushName }),
    notag: ({ sock, chatId, senderJid, args, ctx, pushName }) => handleTagMeOff(sock, chatId, senderJid, args, { ...ctx, pushName }),
    checktagstatus: ({ sock, chatId, senderJid, args, ctx, pushName }) =>
        handleCheckTagStatus(sock, chatId, senderJid, args, { ...ctx, pushName }),
    roast: ({ sock, chatId, senderJid, originalMsg, pushName, ctx }) => handleRoast({ sock, chatId, senderJid, originalMsg, pushName, ctx }),
    birthday: ({ sock, chatId, senderJid, args, originalMsg, ctx }) => handleBirthday({ sock, chatId, senderJid, args, originalMsg, ctx }),
    groups: ({ sock, chatId, senderJid, ctx }) => handleGroups(sock, chatId, senderJid, ctx),
    setwc: ({ sock, chatId, senderJid, fullCommand, ctx }) => handleSetWelcome(sock, chatId, senderJid, fullCommand, ctx),
    link: ({ sock, chatId, senderJid, ctx }) => handleGroupLink(sock, chatId, senderJid, ctx),
    revokelink: ({ sock, chatId, senderJid, ctx }) => handleRevokeLink(sock, chatId, senderJid, ctx),
    warn: ({ sock, chatId, senderJid, args, originalMsg, ctx }) => handleWarn(sock, chatId, senderJid, args, originalMsg, ctx),
    mywarns: ({ sock, chatId, senderJid, ctx }) => handleMyWarns(sock, chatId, senderJid, ctx),
    warns: ({ sock, chatId, senderJid, args, originalMsg, ctx }) => handleWarns(sock, chatId, senderJid, args, originalMsg, ctx),
    clearwarns: ({ sock, chatId, senderJid, args, originalMsg, ctx }) => handleClearWarns(sock, chatId, senderJid, args, originalMsg, ctx),
    kick: ({ sock, chatId, senderJid, args, originalMsg, ctx }) => handleKick(sock, chatId, senderJid, args, originalMsg, ctx),
    ban: ({ sock, chatId, senderJid, args, originalMsg, ctx }) => handleBan(sock, chatId, senderJid, args, originalMsg, ctx),
    unban: ({ sock, chatId, senderJid, args, originalMsg, ctx }) => handleUnban(sock, chatId, senderJid, args, originalMsg, ctx),
    banlist: ({ sock, chatId, senderJid, args, originalMsg, ctx }) => handleBanList(sock, chatId, senderJid, args, originalMsg, ctx),
    dellast: ({ sock, chatId, args, originalMsg, ctx }) => handleDelLast(sock, chatId, args, originalMsg, ctx),
    delall: ({ sock, chatId, args, originalMsg, ctx }) => handleDelLast(sock, chatId, args, originalMsg, ctx),
    movieon: ({ sock, chatId, senderJid, ctx }) => handleMovieOn(sock, chatId, senderJid, ctx),
    movieoff: ({ sock, chatId, senderJid, ctx }) => handleMovieOff(sock, chatId, senderJid, ctx),
    summaryon: ({ sock, chatId, senderJid, ctx }) => handleSummaryOn(sock, chatId, senderJid, ctx),
    summaryoff: ({ sock, chatId, senderJid, ctx }) => handleSummaryOff(sock, chatId, senderJid, ctx),
    summarynow: ({ sock, chatId, senderJid, ctx }) => handleSummaryNow(sock, chatId, senderJid, ctx),
    assist: ({ sock, chatId, senderJid, args, ctx }) => handleAssist(sock, chatId, senderJid, args, ctx),
    resume: ({ sock, chatId, senderJid, args, ctx }) => handleCv(sock, chatId, senderJid, args, ctx),
    tailor: ({ sock, chatId, senderJid, args, ctx }) => handleTailor(sock, chatId, senderJid, args, ctx),
    cover: ({ sock, chatId, senderJid, args, ctx }) => handleCover(sock, chatId, senderJid, args, ctx),
    trending: ({ sock, chatId, senderJid, args, ctx }) => handleTrending(sock, chatId, senderJid, args, ctx),
    tradelert: ({ sock, chatId, senderJid, args, ctx }) => handleTradelert(sock, chatId, senderJid, args, ctx),
    tradenow: ({ sock, chatId, senderJid, args, ctx }) => handleTradenow(sock, chatId, senderJid, args, ctx),
    index: ({ sock, chatId, senderJid, args, ctx }) => handleIndex(sock, chatId, senderJid, args, ctx),
    chainai: ({ sock, chatId, senderJid, args, ctx }) => handleChainAi(sock, chatId, senderJid, args, ctx),
    ipo: ({ sock, chatId, senderJid, args, originalMsg, ctx }) => {
        if (!ctx.ipoController) {
            return safeSendMessage(sock, chatId, { text: '⚠️ IPO analysis service is not available.' }, originalMsg);
        }
        return ctx.ipoController.handle(sock, chatId, senderJid, args, originalMsg);
    },
    svmkr: ({ sock, chatId, senderJid, args, ctx }) => handleSvmkr(sock, chatId, senderJid, args, ctx),
    swing: ({ sock, chatId, senderJid, args, ctx }) => handleSwing(sock, chatId, senderJid, args, ctx),
    expiry: ({ sock, chatId, senderJid, args, ctx }) => handleExpiry(sock, chatId, senderJid, args, ctx),
    backtest: async ({ sock, chatId, args, ctx }) => {
        if (!ctx.backtestController) {
            ctx.backtestController = new BacktestController(ctx.config || {});
        }
        return ctx.backtestController.handleCommand(chatId, `/backtest${args?.length ? ' ' + args.join(' ') : ''}`, sock);
    },
    scalp: async ({ sock, chatId, senderJid, args, ctx }) => {
        const groupManager = ctx?.groupManager;
        const argStr = (args || []).join(' ');

        // `/scalp alert nifty sensex` sets which indices auto-alert here — the
        // same thing /scalpon does, accepted in the phrasing people actually use.
        if (/^\s*alerts?\b/i.test(argStr)) {
            return scalpAlertPrefs({ sock, chatId, senderJid, argStr, ctx });
        }

        if (groupManager && isGroupMessage(chatId)) {
            const enabled = await groupManager.isScalpEnabled(chatId);
            if (!enabled) {
                await safeSendMessage(sock, chatId, { text: '⚠️ Scalp is not enabled here.\nUse `/scalpon` to enable it.' });
                return;
            }
        }

        // `/scalp sensex` overrides; bare `/scalp` follows the group's own
        // selection so a SENSEX-only group does not get handed a NIFTY card.
        let cfg = resolveScalpIndex(argStr);
        if (!cfg) {
            const { keys } = parseScalpIndexArgs(argStr);
            if (keys.length) cfg = SCALP_INDICES[keys[0]];
        }
        if (!cfg && groupManager && isGroupMessage(chatId)) {
            try {
                const picked = await groupManager.getScalpIndices(chatId);
                cfg = SCALP_INDICES[picked[0]] || null;
            } catch (_) { /* fall through to NIFTY */ }
        }
        cfg = cfg || SCALP_INDICES.NIFTY;

        // Send loading message, then edit with result
        let loadingMsg = null;
        try {
            loadingMsg = await sock.sendMessage(chatId, { text: `⚡ _Fetching ${cfg.label} scalp data..._` });
        } catch (_) { /* ignore */ }
        try {
            const svc = new ScalpService();
            const card = await svc.buildScalpCard(cfg.key);
            if (card && loadingMsg?.key) {
                await editMessageText(sock, chatId, loadingMsg.key, card);
            } else if (card) {
                await safeSendMessage(sock, chatId, { text: card });
            } else {
                const errText = '⚠️ Could not build scalp card.';
                if (loadingMsg?.key) await editMessageText(sock, chatId, loadingMsg.key, errText);
                else await safeSendMessage(sock, chatId, { text: errText });
            }
        } catch (err) {
            logger.error(`Scalp command failed: ${err.message}`);
            const errText = `❌ Scalp error: ${err.message}`;
            if (loadingMsg?.key) await editMessageText(sock, chatId, loadingMsg.key, errText);
            else await safeSendMessage(sock, chatId, { text: errText });
        }
    },
    sweep: async ({ sock, chatId, args }) => {
        // Manual counterpart to the auto-alerts. The time window is ignored on
        // purpose: asking for the current state outside 09:45-14:45 should
        // answer, not go quiet, even though the scanner itself stays silent then.
        let loadingMsg = null;
        try {
            loadingMsg = await sock.sendMessage(chatId, {
                text: '⚡ _Scanning for liquidity sweeps..._',
            });
        } catch (_) { /* ignore */ }

        try {
            const { default: sweepAlertService, ALERT_INDICES } = await import(
                '../services/SweepAlertService.js'
            );

            // `/sweep NIFTY` narrows to one index; bare `/sweep` covers all the
            // alerted ones.
            const wanted = (args?.[0] || '').trim().toUpperCase();
            const results = await sweepAlertService.scanNow({ ignoreTimeWindow: true });
            const shown = wanted
                ? results.filter((r) => r.setup.index === wanted)
                : results;

            let text;
            if (shown.length) {
                text = shown.map((r) => r.text).join('\n\n━━━━━━━━━━━━━━━━━━━━\n\n');
            } else {
                const scope = wanted || ALERT_INDICES.join(', ');
                text =
                    `⚡ *No liquidity sweep right now* — ${scope}\n\n` +
                    '_A sweep is a specific event: price runs the stops under a ' +
                    'level, then closes back above it. Most bars are not one._\n' +
                    `_Auto-alerts cover ${ALERT_INDICES.join(' and ')} every 5 min ` +
                    'during market hours._';
            }

            if (loadingMsg?.key) await editMessageText(sock, chatId, loadingMsg.key, text);
            else await safeSendMessage(sock, chatId, { text });
        } catch (err) {
            logger.error(`Sweep command failed: ${err.message}`);
            const errText = `❌ Sweep error: ${err.message}`;
            if (loadingMsg?.key) await editMessageText(sock, chatId, loadingMsg.key, errText);
            else await safeSendMessage(sock, chatId, { text: errText });
        }
    },

    /* ── Admin management ── */
    addadmin: ({ sock, chatId, senderJid, args, originalMsg, ctx }) => handleAddAdmin(sock, chatId, senderJid, args, originalMsg, ctx),
    removeadmin: ({ sock, chatId, senderJid, args, originalMsg, ctx }) => handleRemoveAdmin(sock, chatId, senderJid, args, originalMsg, ctx),
    admins: ({ sock, chatId, senderJid, ctx }) => handleAdmins(sock, chatId, senderJid, ctx),
    increaselimit: ({ sock, chatId, senderJid, args, originalMsg, ctx }) => handleIncreaseLimit(sock, chatId, senderJid, args, originalMsg, ctx),
    checklimit: ({ sock, chatId, senderJid, args, originalMsg, pushName, ctx }) => handleCheckLimit(sock, chatId, senderJid, args, originalMsg, pushName, ctx),

    /* ── Owner: premium / mod / channels ── */
    addpremium: ({ sock, chatId, senderJid, args, ctx }) => handleAddPremium(sock, chatId, senderJid, args, ctx),
    removepremium: ({ sock, chatId, senderJid, args, ctx }) => handleRemovePremium(sock, chatId, senderJid, args, ctx),
    premium: ({ sock, chatId, senderJid, ctx }) => handleListPremium(sock, chatId, senderJid, ctx),
    addmod: ({ sock, chatId, senderJid, args, ctx }) => handleAddMod(sock, chatId, senderJid, args, ctx),
    removemod: ({ sock, chatId, senderJid, args, ctx }) => handleRemoveMod(sock, chatId, senderJid, args, ctx),
    addchannel: ({ sock, chatId, args, senderJid, ctx }) => handleAddChannel(sock, chatId, args, senderJid, ctx),
    removechannel: ({ sock, chatId, args, senderJid, ctx }) => handleRemoveChannel(sock, chatId, args, senderJid, ctx),
    channels: ({ sock, chatId, senderJid, ctx }) => handleChannels(sock, chatId, senderJid, ctx),
    grouppost: ({ sock, chatId, senderJid, args, ctx }) => handleGroupPost(sock, chatId, senderJid, args, ctx),
    driveurl: ({ sock, chatId, senderJid, args, ctx }) => handleDriveUrl(sock, chatId, senderJid, args, ctx),
    viewonce: ({ sock, chatId, senderJid, originalMsg }) => handleViewOnce(sock, chatId, senderJid, originalMsg),
    deploy: ({ sock, chatId, senderJid, originalMsg }) => handleDeploy(sock, chatId, senderJid, originalMsg),
    cmdlog: ({ sock, chatId, args, ctx }) => handleCmdLog(sock, chatId, args, ctx),

    /* ── Instagram / News / Movie ── */
    bypass: ({ sock, chatId, senderJid, args, originalMsg, pushName }) =>
        bypassController.handleBypass(sock, chatId, senderJid, args, originalMsg, pushName),
    bypasson: ({ sock, chatId, senderJid, originalMsg }) =>
        bypassController.handleBypassOn(sock, chatId, senderJid, originalMsg),
    bypassoff: ({ sock, chatId, senderJid, originalMsg }) =>
        bypassController.handleBypassOff(sock, chatId, senderJid, originalMsg),
    insta: ({ sock, chatId, args, originalMsg }) => _handleInsta(sock, chatId, args, originalMsg),
    tw: ({ sock, chatId, args, originalMsg }) => handleTwitter(sock, chatId, args, originalMsg),
    news: ({ sock, chatId, senderJid, ctx }) => handleNews(sock, chatId, senderJid, ctx),
    github: ({ sock, chatId, senderJid, ctx }) => handleGithub(sock, chatId, senderJid, ctx),
    awesome: ({ sock, chatId, senderJid, ctx }) => handleAwesome(sock, chatId, senderJid, ctx),
    horo: async ({ sock, chatId, senderJid, args, originalMsg, ctx }) => {
        try {
            const sign = args[0];
            if (!sign) {
                const listMsg = horoscopeService.getSignsList();
                await safeSendMessage(sock, chatId, { text: listMsg }, originalMsg);
            } else {
                const data = await horoscopeService.fetchHoroscope(sign);
                if (data.error === 'api_error') {
                }
                const msg = horoscopeService.formatMessage(data);
                await safeSendMessage(sock, chatId, { text: msg }, originalMsg);
            }
        } catch (err) {
            logger.error('Horoscope command error:', err);
            await safeSendMessage(sock, chatId, { text: '⚠️ Failed to fetch horoscope. Please try again.' }, originalMsg);
        }
    },
    advice: async ({ sock, chatId, originalMsg }) => {
        try {
            const slip = await adviceService.fetchAdvice();
            await safeSendMessage(sock, chatId, { text: adviceService.formatMessage(slip) }, originalMsg);
        } catch (err) {
            logger.error('Advice command error:', err);
            await safeSendMessage(sock, chatId, { text: adviceService.formatError() }, originalMsg);
        }
    },
    movie: ({ sock, chatId, senderJid, args, pushName, originalMsg, ctx }) => {
        if (!ctx.movieController) {
            return safeSendMessage(sock, chatId, { text: '⚠️ Movie search is not available.' }, originalMsg);
        }
        void ctx.movieController.handleMovieSearch(sock, chatId, senderJid, args, pushName, originalMsg)
            .catch((err) => {
                logger.error(`Movie search handler error: ${err?.message || err}`);
            });
    },
    upcoming: ({ sock, chatId, senderJid, originalMsg, ctx }) => {
        if (!ctx.movieController) {
            return safeSendMessage(sock, chatId, { text: '⚠️ Movie features not available.' }, originalMsg);
        }
        void ctx.movieController.handleUpcoming(sock, chatId, senderJid, originalMsg)
            .catch((err) => logger.error(`Upcoming handler error: ${err?.message || err}`));
    },
    genre: ({ sock, chatId, senderJid, args, originalMsg, ctx }) => {
        if (!ctx.movieController) {
            return safeSendMessage(sock, chatId, { text: '⚠️ Movie features not available.' }, originalMsg);
        }
        void ctx.movieController.handleGenre(sock, chatId, senderJid, args, originalMsg)
            .catch((err) => logger.error(`Genre handler error: ${err?.message || err}`));
    },

    /* ── Sticker Commands (non-blocking — FFmpeg runs in background queue) ── */
    sticker: ({ sock, chatId, args, originalMsg, fullCommand, ctx }) => {
        if (!ctx.stickerController) {
            return safeSendMessage(sock, chatId, { text: '⚠️ Sticker functionality is not available.' }, originalMsg);
        }
        void ctx.stickerController.handleSticker(sock, chatId, originalMsg, args, fullCommand).catch((err) => {
            logger.error('Sticker command error:', err);
            void safeSendMessage(sock, chatId, { text: '⚠️ Failed to process sticker command.' }, originalMsg);
        });
    },
    steal: ({ sock, chatId, args, originalMsg, fullCommand, ctx }) => {
        if (!ctx.stickerController) {
            return safeSendMessage(sock, chatId, { text: '⚠️ Sticker functionality is not available.' }, originalMsg);
        }
        void ctx.stickerController.handleSteal(sock, chatId, originalMsg, args, fullCommand).catch((err) => {
            logger.error('Steal command error:', err);
            void safeSendMessage(sock, chatId, { text: '⚠️ Failed to process steal command.' }, originalMsg);
        });
    },
    toimg: ({ sock, chatId, originalMsg, ctx }) => {
        if (!ctx.stickerController) {
            return safeSendMessage(sock, chatId, { text: '⚠️ Sticker functionality is not available.' }, originalMsg);
        }
        void ctx.stickerController.handleToImage(sock, chatId, originalMsg).catch((err) => {
            logger.error('ToImage command error:', err);
            void safeSendMessage(sock, chatId, { text: '⚠️ Failed to convert sticker to image.' }, originalMsg);
        });
    },
    rgb: ({ sock, chatId, args, originalMsg, ctx }) => {
        if (!ctx.stickerController) {
            return safeSendMessage(sock, chatId, { text: '⚠️ Sticker functionality is not available.' }, originalMsg);
        }
        void ctx.stickerController.handleRgbSticker(sock, chatId, args, originalMsg).catch((err) => {
            logger.error('RGB sticker error:', err);
            void safeSendMessage(sock, chatId, { text: '⚠️ Failed to generate RGB sticker.' }, originalMsg);
        });
    },
    tgstickers: async ({ sock, chatId, args, originalMsg, ctx }) => {
        const groupManager = ctx?.groupManager;
        if (groupManager && isGroupMessage(chatId)) {
            const enabled = await groupManager.isTgStickerEnabled(chatId);
            if (!enabled) {
                await safeSendMessage(sock, chatId, { text: '⚠️ Telegram sticker import is not enabled here.\nUse `/tgstickeron` to enable it.' }, originalMsg);
                return;
            }
        }
        void handleTgStickers(sock, chatId, args, originalMsg, ctx?.stickerForwarder, ctx?.getSock).catch((err) => {
            logger.error('TG stickers command error:', err);
            void safeSendMessage(sock, chatId, { text: `⚠️ ${err.message || 'Failed to import stickers.'}` }, originalMsg);
        });
    },
    tgstop: ({ sock, chatId, originalMsg }) => {
        const stopped = abortImport(chatId);
        void safeSendMessage(sock, chatId, {
            text: stopped ? '🛑 *Import cancelled.*' : 'ℹ️ No active import to cancel.',
        }, originalMsg);
    },
    tgstickeron: async ({ sock, chatId, senderJid, ctx }) => {
        const groupManager = ctx?.groupManager;
        if (!isGroupMessage(chatId)) {
            await safeSendMessage(sock, chatId, { text: 'Use `/tgstickeron` in a group.' });
            return;
        }
        if (!groupManager) {
            await safeSendMessage(sock, chatId, { text: '⚠️ Group manager not available.' });
            return;
        }
        const isActive = await groupManager.isGroupActive(chatId);
        if (!isActive) {
            await safeSendMessage(sock, chatId, { text: '⚠️ Group not activated. Use `/activate` first.' });
            return;
        }
        let groupName = 'Unknown Group';
        try { groupName = (await sock.groupMetadata(chatId)).subject; } catch {}
        const senderPhone = extractPhoneNumber(senderJid);
        await groupManager.setTgStickerEnabled(chatId, groupName, true, senderPhone);
        await safeSendMessage(sock, chatId, {
            text: '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n✅ *TG STICKER ON*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                `📢 *Group:* ${groupName}\n\n` +
                '🎭 Telegram sticker import enabled.\n' +
                'Usage: `/tgstickers <pack-name-or-url>`\n\n' +
                '💡 `/tgstickeroff` to disable',
        });
    },
    tgstickeroff: async ({ sock, chatId, senderJid, ctx }) => {
        const groupManager = ctx?.groupManager;
        if (!isGroupMessage(chatId)) {
            await safeSendMessage(sock, chatId, { text: 'Use `/tgstickeroff` in a group.' });
            return;
        }
        if (!groupManager) {
            await safeSendMessage(sock, chatId, { text: '⚠️ Group manager not available.' });
            return;
        }
        let groupName = 'Unknown Group';
        try { groupName = (await sock.groupMetadata(chatId)).subject; } catch {}
        const senderPhone = extractPhoneNumber(senderJid);
        await groupManager.setTgStickerEnabled(chatId, groupName, false, senderPhone);
        await safeSendMessage(sock, chatId, {
            text: '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🛑 *TG STICKER OFF*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                `📢 *Group:* ${groupName}\n\n` +
                '🎭 Telegram sticker import disabled.\n' +
                '💡 `/tgstickeron` to enable again',
        });
    },
    scalpon: async ({ sock, chatId, senderJid, args, ctx }) =>
        scalpAlertPrefs({ sock, chatId, senderJid, argStr: (args || []).join(' '), ctx }),
    scalpoff: async ({ sock, chatId, senderJid, ctx }) => {
        const groupManager = ctx?.groupManager;
        if (!isGroupMessage(chatId)) {
            await safeSendMessage(sock, chatId, { text: 'Use `/scalpoff` in a group.' });
            return;
        }
        if (!groupManager) {
            await safeSendMessage(sock, chatId, { text: '⚠️ Group manager not available.' });
            return;
        }
        let groupName = 'Unknown Group';
        try { groupName = (await sock.groupMetadata(chatId)).subject; } catch {}
        const senderPhone = extractPhoneNumber(senderJid);
        await groupManager.setScalpEnabled(chatId, groupName, false, senderPhone);
        await safeSendMessage(sock, chatId, {
            text: '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🛑 *SCALP OFF*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                `📢 *Group:* ${groupName}\n\n` +
                '⚡ NIFTY micro scalp disabled.\n' +
                '💡 `/scalpon` to enable again',
        });
    },
};

class CommandController {
    constructor(database, botState, groupManager, newsController = null, movieController = null, userManager = null, stickerController = null, botSettings = null, githubTrendingController = null, warnDatabase = null, authDatabase = null, courseAPI = null, awesomeListsController = null) {
        this.database = database;
        this.botState = botState;
        this.groupManager = groupManager;
        this.newsController = newsController;
        this.movieController = movieController;
        this.userManager = userManager;
        this.stickerController = stickerController;
        this.botSettings = botSettings;
        this.githubTrendingController = githubTrendingController;
        this.awesomeListsController = awesomeListsController;
        this.warnDatabase = warnDatabase;
        this.authDatabase = authDatabase;
        this.courseAPI = courseAPI;
        this.assistService = null;
        this.resumeStore = null;
        this.resumeTailorService = null;
        this.interviewQuestionService = null;
        this.banDatabase = null;
        this.roastService = null;
        this.birthdayService = null;
        this.aiUpdatesController = null;
        this.pendingClearConfirmations = new Map();
        this.pendingGithubPosts = createGithubPostSessionStore();
        this.pendingAwesomePosts = createAwesomePostSessionStore();
        this.pendingResumeSessions = createResumeSessionStore();
        this.getSock = null;
        this.whatsappService = null;
        this.groupChatLogService = null;
        this.groupSummaryController = null;
        this.autoChatController = null;
        this.tradeAlertController = null;
        this.svmkrTracker = null;
        this.svmkrScheduler = null;
        this.botStartTime = Date.now();
        this.stickerForwarder = null;
        this.ipoController = null;

        this._isOwnerFromJid = this._isOwnerFromJid.bind(this);
    }

    setResumeTailor(resumeStore, resumeTailorService) {
        this.resumeStore = resumeStore;
        this.resumeTailorService = resumeTailorService;
    }

    setStickerForwarder(stickerForwarder) {
        this.stickerForwarder = stickerForwarder;
    }

    setWhatsAppService(whatsappService) {
        this.whatsappService = whatsappService;
    }

    setGroupChatLogService(groupChatLogService) {
        this.groupChatLogService = groupChatLogService;
    }

    setGroupSummaryController(groupSummaryController) {
        this.groupSummaryController = groupSummaryController;
    }

    setAutoChatController(autoChatController) {
        this.autoChatController = autoChatController;
    }

    setAssistService(assistService) {
        this.assistService = assistService;
    }

    setInterviewQuestionService(interviewQuestionService) {
        this.interviewQuestionService = interviewQuestionService;
    }

    async initBypassController(mongoDb, groupManager) {
        bypassController.mongoDb = mongoDb;
        bypassController.groupManager = groupManager;
        await bypassController.init();
        this.bypassController = bypassController;
    }

    getBypassController() {
        return this.bypassController || bypassController;
    }

    setBanDatabase(banDatabase) {
        this.banDatabase = banDatabase;
    }

    setRoastService(roastService) {
        this.roastService = roastService;
    }

    setBirthdayService(birthdayService) {
        this.birthdayService = birthdayService;
    }

    setAiUpdatesController(aiUpdatesController) {
        this.aiUpdatesController = aiUpdatesController;
    }

    setTradeAlertController(tradeAlertController) {
        this.tradeAlertController = tradeAlertController;
    }

    /** Live SVMKR scanner handles — `/svmkr stats` and `/svmkr scan` need these. */
    setSvmkr({ tracker = null, scheduler = null } = {}) {
        if (tracker) this.svmkrTracker = tracker;
        if (scheduler) this.svmkrScheduler = scheduler;
    }

    setGetSock(getSock) {
        this.getSock = getSock;
    }

    setIpoController(ipoController) {
        this.ipoController = ipoController;
    }

    /**
     * Check if sender is owner — handles LID (Linked ID) resolution for privacy mode
     */
    async _isOwnerFromJid(sock, chatId, senderJid) {
        const directPhone = extractPhoneNumber(senderJid);
        if (this.groupManager.isOwner(directPhone)) return true;

        if (senderJid?.includes('@lid') && chatId?.endsWith('@g.us')) {
            try {
                // O(1) via the cached phoneByKey index — this used to scan every
                // participant, which is 900+ iterations per command in big groups.
                const phone = await this.groupManager.resolveParticipantPhoneCached(
                    sock,
                    chatId,
                    senderJid
                );
                if (phone && this.groupManager.isOwner(phone)) return true;
            } catch {}
        }

        return false;
    }

    /** Shared context passed to every handler */
    _ctx() {
        return {
            database: this.database,
            botState: this.botState,
            groupManager: this.groupManager,
            newsController: this.newsController,
            githubTrendingController: this.githubTrendingController,
            awesomeListsController: this.awesomeListsController,
            warnDatabase: this.warnDatabase,
            banDatabase: this.banDatabase,
            movieController: this.movieController,
            userManager: this.userManager,
            stickerController: this.stickerController,
            stickerForwarder: this.stickerForwarder,
            botSettings: this.botSettings,
            authDatabase: this.authDatabase,
            pendingClearConfirmations: this.pendingClearConfirmations,
            pendingGithubPosts: this.pendingGithubPosts,
            pendingAwesomePosts: this.pendingAwesomePosts,
            pendingResumeSessions: this.pendingResumeSessions,
            resumeStore: this.resumeStore,
            resumeTailorService: this.resumeTailorService,
            getSock: this.getSock,
            whatsappService: this.whatsappService,
            groupChatLogService: this.groupChatLogService,
            groupSummaryController: this.groupSummaryController,
            autoChatController: this.autoChatController,
            tradeAlertController: this.tradeAlertController,
            svmkrTracker: this.svmkrTracker,
            svmkrScheduler: this.svmkrScheduler,
            assistService: this.assistService,
            interviewQuestionService: this.interviewQuestionService,
            roastService: this.roastService,
            birthdayService: this.birthdayService,
            aiUpdatesController: this.aiUpdatesController,
            botStartTime: this.botStartTime,
            courseAPI: this.courseAPI,
            isOwnerFromJid: this._isOwnerFromJid,
            ipoController: this.ipoController,
        };
    }

    async tryHandlePendingInput(sock, chatId, messageText, senderJid, originalMsg = null) {
        if (messageText?.trim()?.startsWith('/')) {
            return false;
        }

        const ctx = { ...this._ctx(), originalMsg };
        const handledResume = await handlePendingResumeInput(
            sock, chatId, senderJid, messageText || '', ctx,
        );
        if (handledResume) {
            return true;
        }

        if (!messageText?.trim()) {
            return false;
        }

        const handledGithub = await handlePendingGithubConfirmation(
            sock, chatId, senderJid, messageText.trim(), ctx,
        );
        if (handledGithub) {
            return true;
        }

        const handledAwesome = await handlePendingAwesomeConfirmation(
            sock, chatId, senderJid, messageText.trim(), ctx,
        );
        if (handledAwesome) {
            return true;
        }

        return false;
    }

    async handleGroupParticipantsUpdate(sock, update) {
        await _handleGroupParticipantsUpdate(sock, update, this._ctx());
    }

    async handleJoinStubMessage(sock, msg) {
        await _handleJoinStubMessage(sock, msg, this._ctx());
    }

    async handleInsta(sock, chatId, args, quotedMessage, options = {}) {
        await _handleInsta(sock, chatId, args, quotedMessage, options);
    }

    async handleCommand(sock, chatId, command, senderJid, originalMsg = null, pushName = '') {
        const parts = command.trim().split(/\s+/);
        const cmd = parts[0].toLowerCase();
        const args = parts.slice(1);
        if (!cmd) return;

        try {
        const def = findCommand(cmd);
        if (!def) {
            // Show suggestions for unknown commands
            const suggestions = findSimilarCommands(cmd);
            if (suggestions.length > 0) {
                const suggestionText = suggestions.map(s => `  • \`${s}\``).join('\n');
                await sendAndDelete(sock, chatId, {
                    text: `❓ Unknown command: \`${cmd}\`\n\n💡 *Did you mean:*\n${suggestionText}\n\n_Type \`/help\` for all commands_\n_⏰ Auto-deletes in 5 hours_`
                }, originalMsg);
            }
                return;
        }

        logger.info(`📝 Command received: ${def.key} from ${senderJid} in ${chatId}`);

        const access = await checkCommandAccess(sock, chatId, senderJid, def, this.groupManager);
        if (!access.ok) {
            await safeSendMessage(sock, chatId, { text: access.message }, originalMsg);
                return;
            }

        const ctx = { ...this._ctx(), originalMsg, replyOpts: getSafeSendOptions(originalMsg), fullCommand: command.trim() };
        const t0 = Date.now();

        const handler = COMMAND_HANDLERS[def.key];
        if (!handler) {
            // Registered but not wired — fail loudly instead of silently no-oping.
            logger.error(`No handler registered for command key '${def.key}'`);
            await plainSendMessage(sock, chatId, {
                text: `⚠️ \`${cmd}\` is registered but not wired up yet — please tell the owner.`,
            }, originalMsg?.key);
            return;
        }

        try {
            await handler({ sock, chatId, senderJid, args, originalMsg, pushName, ctx, fullCommand: command.trim() });
            botTelemetry.track('command', {
                cmd: def.key,
                chatId,
                senderJid,
                pushName: pushName || '',
                status: 'ok',
                ms: Date.now() - t0,
            });
        } catch (err) {
            botTelemetry.track('command', {
                cmd: def.key,
                chatId,
                senderJid,
                pushName: pushName || '',
                status: 'err',
                ms: Date.now() - t0,
                message: String(err?.message || err).slice(0, 160),
            });
            logger.error(`Command handler error (${cmd}): ${err?.message || err}`);
            logger.error(err?.stack);
            await plainSendMessage(sock, chatId, {
                text: '⚠️ Something went wrong running that command. Please try again.',
            }, originalMsg?.key);
        }
        } catch (err) {
            logger.error(`Command dispatch error (${cmd}): ${err?.message || err}`);
        }
    }
}

export default CommandController;
