import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.NSE_TRADE_OPTIONS = 'false';
import { makeCfg, Clock, FakeFeed, fakeLots, at, DAY } from './helpers.js';
import TradeAlertController from '../vendor/wa-bot/src/controllers/TradeAlertController.js';
import { config as vendorConfig } from '../vendor/wa-bot/src/config/config.js';
import { DISCOVERY_SOURCES } from '../vendor/wa-bot/src/utils/discoverySource.js';
import { discoverStrategies, scheduleFor } from '../src/strategies/registry.js';
import { SourceStrategy, normalizeSetup } from '../src/strategies/sourceStrategy.js';
import { Database } from '../src/db/database.js';
import { Engine } from '../src/engine/engine.js';
import { MarketDataService } from '../src/market/marketData.js';
import { nullLogger } from '../src/logger.js';

const GROUPS = { getTradeAlertGroups: async () => [], getTradeAlertDiscoverySource: async () => null, getTradeAlertMode: async () => 'auto', getTradeAlertSymbols: async () => [] };
const gates = { minConfluence: 40, minConfidence: 70, watchOnly: false, allowsLiveEntry: true };

/** Discovery output in the exact shapes each original source produces. */
const FIXTURES = {
    heatmap: [{ symbol: 'HDFCLIFE', confluence: 45, setup: { status: 'triggered', direction: 'long', score: 92, entry: 547.2, stop: 541.52, target15: 555.72, target20: 558.56, checks: { solidBody: true } } },
        { symbol: 'TRENT', confluence: 45, setup: { status: 'watch', direction: 'long', score: 28 } }],
    heatmap2: [{ symbol: 'JSL', confluence: 45, setup: { direction: 'long', score: 88, entry: 755.9, stop: 749.98, target1: 761.82, target2: 767.74 } }],
    preopen: [{ symbol: 'TRENT', confluence: 40, setup: { direction: 'LONG', entry: 2800, stop: 2745.49, target1: 2854.51, target2: 2909.02, score: 90 } }],
    turnover: [{ symbol: 'SBIN', confluence: 40, setup: { direction: 'SHORT', entry: 957.6, stop: 967.9, target1: 947.3, target2: 937, score: 34 } }],
    nse: [{ symbol: 'KOTAKBANK', confluence: 50 }, { symbol: 'TECHM', confluence: 25 }],
    legacy: [{ symbol: 'RELIANCE', confluence: 55 }],
};

function fakeController(key, { fail = false, ai = null } = {}) {
    const c = new TradeAlertController(GROUPS, vendorConfig, null);
    c.calls = 0;
    c.runDiscovery = async () => {
        c.calls += 1;
        if (fail) throw new Error('NSE returned HTML challenge');
        const rows = FIXTURES[key] || [];
        return {
            symbols: rows.map((r) => r.symbol),
            symbolMeta: rows.map((r) => ({ symbol: r.symbol, sources: [`${key} test`], confluence: r.confluence, confluencePass: r.confluence >= 40, blocked: false, setup: r.setup || null })),
            gates,
            scannedAt: new Date(),
            movers: null,
            intelligence: { universeRows: rows.map((r) => ({ symbol: r.symbol, price: 1000 })) },
        };
    };
    if (ai) {
        c.tradeLlm = { isConfigured: () => true };
        c._runDailyAnalysis = async (symbol) => ({ body: `card ${symbol}`, entryState: null, signal: ai(symbol) });
    }
    return c;
}

