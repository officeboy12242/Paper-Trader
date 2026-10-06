/**
 * Auto-Delete Utility
 * Schedules bot messages for automatic deletion after a specified time.
 *
 * Deletions are PERSISTED. A bare `setTimeout` is lost on deploy or restart, so
 * anything pending at that moment was never deleted at all. Each schedule is
 * written to Mongo and restored at startup: entries whose time already passed
 * while the bot was down are deleted immediately, the rest are re-armed.
 *
 * The socket is resolved through a provider rather than captured in the closure —
 * `sock` is replaced on every reconnect, so a captured reference goes stale and
 * the delete silently fails even without a restart.
 */

import { logger } from './logger.js';
import { safeSendMessage } from './waMessage.js';

const AUTO_DELETE_MS = 5 * 60 * 60 * 1000; // 5 hours default
/** setTimeout overflows past 2^31-1 ms and fires immediately. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
/** Spacing when clearing a restart backlog, so we don't burst at WhatsApp. */
const BACKLOG_SPACING_MS = 400;
/**
 * WhatsApp refuses delete-for-everyone on very old messages, so a long outage
 * would produce a burst of guaranteed failures. Drop those instead.
 */
const MAX_OVERDUE_MS = 48 * 60 * 60 * 1000;

/** @type {import('mongodb').Collection|null} */
let _col = null;
/** @type {(() => object|null)|null} */
let _getSock = null;
/** @type {Map<string, NodeJS.Timeout>} docId → timer */
const timers = new Map();

function docIdFor(chatId, messageKey) {
    return `${chatId}:${messageKey?.id || ''}`;
}

function resolveSock(fallback) {
    if (_getSock) {
        try {
            const live = _getSock();
            if (live) return live;
        } catch {
            // fall through to the caller's socket
        }
    }
    return fallback || null;
}

/**
 * Wire persistence. Safe to skip — without Mongo the module behaves exactly as
 * before (in-memory only), just without surviving restarts.
 * @param {{ mongoDb?: object, getSock?: () => object|null }} opts
 */
export function initAutoDelete({ mongoDb = null, getSock = null } = {}) {
    if (getSock) _getSock = getSock;
    if (!mongoDb) return;

    _col = mongoDb.collection('pending_deletes');
    // Safety net: rows self-expire well after they should have been processed.
    _col.createIndex({ created_at: 1 }, { name: 'pending_deletes_ttl', expireAfterSeconds: 7 * 24 * 60 * 60 })
        .catch((err) => logger.debug(`pending_deletes index: ${err.message}`));
    _col.createIndex({ delete_at: 1 }, { name: 'pending_deletes_due' })
        .catch(() => {});
}

/** Remove the persisted row for a delete that is done (or no longer wanted). */
async function forget(docId) {
    timers.delete(docId);
    if (!_col) return;
    try {
        await _col.deleteOne({ _id: docId });
    } catch (err) {
        logger.debug(`pending_deletes cleanup failed: ${err.message}`);
    }
}

/** Perform the actual delete-for-everyone, then drop the row. */
async function runDelete(docId, chatId, messageKey, fallbackSock = null) {
    const sock = resolveSock(fallbackSock);
    if (!sock) {
        // No live socket — leave the row so the next startup retries it.
        timers.delete(docId);
        return;
    }
    try {
        await sock.sendMessage(chatId, { delete: messageKey });
        logger.info(`🗑️ Auto-deleted message in ${chatId}`);
    } catch {
        // Already deleted, chat gone, or too old — nothing useful to retry.
    }
    await forget(docId);
}

function armTimer(docId, chatId, messageKey, delayMs, fallbackSock = null) {
    const existing = timers.get(docId);
    if (existing) clearTimeout(existing);

    const delay = Math.max(0, Math.min(delayMs, MAX_TIMEOUT_MS));
    const timer = setTimeout(() => {
        void runDelete(docId, chatId, messageKey, fallbackSock);
    }, delay);
    // Never hold the process open just for a pending delete.
    if (typeof timer.unref === 'function') timer.unref();
    timers.set(docId, timer);
}

/**
 * Schedule a message for deletion.
 * @param {object} sock - WhatsApp socket (a live provider is preferred if set)
 * @param {string} chatId - Chat ID
 * @param {object} messageKey - Message key from sent message
 * @param {number} delayMs - Delay in milliseconds (default 5 hours)
 */
