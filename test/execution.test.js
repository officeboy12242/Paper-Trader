import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeWorld, place, bar, at } from './helpers.js';
import { Database } from '../src/db/database.js';
import { legCharges, roundTripFees } from '../src/engine/fees.js';

test('stop entry waits until price trades through the trigger', async () => {
    const w = makeWorld({ SLIPPAGE_BPS: 0 });
    place(w, { symbol: 'LT', direction: 'LONG', orderType: 'STOP_ENTRY', entry: 3000, stop: 2980, target: 3030 });
    w.feed.set('LT', [bar('10:01', 2990, 2995, 2988, 2994)]);
    w.clock.set('10:02');
    await w.positions.monitor();
    assert.equal(w.db.openTrades().length, 0);
    assert.equal(w.db.pendingOrders().length, 1);
    w.feed.set('LT', [bar('10:01', 2990, 2995, 2988, 2994), bar('10:02', 2994, 3001, 2993, 3000), bar('10:03', 3000, 3002, 2999, 3001)]);
    w.clock.set('10:04');
    await w.positions.monitor();
    const t = w.db.openTrades()[0];
    assert.ok(t, 'entry filled');
    assert.equal(t.entry_price, 3000);
    assert.equal(t.entry_time, at('10:02'));
    assert.equal(w.db.pendingOrders().length, 0);
});

test('entry fills at the open when price is already beyond the trigger, with slippage', async () => {
    const w = makeWorld({ SLIPPAGE_BPS: 10 });
    place(w, { symbol: 'LT', direction: 'LONG', orderType: 'STOP_ENTRY', entry: 3000, stop: 2950, target: 3100 });
    w.feed.set('LT', [bar('10:01', 3010, 3012, 3008, 3011), bar('10:02', 3011, 3012, 3010, 3011)]);
    w.clock.set('10:03');
    await w.positions.monitor();
    const t = w.db.openTrades()[0];
    assert.equal(t.entry_price, 3013.01, '3010 + 10 bps');
});

test('market entry (AI-direction signal) fills at the next bar open', async () => {
    const w = makeWorld({ SLIPPAGE_BPS: 0 });
    const r = place(w, { symbol: 'ONGC', direction: 'SHORT', orderType: 'MARKET', referencePrice: 250 });
    assert.ok(r.ok);
    w.feed.set('ONGC', [bar('10:01', 249.5, 250, 249, 249.2), bar('10:02', 249.2, 249.5, 249, 249.1)]);
    w.clock.set('10:03');
    await w.positions.monitor();
    const t = w.db.openTrades()[0];
    assert.equal(t.entry_price, 249.5);
    assert.ok(Math.abs(t.stop_loss_price - 249.5 * 1.05) <= 0.01, '5% above fill');
    assert.equal(t.target_price, 239.5, '10 points below fill');
});

test('unfilled orders expire at the entry cutoff', async () => {
    const w = makeWorld({ SLIPPAGE_BPS: 0 });
    place(w, { symbol: 'LT', direction: 'LONG', orderType: 'STOP_ENTRY', entry: 3100, stop: 3080, target: 3130 });
    w.feed.set('LT', [bar('10:01', 3000, 3001, 2999, 3000), bar('14:59', 3000, 3001, 2999, 3000)]);
    w.clock.set('15:01');
    await w.positions.monitor();
    assert.equal(w.db.pendingOrders().length, 0);
    assert.equal(w.db.getOrder(1).status, 'EXPIRED');
    assert.equal(w.db.openTrades().length, 0);
});

test('duplicate signals do not create duplicate positions', async () => {
    const w = makeWorld({ SLIPPAGE_BPS: 0 });
    const sig = { symbol: 'LT', direction: 'LONG', orderType: 'STOP_ENTRY', entry: 3000, stop: 2980, target: 3030 };
    assert.ok(place(w, sig).ok);
    const dup = place(w, sig);
    assert.equal(dup.ok, false);
    assert.match(dup.reason, /duplicate/);
    assert.equal(w.db.pendingOrders().length, 1);
});

test('duplicates are allowed only when explicitly configured', () => {
    const w = makeWorld({ SLIPPAGE_BPS: 0, ALLOW_DUPLICATE_POSITIONS: 'true' });
    const sig = { symbol: 'LT', direction: 'LONG', orderType: 'STOP_ENTRY', entry: 3000, stop: 2980, target: 3030 };
    assert.ok(place(w, sig).ok);
    assert.ok(place(w, sig).ok);
    assert.equal(w.db.pendingOrders().length, 2);
});

