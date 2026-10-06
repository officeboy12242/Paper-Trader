/**
 * Channel sticker backfill — catches stickers missed by real-time events.
 */

import { logger } from '../utils/logger.js';
import { fetchNewsletterStickerMessages } from '../utils/channelMessages.js';
import { extractStickerFromMessage } from '../utils/stickerExtract.js';
import { isChannelStickerReady } from '../utils/stickerDownload.js';

const POLL_INTERVAL_MS = 60_000;
const STICKERS_PER_FETCH = 25;
const CHANNEL_POLL_CONCURRENCY = 4;

const MAX_CONSECUTIVE_FAILURES = 20;
const FAIL_COUNT_RESET_MS = 30 * 60_000;

class ChannelStickerPoller {
    constructor(stickerForwarder) {
        this.stickerForwarder = stickerForwarder;
        this.channelJids = [];
        this._timer = null;
        this._sock = null;
        this._running = false;
        this._failCounts = new Map();
        this._failCountResetTimer = null;
    }

    setChannels(jids) {
        this.channelJids = [...new Set(jids || [])];
    }

    start(sock) {
        this._sock = sock;
        if (!this.channelJids.length) {
            return;
        }

        if (this._timer) {
            return;
        }

        if (!this._failCountResetTimer) {
            this._failCountResetTimer = setInterval(() => {
                if (this._failCounts.size) {
                    logger.debug('📡 Resetting channel poll failure counts');
                    this._failCounts.clear();
                }
            }, FAIL_COUNT_RESET_MS);
            if (this._failCountResetTimer.unref) {
                this._failCountResetTimer.unref();
            }
        }

        logger.info(
            `📡 Channel sticker backfill active (${this.channelJids.length} channel(s), ` +
                `every ${POLL_INTERVAL_MS / 1000}s, ${CHANNEL_POLL_CONCURRENCY} parallel)`
        );
        this._timer = setInterval(() => {
            void this._pollAll();
        }, POLL_INTERVAL_MS);
        if (this._timer.unref) {
            this._timer.unref();
        }

        setTimeout(() => void this._pollAll(), 15_000);
    }

    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
        if (this._failCountResetTimer) {
            clearInterval(this._failCountResetTimer);
            this._failCountResetTimer = null;
        }
        this._running = false;
        this._sock = null;
    }

    async _pollAll() {
        if (this._running || !this._sock || !this.channelJids.length) {
            return;
        }

        this._running = true;
        try {
            for (let i = 0; i < this.channelJids.length; i += CHANNEL_POLL_CONCURRENCY) {
                const batch = this.channelJids.slice(i, i + CHANNEL_POLL_CONCURRENCY);
                await Promise.allSettled(batch.map((jid) => this._pollChannel(jid)));
            }
        } finally {
            this._running = false;
        }
    }

    async _pollChannel(channelJid) {
        if (!this._sock || !this.stickerForwarder) {
            return;
        }

        const fails = this._failCounts.get(channelJid) || 0;
        if (fails >= MAX_CONSECUTIVE_FAILURES) {
            return;
        }

        try {
            const stickers = await fetchNewsletterStickerMessages(
                this._sock,
                channelJid,
                STICKERS_PER_FETCH,
            );

            this._failCounts.set(channelJid, 0);

            if (!stickers.length) {
                return;
            }

            let queued = 0;
            for (const msg of stickers) {
                const payload = extractStickerFromMessage(msg.message);
                if (!payload || !isChannelStickerReady(payload)) {
                    continue;
                }

                const trackId = msg?.key?.id ? `${channelJid}:${msg.key.id}` : null;
                const contentHash = payload?.fileSha256
                    ? Buffer.from(payload.fileSha256).toString('hex')
                    : null;

                if (this.stickerForwarder.wasForwarded(trackId, contentHash)) {
                    continue;
                }

                const added = await this.stickerForwarder.forwardSticker(
                    this._sock,
                    msg,
                    channelJid,
                    { isBackfill: true },
                );
                if (added) queued++;
            }

            if (queued > 0) {
                logger.info(`📡 Channel backfill queued ${queued} sticker(s) from ${channelJid}`);
            }
        } catch (err) {
            const newFails = fails + 1;
            this._failCounts.set(channelJid, newFails);
            if (newFails >= MAX_CONSECUTIVE_FAILURES) {
                logger.warn(
                    `📡 Channel ${channelJid} poll paused after ${newFails} failures ` +
                        `(resets in ≤${FAIL_COUNT_RESET_MS / 60_000}m): ${err.message}`
                );
            } else if (newFails === 1) {
                // The backfill is the only safety net for stickers that arrive
                // without media. Nineteen debug-level failures meant a channel could
                // be silently dead for ~20 minutes before anything was logged, so the
                // first failure is now visible at the default level.
                logger.warn(`📡 Channel poll failing ${channelJid} (1/${MAX_CONSECUTIVE_FAILURES}): ${err.message}`);
            } else {
                logger.debug(`📡 Channel poll error ${channelJid} (${newFails}/${MAX_CONSECUTIVE_FAILURES}): ${err.message}`);
            }
        }
    }
}

export default ChannelStickerPoller;
