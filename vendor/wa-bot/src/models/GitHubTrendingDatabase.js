/**
 * Tracks GitHub trending repos posted per chat/group to avoid repeats,
 * plus durable per-day slot success so missed/failed posts can catch up.
 */

import crypto from 'crypto';
import { logger } from '../utils/logger.js';

function hashRepo(fullName) {
    return crypto.createHash('md5').update(fullName.trim().toLowerCase()).digest('hex');
}

class GitHubTrendingDatabase {
    constructor(mongoDb) {
        this.mongoDb = mongoDb;
        this.posted = null;
        this.slots = null;
    }

    async init() {
        this.posted = this.mongoDb.collection('posted_github_repos');
        this.slots = this.mongoDb.collection('github_post_slots');
        await Promise.all([
            this.posted.createIndex(
                { hash: 1, group_id: 1 },
                { unique: true, name: 'posted_github_repo_per_group' }
            ),
            this.posted.createIndex({ posted_at: 1 }, { name: 'posted_github_repo_posted_at' }),
            this.slots.createIndex({ slot_key: 1 }, { unique: true, name: 'github_slot_key' }),
            this.slots.createIndex({ posted_at: 1 }, { name: 'github_slot_posted_at' }),
        ]);
        logger.info('Mongo GitHub trending store ready');
    }

    async isRepoPosted(fullName, groupId) {
        const row = await this.posted.findOne(
            { hash: hashRepo(fullName), group_id: groupId },
            { projection: { _id: 1 } }
        );
        return Boolean(row);
    }

    async markRepoPosted(fullName, groupId) {
        if (!fullName || !groupId) {
            return;
        }
        await this.posted.updateOne(
            { hash: hashRepo(fullName), group_id: groupId },
            {
                $setOnInsert: {
                    hash: hashRepo(fullName),
                    group_id: groupId,
                    full_name: fullName.slice(0, 200),
                    posted_at: new Date(),
                },
            },
            { upsert: true }
        );
    }

    async filterUnpostedRepos(repos, groupId) {
        if (!repos?.length || !groupId) {
            return repos || [];
        }
        const unposted = [];
        for (const repo of repos) {
            if (!(await this.isRepoPosted(repo.fullName, groupId))) {
                unposted.push(repo);
            }
        }
        return unposted;
    }

    /**
     * Repos that still need posting to at least one target group.
     * (Partial fan-out can finish later instead of being treated as "done everywhere".)
     */
    async filterFreshForGroups(repos, groupIds) {
        if (!repos?.length || !groupIds?.length) {
            return repos || [];
        }
        const fresh = [];
        for (const repo of repos) {
            let missingSomewhere = false;
            for (const groupId of groupIds) {
                if (!(await this.isRepoPosted(repo.fullName, groupId))) {
                    missingSomewhere = true;
                    break;
                }
            }
            if (missingSomewhere) {
                fresh.push(repo);
            }
        }
        return fresh;
    }

    async pickFreshRepo(repos, groupIds) {
        const fresh = await this.filterFreshForGroups(repos, groupIds);
        return fresh[0] || null;
    }

    async isSlotDone(slotKey) {
        if (!slotKey || !this.slots) return false;
        const row = await this.slots.findOne(
            { slot_key: slotKey },
            { projection: { _id: 1 } }
        );
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
                    repo: String(meta.repo || '').slice(0, 200),
                    posted_at: new Date(),
                },
            },
            { upsert: true }
        );
    }

    async cleanupOldPosted(days = 7) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);
        const [repos, slots] = await Promise.all([
            this.posted.deleteMany({ posted_at: { $lt: cutoff } }),
            this.slots
                ? this.slots.deleteMany({ posted_at: { $lt: cutoff } })
                : Promise.resolve({ deletedCount: 0 }),
        ]);
        return (repos.deletedCount || 0) + (slots.deletedCount || 0);
    }

    close() {
        this.posted = null;
        this.slots = null;
    }
}

export default GitHubTrendingDatabase;