test('invalid signals are rejected before reaching the order book', () => {
    const w = makeWorld();
    const bad = [
        { symbol: '', direction: 'LONG', orderType: 'STOP_ENTRY', entry: 100, stop: 99 },
        { symbol: 'X', direction: 'UP', orderType: 'STOP_ENTRY', entry: 100, stop: 99 },
        { symbol: 'X', direction: 'LONG', orderType: 'STOP_ENTRY', entry: NaN, stop: 99 },
        { symbol: 'X', direction: 'LONG', orderType: 'STOP_ENTRY', entry: 100, stop: 101 },
        { symbol: 'X', direction: 'SHORT', orderType: 'STOP_ENTRY', entry: 100, stop: 99 },
        { symbol: 'X', direction: 'LONG', orderType: 'STOP_ENTRY', entry: 100, stop: 99, target: 98 },
        { symbol: 'X', direction: 'LONG', orderType: 'MARKET', referencePrice: null },
        { symbol: 'X', direction: 'LONG', orderType: 'LIMIT', entry: 100, stop: 99 },
    ];
    for (const s of bad) assert.equal(place(w, s).ok, false, JSON.stringify(s));
    assert.equal(w.db.pendingOrders().length, 0);
});

test('P&L and fees: gross, charges and net are consistent', async () => {
    const w = makeWorld({ SLIPPAGE_BPS: 0, TRAILING_ENABLED: 'false' });
    place(w, { symbol: 'RELIANCE', direction: 'LONG', orderType: 'STOP_ENTRY', entry: 1200, stop: 1190, target: 1210 });
    w.feed.set('RELIANCE', [bar('10:01', 1200, 1201, 1199, 1200), bar('10:02', 1201, 1211, 1200, 1210)]);
    w.clock.set('10:03');
    await w.positions.monitor();
    const t = w.db.searchTrades({}).rows[0];
    assert.equal(t.gross_pnl, (1210 - 1200) * 500);
    const fees = roundTripFees({ direction: 'LONG', entryPrice: 1200, exitPrice: 1210, quantity: 500 }, w.cfg);
    assert.equal(t.fees, fees);
    assert.equal(t.net_pnl, Math.round((5000 - fees) * 100) / 100);
    const sell = legCharges({ side: 'SELL', price: 1210, quantity: 500 }, w.cfg);
    assert.equal(sell.brokerage, 20, 'flat Rs 20 cap');
    assert.ok(sell.stt > 0 && legCharges({ side: 'BUY', price: 1200, quantity: 500 }, w.cfg).stt === 0, 'STT on sell side only');
});

test('restart restores open positions and pending orders, then continues from the database', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-'));
    const file = path.join(dir, 'restart.db');
    const w1 = makeWorld({ SLIPPAGE_BPS: 0, TRAILING_ENABLED: 'false' }, { file });
    place(w1, { symbol: 'LT', direction: 'LONG', orderType: 'STOP_ENTRY', entry: 3000, stop: 2980, target: 3030 });
    place(w1, { symbol: 'TCS', direction: 'LONG', orderType: 'STOP_ENTRY', entry: 4000, stop: 3990, target: 4100 });
    w1.feed.set('LT', [bar('10:01', 2999, 3001, 2998, 3000)]);
    w1.clock.set('10:02');
    await w1.positions.monitor();
    assert.equal(w1.db.openTrades().length, 1);
    w1.db.close(); // process dies here

    // New process, same file. While it was down LT ran to target and TCS triggered then stopped.
    const w2 = makeWorld({ SLIPPAGE_BPS: 0, TRAILING_ENABLED: 'false' }, { file });
    assert.equal(w2.db.openTrades().length, 1, 'open position restored');
    assert.equal(w2.db.pendingOrders().length, 1, 'pending order restored');
    w2.feed.set('LT', [bar('10:01', 2999, 3001, 2998, 3000), bar('10:10', 3005, 3031, 3004, 3030)]);
    w2.feed.set('TCS', [bar('10:20', 4000, 4001, 3999, 4000), bar('10:21', 3995, 3996, 3980, 3985)]);
    w2.clock.set('11:30');
    await w2.positions.monitor();
    const rows = w2.db.searchTrades({}).rows;
    assert.equal(rows.length, 2);
    const lt = rows.find((r) => r.symbol === 'LT');
    const tcs = rows.find((r) => r.symbol === 'TCS');
    assert.equal(lt.exit_reason, 'TARGET', 'missed bars replayed after restart');
    assert.equal(tcs.exit_reason, 'STOP_LOSS');
    assert.equal(tcs.exit_price, 3990, 'stop honoured at the level it printed');
    w2.db.close();
});

test('database persistence: rows survive close and reopen', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-'));
    const file = path.join(dir, 'persist.db');
    const db = new Database(file);
    const id = db.upsertStrategy({ key: 'k', code: 'Strategy-01', name: 'n', source: 's', sourceFiles: '', description: '', enabled: true });
    db.insertEvent({ strategyId: id, type: 'TEST', message: 'hello' });
    db.close();
    const db2 = new Database(file);
    assert.equal(db2.listStrategies()[0].key, 'k');
    assert.equal(db2.listEvents({})[0].message, 'hello');
    assert.equal(db2.getKv('schema_version'), '1');
    db2.close();
});
