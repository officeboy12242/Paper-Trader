import { MongoClient } from 'mongodb';
import { logger } from '../utils/logger.js';

let client = null;
let database = null;

export async function connectMongo({ uri, dbName }) {
    if (database) {
        return database;
    }
    if (!uri) {
        throw new Error('MONGODB_URI is required. Add it to your .env or deployment environment.');
    }

    client = new MongoClient(uri);
    await client.connect();
    database = client.db(dbName);
    await ensureIndexes(database);
    logger.info(`MongoDB ready: ${dbName}`);
    return database;
}

async function ensureIndexes(db) {
    await Promise.all([
        db.collection('posted_courses').createIndex(
            { course_id: 1, group_id: 1 },
            { unique: true, name: 'posted_course_per_group' }
        ),
        db.collection('active_groups').createIndex(
            { group_id: 1 },
            { unique: true, name: 'active_group_id' }
        ),
        db.collection('admins').createIndex(
            { phone_number: 1 },
            { unique: true, name: 'admin_phone_number' }
        ),
        db.collection('auth_data').createIndex(
            { key: 1 },
            { unique: true, name: 'auth_data_key' }
        ),
        db.collection('posted_news').createIndex(
            { hash: 1, group_id: 1 },
            { unique: true, name: 'posted_news_per_group' }
        ),
        db.collection('news_queue').createIndex(
            { hash: 1 },
            { unique: true, name: 'news_queue_hash' }
        ),
        db.collection('posted_github_repos').createIndex(
            { hash: 1, group_id: 1 },
            { unique: true, name: 'posted_github_repo_per_group' }
        ),
    ]);
}

export function getMongoDb() {
    if (!database) {
        throw new Error('MongoDB has not been connected yet.');
    }
    return database;
}

export async function closeMongo() {
    if (client) {
        await client.close();
    }
    client = null;
    database = null;
}
