/**
 * News Database Model
 * Tracks posted tech news and scrape queue (Inshorts)
 */

import crypto from 'crypto';
import { logger } from '../utils/logger.js';

function hashTitle(title) {
    return crypto.createHash('md5').update(title.trim().toLowerCase()).digest('hex');
}

class NewsDatabase {
    constructor(mongoDb) {
        this.mongoDb = mongoDb;
        this.posted = null;
        this.queue = null;
    }

    async init() {
        this.posted = this.mongoDb.collection('posted_news');
        this.queue = this.mongoDb.collection('news_queue');
        await Promise.all([
            this.posted.createIndex(
                { hash: 1, group_id: 1 },
                { unique: true, name: 'posted_news_per_group' }
            ),
            this.posted.createIndex(
                { posted_at: 1 },
                { name: 'posted_news_posted_at' }
            ),
            this.queue.createIndex({ hash: 1 }, { unique: true, name: 'news_queue_hash' }),
            this.queue.createIndex({ scraped_at: -1 }, { name: 'news_queue_scraped_at' }),
        ]);
        logger.info('Mongo news store ready');
    }

    hashTitle(title) {
        return hashTitle(title);
    }

    async isNewsPosted(title, groupId) {
        const row = await this.posted.findOne(
            { hash: hashTitle(title), group_id: groupId },
            { projection: { _id: 1 } }
        );
        return Boolean(row);
    }

    async isNewsPostedGlobally(title) {
        const row = await this.posted.findOne(
            { hash: hashTitle(title) },
            { projection: { _id: 1 } }
        );
        return Boolean(row);
    }

    async markNewsPosted(titles, groupId) {
        if (!titles.length) {
            return;
        }
        const ops = titles.map((title) => {
            const hash = hashTitle(title);
            return {
                updateOne: {
                    filter: { hash, group_id: groupId },
                    update: {
                        $setOnInsert: {
                            hash,
                            group_id: groupId,
                            title: title.slice(0, 200),
                            posted_at: new Date(),
                        },
                    },
                    upsert: true,
                },
            };
        });
        await this.posted.bulkWrite(ops, { ordered: false });
        await this.queue.deleteMany({ hash: { $in: titles.map(hashTitle) } });
    }

    async queueArticles(articles) {
        if (!articles.length) {
            return;
        }
        const ops = articles.map((article) => {
            const hash = hashTitle(article.title);
            return {
                updateOne: {
                    filter: { hash },
                    update: {
                        $setOnInsert: {
                            hash,
                            title: article.title.slice(0, 200),
                            summary: (article.summary || '').slice(0, 500),
                            scraped_at: new Date(),
                        },
                    },
                    upsert: true,
                },
            };
        });
        await this.queue.bulkWrite(ops, { ordered: false });
    }

    async getQueuedArticles() {
        const postedHashes = await this.posted.distinct('hash');
        const postedSet = new Set(postedHashes);
        const rows = await this.queue
            .find({}, { projection: { _id: 0, title: 1, summary: 1, hash: 1 } })
            .sort({ scraped_at: -1 })
            .toArray();
        return rows
            .filter((row) => !postedSet.has(row.hash))
            .map((row) => ({ title: row.title, summary: row.summary || '' }));
    }

    async clearQueue() {
        await this.queue.deleteMany({});
    }

    async cleanupOldNews(days = 7) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);
        const result = await this.posted.deleteMany({ posted_at: { $lt: cutoff } });
        return result.deletedCount || 0;
    }

    close() {
        this.posted = null;
        this.queue = null;
    }
}

export default NewsDatabase;
