/**
 * /birthday — group birthday wishes with a personal LLM touch.
 *
 * Members (or admins) add birthdays with `/birthday add DD-MM` (year optional).
 * Every day at BIRTHDAY_TIME (IST, default 09:07) the scheduler checks today's
 * birthdays in enabled groups and posts an LLM-written wish tagging the person,
 * falling back to a template wish if every provider is rate-limited. Once per
 * birthday per group per year — stored in Mongo, so redeploys never double-post.
 *
 * Owners can force-check/retry on demand with `/birthday check` — reports
 * whether each celebrant in that group has been wished yet and at what time
 * (sent just now, or the timestamp of the earlier send), and sends the wish
 * for anyone still pending. Same Mongo dedupe as the scheduler, so it is
 * always safe to run and can never double-wish someone.
 */

import { logger } from '../utils/logger.js';
import { config } from '../config/config.js';
import { isGroupMessage, extractPhoneNumber } from '../utils/permissions.js';
import { indexParticipantsByDigits, resolveMentionIdentity } from '../utils/welcomeMessage.js';
import AssistLlmRouter from './AssistLlmRouter.js';

const TZ = 'Asia/Kolkata';

/** 'DD-MM' (or 'DD-MM-YYYY') → { dd, mm } or null. */
export function parseBirthdayDate(raw) {
    const m = /^\s*(\d{1,2})\s*[-\/.]\s*(\d{1,2})(?:\s*[-\/.]\s*\d{2,4})?\s*$/.exec(String(raw || ''));
    if (!m) return null;
    const dd = Number(m[1]);
    const mm = Number(m[2]);
    if (dd < 1 || dd > 31 || mm < 1 || mm > 12) return null;
    return { dd, mm };
}

/** Today's 'DD-MM' in IST. */
export function todayDdMmIST(fromMs = Date.now()) {
    const p = new Intl.DateTimeFormat('en-CA', {
        timeZone: TZ,
        day: '2-digit',
        month: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(new Date(fromMs));
    const get = (t) => p.find((x) => x.type === t)?.value;
    return `${get('day')}-${get('month')}`;
}

/** IST day key for once-per-day scheduling. */
export function istDayKey(fromMs = Date.now()) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, dateStyle: 'short' }).format(
        new Date(fromMs)
    );
}

/** Minutes until the next HH:MM IST. */
export function msUntilIST(hour, minute, fromMs = Date.now()) {
    for (let addMin = 0; addMin <= 48 * 60; addMin++) {
        const p = new Intl.DateTimeFormat('en-GB', {
            timeZone: TZ,
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        }).format(new Date(fromMs + addMin * 60_000));
        const [h, m] = p.split(':').map(Number);
        if (h === hour && m === minute) return Math.max(addMin, 1) * 60_000;
    }
    return 24 * 60 * 60 * 1000;
}

const SYSTEM_PROMPT = [
    'You write a short, warm, funny WhatsApp birthday message BODY for ONE member of a students\' tech group.',
    'A separate "🎂 Happy Birthday @Name!" line is added BEFORE your text by the app — do NOT write your own',
    '"Happy birthday" greeting or their name at the start. Start straight into the wish itself.',
    'Speak directly to them ("you"), never in the third person and never as a group announcement.',
    'Rules: max 30 words, no emoji walls (max 2 emojis), no hashtag spam, no quotes or poems.',
    'Light tech/coding wordplay is welcome. Reply with ONLY the body text, nothing else.',
].join('\n');

/** Target {hour, minute} from config, with safe defaults. */
export function wishWindowTarget(cfg = config) {
    const [h, m] = String(cfg?.BIRTHDAY_TIME || '09:07').split(':').map(Number);
    return {
        hour: Number.isFinite(h) ? h : 9,
        minute: Number.isFinite(m) ? m : 7,
    };
}

/** Current {hour, minute} in IST. */
export function istHourMinute(fromMs = Date.now()) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: TZ,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).format(new Date(fromMs));
    const [hour, minute] = parts.split(':').map(Number);
    return { hour, minute };
}

/** True when now is at/after the target time on the IST clock. */
export function inWishWindow(target, now = istHourMinute()) {
    const targetMin = target.hour * 60 + target.minute;
    const nowMin = now.hour * 60 + now.minute;
    return nowMin >= targetMin;
}

// Body only — the "🎂 Happy Birthday @tag!" greeting is always prepended by
// the caller, once, with the actual mention. No name/greeting duplicated here.
const FALLBACK_WISH_BODY =
    'May your code compile on the first try today and your bugs be easy finds.\n' +
    '_— your friends here_';

