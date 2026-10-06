/**
 * Shared throttle in front of the LLM providers.
 *
 * Without this, three `/tradenow` commands fired back-to-back all pick provider[0]
 * (nothing is marked cooled until the *first* one fails), stampede it into a 429,
 * then stampede the next provider together, and so on down the chain — every
 * command fails. The gate gives each provider a per-minute token bucket plus a
 * concurrency cap, so bursts spread across providers or briefly queue instead.
 */

import { logger } from '../utils/logger.js';

const WINDOW_MS = 60_000;

/** Conservative free-tier requests/minute. Override with TRADE_LLM_RPM. */
export const DEFAULT_PROVIDER_RPM = {
    gemini: 8,
    groq: 25,
    nvidia: 35,
    openrouter: 15,
};

/** Parse "gemini:8,groq:25" into { gemini: 8, groq: 25 }. */
export function parseRpmMap(raw, defaults = DEFAULT_PROVIDER_RPM) {
    const out = { ...defaults };
    for (const part of String(raw || '').split(',')) {
        const [name, value] = part.split(':').map((s) => s?.trim().toLowerCase());
        const n = Number(value);
        if (name && Number.isFinite(n) && n > 0) out[name] = n;
    }
    return out;
}

export default class LlmRateGate {
    /**
     * @param {{ rpm?: Record<string, number>, defaultRpm?: number,
     *           perProvider?: number, maxConcurrent?: number, keyMultiplier?: Record<string, number> }} [opts]
     */
    constructor({ rpm = DEFAULT_PROVIDER_RPM, defaultRpm = 12, perProvider = 2, maxConcurrent = 3 } = {}) {
        this.rpm = { ...rpm };
        this.defaultRpm = Math.max(1, defaultRpm);
        this.perProvider = Math.max(1, perProvider);
        this.maxConcurrent = Math.max(1, maxConcurrent);
        /** @type {Map<string, number[]>} provider → recent call timestamps */
        this._calls = new Map();
        /** @type {Map<string, number>} provider → in-flight count */
        this._inflight = new Map();
        /** @type {Array<() => void>} woken when a slot frees */
        this._waiters = [];
    }

    /** Extra keys for a provider multiply its effective per-minute budget. */
    setKeyCount(name, count) {
        const n = Math.max(1, Number(count) || 1);
        if (n > 1) this.rpm[name] = this.limitFor(name) * n;
    }

    limitFor(name) {
        const n = Number(this.rpm[name]);
        return Number.isFinite(n) && n > 0 ? n : this.defaultRpm;
    }

    _recent(name) {
        const cut = Date.now() - WINDOW_MS;
        const arr = (this._calls.get(name) || []).filter((t) => t > cut);
        this._calls.set(name, arr);
        return arr;
    }

    inflight(name) {
        return this._inflight.get(name) || 0;
    }

    totalInflight() {
        let n = 0;
        for (const v of this._inflight.values()) n += v;
        return n;
    }

    /** ms until this provider could accept a call; 0 means right now. */
    waitMs(name) {
        let wait = 0;
        const recent = this._recent(name);
        const limit = this.limitFor(name);
        if (recent.length >= limit) {
            wait = Math.max(wait, recent[recent.length - limit] + WINDOW_MS - Date.now());
        }
        if (this.inflight(name) >= this.perProvider || this.totalInflight() >= this.maxConcurrent) {
            // Freed by a release rather than the clock — poll shortly.
            wait = Math.max(wait, 300);
        }
        return Math.max(0, wait);
    }

    canServe(name) {
        return this.waitMs(name) === 0;
    }

    /**
     * Atomically reserve a slot only if capacity exists right now.
     * Must stay synchronous — an await between the check and the reserve would
     * let concurrent callers all pass the check and stampede the provider.
     * @returns {(() => void)|null} release fn, or null when at capacity
     */
    tryTake(name) {
        if (!this.canServe(name)) return null;
        return this.take(name);
    }

    /**
     * Reserve a request slot. The returned release() MUST be called (use finally).
     * @returns {() => void}
     */
    take(name) {
        this._recent(name).push(Date.now());
        this._inflight.set(name, this.inflight(name) + 1);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this._inflight.set(name, Math.max(0, this.inflight(name) - 1));
            const waiters = this._waiters.splice(0);
            for (const wake of waiters) wake();
        };
    }

    /**
     * Wait until one of `names` has capacity.
     * @returns {Promise<string|null>} the ready provider, or null on timeout.
     */
    async waitForAny(names, maxWaitMs = 45_000) {
        if (!names.length) return null;
        const deadline = Date.now() + Math.max(0, maxWaitMs);
        for (;;) {
            const ready = names.find((n) => this.canServe(n));
            if (ready) return ready;

            const remaining = deadline - Date.now();
            if (remaining <= 0) return null;

            const soonest = Math.min(...names.map((n) => this.waitMs(n)));
            const sleep = Math.max(150, Math.min(soonest, remaining, 2000));
            await new Promise((resolve) => {
                let wake;
                const timer = setTimeout(() => {
                    this._waiters = this._waiters.filter((w) => w !== wake);
                    resolve();
                }, sleep);
                wake = () => {
                    clearTimeout(timer);
                    resolve();
                };
                this._waiters.push(wake);
            });
        }
    }

    /** Debug snapshot for status commands. */
    snapshot(names) {
        return names.map((n) => ({
            name: n,
            used: this._recent(n).length,
            limit: this.limitFor(n),
            inflight: this.inflight(n),
            readyInMs: this.waitMs(n),
        }));
    }
}
