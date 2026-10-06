/**
 * /roast — AI resume roast for students.
 *
 * Member sends a resume PDF/DOCX/TXT (attached, or quoted after /roast) and the
 * bot replies with a funny-but-usable roast: an ATS-style score, formatting and
 * impact-verb feedback, and a concrete fix list — all from the same multi-
 * provider LLM router as the resume tailor (gemini → groq → nvidia →
 * openrouter), so one provider's rate limit never kills the feature.
 *
 * Anti-abuse: per-phone daily limit (IST day) stored in Mongo.
 */

import { logger } from '../utils/logger.js';
import { config } from '../config/config.js';
import { extractResumeText } from '../utils/resumeTextExtract.js';
import { extractPhoneNumber } from '../utils/permissions.js';
import { getTodayDateStrIST } from '../utils/dateIST.js';
import AssistLlmRouter from './AssistLlmRouter.js';

const MAX_PDF_BYTES = 8 * 1024 * 1024;

const SYSTEM_PROMPT = [
    'You are "Roast Master", a senior technical recruiter who reviews resumes of Indian college students.',
    'Your roasts are funny and a little savage but ALWAYS useful — every joke must be attached to a concrete fix.',
    'Never invent facts about the candidate; comment only on what is in the resume text.',
    'Keep the whole reply under 2200 characters so it fits one WhatsApp message.',
    'Format your reply EXACTLY like this (WhatsApp markdown, *bold*, _italic_):',
    '🔥 *ROAST SCORE: <0-100>/100* — <one-line verdict with a joke>',
    '',
    '*What works*',
    '- <1-2 short bullets, may be absent if truly nothing does>',
    '',
    '*Getting roasted*',
    '- <3-5 bullets: the funniest real problems — vague bullets, filler skills, formatting, typos>',
    '',
    '*Fix list (do these)*',
    '1. <highest-impact fix>',
    '2. <second fix>',
    '3. <third fix>',
    '',
    '_Verdict:_ <one funny closing line + one encouraging line>',
].join('\n');

function userBlock(resumeText, displayName) {
    const trimmed = String(resumeText || '').slice(0, 24_000);
    return [
        `Roast this resume. The candidate's name (if present) is "${displayName || 'unknown'}".`,
        'Score honestly: 90+ means recruiter-ready, 60-75 is a typical student resume, below 40 needs a rewrite.',
        'If the text looks like it is not a resume at all, say so in the verdict line and score it 0-10.',
        '',
        '--- RESUME TEXT START ---',
        trimmed,
        '--- RESUME TEXT END ---',
    ].join('\n');
}

/** Parse the LLM reply into { score, body } so the footer can append provider info. */
export function parseRoastOutput(text) {
    const raw = String(text || '').trim();
    const m = /ROAST SCORE:\s*(\d{1,3})\s*\/\s*100/i.exec(raw);
    const score = m ? Math.max(0, Math.min(100, Number(m[1]))) : null;
    return { score, body: raw };
}

export default class RoastService {
    constructor({ mongoDb, cfg = config } = {}) {
        this.cfg = cfg;
        this.llm = new AssistLlmRouter(cfg);
        this.mongoDb = mongoDb || null;
        this.col = null;
    }

    async init() {
        if (!this.mongoDb) return;
        this.col = this.mongoDb.collection('resume_roasts');
        await this.col.createIndex(
            { phone: 1, day: 1 },
            { name: 'roast_phone_day' }
        );
        await this.col.createIndex(
            { created_at: 1 },
            { name: 'roast_created_at', expireAfterSeconds: 60 * 60 * 24 * 45 }
        );
        logger.info('Roast service ready');
    }

    isConfigured() {
        return this.cfg.ROAST_ENABLED !== false && this.llm.isConfigured();
    }

