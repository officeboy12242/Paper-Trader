/**
 * Guided resume tailor:
 * /resume → upload resume → reply with JD → movie-style progress → tailored .txt
 */

import { extractPhoneNumber, isGroupMessage, normalizePhoneNumber } from '../../utils/permissions.js';
import { safeSendMessage } from '../../utils/waMessage.js';
import { hasWaDocument, downloadWaDocument } from '../../utils/waDocument.js';
import { extractResumeText } from '../../utils/resumeTextExtract.js';
import { formatProgressLine } from '../../utils/progressBar.js';
import { parseRewriteMode, parseExportFormat } from '../../prompts/resumeTailorPrompt.js';
import { buildResumePdfBuffer } from '../../utils/resumePdfExport.js';
import { logger } from '../../utils/logger.js';

const SESSION_TTL_MS = 15 * 60 * 1000;

export function createResumeSessionStore() {
    return new Map();
}

function sessionKey(chatId, senderJid) {
    return `${chatId}|${senderJid || ''}`;
}

function resolveUserPhone(chatId, senderJid) {
    const fromSender = normalizePhoneNumber(extractPhoneNumber(senderJid));
    if (fromSender) return fromSender;
    if (!isGroupMessage(chatId)) {
        return normalizePhoneNumber(extractPhoneNumber(chatId));
    }
    return '';
}

function stripCommandPrefix(fullCommand = '') {
    return String(fullCommand || '')
        .replace(/^\/\S+\s*/i, '')
        .trim();
}

function setSession(map, chatId, senderJid, data) {
    map.set(sessionKey(chatId, senderJid), {
        ...data,
        expiresAt: Date.now() + SESSION_TTL_MS,
    });
}

function getLiveSession(map, chatId, senderJid) {
    const key = sessionKey(chatId, senderJid);
    const session = map.get(key);
    if (!session) return null;
    if (Date.now() > (session.expiresAt || 0)) {
        map.delete(key);
        return null;
    }
    return session;
}

async function loadTextFromMsg(sock, originalMsg, pastedText) {
    if (hasWaDocument(originalMsg)) {
        const { buffer, fileName, mimetype } = await downloadWaDocument(sock, originalMsg);
        const extracted = await extractResumeText(buffer, { fileName, mimetype });
        return { ...extracted, fileName, fromFile: true };
    }
    const text = String(pastedText || '').trim();
    if (text.length >= 40) {
        return { text, kind: 'txt', fileName: '', fromFile: false };
    }
    return null;
}

function formatResumeProgress(state) {
    const percent = state.percent ?? 0;
    const modeLabel = state.mode === 'exact' ? 'EXACT JD match' : 'RELATED to JD';
    let msg = '✏️ *$ resume --tailor*\n';
    msg += `> Full rewrite · ${modeLabel}\n`;
    msg += `${formatProgressLine('EDIT', percent, { decimals: 0 })}\n\n`;
    msg += `$ steps\n`;
    msg += `> ${state.stepRead || '⏳'} Read resume & JD\n`;
    msg += `> ${state.stepRewrite || '⏳'} Rewrite all sections\n`;
    msg += `> ${state.stepPack || '⏳'} Package result\n`;
    if (state.detail) {
        msg += `\n_${state.detail}_`;
    }
    return msg.trimEnd();
}

function makeResumeProgressEditor(sock, chatId, messageKey) {
    let closed = false;
    let editTail = Promise.resolve();
    let lastText = '';
    let currentState = {
        percent: 8,
        stepRead: '🔄',
        stepRewrite: '⏳',
        stepPack: '⏳',
        detail: '',
    };

    const queueEdit = () => {
        if (closed || !messageKey?.id || !sock?.sendMessage) return editTail;
        const text = formatResumeProgress(currentState);
        if (text === lastText) return editTail;
        lastText = text;
        const key = {
            remoteJid: chatId || messageKey.remoteJid,
            id: messageKey.id,
            fromMe: true,
            ...(messageKey.participant ? { participant: messageKey.participant } : {}),
        };
        editTail = editTail
            .then(async () => {
                if (closed) return;
                try {
                    await sock.sendMessage(chatId, { text, edit: key, linkPreview: false });
                } catch (err) {
                    logger.warn(`Resume progress edit skipped: ${err?.message || err}`);
                }
            })
            .catch(() => {});
        return editTail;
    };

    return {
        async flush(patch = {}) {
            if (closed) return;
            currentState = { ...currentState, ...patch };
            await queueEdit();
        },
        async close() {
            closed = true;
            await editTail.catch(() => {});
            await new Promise((r) => setTimeout(r, 500));
        },
    };
}

