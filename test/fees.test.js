import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roundTripFees, isDeltaSpot, legCharges } from '../src/engine/fees.js';
import { makeCfg, makeWorld, place, bar } from './helpers.js';

const cfg = makeCfg();

// Delta Exchange rates, as published by GET /v2/products (Oct 2026):
//   XAUTUSD (gold)  maker 0.01%  taker 0.01%
//   ETHUSD          maker 0.02%  taker 0.05%
// plus 18% GST on the fee, charged per side on notional.
const GST = 1.18;

test('gold and ETH route to Delta, NSE symbols keep the F&O schedule', () => {
    for (const s of ['XAUUSD', 'GOLD', 'ETHUSD', 'ETH', 'xauusd']) {
        assert.equal(isDeltaSpot(s), true, `${s} trades on Delta`);
    }
    for (const s of ['RELIANCE', 'SBIN', 'OPT-NSE-NIFTY-25000-CE', '', null, undefined]) {
        assert.equal(isDeltaSpot(s), false, `${s} does not trade on Delta`);
    }
});

test('gold pays Delta taker 0.01% per side plus GST', () => {
    const notional = (4180 + 4190) * 6;
    const expected = Math.round(notional * 0.0001 * GST * 100) / 100;
    assert.equal(
        roundTripFees({ direction: 'LONG', entryPrice: 4180, exitPrice: 4190, quantity: 6, symbol: 'XAUUSD' }, cfg),
        expected,
    );
});

test('ETH pays Delta taker 0.05% per side — five times gold', () => {
    const notional = (2688.81 + 2686.7) * 9;
    const expected = Math.round(notional * 0.0005 * GST * 100) / 100;
    const eth = roundTripFees({ direction: 'SHORT', entryPrice: 2688.81, exitPrice: 2686.7, quantity: 9, symbol: 'ETHUSD' }, cfg);
    const gold = roundTripFees({ direction: 'SHORT', entryPrice: 2688.81, exitPrice: 2686.7, quantity: 9, symbol: 'XAUUSD' }, cfg);
    assert.equal(eth, expected);
    assert.ok(eth > gold * 4, `ETH ${eth} should be ~5x gold ${gold}`);
});

test('DELTA_FEE_SIDE picks the published maker or taker rate', () => {
    const args = { direction: 'LONG', entryPrice: 3000, exitPrice: 3010, quantity: 10, symbol: 'ETHUSD' };
    const taker = roundTripFees(args, makeCfg({ DELTA_FEE_SIDE: 'taker' }));
    const maker = roundTripFees(args, makeCfg({ DELTA_FEE_SIDE: 'maker' }));
    const notional = (3000 + 3010) * 10;
    assert.equal(taker, Math.round(notional * 0.0005 * GST * 100) / 100);
    assert.equal(maker, Math.round(notional * 0.0002 * GST * 100) / 100);
    // Gold maker == taker on XAUTUSD, so the switch must be a no-op there.
    const goldArgs = { ...args, symbol: 'XAUUSD' };
    assert.equal(roundTripFees(goldArgs, makeCfg({ DELTA_FEE_SIDE: 'maker' })), roundTripFees(goldArgs, makeCfg({ DELTA_FEE_SIDE: 'taker' })));
});

test('NSE symbols are unaffected by the Delta rates', () => {
    const args = { direction: 'LONG', entryPrice: 1200, exitPrice: 1210, quantity: 500 };
    assert.equal(roundTripFees({ ...args, symbol: 'RELIANCE' }, cfg), roundTripFees(args, cfg), 'no symbol still means NSE');
    assert.ok(legCharges({ side: 'SELL', price: 1210, quantity: 500 }, cfg).stt > 0, 'STT only exists on the NSE path');
    assert.equal(isDeltaSpot('RELIANCE'), false);
});

test('gold is cheaper on Delta than the NSE F&O schedule would have been', () => {
    const args = { direction: 'LONG', entryPrice: 4000, exitPrice: 4050, quantity: 100 };
    const delta = roundTripFees({ ...args, symbol: 'XAUUSD' }, cfg);
    const nse = roundTripFees(args, cfg);
    assert.ok(delta < nse, `Delta ${delta} vs NSE ${nse} on the same notional`);
});

// ── end to end: a closed gold trade actually carries the Delta charge ───────

test('a closed gold trade is charged Delta fees and settled in INR', async () => {
    const w = makeWorld(
        { SLIPPAGE_BPS: 0, TRAILING_ENABLED: 'false' },
        { strategyById: () => ({ roundTheClock: true, key: 'gold_sweep' }) },
    );
    // Spot symbols bypass the fake feed inside getBars (they hit the real gold
    // API), so route the symbol straight back to the bars we set below.
    w.marketData.getBars = async () => (w.feed.bars.get('XAUUSD') || []).filter((b) => b.ts <= w.clock.t);

    place(w, { symbol: 'XAUUSD', direction: 'LONG', orderType: 'MARKET', referencePrice: 4000, entry: 4000, stop: 3985, target: 4050 });
    w.feed.set('XAUUSD', [
        bar('10:01', 4000, 4000.5, 3999.5, 4000), // fills, and trips the ₹2,000 lock to 4000.24
        bar('10:02', 4000.5, 4051, 4000.5, 4050), // target 4050 hit, low stays above the new stop
    ]);
    w.clock.set('10:03');
    await w.positions.monitor();

    const t = w.db.searchTrades({}).rows[0];
    assert.equal(t.exit_reason, 'TARGET');
    assert.equal(t.exit_price, 4050);
    assert.equal(t.profit_booked, 1, 'the ₹2,000 lock armed on the entry bar');

    // Delta: notional x 0.01% x 1.18, on entry and exit legs, then x INR rate.
    const notional = (4000 + 4050) * 100;
    const feesUsd = Math.round(notional * 0.0001 * GST * 100) / 100;
    const feesInr = Math.round(feesUsd * 84 * 100) / 100;
    assert.equal(t.fees, feesInr, 'Delta charges, converted at INR_USD_RATE');
    assert.equal(t.net_pnl, Math.round((t.gross_pnl - feesInr) * 100) / 100);

    const nseEquivalent = roundTripFees({ direction: 'LONG', entryPrice: 4000, exitPrice: 4050, quantity: 100 }, w.cfg);
    assert.ok(t.fees / 84 < nseEquivalent, 'the NSE schedule would have overcharged gold');
});