    /** @returns {Promise<{ used: number, limit: number }>} */
    async usageToday(phone) {
        const limit = Math.max(1, Number(this.cfg.ROAST_DAILY_LIMIT) || 2);
        if (!this.col) return { used: 0, limit };
        const day = getTodayDateStrIST();
        const used = await this.col.countDocuments({ phone: String(phone), day });
        return { used, limit };
    }

    /**
     * Full pipeline: download → extract → daily-limit → LLM roast.
     * Throws Error with a user-friendly message on any expected failure.
     * @returns {Promise<{ text: string, score: number|null, provider: string, model: string }>}
     */
    async roastDocument({ sock, waMessage, senderJid, displayName = '', bypassLimit = false }) {
        let buffer, fileName, mimetype;
        try {
            const { downloadWaDocument } = await import('../utils/waDocument.js');
            const dl = await downloadWaDocument(sock, waMessage);
            buffer = dl.buffer;
            fileName = dl.fileName;
            mimetype = dl.mimetype;
        } catch (err) {
            // Download failures are NOT LLM problems — keep the message actionable.
            const raw = String(err?.message || err);
            let tip = raw;
            if (/no document found/i.test(raw)) {
                tip =
                    'No resume file on that message. Send a PDF/DOCX with `/roast` as the caption, or reply to the file with `/roast`.';
            } else if (/media unavailable|not a media message|no media/i.test(raw)) {
                tip =
                    'WhatsApp did not give us the file bytes (common when *replying* to an old PDF). Re-send the resume *with* `/roast` in the caption.';
            } else if (/timed? ?out/i.test(raw)) {
                tip = 'Download timed out — try again with a smaller PDF (under 8 MB).';
            } else {
                tip = `Could not download the file: ${raw}`;
            }
            const e = new Error(tip);
            e.userFriendly = true;
            throw e;
        }
        if (buffer.length > MAX_PDF_BYTES) {
            const err = new Error('File too big (max 8 MB). Export a lighter PDF.');
            err.userFriendly = true;
            throw err;
        }

        let extracted;
        try {
            extracted = await extractResumeText(buffer, { fileName, mimetype });
        } catch (err) {
            const e = new Error(`Could not read that file: ${err.message}`);
            e.userFriendly = true;
            throw e;
        }

        return this.roastText({
            resumeText: extracted.text,
            senderJid,
            displayName,
            bypassLimit,
        });
    }

    /** Daily-limit + LLM roast for already-extracted resume text. */
    async roastText({ resumeText, senderJid, displayName = '', bypassLimit = false }) {
        if (!this.isConfigured()) {
            const err = new Error('Roast is offline — no LLM key configured. Tell the bot owner.');
            err.userFriendly = true;
            throw err;
        }

        const phone = extractPhoneNumber(senderJid) || senderJid;
        if (!bypassLimit) {
            const { used, limit } = await this.usageToday(phone);
            if (used >= limit) {
                const err = new Error(`Daily roast limit reached (${used}/${limit}). Come back tomorrow — your resume is not going anywhere. 😄`);
                err.userFriendly = true;
                throw err;
            }
        }

        const { text, provider, model } = await this.llm.completeChat({
            systemPrompt: SYSTEM_PROMPT,
            history: [],
            userBlock: userBlock(resumeText, displayName),
            maxTokens: 1400,
            temperature: 0.85,
            maxChars: 2400,
        });

        const { score, body } = parseRoastOutput(text);

        // Log after success only — failed attempts do not consume the quota.
        await this._log({ phone, chatJid: senderJid, score, provider, model, chars: String(resumeText).length });

        return { text: body, score, provider, model };
    }

    async _log({ phone, chatJid, score, provider, model, chars }) {
        try {
            if (!this.col) return;
            await this.col.insertOne({
                phone: String(phone),
                chat_jid: chatJid,
                day: getTodayDateStrIST(),
                score: Number.isFinite(score) ? score : null,
                provider,
                model,
                resume_chars: chars,
                created_at: new Date(),
            });
        } catch (err) {
            logger.warn(`Roast log failed: ${err.message}`);
        }
    }
}
