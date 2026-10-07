// MongoDatabase: the pure-Atlas engine store. Covers every method the engine
// uses with a pure in-memory test driver that mimics the driver's
// list/insert/replace/deleteById surface; the production path wraps the real
// mongodb driver in the same API shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MongoDatabase } from '../src/db/mongoDatabase.js';

const fakeDriver = () => {
    const tables = {};
    return {
        tables,
        ready: Promise.resolve(true),
        async list(name) {
            return (tables[name] || []).map((r) => ({ ...r }));
        },
        insert(name, doc) {
            (tables[name] ||= []).push({ ...doc });
            return Promise.resolve();
        },
        replace(name, id, doc) {
            const arr = (tables[name] ||= []);
            const at = arr.findIndex((r) => r.id === id);
            if (at >= 0) arr[at] = { ...doc };
            else arr.push({ ...doc });
            return Promise.resolve();
        },
        deleteById(name, id) {
            const arr = (tables[name] ||= []);
            const at = arr.findIndex((r) => r.id === id);
            if (at >= 0) arr.splice(at, 1);
            return Promise.resolve();
        },
        async close() {
            this.closed = true;
        },
        closed: false,
    };
};

async function makeDb() {
    const driver = fakeDriver();
    const db = new MongoDatabase({ driver, dbName: 'testing' });
    await db.ready();
    return { db, driver };
}

test('strategies: upsert inserts on first key, updates on the same key', async () => {
    const { db } = await makeDb();
    const sid = db.upsertStrategy({ key: 'gold_sweep', code: 'Strategy-07', name: 'Gold Sweep', source: 'wa-bot', sourceFiles: 'f.js', description: 'd', enabled: true });
    assert.equal(typeof sid, 'number');
    const again = db.upsertStrategy({ key: 'gold_sweep', code: 'Strategy-07', name: 'Gold Sweep v2', source: 'wa-bot', sourceFiles: 'f.js', description: 'd', enabled: false });
    assert.equal(again, sid, 'upsert returns the same id');
    const listed = db.listStrategies();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].name, 'Gold Sweep v2');
    assert.equal(listed[0].enabled, 0);
});

test('strategy metadata: setStrategyEnabled + setStrategyStatus', async () => {
    const { db } = await makeDb();
    const sid = db.upsertStrategy({ key: 'eth_trend', code: 'Strategy-12', name: 'ETH Trend', source: 'wa-bot', sourceFiles: '', description: '', enabled: true });
    db.setStrategyEnabled(sid, false);
    assert.equal(db.getStrategy(sid).enabled, 0);
    db.setStrategyStatus(sid, 'RUNNING', null);
    assert.equal(db.getStrategy(sid).status, 'RUNNING');
});

test('scans: startScan / finishScan / lastScan / scansOn', async () => {
    const { db } = await makeDb();
    const sid = db.upsertStrategy({ key: 'gold_sweep', code: 'Strategy-07', name: 'Gold Sweep', source: 'x', sourceFiles: '', description: '', enabled: true });
    const scanId = db.startScan(sid, '2026-10-07', 'manual');
    db.finishScan(scanId, { ok: true, candidates: 3, setups: 2, accepted: 1, rejected: 1, detail: { phase: 'OPEN' } });
    const last = db.lastScan(sid);
    assert.equal(last.id, scanId);
    assert.deepEqual(last.detail, { phase: 'OPEN' });
    const rows = db.scansOn(sid, '2026-10-07');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].trigger, 'manual');
    assert.equal(rows[0].ok, true);
});