export function scheduleAutoDelete(sock, chatId, messageKey, delayMs = AUTO_DELETE_MS) {
    if (!sock || !chatId || !messageKey?.id) return;

    const docId = docIdFor(chatId, messageKey);
    const deleteAt = Date.now() + delayMs;

    armTimer(docId, chatId, messageKey, delayMs, sock);

    if (_col) {
        // Fire-and-forget: persistence must never slow the reply path.
        _col.updateOne(
            { _id: docId },
            {
                $set: {
                    chat_id: chatId,
                    message_key: messageKey,
                    delete_at: new Date(deleteAt),
                },
                $setOnInsert: { created_at: new Date() },
            },
            { upsert: true }
        ).catch((err) => logger.debug(`pending_deletes persist failed: ${err.message}`));
    }
}

/**
 * Re-arm everything that was pending when the process stopped. Anything already
 * due is deleted now — that is the case a plain setTimeout loses on every deploy.
 * @returns {Promise<{ restored: number, overdue: number, expired: number }>}
 */
export async function restorePendingDeletes() {
    if (!_col) return { restored: 0, overdue: 0, expired: 0 };

    let rows;
    try {
        rows = await _col.find({}).toArray();
    } catch (err) {
        logger.warn(`Auto-delete restore failed: ${err.message}`);
        return { restored: 0, overdue: 0, expired: 0 };
    }
    if (!rows.length) return { restored: 0, overdue: 0, expired: 0 };

    const now = Date.now();
    let restored = 0;
    let overdue = 0;
    let expired = 0;
    const staleIds = [];

    for (const row of rows) {
        const chatId = row.chat_id;
        const messageKey = row.message_key;
        const dueAt = row.delete_at ? new Date(row.delete_at).getTime() : 0;
        if (!chatId || !messageKey?.id || !dueAt) {
            staleIds.push(row._id);
            continue;
        }

        const lateBy = now - dueAt;
        if (lateBy > MAX_OVERDUE_MS) {
            // WhatsApp would reject these anyway.
            staleIds.push(row._id);
            expired += 1;
            continue;
        }

        if (lateBy >= 0) {
            // Due while we were down — stagger so a long outage does not burst.
            armTimer(row._id, chatId, messageKey, overdue * BACKLOG_SPACING_MS);
            overdue += 1;
        } else {
            armTimer(row._id, chatId, messageKey, -lateBy);
            restored += 1;
        }
    }

    if (staleIds.length) {
        await _col.deleteMany({ _id: { $in: staleIds } }).catch(() => {});
    }

    if (restored || overdue || expired) {
        logger.info(
            `🗑️ Auto-delete restored: ${restored} pending, ${overdue} overdue (clearing now), ${expired} too old`
        );
    }
    return { restored, overdue, expired };
}

/**
 * Helper to send a message and schedule it for auto-deletion
 * @param {object} sock - WhatsApp socket
 * @param {string} chatId - Chat ID
 * @param {object} content - Message content
 * @param {object} options - Send options (quoted, etc)
 * @param {number} deleteAfterMs - Delete after this many ms (default 5 hours)
 * @returns {Promise<object>} - Sent message info
 */
export async function sendAndDelete(sock, chatId, content, originalMsg = null, deleteAfterMs = AUTO_DELETE_MS) {
    const sent = await safeSendMessage(sock, chatId, content, originalMsg);
    if (sent?.key) {
        scheduleAutoDelete(sock, sent.key.remoteJid || chatId, sent.key, deleteAfterMs);
    }
    return sent;
}

/**
 * Clear in-memory timers (shutdown). Persisted rows are intentionally kept so
 * the next start picks them up — that is the whole point of the journal.
 */
export function clearAllScheduledDeletes() {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    logger.info('🗑️ Cleared in-memory auto-delete timers (persisted rows kept)');
}

/** Pending timer count — useful for /status style diagnostics. */
export function pendingDeleteCount() {
    return timers.size;
}

export const AUTO_DELETE_5_HOURS = AUTO_DELETE_MS;
export const AUTO_DELETE_1_HOUR = 60 * 60 * 1000;
export const AUTO_DELETE_30_MIN = 30 * 60 * 1000;
export const AUTO_DELETE_2_MIN = 2 * 60 * 1000;
