/**
 * BypassController — /bypass command + group auto-detect.
 *
 *   /bypass <link> [link2 ...]  resolve one or more HDHub/HubCloud links now
 *                               (parallel worker pool — extra links ≈ free speed)
 *   /bypasson / /bypassoff      (staff) auto-bypass pasted links in this group
 *
 * Free users: 3 successful link-bypasses/day (MOVIE_BYPASS_DAILY_LIMIT), one
 * credit per link that yields results. Owners, moderators, bot admins and
 * premium users are unlimited. Progress is edited into the same message; the
 * footer shows remaining bypasses (or the premium upsell when exhausted).
 *
 * Concurrency: a global worker pool (bypassManyLinks) shared across ALL users
 * and groups — many simultaneous requests run in parallel up to
 * MOVIE_BYPASS_MAX_CONCURRENT workers instead of stampeding target hosts.
 * Additionally, one in-flight command per user prevents double-taps.
 */

import { dirname, resolve } from 'path';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';
import { config } from '../config/config.js';
import { messageQueue } from '../utils/messageQueue.js';
import { sendAndDelete } from '../utils/autoDelete.js';
import { isGroupMessage, extractPhoneNumber, normalizePhoneNumber } from '../utils/permissions.js';
import { bypassManyLinks, isBypassableUrl } from '../services/HdHubBypassService.js';
import { shortLinkService } from '../services/ShortLinkService.js';
import { urlShortener } from '../utils/urlShortener.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const QR_IMAGE_PATH = resolve(__dirname, '../../assets/payment_qr.jpg');
const BYPASS_DAILY_LIMIT = Math.max(1, parseInt(process.env.MOVIE_BYPASS_DAILY_LIMIT, 10) || 3);
const BYPASS_MAX_LINKS = Math.max(1, config.MOVIE_BYPASS_MAX_LINKS || 5);
const BYPASS_PROGRESS_PRIORITY = 2;
const BYPASS_BUDGET_MS = config.MOVIE_HD_BYPASS_BUDGET_MS || 8_000;
const AUTO_DELETE_MS = 5 * 60 * 60 * 1000; // 5 hours

