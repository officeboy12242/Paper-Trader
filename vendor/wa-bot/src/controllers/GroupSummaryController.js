/**
 * Daily end-of-day group chat recap for /summaryon groups.
 */

import { logger } from '../utils/logger.js';
import { formatDateLabelIST, getRecapDateStrIST } from '../utils/dateIST.js';
import NvidiaDeepSeekService, { SUMMARY_SYSTEM_PROMPT } from '../services/NvidiaDeepSeekService.js';
import OpenRouterLlmService from '../services/OpenRouterLlmService.js';
import GeminiTradeService from '../services/GeminiTradeService.js';
import { RECAP_STYLES, DEFAULT_RECAP_STYLE, pickRecapStyle } from '../prompts/recapStyles.js';

/** Extra nudge for free/fallback models that otherwise emit vague "general chat" JSON. */
const SUMMARY_FALLBACK_SYSTEM_PROMPT = [
    SUMMARY_SYSTEM_PROMPT,
    '',
    'CRITICAL ROAST RULES:',
    '1. EVERY topic MUST have a FUNNY TITLE (like a roast award) and include REAL QUOTES.',
    '2. REJECT vague fillers: never use "General discussion", "Casual chat", "Various topics", "Members talked".',
    '3. Each topic must be a ROAST — point out the funny, hypocritical, or unhinged parts.',
    '4. The wrap_up must roast EVERYONE — who was active, who was lazy, who contradicted themselves.',
    '5. Notable moments MUST be the FUNNIEST quotes — the ones people will screenshot and share.',
    '6. If the chat is thin, roast the fact that it\'s thin. "This group went silent faster than Rahul\'s portfolio".',
    '7. The VERDICT is your CLOSING ROAST SET:',
    '   - Roast the group collectively (e.g. "This chat has the financial literacy of a Vegas casino")',
    '   - Roast individuals (e.g. "Rahul\'s relationship with Nifty is more toxic than his last situationship")',
    '   - Call out the most UNHINGED take of the day',
    '   - Praise the MVP who actually carried the chat',
    '   - End with a ONE-LINER PUNCHLINE that makes people screenshot',
    '   - Use CALLBACKS to earlier roast topics for that "if you know, you know" effect',
    '   - Be SAVAGE but LOVING — like roasting your best friends',
].join(' ');

const WEAK_TOPIC_RE =
    /general (chat|discussion|talk)|casual (chat|conversation)|various topics|miscellaneous|random (chat|talk)|members (chatted|talked)|day.?s chat|group chat/i;

/**
 * True when LLM output is specific enough to post (not heuristic-grade fluff).
 * @param {{ topics?: Array<{ title?: string, detail?: string }>, wrap_up?: string }} summary
 */
export function isUsableGroupSummary(summary) {
    const topics = Array.isArray(summary?.topics) ? summary.topics : [];
    if (topics.length < 2) return false;

    let solid = 0;
    for (const t of topics) {
        const title = String(t?.title || '').trim();
        const detail = String(t?.detail || '').trim();
        if (!title) continue;
        if (WEAK_TOPIC_RE.test(title) || WEAK_TOPIC_RE.test(detail)) continue;
        if (detail.length >= 35) solid += 1;
        else if (detail.length >= 15 && title.length >= 8) solid += 1;
    }

    const wrap = String(summary?.wrap_up || '').trim();
    return solid >= 2 || (solid >= 1 && wrap.length >= 80);
}

function parseSummaryTime(timeStr) {
    const [h, m = '0'] = String(timeStr || '00:00').trim().split(':');
    return { hour: Number(h), minute: Number(m) };
}

function currentIstHour() {
    const parts = new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        hour: 'numeric',
        hour12: false,
    }).formatToParts(new Date());
    let hour = Number(parts.find((p) => p.type === 'hour')?.value || 0);
    if (hour === 24) {
        hour = 0;
    }
    return hour;
}

