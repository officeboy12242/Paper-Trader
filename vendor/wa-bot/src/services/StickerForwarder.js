/**
 * Sticker Forwarder Service
 * Forwards stickers from groups and joined channels to target groups.
 * Parallel workers + retry loop — stickers only marked done after successful send.
 */

import { jidNormalizedUser } from 'baileys';
import { logger } from '../utils/logger.js';
import { downloadStickerBuffer, isValidWebpBuffer } from '../utils/stickerDownload.js';
import { extractStickerFromMessage, isNewsletterChat } from '../utils/stickerExtract.js';

const MAX_QUEUE_SIZE = 1000;
const MAX_COMPLETED = 2000;
const MAX_RETRIES = 6;
const RETRY_DELAYS_MS = [2000, 5000, 10000, 20000, 45000, 90000];
const RETRY_TICK_MS = 3000;
const TARGET_REFRESH_MS = 5000;

function normalizeNewsletterJid(jid) {
    if (!jid) {
        return jid;
    }
    return jidNormalizedUser(String(jid).replace(/:\d+(?=@)/, '')) || jid;
}

function stickerKeys(waMessage, fromChat) {
    const stickerPayload = extractStickerFromMessage(waMessage?.message);
    const msgId = waMessage?.key?.id || null;
    const contentHash = stickerPayload?.fileSha256
        ? Buffer.from(stickerPayload.fileSha256).toString('hex')
        : null;

    return {
        trackId: msgId ? `${fromChat}:${msgId}` : null,
        contentHash,
    };
}

class StickerForwarder {
    /**
     * @param {object} opts
     * @param {import('../models/GroupManager.js').default} [opts.groupManager]
     * @param {string[]} [opts.envTargetGroups]
     * @param {string} [opts.packName]
     * @param {string} [opts.packAuthor]
     * @param {string[]} [opts.sourceChannels]
     * @param {number} [opts.concurrency]
     * @param {number} [opts.interSendDelayMs]
     */
    constructor(opts = {}) {
        this.groupManager = opts.groupManager || null;
        this.envTargetGroups = opts.envTargetGroups || [];
        this.sourceChannels = opts.sourceChannels || [];
        this.resolvedChannelNames = new Map();
        this.packName = opts.packName || '';
        this.packAuthor = opts.packAuthor || '';

        this.maxWorkers = Math.max(1, Math.min(8, Number(opts.concurrency) || 3));
        this.interSendDelayMs = Math.max(50, Number(opts.interSendDelayMs) || 150);

        this.countSent = 0;
        this.countReceived = 0;
        this.countErrors = 0;
        this.countDuplicates = 0;
        this.countFromChannels = 0;
        this.countQueued = 0;
        this.countRetried = 0;

        this.completedTrackIds = new Set();
        this.completedContentHashes = new Set();
        this.inFlightTrackIds = new Set();
        this.retryLater = new Map();

        /** @type {Set<string>} */
        this.activeTargetGroups = new Set(this.envTargetGroups);

        this.queue = [];
        this.activeWorkers = 0;
        this._retryTimer = null;
        this._targetRefreshTimer = null;
    }

    startBackgroundWorkers() {
        if (!this._retryTimer) {
            this._retryTimer = setInterval(() => {
                void this._drainRetryLater();
            }, RETRY_TICK_MS);
            if (this._retryTimer.unref) {
                this._retryTimer.unref();
            }
            logger.info('🔄 Sticker forward retry worker started');
        }

        if (!this._targetRefreshTimer) {
            void this.refreshTargetGroups();
            this._targetRefreshTimer = setInterval(() => {
                void this.refreshTargetGroups();
            }, TARGET_REFRESH_MS);
            if (this._targetRefreshTimer.unref) {
                this._targetRefreshTimer.unref();
            }
        }

        logger.info(
            `⚡ Sticker forward workers: ${this.maxWorkers} parallel | delay ${this.interSendDelayMs}ms`
        );
    }

