/**
 * Database Model
 * Handles all database operations for posted courses
 */

import { logger } from '../utils/logger.js';

class DatabaseModel {
    constructor(mongoDb) {
        this.mongoDb = mongoDb;
        this.collection = null;
    }

    async init() {
        this.collection = this.mongoDb.collection('posted_courses');
        await this.collection.createIndex(
            { course_id: 1, group_id: 1 },
            { unique: true, name: 'posted_course_per_group' }
        );
        logger.info('Mongo posted course store ready');
    }

    async isPosted(courseId, groupId) {
        const row = await this.collection.findOne(
            { course_id: String(courseId), group_id: groupId },
            { projection: { _id: 1 } }
        );
        return Boolean(row);
    }

    async markPosted(courseId, groupId, name, url) {
        await this.collection.updateOne(
            { course_id: String(courseId), group_id: groupId },
            {
                $setOnInsert: {
                    course_id: String(courseId),
                    group_id: groupId,
                    name,
                    url,
                    posted_at: new Date(),
                },
            },
            { upsert: true }
        );
    }

    async getTotalPosted(groupId = null) {
        return this.collection.countDocuments(this.buildGroupFilter(groupId));
    }

    async getPostedStats(groupId = null) {
        const baseFilter = this.buildGroupFilter(groupId);
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const weekStart = new Date(now);
        weekStart.setDate(now.getDate() - 7);
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

        const [total, today, thisWeek, thisMonth] = await Promise.all([
            this.collection.countDocuments(baseFilter),
            this.collection.countDocuments({
                ...baseFilter,
                posted_at: { $gte: todayStart },
            }),
            this.collection.countDocuments({
                ...baseFilter,
                posted_at: { $gte: weekStart },
            }),
            this.collection.countDocuments({
                ...baseFilter,
                posted_at: { $gte: monthStart },
            }),
        ]);

        return { total, today, thisWeek, thisMonth };
    }

    async clearAllPosted(groupId = null) {
        const result = await this.collection.deleteMany(this.buildGroupFilter(groupId));
        return result.deletedCount || 0;
    }

    async getRecentCourses(limit = 5) {
        return this.collection
            .find({}, { projection: { _id: 0 } })
            .sort({ posted_at: -1 })
            .limit(limit)
            .toArray();
    }

    buildGroupFilter(groupId) {
        if (groupId) {
            return { group_id: groupId };
        }
        return {};
    }

    close() {
        this.collection = null;
    }
}

export default DatabaseModel;