export default class BirthdayService {
    constructor({ mongoDb, groupManager, userManager = null, cfg = config } = {}) {
        this.cfg = cfg;
        this.groupManager = groupManager;
        this.userManager = userManager;
        this.mongoDb = mongoDb || null;
        this.col = null;
        this.wishesCol = null;
        this.llm = new AssistLlmRouter(cfg);
        this._timer = null;
        this._stopped = false;
    }

    async init() {
        if (!this.mongoDb) return;
        this.col = this.mongoDb.collection('group_birthdays');
        this.wishesCol = this.mongoDb.collection('birthday_wishes_sent');
        await Promise.all([
            this.col.createIndex({ group_id: 1, phone: 1 }, { unique: true, name: 'bday_group_phone' }),
            this.col.createIndex({ group_id: 1, dd: 1, mm: 1 }, { name: 'bday_group_date' }),
            this.wishesCol.createIndex({ group_id: 1, phone: 1, year: 1 }, { unique: true, name: 'bday_wish_once' }),
        ]);
        logger.info('Birthday service ready');
    }

    isConfigured() {
        return this.cfg.BIRTHDAY_ENABLED !== false;
    }

    // ── CRUD ────────────────────────────────────────────────────────────────

    /** @returns {Promise<{ ok: boolean, message: string }>} */
    async addBirthday({ groupId, senderJid, rawDate, phoneOverride = null }) {
        const parsed = parseBirthdayDate(rawDate);
        if (!parsed) {
            return {
                ok: false,
                message: '📅 Send it like *`/birthday add 14-11`* (day-month). Year optional: `/birthday add 14-11-2004`.',
            };
        }
        const phone = phoneOverride || extractPhoneNumber(senderJid);
        if (!phone) return { ok: false, message: 'Could not read your number from this chat.' };
        try {
            await this.col.updateOne(
                { group_id: groupId, phone: String(phone) },
                {
                    $set: {
                        dd: parsed.dd,
                        mm: parsed.mm,
                        added_by: String(senderJid || ''),
                        updated_at: new Date(),
                    },
                    $setOnInsert: { created_at: new Date() },
                },
                { upsert: true }
            );
            return {
                ok: true,
                message:
                    `🎂 Saved! Your birthday is set to *${String(parsed.dd).padStart(2, '0')}-${String(parsed.mm).padStart(2, '0')}* in this group.\n` +
                    `You'll get a tagged wish on the day 🎉`,
            };
        } catch (err) {
            logger.error(`Birthday add failed: ${err.message}`);
            return { ok: false, message: 'Could not save that right now — try again in a bit.' };
        }
    }

    async removeBirthday(groupId, phone) {
        const res = await this.col.deleteOne({ group_id: groupId, phone: String(phone) });
        return res.deletedCount > 0
            ? { ok: true, message: '✅ Birthday removed. No more wishes from me. 🥲' }
            : { ok: false, message: 'You had no birthday saved here. `/birthday add DD-MM` to add one.' };
    }

    async listBirthdays(groupId) {
        return this.col
            .find({ group_id: groupId }, { projection: { _id: 0, phone: 1, dd: 1, mm: 1 } })
            .sort({ mm: 1, dd: 1 })
            .toArray();
    }

    // ── Daily scheduler ─────────────────────────────────────────────────────

    /** @param {{ getSock?: () => object }} [opts] socket is resolved lazily (boot order). */
    start(opts = {}) {
        if (!this.isConfigured()) {
            logger.info('🎂 Birthday wishes disabled');
            return;
        }
        this._getSock = typeof opts.getSock === 'function' ? opts.getSock : null;
        const scheduleNext = () => {
            if (this._stopped) return;
            const [h, m] = String(this.cfg.BIRTHDAY_TIME || '09:07').split(':').map(Number);
            const hour = Number.isFinite(h) ? h : 9;
            const minute = Number.isFinite(m) ? m : 7;
            const delay = msUntilIST(hour, minute);
            const nextAt = new Date(Date.now() + delay).toLocaleString('en-IN', {
                timeZone: TZ,
                dateStyle: 'medium',
                timeStyle: 'short',
            });
            logger.info(`🎂 Next birthday check at ${nextAt} (${TZ})`);
            this._timer = setTimeout(async () => {
                try {
                    await this.runDailyWishes();
                } catch (err) {
                    logger.error(`Birthday run failed: ${err.message}`);
                } finally {
                    scheduleNext();
                }
            }, delay);
        };
        scheduleNext();
        // Catch-up ticks: if the exact-time timer was missed (restart etc.), still
        // run today's wishes any time later the same day. Mongo dedupe keeps the
        // on-time timer and these ticks from double-posting.
        const tickMs = Math.max(1_000, Number(this.cfg.BIRTHDAY_CATCHUP_TICK_MS) || 10 * 60_000);
        this._catchup = setInterval(() => {
            if (this._stopped) return;
            void this._catchupTick();
        }, tickMs);
        void this._catchupTick();
    }

