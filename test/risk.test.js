import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCfg, makeWorld, place, bar } from './helpers.js';
import { finalizeLevels, activateTrailing, ratchetTrailing, hardStopFor } from '../src/engine/risk.js';
import { Database } from '../src/db/database.js';

const cfg = makeCfg({ SLIPPAGE_BPS: 0 });

test('5% hard stop for LONG is entry x 0.95', () => {
    assert.equal(hardStopFor('LONG', 1000, 5), 950);
    const lv = finalizeLevels({ direction: 'LONG', fill: 1000, quantity: 100, sourceStop: 900, sourceTarget: 1100 }, cfg);
    assert.equal(lv.stop, 950, 'looser source stop (10%) is capped at 5%');
    assert.equal(lv.stopBasis, 'HARD_5PCT');
});

test('5% hard stop for SHORT is entry x 1.05', () => {
    assert.equal(hardStopFor('SHORT', 1000, 5), 1050);
    const lv = finalizeLevels({ direction: 'SHORT', fill: 1000, quantity: 100, sourceStop: 1200, sourceTarget: 900 }, cfg);
    assert.equal(lv.stop, 1050);
});

test('tighter source stop wins over the 5% boundary', () => {
    const l = finalizeLevels({ direction: 'LONG', fill: 1000, quantity: 1, sourceStop: 985, sourceTarget: 1030 }, cfg);
    assert.equal(l.stop, 985);
    assert.equal(l.stopBasis, 'SOURCE');
    const s = finalizeLevels({ direction: 'SHORT', fill: 1000, quantity: 1, sourceStop: 1010, sourceTarget: 970 }, cfg);
    assert.equal(s.stop, 1010);
});

test('source stop on the wrong side of the fill is ignored in favour of the hard stop', () => {
    const l = finalizeLevels({ direction: 'LONG', fill: 1000, quantity: 1, sourceStop: 1005, sourceTarget: 1030 }, cfg);
    assert.equal(l.stop, 950);
});

test('minimum target of 10 points is enforced, source target kept when further', () => {
    const near = finalizeLevels({ direction: 'LONG', fill: 1000, quantity: 1, sourceStop: 990, sourceTarget: 1004 }, cfg);
    assert.equal(near.target, 1010);
    assert.equal(near.targetBasis, 'MIN_TARGET');
    const far = finalizeLevels({ direction: 'LONG', fill: 1000, quantity: 1, sourceStop: 990, sourceTarget: 1025 }, cfg);
    assert.equal(far.target, 1025);
    assert.equal(far.targetBasis, 'SOURCE');
    const sh = finalizeLevels({ direction: 'SHORT', fill: 500, quantity: 1, sourceStop: 505, sourceTarget: 497 }, cfg);
    assert.equal(sh.target, 490);
});

test('minimum target units: rupees and percent', () => {
    const r = finalizeLevels({ direction: 'LONG', fill: 1000, quantity: 500, sourceStop: 990, sourceTarget: null }, makeCfg({ MIN_TARGET_UNIT: 'rupees', SLIPPAGE_BPS: 0 }));
    assert.equal(r.target, 1000.02, 'Rs 10 over 500 shares = 0.02 per share');
    const p = finalizeLevels({ direction: 'LONG', fill: 1000, quantity: 1, sourceStop: 990, sourceTarget: null }, makeCfg({ MIN_TARGET_UNIT: 'percent', SLIPPAGE_BPS: 0 }));
    assert.equal(p.target, 1100);
});

test('short target that would be <= 0 is clamped and flagged', () => {
    const lv = finalizeLevels({ direction: 'SHORT', fill: 8, quantity: 1000, sourceStop: 8.3, sourceTarget: 7.7 }, cfg);
    assert.equal(lv.target, 0.05);
    assert.equal(lv.targetBasis, 'MIN_TARGET_UNREACHABLE');
});

test('trailing stop only moves in the profitable direction (LONG and SHORT)', () => {
    const long = { direction: 'LONG', entry_price: 100, target_price: 110, stop_loss_price: 95, trail_distance: 2, high_water: 100 };
    const a = activateTrailing(long, 111, cfg);
    assert.equal(a.stop, 110, 'lock = 100% of target distance');
    Object.assign(long, { stop_loss_price: a.stop, high_water: a.highWater });
    const up = ratchetTrailing(long, 115);
    assert.equal(up.stop, 113);
    Object.assign(long, { stop_loss_price: up.stop, high_water: up.highWater });
    const down = ratchetTrailing(long, 105);
    assert.equal(down.stop, 113, 'never loosens on a pullback');
    assert.equal(down.moved, false);

    const short = { direction: 'SHORT', entry_price: 100, target_price: 90, stop_loss_price: 105, trail_distance: 2, high_water: 100 };
    const s1 = activateTrailing(short, 89, cfg);
    assert.equal(s1.stop, 90);
    Object.assign(short, { stop_loss_price: s1.stop, high_water: s1.highWater });
    const s2 = ratchetTrailing(short, 80);
    assert.equal(s2.stop, 82);
    Object.assign(short, { stop_loss_price: s2.stop, high_water: s2.highWater });
    assert.equal(ratchetTrailing(short, 95).stop, 82, 'never loosens for SHORT');
});

