/**
 * Execution adapters.
 *
 * The engine talks to an ExecutionAdapter so a broker adapter could be added
 * later behind the same interface. THIS BUILD SHIPS ONLY THE PAPER ADAPTER:
 * no broker SDK is installed, no order endpoint exists in the code, and the
 * factory throws for anything that is not paper.
 *
 * Fill model (bar-level, 1-minute bars, mirrors the original WA-BOT grader):
 *  - STOP entry: fills when a bar trades through the trigger. If the bar opened
 *    beyond the trigger (gap / already through), the fill is the bar open.
 *  - MARKET entry: next bar open.
 *  - STOP exit: fills at the stop, or at the open if the bar gapped through it.
 *  - TARGET exit (limit): fills at the target, or at the better open on a gap.
 *  - Slippage of SLIPPAGE_BPS is charged on stop and market fills, not limits.
 */

import { LONG } from './risk.js';

export class ExecutionAdapter {
    constructor() {
        if (new.target === ExecutionAdapter) throw new Error('ExecutionAdapter is abstract');
    }
    /** @returns {'PAPER'} */
    get mode() {
        throw new Error('not implemented');
    }
}

export class PaperExecutionAdapter extends ExecutionAdapter {
    constructor(cfg) {
        super();
        this.slip = (cfg.SLIPPAGE_BPS || 0) / 10_000;
        Object.freeze(this);
    }

    get mode() {
        return 'PAPER';
    }

    _slipped(price, side) {
        const p = side === 'BUY' ? price * (1 + this.slip) : price * (1 - this.slip);
        return Math.round(p * 100) / 100;
    }

    /** @returns {{ price: number, basePrice: number, gapped: boolean }|null} */
    stopEntry({ direction, trigger, bar }) {
        if (direction === LONG) {
            if (!(bar.high >= trigger)) return null;
            const base = Math.max(trigger, bar.open);
            return { price: this._slipped(base, 'BUY'), basePrice: base, gapped: bar.open > trigger };
        }
        if (!(bar.low <= trigger)) return null;
        const base = Math.min(trigger, bar.open);
        return { price: this._slipped(base, 'SELL'), basePrice: base, gapped: bar.open < trigger };
    }

    marketEntry({ direction, bar }) {
        return { price: this._slipped(bar.open, direction === LONG ? 'BUY' : 'SELL'), basePrice: bar.open, gapped: false };
    }

    /** Protective stop (initial or trailing). */
    stopExit({ direction, stop, bar }) {
        if (direction === LONG) {
            if (!(bar.low <= stop)) return null;
            const base = Math.min(stop, bar.open);
            return { price: this._slipped(base, 'SELL'), basePrice: base, gapped: bar.open < stop };
        }
        if (!(bar.high >= stop)) return null;
        const base = Math.max(stop, bar.open);
        return { price: this._slipped(base, 'BUY'), basePrice: base, gapped: bar.open > stop };
    }

    /** Resting limit at the target. */
    targetExit({ direction, target, bar }) {
        if (direction === LONG) {
            if (!(bar.high >= target)) return null;
            return { price: Math.max(target, bar.open), basePrice: target, gapped: bar.open > target };
        }
        if (!(bar.low <= target)) return null;
        return { price: Math.min(target, bar.open), basePrice: target, gapped: bar.open < target };
    }

    marketExit({ direction, price }) {
        return { price: this._slipped(price, direction === LONG ? 'SELL' : 'BUY'), basePrice: price, gapped: false };
    }
}

/**
 * The only way the engine obtains an adapter.
 * @param {object} cfg
 * @param {string} [mode]
 */
export function createExecutionAdapter(cfg, mode = 'PAPER') {
    if (cfg.LIVE_TRADING_ENABLED !== false || cfg.PAPER_TRADING !== true) {
        throw new Error('Refusing to create an execution adapter: live trading is disabled in this build.');
    }
    if (mode !== 'PAPER') {
        throw new Error(`Execution mode "${mode}" is not available. Only PAPER is implemented.`);
    }
    return new PaperExecutionAdapter(cfg);
}
