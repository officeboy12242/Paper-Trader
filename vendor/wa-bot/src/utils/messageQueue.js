/**
 * Per-chat send queue (ported from WhatsAppBotMultiDevice).
 * Serializes sends per chat to avoid delivery races.
 * Lower priority number = sent sooner (cmds before bulk dumps).
 */

import { logger } from './logger.js';

class MessageQueue {
    constructor() {
        /** @type {Map<string, Array<{ run: () => Promise<unknown>, resolve: Function, reject: Function, priority: number }>>} */
        this.queues = new Map();
        /** @type {Map<string, boolean>} */
        this.processing = new Map();
        this.messageDelayMs = 50;
        this._cleanupInterval = setInterval(() => this.cleanupEmptyQueues(), 5 * 60 * 1000);
    }

    cleanupEmptyQueues() {
        for (const [chatId, queue] of this.queues.entries()) {
            if (!queue.length && !this.processing.get(chatId)) {
                this.queues.delete(chatId);
                this.processing.delete(chatId);
            }
        }
    }

    /**
     * Lower number = sent sooner. Typical: DM/cmds 0–1, progress 2, bulk dumps 3+.
     * @param {string} chatId
     * @param {() => Promise<unknown>} sendFunction
     * @param {number} [priority]
     * @returns {Promise<unknown>}
     */
    enqueue(chatId, sendFunction, priority = 1) {
        if (!chatId) {
            return sendFunction();
        }

        return new Promise((resolve, reject) => {
            if (!this.queues.has(chatId)) {
                this.queues.set(chatId, []);
            }
            const queue = this.queues.get(chatId);
            queue.push({ run: sendFunction, resolve, reject, priority });
            queue.sort((a, b) => a.priority - b.priority);

            if (!this.processing.get(chatId)) {
                // Claim + microtask so a sync burst of enqueues can all land before drain
                this.processing.set(chatId, true);
                queueMicrotask(() => {
                    void this.processQueue(chatId);
                });
            }
        });
    }

    async processQueue(chatId) {
        const queue = this.queues.get(chatId);
        try {
            while (queue?.length) {
                queue.sort((a, b) => a.priority - b.priority);
                const item = queue.shift();
                if (!item) continue;
                try {
                    const result = await item.run();
                    item.resolve(result);
                } catch (err) {
                    item.reject(err);
                }
                if (queue.length > 0) {
                    await new Promise((r) => setTimeout(r, this.messageDelayMs));
                }
            }
        } catch (err) {
            logger.warn(`messageQueue drain error for ${chatId}: ${err?.message || err}`);
        } finally {
            this.processing.set(chatId, false);
            if (this.queues.get(chatId)?.length) {
                this.processing.set(chatId, true);
                queueMicrotask(() => {
                    void this.processQueue(chatId);
                });
            } else {
                this.queues.delete(chatId);
            }
        }
    }

    destroy() {
        clearInterval(this._cleanupInterval);
        this.queues.clear();
        this.processing.clear();
    }

    /** Live queue depth for dashboard. */
    stats() {
        let pending = 0;
        let processing = 0;
        for (const q of this.queues.values()) pending += q.length;
        for (const on of this.processing.values()) {
            if (on) processing += 1;
        }
        return { chats: this.queues.size, pending, processing };
    }
}

export const messageQueue = new MessageQueue();