export function formatRecapMessage({ groupName, dateLabel, stats, summary, timeLabel, style = null }) {
    const st = style || RECAP_STYLES[DEFAULT_RECAP_STYLE];
    const h = st.headings;
    let text = '';
    text += '┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n';
    text += `  ${st.banner}\n`;
    text += '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n';
    text += `📅 *${dateLabel}*\n`;
    text += `📢 *${groupName}*\n`;

    // What the group is FOR, inferred from the chat rather than its name — this is
    // what makes the recap read like it knows the room.
    const about = String(summary?.about || '').trim();
    if (about) {
        text += `\n🧭 _${about}_\n`;
    }
    const vibe = String(summary?.vibe || '').trim();
    if (vibe) {
        text += `🎭 *Today's vibe:* ${vibe}\n`;
    }
    text += '─────────────────────────────\n\n';

    text += '📊 *Day at a glance*\n';
    text += `• 💬 ${stats.totalMessages} message(s) from ${stats.uniqueMembers} member(s)\n`;
    if (stats.busiestHourLabel) {
        text += `• 🔥 Busiest hour: ${stats.busiestHourLabel}\n`;
    }
    text += '\n─────────────────────────────\n\n';

    const topics = Array.isArray(summary?.topics) ? summary.topics : [];
    if (topics.length) {
        text += `${h.topics}\n\n`;
        topics.slice(0, 6).forEach((topic, i) => {
            const marks = st.topicMarks?.length ? st.topicMarks : ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣'];
            const emoji = marks[i % marks.length];
            const title = topic?.title || 'Discussion';
            const detail = topic?.detail || '';
            text += `${emoji} *${title}*\n`;
            if (detail) {
                text += `   ${detail}\n`;
            }
            text += '\n';
        });
        text += '─────────────────────────────\n\n';
    }

    const notable = Array.isArray(summary?.notable) ? summary.notable.filter(Boolean) : [];
    if (notable.length) {
        text += `${h.notable}\n`;
        for (const line of notable.slice(0, 4)) {
            text += `• ${line}\n`;
        }
        text += '\n─────────────────────────────\n\n';
    }

    if (stats.topSender) {
        text += `🏆 *Most active:* ${stats.topSender.name} (${stats.topSender.count} msgs)\n\n`;
        text += '─────────────────────────────\n\n';
    }

    const wrapUp = summary?.wrap_up?.trim();
    if (wrapUp) {
        text += `${h.wrapUp}\n`;
        text += `${wrapUp}\n\n`;
        text += '─────────────────────────────\n\n';
    }

    // The closing take. Last thing read, so it is what the group remembers.
    const verdict = String(summary?.verdict || '').trim();
    if (verdict) {
        text += `${h.verdict}\n`;
        text += `_${verdict}_\n\n`;
        text += '─────────────────────────────\n';
    }

    text += `🕐 _Sent at ${timeLabel} IST_`;
    return text;
}

function formatQuietDay(groupName, dateLabel, count, timeLabel, style = null) {
    const st = style || RECAP_STYLES[DEFAULT_RECAP_STYLE];
    let text = '';
    text += '┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n';
    text += `  ${st.banner}\n`;
    text += '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n';
    text += `📅 *${dateLabel}*\n`;
    text += `📢 *${groupName}*\n`;
    text += '─────────────────────────────\n\n';
    if (count === 0) {
        text += '🌙 _Quiet day — no member messages logged._\n';
    } else {
        text += `🌙 _Only ${count} message(s) that day — not enough for a full recap._\n`;
    }
    text += `\n🕐 _Sent at ${timeLabel} IST_`;
    return text;
}

