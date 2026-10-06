/**
 * Stores group member bans (per group, keyed by normalized phone or JID).
 *
 * A ban is durable: banned members who rejoin (via invite link, admin add, or
 * group link re-share) are removed again by the group-participants hook in
 * groupHandlers.js.
 */

import { logger } from '../utils/logger.js';

class BanDatabase {
    constructor(mongoDb) {
        this.mongoDb = mongoDb;
        this.bans = null;
    }

    async init() {
        this.bans = this.mongoDb.collection('group_bans');
        await Promise.all([
            this.bans.createIndex(
                { group_id: 1, member_key: 1 },
                { unique: true, name: 'group_ban_member' },
            ),
            this.bans.createIndex(
                { group_id: 1, banned_at: -1 },
                { name: 'group_ban_time' },
            ),
        ]);
        logger.info('Mongo group ban store ready');
    }

    /**
     * @param {object} params
     * @param {string} params.groupId
     * @param {string} params.memberKey  normalized phone (preferred) or JID
     * @param {string} [params.memberPhone]
     * @param {string} [params.memberJid]
     * @param {string} params.reason
     * @param {string} params.bannedByPhone
     * @param {string} [params.bannedByJid]
     * @returns {Promise<{ existed: boolean, doc: object }>} existed=true when the member was already banned
     */
    async addBan(params) {
        const now = new Date();
        const doc = {
            group_id: params.groupId,
            member_key: params.memberKey,
            member_phone: params.memberPhone || '',
            member_jid: params.memberJid || '',
            reason: String(params.reason || '').slice(0, 300),
            banned_by_phone: params.bannedByPhone || '',
            banned_by_jid: params.bannedByJid || '',
            banned_at: now,
        };

        const result = await this.bans.updateOne(
            { group_id: doc.group_id, member_key: doc.member_key },
            {
                $set: {
                    member_phone: doc.member_phone,
                    member_jid: doc.member_jid,
                    reason: doc.reason,
                    banned_by_phone: doc.banned_by_phone,
                    banned_by_jid: doc.banned_by_jid,
                    banned_at: now,
                },
                $setOnInsert: { group_id: doc.group_id, member_key: doc.member_key },
            },
            { upsert: true },
        );
        return { existed: (result.upsertedCount || 0) === 0, doc };
    }

    async removeBan(groupId, memberKey) {
        const result = await this.bans.deleteOne({ group_id: groupId, member_key: memberKey });
        return result.deletedCount || 0;
    }

    /** @returns {Promise<boolean>} */
    async isBanned(groupId, memberKey) {
        if (!groupId || !memberKey) return false;
        const row = await this.bans.findOne(
            { group_id: groupId, member_key: memberKey },
            { projection: { _id: 1 } },
        );
        return Boolean(row);
    }

    /** All bans for a group, newest first. */
    async listBans(groupId, limit = 50) {
        return this.bans
            .find({ group_id: groupId })
            .sort({ banned_at: -1 })
            .limit(limit)
            .toArray();
    }

    /** Bulk lookup for the join-enforcement hook — one query per join event. */
    async filterBanned(groupId, memberKeys = []) {
        if (!groupId || !memberKeys.length) return new Set();
        const rows = await this.bans
            .find({ group_id: groupId, member_key: { $in: memberKeys } })
            .project({ member_key: 1 })
            .toArray();
        return new Set(rows.map((r) => r.member_key));
    }

    close() {
        this.bans = null;
    }
}

export default BanDatabase;