function makeEngine({ controllerOpts = {}, cfgOverrides = {} } = {}) {
    const cfg = makeCfg({ SLIPPAGE_BPS: 0, ...cfgOverrides });
    const clock = new Clock(at('10:00'));
    const db = new Database(':memory:');
    const feed = new FakeFeed(clock);
    const marketData = new MarketDataService({ cfg, logger: nullLogger, fetchCandles: feed.fetchCandles, now: clock.now, retries: 0 });
    const controllers = {};
    const engine = new Engine({
        cfg, db, logger: nullLogger, marketData, lotSizes: fakeLots, now: clock.now,
        strategyFactory: (def) => new SourceStrategy({ def, cfg, now: clock.now, controller: (controllers[def.key] = fakeController(def.key, controllerOpts[def.key] || {})) }),
    });
    engine.init();
    return { engine, db, cfg, clock, feed, controllers, trader: (key) => engine.traders.find((t) => t.def.key === key) };
}

test('registry discovers every WA-BOT source automatically, one trader each', () => {
    const defs = discoverStrategies();
    const sources = defs.filter((d) => !d.roundTheClock);
    assert.equal(sources.length, DISCOVERY_SOURCES.length);
    assert.deepEqual(sources.map((d) => d.key), DISCOVERY_SOURCES);
    assert.deepEqual(sources.map((d) => d.code), DISCOVERY_SOURCES.map((_, i) => `Strategy-0${i + 1}`));
    for (const d of sources) assert.match(d.source, /WA-BOT/);
    const crypto = defs.filter((d) => d.roundTheClock);
    assert.ok(crypto.length >= 6, 'gold + eth 24h strategies registered');
    assert.ok(crypto.filter((d) => d.key.startsWith('gold_')).every((d) => /Gold 24h/.test(d.source)));
    assert.ok(crypto.filter((d) => d.key.startsWith('eth_')).every((d) => /ETH 24h/.test(d.source)));
});

test('schedules mirror the original clocks', () => {
    const cfg = makeCfg();
    const byKey = Object.fromEntries(discoverStrategies().map((d) => [d.key, scheduleFor(d, cfg)]));
    assert.deepEqual(byKey.heatmap.clock, ['09:20']);
    assert.ok(byKey.heatmap2.clock.includes('09:35'), 'heatmap2 morning-volatility slot');
    assert.equal(byKey.preopen.rescanMinutes, 0, 'auction data is fixed for the day');
    assert.equal(byKey.turnover.rescanMinutes, 0, 'previous-session data is fixed for the day');
    assert.equal(byKey.nse.rescanMinutes, 15);
});

test('every strategy initializes with its own original controller instance', () => {
    const defs = discoverStrategies().filter((d) => !d.roundTheClock);
    const strategies = defs.map((def) => new SourceStrategy({ def, cfg: makeCfg() }));
    assert.equal(strategies.length, DISCOVERY_SOURCES.length);
    assert.equal(new Set(strategies.map((s) => s.controller)).size, DISCOVERY_SOURCES.length, 'no shared controller state');
    for (const s of strategies) assert.equal(typeof s.controller._passesSendGates, 'function');
});

test('normalizeSetup understands all four original setup shapes', () => {
    assert.deepEqual(normalizeSetup(FIXTURES.heatmap[0].setup).target, 555.72);
    assert.equal(normalizeSetup(FIXTURES.heatmap[1].setup), null, 'watch has no levels');
    assert.equal(normalizeSetup(FIXTURES.heatmap2[0].setup).direction, 'LONG');
    assert.equal(normalizeSetup(FIXTURES.turnover[0].setup).direction, 'SHORT');
    assert.equal(normalizeSetup(null), null);
});

test('setup sources generate signals and paper orders without AI; nse/legacy wait for AI', async () => {
    const { engine, db, trader } = makeEngine();
    for (const t of engine.traders) await t.runScan('test', DAY);
    const orders = db.pendingOrders();
    const byKey = (k) => orders.filter((o) => o.strategy_id === trader(k).id);
    assert.equal(byKey('heatmap').length, 1);
    assert.equal(byKey('heatmap').at(0).symbol, 'HDFCLIFE');
    assert.equal(byKey('heatmap2').length, 1);
    assert.equal(byKey('preopen').length, 1);
    assert.equal(byKey('turnover').length, 1);
    assert.equal(byKey('turnover').at(0).direction, 'SHORT');
    assert.equal(byKey('nse').length, 0);
    assert.equal(byKey('legacy').length, 0);
    assert.equal(db.getStrategy(trader('nse').id).status, 'AWAITING_AI');
    const watch = db.listSignals({ strategyId: trader('heatmap').id }).find((s) => s.symbol === 'TRENT');
    assert.equal(watch.status, 'WATCH', 'watch-only heatmap name is recorded, not traded');
});

