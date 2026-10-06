/**
 * Indian F&O (stock futures) transaction charges, per leg.
 * Rates are configurable because SEBI / exchanges / the Budget revise them;
 * verify against your broker's current contract note before relying on totals.
 *
 * Gold and ETH do not trade on the NSE — they settle on Delta Exchange, which
 * charges a flat percentage of notional per side instead. `roundTripFees`
 * dispatches between the two venues on the symbol.
 */

import { round2 } from './risk.js';

/**
 * Symbols cleared on Delta Exchange rather than the NSE. Mapped to the
 * contract family whose published commission rate applies.
 * @type {Map<string, 'gold'|'eth'>}
 */
const DELTA_CONTRACTS = new Map([
    ['XAUUSD', 'gold'],
    ['GOLD', 'gold'],
    ['ETHUSD', 'eth'],
    ['ETH', 'eth'],
]);

/** True when this symbol is a Delta Exchange gold/ETH contract. */
export function isDeltaSpot(symbol) {
    return DELTA_CONTRACTS.has(String(symbol ?? '').toUpperCase());
}

/**
 * One Delta leg: fee is a percentage of notional (price x quantity), and 18%
 * GST is charged on top of the fee itself.
 */
function deltaLeg({ price, quantity }, ratePct, gstPct) {
    const fee = (price * quantity * ratePct) / 100;
    return fee + (fee * gstPct) / 100;
}

/** The configured Delta rate (maker or taker) for a contract family. */
function deltaRatePct(cfg, family) {
    const taker = family === 'gold' ? cfg.DELTA_FEE_GOLD_TAKER_PCT : cfg.DELTA_FEE_ETH_TAKER_PCT;
    if (cfg.DELTA_FEE_SIDE !== 'maker') return taker;
    return family === 'gold' ? cfg.DELTA_FEE_GOLD_MAKER_PCT : cfg.DELTA_FEE_ETH_MAKER_PCT;
}

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

/**
 * Total charges for entry + exit of one position.
 *
 * Pass `symbol` so gold/ETH are priced on Delta's schedule and everything else
 * stays on the NSE F&O schedule. Returns quote currency: INR for NSE, USD for
 * Delta (callers multiply by INR_USD_RATE when the venue settles in INR).
 */
export function roundTripFees({ direction, entryPrice, exitPrice, quantity, symbol }, cfg) {
    if (isDeltaSpot(symbol)) {
        const family = DELTA_CONTRACTS.get(String(symbol).toUpperCase());
        const ratePct = deltaRatePct(cfg, family);
        return round2(
            deltaLeg({ price: entryPrice, quantity }, ratePct, cfg.FEE_GST_PCT)
                + deltaLeg({ price: exitPrice, quantity }, ratePct, cfg.FEE_GST_PCT),
        );
    }
    const entrySide = direction === 'LONG' ? 'BUY' : 'SELL';
    const exitSide = direction === 'LONG' ? 'SELL' : 'BUY';
    const a = legCharges({ side: entrySide, price: entryPrice, quantity }, cfg);
    const b = legCharges({ side: exitSide, price: exitPrice, quantity }, cfg);
    return round2(a.total + b.total);
}