async function deleteProgressMessage(sock, chatId, messageKey) {
    if (!messageKey?.id || !sock?.sendMessage) return;
    const key = {
        remoteJid: chatId || messageKey.remoteJid,
        id: messageKey.id,
        fromMe: true,
        ...(messageKey.participant ? { participant: messageKey.participant } : {}),
    };
    for (let i = 0; i < 2; i++) {
        try {
            await sock.sendMessage(chatId, { delete: key });
            return;
        } catch {
            await new Promise((r) => setTimeout(r, 400));
        }
    }
}

async function askForJd(sock, chatId, originalMsg, meta, pendingResumeSessions, senderJid, phone, resumeText, palette = null, typography = null) {
    setSession(pendingResumeSessions, chatId, senderJid, {
        mode: 'await_jd',
        phone,
        resumeText,
        palette: palette || meta.palette || null,
        typography: typography || meta.typography || null,
        fileName: meta.fileName || '',
        kind: meta.kind || '',
    });

    const src = meta.fromFile
        ? `${(meta.kind || 'file').toUpperCase()}${meta.fileName ? `: ${meta.fileName}` : ''}`
        : 'pasted text';

    await safeSendMessage(
        sock,
        chatId,
        {
            text:
                '✅ *Resume received*\n\n' +
                `📄 ${src}\n` +
                `🔤 ~${meta.textLength || resumeText.length} chars saved\n\n` +
                '🎯 *Next:* reply to *this* message with the *job description*\n' +
                '(paste JD text, or attach PDF/DOC/DOCX/TXT).\n\n' +
                '_Waiting 15 minutes… `/resume cancel` to stop_',
        },
        originalMsg
    );
}

async function askForMode(sock, chatId, originalMsg, pendingResumeSessions, senderJid, phone, resumeText, jdText, palette = null, typography = null) {
    setSession(pendingResumeSessions, chatId, senderJid, {
        mode: 'await_mode',
        phone,
        resumeText,
        jdText,
        palette,
        typography,
    });

    await safeSendMessage(
        sock,
        chatId,
        {
            text:
                '✅ *JD received*\n\n' +
                'How should I rewrite the *whole* resume?\n\n' +
                '1️⃣ *Exact* — ~75% JD wording / ~25% your hard facts (aggressive ATS rewrite)\n' +
                '2️⃣ *Related* — natural rewrite with stronger ATS keywords + HR-friendly bullets\n\n' +
                'Reply with `1` or `2` (or `exact` / `related`).\n\n' +
                '_Waiting 15 minutes… `/resume cancel` to stop_',
        },
        originalMsg
    );
}

async function askForFormat(sock, chatId, originalMsg, pendingResumeSessions, senderJid, phone, resumeText, jdText, rewriteMode, palette = null, typography = null) {
    setSession(pendingResumeSessions, chatId, senderJid, {
        mode: 'await_format',
        phone,
        resumeText,
        jdText,
        rewriteMode,
        palette,
        typography,
    });

    await safeSendMessage(
        sock,
        chatId,
        {
            text:
                '📦 *Output format*\n\n' +
                'How should I send the revised resume?\n\n' +
                '1️⃣ *TXT* — plain text (layout as text)\n' +
                '2️⃣ *PDF* — resume PDF matching your layout family, section order, and colors when available\n\n' +
                'Reply with `1` or `2` (or `txt` / `pdf`).\n\n' +
                '_Waiting 15 minutes… `/resume cancel` to stop_',
        },
        originalMsg
    );
}

/**
 * /resume — guided tailor (aliases: /cv, /setcv, /mycv)
 */