    stop() {
        this._stopped = true;
        if (this._timer) clearTimeout(this._timer);
        if (this._catchup) clearInterval(this._catchup);
    }

    async _catchupTick() {
        const target = wishWindowTarget(this.cfg);
        const now = istHourMinute();
        // Any time at/after the target time counts — late wishes beat missed days.
        if (!inWishWindow(target, now)) return;
        const lastKey = istDayKey();
        if (this._lastCatchupRun === lastKey) return;
        this._lastCatchupRun = lastKey;
        await this.runDailyWishes().catch((err) => {
            logger.error(`Birthday catch-up run failed: ${err.message}`);
        });
    }

    /**
     * Post wishes for today's birthdays in every enabled group. Once per
     * (group, phone, year) — Mongo-unique, so retries/restarts cannot double-post.
     */
    async runDailyWishes({ sock } = {}) {
        const s = sock || (typeof this._getSock === 'function' ? this._getSock() : null);
        if (!s) {
            logger.info('🎂 Birthday check: no WhatsApp socket yet');
            return { posted: 0, skipped: 0 };
        }
        const today = todayDdMmIST();
        const [dd, mm] = today.split('-').map(Number);

        const rows = await this.col.find({ dd, mm }).toArray();
        if (!rows.length) {
            logger.info(`🎂 Birthday check ${today}: nobody today`);
            return { posted: 0, skipped: 0 };
        }

        // Group IDs from birthday docs; keep the bot's enabled-group check loose
        // (a saved birthday implies the group wants wishes).
        const byGroup = new Map();
        for (const r of rows) byGroup.set(r.group_id, (byGroup.get(r.group_id) || []).concat(r));

        let posted = 0;
        let skipped = 0;
        for (const [groupId, members] of byGroup) {
            const results = await this._wishGroup(groupId, members, s);
            for (const r of results) {
                if (r.status === 'sent') posted++;
                else if (r.status === 'already') skipped++;
                // 'failed' counts as neither — the marker was rolled back so a
                // later run (scheduled or manual /birthday check) can retry it.
            }
        }
        logger.info(`🎂 Birthday wishes ${today}: ${posted} posted, ${skipped} already done`);
        return { posted, skipped };
    }

    /**
     * On-demand version of the daily run, scoped to ONE group — for
     * `/birthday check`. Reports exactly what happened to each of today's
     * celebrants in this group: sent just now (with the timestamp), already
     * wished earlier (with the original timestamp), or a send that failed and
     * will be retried by the next scheduled/manual run.
     *
     * Safe to call any time and any number of times — the same Mongo dedupe
     * that guards the scheduler guards this, so it can never double-wish.
     *
     * @returns {Promise<{ hasBirthdayToday: boolean, results: Array<{phone:string,status:'sent'|'already'|'failed',at:Date|null,error?:string}>, error?: string }>}
     */
    async checkAndWish({ groupId, sock } = {}) {
        const s = sock || (typeof this._getSock === 'function' ? this._getSock() : null);
        if (!s) {
            return { hasBirthdayToday: false, results: [], error: 'no-socket' };
        }
        const today = todayDdMmIST();
        const [dd, mm] = today.split('-').map(Number);

        const rows = await this.col.find({ group_id: groupId, dd, mm }).toArray();
        if (!rows.length) {
            return { hasBirthdayToday: false, results: [] };
        }

        const results = await this._wishGroup(groupId, rows, s);
        return { hasBirthdayToday: true, results };
    }