test('preopen/turnover confluence below 40 only passes through the original soft fallback', async () => {
    const { db, trader } = makeEngine({ cfgOverrides: { TRADE_ALERT_DAILY_SOFT_FALLBACK: 'false' } });
    await trader('preopen').runScan('test', DAY);
    const sig = db.listSignals({ strategyId: trader('preopen').id })[0];
    assert.equal(sig.status, 'ACCEPTED', 'confluence 40 meets the strict floor');

    FIXTURES.turnover[0].confluence = 25;
    try {
        await trader('turnover').runScan('test', DAY);
        const rej = db.listSignals({ strategyId: trader('turnover').id })[0];
        assert.equal(rej.status, 'REJECTED');
        assert.match(rej.reject_reason, /confluence 25 < 40/);
    } finally {
        FIXTURES.turnover[0].confluence = 40;
    }
});

test('soft fallback admits confluence >= 25 when nothing strict passed (original behaviour)', async () => {
    FIXTURES.turnover[0].confluence = 25;
    try {
        const { db, trader } = makeEngine();
        await trader('turnover').runScan('test', DAY);
        const s = db.listSignals({ strategyId: trader('turnover').id })[0];
        assert.equal(s.status, 'ACCEPTED');
        assert.equal(s.signal_metadata.softGate, true);
    } finally {
        FIXTURES.turnover[0].confluence = 40;
    }
});

test('with AI configured: nse trades the AI side; setup sources need AI agreement', async () => {
    const buyCe = () => ({ isActionable: true, confidence: 82, isBuyCall: true, isBuyPut: false, recommendation: '✅ BUY CE', ceConfidence: 82, peConfidence: 30 });
    const buyPe = () => ({ isActionable: true, confidence: 80, isBuyCall: false, isBuyPut: true, recommendation: '✅ BUY PE', ceConfidence: 20, peConfidence: 80 });
    const noTrade = () => ({ isActionable: false, confidence: 55, isBuyCall: false, isBuyPut: false, recommendation: '❌ NO TRADE', ceConfidence: 55, peConfidence: 40 });
    const { db, trader, controllers } = makeEngine({ controllerOpts: { nse: { ai: buyCe }, heatmap: { ai: buyPe }, heatmap2: { ai: buyCe }, legacy: { ai: noTrade } } });
    for (const k of ['nse', 'heatmap', 'heatmap2', 'legacy']) await trader(k).runScan('test', DAY);

    const nseOrders = db.pendingOrders().filter((o) => o.strategy_id === trader('nse').id);
    assert.equal(nseOrders.length, 1, 'TECHM confluence 25 is soft-only and KOTAKBANK strict, so only the strict pick trades');
    assert.equal(nseOrders[0].symbol, 'KOTAKBANK');
    assert.equal(nseOrders[0].order_type, 'MARKET');
    assert.equal(nseOrders[0].direction, 'LONG');

    const hm = db.listSignals({ strategyId: trader('heatmap').id }).find((s) => s.symbol === 'HDFCLIFE');
    assert.equal(hm.status, 'REJECTED');
    assert.match(hm.reject_reason, /disagrees with LONG setup/);
    assert.equal(controllers.heatmap.calls, 1);

    assert.equal(db.pendingOrders().filter((o) => o.strategy_id === trader('heatmap2').id).length, 1, 'AI CE agrees with long setup');
    const lg = db.listSignals({ strategyId: trader('legacy').id })[0];
    assert.equal(lg.status, 'REJECTED');
    assert.match(lg.reject_reason, /AI < 70%/);
});

