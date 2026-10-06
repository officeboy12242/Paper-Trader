/**
 * User Manager
 * Stores and retrieves user information (JID -> push name mapping)
 */

import { logger } from '../utils/logger.js';

class UserManager {
    constructor(db) {
        this.db = db;
        this.collection = db.collection('users');
        this._ensureIndexes();
    }

    async _ensureIndexes() {
        try {
            await this.collection.createIndex({ _id: 1 });
        } catch (err) {
            logger.error('Failed to create user indexes:', err.message);
        }
    }

    /**
     * Store or update user information
     * @param {string} jid - User's JID (can be LID or standard JID)
     * @param {string} pushName - User's WhatsApp display name
     */
    async updateUser(jid, pushName) {
        if (!jid || !pushName) return;

        try {
            await this.collection.updateOne(
                { _id: jid },
                {
                    $set: {
                        pushName: pushName,
                        lastUpdated: new Date()
                    }
                },
                { upsert: true }
            );
        } catch (err) {
            logger.error('Failed to update user:', err.message);
        }
    }

    /**
     * Get user information by JID
     * @param {string} jid - User's JID
     * @returns {Promise<{pushName: string, lastUpdated: Date} | null>}
     */
    async getUser(jid) {
        if (!jid) return null;

        try {
            const user = await this.collection.findOne({ _id: jid });
            return user;
        } catch (err) {
            logger.error('Failed to get user:', err.message);
            return null;
        }
    }

    /**
     * Get user's display name by JID
     * @param {string} jid - User's JID
     * @returns {Promise<string | null>}
     */
    async getUserName(jid) {
        if (!jid) return null;

        const user = await this.getUser(jid);
        return user?.pushName || null;
    }

    /**
     * Try to resolve user name from multiple possible JIDs
     * (handles LID and standard JID formats)
     * @param {string[]} jids - Array of possible JIDs to check
     * @returns {Promise<string | null>}
     */
    async resolveUserName(jids) {
        if (!Array.isArray(jids) || jids.length === 0) return null;

        for (const jid of jids) {
            const name = await this.getUserName(jid);
            if (name) return name;
        }

        return null;
    }

}

export default UserManager;