export async function handleCv(sock, chatId, senderJid, args, ctx) {
    const { pendingResumeSessions, fullCommand, originalMsg, resumeStore, resumeTailorService } = ctx;
    const action = String(args[0] || '').toLowerCase();

    if (action === 'cancel') {
        pendingResumeSessions?.delete(sessionKey(chatId, senderJid));
        await safeSendMessage(sock, chatId, { text: '❎ Resume tailor cancelled.' }, originalMsg);
        return;
    }

    if (!resumeStore || !resumeTailorService) {
        await safeSendMessage(sock, chatId, { text: '⚠️ Resume tailor is not available.' }, originalMsg);
        return;
    }
    if (!resumeTailorService.isConfigured()) {
        await safeSendMessage(
            sock,
            chatId,
            { text: '⚠️ AI not configured. Set GEMINI / GROQ / NVIDIA / OPENROUTER API key.' },
            originalMsg
        );
        return;
    }

    const phone = resolveUserPhone(chatId, senderJid);
    if (!phone) {
        await safeSendMessage(sock, chatId, { text: '⚠️ Could not identify your number.' }, originalMsg);
        return;
    }

    const pasted = stripCommandPrefix(fullCommand);
    // If user typed "/resume some jd..." without a file, still start upload step (ignore short args like cancel)
    const earlyPaste = pasted.replace(/^(cancel)\b/i, '').trim();

    let loaded = null;
    try {
        loaded = await loadTextFromMsg(sock, originalMsg, earlyPaste.length >= 40 ? earlyPaste : '');
    } catch (err) {
        await safeSendMessage(sock, chatId, { text: `❌ ${err.message}` }, originalMsg);
        return;
    }

    if (loaded) {
        await resumeStore.saveBase({
            phone,
            chatId,
            text: loaded.text,
            fileName: loaded.fileName,
            kind: loaded.kind,
            palette: loaded.palette || null,
            typography: loaded.typography || null,
        });
        await askForJd(sock, chatId, originalMsg, {
            ...loaded,
            textLength: loaded.text.length,
        }, pendingResumeSessions, senderJid, phone, loaded.text, loaded.palette || null, loaded.typography || null);
        return;
    }

    setSession(pendingResumeSessions, chatId, senderJid, {
        mode: 'await_resume',
        phone,
    });

    await safeSendMessage(
        sock,
        chatId,
        {
            text:
                '📄 *Resume tailor*\n\n' +
                'Step 1/4 — send your resume as *PDF*, *DOC*, *DOCX*, or *TXT*\n' +
                '(or paste the full resume text).\n\n' +
                'Then: JD → rewrite style (*exact*/*related*) → output (*txt*/*pdf*).\n\n' +
                '_Waiting 15 minutes… `/resume cancel` to stop_',
        },
        originalMsg
    );
}

/** @deprecated alias kept for registry key `tailor` — jump to JD if resume exists */
export async function handleTailor(sock, chatId, senderJid, args, ctx) {
    const { resumeStore, resumeTailorService, pendingResumeSessions, fullCommand, originalMsg } = ctx;
    if (!resumeStore || !resumeTailorService?.isConfigured()) {
        await safeSendMessage(sock, chatId, { text: '⚠️ Resume tailor not available. Use `/resume`.' }, originalMsg);
        return;
    }

    const phone = resolveUserPhone(chatId, senderJid);
    const profile = phone ? await resumeStore.getByPhone(phone) : null;
    if (!profile?.text?.trim()) {
        await handleCv(sock, chatId, senderJid, args, ctx);
        return;
    }

    const pasted = stripCommandPrefix(fullCommand) || args.join(' ').trim();
    let jdText = '';
    try {
        if (hasWaDocument(originalMsg)) {
            const { buffer, fileName, mimetype } = await downloadWaDocument(sock, originalMsg);
            jdText = (await extractResumeText(buffer, { fileName, mimetype })).text;
        } else if (pasted.length >= 40) {
            jdText = pasted;
        }
    } catch (err) {
        await safeSendMessage(sock, chatId, { text: `❌ ${err.message}` }, originalMsg);
        return;
    }

    if (jdText) {
        await askForMode(
            sock,
            chatId,
            originalMsg,
            pendingResumeSessions,
            senderJid,
            phone,
            profile.text,
            jdText,
            profile.palette || null,
            profile.typography || null
        );
        return;
    }

    await askForJd(sock, chatId, originalMsg, {
        fromFile: false,
        kind: profile.kind || 'txt',
        fileName: profile.file_name || '',
        textLength: profile.text.length,
        palette: profile.palette || null,
        typography: profile.typography || null,
    }, pendingResumeSessions, senderJid, phone, profile.text, profile.palette || null, profile.typography || null);
}

