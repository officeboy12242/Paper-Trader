/**
 * Persist member messages per group/day for end-of-day recap.
 */

import { normalizeMessageContent, jidNormalizedUser, downloadMediaMessage } from 'baileys';
import pino from 'pino';
import { logger } from '../utils/logger.js';
import { getTextFromWAMessage, resolveConversationChatId } from '../utils/waMessage.js';
import { extractPhoneNumber } from '../utils/permissions.js';
import { getTodayDateStrIST } from '../utils/dateIST.js';
import { clampToSentence } from '../utils/summaryText.js';
import GeminiTradeService from './GeminiTradeService.js';

const REFRESH_MS = 5 * 60_000;
const baileysLogger = pino({ level: 'silent' });
/** Logged text with vision can be longer than plain chat lines. */
const MAX_LOG_TEXT = 700;
const MAX_VISION_BYTES = 4 * 1024 * 1024;
const VISION_DOWNLOAD_MS = 25_000;

/**
 * Combine optional caption + Gemini vision blurb into the stored log line.
 * @param {string} caption
 * @param {string} visionDesc
 */
export function formatImageLogText(caption, visionDesc) {
    const c = String(caption || '').trim();
    const d = String(visionDesc || '')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 280);
    if (!d) return c || '[image]';
    return c ? `${c} — [image: ${d}]` : `[image: ${d}]`;
}

// Chat filler that would otherwise top every frequency count. Hinglish is in
// here too — these groups mix English and Hindi in the same sentence.
const STOP_WORDS = new Set([
    'about', 'after', 'again', 'ahha', 'also', 'always', 'anyone', 'because', 'been', 'before',
    'being', 'below', 'bhai', 'bhi', 'bola', 'both', 'come', 'could', 'dont', 'even', 'ever',
    'every', 'from', 'gaya', 'good', 'guys', 'haan', 'have', 'hain', 'here', 'hoga', 'jaise',
    'just', 'karo', 'kuch', 'like', 'lots', 'main', 'many', 'matlab', 'more', 'most', 'much',
    'nahi', 'never', 'okay', 'only', 'other', 'over', 'please', 'raha', 'rahe', 'really', 'same',
    'says', 'send', 'should', 'some', 'still', 'sure', 'take', 'than', 'thanks', 'that', 'their',
    'them', 'then', 'there', 'these', 'they', 'thing', 'think', 'this', 'those', 'time', 'tume',
    'very', 'want', 'well', 'were', 'what', 'when', 'where', 'which', 'while', 'will', 'with',
    'wont', 'would', 'yaar', 'yeah', 'your',
]);

/**
 * Most repeated meaningful words across a set of logged messages.
 * Used only for the offline recap — it names subjects without quoting anyone.
 */
function topTerms(rows, limit) {
    const counts = new Map();
    for (const row of rows) {
        const text = String(row?.text || '');
        // Placeholders ([sticker]) and links say nothing about the subject.
        if (!text || /^\[/.test(text)) continue;
        const words = text
            .toLowerCase()
            .replace(/https?:\/\/\S+/g, ' ')
            .replace(/[^a-z0-9ऀ-ॿ\s]/g, ' ')
            .split(/\s+/);
        const seen = new Set();
        for (const word of words) {
            if (word.length < 4 || STOP_WORDS.has(word) || /^\d+$/.test(word)) continue;
            // Count each word once per message so one ranty message cannot
            // invent a "topic" on its own.
            if (seen.has(word)) continue;
            seen.add(word);
            counts.set(word, (counts.get(word) || 0) + 1);
        }
    }

    return [...counts.entries()]
        .filter(([, n]) => n >= 2)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, limit)
        .map(([word]) => word);
}