test('position size is exactly LOT_SIZE x lot size (1 lot by default)', () => {
    const w = makeWorld({ SLIPPAGE_BPS: 0 });
    assert.equal(w.cfg.LOT_SIZE, 1);
    const r = place(w, { symbol: 'RELIANCE', direction: 'LONG', orderType: 'STOP_ENTRY', entry: 1000, stop: 990, target: 1020 });
    assert.ok(r.ok);
    const o = w.db.pendingOrders()[0];
    assert.equal(o.lots, 1);
    assert.equal(o.quantity, 500);
});

test('LONG stopped out at the 5% boundary when the source stop is looser', async () => {
    const w = makeWorld({ SLIPPAGE_BPS: 0 });
    place(w, { symbol: 'RELIANCE', direction: 'LONG', orderType: 'STOP_ENTRY', entry: 1000, stop: 900, target: 1050 });
    w.feed.set('RELIANCE', [bar('10:01', 999, 1001, 999, 1000), bar('10:02', 1000, 1000, 960, 962), bar('10:03', 962, 963, 949, 950), bar('10:04', 950, 950, 940, 945)]);
    w.clock.set('10:05');
    await w.positions.monitor();
    const t = w.db.searchTrades({}).rows[0];
    assert.equal(t.status, 'CLOSED');
    assert.equal(t.exit_reason, 'STOP_LOSS');
    assert.equal(t.exit_price, 950);
    assert.equal(t.gross_pnl, -25000);
});

test('SHORT stopped out at the 5% boundary', async () => {
    const w = makeWorld({ SLIPPAGE_BPS: 0 });
    place(w, { symbol: 'SBIN', direction: 'SHORT', orderType: 'STOP_ENTRY', entry: 200, stop: 230, target: 180 });
    w.feed.set('SBIN', [bar('10:01', 201, 201, 199, 200), bar('10:02', 200, 211, 200, 210), bar('10:03', 210, 212, 209, 211)]);
    w.clock.set('10:04');
    await w.positions.monitor();
    const t = w.db.searchTrades({}).rows[0];
    assert.equal(t.exit_reason, 'STOP_LOSS');
    assert.equal(t.exit_price, 210);
    assert.ok(t.exit_price <= 200 * 1.05);
});

test('gap through the stop fills at the open (realistic), never silently at the stop', async () => {
    const w = makeWorld({ SLIPPAGE_BPS: 0 });
    place(w, { symbol: 'TCS', direction: 'LONG', orderType: 'STOP_ENTRY', entry: 100, stop: 98, target: 112 });
    w.feed.set('TCS', [bar('10:01', 100, 100.5, 99.5, 100), bar('10:02', 96, 96.5, 95, 95.5), bar('10:03', 95.5, 96, 95, 95.2)]);
    w.clock.set('10:04');
    await w.positions.monitor();
    const t = w.db.searchTrades({}).rows[0];
    assert.equal(t.exit_reason, 'STOP_LOSS');
    assert.equal(t.exit_price, 96);
});

test('target exit when trailing is disabled', async () => {
    const w = makeWorld({ SLIPPAGE_BPS: 0, TRAILING_ENABLED: 'false' });
    place(w, { symbol: 'INFY', direction: 'LONG', orderType: 'STOP_ENTRY', entry: 1500, stop: 1490, target: 1505 });
    w.feed.set('INFY', [bar('10:01', 1500, 1501, 1499, 1500.5), bar('10:02', 1500.5, 1511, 1500, 1510), bar('10:03', 1510, 1512, 1508, 1509)]);
    w.clock.set('10:04');
    await w.positions.monitor();
    const t = w.db.searchTrades({}).rows[0];
    assert.equal(t.exit_reason, 'TARGET');
    assert.equal(t.target_price, 1507.5, 'source target 1505 lifted to the NSE 0.5% floor');
    assert.equal(t.exit_price, 1507.5);
    assert.equal(t.gross_pnl, 750);
});

test('trailing: target arms the trail, price runs, reversal exits at the trailing stop', async () => {
    const w = makeWorld({ SLIPPAGE_BPS: 0, TRAIL_DISTANCE: 3, TRAIL_DISTANCE_UNIT: 'points' });
    place(w, { symbol: 'INFY', direction: 'LONG', orderType: 'STOP_ENTRY', entry: 1500, stop: 1490, target: 1505 });
    w.feed.set('INFY', [
        bar('10:01', 1500, 1501, 1499, 1500.5),
        bar('10:02', 1501, 1511, 1500, 1510), // target 1510 touched -> trail armed, stop -> 1510
        bar('10:03', 1511, 1520, 1511, 1519), // ratchet -> 1517
        bar('10:04', 1519, 1525, 1518, 1524), // ratchet -> 1522
        bar('10:05', 1524, 1524, 1515, 1516), // reversal hits 1522
        bar('10:06', 1516, 1517, 1514, 1515),
    ]);
    w.clock.set('10:07');
    await w.positions.monitor();
    const t = w.db.searchTrades({}).rows[0];
    assert.equal(t.status, 'CLOSED');
    assert.equal(t.exit_reason, 'TRAILING_STOP');
    assert.equal(t.trailing_active, 1);
    assert.equal(t.exit_price, 1522);
    assert.ok(t.exit_price > t.target_price, 'trail protected more than the minimum target');
    const ev = w.db.listEvents({ tradeId: t.id }).map((e) => e.type);
    assert.ok(ev.includes('TRAILING_ACTIVATED'));
    assert.ok(ev.includes('TRAIL_RAISED'));
});