class GroupSummaryController {
    /**
     * @param {import('../services/GroupChatLogService.js').default} chatLog
     * @param {import('../models/GroupManager.js').default} groupManager
     * @param {object} config
     * @param {import('mongodb').Db} [mongoDb]
     */
    constructor(chatLog, groupManager, config = {}, mongoDb = null) {
        this.chatLog = chatLog;
        this.groupManager = groupManager;
        this.config = config;
        this.mongoDb = mongoDb;
        this.nvidia = new NvidiaDeepSeekService(config);
        this.openrouter = new OpenRouterLlmService(config);
        this.gemini = new GeminiTradeService(config);
        this.minMessages = Math.max(1, Number(config.GROUP_SUMMARY_MIN_MESSAGES) || 3);
        this.enabled = config.GROUP_SUMMARY_ENABLED !== false;
        this.timezone = config.GROUP_SUMMARY_TIMEZONE || 'Asia/Kolkata';
        const { hour, minute } = parseSummaryTime(config.GROUP_SUMMARY_TIME);
        this.summaryHour = hour;
        this.summaryMinute = minute;
        this._sock = null;
        this._sentCollection = null;
    }

    _hasLlm() {
        return this.gemini.isConfigured()
            || this._orcaConfigured()
            || this.nvidia.isConfigured()
            || this.openrouter.isConfigured();
    }

    _orcaConfigured() {
        return Boolean(this.config.ORCAROUTER_API_KEY);
    }

    _summaryTimeoutMs() {
        return this.config.GROUP_SUMMARY_LLM_TIMEOUT_MS || this.config.OPENROUTER_TIMEOUT_MS || 90_000;
    }

