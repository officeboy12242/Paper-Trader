import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCfg, Clock, FakeFeed, fakeLots, at, bar } from './helpers.js';
import { Database } from '../src/db/database.js';
import { Engine } from '../src/engine/engine.js';
import { MarketDataService } from '../src/market/marketData.js';
import { SourceStrategy } from '../src/strategies/sourceStrategy.js';
import { createServer, tradesToCsv } from '../src/web/server.js';
import { nullLogger } from '../src/logger.js';

async function setup() {
    const cfg = makeCfg({ SLIPPAGE_BPS: 0, TRAILING_ENABLED: 'false' });
    const clock = new Clock(at('10:00'));
    const db = new Database(':memory:');
    const feed = new FakeFeed(clock);
    const engine = new Engine({
        cfg, db, logger: nullLogger, lotSizes: fakeLots, now: clock.now,
        marketData: new MarketDataService({ cfg, logger: nullLogger, fetchCandles: feed.fetchCandles, now: clock.now, retries: 0 }),
        strategyFactory: (def) => new SourceStrategy({ def, cfg }),
    });
    engine.init();
    const id = engine.traders[0].id;
    const sigId = db.insertSignal({ strategyId: id, sessionDate: '2026-10-06', symbol: 'RELIANCE', direction: 'LONG', signalType: 'SETUP', status: 'ACCEPTED', price: 1200, filterCondition: 'heatmap: test, "quoted"' });
    engine.positions.placeEntry({ strategyId: id, signalId: sigId, signal: { symbol: 'RELIANCE', direction: 'LONG', orderType: 'STOP_ENTRY', entry: 1200, stop: 1190, target: 1210, filterCondition: 'heatmap: test, "quoted"' }, sessionDate: '2026-10-06' });
    feed.set('RELIANCE', [bar('10:01', 1200, 1201, 1199, 1200), bar('10:02', 1201, 1211, 1200, 1210)]);
    clock.set('10:03');
    await engine.positions.monitor();
    engine.refreshStats();
    const web = createServer(engine, { port: 0 });
    const base = await web.listen();
    return { engine, db, web, base };
}