test('signals: evalSymbols / latestSignal / listSignals / updateStatus / trader join', async () => {
    const { db } = await makeDb();
    const sid = db.upsertStrategy({ key: 'gold_sweep', code: 'Strategy-07', name: 'Gold Sweep', source: 'x', sourceFiles: '', description: '', enabled: true });
    const s1 = db.insertSignal({ strategyId: sid, scanId: null, sessionDate: '2026-10-07', symbol: 'XAUUSD', direction: 'LONG', signalType: 'SETUP', status: 'ACCEPTED', price: 4100, metadata: { aiMode: 'AI_GATE', setup: { entry: 4100 } } });
    db.insertSignal({ strategyId: sid, scanId: null, sessionDate: '2026-10-07', symbol: 'ETHUSD', direction: 'SHORT', signalType: 'WATCH', status: 'WATCH', rejectReason: 'confluence 30', metadata: null });
    assert.deepEqual([...db.evaluatedSymbols(sid, '2026-10-07')], ['XAUUSD']);
    const latest = db.latestSignal(sid);
    assert.equal(latest.status, 'ACCEPTED', 'latest accepted wins once accepted is on-board');
    const listed = db.listSignals({ strategyId: sid, limit: 10 });
    assert.equal(listed.length, 2);
    assert.doesNotThrow(() => JSON.stringify(listed[0].signal_metadata));
    db.updateSignalStatus(s1, 'REJECTED', 'gate');
    assert.equal(db.getSignal(s1).status, 'REJECTED');
});

test('orders: PENDING filter + countEntriesOn + markFilled + close', async () => {
    const { db } = await makeDb();
    const sid = db.upsertStrategy({ key: 'eth_trend', code: 'Strategy-12', name: 'ETH Trend', source: 'x', sourceFiles: '', description: '', enabled: true });
    const s1 = db.insertSignal({ strategyId: sid, scanId: null, sessionDate: '2026-10-07', symbol: 'ETHUSD', direction: 'LONG', signalType: 'SETUP', status: 'ACCEPTED', price: 3000, metadata: null });
    const o1 = db.insertOrder({ strategyId: sid, signalId: s1, sessionDate: '2026-10-07', symbol: 'ETHUSD', direction: 'LONG', orderType: 'STOP_ENTRY', quantity: 1, lots: 1, lotSize: 100, lotSizeSource: 'repo', triggerPrice: 3000, createdAt: Date.now(), expiresAt: Date.now() + 3600000, lastBarTs: null });
    assert.equal(db.countEntriesOn(sid, '2026-10-07'), 1, 'pending order counts toward cadence');
    assert.equal(db.pendingOrders().length, 1);
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(db.getOrder(o1).risk_plan ?? null))
    );
    db.markOrderFilled(o1, 3000, Date.now());
    assert.equal(db.pendingOrders().length, 0);
    assert.equal(db.getOrder(o1).status, 'FILLED');
    assert.equal(db.countEntriesOn(sid, '2026-10-07'), 0);
});

test('trades: open → updateState → close → hasLiveExposure/countEntriesOn flip', async () => {
    const { db } = await makeDb();
    const sid = db.upsertStrategy({ key: 'gold_sweep', code: 'S07', name: 'Gold Sweep', source: 'x', sourceFiles: '', description: '', enabled: true });
    const s1 = db.insertSignal({ strategyId: sid, scanId: null, sessionDate: '2026-10-07', symbol: 'XAUUSD', direction: 'LONG', signalType: 'SETUP', status: 'ACCEPTED', price: 4100, metadata: { setup: { entry: 4100, stop: 4090, target: 4125 } } });
    const o1 = db.insertOrder({ strategyId: sid, signalId: s1, sessionDate: '2026-10-07', symbol: 'XAUUSD', direction: 'LONG', orderType: 'STOP_ENTRY', quantity: 10, lots: 1, lotSize: 10, lotSizeSource: 'repo', triggerPrice: 4100, createdAt: Date.now(), expiresAt: Date.now() + 3600000 });
    const t = db.insertTrade({ strategyId: sid, signalId: s1, orderId: o1, sessionDate: '2026-10-07', symbol: 'XAUUSD', direction: 'LONG', quantity: 10, lots: 1, lotSize: 10, lotSizeSource: 'repo', entryPrice: 4100, entryTime: Date.now(), targetPrice: 4125, stopLossPrice: 4090, hardStop: 3895, initialStop: 4090, trailingEnabled: false, trailDistance: null });
    db.updateTradeState({ id: t, stop_loss_price: 4100, trailing_active: false, last_price: 4110, last_price_time: Date.now(), profit_booked: false });
    assert.equal(db.getTrade(t).stop_loss_price, 4100);
    assert.equal(db.hasLiveExposure(sid, 'XAUUSD'), true);
    assert.equal(db.countEntriesOn(sid, '2026-10-07'), 2, 'order (PENDING after markFilled?) and trade are still live');
    db.markOrderFilled(o1, 4100, Date.now());
    assert.equal(db.countEntriesOn(sid, '2026-10-07'), 1);
    const changes = db.closeTrade(t, { exitPrice: 4125, exitTime: Date.now(), exitReason: 'TARGET', grossPnl: 250, fees: 12.5, netPnl: 237.5, holdingSeconds: 120 });
    assert.equal(changes, 1);
    assert.equal(db.getTrade(t).exit_reason, 'TARGET');
    assert.equal(db.hasLiveExposure(sid, 'XAUUSD'), false);
    assert.equal(db.openTrades().length, 0);
});

