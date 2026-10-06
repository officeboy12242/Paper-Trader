// Shared test fixtures. Import config first: it normalises LOG_LEVEL for the vendored modules.
import { loadConfig } from '../src/config.js';
import { Database } from '../src/db/database.js';
import { nullLogger } from '../src/logger.js';
import { MarketDataService } from '../src/market/marketData.js';
import { istTimestamp } from '../src/market/clock.js';
import { createExecutionAdapter } from '../src/engine/execution.js';
import { PositionManager } from '../src/engine/positions.js';

/** A real NSE trading day (Tuesday) used by every test. */
export const DAY = '2026-10-06';
export const at = (hhmm, day = DAY) => istTimestamp(day, hhmm);

export function makeCfg(overrides = {}) {
    const keys = Object.keys(overrides);
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) process.env[k] = String(overrides[k]);
    try {
        return { ...loadConfig(), DATABASE_PATH: ':memory:' };
    } finally {
        for (const k of keys) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    }
}

export class Clock {
    constructor(ms) { this.t = ms; }
    now = () => this.t;
    set(hhmm, day = DAY) { this.t = at(hhmm, day); }
}

/** One 1-minute bar at an IST wall-clock time. */
export const bar = (hhmm, o, h, l, c, day = DAY) => ({ ts: at(hhmm, day), open: o, high: h, low: l, close: c, volume: 1000 });

/** Feed with per-symbol bars; only bars that have "happened" (ts <= now) are returned. */
export class FakeFeed {
    constructor(clock) {
        this.clock = clock;
        this.bars = new Map();
        this.fail = false;
        this.calls = 0;
    }
    set(symbol, bars) { this.bars.set(symbol, bars); }
    fetchCandles = async (yahooSymbol) => {
        this.calls += 1;
        if (this.fail) throw new Error('simulated API failure (HTTP 503)');
        const sym = yahooSymbol.replace(/\.NS$/, '');
        return (this.bars.get(sym) || []).filter((b) => b.ts <= this.clock.t);
    };
}

export const fakeLots = { resolve: (s) => ({ lotSize: s === 'RELIANCE' ? 500 : 100, source: 'test' }), refresh: async () => {} };

export function makeWorld(cfgOverrides = {}, { file = ':memory:', strategyById = () => null } = {}) {
    const cfg = makeCfg(cfgOverrides);
    const clock = new Clock(at('10:00'));
    const db = new Database(file);
    const feed = new FakeFeed(clock);
    const marketData = new MarketDataService({ cfg, logger: nullLogger, fetchCandles: feed.fetchCandles, now: clock.now, retries: 0, retryDelayMs: 0 });
    const closed = [];
    const positions = new PositionManager({ db, cfg, adapter: createExecutionAdapter(cfg), logger: nullLogger, marketData, lotSizes: fakeLots, now: clock.now, onTradeClosed: (t) => closed.push(t), strategyById });
    const sid = db.upsertStrategy({ key: 'test', code: 'Strategy-01', name: 'Test', source: 'test', sourceFiles: '', description: '', enabled: true });
    return { cfg, clock, db, feed, marketData, positions, sid, closed };
}

/** Insert an ACCEPTED signal row and place its order. */
export function place(world, signal, { strategyId = world.sid } = {}) {
    const signalId = world.db.insertSignal({ strategyId, sessionDate: DAY, symbol: signal.symbol, direction: signal.direction, timestamp: world.clock.t, price: signal.entry ?? signal.referencePrice, signalType: 'SETUP', status: 'ACCEPTED' });
    return world.positions.placeEntry({ strategyId, signalId, signal, sessionDate: DAY });
}