async function runTailor(sock, chatId, phone, baseText, jdText, rewriteMode, exportFormat, ctx, palette = null, typography = null) {
    const { resumeStore, resumeTailorService, originalMsg } = ctx;
    const mode = rewriteMode === 'exact' ? 'exact' : 'related';
    const format = exportFormat === 'pdf' ? 'pdf' : 'txt';

    let resolvedPalette = palette;
    let resolvedTypography = typography;
    if ((!resolvedPalette || !resolvedTypography) && resumeStore) {
        const profile = await resumeStore.getByPhone(phone);
        resolvedPalette = resolvedPalette || profile?.palette || null;
        resolvedTypography = resolvedTypography || profile?.typography || null;
    }

    const searchingMsg = await safeSendMessage(
        sock,
        chatId,
        { text: formatResumeProgress({ percent: 8, mode, stepRead: '🔄', stepRewrite: '⏳', stepPack: '⏳' }) },
        originalMsg
    );
    const progress = makeResumeProgressEditor(sock, chatId, searchingMsg?.key);

    try {
        await progress.flush({
            percent: 20,
            mode,
            stepRead: '✅',
            stepRewrite: '🔄',
            detail: mode === 'exact' ? 'Full exact rewrite…' : 'Full related rewrite…',
        });

        const resultPromise = resumeTailorService.tailor({
            baseResume: baseText,
            jobDescription: jdText,
            mode,
        });

        await progress.flush({
            percent: 45,
            mode,
            stepRewrite: '🔄',
            detail: 'Rewriting summary, skills, experience, projects…',
        });
        const result = await resultPromise;

        await progress.flush({
            percent: 85,
            mode,
            stepRewrite: '✅',
            stepPack: '🔄',
            detail: format === 'pdf' ? 'Building PDF…' : 'Saving TXT…',
        });

        await resumeStore.saveTailorResult(phone, chatId, {
            jdText,
            tailoredText: result.tailored,
            gapsText: result.gaps,
        });

        const baseName = mode === 'exact' ? 'resume-exact-jd' : 'resume-related-jd';
        let fileBuffer;
        let mimetype;
        let fileName;

        if (format === 'pdf') {
            fileBuffer = await buildResumePdfBuffer(result.tailored, {
                title: baseName,
                baseText,
                palette: resolvedPalette,
                typography: resolvedTypography,
            });
            mimetype = 'application/pdf';
            fileName = `${baseName}.pdf`;
        } else {
            fileBuffer = Buffer.from(result.tailored, 'utf8');
            mimetype = 'text/plain';
            fileName = `${baseName}.txt`;
        }

        await progress.flush({ percent: 100, mode, stepPack: '✅', detail: 'Done' });
        await progress.close();
        await deleteProgressMessage(sock, chatId, searchingMsg?.key);

        const gapsPreview = (result.gaps || '').slice(0, 1200);
        const modeTitle = mode === 'exact' ? 'Exact JD match' : 'Related to JD';
        await safeSendMessage(
            sock,
            chatId,
            {
                text:
                    `✅ *Full revised resume ready* (${modeTitle} · ${format.toUpperCase()})\n\n` +
                    `*Gaps vs JD:*\n${gapsPreview || 'None'}\n\n` +
                    (result.keywords ? `*Keywords:* ${result.keywords.slice(0, 400)}\n\n` : '') +
                    `📄 Complete rewrite attached as \`${fileName}\`.\n` +
                    'Run `/resume` again for another JD, or `/cover` for a cover letter.',
            },
            originalMsg
        );

        await safeSendMessage(
            sock,
            chatId,
            {
                document: fileBuffer,
                mimetype,
                fileName,
            },
            originalMsg
        );
    } catch (err) {
        logger.error(`Resume tailor failed: ${err.message}`);
        try {
            await progress.close();
        } catch {}
        await deleteProgressMessage(sock, chatId, searchingMsg?.key);
        await safeSendMessage(sock, chatId, { text: `❌ Tailor failed: ${err.message}` }, originalMsg);
    }
}

