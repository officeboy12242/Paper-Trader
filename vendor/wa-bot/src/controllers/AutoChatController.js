/**
 * Daily auto open/close of group chat (/autochat on groups).
 *
 * Each enabled group is unlocked (members may message) at AUTOCHAT_OPEN_TIME
 * with a short LLM "good morning" built from the group's title + description,
 * then locked back to admins-only at AUTOCHAT_CLOSE_TIME with a quick
 * good-night. Lock/unlock goes through WhatsApp's announcement group setting,
 * so the bot must be a group admin for the mode change to take effect — when it
 * is not, the open/close messages still post and only the mode change is
 * skipped.
 */

import { logger } from '../utils/logger.js';
import { formatDayKey } from '../utils/newsScheduler.js';
import GeminiTradeService from '../services/GeminiTradeService.js';
import OpenRouterLlmService from '../services/OpenRouterLlmService.js';

export const AUTOCHAT_KIND_OPEN = 'open';
export const AUTOCHAT_KIND_CLOSE = 'close';

export const DEFAULT_OPEN_TIME = '09:00';
export const DEFAULT_CLOSE_TIME = '23:55';

const LLM_SYSTEM_PROMPT = [
    'You write short, friendly WhatsApp group announcements for a bot.',
    'Reply with ONLY the announcement text — 2-3 short lines, under 40 words.',
    'WhatsApp formatting allowed (*bold*, emojis). No hashtags, no hashtags spam,',
    'no preamble like "Here is your message", no quotes wrapping the whole text.',
].join(' ');

/** Between-group pacing for scheduled runs so WhatsApp never sees a burst. */
const INTER_GROUP_DELAY_MS = 700;

export function parseClockTime(timeStr) {
    const [h, m = '0'] = String(timeStr || '').trim().split(':');
    const hour = Number(h);
    const minute = Number(m);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
        return null;
    }
    return { hour, minute, minutes: hour * 60 + minute };
}

/** '9:00' / '23:55' → '9:00 AM' / '11:55 PM' style label. */
export function formatClockLabel(timeStr) {
    const t = parseClockTime(timeStr);
    if (!t) return String(timeStr || '');
    const h12 = t.hour % 12 === 0 ? 12 : t.hour % 12;
    const suffix = t.hour < 12 ? 'AM' : 'PM';
    return `${h12}:${String(t.minute).padStart(2, '0')} ${suffix}`;
}

/** One-line topic teaser from the group description (first sentence, capped). */
function aboutLine(desc) {
    const d = String(desc || '').trim().replace(/\s+/g, ' ');
    if (!d) return '';
    const sentence = d.split(/(?<=[.!?])\s+/)[0] || d;
    return sentence.length > 110 ? `${sentence.slice(0, 107)}...` : sentence;
}

function shortSubject(subject) {
    const s = String(subject || '').trim();
    return s.length > 40 ? `${s.slice(0, 37)}...` : s;
}

/**
 * Offline fallback used when no LLM key is configured or the call fails —
 * short, on-topic, and honest about the schedule.
 */
export function buildFallbackMessage(
    kind,
    { subject = '', desc = '' } = {},
    { openLabel = '9:00 AM', closeLabel = '11:55 PM' } = {}
) {
    const who = shortSubject(subject) || 'everyone';
    const about = aboutLine(desc);
    if (kind === AUTOCHAT_KIND_OPEN) {
        const lines = [
            `🌅 *Good morning, ${who}!*`,
            `The chat is now *OPEN* ☀️ — open till ${closeLabel} tonight.`,
        ];
        if (about) {
            lines.push(`_${about}_`);
        }
        lines.push('Let\'s make today a good one! 🚀');
        return lines.join('\n');
    }
    return [
        `🌙 *Good night, ${who}!*`,
        `Chat is now closed for the night — back at ${openLabel} tomorrow. 👋`,
    ].join('\n');
}

/**
 * Trim LLM output to a safe short plain message; '' means "use the fallback".
 */
