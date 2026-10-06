/**
 * AI generation + WhatsApp poll/answer posting for Interview Q of the Day.
 */

import crypto from 'crypto';
import { jidNormalizedUser, normalizeMessageContent } from 'baileys';
import AssistLlmRouter from '../services/AssistLlmRouter.js';
import { logger } from '../utils/logger.js';
import { config } from '../config/config.js';
import { extractPhoneNumber } from '../utils/permissions.js';
import {
    decryptInterviewPollVote,
    selectedOptionLetter,
    voterCandidatesFromMsg,
    buildWeeklyLeaderboard,
    formatWeeklyLeaderboard,
} from './interviewQuestion.pollVotes.js';

export const INTERVIEW_CATEGORIES = [
    'DSA',
    'System Design',
    'Low-Level Design / OOP',
    'SQL',
    'Computer Fundamentals',
    'Debugging',
    'Code Output',
    'Language-Specific',
    'Behavioral',
    'Aptitude',
];

const ALLOWED_DIFFICULTIES = new Set(['medium', 'hard']);

const SYSTEM_PROMPT = [
    'You generate one interview multiple-choice question for software engineers / students.',
    'Return JSON ONLY — no markdown fences, no prose outside JSON.',
    'Hard rules:',
    '- Exactly 4 options A–D.',
    '- Exactly one correctOption in A|B|C|D.',
    '- Do not put the answer in the question text.',
    '- Keep question + each option short enough for a WhatsApp poll (options under ~90 chars).',
    '- Difficulty MUST be Medium or Hard only (never Easy).',
    '- Do NOT repeat or lightly rephrase any question listed in the avoid list.',
    '- Include explanation, approach, and complexity when relevant (DSA/algorithms).',
    '- For Behavioral/Aptitude, timeComplexity/spaceComplexity may be empty strings.',
    '- Valid strict JSON: double quotes only, escape any " inside strings as \\", no trailing commas, no raw newlines inside strings.',
].join('\n');

function pickCategory(slotIndex = 0) {
    const day = Math.floor(Date.now() / 86_400_000);
    const idx = (day * 2 + Number(slotIndex || 0)) % INTERVIEW_CATEGORIES.length;
    return INTERVIEW_CATEGORIES[idx];
}

/** Prefer Hard slightly more often than Medium. */
export function pickDifficulty(slotIndex = 0) {
    const n = (Math.floor(Date.now() / 86_400_000) * 3 + Number(slotIndex || 0)) % 5;
    return n < 3 ? 'Hard' : 'Medium';
}

/** Stable fingerprint so we never re-post the same (or near-identical) stem. */
export function questionFingerprint(questionText) {
    const norm = String(questionText || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!norm) return '';
    return crypto.createHash('sha256').update(norm).digest('hex').slice(0, 32);
}

export function normalizeDifficulty(raw) {
    const d = String(raw || '')
        .trim()
        .toLowerCase();
    if (d === 'hard' || d === 'difficult' || d === 'advanced') return 'Hard';
    if (d === 'medium' || d === 'med' || d === 'intermediate') return 'Medium';
    return '';
}

/** Strip fences / think tags and isolate the outermost `{...}`. */
function sliceJsonObject(raw) {
    let text = String(raw || '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .trim();
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    text = (fenced?.[1] || text).trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) {
        throw new Error('No JSON object in AI response');
    }
    return text.slice(start, end + 1);
}

/**
 * Repair common LLM JSON mistakes: smart quotes, trailing commas,
 * raw control chars in strings, and unescaped " inside string values.
 */
export function repairLlmJson(jsonText) {
    let s = String(jsonText || '')
        .replace(/^\uFEFF/, '')
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/,\s*([}\]])/g, '$1');

    let out = '';
    let inString = false;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];

        if (!inString) {
            if (c === '"') inString = true;
            out += c;
            continue;
        }

        if (c === '\\') {
            const next = s[i + 1];
            if (next !== undefined) {
                out += c + next;
                i++;
            } else {
                out += '\\\\';
            }
            continue;
        }

        if (c === '"') {
            let j = i + 1;
            while (j < s.length && /[ \t\r\n]/.test(s[j])) j++;
            const next = s[j];
            if (next === undefined || next === ',' || next === '}' || next === ']' || next === ':') {
                inString = false;
                out += c;
            } else {
                out += '\\"';
            }
            continue;
        }

        if (c === '\n') {
            out += '\\n';
            continue;
        }
        if (c === '\r') {
            out += '\\r';
            continue;
        }
        if (c === '\t') {
            out += '\\t';
            continue;
        }
        if (c.charCodeAt(0) < 0x20) {
            continue;
        }

        out += c;
    }

    return out;
}

