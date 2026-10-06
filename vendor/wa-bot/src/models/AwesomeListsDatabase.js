/**
 * Tracks awesome lists posted per chat/group to avoid repeats.
 */

import crypto from 'crypto';
import { logger } from '../utils/logger.js';

function hashList(fullName) {
    return crypto.createHash('md5').update(String(fullName || '').trim().toLowerCase()).digest('hex');
}

class AwesomeListsDatabase {
    constructor(mongoDb) {
        this.mongoDb = mongoDb;
        this.posted = null;
    }

    async init() {
        this.posted = this.mongoDb.collection('posted_awesome_lists');
        await Promise.all([
            this.posted.createIndex(
                { hash: 1, group_id: 1 },
                { unique: true, name: 'posted_awesome_list_per_group' }
            ),
            this.posted.createIndex({ posted_at: 1 }, { name: 'posted_awesome_list_posted_at' }),
        ]);
        logger.info('Mongo awesome lists store ready');
    }

    async isListPosted(fullName, groupId) {
        const row = await this.posted.findOne(
            { hash: hashList(fullName), group_id: groupId },
            { projection: { _id: 1 } }
        );
        return Boolean(row);
    }

    async markListPosted(fullName, groupId) {
        if (!fullName || !groupId) return;
        await this.posted.updateOne(
            { hash: hashList(fullName), group_id: groupId },
            {
                $setOnInsert: {
                    hash: hashList(fullName),
                    group_id: groupId,
                    full_name: String(fullName).slice(0, 200),
                    posted_at: new Date(),
                },
            },
            { upsert: true }
        );
    }

    async filterUnpostedLists(lists, groupId) {
        if (!lists?.length || !groupId) return lists || [];
        const unposted = [];
        for (const list of lists) {
            if (!(await this.isListPosted(list.fullName, groupId))) {
                unposted.push(list);
            }
        }
        return unposted;
    }

    async filterFreshForGroups(lists, groupIds) {
        if (!lists?.length || !groupIds?.length) return lists || [];
        const fresh = [];
        for (const list of lists) {
            let postedAnywhere = false;
            for (const groupId of groupIds) {
                if (await this.isListPosted(list.fullName, groupId)) {
                    postedAnywhere = true;
                    break;
                }
            }
            if (!postedAnywhere) fresh.push(list);
        }
        return fresh;
    }

    async pickFreshList(lists, groupIds) {
        const fresh = await this.filterFreshForGroups(lists, groupIds);
        if (!fresh.length) return null;
        return fresh[Math.floor(Math.random() * fresh.length)];
    }

    async cleanupOldPosted(days = 14) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);
        const result = await this.posted.deleteMany({ posted_at: { $lt: cutoff } });
        return result.deletedCount || 0;
    }

    close() {
        this.posted = null;
    }
}

export default AwesomeListsDatabase;
