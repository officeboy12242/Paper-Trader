import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MongoStore, signalText, tradeText } from '../src/db/mongo.js';
import { nullLogger } from '../src/logger.js';
import { Database } from '../src/db/database.js';

test('mongo mirror is a no-op without a URI', async () => {
    const m = new MongoStore({ uri: '', logger: nullLogger });
    assert.equal(m.enabled, false);
    m.push('signals', { hello: 'world' }); // must not throw
    await m.flush(); // must not throw
    await m.close();
});

test('signal text summarises the decision for future embeddings', () => {
    const t = signalText({
        strategyCode: 'Strategy-07', source: 'gold_sweep', symbol: 'XAUUSD',
        direction: 'LONG', status: 'ACCEPTED',
        setup: { entry: 4160, stop: 4145, target: 4200, score: 75, checks: { sweepLow: true } },
        confluence: 70,
    });
    assert.match(t, /Strategy-07/);
    assert.match(t, /BUY XAUUSD @ 4160/);
    const w = signalText({ strategyCode: 'Strategy-07', source: 'gold_sweep', symbol: 'XAUUSD', direction: null, status: 'WATCH', setup: null, reason: 'no setup' });
    assert.match(w, /watch/);
});

test('trade text summarises the outcome label', () => {
    const t = tradeText({
        strategyCode: 'Strategy-07', source: 'gold_sweep', symbol: 'XAUUSD',
        direction: 'SHORT', entry: 4166, exitPrice: 4126, netPnl: 2000, rMultiple: 2.6,
        exitReason: 'TARGET', holdingSeconds: 1800,
    });
    assert.match(t, /SELL XAUUSD/);
    assert.match(t, /WIN/);
});

test('dumpBackup/restoreBackup round-trips engine state to a fresh sqlite', () => {
    const src = new Database(':memory:');
    const sid = src.upsertStrategy({ key: 'gold_sweep', code: 'Strategy-07', name: 'Gold Sweep', source: 'wa-bot', sourceFiles: 'x', description: 'd', enabled: true });
    const scanId = src.startScan(sid, '2026-10-07', 'manual');
    const signalId = src.insertSignal({ strategyId: sid, scanId, sessionDate: '2026-10-07', symbol: 'XAUUSD', direction: 'LONG', signalType: 'SETUP', status: 'ACCEPTED', price: 4000, metadata: { setup: {} } });
    const orderId = src.insertOrder({ strategyId: sid, signalId, sessionDate: '2026-10-07', symbol: 'XAUUSD', direction: 'LONG', orderType: 'STOP_ENTRY', quantity: 10, lots: 1, lotSize: 10, lotSizeSource: 'repo', triggerPrice: 4000, createdAt: Date.now(), expiresAt: Date.now() + 3600000 });
    src.insertTrade({ strategyId: sid, signalId, orderId, sessionDate: '2026-10-07', symbol: 'XAUUSD', direction: 'LONG', quantity: 10, lots: 1, lotSize: 10, lotSizeSource: 'repo', entryPrice: 4000, entryTime: Date.now(), targetPrice: 4100, stopLossPrice: 3950, hardStop: 3800, initialStop: 3950, trailingEnabled: false, trailDistance: null });
    const snap = src.dumpBackup();

    const dst = new Database(':memory:');
    const r = dst.restoreBackup(snap);
    assert.equal(r.openTrades, 1);
    assert.equal(r.pendingOrders, 1);
    assert.equal(r.recentSignals, 1);
    assert.equal(r.strategies, 1);
    assert.equal(dst.openTrades().length, 1);
    assert.equal(dst.pendingOrders().length, 1);
    assert.equal(dst.listStrategies().length, 1);

    const full = new Database(':memory:');
    full.upsertStrategy({ key: 'gold_sweep', code: 'Strategy-07', name: 'n', source: 's', sourceFiles: '', description: '', enabled: true });
    const r2 = full.restoreBackup(snap);
    assert.equal(r2.skipped, true);
});