export function extractJsonObject(raw) {
    const sliced = sliceJsonObject(raw);
    try {
        return JSON.parse(sliced);
    } catch {
        const repaired = repairLlmJson(sliced);
        try {
            return JSON.parse(repaired);
        } catch (err) {
            throw new Error(`Invalid AI JSON: ${err.message}`);
        }
    }
}

/**
 * @param {object} parsed
 */
export function normalizeQuestion(parsed) {
    if (!parsed || typeof parsed !== 'object') {
        throw new Error('Invalid question object');
    }

    const options = parsed.options || {};
    const A = String(options.A || '').trim();
    const B = String(options.B || '').trim();
    const C = String(options.C || '').trim();
    const D = String(options.D || '').trim();
    if (!A || !B || !C || !D) {
        throw new Error('Missing MCQ options A–D');
    }

    const correctOption = String(parsed.correctOption || '')
        .trim()
        .toUpperCase()
        .slice(0, 1);
    if (!['A', 'B', 'C', 'D'].includes(correctOption)) {
        throw new Error('Invalid correctOption');
    }

    const question = String(parsed.question || '').trim();
    if (question.length < 10) {
        throw new Error('Question too short');
    }

    const difficulty = normalizeDifficulty(parsed.difficulty);
    if (!difficulty || !ALLOWED_DIFFICULTIES.has(difficulty.toLowerCase())) {
        throw new Error('Difficulty must be Medium or Hard');
    }

    const clip = (s, n) => String(s || '').trim().slice(0, n);

    return {
        type: clip(parsed.type || 'DSA', 40),
        difficulty,
        topic: clip(parsed.topic || 'General', 60),
        question: clip(question, 400),
        options: {
            A: clip(A, 100),
            B: clip(B, 100),
            C: clip(C, 100),
            D: clip(D, 100),
        },
        correctOption,
        properAnswer: clip(parsed.properAnswer || parsed.options?.[correctOption] || '', 800),
        explanation: clip(parsed.explanation || '', 1200),
        hint: clip(parsed.hint || '', 300),
        approach: clip(parsed.approach || '', 800),
        timeComplexity: clip(parsed.timeComplexity || '', 40),
        spaceComplexity: clip(parsed.spaceComplexity || '', 40),
        commonMistake: clip(parsed.commonMistake || '', 400),
        questionFp: questionFingerprint(question),
    };
}

export function formatAnswerMessage(q) {
    let text = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    text += '✅ *ANSWER · Interview Q of the Day*\n';
    text += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
    text += `📌 *${q.type}* · ${q.difficulty} · ${q.topic}\n\n`;
    text += `*Correct:* ${q.correctOption}. ${q.options[q.correctOption]}\n\n`;
    text += `*Proper answer*\n${q.properAnswer}\n\n`;
    text += `*Explanation*\n${q.explanation}\n`;
    if (q.approach) {
        text += `\n*Approach*\n${q.approach}\n`;
    }
    if (q.timeComplexity) {
        text += `\n⏱ *Time:* ${q.timeComplexity}`;
    }
    if (q.spaceComplexity) {
        text += `\n💾 *Space:* ${q.spaceComplexity}`;
    }
    if (q.timeComplexity || q.spaceComplexity) {
        text += '\n';
    }
    if (q.commonMistake) {
        text += `\n⚠️ *Common mistake*\n${q.commonMistake}\n`;
    }
    text += '\n🤖 _Sassy Bot_';
    return text;
}

export function formatPollName(q) {
    return (
        `🧠 Interview Q · ${q.type} (${q.difficulty})\n` +
        `Topic: ${q.topic}\n\n` +
        `${q.question}`
    ).slice(0, 255);
}

export function pollValues(q) {
    return [
        `A. ${q.options.A}`,
        `B. ${q.options.B}`,
        `C. ${q.options.C}`,
        `D. ${q.options.D}`,
    ].map((v) => v.slice(0, 100));
}