    stopBackgroundWorkers() {
        if (this._retryTimer) {
            clearInterval(this._retryTimer);
            this._retryTimer = null;
        }
        if (this._targetRefreshTimer) {
            clearInterval(this._targetRefreshTimer);
            this._targetRefreshTimer = null;
        }
    }

    async refreshTargetGroups() {
        let ids = [];
        if (this.groupManager) {
            try {
                const rows = await this.groupManager.getStickerAutoGroups();
                ids = rows.map((g) => g.group_id).filter(Boolean);
            } catch (err) {
                logger.warn(`Sticker target refresh failed: ${err.message}`);
            }
        }
        if (!ids.length && this.envTargetGroups.length) {
            ids = [...this.envTargetGroups];
        }
        this.activeTargetGroups = new Set(ids);
        return ids;
    }

    setSourceChannels(jids, nameByJid = new Map()) {
        this.sourceChannels = jids || [];
        this.resolvedChannelNames = nameByJid;
    }

    shouldForwardFrom(chatId) {
        if (!chatId || this.activeTargetGroups.has(chatId)) {
            return false;
        }

        if (isNewsletterChat(chatId)) {
            if (!this.sourceChannels.length) {
                return true;
            }
            const normalized = normalizeNewsletterJid(chatId);
            return this.sourceChannels.some((ch) => normalizeNewsletterJid(ch) === normalized);
        }

        if (chatId.endsWith('@g.us')) {
            return true;
        }

        return false;
    }

    wasForwarded(trackId, contentHash) {
        if (trackId && this.completedTrackIds.has(trackId)) {
            return true;
        }
        if (contentHash && this.completedContentHashes.has(contentHash)) {
            return true;
        }
        return false;
    }

    async forwardSticker(sock, waMessage, fromChat, { isRetry = false, isBackfill = false, mediaPending = false } = {}) {
        if (!this.shouldForwardFrom(fromChat)) {
            return false;
        }

        const { trackId, contentHash } = stickerKeys(waMessage, fromChat);

        if (!trackId && !contentHash) {
            return false;
        }

        if (this.wasForwarded(trackId, contentHash)) {
            this.countDuplicates++;
            return false;
        }

        if (trackId && this.inFlightTrackIds.has(trackId) && !isRetry) {
            return false;
        }

        if (trackId && this.retryLater.has(trackId) && !isRetry) {
            const pending = this.retryLater.get(trackId);
            pending.item = { sock, waMessage, fromChat, trackId, contentHash };
            return true;
        }

        if (this.queue.length >= MAX_QUEUE_SIZE) {
            logger.warn(`⚠️ Sticker queue at ${MAX_QUEUE_SIZE} — workers at full capacity`);
        }

        this.queue.push({ sock, waMessage, fromChat, trackId, contentHash, isBackfill, mediaPending });
        this.countQueued++;

        const isChannel = isNewsletterChat(fromChat);
        logger.info(
            `📥 Sticker queued from ${isChannel ? 'channel' : 'group'} | ` +
                `Queue: ${this.queue.length}, Workers: ${this.activeWorkers}/${this.maxWorkers}` +
                `${isRetry ? ' (retry)' : ''}${isBackfill ? ' (backfill)' : ''}` +
                `${mediaPending ? ' (media pending)' : ''}`
        );

        this._kickWorkers();
        return true;
    }

    _kickWorkers() {
        while (this.activeWorkers < this.maxWorkers && this.queue.length > 0) {
            this.activeWorkers++;
            void this._workerLoop();
        }
    }

    async _workerLoop() {
        try {
            for (;;) {
                const item = this.queue.shift();
                if (!item) {
                    break;
                }

                if (item.trackId) {
                    this.inFlightTrackIds.add(item.trackId);
                }

                try {
                    const ok = await this._processSticker(item);
                    if (ok && item.trackId) {
                        this.retryLater.delete(item.trackId);
                    }
                } catch (error) {
                    this.countErrors++;
                    this._scheduleRetry(item, error);
                } finally {
                    if (item.trackId) {
                        this.inFlightTrackIds.delete(item.trackId);
                    }
                }

                if (this.queue.length > 0) {
                    await new Promise((r) => setTimeout(r, this.interSendDelayMs));
                }
            }
        } finally {
            this.activeWorkers--;
            if (this.queue.length > 0) {
                this._kickWorkers();
            }
        }
    }

