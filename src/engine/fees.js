/**
 * Indian F&O (stock futures) transaction charges, per leg.
 * Rates are configurable because SEBI / exchanges / the Budget revise them;
 * verify against your broker's current contract note before relying on totals.
 */

import { round2 } from './risk.js';

/**
 * @param {{ side: 'BUY'|'SELL', price: number, quantity: number }} leg
 * @param {object} cfg
 */
export function legCharges({ side, price, quantity }, cfg) {
    const turnover = price * quantity;
    const brokerage = Math.min(cfg.FEE_BROKERAGE_FLAT, (turnover * cfg.FEE_BROKERAGE_PCT) / 100);
    const stt = side === 'SELL' ? (turnover * cfg.FEE_STT_SELL_PCT) / 100 : 0;
    const exchange = (turnover * cfg.FEE_EXCHANGE_PCT) / 100;
    const sebi = (turnover / 1e7) * cfg.FEE_SEBI_PER_CRORE;
    const stamp = side === 'BUY' ? (turnover * cfg.FEE_STAMP_BUY_PCT) / 100 : 0;
    const gst = ((brokerage + exchange + sebi) * cfg.FEE_GST_PCT) / 100;
    const total = brokerage + stt + exchange + sebi + stamp + gst;
    return { turnover, brokerage, stt, exchange, sebi, stamp, gst, total };
}

/** Total charges for entry + exit of one position. */
export function roundTripFees({ direction, entryPrice, exitPrice, quantity }, cfg) {
    const entrySide = direction === 'LONG' ? 'BUY' : 'SELL';
    const exitSide = direction === 'LONG' ? 'SELL' : 'BUY';
    const a = legCharges({ side: entrySide, price: entryPrice, quantity }, cfg);
    const b = legCharges({ side: exitSide, price: exitPrice, quantity }, cfg);
    return round2(a.total + b.total);
}