/** "a, b and c" — reads like a sentence instead of a delimiter dump. */
function joinList(items) {
    if (items.length <= 1) return items[0] || '';
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function normalizeGroupId(chatId) {
    if (!chatId?.endsWith('@g.us')) {
        return '';
    }
    const resolved = resolveConversationChatId({ remoteJid: chatId }) || chatId;
    return jidNormalizedUser(String(resolved).replace(/:\d+(?=@)/, '')) || resolved;
}

function describeMessageContent(message) {
    const content = normalizeMessageContent(message);
    if (!content) {
        return null;
    }

    const text = getTextFromWAMessage(message).trim();
    if (text.startsWith('/')) {
        return null;
    }

    if (content.stickerMessage) {
        return text ? `${text} [sticker]` : '[sticker]';
    }
    if (content.imageMessage) {
        return text || '[image]';
    }
    if (content.videoMessage) {
        return text || '[video]';
    }
    if (content.audioMessage || content.pttMessage) {
        return text || '[audio]';
    }
    if (content.documentMessage) {
        return text || '[document]';
    }
    if (content.pollCreationMessage || content.pollUpdateMessage) {
        return text || '[poll]';
    }
    if (content.reactionMessage) {
        return null;
    }

    return text || null;
}

class GroupChatLogService {
    /**
     * @param {import('mongodb').Db} mongoDb
     * @param {import('../models/GroupManager.js').default} groupManager
     * @param {object} config
     */
    constructor(mongoDb, groupManager, config = {}) {
        this.mongoDb = mongoDb;
        this.groupManager = groupManager;
        this.config = config;
        this.maxPerDay = Math.max(50, Number(config.GROUP_SUMMARY_MAX_MESSAGES) || 400);
        // Raised from 100: the summary LLM used to get at most ~60 sampled lines
        // for a 150-message day AND the call layer sliced the prompt at 5000
        // chars, so the model saw less than half the conversation — recaps came
        // out "half and not to the points". The sample now fits the ~14k-char
        // first attempt in NvidiaDeepSeekService.completeWithSummaryRetry.
        this.llmMaxMessages = Math.max(20, Number(config.GROUP_SUMMARY_LLM_MAX_MESSAGES) || 400);
        this.chunkThreshold = Math.max(80, Number(config.GROUP_SUMMARY_CHUNK_THRESHOLD) || 150);
        this.chunkSize = Math.max(30, Math.min(60, Number(config.GROUP_SUMMARY_CHUNK_SIZE) || 50));
        this.narrative = config.GROUP_SUMMARY_NARRATIVE !== false;
        this.imageVisionEnabled = config.GROUP_SUMMARY_IMAGE_VISION !== false;
        this.imageVisionMaxPerDay = Math.max(
            0,
            Number(config.GROUP_SUMMARY_IMAGE_VISION_MAX_PER_DAY) || 40
        );
        this.gemini = new GeminiTradeService(config);
        /** @type {Set<string>} */
        this._enabledGroups = new Set();
        /** @type {Map<string, number>} in-memory daily counts — avoid countDocuments on every msg */
        this._dayCounts = new Map();
        /** @type {Map<string, number>} vision calls per group|date */
        this._visionCounts = new Map();
        this._refreshTimer = null;
        this.collection = null;
    }

    async init() {
        this.collection = this.mongoDb.collection('group_chat_log');
        await this.collection.createIndex(
            { group_id: 1, date: 1, message_id: 1 },
            { unique: true, name: 'group_chat_log_unique' }
        );
        await this.collection.createIndex(
            { created_at: 1 },
            { name: 'group_chat_log_ttl', expireAfterSeconds: 14 * 24 * 60 * 60 }
        );
        await this.refreshEnabledGroups();
        this._refreshTimer = setInterval(() => {
            void this.refreshEnabledGroups();
        }, REFRESH_MS);
        if (this._refreshTimer.unref) {
            this._refreshTimer.unref();
        }
        logger.info('Group chat log service ready');
    }

    stop() {
        if (this._refreshTimer) {
            clearInterval(this._refreshTimer);
            this._refreshTimer = null;
        }
    }

    async refreshEnabledGroups() {
        if (!this.groupManager) {
            return;
        }
        const groups = await this.groupManager.getSummaryEnabledGroups();
        this._enabledGroups = new Set(
            groups.map((g) => normalizeGroupId(g.group_id)).filter(Boolean)
        );
    }

    isLoggingEnabled(groupId) {
        const normalized = normalizeGroupId(groupId);
        return Boolean(normalized && this._enabledGroups.has(normalized));
    }

    /**
     * @param {import('baileys').proto.IWebMessageInfo} msg
     * @param {string} senderJid
     * @param {string} chatId
     * @param {import('baileys').WASocket} [sock] — needed to download image bytes for vision
     */
    async maybeLogMessage(msg, senderJid, chatId, sock = null) {
        if (!this.collection || !this.isLoggingEnabled(chatId) || msg.key?.fromMe) {
            return;
        }

        let body = describeMessageContent(msg.message);
        if (!body) {
            return;
        }

        const storageGroupId = normalizeGroupId(chatId);
        if (!storageGroupId) {
            return;
        }

        const date = getTodayDateStrIST();
        const messageId = msg.key?.id;
        if (!messageId) {
            return;
        }

        const content = normalizeMessageContent(msg.message);
        if (content?.imageMessage && sock) {
            body = await this._enrichImageBody(msg, sock, content.imageMessage, body, storageGroupId, date);
        }

        const senderName = (msg.pushName || '').trim() || 'Member';
        const senderPhone = extractPhoneNumber(senderJid) || '';
        const ts = msg.messageTimestamp
            ? Number(msg.messageTimestamp) * 1000
            : Date.now();

        try {
            const countKey = `${storageGroupId}|${date}`;
            let count = this._dayCounts.get(countKey);
            if (count === undefined) {
                count = await this.collection.countDocuments({ group_id: storageGroupId, date });
                this._dayCounts.set(countKey, count);
                // Bound memory — drop oldest keys if map grows
                if (this._dayCounts.size > 200) {
                    const first = this._dayCounts.keys().next().value;
                    if (first !== undefined) this._dayCounts.delete(first);
                }
            }
            if (count >= this.maxPerDay) {
                return;
            }

            const result = await this.collection.updateOne(
                { group_id: storageGroupId, date, message_id: messageId },
                {
                    $setOnInsert: {
                        group_id: storageGroupId,
                        date,
                        message_id: messageId,
                        sender_name: senderName.slice(0, 64),
                        sender_phone: senderPhone.slice(0, 20),
                        text: body.slice(0, MAX_LOG_TEXT),
                        ts,
                        created_at: new Date(),
                    },
                },
                { upsert: true }
            );
            if (result.upsertedCount) {
                this._dayCounts.set(countKey, count + 1);
            }
        } catch (err) {
            if (err?.code !== 11000) {
                logger.debug(`Group chat log skip: ${err.message}`);
            }
        }
    }

    /**
     * Download the image once and ask Gemini what it shows. Fail-soft: returns
     * the original body ([image] / caption) on any error or quota skip.
     */
    async _enrichImageBody(msg, sock, imageMessage, body, storageGroupId, date) {
        if (!this.imageVisionEnabled || this.imageVisionMaxPerDay <= 0) return body;
        if (!this.gemini.isConfigured()) return body;

        const visionKey = `${storageGroupId}|${date}`;
        const used = this._visionCounts.get(visionKey) || 0;
        if (used >= this.imageVisionMaxPerDay) return body;

        try {
            const buffer = await Promise.race([
                downloadMediaMessage(
                    msg,
                    'buffer',
                    {},
                    {
                        logger: baileysLogger,
                        reuploadRequest: sock.updateMediaMessage?.bind(sock),
                    }
                ),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('image download timeout')), VISION_DOWNLOAD_MS)
                ),
            ]);
            if (!Buffer.isBuffer(buffer) || buffer.length < 32 || buffer.length > MAX_VISION_BYTES) {
                return body;
            }

            const caption = getTextFromWAMessage(msg).trim();
            const mimeType = String(imageMessage.mimetype || 'image/jpeg').split(';')[0];
            const desc = await this.gemini.describeImage(buffer, {
                mimeType,
                caption,
                timeoutMs: 20_000,
            });
            this._visionCounts.set(visionKey, used + 1);
            if (this._visionCounts.size > 200) {
                const first = this._visionCounts.keys().next().value;
                if (first !== undefined) this._visionCounts.delete(first);
            }
            return formatImageLogText(caption, desc);
        } catch (err) {
            logger.debug(`Group chat image vision skipped: ${err.message}`);
            return body;
        }
    }

    /**
     * @param {string} groupId
     * @param {string} dateStr
     */
    async getMessagesForDay(groupId, dateStr) {
        if (!this.collection) {
            return [];
        }
        const normalized = normalizeGroupId(groupId) || groupId;
        return this.collection
            .find({ group_id: normalized, date: dateStr })
            .sort({ ts: 1 })
            .toArray();
    }

    async countMessagesForDay(groupId, dateStr) {
        if (!this.collection) {
            return 0;
        }
        const normalized = normalizeGroupId(groupId) || groupId;
        return this.collection.countDocuments({ group_id: normalized, date: dateStr });
    }

    /**
     * @param {object[]} messages
     */
    computeStats(messages) {
        const senders = new Map(); // Map<sender_phone, { name: string, count: number }>
        const hourCounts = new Array(24).fill(0);
        const hourFormatter = new Intl.DateTimeFormat('en-IN', {
            timeZone: 'Asia/Kolkata',
            hour: 'numeric',
            hour12: false,
        });

        for (const row of messages) {
            const name = row.sender_name || 'Member';
            const phone = row.sender_phone;

            if (phone) {
                const senderStats = senders.get(phone) || { name: name, count: 0 };
                senderStats.count++;
                // Ensure the name is updated in case it changed or was initially 'Member'
                senderStats.name = name;
                senders.set(phone, senderStats);
            }

            const hour = Number(hourFormatter.format(new Date(row.ts)));
            hourCounts[hour] += 1;
        }

        let busiestHour = 0;
        let busiestCount = 0;
        for (let h = 0; h < 24; h++) {
            if (hourCounts[h] > busiestCount) {
                busiestCount = hourCounts[h];
                busiestHour = h;
            }
        }

        // senders maps phone -> { name, count }; destructuring the value as a
        // number made every comparison false, so "Most active" never rendered.
        let topSender = null;
        let topCount = 0;
        for (const stat of senders.values()) {
            if (stat.count > topCount) {
                topCount = stat.count;
                topSender = stat.name;
            }
        }

        const formatHour = (h) => {
            const end = (h + 1) % 24;
            const fmt = (n) => {
                const period = n >= 12 ? 'PM' : 'AM';
                const hour12 = n % 12 || 12;
                return `${hour12} ${period}`;
            };
            return `${fmt(h)} – ${fmt(end)} IST`;
        };

        return {
            totalMessages: messages.length,
            uniqueMembers: senders.size,
            busiestHourLabel: busiestCount > 0 ? formatHour(busiestHour) : null,
            topSender: topSender ? { name: topSender, count: topCount } : null,
        };
    }

    /** Scale down LLM input for busier days to avoid API timeouts. */
    getLlmSampleLimit(totalMessages) {
        // With 1M context models, we can send many more messages
        if (totalMessages <= 200) {
            return Math.min(this.llmMaxMessages, totalMessages);
        }
        if (totalMessages <= 500) {
            return Math.min(400, this.llmMaxMessages);
        }
        if (totalMessages <= 1000) {
            return Math.min(600, this.llmMaxMessages);
        }
        // Very busy days: still send a lot for richer context
        return Math.min(800, this.llmMaxMessages);
    }

    /** Keep conversation edges plus evenly spaced middle messages. */
    sampleMessages(messages, maxLines) {
        if (messages.length <= maxLines) {
            return messages;
        }

        const picked = [];
        const used = new Set();

        const addAt = (idx) => {
            if (idx < 0 || idx >= messages.length || used.has(idx)) {
                return;
            }
            used.add(idx);
            picked.push(messages[idx]);
        };

        for (let i = 0; i < Math.min(4, messages.length); i++) {
            addAt(i);
        }
        for (let i = Math.max(0, messages.length - 4); i < messages.length; i++) {
            addAt(i);
        }

        const slots = maxLines - picked.length;
        for (let i = 0; i < slots; i++) {
            const idx = Math.floor(((i + 0.5) * messages.length) / slots);
            addAt(idx);
        }

        return picked.sort((a, b) => a.ts - b.ts);
    }

    formatMessageLines(messages, textLimit = 120) {
        return messages.map((row) => {
            const time = new Date(row.ts).toLocaleTimeString('en-IN', {
                hour: '2-digit',
                minute: '2-digit',
                timeZone: 'Asia/Kolkata',
            });
            // Word-boundary cut: a message chopped mid-word feeds the model a
            // broken sentence, and broken sentences come back in the recap.
            const text = clampToSentence(row.text || '', textLimit);
            return `[${time}] ${row.sender_name}: ${text}`;
        });
    }

    buildPrompt(messages, groupName, dateLabel) {
        const maxLines = this.getLlmSampleLimit(messages.length);
        const textLimit = messages.length > 300 ? 300 : messages.length > 150 ? 400 : 500;
        const sampled = this.sampleMessages(messages, maxLines);
        const lines = this.formatMessageLines(sampled, textLimit);

        const sampledNote = messages.length > maxLines
            ? `\n(Showing ${sampled.length} of ${messages.length} messages — sampled for recap.)`
            : '';

        const narrativeLines = this.narrative
            ? [
                  'Below is the actual member conversation for the day (name: message).',
                  'Walk through it like a narrator reading the chat log. For each topic:',
                  '  - WHO started it and WHO replied',
                  '  - WHAT was actually said (use exact quotes or close paraphrases)',
                  '  - HOW the conversation evolved (questions → answers, jokes → roasts, debates → conclusions)',
                  '  - The FUNNY or MEMORABLE moments — punchlines, comebacks, hot takes, random tangents',
                  'Do NOT just list random words from the chat. Show the ACTUAL conversations and interactions.',
                  'For each topic, include at least 2-3 actual quotes from different people.',
                  'Extract 3-5 topics with WHO + WHAT + HOW + QUOTES detail for each.',
              ]
            : ['Extract 3-5 concrete topics with short details from the chat lines below.'];

        const body = [
            `Group: ${groupName}`,
            `Date: ${dateLabel}`,
            `Messages (${messages.length}):${sampledNote}`,
            ...narrativeLines,
            lines.join('\n'),
        ].join('\n\n');

        return body;
    }

    /**
     * Split a busy day into at most 3 compact LLM prompts (map-reduce).
     * Samples within each time window so chunks stay small and reliable.
     * @returns {string[]}
     */
    buildChunkPrompts(messages, groupName, dateLabel) {
        const total = messages.length;
        const maxParts = 3;
        const partSize = Math.ceil(total / maxParts);
        const prompts = [];
        const textLimit = 200;  // More context per message in chunks too
        const perChunkSample = 80;  // With 1M context, send more per chunk

        for (let part = 0; part < maxParts; part++) {
            const start = part * partSize;
            if (start >= total) break;
            const chunk = messages.slice(start, start + partSize);
            const sampled = this.sampleMessages(chunk, perChunkSample);
            const lines = this.formatMessageLines(sampled, textLimit);
            const parts = Math.min(maxParts, Math.ceil(total / partSize));

            let body = [
                `Group: ${groupName}`,
                `Date: ${dateLabel}`,
                `Part ${part + 1} of ${parts} (sample of ${sampled.length} from ${chunk.length} msgs; day total ${total})`,
                'Below is the actual member conversation for this part of the day (name: message).',
                'Summarize what people actually discussed — themes, who said what, questions, opinions, decisions — not just that chatting happened.',
                'List 2-4 topics from this part only (JSON topics/notable/wrap_up).',
                lines.join('\n'),
            ].join('\n\n');

            if (body.length > 15000) {
                body = `${body.slice(0, 15000)}\n\n[...truncated...]`;
            }
            prompts.push(body);
        }

        return prompts;
    }

    /**
     * Prefer a single compact sample for most days.
     * Chunk only for very busy days where one sample would be too thin.
     */
    shouldUseChunkedSummary(messages) {
        return messages.length >= Math.max(this.chunkThreshold, 220);
    }

    /**
     * Offline topics when the LLM times out — still useful for the group.
     *
     * This used to paste raw chat lines cut at 60 chars ("Members talked about:
     * <half a message> · <half a message>"), which is why failed recaps read as
     * chopped-up chat. It now names the recurring subjects instead and writes
     * complete sentences around them.
     * @returns {{ topics: object[], notable: string[], wrap_up: string }}
     */
    buildHeuristicSummary(messages, stats) {
        const hourBuckets = new Map();
        for (const row of messages) {
            const hour = new Date(row.ts).toLocaleString('en-IN', {
                timeZone: 'Asia/Kolkata',
                hour: 'numeric',
                hour12: false,
            });
            const h = Number(hour) === 24 ? 0 : Number(hour);
            if (!hourBuckets.has(h)) hourBuckets.set(h, []);
            hourBuckets.get(h).push(row);
        }

        const rankedHours = [...hourBuckets.entries()]
            .sort((a, b) => b[1].length - a[1].length)
            .slice(0, 4);

        const topics = rankedHours.map(([hour, rows], idx) => {
            const period = hour >= 12 ? 'PM' : 'AM';
            const hour12 = hour % 12 || 12;
            const speakers = new Set(rows.map((r) => r.sender_name).filter(Boolean));
            const terms = topTerms(rows, 3);
            const title = idx === 0
                ? `Busiest stretch — around ${hour12} ${period}`
                : `Chat around ${hour12} ${period}`;

            const who = `${rows.length} message${rows.length === 1 ? '' : 's'}` +
                `${speakers.size ? ` from ${speakers.size} member${speakers.size === 1 ? '' : 's'}` : ''}`;
            const detail = terms.length
                ? `${who}, mostly around ${joinList(terms)}.`
                : `${who}, with no single subject dominating.`;
            return { title, detail };
        });

        if (!topics.length) {
            topics.push({
                title: 'Group activity',
                detail:
                    `${stats.totalMessages} message${stats.totalMessages === 1 ? '' : 's'} ` +
                    `from ${stats.uniqueMembers} member${stats.uniqueMembers === 1 ? '' : 's'}.`,
            });
        }

        // "Most active" and "Busiest hour" already have their own lines in the
        // recap — repeating them here just padded it out.
        const notable = [];
        const dayTerms = topTerms(messages, 4);
        if (dayTerms.length) {
            notable.push(`Talk kept coming back to ${joinList(dayTerms)}.`);
        }
        const quietHours = 24 - new Set(messages.map((r) => new Date(r.ts).getUTCHours())).size;
        if (quietHours >= 20 && stats.totalMessages >= 10) {
            notable.push('The whole day happened in just a couple of hours.');
        }

        const wrap_up =
            `Active day with ${stats.totalMessages} messages from ${stats.uniqueMembers} members` +
            `${stats.busiestHourLabel ? `, peaking around ${stats.busiestHourLabel}` : ''}.` +
            (stats.topSender ? ` ${stats.topSender.name} led the chat.` : '') +
            (dayTerms.length ? ` Talk kept coming back to ${joinList(dayTerms)}.` : '');

        return { topics, notable, wrap_up };
    }

    async purgeDay(groupId, dateStr) {
        if (!this.collection) {
            return;
        }
        const normalized = normalizeGroupId(groupId) || groupId;
        await this.collection.deleteMany({ group_id: normalized, date: dateStr });
    }
}

export default GroupChatLogService;
