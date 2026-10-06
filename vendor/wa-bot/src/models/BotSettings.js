/**
 * Persistent bot settings (survives redeploy/restart)
 */

import { logger } from '../utils/logger.js';

class BotSettings {
    constructor(mongoDb) {
        this.collection = mongoDb.collection('bot_settings');
    }

    async init() {
        await this.collection.createIndex({ key: 1 }, { unique: true, name: 'bot_settings_key' });
        logger.info('Mongo bot settings store ready');
    }

    async getCoursesPaused() {
        const doc = await this.collection.findOne({ key: 'courses_paused' });
        return Boolean(doc?.value);
    }

    async setCoursesPaused(paused) {
        await this.collection.updateOne(
            { key: 'courses_paused' },
            {
                $set: {
                    key: 'courses_paused',
                    value: Boolean(paused),
                    updated_at: new Date(),
                },
            },
            { upsert: true }
        );
    }

    async setCoursesPauseSnapshot(courseIds = []) {
        const ids = [...new Set(courseIds.map((id) => String(id)).filter(Boolean))];
        await this.collection.updateOne(
            { key: 'courses_pause_snapshot' },
            {
                $set: {
                    key: 'courses_pause_snapshot',
                    value: ids,
                    updated_at: new Date(),
                },
            },
            { upsert: true }
        );
    }

    async getCoursesPauseSnapshot() {
        const doc = await this.collection.findOne({ key: 'courses_pause_snapshot' });
        return Array.isArray(doc?.value) ? doc.value.map(String) : [];
    }

    async clearCoursesPauseSnapshot() {
        await this.collection.deleteOne({ key: 'courses_pause_snapshot' });
    }

    async getDriveSources() {
        const doc = await this.collection.findOne({ key: 'drive_sources' });
        return Array.isArray(doc?.value) ? doc.value : [];
    }

    async setDriveSources(urls) {
        await this.collection.updateOne(
            { key: 'drive_sources' },
            {
                $set: {
                    key: 'drive_sources',
                    value: urls,
                    updated_at: new Date(),
                },
            },
            { upsert: true },
        );
    }

    async getAssistModeEnabled() {
        const doc = await this.collection.findOne({ key: 'assist_mode_enabled' });
        return Boolean(doc?.value);
    }

    async setAssistModeEnabled(enabled) {
        await this.collection.updateOne(
            { key: 'assist_mode_enabled' },
            {
                $set: {
                    key: 'assist_mode_enabled',
                    value: Boolean(enabled),
                    updated_at: new Date(),
                },
            },
            { upsert: true }
        );
    }

    /** Generic JSON blob helpers (scheduler slots, etc.). */
    async getJson(key, fallback = null) {
        const doc = await this.collection.findOne({ key: String(key) });
        return doc?.value === undefined ? fallback : doc.value;
    }

    async setJson(key, value) {
        await this.collection.updateOne(
            { key: String(key) },
            {
                $set: {
                    key: String(key),
                    value,
                    updated_at: new Date(),
                },
            },
            { upsert: true }
        );
    }
}

export default BotSettings;
