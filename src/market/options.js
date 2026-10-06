/**
 * Options premium feed for the paper engine.
 *
 * NSE CE/PE option premiums do not exist on Yahoo as 1-minute bars, so this
 * service polls the live NSE option chain and synthesises a single 1-minute
 * "bar" at the last traded premium. The position monitor consumes the
 * synthetic bar unchanged — stops, targets and trailing then work on premium
 * exactly like any other instrument.
 */

import { nseOptionChainService } from '../../vendor/wa-bot/src/services/NseOptionChainService.js';

export const OPTION_PREFIX = 'OPT-';

/** `OPT-<SYM>-<STRIKE>-<CE|PE>` -> parsed, or null when not an option symbol. */
export function parseOptionSymbol(symbol) {
    const s = String(symbol || '');
    if (!s.startsWith(OPTION_PREFIX)) return null;
    const parts = s.slice(OPTION_PREFIX.length).split('-');
    const type = parts.pop();
    const strike = Number(parts.pop());
    const underlying = parts.join('-');
    if (!underlying || !Number.isFinite(strike) || !(type === 'CE' || type === 'PE')) return null;
    return { underlying, strike, type };
}

export function underlyingOf(symbol) {
    const p = parseOptionSymbol(symbol);
    return p ? p.underlying : symbol;
}

export function optionSymbol(underlying, strike, type) {
    return `${OPTION_PREFIX}${underlying}-${strike}-${type}`;
}

/** Margin/1-lot convention: long 1 CE/PE premium at market (paper). */
export class OptionsFeed {
    constructor({ logger = null, now = Date.now, maxAgeMs = 60_000 } = {}) {
        this.logger = logger;
        this.now = now;
        this.maxAgeMs = maxAgeMs;
    }

    /** ATM CE/PE entry quote for an underlying, or null when the chain fails. */
    async entryQuote(underlying, direction) {
        const ctx = await nseOptionChainService.fetchOptionContext(underlying, { maxAgeMs: this.maxAgeMs }).catch(() => null);
        const snap = ctx?.snapshot;
        if (!snap) return null;
        const leg = direction === 'LONG' ? snap.atmCe : snap.atmPe;
        const premium = leg?.ltp;
        if (!(premium > 0) || !(snap.atmStrike > 0)) return null;
        return {
            underlying,
            type: direction === 'LONG' ? 'CE' : 'PE',
            strike: snap.atmStrike,
            premium,
            spot: snap.spot,
            symbol: optionSymbol(underlying, snap.atmStrike, direction === 'LONG' ? 'CE' : 'PE'),
        };
    }

    /**
     * Synthesise one 1m premium bar for an option position, or null when the
     * chain is unavailable (position untouched this pass, retried next poll).
     */
    async premiumBar(symbol) {
        const p = parseOptionSymbol(symbol);
        if (!p) return null;
        const ctx = await nseOptionChainService.fetchOptionContext(p.underlying, { maxAgeMs: this.maxAgeMs }).catch(() => null);
        const snap = ctx?.snapshot;
        if (!snap) return null;
        const leg = (snap.strikes || []).find((s) => Number(s.strike) === Number(p.strike));
        const premium = (p.type === 'CE' ? leg?.ce : leg?.pe)?.ltp;
        if (!(premium > 0)) return null;
        const ts = Math.floor(this.now() / 60_000) * 60_000;
        return { ts, open: premium, high: premium, low: premium, close: premium, volume: 0 };
    }
}
