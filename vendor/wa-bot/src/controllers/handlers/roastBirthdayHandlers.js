/**
 * Handlers for /roast and /birthday commands.
 */

import { logger } from '../../utils/logger.js';
import { safeSendMessage } from '../../utils/waMessage.js';
import { isGroupMessage, extractPhoneNumber } from '../../utils/permissions.js';
import { hasWaDocument } from '../../utils/waDocument.js';
import { indexParticipantsByDigits, resolveMentionIdentity } from '../../utils/welcomeMessage.js';

const ROAST_USAGE =
    '🔥 *AI Resume Roast*\n\n' +
    'Send your resume PDF here *with* `/roast` as the caption.\n' +
    '(Replying `/roast` to an old file often fails — WhatsApp strips the bytes.)\n\n' +
    'You get: roast score /100, what works, what gets roasted, and a fix list.\n\n' +
    '_PDF / DOCX / TXT up to 8 MB._';

/**
 * /roast — attach a resume PDF with /roast as caption, or quote a resume.
 */
export async function handleRoast({ sock, chatId, senderJid, originalMsg, pushName, ctx }) {
    const service = ctx?.roastService;
    if (!service) {
        await safeSendMessage(sock, chatId, { text: '⚠️ Roast service is not ready yet — try again in a minute.' }, originalMsg);
        return;
    }

    const hasDoc = hasWaDocument(originalMsg);
    if (!hasDoc) {
        await safeSendMessage(sock, chatId, { text: ROAST_USAGE }, originalMsg);
        return;
    }

    const progressMsg = await safeSendMessage(
        sock,
        chatId,
        { text: '🔥 *Downloading resume…* preparing the roast 🔥' },
        originalMsg
    );

    try {
        const displayName = String(pushName || '').trim();
        // Owner roasts unlimited (testing / demos); everyone else has a daily limit.
        const bypassLimit = ctx?.isOwnerFromJid
            ? await ctx.isOwnerFromJid(sock, chatId, senderJid)
            : false;
        const result = await service.roastDocument({
            sock,
            waMessage: originalMsg,
            senderJid,
            displayName,
            bypassLimit,
        });

        const footer =
            `\n\n_Grilled by ${result.provider}/${result.model}_` +
            `\n_Another one? Send a fresh PDF with /roast._`;
        await safeSendMessage(
            sock,
            chatId,
            { text: `${result.text}${footer}` },
            originalMsg
        );
        logger.info(`🔥 Roast delivered to ${chatId} via ${result.provider} (score ${result.score ?? '?'})`);
    } catch (err) {
        const friendly = err?.userFriendly ? err.message : null;
        logger.warn(`Roast failed for ${chatId}: ${err.message}`);
        const reason = friendly
            ? ''
            : String(err?.message || '').slice(0, 120);
        await safeSendMessage(
            sock,
            chatId,
            {
                text:
                    friendly ||
                    `💀 The grill broke mid-roast (LLM hiccup: ${reason || 'all providers failed'}). ` +
                        'Try again in a minute — the fallback providers usually catch it.',
            },
            originalMsg
        );
    } finally {
        try {
            if (progressMsg?.key) await sock.sendMessage(chatId, { delete: progressMsg.key });
        } catch {}
    }
}

const IST_TIME_FMT = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
});

/**
 * /birthday — add/remove/list birthdays in a group.
 *   /birthday add 14-11 [optional: quote or reply does nothing special]
 *   /birthday list
 *   /birthday remove
 *   /birthday check — owner only: has today's celebrant(s) been wished, and
 *     when — retries (sends now) anyone still pending
 */
