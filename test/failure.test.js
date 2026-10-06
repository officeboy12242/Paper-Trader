import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeWorld, place, bar, makeCfg, Clock, FakeFeed, fakeLots, at } from './helpers.js';
import { Database } from '../src/db/database.js';
import { Engine } from '../src/engine/engine.js';
import { MarketDataService } from '../src/market/marketData.js';
import { SourceStrategy } from '../src/strategies/sourceStrategy.js';
import { nullLogger } from '../src/logger.js';

const longSig = { symbol: 'LT', direction: 'LONG', orderType: 'STOP_ENTRY', entry: 3000, stop: 2980, target: 3030 };

test('API failure: monitoring fails safe, positions untouched, then recovers and replays', async () => {
    const w = makeWorld({ SLIPPAGE_BPS: 0, TRAILING_ENABLED: 'false' });
    place(w, longSig);
    w.feed.set('LT', [bar('10:01', 2999, 3001, 2998, 3000)]);
    w.clock.set('10:02');
    await w.positions.monitor();
    assert.equal(w.db.openTrades().length, 1);

    w.feed.fail = true;
    w.feed.set('LT', [bar('10:01', 2999, 3001, 2998, 3000), bar('10:05', 2995, 2996, 2975, 2978), bar('10:06', 2978, 2980, 2970, 2972)]);
    for (let i = 0; i < 6; i++) {
        w.clock.t += 30_000;
        const pass = await w.positions.monitor();
        assert.ok(pass, 'monitor never throws');
    }
    assert.equal(w.marketData.status().state, 'DISCONNECTED');
    assert.equal(w.db.openTrades().length, 1, 'no data, no action');

    w.feed.fail = false; // reconnect
    w.clock.set('10:10');
    await w.positions.monitor();
    assert.equal(w.marketData.status().state, 'CONNECTED');
    const t = w.db.searchTrades({}).rows[0];
    assert.equal(t.exit_reason, 'STOP_LOSS', 'stop printed during the outage is honoured on replay');
    assert.equal(t.exit_price, 2980);
});

test('market-data disconnect with missing prices: position held, squared off at last known price after the grace period', async () => {
    const w = makeWorld({ SLIPPAGE_BPS: 0 });
    place(w, longSig);
    w.feed.set('LT', [bar('10:01', 2999, 3001, 2998, 3000), bar('10:02', 3000, 3004, 2999, 3003)]);
    w.clock.set('10:03');
    await w.positions.monitor();
    w.feed.set('LT', []); // feed returns nothing for the rest of the day
    w.clock.set('15:25');
    await w.positions.monitor();
    assert.equal(w.db.openTrades().length, 1, 'waits for the feed before squaring off blind');
    w.clock.set('15:55');
    await w.positions.monitor();
    const t = w.db.searchTrades({}).rows[0];
    assert.equal(t.exit_reason, 'EOD_SQUARE_OFF');
    assert.equal(t.exit_price, 3003, 'last known price');
});

test('database restart: health reports the outage, a reopened database resumes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-'));
    const file = path.join(dir, 'dbrestart.db');
    const cfg = makeCfg();
    const clock = new Clock(at('10:00'));
    let db = new Database(file);
    const md = new MarketDataService({ cfg, logger: nullLogger, fetchCandles: async () => [], now: clock.now });
    const engine = new Engine({ cfg, db, logger: nullLogger, marketData: md, lotSizes: fakeLots, now: clock.now, strategyFactory: (def) => new SourceStrategy({ def, cfg }) });
    engine.init();
    assert.equal(engine.health().database.ok, true);
    db.close();
    assert.equal(engine.health().database.ok, false);
    assert.equal(engine.health().status, 'FAIL');
    db = new Database(file);
    assert.equal(db.listStrategies().length, 12, 'state intact after reopen');
    db.close();
});