test('PROFIT_BOOK_INR locks a 24h trade at the price that banks it (₹, not $)', async () => {
    const w = makeWorld(
        { SLIPPAGE_BPS: 0, PROFIT_BOOK_INR: 2000, INR_USD_RATE: 84 },
        { strategyById: () => ({ roundTheClock: true, key: 'gold_sweep' }) },
    );
    // The lock is gated by roundTheClock, not by symbol. A spot symbol would
    // bypass the fake feed (getBars hits the real gold API for those), so the
    // contract is exercised on an NSE symbol with a 24h strategy attached.
    place(w, { symbol: 'SBIN', direction: 'LONG', orderType: 'MARKET', referencePrice: 4000, entry: 4000, stop: 3985, target: 4100 });
    w.feed.set('SBIN', [
        bar('10:01', 4000, 4000.6, 3999.5, 4000.5), // fills at 4000, +$0.60 = ₹5,040 on qty 100
        bar('10:02', 4000.5, 4001, 4000.4, 4000.9), // holds above the new stop
        bar('10:03', 4000.9, 4001.2, 4000.5, 4001),
    ]);
    w.clock.set('10:04');
    await w.positions.monitor();

    const t = w.db.searchTrades({}).rows[0];
    assert.equal(t.status, 'OPEN', 'the lock tightens, it does not close');
    assert.equal(t.profit_booked, 1, 'flag persists for the rest of the trade');
    //  ₹2,000 / (qty 100 x rate 84) = $0.2381 above entry, NOT ₹2,000 / qty = $20.
    assert.equal(t.stop_loss_price, 4000.24);
    assert.ok(t.stop_loss_price > t.entry_price, 'stop sits in profit for a LONG');
    const ev = w.db.listEvents({}).map((e) => e.type);
    assert.ok(ev.includes('PROFIT_BOOKED'), `events were ${ev.join(', ')}`);
    assert.ok(ev.includes('ORDER_PLACED'));
});

test('the profit lock survives a restart instead of being re-derived', async () => {
    const file = path.join(os.tmpdir(), `profit-lock-${Date.now()}-${process.pid}.db`);
    const w = makeWorld(
        { SLIPPAGE_BPS: 0, PROFIT_BOOK_INR: 2000, INR_USD_RATE: 84 },
        { file, strategyById: () => ({ roundTheClock: true, key: 'eth_sweep' }) },
    );
    place(w, { symbol: 'TCS', direction: 'SHORT', orderType: 'MARKET', referencePrice: 2700, entry: 2700, stop: 2710, target: 2650 });
    w.feed.set('TCS', [
        bar('10:01', 2700, 2700.5, 2696, 2696.5), // -$3.50 on qty 100 = ₹29,400
        bar('10:02', 2696.5, 2697, 2695, 2695.5),
    ]);
    w.clock.set('10:03');
    await w.positions.monitor();

    const reopened = new Database(file);
    const row = reopened.openTrades()[0];
    assert.equal(row.profit_booked, 1, 'profit_booked is written to the database');
    // ₹2,000 / (qty 100 x rate 84) = $0.2381 below the 2700 entry.
    assert.equal(row.stop_loss_price, 2699.76, 'SHORT locks below entry in ₹ terms');
    // Cleanup must never mask an assertion above.
    try { reopened.close(); } catch { /* already closed */ }
    try { w.db.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(`${file}${suffix}`, { force: true }); } catch { /* best effort */ }
    }
});

test('end-of-day square-off closes every intraday position', async () => {
    const w = makeWorld({ SLIPPAGE_BPS: 0 });
    place(w, { symbol: 'ITC', direction: 'LONG', orderType: 'STOP_ENTRY', entry: 400, stop: 395, target: 420 });
    w.feed.set('ITC', [bar('10:01', 400, 401, 399.5, 400.5), bar('15:19', 402, 403, 401, 402.5), bar('15:21', 410, 411, 409, 410)]);
    w.clock.set('15:22');
    await w.positions.monitor();
    const t = w.db.searchTrades({}).rows[0];
    assert.equal(t.exit_reason, 'EOD_SQUARE_OFF');
    assert.equal(t.exit_price, 402.5, 'last bar before 15:20, bars after square-off ignored');
});