    /**
     * OrcaRouter — free DeepSeek V4 Flash. Immediate fallback behind Gemini
     * when the Gemini free-tier quota (250 RPD) is exhausted or Gemini returns
     * weak topics. OrcaRouter retired the `pro-free` slug we originally wired
     * up; `flash-free` is what's actually available now, with 128K context.
     * Single-shot even chunk-sized groups; falls through to NVIDIA / OpenRouter
     * on failure.
     */
    async _summarizeViaOrcaRouter(prompt, opts = {}) {
        if (!this._orcaConfigured()) throw new Error('OrcaRouter not configured');
        const model = String(
            this.config.SUMMARY_ORCAROUTER_MODEL || 'deepseek/deepseek-v4-flash-free'
        ).trim();
        const system = opts.system || SUMMARY_FALLBACK_SYSTEM_PROMPT;

        const res = await fetch('https://api.orcarouter.ai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.config.ORCAROUTER_API_KEY}`,
            },
            body: JSON.stringify({
                model,
                messages: [
                    { role: 'system', content: system },
                    { role: 'user', content: prompt },
                ],
                temperature: 0.25,
                // 8K covers the full about+vibe+4-6 topics with quotes+notable+wrap_up+verdict
                // schema without mid-JSON truncation on a busy day.
                max_tokens: opts.maxTokens ?? 8000,
                // DeepSeek reasoning knob — 'low' keeps latency sane while
                // still letting the model think through the recap structure.
                reasoning_effort: 'low',
            }),
            signal: AbortSignal.timeout(this._summaryTimeoutMs()),
        });
        if (!res.ok) {
            const detail = await res.text().catch(() => '');
            throw new Error(`OrcaRouter HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
        }
        const data = await res.json();
        const text = data.choices?.[0]?.message?.content || '';
        if (!text.trim()) throw new Error('OrcaRouter returned empty content');

        const summary = this.nvidia.parseSummaryJson(text);
        if (!isUsableGroupSummary(summary)) {
            logger.warn('Group summary: OrcaRouter returned weak/vague topics');
            return null;
        }
        logger.info(`Group summary: OrcaRouter via ${model}`);
        return summary;
    }

    /**
     * Try Gemini for summarization — primary LLM. 1M ctx single-shots even
     * chunk-sized groups; 8K output tokens covers the full about+vibe+topics+
     * notable+wrap_up+verdict schema comfortably. The real reason recaps
     * never actually came from Gemini before was a bad destructure (see
     * below) — the token bump helps too, but the destructure was the
     * silent killer.
     */
    async _summarizeViaGemini(prompt, opts = {}) {
        if (!this.gemini.isConfigured()) {
            throw new Error('Gemini not configured');
        }
        try {
            // GeminiTradeService.complete() returns a plain string, not an object.
            // The earlier `const { text } = ...` destructure silently left text
            // undefined, which is why every Gemini recap fell through to
            // NVIDIA/OpenRouter with a "weak/vague topics" warning — the JSON
            // was never actually parsed.
            const text = await this.gemini.complete(
                opts.system || SUMMARY_FALLBACK_SYSTEM_PROMPT,
                prompt,
                { temperature: 0.25, maxTokens: opts.maxTokens ?? 8000, timeoutMs: this._summaryTimeoutMs() }
            );
            const summary = this.nvidia.parseSummaryJson(text);
            if (!isUsableGroupSummary(summary)) {
                logger.warn('Group summary: Gemini returned weak/vague topics');
                return null;
            }
            logger.info('Group summary: Gemini summary complete');
            return summary;
        } catch (err) {
            logger.warn('Group summary: Gemini failed: ' + err.message);
            throw err;
        }
    }

    /**
     * Try OpenRouter summary models one-by-one; skip weak/vague JSON and move on.
     * @param {string} prompt
     * @param {{ maxTokens?: number, system?: string }} [opts]
     */
    async _summarizeViaOpenRouter(prompt, opts = {}) {
        const models = this.openrouter.summaryModels?.length
            ? this.openrouter.summaryModels
            : this.openrouter.models;
        let lastErr;
        let lastWeak = null;

        for (const model of models) {
            try {
                const { text } = await this.openrouter.chat({
                    system: opts.system || SUMMARY_FALLBACK_SYSTEM_PROMPT,
                    user: prompt,
                    temperature: 0.25,
                    maxTokens: opts.maxTokens ?? 1400,
                    timeoutMs: this._summaryTimeoutMs(),
                    models: [model],
                });
                const summary = this.nvidia.parseSummaryJson(text);
                if (!isUsableGroupSummary(summary)) {
                    lastWeak = summary;
                    logger.warn(
                        `Group summary: OpenRouter ${model} returned weak/vague topics — trying next model`
                    );
                    continue;
                }
                logger.info(`Group summary: OpenRouter via ${model}`);
                return summary;
            } catch (err) {
                lastErr = err;
                logger.warn(`Group summary: OpenRouter ${model} failed: ${err.message}`);
            }
        }

        if (lastWeak && (lastWeak.topics?.length || lastWeak.wrap_up)) {
            logger.warn('Group summary: all OpenRouter models weak — using best-effort last result');
            return lastWeak;
        }
        throw lastErr || new Error('OpenRouter summary failed');
    }

    /**
     * Same map-reduce path as NVIDIA — used when NVIDIA fails or is unset.
     * @param {string[]} chunkPrompts
     * @param {{ groupName?: string, dateLabel?: string, totalMessages?: number }} [meta]
     */
    async _summarizeChunksViaOpenRouter(chunkPrompts, meta = {}) {
        if (!chunkPrompts.length) {
            throw new Error('No chunk prompts provided');
        }
        if (chunkPrompts.length === 1) {
            return this._summarizeViaOpenRouter(chunkPrompts[0]);
        }

        const partials = [];
        for (let i = 0; i < chunkPrompts.length; i++) {
            logger.info(
                `Group recap OpenRouter chunk ${i + 1}/${chunkPrompts.length} ` +
                    `for ${meta.groupName || 'group'}`
            );
            try {
                partials.push(await this._summarizeViaOpenRouter(chunkPrompts[i], { maxTokens: 3000 }));
            } catch (err) {
                logger.warn(
                    `Group recap OpenRouter chunk ${i + 1}/${chunkPrompts.length} failed: ${err.message}`
                );
            }
        }

        if (!partials.length) {
            throw new Error('All OpenRouter recap chunks failed');
        }
        if (partials.length === 1) {
            return partials[0];
        }

        const mergePrompt = [
            'Merge these partial WhatsApp group recap JSON summaries into one final recap.',
            meta.groupName ? `Group: ${meta.groupName}` : '',
            meta.dateLabel ? `Date: ${meta.dateLabel}` : '',
            meta.totalMessages ? `Total messages that day: ${meta.totalMessages}` : '',
            'Combine overlapping topics, keep 3-5 topics total, 0-3 notable items, one wrap_up.',
            'PRESERVE ACTUAL QUOTES from the chat — these are the most valuable part.',
            'Keep concrete details (names, subjects, quotes) — drop vague fillers like "talked about various things".',
            'Also produce ONE about / vibe / verdict for the whole day, not per part:',
            'about = what this group is for, judged across every part;',
            'vibe = a 3-6 word mood tag; verdict = 2-4 sentences of your own opinion on the day, in character.',
            '',
            ...partials.map((part, idx) => `Part ${idx + 1}:\n${JSON.stringify(part)}`),
        ]
            .filter(Boolean)
            .join('\n');

        const mergeSystem = [
            'You merge partial group chat recap JSON objects into one final recap.',
            'Reply with ONLY valid JSON (no markdown fences) in this shape:',
            '{"about":"one line on what this group is for","vibe":"3-6 word mood tag",',
            '"topics":[{"title":"short title","detail":"1-2 sentences"}],"notable":["bullet strings"],',
            '"wrap_up":"2-4 sentence paragraph","verdict":"2-4 sentences of your own opinion, in character"}',
            'Deduplicate topics; preserve the most important concrete details and ACTUAL QUOTES from each part.',
            'Each topic detail should include at least one real quote or paraphrase from the chat.',
            'about/vibe/verdict describe the WHOLE day — write them fresh, do not concatenate the parts.',
        ].join(' ');

        try {
            const merged = await this._summarizeViaOpenRouter(mergePrompt, {
                system: mergeSystem,
                maxTokens: 3000,
            });
            if (isUsableGroupSummary(merged) || merged.topics?.length) {
                return merged;
            }
            return this.nvidia.mergePartialsLocally(partials, meta);
        } catch (err) {
            logger.warn(`Group recap OpenRouter merge failed, using local merge: ${err.message}`);
            return this.nvidia.mergePartialsLocally(partials, meta);
        }
    }

    async _summarizeDay(messages, groupName, dateLabel, style = null) {
        const useChunks = this.chatLog.shouldUseChunkedSummary(messages);
        const chunkMeta = {
            groupName,
            dateLabel,
            totalMessages: messages.length,
        };

        // Gemini 2.5 Flash (1M ctx, 250 RPD, 10 RPM free) is the primary
        // summary path: strongest instruction-following on the JSON schema of
        // any free provider, single-shots even chunk-sized groups on a 1M
        // window. OrcaRouter DeepSeek Flash is the immediate fallback for
        // quota-exhaustion days; the NVIDIA/OpenRouter chunk chain only runs
        // if both free single-shot routes are down.
        const basePromptCached = () => {
            const bp = this.chatLog.buildPrompt(messages, groupName, dateLabel);
            return style?.persona ? `${bp}\n\n${style.persona}` : bp;
        };

        if (this.gemini.isConfigured()) {
            try {
                const prompt = basePromptCached();
                logger.info(
                    `Group summary via Gemini: ${groupName} — ${messages.length} msgs, ` +
                        `prompt ${prompt.length} chars${useChunks ? ' [chunk threshold reached — bypassing]' : ''}`
                );
                const result = await this._summarizeViaGemini(prompt);
                if (result) return result;
            } catch (err) {
                logger.warn(`Group summary: Gemini failed for ${groupName}: ${err.message}`);
            }
        }

        if (this._orcaConfigured()) {
            try {
                const prompt = basePromptCached();
                logger.info(
                    `Group summary via OrcaRouter DeepSeek: ${groupName} — ${messages.length} msgs, ` +
                        `prompt ${prompt.length} chars${useChunks ? ' [chunk threshold reached — bypassing]' : ''}`
                );
                const result = await this._summarizeViaOrcaRouter(prompt);
                if (result) return result;
            } catch (err) {
                logger.warn(`Group summary: OrcaRouter failed for ${groupName}: ${err.message}`);
            }
        }

        if (useChunks) {
            const rawChunks = this.chatLog.buildChunkPrompts(messages, groupName, dateLabel);
            // Long chats go down this path — without the persona here, big groups
            // would get styled headings wrapped around a flat, default voice.
            const chunkPrompts = style?.persona
                ? rawChunks.map((c) => `${c}\n\n${style.persona}`)
                : rawChunks;
            logger.info(
                `Group summary: ${groupName} — ${messages.length} msgs, ` +
                    `${chunkPrompts.length} chunk(s) for map-reduce`
            );
            // Gemini already tried single-shot above (1M ctx handles everything);
            // if we're here it either 429'd or returned weak, so skip straight to
            // NVIDIA/OpenRouter map-reduce rather than burning another Gemini call.
            if (this.nvidia.isConfigured()) {
                try {
                    return await this.nvidia.summarizeGroupChatChunks(chunkPrompts, chunkMeta);
                } catch (err) {
                    logger.warn(`NVIDIA chunk recap failed for ${groupName}: ${err.message}`);
                    if (!this.openrouter.isConfigured()) throw err;
                    return this._summarizeChunksViaOpenRouter(chunkPrompts, chunkMeta);
                }
            }
            return this._summarizeChunksViaOpenRouter(chunkPrompts, chunkMeta);
        }

        const basePrompt = this.chatLog.buildPrompt(messages, groupName, dateLabel);
        // The persona goes in the USER prompt, not the system one, so it survives
        // every provider path below — each has its own system prompt and would
        // otherwise silently drop the style, changing headings but not the voice.
        const prompt = style?.persona ? `${basePrompt}\n\n${style.persona}` : basePrompt;
        logger.info(
            `Group summary: ${groupName} — ${messages.length} msgs, prompt ${prompt.length} chars` +
                (style ? `, style ${style.key}` : '')
        );
        // Gemini already ran in the primary bypass above; go straight to NVIDIA.
        if (this.nvidia.isConfigured()) {
            try {
                const summary = await this.nvidia.summarizeGroupChat(prompt);
                if (isUsableGroupSummary(summary) || summary?.topics?.length) {
                    return summary;
                }
                logger.warn(`NVIDIA recap for ${groupName} looked weak — trying OpenRouter`);
                if (this.openrouter.isConfigured()) {
                    return this._summarizeViaOpenRouter(prompt);
                }
                return summary;
            } catch (err) {
                logger.warn(`NVIDIA recap failed for ${groupName}: ${err.message}`);
                if (!this.openrouter.isConfigured()) throw err;
                return this._summarizeViaOpenRouter(prompt);
            }
        }
        return this._summarizeViaOpenRouter(prompt);
    }

    async init() {
        if (!this.mongoDb) {
            return;
        }
        this._sentCollection = this.mongoDb.collection('group_summary_sent');
        await this._sentCollection.createIndex(
            { group_id: 1, recap_date: 1 },
            { unique: true, name: 'group_summary_sent_unique' }
        );
    }

    setSock(sock) {
        this._sock = sock;
    }

    async wasRecapSent(groupId, dateStr) {
        if (!this._sentCollection) {
            return false;
        }
        const row = await this._sentCollection.findOne({ group_id: groupId, recap_date: dateStr });
        return Boolean(row);
    }

    async markRecapSent(groupId, dateStr) {
        if (!this._sentCollection) {
            return;
        }
        await this._sentCollection.updateOne(
            { group_id: groupId, recap_date: dateStr },
            { $set: { sent_at: new Date() } },
            { upsert: true }
        );
    }

    /** Morning catch-up if bot missed the midnight run (restart/deploy). */
    async runCatchUpIfNeeded(sock = this._sock) {
        if (!this.enabled || !sock || !this._hasLlm()) {
            return;
        }

        const istHour = currentIstHour();
        if (istHour >= 12) {
            return;
        }

        const dateStr = getRecapDateStrIST(Date.now(), this.summaryHour, this.summaryMinute);
        const groups = await this.groupManager.getSummaryEnabledGroups();
        if (!groups.length) {
            return;
        }

        let pending = 0;
        for (const group of groups) {
            if (!(await this.wasRecapSent(group.group_id, dateStr))) {
                pending++;
            }
        }
        if (!pending) {
            return;
        }

        logger.info(`🗓️ Catch-up recap for ${pending} group(s) (missed midnight) — date ${dateStr}`);
        await this.postDailySummaries(sock, { dateStr, skipSentCheck: false });
    }

    async postRecapForGroup(sock, groupId, { dateStr = null, force = false } = {}) {
        if (!this.enabled || !sock) {
            throw new Error('Recap service not ready');
        }
        if (!this._hasLlm()) {
            throw new Error('No summary LLM configured (set GEMINI_API_KEY, ORCAROUTER_API_KEY, NVIDIA_API_KEY, or OPENROUTER_API_KEY)');
        }

        const groups = await this.groupManager.getSummaryEnabledGroups();
        const group = groups.find((g) => g.group_id === groupId);
        if (!group) {
            throw new Error('Group recap is not enabled here');
        }

        let recapDate;
        if (dateStr) {
            recapDate = dateStr;
        } else if (force) {
            // For /summarynow, always summarize for today
            const now = new Date();
            const options = {
                timeZone: 'Asia/Kolkata',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit'
            };
            recapDate = new Intl.DateTimeFormat('en-CA', options).format(now);
        } else {
            // For scheduled summaries, use the recap date logic
            recapDate = getRecapDateStrIST(Date.now(), this.summaryHour, this.summaryMinute);
        }
        const dateLabel = formatDateLabelIST(recapDate);
        const timeLabel = `${String(this.summaryHour).padStart(2, '0')}:${String(this.summaryMinute).padStart(2, '0')}`;

        const ok = await this.postSummaryForGroup(
            sock,
            group,
            recapDate,
            dateLabel,
            timeLabel,
            { force }
        );
        if (ok) {
            await this.markRecapSent(group.group_id, recapDate);
        }
        return ok;
    }

    async postDailySummaries(sock = this._sock, { dateStr = null, skipSentCheck = false, force = false } = {}) {
        if (!this.enabled) {
            logger.warn('Group summary: disabled (GROUP_SUMMARY_ENABLED=false)');
            return;
        }
        if (!sock) {
            logger.warn('Group summary: no socket, skipping');
            return;
        }
        if (!this._hasLlm()) {
            logger.warn('Group summary: no Gemini/OrcaRouter/NVIDIA/OpenRouter key, skipping');
            return;
        }

        const groups = await this.groupManager.getSummaryEnabledGroups();
        if (!groups.length) {
            logger.info('Group summary: no /summaryon groups');
            return;
        }

        const recapDate = dateStr || getRecapDateStrIST(Date.now(), this.summaryHour, this.summaryMinute);
        const dateLabel = formatDateLabelIST(recapDate);
        const timeLabel = `${String(this.summaryHour).padStart(2, '0')}:${String(this.summaryMinute).padStart(2, '0')}`;

        logger.info(`🗓️ Posting group day recap for ${groups.length} group(s) — date ${recapDate}...`);

        let sent = 0;
        let skipped = 0;
        for (const group of groups) {
            try {
                if (!skipSentCheck && !force && (await this.wasRecapSent(group.group_id, recapDate))) {
                    skipped++;
                    continue;
                }

                const ok = await this.postSummaryForGroup(
                    sock,
                    group,
                    recapDate,
                    dateLabel,
                    timeLabel,
                    { force }
                );
                if (ok) {
                    sent++;
                    await this.markRecapSent(group.group_id, recapDate);
                } else {
                    skipped++;
                }
                await new Promise((r) => setTimeout(r, 800));
            } catch (err) {
                logger.error(`Group summary failed for ${group.group_id}: ${err.message}`);
            }
        }
        logger.info(`🗓️ Group day recap done: ${sent} sent, ${skipped} skipped, ${groups.length} total`);
    }

    async postSummaryForGroup(sock, group, dateStr, dateLabel, timeLabel, { force = false } = {}) {
        const groupId = group.group_id;
        const groupName = group.group_name || groupId;
        const messages = await this.chatLog.getMessagesForDay(groupId, dateStr);
        // Quiet days get the personality too, and must agree with the style a full
        // recap for the same group+date would have used.
        const quietStyle = pickRecapStyle(groupId, dateStr, this.config.GROUP_SUMMARY_STYLE);

        if (messages.length === 0) {
            logger.warn(
                `Group summary: 0 logged messages for ${groupName} on ${dateStr} ` +
                    '(need /summaryon before chat + member messages that day)'
            );
            if (force) {
                await sock.sendMessage(groupId, {
                    text: formatQuietDay(groupName, dateLabel, 0, timeLabel, quietStyle),
                });
                return true;
            }
            return false;
        }

        if (messages.length < this.minMessages) {
            logger.info(`Group summary: ${groupName} only ${messages.length} msg(s) on ${dateStr} (min ${this.minMessages})`);
            await sock.sendMessage(groupId, {
                text: formatQuietDay(groupName, dateLabel, messages.length, timeLabel, quietStyle),
            });
            await this.chatLog.purgeDay(groupId, dateStr);
            return true;
        }

        const stats = this.chatLog.computeStats(messages);
        const startedAt = Date.now();
        const heuristic = this.chatLog.buildHeuristicSummary(messages, stats);

        // Deterministic per group per day, so a retry or a self-heal re-run cannot
        // hand the same group a second personality for the same date.
        const style = quietStyle;

        let summary;
        try {
            summary = await this._summarizeDay(messages, groupName, dateLabel, style);
            logger.info(`Group summary: ${groupName} LLM done in ${Date.now() - startedAt}ms`);
        } catch (err) {
            logger.error(`Recap LLM failed for ${groupName}: ${err.message}`);
            summary = null;
        }

        // Always show topics — fill gaps from chat activity if LLM timed out or returned empty
        if (!summary?.topics?.length) {
            logger.warn(`Group summary: using heuristic topics for ${groupName}`);
            // Spread first: rebuilding the object from scratch here silently dropped
            // about / vibe / verdict even when the model had produced them.
            summary = {
                ...(summary || {}),
                topics: heuristic.topics,
                notable: summary?.notable?.length ? summary.notable : heuristic.notable,
                wrap_up: summary?.wrap_up?.trim() || heuristic.wrap_up,
            };
        } else if (!summary.wrap_up?.trim()) {
            summary.wrap_up = heuristic.wrap_up;
        }
        if (!summary.notable?.length && heuristic.notable.length) {
            summary.notable = heuristic.notable;
        }

        const text = formatRecapMessage({
            groupName,
            dateLabel,
            stats,
            summary,
            timeLabel,
            style,
        });

        await sock.sendMessage(groupId, { text });
        await this.chatLog.purgeDay(groupId, dateStr);
        logger.info(`✅ Group recap sent to ${groupName} (${messages.length} msgs)`);
        return true;
    }
}

export default GroupSummaryController;