/** Weekend learning recap — short enough for WhatsApp, good for revision. */
export function formatWeeklySummary(docs, { weekLabel = '', leaderboardText = '', leaderboardRows = null } = {}) {
    let text = '';
    const board =
        String(leaderboardText || '').trim() ||
        (Array.isArray(leaderboardRows)
            ? formatWeeklyLeaderboard(leaderboardRows, { weekLabel })
            : '');
    if (board) {
        text += board;
        if (!board.endsWith('\n')) text += '\n';
        text += '\n';
    }

    text += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    text += '📚 *WEEKEND INTERVIEW Q RECAP*\n';
    text += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    if (weekLabel) {
        text += `_${weekLabel}_\n`;
    }
    text += '\nRevise these before Monday — question → answer → why.\n';

    const list = Array.isArray(docs) ? docs : [];
    if (!list.length) {
        text += '\n_No interview questions were posted this week._\n';
        text += '\n🤖 _Sassy Bot_';
        return text.slice(0, 4000);
    }

    list.forEach((doc, i) => {
        const n = i + 1;
        const correct = String(doc.correct_option || '').toUpperCase();
        const opt = doc.options?.[correct] || '';
        text += `\n*${n}. ${doc.type || 'Q'} · ${doc.difficulty || ''} · ${doc.topic || ''}*\n`;
        text += `${doc.question}\n`;
        text += `✅ *${correct}${opt ? `. ${opt}` : ''}*\n`;
        const takeaway = String(doc.explanation || doc.proper_answer || '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 180);
        if (takeaway) {
            text += `💡 ${takeaway}${takeaway.length >= 180 ? '…' : ''}\n`;
        }
    });

    text += '\n🧠 Tip: cover the answers and re-solve each MCQ from memory.\n';
    text += '\n🤖 _Sassy Bot_';
    return text.slice(0, 4000);
}

const LEADERBOARD_AI_SYSTEM = [
    'You write a WhatsApp-ready WEEKLY INTERVIEW MCQ LEADERBOARD for a coding/interview prep group.',
    'Style: savage-but-loving roast commentary — funny, specific, competitive, Hinglish OK.',
    'MUST include the real standings with scores (correct/attempted) for the top names given.',
    'Use 🥇🥈🥉 for top 3. Keep under 1200 characters. No markdown fences. No inventing people.',
    'Start with a short banner line like "🏆 WEEKLY INTERVIEW LEADERBOARD".',
    'End with one punchy one-liner that makes people want to vote next week.',
].join(' ');


/** Build a Baileys quoted stub so the answer replies to the poll. */
export function buildPollQuote(doc, q) {
    const key = doc?.poll_message_key;
    const id = key?.id || doc?.poll_message_id;
    if (!id) return null;

    return {
        key: {
            remoteJid: key?.remoteJid || doc.jid,
            id,
            fromMe: key?.fromMe !== false,
            ...(key?.participant ? { participant: key.participant } : {}),
        },
        message: {
            conversation: formatPollName(q).slice(0, 120),
        },
    };
}

class InterviewQuestionService {
    /**
     * @param {object} opts
     * @param {import('./interviewQuestion.storage.js').default} opts.store
     * @param {import('../models/GroupManager.js').default} opts.groupManager
     * @param {object} [opts.cfg]
     */
    constructor({ store, groupManager, cfg = config }) {
        this.store = store;
        this.groupManager = groupManager;
        this.cfg = cfg;
        this.llm = new AssistLlmRouter(cfg);
        /** @type {Map<string, NodeJS.Timeout>} */
        this._answerTimers = new Map();
        this._getSock = null;
    }

    setGetSock(fn) {
        this._getSock = fn;
    }

    isConfigured() {
        return this.llm.isConfigured();
    }

    async generateQuestion({ category, slotIndex = 0, difficulty } = {}) {
        if (!this.isConfigured()) {
            throw new Error('No LLM configured (set GEMINI / GROQ / NVIDIA / OPENROUTER key)');
        }

        const type = category || pickCategory(slotIndex);
        const wantDiff = normalizeDifficulty(difficulty) || pickDifficulty(slotIndex);
        const lookback = this.cfg.INTERVIEW_Q_DEDUP_LOOKBACK || 200;
        const recent = await this.store.findRecentQuestions(lookback);
        const usedFps = new Set(recent.map((r) => r.question_fp).filter(Boolean));
        const avoidLines = recent
            .slice(0, 40)
            .map((r, i) => `${i + 1}. [${r.type || '?'}] ${String(r.question || '').slice(0, 120)}`);

        const userBlock = [
            `Generate ONE interview MCQ.`,
            `Category/type must be: ${type}`,
            `Difficulty MUST be exactly: ${wantDiff} (Medium or Hard only — never Easy).`,
            `Return JSON with keys: type, difficulty, topic, question, options{A,B,C,D}, correctOption, properAnswer, explanation, hint, approach, timeComplexity, spaceComplexity, commonMistake.`,
            `Strict JSON only — escape inner double-quotes; no trailing commas.`,
            avoidLines.length
                ? `AVOID repeating or rephrasing these already-used questions:\n${avoidLines.join('\n')}`
                : 'Invent a fresh question not commonly reused in bank dumps.',
        ].join('\n');

        let lastErr;
        for (let attempt = 0; attempt < 4; attempt++) {
            try {
                const { text, provider, model } = await this.llm.completeChat({
                    systemPrompt: SYSTEM_PROMPT,
                    history: [],
                    userBlock:
                        attempt === 0
                            ? userBlock
                            : `${userBlock}\nPrevious output was rejected (${lastErr?.message || 'invalid'}). Reply with a NEW Medium/Hard question as valid JSON only.`,
                    maxTokens: 1200,
                    temperature: attempt === 0 ? 0.75 : 0.45,
                    maxChars: 4000,
                });

                const normalized = normalizeQuestion(extractJsonObject(text));
                if (!normalized.type) normalized.type = type;

                if (normalized.difficulty !== wantDiff) {
                    normalized.difficulty = wantDiff;
                }

                if (!normalized.questionFp) {
                    throw new Error('Empty question fingerprint');
                }
                if (
                    usedFps.has(normalized.questionFp) ||
                    (await this.store.fingerprintExists(normalized.questionFp))
                ) {
                    throw new Error('Duplicate question fingerprint');
                }

                logger.info(
                    `Interview Q generated via ${provider}/${model}: ${normalized.type} · ${normalized.difficulty} · ${normalized.topic}`
                );
                return normalized;
            } catch (err) {
                lastErr = err;
                logger.warn(`Interview Q generate attempt ${attempt + 1} failed: ${err.message}`);
            }
        }
        throw lastErr || new Error('Failed to generate interview question');
    }

    /**
     * Save + post poll for one jid. Skips if slot already used.
     * @param {object} [opts.question] pre-generated question (shared across groups for one slot)
     */
    async postQuestionToJid(sock, jid, { slotKey, slotIndex = 0, category, question } = {}) {
        if (!sock || !jid) {
            throw new Error('Missing sock/jid');
        }

        const key = slotKey || `manual-${Date.now()}`;
        const existing = await this.store.findBySlot(jid, key);
        if (existing && existing.status !== 'failed') {
            logger.info(`Interview Q skip duplicate ${jid} slot ${key}`);
            return { skipped: true, doc: existing };
        }
        if (existing?.status === 'failed') {
            await this.store.deleteById(existing._id);
        }

        const q = question || (await this.generateQuestion({ category, slotIndex }));
        const answerDelayMs = this.cfg.INTERVIEW_Q_ANSWER_DELAY_MS || 30 * 60 * 1000;

        const doc = await this.store.insertQuestion({
            jid,
            slot_key: key,
            type: q.type,
            difficulty: q.difficulty,
            topic: q.topic,
            question: q.question,
            question_fp: q.questionFp || questionFingerprint(q.question),
            options: q.options,
            correct_option: q.correctOption,
            proper_answer: q.properAnswer,
            explanation: q.explanation,
            hint: q.hint,
            approach: q.approach,
            time_complexity: q.timeComplexity,
            space_complexity: q.spaceComplexity,
            common_mistake: q.commonMistake,
            status: 'scheduled',
            poll_message_id: '',
            poll_message_key: null,
            poll_enc_key: '',
            poll_option_names: [],
            poll_creator_jid: '',
            votes: [],
            question_posted_at: null,
            answer_due_at: null,
            answer_posted_at: null,
        });

        try {
            const optionNames = pollValues(q);
            const pollEncKey = crypto.randomBytes(32);
            const meJid = jidNormalizedUser(sock.user?.id) || sock.user?.id || '';
            const meLid = sock.user?.lid ? jidNormalizedUser(sock.user.lid) || sock.user.lid : '';

            // Polls cannot carry mentions, so send a pre-poll message. Mentions
            // are strictly opt-in via /tagme.
            if (String(jid).endsWith('@g.us')) {
                try {
                    await this.sendInterviewPing(sock, jid, q, answerDelayMs);
                } catch (err) {
                    logger.debug(`Interview Q ping skipped: ${err.message}`);
                }
            }

            const sent = await sock.sendMessage(jid, {
                poll: {
                    name: formatPollName(q),
                    values: optionNames,
                    selectableCount: 1,
                    messageSecret: pollEncKey,
                },
            });

            const postedAt = new Date();
            const dueAt = new Date(postedAt.getTime() + answerDelayMs);
            await this.store.markQuestionPosted(doc._id, {
                pollMessageId: sent?.key?.id || '',
                pollMessageKey: sent?.key || null,
                questionPostedAt: postedAt,
                answerDueAt: dueAt,
                pollEncKeyB64: pollEncKey.toString('base64'),
                pollOptionNames: optionNames,
                pollCreatorJid: meLid || meJid,
            });

            this.scheduleAnswer(String(doc._id), dueAt.getTime());
            return { skipped: false, docId: String(doc._id), question: q };
        } catch (err) {
            await this.store.markFailed(doc._id, err.message);
            throw err;
        }
    }

    /**
     * Pre-poll notification. Only /tagme opt-ins receive an @mention.
     */
    async sendInterviewPing(sock, jid, q, answerDelayMs) {
        const baseText =
            `🧠 *Interview Q* · ${q.type} (${q.difficulty})\n` +
            `Topic: *${q.topic}*\n\n` +
            `_Vote on the poll below — answer drops in ${Math.round(answerDelayMs / 60_000)} min._`;

        let tagged = [];
        try {
            const rows = await this.store.getTaggedMembers(jid);
            if (rows?.length) {
                tagged = await this.resolveMentionJids(jid, rows.map((r) => r.phone), sock);
            }
        } catch (err) {
            logger.debug(`Interview Q tag lookup failed: ${err.message}`);
        }

        if (tagged.length) {
            const tagLines = tagged.map((jid2) => `@${String(jid2).split('@')[0]}`).join(' ');
            await sock.sendMessage(jid, {
                text: `${baseText}\n\n🔔 ${tagLines}`,
                mentions: tagged,
                linkPreview: false,
            });
            return;
        }

        // No opt-ins: send the context message without notifying the group.
        await sock.sendMessage(jid, { text: baseText, linkPreview: false });
    }

    /**
     * Group participant JIDs for a list of phone numbers (cached metadata lookup).
     * Handles Baileys 7 pn/lid participant records — phoneNumber wins when present.
     */
    async resolveMentionJids(groupId, phones = [], sock = null) {
        if (!groupId?.endsWith('@g.us') || !phones?.length) return [];
        const s = sock || this._getSock?.();
        if (!s?.groupMetadata) return [];
        try {
            const want = new Set(phones.map((p) => String(p).replace(/\D/g, '')).filter(Boolean));
            if (!want.size) return [];
            const meta = await s.groupMetadata(groupId);
            const out = [];
            for (const p of meta?.participants || []) {
                const phone = String(p.phoneNumber || '').replace(/\D/g, '') ||
                    String(p.id || '').split('@')[0].replace(/\D/g, '');
                if (want.has(phone) && p.id) out.push(p.id);
            }
            return out;
        } catch (err) {
            logger.debug(`Interview Q mention resolve failed: ${err.message}`);
            return [];
        }
    }

    /**
     * Visible @mention block for leaderboard rows — tags the listed players
     * in weekly summary and /iqboard messages.
     */
    async buildLeaderboardTagPack(groupId, rows = [], { limit = 10, sock = null } = {}) {
        const eligible = (rows || [])
            .filter((r) => r?.phone && (r.attempted ?? 0) > 0);
        if (!eligible.length || !groupId?.endsWith('@g.us')) {
            return { text: '', mentions: [] };
        }
        try {
            // /notag wins: only members who explicitly opted in via /tagme in
            // THIS group may be @-mentioned on the leaderboard or weekly recap.
            const taggedPhones = new Set(
                (await this.store.getTaggedMembers(groupId))
                    .filter((r) => r.tagged === true)
                    .map((r) => String(r.phone))
            );
            const picked = eligible
                .filter((r) => taggedPhones.has(String(r.phone)))
                .slice(0, limit);
            if (!picked.length) return { text: '', mentions: [] };
            const jids = await this.resolveMentionJids(groupId, picked.map((r) => r.phone), sock);
            if (!jids.length) return { text: '', mentions: [] };
            const tags = jids.map((j) => `@${String(j).split('@')[0]}`).join(' ');
            return { text: `\n\n🔥 ${tags}`, mentions: jids };
        } catch (err) {
            logger.debug(`Interview Q leaderboard tags skipped: ${err.message}`);
            return { text: '', mentions: [] };
        }
    }

    /**
     * Handle an incoming pollUpdateMessage for Interview Q scoring.
     * Fail-soft: never throws to the message pipeline.
     */
    async handleIncomingPollVote(msg, sock = null) {
        try {
            const content = normalizeMessageContent(msg?.message);
            const pum = content?.pollUpdateMessage;
            if (!pum?.vote || !pum?.pollCreationMessageKey?.id) return { ok: false, reason: 'not_poll' };

            const pollMsgId = pum.pollCreationMessageKey.id;
            const doc = await this.store.findByPollMessageId(pollMsgId);
            if (!doc) return { ok: false, reason: 'unknown_poll' };
            if (doc.status !== 'question_posted') return { ok: false, reason: 'closed' };
            if (!doc.poll_enc_key) return { ok: false, reason: 'no_enc_key' };

            const sockRef = sock || this._getSock?.();
            const mePn = jidNormalizedUser(sockRef?.user?.id) || sockRef?.user?.id || '';
            const meLid = sockRef?.user?.lid
                ? jidNormalizedUser(sockRef.user.lid) || sockRef.user.lid
                : '';
            const creatorJids = [doc.poll_creator_jid, meLid, mePn].filter(Boolean);
            const voterJids = voterCandidatesFromMsg(msg, mePn);

            const voteMsg = decryptInterviewPollVote({
                voteEnc: pum.vote,
                pollEncKey: Buffer.from(doc.poll_enc_key, 'base64'),
                pollMsgId,
                pollCreatorJids: creatorJids,
                voterJids,
            });
            if (!voteMsg) {
                logger.debug(`Interview Q vote decrypt failed for poll ${pollMsgId}`);
                return { ok: false, reason: 'decrypt_failed' };
            }

            const optionNames = doc.poll_option_names?.length
                ? doc.poll_option_names
                : pollValues(this.docToQuestion(doc));
            const letter = selectedOptionLetter(voteMsg, optionNames);
            if (!letter) return { ok: false, reason: 'no_option' };

            const voterJid = voterJids[0] || msg.key?.participant || '';
            const voterPhone = extractPhoneNumber(voterJid) || '';
            const voterName = (msg.pushName || '').trim() || 'Member';

            await this.store.upsertVote(doc._id, {
                voter_jid: voterJid,
                voter_phone: voterPhone,
                voter_name: voterName,
                option: letter,
                voted_at: new Date(),
            });
            return { ok: true, option: letter, docId: String(doc._id) };
        } catch (err) {
            logger.debug(`Interview Q vote handle error: ${err.message}`);
            return { ok: false, reason: err.message };
        }
    }

    async getLeaderboardForJid(jid, { sinceMs, limit = 10, ai = true } = {}) {
        const since = new Date(sinceMs || Date.now() - 7 * 24 * 60 * 60 * 1000);
        const docs = await this.store.findPostedSince(jid, since);
        const rows = buildWeeklyLeaderboard(docs, {
            timezone: this.cfg.INTERVIEW_Q_TIMEZONE || 'Asia/Kolkata',
        });
        const weekLabel = `Week of ${since.toLocaleDateString('en-IN', {
            timeZone: this.cfg.INTERVIEW_Q_TIMEZONE || 'Asia/Kolkata',
            day: 'numeric',
            month: 'short',
        })}`;
        const text = ai
            ? await this.renderLeaderboardText(rows, { weekLabel, limit })
            : formatWeeklyLeaderboard(rows, { weekLabel, limit });
        return {
            rows: rows.slice(0, limit),
            allRows: rows,
            weekLabel,
            text,
            jid,
        };
    }

    /**
     * AI roast leaderboard every time; falls back to the static board on LLM failure.
     */
    async renderLeaderboardText(rows, { weekLabel = '', limit = 10 } = {}) {
        const fallback = formatWeeklyLeaderboard(rows, { weekLabel, limit });
        const top = (rows || []).filter((r) => r.attempted > 0).slice(0, limit);
        if (!top.length || !this.llm?.isConfigured?.()) return fallback;

        try {
            const standings = top.map((r, i) => ({
                rank: i + 1,
                name: r.name,
                correct: r.correct,
                attempted: r.attempted,
                accuracy_pct: Math.round(r.accuracy * 100),
                streak: r.streak,
            }));
            const { text } = await this.llm.completeChat({
                systemPrompt: LEADERBOARD_AI_SYSTEM,
                history: [],
                userBlock: [
                    weekLabel ? `Week: ${weekLabel}` : '',
                    'Standings JSON (use these exact names + scores):',
                    JSON.stringify(standings),
                    'Write a fresh, different roast every time — never copy a previous vibe.',
                ]
                    .filter(Boolean)
                    .join('\n'),
                maxTokens: 700,
                temperature: 0.95,
                maxChars: 1600,
            });
            const cleaned = String(text || '')
                .replace(/^```[\s\S]*?```/g, '')
                .trim();
            if (cleaned.length < 60) return fallback;
            // Guard: at least one real name must appear so the model can't invent a board.
            const hasName = top.some((r) => cleaned.includes(r.name));
            if (!hasName) return fallback;
            return cleaned;
        } catch (err) {
            logger.warn(`Interview Q AI leaderboard failed: ${err.message}`);
            return fallback;
        }
    }

    docToQuestion(doc) {
        return {
            type: doc.type,
            difficulty: doc.difficulty,
            topic: doc.topic,
            question: doc.question,
            options: doc.options,
            correctOption: doc.correct_option,
            properAnswer: doc.proper_answer,
            explanation: doc.explanation,
            hint: doc.hint,
            approach: doc.approach,
            timeComplexity: doc.time_complexity,
            spaceComplexity: doc.space_complexity,
            commonMistake: doc.common_mistake,
            questionFp: doc.question_fp || questionFingerprint(doc.question),
        };
    }

    scheduleAnswer(docId, dueAtMs) {
        const existing = this._answerTimers.get(docId);
        if (existing) clearTimeout(existing);

        const delay = Math.max(0, dueAtMs - Date.now());
        const timer = setTimeout(() => {
            this._answerTimers.delete(docId);
            void this.postAnswerById(docId);
        }, delay);
        if (typeof timer.unref === 'function') timer.unref();
        this._answerTimers.set(docId, timer);
        logger.info(`Interview Q answer scheduled in ${Math.round(delay / 1000)}s for ${docId}`);
    }

    async postAnswerById(docId) {
        const doc = await this.store.findById(docId);
        if (!doc) return { ok: false, reason: 'not_found' };
        if (doc.status === 'answer_posted') return { ok: true, reason: 'already' };
        if (doc.status !== 'question_posted') {
            return { ok: false, reason: `status_${doc.status}` };
        }

        const sock = this._getSock?.();
        if (!sock) {
            this.scheduleAnswer(docId, Date.now() + 60_000);
            return { ok: false, reason: 'no_sock' };
        }

        try {
            const q = this.docToQuestion(doc);
            const quoted = buildPollQuote(doc, q);
            await sock.sendMessage(
                doc.jid,
                { text: formatAnswerMessage(q) },
                quoted ? { quoted } : undefined
            );
            await this.store.markAnswerPosted(doc._id);
            logger.info(`Interview Q answer posted for ${doc.jid} (${docId})`);
            return { ok: true };
        } catch (err) {
            logger.error(`Interview Q answer failed ${docId}: ${err.message}`);
            return { ok: false, reason: err.message };
        }
    }

    async recoverPendingAnswers() {
        const pending = await this.store.findPendingAnswersDue(Date.now() + 24 * 60 * 60 * 1000);
        for (const doc of pending) {
            const due = new Date(doc.answer_due_at).getTime();
            this.scheduleAnswer(String(doc._id), due);
        }
        if (pending.length) {
            logger.info(`Interview Q recovered ${pending.length} pending answer job(s)`);
        }
        return pending.length;
    }

    /** Post one question to all interview-q enabled groups for a schedule slot */
    async postSlotToGroups(sock, { slotKey, slotIndex = 0 }) {
        const groups = await this.groupManager.getInterviewQGroups();
        if (!groups.length) {
            logger.warn('Interview Q: no enabled groups — use /interviewqon');
            return { posted: 0, groups: 0, skipped: 0 };
        }

        let sharedQuestion = null;
        try {
            sharedQuestion = await this.generateQuestion({ slotIndex });
        } catch (err) {
            logger.error(`Interview Q generate for slot ${slotKey} failed: ${err.message}`);
            return { posted: 0, groups: groups.length, skipped: 0 };
        }

        let posted = 0;
        let skipped = 0;
        for (const group of groups) {
            try {
                const result = await this.postQuestionToJid(sock, group.group_id, {
                    slotKey,
                    slotIndex,
                    question: sharedQuestion,
                });
                if (result.skipped) skipped++;
                else posted++;
                await new Promise((r) => setTimeout(r, 800));
            } catch (err) {
                logger.error(`Interview Q post failed for ${group.group_id}: ${err.message}`);
            }
        }
        return { posted, groups: groups.length, skipped };
    }

    async isSlotFullyPosted(slotKey) {
        if (!slotKey || !this.store) return false;
        const groups = await this.groupManager.getInterviewQGroups();
        if (!groups.length) return false;
        for (const group of groups) {
            const doc = await this.store.findBySlot(group.group_id, slotKey);
            if (!doc || doc.status === 'failed' || doc.status === 'scheduled') {
                return false;
            }
        }
        return true;
    }

    /**
     * Post Saturday-night learning recap of the past week to all enabled groups.
     * @param {string} summaryKey e.g. summary-2026-07-26
     */
    async postWeeklySummaryToGroups(sock, { summaryKey, sinceMs } = {}) {
        const groups = await this.groupManager.getInterviewQGroups();
        if (!groups.length) {
            return { posted: 0, groups: 0, skipped: 0 };
        }

        const since = new Date(sinceMs || Date.now() - 7 * 24 * 60 * 60 * 1000);
        const weekLabel = `Week of ${since.toLocaleDateString('en-IN', {
            timeZone: this.cfg.INTERVIEW_Q_TIMEZONE || 'Asia/Kolkata',
            day: 'numeric',
            month: 'short',
        })}`;

        let posted = 0;
        let skipped = 0;
        for (const group of groups) {
            const slotKey = summaryKey || `summary-${Date.now()}`;
            try {
                const existing = await this.store.findBySlot(group.group_id, slotKey);
                if (existing && existing.status !== 'failed') {
                    skipped++;
                    continue;
                }
                if (existing?.status === 'failed') {
                    await this.store.deleteById(existing._id);
                }

                const docs = await this.store.findPostedSince(group.group_id, since);
                const seen = new Set();
                const unique = [];
                for (const d of docs) {
                    const fp = d.question_fp || questionFingerprint(d.question);
                    if (fp && seen.has(fp)) continue;
                    if (fp) seen.add(fp);
                    unique.push(d);
                }

                const leaderboardRows = buildWeeklyLeaderboard(docs, {
                    timezone: this.cfg.INTERVIEW_Q_TIMEZONE || 'Asia/Kolkata',
                });
                const leaderboardText = await this.renderLeaderboardText(leaderboardRows, {
                    weekLabel,
                    limit: 10,
                });
                const tagPack = await this.buildLeaderboardTagPack(group.group_id, leaderboardRows, {
                    limit: 10,
                    sock,
                });
                const text = formatWeeklySummary(unique, { weekLabel, leaderboardText }) + tagPack.text;
                await sock.sendMessage(group.group_id, {
                    text,
                    ...(tagPack.mentions.length ? { mentions: tagPack.mentions } : {}),
                    linkPreview: false,
                });

                await this.store.insertQuestion({
                    jid: group.group_id,
                    slot_key: slotKey,
                    type: 'Weekly Summary',
                    difficulty: 'Recap',
                    topic: 'Weekend revision',
                    question: `Weekly summary (${unique.length} Qs)`,
                    question_fp: questionFingerprint(`summary:${slotKey}:${group.group_id}`),
                    options: { A: '-', B: '-', C: '-', D: '-' },
                    correct_option: 'A',
                    proper_answer: '',
                    explanation: '',
                    hint: '',
                    approach: '',
                    time_complexity: '',
                    space_complexity: '',
                    common_mistake: '',
                    status: 'answer_posted',
                    poll_message_id: '',
                    poll_message_key: null,
                    question_posted_at: new Date(),
                    answer_due_at: null,
                    answer_posted_at: new Date(),
                });
                posted++;
                await new Promise((r) => setTimeout(r, 800));
            } catch (err) {
                logger.error(`Interview Q weekly summary failed for ${group.group_id}: ${err.message}`);
            }
        }
        return { posted, groups: groups.length, skipped };
    }
}

export default InterviewQuestionService;