/** Hosts whose links are auto-bypassable (mirror of HdHubBypassService families). */
const BYPASS_HOST_RE = /https?:\/\/[^\s"'<>]*(hubcloud|hubdrive|hubcdn|hubstream|hdhubdrive|driveseed|hdstream4u|nexdrive|gdflix)\.[a-z.]+[^\s"'<>]*/gi;

/** All bypassable URLs in a text message (deduped, order preserved). */
export function extractBypassableUrls(text) {
    const out = [];
    const seen = new Set();
    for (const m of String(text || '').matchAll(BYPASS_HOST_RE)) {
        const u = m[0];
        if (!seen.has(u)) {
            seen.add(u);
            out.push(u);
        }
    }
    return out;
}

/** First bypassable URL in a text message, or null. */
export function extractBypassableUrl(text) {
    return extractBypassableUrls(text)[0] || null;
}

function normalizeOwnMessageKey(messageKey, chatId) {
    if (!messageKey?.id) return null;
    return {
        remoteJid: chatId || messageKey.remoteJid,
        id: messageKey.id,
        fromMe: true,
        ...(messageKey.participant ? { participant: messageKey.participant } : {}),
    };
}

function resolveOutboundJid(key, chatId) {
    return key?.remoteJid || chatId;
}

const BAR_BLOCKS = 18;
function progressBar(percent) {
    const filled = Math.max(1, Math.min(BAR_BLOCKS, Math.round((percent / 100) * BAR_BLOCKS)));
    return '█'.repeat(filled) + '░'.repeat(BAR_BLOCKS - filled);
}

function formatBypassProgress(urls, percent, note = '') {
    const count = urls.length;
    let msg = `🔗 *BYPASSING…* (${count} link${count > 1 ? 's' : ''} in parallel)\n\n`;
    for (const u of urls.slice(0, 3)) msg += `> ${u.replace(/^https?:\/\//, '').slice(0, 70)}\n`;
    if (urls.length > 3) msg += `> … +${urls.length - 3} more\n`;
    msg += `\n[${progressBar(percent)}] ${percent}%\n`;
    if (note) msg += `> ${note}\n`;
    return msg.trimEnd();
}

function formatBypassResult({ results, remaining, unlimited }) {
    let msg = '✅ *BYPASS SUCCESSFUL*\n\n';
    let linkTotal = 0;
    for (const r of results) {
        if (results.length > 1 && r.title) msg += `📄 *${r.title}*\n`;
        for (const l of r.links) {
            linkTotal += 1;
            msg += `┌ 📌 ${l.label}\n`;
            msg += `└ 🔗 ${l.url}\n`;
        }
        if (results.length > 1 && r.links.length === 0) {
            msg += '┌ ⚠️ No bypassable servers found\n└ —\n';
        }
        if (results.length > 1) msg += '\n';
    }
    msg += '─────────────────────────────\n';
    if (results.length > 1) msg += `⚡ ${results.length} link(s) · ${linkTotal} direct links\n`;
    msg += '⚠️ _Use VPN if links are blocked_\n';
    msg += '⏰ _Download links expire in 7 hours_\n';
    msg += '─────────────────────────────\n';
    if (unlimited) {
        msg += '⭐ _Unlimited bypasses (Premium/Staff)_';
    } else {
        msg += `🔢 _Bypasses left today: *${remaining}* / ${BYPASS_DAILY_LIMIT}_\n`;
        msg += '⏰ _This message auto-deletes in 5 hours_';
    }
    return msg;
}

function formatBypassFailed(urls, remaining, unlimited) {
    let msg = '❌ *BYPASS FAILED*\n\n';
    for (const u of urls.slice(0, 3)) msg += `> ${u.slice(0, 90)}\n`;
    if (urls.length > 3) msg += `> … +${urls.length - 3} more\n`;
    msg += '\nThe link(s) may be dead, password-protected, or not supported yet.\n';
    msg += '_Supported: HDHub4u, HubCloud, HubDrive, HubCDN pages._\n\n';
    msg += '─────────────────────────────\n';
    if (unlimited) {
        msg += '⭐ _Unlimited bypasses (Premium/Staff)_';
    } else {
        msg += `🔢 _Bypasses left today: *${remaining}* / ${BYPASS_DAILY_LIMIT}_\n`;
        msg += '⏰ _This message auto-deletes in 5 hours_';
    }
    return msg;
}

function formatGdflixLimited(urls) {
    let msg = '⛔ *GDFLIX NOT SUPPORTED*\n\n';
    for (const u of urls.slice(0, 3)) msg += `> ${u.slice(0, 90)}\n`;
    msg += '\nGDFlix pages are protected by Cloudflare Turnstile — the bot cannot solve it.\n';
    msg += '_Only their Telegram mirror exists, which is excluded._\n\n';
    msg += '💡 *Instead:* open the movie page on HDHub4u and send me its\n';
    msg += 'HubCloud / HubDrive / HubCDN link — those bypass fully.\n';
    msg += '─────────────────────────────';
    return msg;
}

function formatLimitReached() {
    let text = '';
    text += '┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n';
    text += '┃   ⛔ *DAILY LIMIT REACHED*   ┃\n';
    text += '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n';
    text += `🔗 You've used all *${BYPASS_DAILY_LIMIT}* free bypasses today!\n\n`;
    text += '─────────────────────────────\n';
    text += '🌟 *Want unlimited bypasses?*\n\n';
    text += '1️⃣ Scan the QR code below to pay\n';
    text += '2️⃣ Send the payment screenshot to:\n';
    text += `    📱 *wa.me/${config.PAYMENT_CONTACT || '917887499710'}*\n`;
    text += '3️⃣ Get unlimited access! 🎉\n';
    text += '─────────────────────────────\n\n';
    text += '_Your limit resets at midnight IST_ 🕛';
    return text;
}

class BypassController {
    constructor(mongoDb, groupManager) {
        this.mongoDb = mongoDb;
        this.groupManager = groupManager;
        this.bypassLimits = null;
        /** @type {Map<string, { unlimited: boolean, at: number }>} */
        this._unlimitedCache = new Map();
        /** one in-flight command per user per chat */
        this._activeByUser = new Map();
        /** global in-flight link slots (shared across all users/groups) */
        this._globalActive = 0;
        this._globalMax = Math.max(1, config.MOVIE_BYPASS_MAX_CONCURRENT || 6);
        this._waiters = [];
    }

    async init() {
        this.bypassLimits = this.mongoDb.collection('bypass_limits');
        await this.bypassLimits.createIndex(
            { user_id: 1, date: 1 },
            { unique: true, name: 'user_daily_bypass_limit' }
        );
        logger.info(`Bypass controller ready (global concurrency: ${this._globalMax})`);
    }

    /** Acquire one global link slot (fair FIFO). Resolves when acquired. */
    async _acquireSlot() {
        if (this._globalActive < this._globalMax) {
            this._globalActive += 1;
            return;
        }
        await new Promise((resolveWait) => this._waiters.push(resolveWait));
        this._globalActive += 1;
    }

    _releaseSlot() {
        this._globalActive = Math.max(0, this._globalActive - 1);
        const next = this._waiters.shift();
        if (next) next();
    }

    getTodayDateStr() {
        const now = new Date();
        const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
        return ist.toISOString().split('T')[0];
    }

    async getUserBypassCount(userId) {
        const normalized = normalizePhoneNumber(userId);
        const record = await this.bypassLimits.findOne({ user_id: normalized, date: this.getTodayDateStr() });
        return record?.count || 0;
    }

    async incrementBypassCount(userId, by = 1) {
        const normalized = normalizePhoneNumber(userId);
        await this.bypassLimits.updateOne(
            { user_id: normalized, date: this.getTodayDateStr() },
            { $inc: { count: by }, $setOnInsert: { user_id: normalized, date: this.getTodayDateStr() } },
            { upsert: true }
        );
    }

    async isUnlimitedUser(phoneNumber) {
        if (!this.groupManager) return false;
        const normalized = normalizePhoneNumber(phoneNumber);
        if (!normalized) return false;

        const cached = this._unlimitedCache.get(normalized);
        if (cached && Date.now() - cached.at < 60_000) return cached.unlimited;

        const gm = this.groupManager;
        const [owner, moderator, dynamicMod, botAdmin, premium] = await Promise.all([
            Promise.resolve(gm.isOwner(normalized)),
            Promise.resolve(gm.isModerator(normalized)),
            gm.isDynamicModerator(normalized),
            gm.isBotAdmin(normalized),
            gm.isPremiumUser(normalized),
        ]);
        const unlimited = owner || moderator || dynamicMod || botAdmin || premium;
        if (this._unlimitedCache.size > 500) {
            this._unlimitedCache.delete(this._unlimitedCache.keys().next().value);
        }
        this._unlimitedCache.set(normalized, { unlimited, at: Date.now() });
        return unlimited;
    }

    scheduleDelete(sock, chatId, messageKey, delayMs = AUTO_DELETE_MS) {
        if (!messageKey?.id) return;
        setTimeout(() => {
            try {
                const key = normalizeOwnMessageKey(messageKey, chatId);
                if (key) void sock?.sendMessage(resolveOutboundJid(key, chatId), { delete: key });
            } catch {}
        }, delayMs).unref?.();
    }

    /** Wrap one link's resolution in the global slot limiter. */
    async _resolveWithSlot(urls, budgetMs) {
        const slots = Math.min(urls.length, Math.max(1, this._globalMax - this._globalActive));
        // bypassManyLinks already pools internally; the global limiter throttles
        // how many links from THIS command may run right now.
        await this._acquireSlots(urls.length);
        try {
            return await bypassManyLinks(urls, {
                budgetMs,
                maxLinks: BYPASS_MAX_LINKS,
                concurrency: this._globalMax,
            });
        } finally {
            this._releaseSlots(urls.length);
        }
    }

    async _acquireSlots(n) {
        for (let i = 0; i < n; i++) await this._acquireSlot();
    }

    _releaseSlots(n) {
        for (let i = 0; i < n; i++) this._releaseSlot();
    }

    /**
     * Core flow: progress message → parallel pool resolve → shorten → edit to results.
     * @returns {Promise<boolean>} true when a bypass was attempted
     */
    async _runBypass(sock, chatId, senderJid, urlsIn, originalMsg, pushName = '') {
        void pushName;
        const userKey = `${chatId}:${normalizePhoneNumber(senderJid)}`;
        if (this._activeByUser.has(userKey)) {
            await sendAndDelete(sock, chatId, {
                text: '⏳ One bypass at a time — wait for the current one to finish.',
            }, originalMsg, 30_000);
            return true;
        }

        const unlimited = await this.isUnlimitedUser(senderJid);
        let used = unlimited ? 0 : await this.getUserBypassCount(senderJid);
        const freeLeft = Math.max(0, BYPASS_DAILY_LIMIT - used);

        if (!unlimited && freeLeft <= 0) {
            const sent = await sendAndDelete(sock, chatId, { text: formatLimitReached() }, originalMsg);
            this.scheduleDelete(sock, chatId, sent?.key);
            if (existsSync(QR_IMAGE_PATH)) {
                try {
                    const qr = await sock.sendMessage(chatId, {
                        image: readFileSync(QR_IMAGE_PATH),
                        caption: '💳 *Scan to pay for unlimited bypasses!*\n\nAfter payment, send screenshot to the owner.',
                    }, { quoted: originalMsg });
                    this.scheduleDelete(sock, chatId, qr?.key);
                } catch {}
            }
            return true;
        }

        // Free users: only attempt as many links as they have credits for
        const urls = unlimited ? urlsIn.slice(0, BYPASS_MAX_LINKS) : urlsIn.slice(0, freeLeft);
        if (!urls.length) return true;

        this._activeByUser.set(userKey, true);
        const run = (async () => {
            let progressMsg = null;
            try {
                progressMsg = await sock.sendMessage(chatId, {
                    text: formatBypassProgress(urls, 15, '🔎 Fetching pages…'),
                }, { quoted: originalMsg });
            } catch {}

            const editProgress = async (percent, note) => {
                if (!progressMsg?.key) return;
                try {
                    await messageQueue.enqueue(chatId, async () => {
                        await sock.sendMessage(resolveOutboundJid(progressMsg.key, chatId), {
                            text: formatBypassProgress(urls, percent, note),
                            edit: normalizeOwnMessageKey(progressMsg.key, chatId),
                            linkPreview: false,
                        });
                    }, BYPASS_PROGRESS_PRIORITY);
                } catch {}
            };

            try {
                await editProgress(35, '🔓 Unlocking download servers…');

                // 2) resolve all links through the shared parallel pool
                const resolved = await this._resolveWithSlot(urls, BYPASS_BUDGET_MS);
                const ok = resolved.filter((r) => r.links.length > 0);
                const gdflixTried = urls.filter((u) => /gdflix\./i.test(u));

                if (!ok.length) {
                    if (progressMsg?.key) {
                        try {
                            await sock.sendMessage(resolveOutboundJid(progressMsg.key, chatId), {
                                text: gdflixTried.length && ok.length === 0
                                    ? formatGdflixLimited(gdflixTried)
                                    : formatBypassFailed(urls, Math.max(0, BYPASS_DAILY_LIMIT - used), unlimited),
                                edit: normalizeOwnMessageKey(progressMsg.key, chatId),
                                linkPreview: false,
                            });
                            this.scheduleDelete(sock, chatId, progressMsg.key);
                        } catch {}
                    }
                    logger.info(`Bypass failed for ${urls.length} link(s)`);
                    return;
                }

                await editProgress(70, '🔗 Creating short links…');

                // 3) short links for every direct link (parallel)
                const allLinks = [];
                for (const r of ok) allLinks.push(...r.links);
                await Promise.all(allLinks.map(async (l) => {
                    try {
                        const minted = await shortLinkService.shorten(l.url);
                        const expiring = typeof minted === 'string' ? minted : minted?.url;
                        if (!expiring) return;
                        const display = await urlShortener._toDisplayShortUrl(expiring);
                        l.url = display || expiring;
                    } catch (e) {
                        logger.warn(`Bypass short link failed for one server: ${e?.message || e}`);
                    }
                }));

                await editProgress(100, '✅ Done');

                // 4) consume one credit per successful link
                const successCount = ok.length;
                if (!unlimited && successCount > 0) {
                    await this.incrementBypassCount(senderJid, successCount);
                    used += successCount;
                }

                // 5) replace progress with results
                const resultText = formatBypassResult({
                    results: ok,
                    remaining: Math.max(0, BYPASS_DAILY_LIMIT - used),
                    unlimited,
                });
                if (progressMsg?.key) {
                    try {
                        await sock.sendMessage(resolveOutboundJid(progressMsg.key, chatId), {
                            text: resultText,
                            edit: normalizeOwnMessageKey(progressMsg.key, chatId),
                            linkPreview: false,
                        });
                        this.scheduleDelete(sock, chatId, progressMsg.key);
                        return;
                    } catch {}
                }
                const sent = await sock.sendMessage(chatId, { text: resultText, linkPreview: false }, { quoted: originalMsg });
                this.scheduleDelete(sock, chatId, sent?.key);
            } catch (err) {
                logger.error(`Bypass error: ${err?.stack || err?.message || err}`);
                if (progressMsg?.key) {
                    try {
                        await sock.sendMessage(resolveOutboundJid(progressMsg.key, chatId), {
                            text: formatBypassFailed(urls, Math.max(0, BYPASS_DAILY_LIMIT - used), unlimited),
                            edit: normalizeOwnMessageKey(progressMsg.key, chatId),
                            linkPreview: false,
                        });
                        this.scheduleDelete(sock, chatId, progressMsg.key);
                    } catch {}
                }
            } finally {
                this._activeByUser.delete(userKey);
            }
        })();

        await run;
        return true;
    }

    /** /bypass <link> [link2 ...] */
    async handleBypass(sock, chatId, senderJid, args, originalMsg = null, pushName = '') {
        const urls = extractBypassableUrls((args || []).join(' '));
        if (!urls.length) {
            await sendAndDelete(sock, chatId, {
                text:
                    '🔗 *LINK BYPASSER*\n\n' +
                    'Usage: `/bypass <link>` — or up to ' + BYPASS_MAX_LINKS + ' links at once:\n' +
                    '`/bypass <link1> <link2> <link3>`\n\n' +
                    '_Supported links:_\n' +
                    '• HDHub4u / HubCloud / HubDrive / HubCDN\n\n' +
                    `_Free limit: ${BYPASS_DAILY_LIMIT} bypasses/day · admins & premium: unlimited_`,
            }, originalMsg);
            return;
        }
        const unsupported = urls.filter((u) => !isBypassableUrl(u));
        if (unsupported.length === urls.length) {
            await sendAndDelete(sock, chatId, {
                text:
                    '⚠️ That link is not a supported bypass target.\n\n' +
                    '_Supported: HDHub4u, HubCloud, HubDrive, HubCDN pages._',
            }, originalMsg);
            return;
        }
        const supported = urls.filter((u) => isBypassableUrl(u)).slice(0, BYPASS_MAX_LINKS);
        await this._runBypass(sock, chatId, senderJid, supported, originalMsg, pushName);
    }

    /** /bypasson — staff only (enforced by registry role) */
    async handleBypassOn(sock, chatId, senderJid, originalMsg = null) {
        if (!isGroupMessage(chatId)) {
            await sendAndDelete(sock, chatId, { text: 'Use `/bypasson` in a group.' }, originalMsg);
            return;
        }
        let groupName = 'Unknown Group';
        try { groupName = (await sock.groupMetadata(chatId)).subject; } catch {}
        await this.groupManager.setBypassAuto(chatId, groupName, true, extractPhoneNumber(senderJid));
        await sendAndDelete(sock, chatId, {
            text:
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                '✅ *BYPASS AUTO ON* ✅\n' +
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                `📢 *Group:* ${groupName}\n\n` +
                '🔗 HDHub4u / HubCloud links pasted here are bypassed automatically.\n' +
                '_No command needed — just send the link._\n\n' +
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                '💡 Use `/bypassoff` to turn this off',
        }, originalMsg);
        logger.info(`🔗 Bypass auto ON: ${groupName} (${chatId})`);
    }

    /** /bypassoff — staff only (enforced by registry role) */
    async handleBypassOff(sock, chatId, senderJid, originalMsg = null) {
        if (!isGroupMessage(chatId)) {
            await sendAndDelete(sock, chatId, { text: 'Use `/bypassoff` in a group.' }, originalMsg);
            return;
        }
        const wasEnabled = await this.groupManager.isBypassAutoEnabled(chatId);
        if (!wasEnabled) {
            await sendAndDelete(sock, chatId, {
                text:
                    'ℹ️ *BYPASS AUTO OFF*\n\nAuto bypass is not enabled in this group.\n\nUse `/bypasson` to enable it.',
            }, originalMsg);
            return;
        }
        let groupName = 'Unknown Group';
        try { groupName = (await sock.groupMetadata(chatId)).subject; } catch {}
        await this.groupManager.setBypassAuto(chatId, groupName, false, extractPhoneNumber(senderJid));
        await sendAndDelete(sock, chatId, {
            text:
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                '🛑 *BYPASS AUTO OFF* 🛑\n' +
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                'Links in this group will no longer be bypassed automatically.',
        }, originalMsg);
        logger.info(`🔗 Bypass auto OFF: ${groupName} (${chatId})`);
    }

    /** Called by WhatsAppService for every non-command group text. */
    async maybeAutoBypass(sock, chatId, text, senderJid, msg) {
        if (!chatId?.endsWith('@g.us')) return; // groups only
        if (!this.groupManager) return;
        try {
            if (!(await this.groupManager.isBypassAutoEnabled(chatId))) return;
        } catch {
            return;
        }
        // A message may carry several links — bypass ALL of them in one go
        const urls = extractBypassableUrls(text).slice(0, BYPASS_MAX_LINKS);
        if (!urls.length) return;
        if (msg?.key?.fromMe) return;
        void this._runBypass(sock, chatId, senderJid, urls, msg, msg?.pushName || '');
    }
}

export const bypassController = new BypassController(null, null);
export default BypassController;
