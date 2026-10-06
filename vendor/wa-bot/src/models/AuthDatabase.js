/**
 * Auth Database Model
 * Stores WhatsApp authentication data in MongoDB.
 */

import { logger } from '../utils/logger.js';

class AuthDatabase {
    constructor(mongoDb) {
        this.mongoDb = mongoDb;
        this.collection = null;
        this.cache = new Map();
    }

    async init() {
        this.collection = this.mongoDb.collection('auth_data');
        await this.collection.createIndex(
            { key: 1 },
            { unique: true, name: 'auth_data_key' }
        );

        this.cache.clear();
        const rows = await this.collection.find({}, { projection: { _id: 0, key: 1, value: 1 } }).toArray();
        for (const row of rows) {
            this.cache.set(row.key, row.value);
        }

        logger.info(`Mongo auth store ready (${this.cache.size} record(s))`);
    }

    // Save auth data (creds or keys)
    // Value should already be stringified by caller
    async set(key, value) {
        const valueStr = typeof value === 'string' ? value : JSON.stringify(value);
        this.cache.set(key, valueStr);
        await this.collection.updateOne(
            { key },
            {
                $set: {
                    value: valueStr,
                    updated_at: new Date(),
                },
                $setOnInsert: {
                    key,
                },
            },
            { upsert: true }
        );
    }

    // Get auth data
    // Returns raw string, caller will parse it
    get(key) {
        return this.cache.get(key) || null;
    }

    // Delete auth data
    async delete(key) {
        this.cache.delete(key);
        await this.collection.deleteOne({ key });
    }

    // Clear all auth data (logout)
    async clearAll() {
        this.cache.clear();
        const result = await this.collection.deleteMany({});
        logger.info(`Cleared ${result.deletedCount || 0} auth records`);
        return result.deletedCount || 0;
    }

    // Get all keys (for debugging)
    getAllKeys() {
        return Array.from(this.cache.keys());
    }

    close() {
        this.cache.clear();
        this.collection = null;
    }
}

export default AuthDatabase;
