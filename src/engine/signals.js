/**
 * Signal validation. A signal that fails here never reaches the order book.
 */

import { LONG, SHORT } from './risk.js';

const SYMBOL_RE = /^[A-Z0-9&_-]{1,24}$/;

/**
 * @param {object} s
 * @param {string} s.symbol
 * @param {'LONG'|'SHORT'} s.direction
 * @param {'STOP_ENTRY'|'MARKET'} s.orderType
 * @param {number} [s.entry]   trigger for STOP_ENTRY
 * @param {number} [s.stop]
 * @param {number} [s.target]
 * @param {number} [s.referencePrice] last price for MARKET
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validateSignal(s) {
    if (!s || typeof s !== 'object') return { ok: false, reason: 'empty signal' };
    if (!SYMBOL_RE.test(String(s.symbol || ''))) return { ok: false, reason: `invalid symbol "${s.symbol}"` };
    if (s.direction !== LONG && s.direction !== SHORT) return { ok: false, reason: `invalid direction "${s.direction}"` };
    const d = s.direction === LONG ? 1 : -1;
    const pos = (v) => Number.isFinite(v) && v > 0;

    if (s.orderType === 'STOP_ENTRY') {
        if (!pos(s.entry)) return { ok: false, reason: `invalid entry ${s.entry}` };
        if (!pos(s.stop)) return { ok: false, reason: `invalid stop ${s.stop}` };
        if ((s.stop - s.entry) * d >= 0) return { ok: false, reason: `stop ${s.stop} is not on the loss side of entry ${s.entry}` };
        if (s.target != null) {
            if (!pos(s.target)) return { ok: false, reason: `invalid target ${s.target}` };
            if ((s.target - s.entry) * d <= 0) return { ok: false, reason: `target ${s.target} is not on the profit side of entry ${s.entry}` };
        }
        return { ok: true };
    }
    if (s.orderType === 'MARKET') {
        if (!pos(s.referencePrice)) return { ok: false, reason: 'missing price for market entry' };
        return { ok: true };
    }
    return { ok: false, reason: `invalid order type "${s.orderType}"` };
}
