/**
 * Tracks AI update items posted per group to avoid repeats, plus durable
 * per-day slot success so a missed/failed post can still catch up.
 * Mirrors GitHubTrendingDatabase.js.
 */

import crypto from 'crypto';
import { logger } from '../utils/logger.js';

function hashItem(url) {
    return crypto.createHash('md5').update(url.trim().toLowerCase()).digest('hex');
}

class AiUpdatesDatabase {
    constructor(mongoDb) {
        this.mongoDb = mongoDb;
        this.posted = null;
        this.slots = null;
    }

    async init() {
        this.posted = this.mongoDb.collection('posted_ai_updates');
        this.slots = this.mongoDb.collection('ai_updates_slots');
        await Promise.all([
            this.posted.createIndex(
                { hash: 1, group_id: 1 },
                { unique: true, name: 'posted_ai_update_per_group' }
            ),
            this.posted.createIndex({ posted_at: 1 }, { name: 'posted_ai_update_posted_at' }),
            this.slots.createIndex({ slot_key: 1 }, { unique: true, name: 'ai_updates_slot_key' }),
            this.slots.createIndex({ posted_at: 1 }, { name: 'ai_updates_slot_posted_at' }),
        ]);
        logger.info('Mongo AI updates store ready');
    }

    async isItemPosted(url, groupId) {
        const row = await this.posted.findOne(
            { hash: hashItem(url), group_id: groupId },
            { projection: { _id: 1 } }
        );
        return Boolean(row);
    }

    async markItemPosted(url, groupId) {
        if (!url || !groupId) return;
        await this.posted.updateOne(
            { hash: hashItem(url), group_id: groupId },
            {
                $setOnInsert: {
                    hash: hashItem(url),
                    group_id: groupId,
                    url: url.slice(0, 400),
                    posted_at: new Date(),
                },
            },
            { upsert: true }
        );
    }

    /** Items that still need posting to at least one target group. */
    async filterFreshForGroups(items, groupIds) {
        if (!items?.length || !groupIds?.length) {
            return items || [];
        }
        const fresh = [];
        for (const item of items) {
            let missingSomewhere = false;
            for (const groupId of groupIds) {
                if (!(await this.isItemPosted(item.url, groupId))) {
                    missingSomewhere = true;
                    break;
                }
            }
            if (missingSomewhere) fresh.push(item);
        }
        return fresh;
    }

    async pickFreshItem(items, groupIds) {
        const fresh = await this.filterFreshForGroups(items, groupIds);
        return fresh[0] || null;
    }

    async isSlotDone(slotKey) {
        if (!slotKey || !this.slots) return false;
        const row = await this.slots.findOne({ slot_key: slotKey }, { projection: { _id: 1 } });
        return Boolean(row);
    }

    async markSlotDone(slotKey, meta = {}) {
        if (!slotKey || !this.slots) return;
        await this.slots.updateOne(
            { slot_key: slotKey },
            {
                $set: {
                    slot_key: slotKey,
                    posted: Number(meta.posted) || 0,
                    reason: String(meta.reason || '').slice(0, 80),
                    item: String(meta.item || '').slice(0, 200),
                    posted_at: new Date(),
                },
            },
            { upsert: true }
        );
    }

    async cleanupOldPosted(days = 14) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);
        const [posted, slots] = await Promise.all([
            this.posted.deleteMany({ posted_at: { $lt: cutoff } }),
            this.slots
                ? this.slots.deleteMany({ posted_at: { $lt: cutoff } })
                : Promise.resolve({ deletedCount: 0 }),
        ]);
        return (posted.deletedCount || 0) + (slots.deletedCount || 0);
    }

    close() {
        this.posted = null;
        this.slots = null;
    }
}

export default AiUpdatesDatabase;
