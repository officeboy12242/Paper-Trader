/**
 * In-process Mongo job worker — polls claimable jobs and runs registered handlers.
 */

import { logger } from '../utils/logger.js';

/**
 * @param {object} opts
 * @param {import('./mongoJobQueue.js').MongoJobQueue} opts.queue
 * @param {Record<string, (payload: object, job: object) => Promise<void>>} opts.handlers
 * @param {number} [opts.concurrency]
 * @param {number} [opts.pollMs]
 */
export function startMongoJobWorker({ queue, handlers, concurrency = 2, pollMs = 2000 }) {
    let stopped = false;
    let active = 0;
    /** @type {ReturnType<typeof setInterval>|null} */
    let timer = null;

    const tick = async () => {
        if (stopped) return;
        while (!stopped && active < concurrency) {
            let job;
            try {
                job = await queue.claim();
            } catch (err) {
                logger.warn(`Job claim failed: ${err.message}`);
                break;
            }
            if (!job) break;

            active += 1;
            const id = String(job._id);
            const type = String(job.type || '');
            const handler = handlers[type];
            void (async () => {
                try {
                    if (!handler) throw new Error(`No handler for job type: ${type}`);
                    await handler(job.payload || {}, job);
                    await queue.complete(id);
                } catch (err) {
                    await queue.fail(id, err, {
                        attempts: job.attempts,
                        maxAttempts: job.maxAttempts,
                    });
                } finally {
                    active -= 1;
                }
            })();
        }
    };

    timer = setInterval(() => {
        void tick();
    }, Math.max(500, pollMs));
    void tick();
    logger.info(`🧰 Mongo job worker started (concurrency ${concurrency})`);

    return {
        stop() {
            stopped = true;
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
        },
        get active() {
            return active;
        },
    };
}

export default startMongoJobWorker;
