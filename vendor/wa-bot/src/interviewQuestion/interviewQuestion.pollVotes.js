/**
 * Interview Q poll-vote helpers: decrypt, map A–D, weekly leaderboard.
 */

import { createHash } from 'crypto';
import { decryptPollVote, getKeyAuthor, jidNormalizedUser } from 'baileys';

const LETTERS = ['A', 'B', 'C', 'D'];

export function sha256Hex(text) {
    return createHash('sha256').update(Buffer.from(String(text || ''), 'utf8')).digest().toString();
}

/** Map poll option display strings → A/B/C/D via the same hash Baileys uses. */
export function buildOptionLetterMap(optionNames) {
    const map = new Map();
    (optionNames || []).slice(0, 4).forEach((name, i) => {
        map.set(sha256Hex(name), LETTERS[i]);
    });
    return map;
}

/**
 * Try LID/PN JID combos until AES-GCM decrypt succeeds (Baileys poll vote quirk).
 * @returns {import('baileys').proto.Message.IPollVoteMessage | null}
 */
export function decryptInterviewPollVote({
    voteEnc,
    pollEncKey,
    pollMsgId,
    pollCreatorJids = [],
    voterJids = [],
}) {
    if (!voteEnc?.encPayload || !voteEnc?.encIv || !pollEncKey || !pollMsgId) return null;
    const creators = [...new Set(pollCreatorJids.filter(Boolean).map((j) => jidNormalizedUser(j) || j))];
    const voters = [...new Set(voterJids.filter(Boolean).map((j) => jidNormalizedUser(j) || j))];
    for (const pollCreatorJid of creators) {
        for (const voterJid of voters) {
            try {
                return decryptPollVote(
                    { encPayload: voteEnc.encPayload, encIv: voteEnc.encIv },
                    { pollCreatorJid, pollMsgId, pollEncKey, voterJid }
                );
            } catch {
                /* try next combo */
            }
        }
    }
    return null;
}

/** First selected option letter (A–D) from a decrypted poll vote. */
export function selectedOptionLetter(voteMsg, optionNames) {
    const map = buildOptionLetterMap(optionNames);
    const selected = voteMsg?.selectedOptions || [];
    for (const opt of selected) {
        // Same encoding Baileys getAggregateVotesInPollMessage uses (Buffer#toString).
        const hash = Buffer.from(opt).toString();
        const letter = map.get(hash);
        if (letter) return letter;
    }
    return null;
}

export function voterCandidatesFromMsg(msg, meId) {
    const me = jidNormalizedUser(meId) || meId;
    const author = getKeyAuthor(msg?.key, me);
    const out = [author];
    if (msg?.key?.participant) out.push(jidNormalizedUser(msg.key.participant) || msg.key.participant);
    if (msg?.key?.remoteJid && !String(msg.key.remoteJid).endsWith('@g.us')) {
        out.push(jidNormalizedUser(msg.key.remoteJid) || msg.key.remoteJid);
    }
    return [...new Set(out.filter(Boolean))];
}

/**
 * Build ranked weekly standings from question docs that carry `votes[]`.
 * @param {object[]} docs
 * @param {{ nowMs?: number, timezone?: string }} [opts]
 */
export function buildWeeklyLeaderboard(docs, opts = {}) {
    const tz = opts.timezone || 'Asia/Kolkata';
    const nowMs = opts.nowMs || Date.now();
    /** @type {Map<string, { key: string, name: string, phone: string, correct: number, attempted: number, correctDays: Set<string> }>} */
    const byKey = new Map();

    for (const doc of docs || []) {
        if (!doc || doc.type === 'Weekly Summary') continue;
        const correct = String(doc.correct_option || '').toUpperCase();
        if (!correct || !LETTERS.includes(correct)) continue;
        const dayKey = istDayKey(doc.question_posted_at || doc.created_at, tz);

        for (const vote of doc.votes || []) {
            const key = String(vote.voter_phone || vote.voter_jid || '').trim();
            if (!key) continue;
            let row = byKey.get(key);
            if (!row) {
                row = {
                    key,
                    name: String(vote.voter_name || 'Member').slice(0, 32),
                    phone: String(vote.voter_phone || ''),
                    correct: 0,
                    attempted: 0,
                    correctDays: new Set(),
                };
                byKey.set(key, row);
            }
            if (vote.voter_name) row.name = String(vote.voter_name).slice(0, 32);
            row.attempted += 1;
            if (String(vote.option || '').toUpperCase() === correct) {
                row.correct += 1;
                if (dayKey) row.correctDays.add(dayKey);
            }
        }
    }

    const rows = [...byKey.values()].map((r) => ({
        name: r.name,
        phone: r.phone,
        correct: r.correct,
        attempted: r.attempted,
        accuracy: r.attempted ? r.correct / r.attempted : 0,
        streak: computeStreak(r.correctDays, nowMs, tz),
    }));

    rows.sort(
        (a, b) =>
            b.correct - a.correct ||
            b.accuracy - a.accuracy ||
            b.streak - a.streak ||
            b.attempted - a.attempted ||
            a.name.localeCompare(b.name)
    );
    return rows;
}

export function formatWeeklyLeaderboard(rows, { weekLabel = '', limit = 10 } = {}) {
    let text = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    text += '🏆 *WEEKLY INTERVIEW LEADERBOARD*\n';
    text += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    if (weekLabel) text += `_${weekLabel}_\n`;
    text += '\n';

    const list = (rows || []).filter((r) => r.attempted > 0).slice(0, limit);
    if (!list.length) {
        text += '_No poll votes this week yet — answer the next MCQ!_\n';
        return text;
    }

    const medals = ['🥇', '🥈', '🥉'];
    list.forEach((r, i) => {
        const medal = medals[i] || `${i + 1}.`;
        const pct = Math.round(r.accuracy * 100);
        const streakBit = r.streak > 1 ? ` · streak ${r.streak}` : '';
        text += `${medal} *${r.name}* — ${r.correct}/${r.attempted} (${pct}%)${streakBit}\n`;
    });

    if ((rows || []).length > limit) {
        text += `\n_…and ${(rows || []).length - limit} more_\n`;
    }
    return text;
}

function istDayKey(ts, tz) {
    if (!ts) return '';
    const d = ts instanceof Date ? ts : new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(d);
}

/** Consecutive IST days (ending today or yesterday) with ≥1 correct vote. */
export function computeStreak(correctDaysSet, nowMs, tz = 'Asia/Kolkata') {
    const days = correctDaysSet instanceof Set ? correctDaysSet : new Set(correctDaysSet || []);
    if (!days.size) return 0;
    let streak = 0;
    let cursor = new Date(nowMs);
    // Allow streak to still count if they haven't played "today" yet (use yesterday as tip).
    const today = istDayKey(cursor, tz);
    if (!days.has(today)) {
        cursor = new Date(cursor.getTime() - 24 * 60 * 60 * 1000);
    }
    for (let i = 0; i < 60; i++) {
        const key = istDayKey(cursor, tz);
        if (!days.has(key)) break;
        streak += 1;
        cursor = new Date(cursor.getTime() - 24 * 60 * 60 * 1000);
    }
    return streak;
}