export async function handleCover(sock, chatId, senderJid, args, ctx) {
    const { resumeStore, resumeTailorService, fullCommand, originalMsg } = ctx;

    if (!resumeStore || !resumeTailorService?.isConfigured()) {
        await safeSendMessage(sock, chatId, { text: '⚠️ Cover letter needs AI + `/resume` first.' }, originalMsg);
        return;
    }

    const phone = resolveUserPhone(chatId, senderJid);
    const profile = phone ? await resumeStore.getByPhone(phone) : null;
    if (!profile?.text?.trim()) {
        await safeSendMessage(sock, chatId, { text: '❌ Save a resume with `/resume` first.' }, originalMsg);
        return;
    }

    let jdText = profile.last_jd || '';
    const pasted = stripCommandPrefix(fullCommand) || args.join(' ').trim();
    try {
        if (hasWaDocument(originalMsg)) {
            const { buffer, fileName, mimetype } = await downloadWaDocument(sock, originalMsg);
            jdText = (await extractResumeText(buffer, { fileName, mimetype })).text;
        } else if (pasted.length >= 40) {
            jdText = pasted;
        }
    } catch (err) {
        await safeSendMessage(sock, chatId, { text: `❌ ${err.message}` }, originalMsg);
        return;
    }

    if (!jdText?.trim()) {
        await safeSendMessage(
            sock,
            chatId,
            { text: '❌ No JD yet. Finish `/resume` (upload + JD), or paste/attach a JD with `/cover`.' },
            originalMsg
        );
        return;
    }

    await safeSendMessage(sock, chatId, { text: '⏳ Writing cover letter…' }, originalMsg);
    try {
        const { text } = await resumeTailorService.coverLetter({
            baseResume: profile.text,
            jobDescription: jdText,
        });
        await safeSendMessage(sock, chatId, { text: `✉️ *Cover letter*\n\n${text}` }, originalMsg);
    } catch (err) {
        await safeSendMessage(sock, chatId, { text: `❌ ${err.message}` }, originalMsg);
    }
}

/**
 * Pending steps after /resume (resume → JD → mode).
 * @returns {Promise<boolean>}
 */
