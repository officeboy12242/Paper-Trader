/**
 * Crash-safe checkpoints for long sticker-pack imports.
 *
 * A pack import can take minutes and is interrupted for boring reasons — the
 * WhatsApp socket wedges, the process restarts, someone sends /tgstop. Without
 * a checkpoint, re-running the command redoes every download, every Lottie
 * render and every upload from scratch.
 *
 * This records which sticker indices of a pack have actually been delivered to
 * a chat, so a re-run picks up where the last one stopped.
 *
 * Deliberately a plain JSON file rather than a Mongo collection: it needs no
 * schema plumbing, works before the DB connects, and the data is short-lived
 * by nature. It lives outside the sticker temp dir, which the service sweeps.
 */

import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // forget stale checkpoints
const MAX_ENTRIES = 200;                        // bound the file

export class ImportProgressStore {
    /**
     * @param {string} filePath  Where to persist. Parent dirs are created.
     * @param {{ ttlMs?: number }} [opts]
     */
    constructor(filePath, { ttlMs = DEFAULT_TTL_MS } = {}) {
        this.filePath = filePath;
        this.ttlMs = ttlMs;
        this.data = null;      // lazily loaded { [key]: { done: number[], updatedAt } }
        this._writeTimer = null;
        this._dirty = false;
    }

    static key(chatId, packName) {
        return `${chatId}::${String(packName).toLowerCase()}`;
    }

    _load() {
        if (this.data) return this.data;
        try {
            const raw = fs.readFileSync(this.filePath, 'utf-8');
            const parsed = JSON.parse(raw);
            this.data = (parsed && typeof parsed === 'object') ? parsed : {};
        } catch {
            this.data = {};   // missing or corrupt — start clean, never throw
        }
        this._prune();
        return this.data;
    }

    _prune() {
        const cutoff = Date.now() - this.ttlMs;
        const entries = Object.entries(this.data);
        for (const [k, v] of entries) {
            if (!v || typeof v.updatedAt !== 'number' || v.updatedAt < cutoff) {
                delete this.data[k];
            }
        }
        // Keep the newest MAX_ENTRIES if it somehow grows.
        const keys = Object.keys(this.data);
        if (keys.length > MAX_ENTRIES) {
            keys.sort((a, b) => this.data[b].updatedAt - this.data[a].updatedAt)
                .slice(MAX_ENTRIES)
                .forEach((k) => delete this.data[k]);
        }
    }

    /** Indices already delivered for this chat+pack. */
    getDone(chatId, packName) {
        const entry = this._load()[ImportProgressStore.key(chatId, packName)];
        return new Set(Array.isArray(entry?.done) ? entry.done : []);
    }

    /** Record one delivered sticker. Writes are debounced. */
    markDone(chatId, packName, index) {
        const data = this._load();
        const key = ImportProgressStore.key(chatId, packName);
        const entry = data[key] || (data[key] = { done: [], updatedAt: 0 });
        if (!entry.done.includes(index)) entry.done.push(index);
        entry.updatedAt = Date.now();
        this._scheduleWrite();
    }

    /** Drop the checkpoint — call once a pack finishes cleanly. */
    clear(chatId, packName) {
        const data = this._load();
        delete data[ImportProgressStore.key(chatId, packName)];
        this._scheduleWrite();
    }

    /**
     * Debounced so a 40-sticker pack doesn't rewrite the file 40 times, but
     * short enough that a crash loses at most a sticker or two of progress.
     */
    _scheduleWrite(delayMs = 400) {
        this._dirty = true;
        if (this._writeTimer) return;
        this._writeTimer = setTimeout(() => {
            this._writeTimer = null;
            this.flush();
        }, delayMs);
        this._writeTimer.unref?.();   // never hold the process open
    }

    /** Write immediately. Atomic: temp file + rename, so a crash can't corrupt it. */
    flush() {
        if (!this._dirty || !this.data) return;
        this._dirty = false;
        try {
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            const tmp = `${this.filePath}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(this.data));
            fs.renameSync(tmp, this.filePath);
        } catch (err) {
            logger.warn(`Import progress write failed: ${err?.message || err}`);
        }
    }
}

export default ImportProgressStore;
