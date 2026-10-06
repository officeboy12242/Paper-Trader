/**
 * Database Auth State
 * Custom auth state handler that stores WhatsApp auth in database instead of files
 * Compatible with Baileys' useMultiFileAuthState
 */

import { initAuthCreds, BufferJSON, proto } from 'baileys';
import { logger } from './logger.js';

/**
 * Use database for auth state instead of files
 * This makes auth portable and works on Render without persistent disk
 */
export async function useDatabaseAuthState(authDB) {
    // Serialize/deserialize with BufferJSON to handle Buffers properly
    const writeData = async (data, key) => {
        try {
            await authDB.set(key, JSON.stringify(data, BufferJSON.replacer));
        } catch (error) {
            logger.error(`Error writing ${key}:`, error.message);
        }
    };

    const readData = (key) => {
        try {
            const data = authDB.get(key);
            if (data) {
                return JSON.parse(data, BufferJSON.reviver);
            }
            return null;
        } catch (error) {
            logger.error(`Error reading ${key}:`, error.message);
            return null;
        }
    };

    // Load credentials from database or create new ones
    const creds = readData('creds') || initAuthCreds();
    
    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    for (const id of ids) {
                        const key = `${type}-${id}`;
                        let value = readData(key);
                        if (value) {
                            if (type === 'app-state-sync-key') {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        }
                    }
                    return data;
                },
                set: async (data) => {
                    const writes = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            if (value == null) {
                                writes.push(authDB.delete(key).catch(() => {}));
                            } else {
                                writes.push(writeData(value, key));
                            }
                        }
                    }
                    await Promise.all(writes);
                }
            }
        },
        saveCreds: async () => {
            await writeData(creds, 'creds');
        },
        clearAuth: async () => {
            await authDB.clearAll();
            logger.info('🗑️ Cleared all auth data from database');
        },
        closeDB: () => {
            authDB.close();
        }
    };
}
