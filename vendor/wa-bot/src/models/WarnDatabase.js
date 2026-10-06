/**
 * Stores group member warnings (per group, keyed by phone or JID).
 */

import { logger } from '../utils/logger.js';

class WarnDatabase {
    constructor(mongoDb) {
        this.mongoDb = mongoDb;
        this.warns = null;
    }

    async init() {
        this.warns = this.mongoDb.collection('group_warns');
        await Promise.all([
            this.warns.createIndex(
                { group_id: 1, member_key: 1, created_at: -1 },
                { name: 'group_warn_member_time' },
            ),
            this.warns.createIndex(
                { group_id: 1, member_key: 1 },
                { name: 'group_warn_member' },
            ),
        ]);
        logger.info('Mongo group warn store ready');
    }

    /**
     * @param {object} params
     * @param {string} params.groupId
     * @param {string} params.memberKey
     * @param {string} [params.memberPhone]
     * @param {string} [params.memberJid]
     * @param {string} params.reason
     * @param {string} params.warnedByPhone
     * @param {string} [params.warnedByJid]
     */
    async addWarn(params) {
        const doc = {
            group_id: params.groupId,
            member_key: params.memberKey,
            member_phone: params.memberPhone || '',
            member_jid: params.memberJid || '',
            reason: params.reason.trim(),
            warned_by_phone: params.warnedByPhone,
            warned_by_jid: params.warnedByJid || '',
            created_at: new Date(),
        };
        await this.warns.insertOne(doc);
        const count = await this.countWarns(params.groupId, params.memberKey);
        return { count, doc };
    }

    async countWarns(groupId, memberKey) {
        return this.warns.countDocuments({ group_id: groupId, member_key: memberKey });
    }

    async getWarns(groupId, memberKey, limit = 20) {
        return this.warns
            .find({ group_id: groupId, member_key: memberKey })
            .sort({ created_at: -1 })
            .limit(limit)
            .toArray();
    }

    async clearWarns(groupId, memberKey) {
        const result = await this.warns.deleteMany({ group_id: groupId, member_key: memberKey });
        return result.deletedCount || 0;
    }

    close() {
        this.warns = null;
    }
}

export default WarnDatabase;