test('API endpoints serve dashboard data, CSV export and keep secrets out', async () => {
    process.env.ORCAROUTER_API_KEY = 'sk-should-never-appear';
    process.env.MONGODB_URI = 'mongodb://mongo-secret-should-never-appear';
    const { web, base, db } = await setup();
    try {
        const get = async (p) => { const r = await fetch(base + p); assert.equal(r.status, 200, p); return r; };
        const ov = await (await get('/api/overview')).json();
        assert.equal(ov.safety.paperTrading, true);
        assert.equal(ov.safety.liveTrading, false);
        assert.equal(ov.all.totalTrades, 1);
        assert.equal(ov.all.netPnl < 5000, true, 'net is after fees');

        const strategies = await (await get('/api/strategies')).json();
        assert.equal(strategies.length, 6 + 8);
        const detail = await (await get(`/api/strategies/${strategies[0].id}`)).json();
        assert.equal(detail.metrics.totalTrades, 1);
        assert.equal(detail.equity.length, 1);
        assert.ok(detail.description);

        const rk = await (await get('/api/ranking?period=all')).json();
        assert.match(rk.settings.formula, /score = 100/);
        assert.equal(rk.rows[0].strategy.id, strategies[0].id);

        const hist = await (await get('/api/trades?result=WIN&direction=BUY&symbol=REL')).json();
        assert.equal(hist.total, 1);
        assert.equal(hist.rows[0].strategy_key, 'heatmap', 'source attribution on every trade');
        const none = await (await get('/api/trades?result=LOSS')).json();
        assert.equal(none.total, 0);

        const csv = await (await get('/api/trades.csv')).text();
        const lines = csv.trim().split('\r\n');
        assert.equal(lines.length, 2);
        assert.match(lines[0], /^Trade #,Strategy code,Strategy,Source key,Original source/);
        assert.match(lines[1], /"heatmap: test, ""quoted"""/, 'CSV escaping');

        for (const p of ['/api/config', '/api/health', '/api/strategies', '/api/overview']) {
            const body = await (await get(p)).text();
            assert.doesNotMatch(body, /sk-should-never-appear/, p);
            assert.doesNotMatch(body, /mongo-secret-should-never-appear/, p);
        }
        const html = await (await get('/')).text();
        assert.match(html, /LIVE TRADING DISABLED/);
        const traversal = await fetch(`${base}/..%2f..%2f..%2fpackage.json`);
        assert.notEqual(traversal.status, 200, 'static server cannot escape public/');

        const sid = strategies[2].id;
        const off = await fetch(`${base}/api/strategies/${sid}/disable`, { method: 'POST' });
        assert.equal(off.status, 200);
        assert.equal(db.getStrategy(sid).enabled, 0);
        const cross = await fetch(`${base}/api/strategies/${sid}/enable`, { method: 'POST', headers: { Origin: 'http://evil.example' } });
        assert.equal(cross.status, 403);
        assert.equal((await fetch(`${base}/api/nope`)).status, 404);
    } finally {
        delete process.env.ORCAROUTER_API_KEY;
        await web.close();
    }
});

test('POST /api/positions/:id/exit manually closes an open trade as MANUAL_EXIT', async () => {
    const cfg = makeCfg({ SLIPPAGE_BPS: 0, TRAILING_ENABLED: 'false' });
    const clock = new Clock(at('10:00'));
    const db = new Database(':memory:');
    const feed = new FakeFeed(clock);
    const engine = new Engine({
        cfg, db, logger: nullLogger, lotSizes: fakeLots, now: clock.now,
        marketData: new MarketDataService({ cfg, logger: nullLogger, fetchCandles: feed.fetchCandles, now: clock.now, retries: 0 }),
        strategyFactory: (def) => new SourceStrategy({ def, cfg }),
    });
    engine.init();
    const id = engine.traders[0].id;
    const sigId = db.insertSignal({ strategyId: id, sessionDate: '2026-10-06', symbol: 'RELIANCE', direction: 'LONG', signalType: 'SETUP', status: 'ACCEPTED', price: 1200, filterCondition: 'heatmap: test' });
    engine.positions.placeEntry({ strategyId: id, signalId: sigId, signal: { symbol: 'RELIANCE', direction: 'LONG', orderType: 'STOP_ENTRY', entry: 1200, stop: 1190, target: 1210, filterCondition: 'heatmap: test' }, sessionDate: '2026-10-06' });
    // Bars stay inside the stop/target band, so the position remains open.
    feed.set('RELIANCE', [bar('10:01', 1200, 1201, 1199, 1200), bar('10:02', 1200, 1201, 1199, 1200)]);
    clock.set('10:03');
    await engine.positions.monitor();
    const open = db.openTrades();
    assert.equal(open.length, 1, 'position stays open before the manual exit');
    const tid = open[0].id;

    const web = createServer(engine, { port: 0 });
    const base = await web.listen();
    try {
        const r = await fetch(`${base}/api/positions/${tid}/exit`, { method: 'POST' });
        assert.equal(r.status, 200);
        const body = await r.json();
        assert.equal(body.ok, true);
        const closed = db.getTrade(tid);
        assert.equal(closed.exit_reason, 'MANUAL_EXIT');
        assert.equal(db.openTrades().length, 0);
        // A second manual exit reports the trade is no longer open.
        const again = await fetch(`${base}/api/positions/${tid}/exit`, { method: 'POST' });
        assert.equal(again.status, 404);
        // Cross-origin exits are refused like the toggle.
        const forged = await fetch(`${base}/api/positions/${tid}/exit`, { method: 'POST', headers: { Origin: 'http://evil.example' } });
        assert.equal(forged.status, 403);
    } finally {
        await web.close();
    }
});

test('CSV helper escapes commas, quotes and newlines', () => {
    const csv = tradesToCsv([{ id: 1, symbol: 'M&M', filter_condition: 'a,b\n"c"' }]);
    assert.match(csv, /"a,b\n""c"""/);
});