    /**
     * Shared per-group send loop used by both `runDailyWishes` (all groups,
     * scheduled) and `checkAndWish` (one group, on demand). Every member gets
     * either a fresh wish (dedupe-inserted first, so a crash mid-send can
     * never double-post) or a report of when they were already wished.
     * @returns {Promise<Array<{phone:string,status:'sent'|'already'|'failed',at:Date|null,error?:string}>>}
     */
    async _wishGroup(groupId, members, s) {
        const year = Number(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric' }).format(new Date()));

        // Bare stored digits don't record whether they came from @s.whatsapp.net
        // or @lid — resolve against the group's live roster so the tag actually
        // lands on the member instead of printing unresolvable raw digits.
        let digitIndex = new Map();
        try {
            const meta = await this.groupManager?.getGroupMetadataCached?.(s, groupId);
            digitIndex = indexParticipantsByDigits(meta?.participants);
        } catch (err) {
            logger.debug(`Birthday wish: group metadata fetch failed for ${groupId}: ${err.message}`);
        }

        const results = [];
        for (const member of members) {
            const phone = String(member.phone);
            const now = new Date();
            try {
                const inserted = await this.wishesCol.insertOne({
                    group_id: groupId,
                    phone,
                    year,
                    sent_at: now,
                }).then(() => true).catch((err) => {
                    if (err?.code === 11000) return false; // already wished this year
                    throw err;
                });

                // Resolved once per member, before branching, so /birthday check
                // can show a real name instead of raw digits on EVERY line —
                // "already wished" and "send failed" included, not just "sent".
                const displayName = await this._resolveName(phone);

                if (!inserted) {
                    const existing = await this.wishesCol.findOne({ group_id: groupId, phone, year });
                    results.push({ phone, name: displayName, status: 'already', at: existing?.sent_at || null });
                    continue;
                }

                const participant = digitIndex.get(phone);
                const identity = participant ? resolveMentionIdentity(participant) : null;
                const tags = identity ? identity.mentions : [`${phone}@s.whatsapp.net`];
                // The visible "@digits" must match a JID actually present in
                // `mentions` for the tag to render — a resolved participant's
                // real phone/LID digits can differ from the bare digits we
                // stored, so use the resolved one when we have it.
                const tagDigits = identity?.displayJid ? identity.displayJid.split('@')[0] : phone;

                // A personal wish for THIS person, not a generic group blast —
                // resolved only after the dedupe check passes, so an
                // already-wished member never costs a wasted LLM call.
                const wishBody = await this._generateWish(member, displayName);

                // The mention lives IN the greeting line, not tacked on as a
                // trailing "@digits" afterthought — one message, tag up front.
                await s.sendMessage(groupId, {
                    text: `🎂 Happy Birthday @${tagDigits}! 🎉\n${wishBody}`,
                    mentions: tags,
                });
                results.push({ phone, name: displayName, status: 'sent', at: now });

                // Explicit 0 must disable the gap (no `|| 700` — 0 is falsy).
                const rawGap = this.cfg.BIRTHDAY_SEND_GAP_MS;
                const gapMs =
                    rawGap === undefined || rawGap === null || rawGap === ''
                        ? 700
                        : Math.max(0, Number(rawGap) || 0);
                if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
            } catch (err) {
                logger.warn(`Birthday wish failed for ${groupId}/${phone}: ${err.message}`);
                // Roll back the marker so a later retry can still send it.
                await this.wishesCol.deleteOne({ group_id: groupId, phone, year }).catch(() => {});
                results.push({ phone, name: null, status: 'failed', at: null, error: err.message });
            }
        }
        return results;
    }

    /**
     * A saved WhatsApp display name for this phone/LID digit string, if this
     * person has ever sent a message the bot logged their pushName for.
     * Tried under both JID forms since a bare digit string doesn't record
     * which addressing mode it came from.
     * @returns {Promise<string | null>}
     */
    async _resolveName(phone) {
        if (!this.userManager) return null;
        try {
            return await this.userManager.resolveUserName([
                `${phone}@s.whatsapp.net`,
                `${phone}@lid`,
            ]);
        } catch (err) {
            logger.debug(`Birthday wish: name lookup failed for ${phone}: ${err.message}`);
            return null;
        }
    }

    /**
     * The wish BODY only for THIS celebrant — no greeting, no name, no tag.
     * The caller prepends the one "🎂 Happy Birthday @tag!" line that carries
     * the actual mention, so this never duplicates a greeting.
     */
    async _generateWish(member, displayName) {
        try {
            const { text } = await this.llm.completeChat({
                systemPrompt: SYSTEM_PROMPT,
                history: [],
                userBlock: displayName
                    ? `Write the birthday message body for ${displayName}. Do not greet them by name — just the body.`
                    : 'Write the birthday message body for this member. Their name is not known and is not needed — just the body, speaking directly to them.',
                maxTokens: 90,
                temperature: 0.9,
                maxChars: 280,
            });
            return text.trim().slice(0, 260);
        } catch (err) {
            logger.warn(`Birthday LLM wish failed (template fallback): ${err.message}`);
            return FALLBACK_WISH_BODY;
        }
    }
}
