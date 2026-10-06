/**
 * BullMQ job queue — same enqueue(type, payload) surface as MongoJobQueue.
 * Used when REDIS_URL is set.
 */

import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { logger } from '../utils/logger.js';

export class BullJobQueue {
    /**
     * @param {string} redisUrl
     */
    constructor(redisUrl) {
        this.kind = 'bull';
        this.redisUrl = redisUrl;
        this.connection = new IORedis(redisUrl, {
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
        });
        /** @type {Map<string, Queue>} */
        this.queues = new Map();
        /** @type {Worker[]} */
        this.workers = [];
    }

    async init() {
        // Connection opens lazily; ping once for early failure.
        await this.connection.ping();
        logger.info('🧰 BullMQ job queue connected (Redis)');
    }

    _queue(type) {
        const name = String(type);
        if (!this.queues.has(name)) {
            this.queues.set(name, new Queue(name, { connection: this.connection }));
        }
        return this.queues.get(name);
    }

    /**
     * @param {string} type
     * @param {object} [payload]
     * @param {{ delayMs?: number, maxAttempts?: number, jobKey?: string }} [opts]
     */
    async enqueue(type, payload = {}, opts = {}) {
        const q = this._queue(type);
        const job = await q.add(
            String(type),
            payload && typeof payload === 'object' ? payload : {},
            {
                jobId: opts.jobKey ? String(opts.jobKey) : undefined,
                delay: Math.max(0, Number(opts.delayMs) || 0),
                attempts: Math.max(1, Number(opts.maxAttempts) || 3),
                backoff: { type: 'exponential', delay: 5000 },
                removeOnComplete: 100,
                removeOnFail: 50,
            }
        );
        return String(job.id);
    }

    /**
     * @param {Record<string, (payload: object, job: object) => Promise<void>>} handlers
     * @param {number} [concurrency]
     */
    startWorkers(handlers, concurrency = 2) {
        for (const [type, handler] of Object.entries(handlers)) {
            const worker = new Worker(
                type,
                async (job) => {
                    await handler(job.data || {}, {
                        type,
                        attempts: job.attemptsMade + 1,
                        maxAttempts: job.opts?.attempts || 3,
                        _id: job.id,
                        payload: job.data,
                    });
                },
                {
                    connection: this.connection.duplicate(),
                    concurrency: Math.max(1, concurrency),
                }
            );
            worker.on('failed', (job, err) => {
                logger.warn(`Bull job ${type}/${job?.id} failed: ${err.message}`);
            });
            this.workers.push(worker);
        }
        logger.info(
            `🧰 BullMQ workers started for ${Object.keys(handlers).join(', ')} (concurrency ${concurrency})`
        );
        return {
            stop: async () => {
                await Promise.all(this.workers.map((w) => w.close()));
                this.workers = [];
            },
        };
    }

    async stats() {
        let pending = 0;
        let running = 0;
        let failed = 0;
        for (const q of this.queues.values()) {
            const counts = await q.getJobCounts('wait', 'delayed', 'active', 'failed');
            pending += (counts.wait || 0) + (counts.delayed || 0);
            running += counts.active || 0;
            failed += counts.failed || 0;
        }
        // Also scan known handler queue names if none enqueued yet from this process
        return { pending, running, failed, driver: 'bullmq' };
    }

    async close() {
        await Promise.all([...this.queues.values()].map((q) => q.close()));
        this.queues.clear();
        await this.connection.quit().catch(() => {});
    }
}

export default BullJobQueue;
