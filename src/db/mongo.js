/**
 * MongoDB mirror for future AI/RAG work.
 *
 * SQLite stays the engine's source of truth (synchronous, crash-safe). This
 * store asynchronously mirrors every signal and closed trade into MongoDB so
 * a future model/RAG pipeline can query the full decision history — setups,
 * feature bars, outcomes — without touching the live database.
 *
 * Design rules:
 *  - Optional: with no MONGODB_URI everything is a no-op.
 *  - Never blocks trading: buffered queue, background flush, all errors
 *    swallowed into the process log. A Mongo outage must not stop the engine.
 *  - The URI never leaves this module (never logged, never in publicConfig).
 */

import { MongoClient } from 'mongodb';

const FLUSH_MS = 5_000;
const MAX_BATCH = 500;

const dirWord = (d) => (d === 'LONG' ? 'BUY' : d === 'SHORT' ? 'SELL' : d || '?');

/** Human-readable summary of one signal — the future embedding input. */
export function signalText(s) {
    const setup = s.setup
        ? `${dirWord(s.direction)} ${s.symbol} @ ${s.setup.entry} SL ${s.setup.stop} T1 ${s.setup.target ?? '?'} score ${s.setup.score ?? '?'} (${Object.keys(s.setup.checks || {}).join(', ') || 'no checks'})`
        : `${s.symbol} watch: ${s.reason || 'no setup'}`;
    return `[${s.strategyCode} ${s.source}] ${setup} status=${s.status}${s.confluence != null ? ` confluence=${s.confluence}` : ''}`;
}

/** Human-readable summary of one closed trade — the future embedding input. */
export function tradeText(t) {
    const win = t.netPnl > 0 ? 'WIN' : t.netPnl < 0 ? 'LOSS' : 'FLAT';
    return `[${t.strategyCode} ${t.source}] ${dirWord(t.direction)} ${t.symbol} entry ${t.entry} exit ${t.exitPrice} ${win} ${t.netPnl >= 0 ? '+' : ''}${t.netPnl} (R ${t.rMultiple ?? '?'}) via ${t.exitReason} held ${t.holdingSeconds ?? '?'}s`;
}

export class MongoStore {
    constructor({ uri = null, dbName = 'papertrader', logger = null } = {}) {
        this.uri = uri && String(uri).trim() ? String(uri).trim() : null;
        this.dbName = dbName;
        this.logger = logger;
        this.client = null;
        this.db = null;
        this.queue = [];
        this.timer = null;
        this.connected = false;
    }

    get enabled() {
        return Boolean(this.uri);
    }

    async connect() {
        if (!this.enabled || this.connected) return;
        try {
            this.client = new MongoClient(this.uri, { serverSelectionTimeoutMS: 10_000 });
            await this.client.connect();
            this.db = this.client.db(this.dbName);
            await Promise.all([
                this.db.collection('signals').createIndex({ strategyCode: 1, ts: -1 }),
                this.db.collection('signals').createIndex({ symbol: 1, ts: -1 }),
                this.db.collection('trades').createIndex({ strategyCode: 1, exitTime: -1 }),
                this.db.collection('trades').createIndex({ symbol: 1, exitTime: -1 }),
                this.db.collection('trades').createIndex({ win: 1 }),
            ]);
            this.connected = true;
            this.logger?.info('MONGO', 'CONNECTED', `mirroring to ${this.dbName}`);
            this.timer = setInterval(() => this.flush().catch(() => {}), FLUSH_MS);
            this.timer.unref?.();
            await this.flush();
        } catch (err) {
            this.logger?.warn('MONGO', 'CONNECT FAILED', String(err?.message || err));
        }
    }

    /** Queue a document for the named collection. Never throws. */
    push(collection, doc) {
        if (!this.enabled) return;
        try {
            this.queue.push({ collection, doc: { ...doc, _mirroredAt: new Date() } });
            if (this.queue.length >= MAX_BATCH) this.flush().catch(() => {});
        } catch {
            /* mirroring must never break trading */
        }
    }

    /** Upsert the latest full state snapshot (always one doc per db, tagged
     * `kind:'latest'`). Called by the engine periodically. Returns true on
     * success, never throws. */
    async upsertSnapshot(doc) {
        if (!this.enabled) return false;
        try {
            if (!this.connected) await this.connect();
            if (!this.connected) return false;
            await this.db
                .collection('snapshot')
                .replaceOne({ kind: 'latest' }, { kind: 'latest', ...doc, updatedAt: new Date() }, { upsert: true });
            return true;
        } catch (err) {
            this.logger?.warn('MONGO', 'SNAPSHOT FAILED', String(err?.message || err));
            return false;
        }
    }

    /** Fetch the latest state snapshot, or null. Tolerant of no collection. */
    async latestSnapshot() {
        if (!this.enabled) return null;
        try {
            if (!this.connected) await this.connect();
            if (!this.connected) return null;
            const doc = await this.db.collection('snapshot').findOne({ kind: 'latest' });
            return doc || null;
        } catch {
            return null;
        }
    }

    async flush() {
        if (!this.enabled || !this.queue.length) return;
        if (!this.connected) {
            await this.connect();
            if (!this.connected) return;
        }
        const batch = this.queue.splice(0, MAX_BATCH);
        const byCol = new Map();
        for (const { collection, doc } of batch) {
            if (!byCol.has(collection)) byCol.set(collection, []);
            byCol.get(collection).push(doc);
        }
        for (const [collection, docs] of byCol) {
            try {
                await this.db.collection(collection).insertMany(docs, { ordered: false });
            } catch (err) {
                this.logger?.warn('MONGO', 'WRITE FAILED', `${collection}: ${String(err?.message || err)}`);
            }
        }
    }

    async close() {
        clearInterval(this.timer);
        try {
            await this.flush();
        } catch {
            /* ignore */
        }
        await this.client?.close().catch(() => {});
        this.connected = false;
    }
}