export async function handlePendingResumeInput(sock, chatId, senderJid, messageText, ctx) {
    const { pendingResumeSessions, originalMsg, resumeStore } = ctx;
    if (!pendingResumeSessions) return false;

    const session = getLiveSession(pendingResumeSessions, chatId, senderJid);
    if (!session) return false;

    const hasDoc = hasWaDocument(originalMsg);
    const pasted = String(messageText || '').trim();

    // Short choices ("1" / "2") — handle before the length gate
    if (session.mode === 'await_mode') {
        const rewriteMode = parseRewriteMode(pasted);
        if (!rewriteMode) {
            await safeSendMessage(
                sock,
                chatId,
                { text: 'Reply with `1` (*exact*) or `2` (*related*).' },
                originalMsg
            );
            return true;
        }

        const phone = session.phone || resolveUserPhone(chatId, senderJid);
        let baseText = session.resumeText;
        if (!baseText) {
            const profile = await resumeStore.getByPhone(phone);
            baseText = profile?.text || '';
        }
        if (!baseText || !session.jdText) {
            pendingResumeSessions.delete(sessionKey(chatId, senderJid));
            await safeSendMessage(sock, chatId, { text: '❌ Session incomplete — start over with `/resume`.' }, originalMsg);
            return true;
        }

        await askForFormat(
            sock,
            chatId,
            originalMsg,
            pendingResumeSessions,
            senderJid,
            phone,
            baseText,
            session.jdText,
            rewriteMode,
            session.palette || null,
            session.typography || null
        );
        return true;
    }

    if (session.mode === 'await_format') {
        const exportFormat = parseExportFormat(pasted);
        if (!exportFormat) {
            await safeSendMessage(
                sock,
                chatId,
                { text: 'Reply with `1` (*txt*) or `2` (*pdf*).' },
                originalMsg
            );
            return true;
        }

        pendingResumeSessions.delete(sessionKey(chatId, senderJid));

        const phone = session.phone || resolveUserPhone(chatId, senderJid);
        let baseText = session.resumeText;
        let palette = session.palette || null;
        let typography = session.typography || null;
        if (!baseText) {
            const profile = await resumeStore.getByPhone(phone);
            baseText = profile?.text || '';
            palette = palette || profile?.palette || null;
            typography = typography || profile?.typography || null;
        }
        if (!baseText || !session.jdText || !session.rewriteMode) {
            await safeSendMessage(sock, chatId, { text: '❌ Session incomplete — start over with `/resume`.' }, originalMsg);
            return true;
        }

        await runTailor(
            sock,
            chatId,
            phone,
            baseText,
            session.jdText,
            session.rewriteMode,
            exportFormat,
            ctx,
            palette,
            typography
        );
        return true;
    }

    if (!hasDoc && pasted.length < 40) {
        return false;
    }

    if (session.mode === 'await_resume') {
        pendingResumeSessions.delete(sessionKey(chatId, senderJid));

        let loaded;
        try {
            loaded = await loadTextFromMsg(sock, originalMsg, pasted);
        } catch (err) {
            await safeSendMessage(sock, chatId, { text: `❌ ${err.message}` }, originalMsg);
            setSession(pendingResumeSessions, chatId, senderJid, {
                mode: 'await_resume',
                phone: session.phone,
            });
            return true;
        }

        if (!loaded) {
            setSession(pendingResumeSessions, chatId, senderJid, {
                mode: 'await_resume',
                phone: session.phone,
            });
            return false;
        }

        const phone = session.phone || resolveUserPhone(chatId, senderJid);
        await resumeStore.saveBase({
            phone,
            chatId,
            text: loaded.text,
            fileName: loaded.fileName,
            kind: loaded.kind,
            palette: loaded.palette || null,
            typography: loaded.typography || null,
        });

        await askForJd(sock, chatId, originalMsg, {
            ...loaded,
            textLength: loaded.text.length,
        }, pendingResumeSessions, senderJid, phone, loaded.text, loaded.palette || null, loaded.typography || null);
        return true;
    }

    if (session.mode === 'await_jd') {
        pendingResumeSessions.delete(sessionKey(chatId, senderJid));

        let jdText = pasted;
        try {
            if (hasDoc) {
                const { buffer, fileName, mimetype } = await downloadWaDocument(sock, originalMsg);
                jdText = (await extractResumeText(buffer, { fileName, mimetype })).text;
            }
        } catch (err) {
            await safeSendMessage(sock, chatId, { text: `❌ ${err.message}` }, originalMsg);
            setSession(pendingResumeSessions, chatId, senderJid, {
                mode: 'await_jd',
                phone: session.phone,
                resumeText: session.resumeText,
                palette: session.palette || null,
                typography: session.typography || null,
            });
            return true;
        }

        if (!jdText || jdText.length < 40) {
            setSession(pendingResumeSessions, chatId, senderJid, {
                mode: 'await_jd',
                phone: session.phone,
                resumeText: session.resumeText,
                palette: session.palette || null,
                typography: session.typography || null,
            });
            await safeSendMessage(
                sock,
                chatId,
                { text: '⚠️ JD looks too short. Reply again with the full job description (40+ chars).' },
                originalMsg
            );
            return true;
        }

        const phone = session.phone || resolveUserPhone(chatId, senderJid);
        let baseText = session.resumeText;
        let palette = session.palette || null;
        let typography = session.typography || null;
        if (!baseText) {
            const profile = await resumeStore.getByPhone(phone);
            baseText = profile?.text || '';
            palette = palette || profile?.palette || null;
            typography = typography || profile?.typography || null;
        }
        if (!baseText) {
            await safeSendMessage(sock, chatId, { text: '❌ Resume missing — start over with `/resume`.' }, originalMsg);
            return true;
        }

        await askForMode(
            sock,
            chatId,
            originalMsg,
            pendingResumeSessions,
            senderJid,
            phone,
            baseText,
            jdText,
            palette,
            typography
        );
        return true;
    }

    return false;
}