test('searchTrades filters + strategy join + total/limit/offset', async () => {
    const { db } = await makeDb();
    const sid = db.upsertStrategy({ key: 'gold_sweep', code: 'Strategy-07', name: 'Gold Sweep', source: 'x', sourceFiles: '', description: '', enabled: true });
    const s1 = db.insertSignal({ strategyId: sid, scanId: null, sessionDate: '2026-10-07', symbol: 'XAUUSD', direction: 'LONG', signalType: 'SETUP', status: 'ACCEPTED', price: 4100, metadata: null });
    const t1 = db.insertTrade({ strategyId: sid, signalId: s1, orderId: null, sessionDate: '2026-10-07', symbol: 'XAUUSD', direction: 'LONG', quantity: 10, lots: 1, lotSize: 10, lotSizeSource: 'repo', entryPrice: 4100, entryTime: Date.now(), targetPrice: 4200, stopLossPrice: 4000, hardStop: 3895, initialStop: 4000, trailingEnabled: false });
    db.closeTrade(t1, { exitPrice: 4200, exitTime: Date.now(), exitReason: 'TARGET', grossPnl: 1000, fees: 10, netPnl: 990, holdingSeconds: 600 });
    const all = db.searchTrades({ limit: 10 });
    assert.equal(all.total, 1);
    assert.equal(all.rows[0].strategy_code, 'Strategy-07');
    const wins = db.searchTrades({ result: 'WIN', strategyId: sid });
    assert.equal(wins.total, 1);
    const losses = db.searchTrades({ result: 'LOSS' });
    assert.equal(losses.total, 0);
    const bySymbol = db.searchTrades({ symbol: 'xau' });
    assert.equal(bySymbol.total, 1);
});

test('closedTradesWithSignals returns metadata from the joined signal', async () => {
    const { db } = await makeDb();
    const sid = db.upsertStrategy({ key: 'gold_sweep', code: 'S07', name: 'Gold Sweep', source: 'x', sourceFiles: '', description: '', enabled: true });
    const s1 = db.insertSignal({ strategyId: sid, scanId: null, sessionDate: '2026-10-07', symbol: 'XAUUSD', direction: 'LONG', signalType: 'SETUP', status: 'ACCEPTED', price: 4100, metadata: { aiMode: 'AI_GATE' } });
    const t1 = db.insertTrade({ strategyId: sid, signalId: s1, orderId: null, sessionDate: '2026-10-07', symbol: 'XAUUSD', direction: 'LONG', quantity: 10, lots: 1, lotSize: 10, lotSizeSource: 'repo', entryPrice: 4100, entryTime: Date.now(), targetPrice: 4200, stopLossPrice: 4000, hardStop: 3895, initialStop: 4000, trailingEnabled: false });
    db.closeTrade(t1, { exitPrice: 4200, exitTime: Date.now(), exitReason: 'TARGET', grossPnl: 1000, fees: 10, netPnl: 990, holdingSeconds: 600 });
    const rows = db.closedTradesWithSignals();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].signal_metadata.aiMode, 'AI_GATE');
});