export function sanitizeGeneratedText(text) {
    let t = String(text || '').trim();
    if (!t) return '';
    // Strip markdown fences and any code wrappers the model may have added.
    t = t.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').trim();
    if (!t) return '';
    // Some models echo the instruction back — drop the obvious prefixes.
    t = t.replace(
        /^(?:here(?:'s| is)?(?: your| a)? (?:short |daily )?(?:opening|closing|announcement|message)?\s*:?\s*|message\s*:\s*)/i,
        ''
    ).trim();
    t = t.replace(/^["'«»]+|["'«»]+$/g, '').trim();
    if (!t) return '';
    t = t.replace(/\n{3,}/g, '\n\n').trim();
    if (t.length > 600) {
        t = `${t.slice(0, 597)}...`;
    }
    return t;
}

class AutoChatController {
    /**
     * @param {import('../models/GroupManager.js').default} groupManager
     * @param {object} config
     * @param {import('mongodb').Db} [mongoDb]
     */
    constructor(groupManager, config = {}, mongoDb = null) {
        this.groupManager = groupManager;
        this.config = config;
        this.mongoDb = mongoDb;
        this.enabled = config.AUTOCHAT_ENABLED !== false;
        this.timezone = config.AUTOCHAT_TIMEZONE || 'Asia/Kolkata';
        this.openLabel = formatClockLabel(config.AUTOCHAT_OPEN_TIME || DEFAULT_OPEN_TIME);
        this.closeLabel = formatClockLabel(config.AUTOCHAT_CLOSE_TIME || DEFAULT_CLOSE_TIME);
        this.openTime = parseClockTime(config.AUTOCHAT_OPEN_TIME || DEFAULT_OPEN_TIME) || parseClockTime(DEFAULT_OPEN_TIME);
        this.closeTime = parseClockTime(config.AUTOCHAT_CLOSE_TIME || DEFAULT_CLOSE_TIME) || parseClockTime(DEFAULT_CLOSE_TIME);
        this.llmTimeoutMs = Math.min(60_000, Math.max(5_000, Number(config.AUTOCHAT_LLM_TIMEOUT_MS) || 25_000));
        this.gemini = new GeminiTradeService(config);
        this.openrouter = new OpenRouterLlmService(config);
        this._logCol = null;
    }

    async init() {
        if (!this.mongoDb) {
            return;
        }
        this._logCol = this.mongoDb.collection('auto_chat_log');
        await this._logCol.createIndex(
            { group_id: 1, day: 1, kind: 1 },
            { unique: true, name: 'auto_chat_log_unique' }
        );
    }

    _dateStr(ms = Date.now()) {
        return formatDayKey(new Date(ms), this.timezone);
    }

    _nowMinutes(ms = Date.now()) {
        const p = new Intl.DateTimeFormat('en-CA', {
            timeZone: this.timezone,
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
            hourCycle: 'h23',
        }).formatToParts(new Date(ms));
        const hour = Number(p.find((x) => x.type === 'hour')?.value || 0) % 24;
        const minute = Number(p.find((x) => x.type === 'minute')?.value || 0);
        return hour * 60 + minute;
    }

    _hasLlm() {
        return this.gemini.isConfigured() || this.openrouter.isConfigured();
    }

    async _wasDone(groupId, day, kind) {
        if (!this._logCol) return false;
        const row = await this._logCol.findOne({ group_id: groupId, day, kind });
        return Boolean(row);
    }

    async _markDone(groupId, day, kind) {
        if (!this._logCol) return;
        await this._logCol.updateOne(
            { group_id: groupId, day, kind },
            { $set: { done_at: new Date() } },
            { upsert: true }
        );
    }

    /**
     * Bring the group's announcement mode in line with the schedule. Best-effort:
     * WhatsApp rejects the change when the bot is not a group admin.
     * @returns {Promise<object|null>} fresh group metadata (null if unfetchable)
     */
    async _setMode(sock, groupId, open) {
        let meta = null;
        try {
            meta = await this.groupManager.getGroupMetadataCached(sock, groupId);
        } catch (err) {
            logger.warn(`autochat: metadata fetch failed for ${groupId}: ${err.message}`);
        }
        const desiredAnnounce = !open;
        if (meta && typeof meta.announce === 'boolean' && meta.announce === desiredAnnounce) {
            return meta;
        }
        try {
            await sock.groupSettingUpdate(groupId, open ? 'not_announcement' : 'announcement');
            logger.info(
                `autochat: ${open ? 'opened' : 'closed'} ${groupId}` +
                    (meta && typeof meta.announce === 'boolean' ? ` (was ${meta.announce ? 'locked' : 'open'})` : '')
            );
        } catch (err) {
            // ponytail: no admin rights = messages-only mode. We keep posting the
            // open/close notes; a human admin has to lock/unlock manually.
            logger.warn(
                `autochat: could not ${open ? 'open' : 'close'} ${groupId} ` +
                    `— is the bot a group admin? ${err.message}`
            );
        }
        return meta;
    }

    /** LLM opening/closing note from group title + description; '' → fallback. */
    async _announceText(kind, meta, subjectFallback = '') {
        const subject = shortSubject(meta?.subject || subjectFallback);
        const desc = String(meta?.desc || '').trim();
        if (!this._hasLlm()) {
            return '';
        }
        const isOpen = kind === AUTOCHAT_KIND_OPEN;
        const when = isOpen ? this.openLabel : this.closeLabel;
        const reopen = this.openLabel;
        const prompt = [
            `Write the daily ${isOpen ? 'opening' : 'closing'} message for this WhatsApp group.`,
            `Group name: ${subject || '(not set)'}`,
            `Group description: ${desc || '(none)'}`,
            isOpen
                ? `The bot is unlocking the chat right now (${when}). Greet the group and mention what it is about, using the title/description, in one short line; then one line nudging members to jump in; then a short sign-off.`
                : `The bot is locking the chat for the night (${when}) and it reopens at ${reopen} tomorrow. Say a quick good night that lightly nods at what the group is about — keep it about GitHub, tech and learning. No developer jargon: do not mention commits, merges, builds, PRs, code or CI — just a warm, simple good night.`,
            'Short and simple.',
        ].join('\n');

        let text = '';
        if (this.gemini.isConfigured()) {
            try {
                // gemini-2.5 models spend output tokens on internal "thoughts"
                // before the reply; 300 leaves only ~10-30 tokens for the actual
                // message and cuts it mid-sentence (MAX_TOKENS). 1024 keeps the
                // final text intact — sanitizeGeneratedText caps it at 600 chars.
                text = await this.gemini.complete(LLM_SYSTEM_PROMPT, prompt, {
                    temperature: 0.8,
                    maxTokens: 1024,
                    timeoutMs: this.llmTimeoutMs,
                });
            } catch (err) {
                logger.warn(`autochat: Gemini note failed: ${err.message}`);
            }
        }
        if (!text && this.openrouter.isConfigured()) {
            try {
                const res = await this.openrouter.chat({
                    system: LLM_SYSTEM_PROMPT,
                    user: prompt,
                    temperature: 0.8,
                    maxTokens: 800,
                    timeoutMs: this.llmTimeoutMs,
                });
                text = res?.text || '';
            } catch (err) {
                logger.warn(`autochat: OpenRouter note failed: ${err.message}`);
            }
        }
        const clean = sanitizeGeneratedText(text);
        if (!clean) {
            logger.info(`autochat: LLM note unavailable for ${subject} — using fallback`);
        }
        return clean;
    }

    async _send(sock, groupId, text) {
        try {
            await sock.sendMessage(groupId, { text });
            return true;
        } catch (err) {
            logger.warn(`autochat: send failed to ${groupId}: ${err.message}`);
            return false;
        }
    }

    /**
     * Open one group for the day: unlock + LLM greeting (once per group per day).
     * @returns {Promise<'ok'|'already'|'skipped'>}
     */
    async openChat(sock, groupId, { day = null } = {}) {
        const d = day || this._dateStr();
        if (await this._wasDone(groupId, d, AUTOCHAT_KIND_OPEN)) {
            return 'already';
        }
        const meta = await this._setMode(sock, groupId, true);
        const text =
            (await this._announceText(AUTOCHAT_KIND_OPEN, meta)) ||
            buildFallbackMessage(AUTOCHAT_KIND_OPEN, meta, {
                openLabel: this.openLabel,
                closeLabel: this.closeLabel,
            });
        await this._send(sock, groupId, text);
        await this._markDone(groupId, d, AUTOCHAT_KIND_OPEN);
        logger.info(`autochat: opening message sent to ${groupId}`);
        return 'ok';
    }

    /**
     * Close one group for the night: lock first, then a short good-night (unless silent).
     * @returns {Promise<'ok'|'already'|'skipped'>}
     */
    async closeChat(sock, groupId, { day = null, silent = false } = {}) {
        const d = day || this._dateStr();
        if (await this._wasDone(groupId, d, AUTOCHAT_KIND_CLOSE)) {
            return 'already';
        }
        const meta = await this._setMode(sock, groupId, false);
        if (!silent) {
            const text =
                (await this._announceText(AUTOCHAT_KIND_CLOSE, meta)) ||
                buildFallbackMessage(AUTOCHAT_KIND_CLOSE, meta, {
                    openLabel: this.openLabel,
                    closeLabel: this.closeLabel,
                });
            await this._send(sock, groupId, text);
        }
        await this._markDone(groupId, d, AUTOCHAT_KIND_CLOSE);
        logger.info(`autochat: ${silent ? 'closed' : 'closing message sent to'} ${groupId}`);
        return 'ok';
    }

    /** Scheduled 09:00 run — every enabled group that is not yet opened today. */
    async runOpenTransition(sock) {
        if (!this.enabled || !sock) return 0;
        const groups = await this.groupManager.getAutoChatEnabledGroups();
        if (!groups.length) return 0;
        let opened = 0;
        for (const group of groups) {
            try {
                const res = await this.openChat(sock, group.group_id);
                if (res === 'ok') opened += 1;
            } catch (err) {
                logger.error(`autochat: open failed for ${group.group_id}: ${err.message}`);
            }
            if (opened) await new Promise((r) => setTimeout(r, INTER_GROUP_DELAY_MS));
        }
        logger.info(`autochat: scheduled open done — ${opened} group(s) opened`);
        return opened;
    }

    /** Scheduled 23:55 run — every enabled group that is not yet closed today. */
    async runCloseTransition(sock) {
        if (!this.enabled || !sock) return 0;
        const groups = await this.groupManager.getAutoChatEnabledGroups();
        if (!groups.length) return 0;
        let closed = 0;
        for (const group of groups) {
            try {
                const res = await this.closeChat(sock, group.group_id);
                if (res === 'ok') closed += 1;
            } catch (err) {
                logger.error(`autochat: close failed for ${group.group_id}: ${err.message}`);
            }
            if (closed) await new Promise((r) => setTimeout(r, INTER_GROUP_DELAY_MS));
        }
        logger.info(`autochat: scheduled close done — ${closed} group(s) closed`);
        return closed;
    }

    /**
     * Called right after `/autochat on`: snap the group to where the clock says
     * it should be, so enabling mid-morning opens + greets immediately and
     * enabling at night locks without a 1 AM good-night note.
     * @returns {Promise<'opened'|'already-open'|'closed'|'already-closed'|'skipped'>}
     */
    async alignGroupToSchedule(sock, groupId) {
        if (!sock) return 'skipped';
        const nowMin = this._nowMinutes();
        if (nowMin >= this.openTime.minutes && nowMin < this.closeTime.minutes) {
            const res = await this.openChat(sock, groupId);
            if (res === 'ok') return 'opened';
            if (res === 'already') return 'already-open';
            return 'skipped';
        }
        const day = nowMin < this.openTime.minutes ? this._dateStr(Date.now() - 24 * 60 * 60 * 1000) : this._dateStr();
        const res = await this.closeChat(sock, groupId, { day, silent: true });
        if (res === 'ok') return 'closed';
        if (res === 'already') return 'already-closed';
        return 'skipped';
    }

    /**
     * Startup catch-up: the bot may have been offline across a transition
     * (Render sleep / redeploy). Groups still open from yesterday get locked
     * silently; groups still locked after 09:00 get opened + greeted.
     */
    async runCatchUpIfNeeded(sock) {
        if (!this.enabled || !sock || this.config.AUTOCHAT_CATCHUP_ENABLED === false) {
            return 0;
        }
        const groups = await this.groupManager.getAutoChatEnabledGroups();
        if (!groups.length) return 0;
        const nowMin = this._nowMinutes();
        const today = this._dateStr();
        const yesterday = this._dateStr(Date.now() - 24 * 60 * 60 * 1000);
        let changed = 0;
        for (const group of groups) {
            try {
                const gid = group.group_id;
                if (nowMin >= this.openTime.minutes && nowMin < this.closeTime.minutes) {
                    // Within open window — today's greeting may have been missed.
                    if (!(await this._wasDone(gid, today, AUTOCHAT_KIND_OPEN))) {
                        const res = await this.openChat(sock, gid);
                        if (res === 'ok') changed += 1;
                    }
                } else {
                    // Outside the window the chat must be locked. The close that was
                    // missed belongs to yesterday before 09:00, to today after 23:55.
                    const day = nowMin < this.openTime.minutes ? yesterday : today;
                    const silent = nowMin < this.openTime.minutes || nowMin - this.closeTime.minutes > 30;
                    if (!(await this._wasDone(gid, day, AUTOCHAT_KIND_CLOSE))) {
                        const res = await this.closeChat(sock, gid, { day, silent });
                        if (res === 'ok') changed += 1;
                    }
                }
            } catch (err) {
                logger.error(`autochat: catch-up failed for ${group.group_id}: ${err.message}`);
            }
            await new Promise((r) => setTimeout(r, INTER_GROUP_DELAY_MS));
        }
        if (changed) {
            logger.info(`autochat: catch-up aligned ${changed} group(s)`);
        }
        return changed;
    }
}

export default AutoChatController;