test('invalid setup levels from a source are rejected, not traded', async () => {
    const saved = FIXTURES.heatmap2[0].setup;
    FIXTURES.heatmap2[0].setup = { ...saved, stop: 760 }; // stop above entry for a long
    try {
        const { db, trader } = makeEngine();
        await trader('heatmap2').runScan('test', DAY);
        const s = db.listSignals({ strategyId: trader('heatmap2').id })[0];
        assert.equal(s.status, 'REJECTED');
        assert.match(s.reject_reason, /not on the loss side/);
        assert.equal(db.pendingOrders().length, 0);
    } finally {
        FIXTURES.heatmap2[0].setup = saved;
    }
});

test('rescans do not duplicate signals or positions (same symbol, same day)', async () => {
    const { db, trader } = makeEngine();
    await trader('heatmap').runScan('clock 09:20', DAY);
    await trader('heatmap').runScan('rescan 09:35', DAY);
    await trader('heatmap').runScan('rescan 09:50', DAY);
    assert.equal(db.pendingOrders().length, 1);
    assert.equal(db.listSignals({ strategyId: trader('heatmap').id }).filter((s) => s.status === 'ACCEPTED').length, 1);
});

test('strategies stay isolated: one failing trader does not stop the others, stats never mix', async () => {
    const { engine, db, trader } = makeEngine({ controllerOpts: { heatmap: { fail: true } } });
    for (const t of engine.traders) await t.runScan('test', DAY);
    assert.equal(db.getStrategy(trader('heatmap').id).status, 'ERROR');
    assert.equal(db.pendingOrders().filter((o) => o.strategy_id === trader('heatmap2').id).length, 1);

    // Close one trade for heatmap2 only and check per-strategy stats.
    const o = db.pendingOrders().find((x) => x.strategy_id === trader('heatmap2').id);
    const tid = db.insertTrade({ strategyId: o.strategy_id, orderId: o.id, signalId: o.signal_id, sessionDate: DAY, symbol: o.symbol, direction: 'LONG', quantity: 100, lots: 1, lotSize: 100, entryPrice: 756, entryTime: at('10:01'), targetPrice: 766, stopLossPrice: 750, hardStop: 718, initialStop: 750, trailingEnabled: true });
    db.closeTrade(tid, { exitPrice: 766, exitTime: at('10:30'), exitReason: 'TARGET', grossPnl: 1000, fees: 50, netPnl: 950, holdingSeconds: 1740 });
    const rk = engine.ranking('all').rows;
    const get = (k) => rk.find((r) => r.strategy.key === k).metrics;
    assert.equal(get('heatmap2').totalTrades, 1);
    assert.equal(get('heatmap2').netPnl, 950);
    for (const k of ['heatmap', 'preopen', 'turnover', 'nse', 'legacy']) assert.equal(get(k).totalTrades, 0, `${k} must not see heatmap2's trade`);
});

test('daily cap mirrors TRADE_ALERT_MAX_SENDS', async () => {
    const { engine, db, trader } = makeEngine({ cfgOverrides: { MAX_TRADES_PER_STRATEGY_PER_DAY: 1 } });
    FIXTURES.heatmap2.push({ symbol: 'GAIL', confluence: 45, setup: { direction: 'long', score: 60, entry: 170.35, stop: 169.19, target1: 171.51, target2: 172.67 } });
    try {
        await trader('heatmap2').runScan('test', DAY);
        assert.equal(db.pendingOrders().filter((o) => o.strategy_id === trader('heatmap2').id).length, 1);
        const gail = db.listSignals({ strategyId: trader('heatmap2').id }).find((s) => s.symbol === 'GAIL');
        assert.equal(gail.reject_reason, 'daily_limit');
        assert.ok(engine);
    } finally {
        FIXTURES.heatmap2.pop();
    }
});