export async function handleBirthday({ sock, chatId, senderJid, args, originalMsg, ctx }) {
    const service = ctx?.birthdayService;
    if (!service) {
        await safeSendMessage(sock, chatId, { text: '⚠️ Birthday service is not ready yet — try again in a minute.' }, originalMsg);
        return;
    }
    if (!isGroupMessage(chatId)) {
        await safeSendMessage(sock, chatId, { text: '❌ Birthdays work in groups only — add yours in your class/community group.' }, originalMsg);
        return;
    }

    const sub = String(args?.[0] || '').toLowerCase();
    const phone = extractPhoneNumber(senderJid);

    if (sub === 'add' || sub === 'set') {
        const res = await service.addBirthday({
            groupId: chatId,
            senderJid,
            rawDate: args?.slice(1).join(' ') || '',
        });
        await safeSendMessage(sock, chatId, { text: res.message }, originalMsg);
        return;
    }

    if (sub === 'remove' || sub === 'delete' || sub === 'off') {
        if (!phone) {
            await safeSendMessage(sock, chatId, { text: 'Could not read your number from this chat.' }, originalMsg);
            return;
        }
        const res = await service.removeBirthday(chatId, phone);
        await safeSendMessage(sock, chatId, { text: res.message }, originalMsg);
        return;
    }

    if (sub === 'check' || sub === 'retry' || sub === 'status') {
        const isOwner = ctx?.isOwnerFromJid ? await ctx.isOwnerFromJid(sock, chatId, senderJid) : false;
        if (!isOwner) {
            await safeSendMessage(
                sock,
                chatId,
                { text: '🔒 `/birthday check` is owner-only — it force-sends real wishes, not just a status peek.' },
                originalMsg
            );
            return;
        }

        const { hasBirthdayToday, results, error } = await service.checkAndWish({ groupId: chatId, sock });

        if (error === 'no-socket') {
            await safeSendMessage(sock, chatId, { text: '⚠️ No WhatsApp connection available right now — try again shortly.' }, originalMsg);
            return;
        }
        if (!hasBirthdayToday) {
            await safeSendMessage(sock, chatId, { text: '📅 No birthdays today in this group.' }, originalMsg);
            return;
        }

        // A resolved display name reads far better than raw stored digits (which
        // can be a phone number OR a WhatsApp @lid pseudo-ID) — but this is an
        // owner-facing status report, not the wish itself, so it deliberately
        // does NOT @mention the celebrant again on top of their actual wish.
        const lines = results.map((r) => {
            const when = r.at ? IST_TIME_FMT.format(new Date(r.at)) : 'unknown time';
            const who = r.name ? `${r.name} (+${r.phone})` : `+${r.phone}`;
            if (r.status === 'sent') return `🎉 ${who} — wished just now at ${when}`;
            if (r.status === 'already') return `✅ ${who} — already wished today at ${when}`;
            return `⚠️ ${who} — send failed (${r.error || 'unknown error'}); will retry on the next check`;
        });

        await safeSendMessage(sock, chatId, { text: `🎂 *Birthday check*\n\n${lines.join('\n')}` }, originalMsg);
        return;
    }

    if (sub === 'list') {
        const rows = await service.listBirthdays(chatId);
        if (!rows.length) {
            await safeSendMessage(sock, chatId, { text: '📅 No birthdays saved here yet. `/birthday add DD-MM` to add yours!' }, originalMsg);
            return;
        }
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit' }).format(new Date());
        const [tD, tM] = today.split('-').map(Number);

        // The stored `phone` is bare digits with no record of which domain they
        // came from (@s.whatsapp.net vs @lid) — match against the group's live
        // participant list to tag the right one instead of guessing the domain.
        let digitIndex = new Map();
        try {
            const meta = await ctx?.groupManager?.getGroupMetadataCached?.(sock, chatId);
            digitIndex = indexParticipantsByDigits(meta?.participants);
        } catch (err) {
            logger.debug(`Birthday list: group metadata fetch failed: ${err.message}`);
        }

        const mentionSet = new Set();
        const lines = rows.map((r) => {
            const isToday = r.dd === tD && r.mm === tM;
            const participant = digitIndex.get(String(r.phone));
            if (participant) {
                for (const m of resolveMentionIdentity(participant).mentions) mentionSet.add(m);
            } else {
                mentionSet.add(`${r.phone}@s.whatsapp.net`);
            }
            return `${isToday ? '🎉' : '•'} ${String(r.dd).padStart(2, '0')}-${String(r.mm).padStart(2, '0')} → @${r.phone}${isToday ? ' (today!)' : ''}`;
        });
        const mentions = [...mentionSet];
        await safeSendMessage(
            sock,
            chatId,
            {
                text: `🎂 *Birthdays in this group*\n\n${lines.join('\n')}\n\n_Add yours: /birthday add DD-MM_`,
                mentions,
            },
            originalMsg
        );
        return;
    }

    // No/unknown subcommand → own birthday + help
    const own = await service.col?.findOne?.({ group_id: chatId, phone: String(phone) }) ?? null;
    const ownLine = own ? `Your birthday here: *${String(own.dd).padStart(2, '0')}-${String(own.mm).padStart(2, '0')}*\n\n` : '';
    await safeSendMessage(
        sock,
        chatId,
        {
            text:
                `🎂 *Birthday wishes*\n\n` +
                `${ownLine}` +
                `• \`/birthday add DD-MM\` — save your birthday (year optional)\n` +
                `• \`/birthday list\` — see the group's birthdays\n` +
                `• \`/birthday remove\` — stop wishes for you\n` +
                `• \`/birthday check\` — _(owner)_ has today's celebrant been wished, and when? Retries if not\n\n` +
                `_On your day the bot posts an AI-written wish and tags you 🎉_`,
        },
        originalMsg
    );
}
