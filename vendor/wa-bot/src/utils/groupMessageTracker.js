/**
 * Ring buffer of recent group message keys for admin bulk-delete.
 */

import { getTextFromWAMessage, resolveConversationChatId } from './waMessage.js';

const MAX_PER_GROUP = 500;

const DELETE_CMD_RE = /^\/(dellast|delall|del)\b/i;

class GroupMessageTracker {
    constructor() {
        /** @type {Map<string, Array<{ key: import('baileys').proto.IMessageKey, ts: number }>>} */
        this._groups = new Map();
        /**
         * Mirror of the ids in each list, so the duplicate check on the hot path
         * is O(1). It previously scanned up to MAX_PER_GROUP entries for every
         * inbound message — real CPU in a busy 900-member group, and it ran
         * synchronously inside the messages.upsert loop.
         * @type {Map<string, Set<string>>}
         */
        this._ids = new Map();
    }

    /** Keep the id mirror aligned with a list we just replaced or trimmed. */
    _reindex(storageKey, list) {
        this._ids.set(storageKey, new Set(list.map((e) => e.key.id)));
    }

    _normalizeGroupId(chatId) {
        if (!chatId?.endsWith('@g.us')) {
            return '';
        }
        return resolveConversationChatId({ remoteJid: chatId }) || chatId;
    }

    _lookupKeys(chatId) {
        const keys = [];
        const add = (value) => {
            if (value && !keys.includes(value)) {
                keys.push(value);
            }
        };

        add(chatId);
        add(this._normalizeGroupId(chatId));
        add(resolveConversationChatId({ remoteJid: chatId }));

        return keys;
    }

    _getList(chatId) {
        for (const key of this._lookupKeys(chatId)) {
            const list = this._groups.get(key);
            if (list?.length) {
                return { storageKey: key, list };
            }
        }

        const storageKey = this._normalizeGroupId(chatId) || chatId;
        return { storageKey, list: this._groups.get(storageKey) || [] };
    }

    /**
     * Track a message the bot just sent (emitOwnEvents is off, so upsert won't include it).
     * @param {string} chatId
     * @param {import('baileys').proto.IWebMessageInfo | { key?: import('baileys').proto.IMessageKey, message?: import('baileys').proto.IMessage }} sent
     * @param {object} [content]
     */
    trackOutgoingSend(chatId, sent, content = null) {
        if (!sent?.key?.id || content?.delete) {
            return;
        }

        const remoteJid = this._normalizeGroupId(sent.key.remoteJid || chatId);
        if (!remoteJid) {
            return;
        }

        const text = typeof content?.text === 'string' ? content.text.trim() : '';
        if (DELETE_CMD_RE.test(text)) {
            return;
        }

        let message = sent.message;
        if (!message) {
            if (content?.text) {
                message = { conversation: content.text };
            } else if (content?.image) {
                message = { imageMessage: {} };
            } else if (content?.video) {
                message = { videoMessage: {} };
            } else if (content?.sticker) {
                message = { stickerMessage: {} };
            } else if (content?.audio) {
                message = { audioMessage: {} };
            } else if (content?.document) {
                message = { documentMessage: {} };
            } else {
                message = { conversation: '' };
            }
        }

        this.track({
            key: {
                remoteJid,
                id: sent.key.id,
                fromMe: true,
                ...(sent.key.participant ? { participant: sent.key.participant } : {}),
            },
            message,
        });
    }

    /**
     * @param {import('baileys').proto.IWebMessageInfo} msg
     */
    track(msg) {
        const chatId = this._normalizeGroupId(msg?.key?.remoteJid);
        if (!chatId || !msg.key?.id || !msg.message) {
            return;
        }

        const text = getTextFromWAMessage(msg.message).trim();
        if (DELETE_CMD_RE.test(text)) {
            return;
        }

        let list = this._groups.get(chatId);
        if (!list) {
            list = [];
            this._groups.set(chatId, list);
        }
        let ids = this._ids.get(chatId);
        if (!ids) {
            ids = new Set(list.map((e) => e.key.id));
            this._ids.set(chatId, ids);
        }

        if (ids.has(msg.key.id)) {
            return;
        }

        list.push({
            key: {
                remoteJid: chatId,
                id: msg.key.id,
                fromMe: Boolean(msg.key.fromMe),
                ...(msg.key.participant ? { participant: msg.key.participant } : {}),
                ...(msg.key.participantLid ? { participantLid: msg.key.participantLid } : {}),
            },
            ts: Date.now(),
        });
        ids.add(msg.key.id);

        if (list.length > MAX_PER_GROUP) {
            const dropped = list.splice(0, list.length - MAX_PER_GROUP);
            for (const entry of dropped) ids.delete(entry.key.id);
        }
    }

    /**
     * @param {string} chatId
     * @param {number} count
     * @returns {Array<{ key: import('baileys').proto.IMessageKey, ts: number }>}
     */
    getLast(chatId, count) {
        const { list } = this._getList(chatId);
        if (!count || count >= list.length) {
            return [...list];
        }
        return list.slice(-count);
    }

    /**
     * Most recent messages eligible for bulk delete (strictly before the command message).
     * @param {string} chatId
     * @param {number} count
     * @param {string} [beforeMessageId]
     */
    getRecentBefore(chatId, count, beforeMessageId) {
        let list = [...this._getList(chatId).list];

        if (beforeMessageId) {
            const cut = list.findIndex((entry) => entry.key.id === beforeMessageId);
            if (cut >= 0) {
                list = list.slice(0, cut);
            }
        }

        if (!list.length) {
            return [];
        }

        if (!count || count >= list.length) {
            return [...list];
        }

        return list.slice(-count);
    }

    /**
     * @deprecated Use getRecentBefore for /dellast N — users expect most-recent messages.
     */
    getOldestBefore(chatId, count, beforeMessageId) {
        let list = [...this._getList(chatId).list];

        if (beforeMessageId) {
            const cut = list.findIndex((entry) => entry.key.id === beforeMessageId);
            if (cut >= 0) {
                list = list.slice(0, cut);
            }
        }

        if (!list.length) {
            return [];
        }

        if (!count || count >= list.length) {
            return [...list];
        }

        return list.slice(0, count);
    }

    /**
     * @param {string} chatId
     * @param {string} [beforeMessageId]
     * @returns {number}
     */
    countBefore(chatId, beforeMessageId) {
        let list = [...this._getList(chatId).list];
        if (beforeMessageId) {
            const cut = list.findIndex((entry) => entry.key.id === beforeMessageId);
            if (cut >= 0) {
                list = list.slice(0, cut);
            }
        }
        return list.length;
    }

    count(chatId) {
        return this._getList(chatId).list.length;
    }

    /**
     * @param {string} chatId
     * @param {string[]} messageIds
     */
    removeByIds(chatId, messageIds) {
        const idSet = new Set(messageIds);
        const { storageKey, list } = this._getList(chatId);
        if (!list.length) {
            return;
        }
        const next = list.filter((entry) => !idSet.has(entry.key.id));
        this._groups.set(storageKey, next);
        this._reindex(storageKey, next);
    }
}

export const groupMessageTracker = new GroupMessageTracker();