test('listEvents returns ordered, filtered events with parsed detail', async () => {
    const { db } = await makeDb();
    db.insertEvent({ strategyId: 3, type: 'ENTRY', price: 4100, message: 'fill', detail: { lots: 1 } });
    db.insertEvent({ strategyId: 3, type: 'EXIT', price: 4200, message: 't1 hit', detail: null });
    const rows = db.listEvents({ strategyId: 3 });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].type, 'EXIT', 'newest id first');
    assert.deepEqual(rows[1].detail, { lots: 1 });
});

test('kv + model versions + performance snapshots follow the upsert and filter contracts', async () => {
    const { db } = await makeDb();
    db.setKv('ml:lastTrain', '2026-10-07');
    assert.equal(db.getKv('ml:lastTrain'), '2026-10-07');
    const promoted = db.insertModelVersion({ createdAt: Date.now(), sampleSize: 200, trainedThrough: Date.now(), trainSize: 140, testSize: 60, featureNames: ['a', 'b'], model: { weights: [0.1, -0.2], mean: [0, 0], std: [1, 1], bias: 0 }, metrics: { testAcc: 0.6 }, promoted: true, note: 'test' });
    const cur = db.currentModel();
    assert.equal(cur.id, promoted);
    assert.equal(cur.metrics.testAcc, 0.6);
    const versions = db.listModelVersions();
    assert.equal(versions.length, 1);
    db.deleteModelVersion(promoted);
    assert.equal(db.currentModel(), null);

    db.savePerformance(7, 'ALL', { totalTrades: 3, winningTrades: 2, losingTrades: 1, winRate: 66.6, profitFactor: 2.1, grossProfit: 300, grossLoss: 100, netPnl: 200, fees: 40, avgWin: 150, avgLoss: 100, largestWin: 200, largestLoss: 100, maxDrawdown: 50, maxDrawdownPct: 5, avgHoldingSeconds: 120 }, 80);
    const p = db.getPerformance(7, 'ALL');
    assert.equal(p.rank_score, 80);
    db.savePerformance(7, 'ALL', { totalTrades: 4, winningTrades: 3, losingTrades: 1, winRate: 75, profitFactor: 3, grossProfit: 450, grossLoss: 150, netPnl: 300, fees: 60, avgWin: 150, avgLoss: 150, largestWin: 250, largestLoss: 150, maxDrawdown: 50, maxDrawdownPct: 5, avgHoldingSeconds: 120 }, 88);
    const p2 = db.getPerformance(7, 'ALL');
    assert.equal(p2.total_trades, 4, 'savePerformance upserts on (strategy_id, period)');
    assert.equal(p2.rank_score, 88);
});

test('adapter side-effects coverage: every mutation persists via driver ops', async () => {
    const { db, driver } = await makeDb();
    const sid = db.upsertStrategy({ key: 'gold_sweep', code: 'S07', name: 'n', source: 's', sourceFiles: '', description: '', enabled: true });
    db.insertSignal({ strategyId: sid, scanId: null, sessionDate: '2026-10-07', symbol: 'XAUUSD', direction: 'LONG', signalType: 'SETUP', status: 'ACCEPTED', price: 4100, metadata: null });
    const sigRows = driver.tables['engine_signals'] || [];
    assert.equal(sigRows.length, 1);
    assert.equal(sigRows[0].id, 1);
    db.setKv('hello', 'world');
    db.setKv('hello', 'there');
    const kvRows = driver.tables['engine_kv'] || [];
    assert.equal(kvRows.length, 1);
    assert.equal(kvRows[0].value, 'there');
    db.deleteModelVersion(1);
    assert.equal(db.countLoaded().strategies, 1);
    await db.close();
    assert.equal(driver.closed, true);
});