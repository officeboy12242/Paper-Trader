/**
 * Job queue factory — Mongo outbox by default; BullMQ when REDIS_URL is set.
 */

import { config } from '../config/config.js';
import { MongoJobQueue } from './mongoJobQueue.js';
import { startMongoJobWorker } from './mongoJobWorker.js';
import { logger } from '../utils/logger.js';

/**
 * @param {import('mongodb').Db} db
 */
export async function createJobQueue(db) {
    if (config.REDIS_URL) {
        const { BullJobQueue } = await import('./bullJobQueue.js');
        const queue = new BullJobQueue(config.REDIS_URL);
        await queue.init();
        return queue;
    }
    const queue = new MongoJobQueue(db);
    await queue.init();
    logger.info('🧰 Using Mongo job outbox (set REDIS_URL for BullMQ)');
    return queue;
}

/**
 * @param {object} opts
 * @param {import('./mongoJobQueue.js').MongoJobQueue|import('./bullJobQueue.js').BullJobQueue} opts.queue
 * @param {Record<string, Function>} opts.handlers
 * @param {number} [opts.concurrency]
 */
export function startJobRuntime({ queue, handlers, concurrency = 2 }) {
    if (queue.kind === 'bull' && typeof queue.startWorkers === 'function') {
        return queue.startWorkers(handlers, concurrency);
    }
    return startMongoJobWorker({ queue, handlers, concurrency });
}

export { MongoJobQueue, startMongoJobWorker };
