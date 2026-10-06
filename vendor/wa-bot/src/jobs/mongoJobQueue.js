/**
 * Mongo outbox job queue — claimable pending→running jobs with retry/backoff.
 */

import { ObjectId } from 'mongodb';
import { logger } from '../utils/logger.js';

const RETRY_BASE_MS = 5_000;

export class MongoJobQueue {
    /** @param {import('mongodb').Db} db */
    constructor(db) {
        this.kind = 'mongo';
        this.col = db.collection('bot_jobs');
    }

    async init() {
        await Promise.all([
            this.col.createIndex({ status: 1, runAt: 1 }, { name: 'bot_jobs_status_runAt' }),
            this.col.createIndex(
                { jobKey: 1 },
                { unique: true, partialFilterExpression: { jobKey: { $type: 'string' } }, name: 'bot_jobs_jobKey' }
            ),
        ]);
    }

    /**
     * @param {string} type
     * @param {object} [payload]
     * @param {{ delayMs?: number, maxAttempts?: number, jobKey?: string }} [opts]
     */
    async enqueue(type, payload = {}, opts = {}) {
        const delayMs = Math.max(0, Number(opts.delayMs) || 0);
        const maxAttempts = Math.max(1, Number(opts.maxAttempts) || 3);
        const jobKey = opts.jobKey ? String(opts.jobKey) : null;

        if (jobKey) {
            const existing = await this.col.findOne({
                jobKey,
                status: { $in: ['pending', 'running'] },
            });
            if (existing) return String(existing._id);
        }

        const doc = {
            type: String(type),
            payload: payload && typeof payload === 'object' ? payload : {},
            status: 'pending',
            attempts: 0,
            maxAttempts,
            runAt: new Date(Date.now() + delayMs),
            createdAt: new Date(),
            lockedAt: null,
            completedAt: null,
            error: null,
            ...(jobKey ? { jobKey } : {}),
        };

        try {
            const r = await this.col.insertOne(doc);
            return String(r.insertedId);
        } catch (err) {
            // Unique jobKey race — treat as already queued
            if (jobKey && err?.code === 11000) {
                const existing = await this.col.findOne({ jobKey });
                if (existing) return String(existing._id);
            }
            throw err;
        }
    }

    async claim() {
        const now = new Date();
        const doc = await this.col.findOneAndUpdate(
            { status: 'pending', runAt: { $lte: now } },
            { $set: { status: 'running', lockedAt: now }, $inc: { attempts: 1 } },
            { sort: { runAt: 1 }, returnDocument: 'after' }
        );
        return doc || null;
    }

    async complete(id) {
        await this.col.updateOne(
            { _id: new ObjectId(String(id)) },
            {
                $set: {
                    status: 'completed',
                    completedAt: new Date(),
                    error: null,
                },
            }
        );
    }

    async fail(id, error, { attempts, maxAttempts } = {}) {
        const msg = String(error?.message || error || 'failed').slice(0, 500);
        const n = Number(attempts) || 1;
        const max = Number(maxAttempts) || 3;
        if (n < max) {
            const delay = RETRY_BASE_MS * 2 ** Math.max(0, n - 1);
            await this.col.updateOne(
                { _id: new ObjectId(String(id)) },
                {
                    $set: {
                        status: 'pending',
                        runAt: new Date(Date.now() + delay),
                        lockedAt: null,
                        error: msg,
                    },
                }
            );
            logger.warn(`Job ${id} retry ${n}/${max} in ${Math.round(delay / 1000)}s: ${msg}`);
            return;
        }
        await this.col.updateOne(
            { _id: new ObjectId(String(id)) },
            {
                $set: {
                    status: 'failed',
                    completedAt: new Date(),
                    lockedAt: null,
                    error: msg,
                },
            }
        );
        logger.error(`Job ${id} failed permanently: ${msg}`);
    }

    async stats() {
        const [pending, running, failed] = await Promise.all([
            this.col.countDocuments({ status: 'pending' }),
            this.col.countDocuments({ status: 'running' }),
            this.col.countDocuments({ status: 'failed' }),
        ]);
        return { pending, running, failed, driver: 'mongo' };
    }
}

export default MongoJobQueue;