    async _drainRetryLater() {
        if (!this.retryLater.size) return;

        const now = Date.now();
        for (const [trackId, entry] of this.retryLater) {
            if (entry.nextRetryAt > now) continue;
            if (this.inFlightTrackIds.has(trackId)) continue;

            this.retryLater.delete(trackId);
            this.countRetried++;
            logger.info(`🔄 Auto-retry sticker ${trackId.slice(-16)} (attempt ${entry.attempts + 1})`);
            await this.forwardSticker(
                entry.item.sock,
                entry.item.waMessage,
                entry.item.fromChat,
                { isRetry: true },
            );
        }
    }

    _scheduleRetry(item, error) {
        const trackId = item.trackId;
        if (!trackId) {
            logger.error(`❌ Sticker error (no track id): ${error.message}`);
            return;
        }

        const prev = this.retryLater.get(trackId);
        const attempts = (prev?.attempts ?? 0) + 1;

        if (attempts >= MAX_RETRIES) {
            this.retryLater.delete(trackId);
            logger.error(`❌ Sticker gave up after ${MAX_RETRIES} tries (${trackId.slice(-16)}): ${error.message}`);
            return;
        }

        const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)];
        this.retryLater.set(trackId, {
            item,
            attempts,
            nextRetryAt: Date.now() + delay,
        });
        logger.warn(
            `⏳ Sticker retry ${attempts}/${MAX_RETRIES} in ${Math.round(delay / 1000)}s ` +
                `(${trackId.slice(-16)}): ${error.message}`
        );
    }

    _markCompleted(trackId, contentHash) {
        if (trackId) {
            this.completedTrackIds.add(trackId);
            if (this.completedTrackIds.size > MAX_COMPLETED) {
                const oldest = this.completedTrackIds.values().next().value;
                this.completedTrackIds.delete(oldest);
            }
        }
        if (contentHash) {
            this.completedContentHashes.add(contentHash);
            if (this.completedContentHashes.size > MAX_COMPLETED) {
                const oldest = this.completedContentHashes.values().next().value;
                this.completedContentHashes.delete(oldest);
            }
        }
    }

    async _resolveTargetGroupIds() {
        if (this.activeTargetGroups.size) {
            return [...this.activeTargetGroups];
        }
        return this.refreshTargetGroups();
    }

    /**
     * @returns {Promise<boolean>}
     */
    async _processSticker({ sock, waMessage, fromChat, trackId, contentHash }) {
        this.countReceived++;
        const isChannel = isNewsletterChat(fromChat);

        if (isChannel) {
            this.countFromChannels++;
        }

        if (this.wasForwarded(trackId, contentHash)) {
            this.countDuplicates++;
            return true;
        }

        const targetGroups = await this._resolveTargetGroupIds();
        if (!targetGroups.length) {
            throw new Error('No sticker target groups enabled — use /stickeron in a group');
        }

        const buffer = await downloadStickerBuffer(sock, waMessage);
        if (!isValidWebpBuffer(buffer)) {
            throw new Error('Downloaded sticker is not valid WebP');
        }

        let stickerBuffer = buffer;
        try {
            const { Sticker } = await import('wa-sticker-formatter');
            const sticker = new Sticker(buffer, {
                pack: this.packName,
                author: this.packAuthor,
                type: 'default',
                quality: 50,
            });
            const repacked = await sticker.toBuffer();
            if (isValidWebpBuffer(repacked)) {
                stickerBuffer = repacked;
            } else {
                logger.warn('Sticker re-pack produced invalid WebP, sending original');
            }
        } catch (formatError) {
            logger.warn(`Sticker re-pack failed, sending original: ${formatError.message}`);
        }

        const results = await Promise.allSettled(
            targetGroups.map((targetGroup) =>
                sock.sendMessage(
                    targetGroup,
                    { sticker: stickerBuffer },
                    {
                        ephemeralExpiration: 86400,
                        mediaUploadTimeoutMs: 90000,
                    }
                )
            )
        );

        const successCount = results.filter((r) => r.status === 'fulfilled').length;
        for (const result of results) {
            if (result.status === 'rejected') {
                logger.error(`❌ Send failed: ${result.reason?.message || result.reason}`);
            }
        }

        if (successCount === 0) {
            throw new Error(`Send failed to all ${targetGroups.length} target group(s)`);
        }

        this._markCompleted(trackId, contentHash);
        this.countSent++;
        const sourceLabel = isChannel ? 'channel' : 'group';
        logger.info(
            `✅ Sticker from ${sourceLabel} → ${successCount}/${targetGroups.length} groups | ` +
                `Sent: ${this.countSent}, Queue: ${this.queue.length}, Workers: ${this.activeWorkers}, ` +
                `Retries pending: ${this.retryLater.size}, Channels: ${this.countFromChannels}, Err: ${this.countErrors}`
        );
        return true;
    }

    /**
     * Send already-converted sticker buffers to the configured target groups.
     *
     * The queue-based path above starts from a WhatsApp message it has to
     * download; this one takes finished buffers, which is what the Telegram
     * pack importer produces. Sends are sequential per group with a small gap
     * so a 40-sticker pack doesn't trip WhatsApp's rate limiting.
     *
     * @param {import('baileys').WASocket} sock
     * @param {Array<{ buffer: Buffer, isAnimated?: boolean }>} stickers
     * @param {{ signal?: AbortSignal, gapMs?: number, exclude?: string[],
     *           onProgress?: (sent: number, total: number) => void }} [opts]
     * @returns {Promise<{ targets: string[], sent: number, failed: number }>}
     */
    async broadcastStickerBuffers(sock, stickers, { signal, gapMs = 350, exclude = [], onProgress } = {}) {
        const skip = new Set(exclude);
        const targets = (await this._resolveTargetGroupIds()).filter((t) => !skip.has(t));
        if (!targets.length || !stickers?.length) {
            return { targets: [], sent: 0, failed: 0 };
        }

        let sent = 0;
        let failed = 0;

        for (const sticker of stickers) {
            if (signal?.aborted) break;

            for (const target of targets) {
                if (signal?.aborted) break;
                try {
                    const content = { sticker: sticker.buffer };
                    if (sticker.isAnimated) content.isAnimated = true;
                    await sock.sendMessage(target, content, {
                        ephemeralExpiration: 86400,
                        mediaUploadTimeoutMs: 90000,
                    });
                    sent++;
                    this.countSent++;
                } catch (err) {
                    failed++;
                    this.countErrors++;
                    logger.warn(`Sticker broadcast to ${target} failed: ${err?.message || err}`);
                }
                await new Promise((r) => setTimeout(r, gapMs));
            }
            onProgress?.(sent, stickers.length * targets.length);
        }

        logger.info(
            `📤 Broadcast ${stickers.length} sticker(s) → ${targets.length} group(s): ${sent} sent, ${failed} failed`
        );
        return { targets, sent, failed };
    }

    getStats() {
        return {
            sent: this.countSent,
            received: this.countReceived,
            queued: this.countQueued,
            queueLength: this.queue.length,
            workers: this.activeWorkers,
            maxWorkers: this.maxWorkers,
            targetGroups: this.activeTargetGroups.size,
            retriesPending: this.retryLater.size,
            retried: this.countRetried,
            fromChannels: this.countFromChannels,
            errors: this.countErrors,
            duplicates: this.countDuplicates,
            isProcessing: this.activeWorkers > 0,
        };
    }

    resetStats() {
        this.countSent = 0;
        this.countReceived = 0;
        this.countQueued = 0;
        this.countFromChannels = 0;
        this.countErrors = 0;
        this.countDuplicates = 0;
        this.countRetried = 0;
        logger.info('📊 Sticker stats reset');
    }
}

export default StickerForwarder;
