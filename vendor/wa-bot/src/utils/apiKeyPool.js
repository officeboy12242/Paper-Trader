/**
 * Round-robin API key pool.
 *
 * Free tiers rate-limit per key, not per provider, so a second/third key for the
 * same provider multiplies headroom for burst commands like `/tradenow`.
 * Accepts `KEY` (single) or `KEYS` (comma/whitespace separated) env values.
 */

/** @param {...any} raw First non-empty source wins; each may hold several keys. */
export function parseKeyList(...raw) {
    const out = [];
    const seen = new Set();
    for (const value of raw) {
        if (!value) continue;
        for (const part of String(value).split(/[,\s]+/)) {
            const key = part.trim();
            if (!key || seen.has(key)) continue;
            seen.add(key);
            out.push(key);
        }
    }
    return out;
}

export class ApiKeyPool {
    /** @param {string[]} keys */
    constructor(keys = []) {
        this.keys = keys.filter(Boolean);
        this._idx = 0;
        /** @type {Map<string, number>} key → cooledUntil epoch ms */
        this._cooled = new Map();
    }

    get size() {
        return this.keys.length;
    }

    get primary() {
        return this.keys[0] || '';
    }

    /** Next key in rotation, preferring ones not cooled by a recent 429. */
    next() {
        if (!this.keys.length) return '';
        const now = Date.now();
        for (let i = 0; i < this.keys.length; i++) {
            const key = this.keys[this._idx++ % this.keys.length];
            if ((this._cooled.get(key) || 0) <= now) return key;
        }
        // Every key cooled — use the one that frees up soonest.
        return this.keys.reduce((best, k) =>
            (this._cooled.get(k) || 0) < (this._cooled.get(best) || 0) ? k : best
        );
    }

    /** Keys not currently cooled by a 429. */
    healthyCount() {
        const now = Date.now();
        return this.keys.filter((k) => (this._cooled.get(k) || 0) <= now).length;
    }

    markRateLimited(key, cooldownMs = 60_000) {
        if (!key) return;
        this._cooled.set(key, Date.now() + cooldownMs);
    }

    /** True when another key could still be tried for this request. */
    hasAlternative(key) {
        return this.keys.length > 1 && this.keys.some((k) => k !== key);
    }
}

/** Convenience: build a pool from a `KEYS` value falling back to a `KEY` value. */
export function buildKeyPool(...raw) {
    return new ApiKeyPool(parseKeyList(...raw));
}