test('process restart: a new engine on the same file recovers open trades and keeps strategy toggles', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-'));
    const file = path.join(dir, 'proc.db');
    const cfg = makeCfg({ SLIPPAGE_BPS: 0 });
    const clock = new Clock(at('10:00'));
    const feed = new FakeFeed(clock);
    const mk = (db) => new Engine({
        cfg, db, logger: nullLogger, lotSizes: fakeLots, now: clock.now,
        marketData: new MarketDataService({ cfg, logger: nullLogger, fetchCandles: feed.fetchCandles, now: clock.now, retries: 0 }),
        strategyFactory: (def) => new SourceStrategy({ def, cfg }),
    });
    let db = new Database(file);
    let e = mk(db);
    e.init();
    const id = e.traders[1].id;
    e.setEnabled(e.traders[0].id, false);
    const sigId = db.insertSignal({ strategyId: id, sessionDate: '2026-10-06', symbol: 'LT', direction: 'LONG', signalType: 'SETUP', status: 'ACCEPTED', price: 3000 });
    e.positions.placeEntry({ strategyId: id, signalId: sigId, signal: longSig, sessionDate: '2026-10-06' });
    db.close();

    db = new Database(file);
    e = mk(db);
    e.init();
    assert.equal(db.pendingOrders().length, 1);
    assert.equal(Boolean(db.getStrategy(e.traders[0].id).enabled), false, 'disabled trader stays disabled');
    feed.set('LT', [bar('10:01', 2999, 3001, 2998, 3000)]);
    clock.set('10:02');
    await e.positions.monitor();
    assert.equal(e.positions.openPositionsView().length, 1);
    assert.equal(e.overview().activePositions, 1);
    db.close();
});

test('missing price for an AI market signal is rejected safely', () => {
    const w = makeWorld();
    const r = place(w, { symbol: 'ONGC', direction: 'LONG', orderType: 'MARKET', referencePrice: undefined });
    assert.equal(r.ok, false);
    assert.match(r.reason, /missing price/);
});

test('scheduler: a failing scan is retried later, not hammered, and other traders keep their schedule', async () => {
    const cfg = makeCfg();
    const clock = new Clock(at('09:21'));
    const db = new Database(':memory:');
    let attempts = 0;
    const md = new MarketDataService({ cfg, logger: nullLogger, fetchCandles: async () => [], now: clock.now });
    const engine = new Engine({
        cfg, db, logger: nullLogger, marketData: md, lotSizes: fakeLots, now: clock.now,
        strategyFactory: (def) => {
            const s = new SourceStrategy({ def, cfg, now: clock.now });
            s.discover = async () => {
                if (def.key === 'heatmap') { attempts += 1; throw new Error('NSE 403'); }
                return { discovery: { scannedAt: new Date(), gates: {} }, candidates: [] };
            };
            return s;
        },
    });
    engine.init();
    await engine.schedulerTick({ wait: true });
    await engine.schedulerTick({ wait: true });
    assert.equal(attempts, 1, 'no immediate retry storm');
    assert.equal(db.getStrategy(engine.traders[0].id).status, 'ERROR');
    assert.equal(db.getStrategy(engine.traders[1].id).status, 'RUNNING');
    clock.t += 3 * 60_000;
    engine.traders[0].lastError.at = clock.t - 3 * 60_000;
    await engine.schedulerTick({ wait: true });
    assert.equal(attempts, 2, 'retried after the back-off');
});

test('outside market hours and on holidays traders do not scan', async () => {
    const cfg = makeCfg();
    const clock = new Clock(at('10:00', '2026-10-02')); // Gandhi Jayanti, NSE holiday
    const db = new Database(':memory:');
    let scans = 0;
    const engine = new Engine({
        cfg, db, logger: nullLogger, lotSizes: fakeLots, now: clock.now,
        marketData: new MarketDataService({ cfg, logger: nullLogger, fetchCandles: async () => [], now: clock.now }),
        strategyFactory: (def) => Object.assign(new SourceStrategy({ def, cfg, now: clock.now }), { discover: async () => { if (!def.roundTheClock) scans += 1; return { discovery: {}, candidates: [] }; } }),
    });
    engine.init();
    await engine.schedulerTick({ wait: true });
    assert.equal(scans, 0);
    assert.match(db.listStrategies()[0].status_detail, /holiday/);
    clock.t = at('08:30', '2026-10-06');
    await engine.schedulerTick({ wait: true });
    assert.equal(scans, 0, 'before the open');
});
