/**
 * Engine: wires the pipeline and keeps it running.
 *
 *   Market data -> Strategy registry -> Traders (one per strategy)
 *     -> signal gating -> Risk manager -> Paper execution -> Position manager
 *     -> SQLite -> Statistics -> Dashboard API
 *
 * Two loops, each guarded against overlap and against its own exceptions:
 *   scheduler  every SCHEDULER_TICK_SECONDS: each trader decides if a scan is due
 *   monitor    every PRICE_POLL_SECONDS: fills, stops, targets, trailing, EOD
 * Nothing is held only in memory: a restart resumes from the database.
 */

import { createExecutionAdapter } from './execution.js';
import { PositionManager } from './positions.js';
import { Trader } from './trader.js';
import { discoverStrategies, scheduleFor } from '../strategies/registry.js';
import { SourceStrategy } from '../strategies/sourceStrategy.js';
import { GoldStrategy } from '../strategies/goldStrategy.js';
import { MongoStore } from '../db/mongo.js';
import { MarketDataService } from '../market/marketData.js';
import { LotSizeService } from '../market/lotSizes.js';
import { sessionPhase, sessionDate, weekKey, monthKey } from '../market/clock.js';
import { computeMetrics, equityCurve, pnlBy, filterPeriod, periodRange } from '../stats/statistics.js';
import { rankStrategies, rankingSettings } from '../stats/ranking.js';
import { publicConfig } from '../config.js';

export class Engine {
    /**
     * @param {object} o
     * @param {object} o.cfg
     * @param {import('../db/database.js').Database} o.db
     * @param {import('../logger.js').Logger} o.logger
     * @param {MarketDataService} [o.marketData]
     * @param {LotSizeService} [o.lotSizes]
     * @param {(def: object) => SourceStrategy} [o.strategyFactory]
     * @param {() => number} [o.now]
     */
    constructor({ cfg, db, logger, marketData = null, lotSizes = null, strategyFactory = null, now = Date.now }) {
        this.cfg = cfg;
        this.db = db;
        this.logger = logger;
        this.now = now;
        this.adapter = createExecutionAdapter(cfg);
        this.marketData = marketData || new MarketDataService({ cfg, logger, now });
        this.lotSizes = lotSizes || new LotSizeService({ cfg, db, logger, now });
        this.strategyFactory = strategyFactory || ((def) => (def.roundTheClock
            ? new GoldStrategy({ def, cfg, marketData: this.marketData, now })
            : new SourceStrategy({ def, cfg, now })));
        this.traders = [];
        this.codeById = new Map();
        // MongoDB mirror for future AI/RAG work. Optional and fully
        // asynchronous — trading never waits for it.
        this.mongo = new MongoStore({ uri: cfg.MONGODB_URI, dbName: cfg.MONGODB_DB, logger });
        this.positions = new PositionManager({
            db,
            cfg,
            adapter: this.adapter,
            logger,
            marketData: this.marketData,
            lotSizes: this.lotSizes,
            now,
            onTradeClosed: () => this.refreshStats(),
            codeOf: (id) => this.codeById.get(id) || `Strategy-${id}`,
            strategyById: (id) => this.traders.find((t) => t.id === id)?.def ?? null,
            mongo: this.mongo,
        });
        this.timers = [];
        this.running = false;
        this.startedAt = null;
        this.loops = {
            scheduler: { busy: false, lastStart: null, lastEnd: null, errors: 0 },
            monitor: { busy: false, lastStart: null, lastEnd: null, errors: 0 },
        };
        this._inflight = new Set();
    }

    /** Register strategies from the WA-BOT source list and build one trader each. */
    init() {
        const defs = discoverStrategies(this.cfg);
        const ctx = { cfg: this.cfg, db: this.db, logger: this.logger, positions: this.positions, marketData: this.marketData, mongo: this.mongo, now: this.now };
        const existing = new Map(this.db.listStrategies().map((s) => [s.key, s]));
        this.traders = defs.map((def) => {
            // A strategy toggled off in the dashboard stays off across restarts.
            const enabled = existing.has(def.key) ? Boolean(existing.get(def.key).enabled) && def.enabled : def.enabled;
            const id = this.db.upsertStrategy({ key: def.key, code: def.code, name: def.name, source: def.source, sourceFiles: def.sourceFiles, description: def.description, enabled });
            this.codeById.set(id, def.code);
            return new Trader({ def, strategyId: id, strategy: this.strategyFactory(def), ctx });
        });
        this.logger.info('ENGINE', 'REGISTRY', `${this.traders.length} strategies discovered: ${defs.map((d) => `${d.code}=${d.key}`).join(', ')}`);
        return this.traders;
    }

    /** Fast refresh of quotes for every live symbol (drives unrealized P&L). */
    async refreshOpenQuotes() {
        const symbols = new Set();
        for (const o of this.db.pendingOrders()) symbols.add(o.symbol);
        for (const t of this.db.openTrades()) symbols.add(t.symbol);
        if (!symbols.size) return;
        await Promise.all([...symbols].map(async (sym) => {
            try {
                if (sym.startsWith('OPT-')) {
                    const bar = await this.positions.optionsFeed.premiumBar(sym);
                    if (bar) this.marketData.setQuote(sym, bar.close, bar.ts);
                } else {
                    await this.marketData.getBars(sym, { continuous: true, range: '1d' });
                }
            } catch { /* feed hiccup — monitor retries soon */ }
        }));
    }

    async start() {
        if (this.running) return;
        if (!this.traders.length) this.init();
        this.running = true;
        this.startedAt = this.now();
        this.logger.info('ENGINE', 'START', 'PAPER TRADING MODE · LIVE TRADING DISABLED');
        const open = this.db.openTrades().length;
        const pending = this.db.pendingOrders().length;
        if (open || pending) this.logger.info('ENGINE', 'RECOVERY', `${open} open position(s), ${pending} pending order(s) restored from database`);
        await this.lotSizes.refresh().catch(() => {});
        this.refreshStats();
        this.marketData.startSpotSocket();
        this.mongo.connect().catch(() => {});
        // Bridge socket quotes into the quote map so unrealized P&L is live.
        // Socket map is keyed by Delta symbols (XAUTUSD/ETHUSD); bridge to ours.
        this._every('spot', 5_000, () => {
            for (const [sym, spot] of [['XAUUSD', 'XAUTUSD'], ['ETHUSD', 'ETHUSD']]) {
                const q = this.marketData.spotQuote(spot);
                if (q) this.marketData.setSpotQuote(sym, q.price, q.ts);
            }
        });

        // Monitor first so recovered positions are brought up to date before new scans.
        await this._loop('monitor', () => this.positions.monitor());
        this._every('monitor', this.cfg.PRICE_POLL_SECONDS * 1000, () => this.positions.monitor());
        this._every('quotes', 5_000, () => this.refreshOpenQuotes());
        this._every('scheduler', this.cfg.SCHEDULER_TICK_SECONDS * 1000, () => this.schedulerTick());
        this._every('stats', 5 * 60_000, async () => this.refreshStats());
        this._every('lots', 60 * 60_000, () => this.lotSizes.refresh());
        this._every('heartbeat', 60_000, async () => this.db.setKv('heartbeat', String(this.now())));
        this._loop('scheduler', () => this.schedulerTick());
    }

    _every(name, ms, fn) {
        const t = setInterval(() => this._loop(name, fn), ms);
        t.unref?.();
        this.timers.push(t);
    }

    async _loop(name, fn) {
        const st = (this.loops[name] ||= { busy: false, lastStart: null, lastEnd: null, errors: 0 });
        if (st.busy || !this.running) return;
        st.busy = true;
        st.lastStart = this.now();
        const p = (async () => {
            try {
                await fn();
            } catch (err) {
                st.errors += 1;
                this.logger.error('ENGINE', `${name.toUpperCase()} ERROR`, String(err?.stack || err));
            } finally {
                st.busy = false;
                st.lastEnd = this.now();
            }
        })();
        this._inflight.add(p);
        p.finally(() => this._inflight.delete(p));
        return p;
    }

    /**
     * Each trader ticks on its own track: a long scan (AI analysis can take
     * minutes) in one trader never delays another. `wait` is for tests.
     */
    async schedulerTick({ wait = false } = {}) {
        const runs = [];
        for (const t of this.traders) {
            if (t.busy) continue;
            const p = t.tick();
            this._inflight.add(p);
            p.finally(() => this._inflight.delete(p));
            runs.push(p);
        }
        if (wait) await Promise.all(runs);
    }

    /** Graceful shutdown: stop timers, wait for in-flight work, leave state in the DB. */
    async stop({ timeoutMs = 20_000 } = {}) {
        if (!this.running) return;
        this.running = false;
        for (const t of this.timers) clearInterval(t);
        this.timers = [];
        this.marketData.stopSpotSocket();
        await this.mongo.close().catch(() => {});
        const pending = [...this._inflight];
        if (pending.length) {
            this.logger.info('ENGINE', 'STOPPING', `waiting for ${pending.length} task(s)`);
            await Promise.race([Promise.allSettled(pending), new Promise((r) => setTimeout(r, timeoutMs))]);
        }
        for (const t of this.traders) t.setStatus('STOPPED', 'engine stopped');
        this.refreshStats();
        this.logger.info('ENGINE', 'STOPPED', 'state saved');
    }

    // ── statistics ───────────────────────────────────────────────────────────

    refreshStats() {
        const now = this.now();
        const today = sessionDate(now);
        const periods = { ALL: 'all', [`DAY:${today}`]: 'daily', [`WEEK:${weekKey(today)}`]: 'weekly', [`MONTH:${monthKey(today)}`]: 'monthly' };
        const ranking = this.ranking('all');
        const scoreById = new Map(ranking.rows.map((r) => [r.strategy.id, r.score]));
        for (const s of this.db.listStrategies()) {
            const trades = this.db.closedTrades({ strategyId: s.id });
            for (const [key, period] of Object.entries(periods)) {
                const m = computeMetrics(filterPeriod(trades, period, now), { capital: this.cfg.CAPITAL_PER_STRATEGY });
                this.db.savePerformance(s.id, key, m, key === 'ALL' ? scoreById.get(s.id) ?? null : null);
            }
        }
    }

    ranking(period = 'all') {
        const rows = this.db.listStrategies().map((s) => ({
            strategy: s,
            metrics: computeMetrics(filterPeriod(this.db.closedTrades({ strategyId: s.id }), period, this.now()), { capital: this.cfg.CAPITAL_PER_STRATEGY }),
        }));
        return { period, range: periodRange(period, this.now()), settings: rankingSettings(this.cfg), rows: rankStrategies(rows, this.cfg) };
    }

    // ── read models for the dashboard ────────────────────────────────────────

    overview() {
        const now = this.now();
        const all = this.db.closedTrades();
        const today = sessionDate(now);
        const open = this.positions.openPositionsView();
        const metricsAll = computeMetrics(all, { capital: this.cfg.CAPITAL_PER_STRATEGY * Math.max(1, this.traders.length) });
        const metricsToday = computeMetrics(all.filter((t) => t.session_date === today), { capital: this.cfg.CAPITAL_PER_STRATEGY * Math.max(1, this.traders.length) });
        return {
            safety: { paperTrading: true, liveTrading: false, executionMode: this.adapter.mode },
            session: sessionPhase(this.cfg, now),
            now,
            all: metricsAll,
            today: metricsToday,
            weekly: computeMetrics(filterPeriod(all, 'weekly', now)),
            monthly: computeMetrics(filterPeriod(all, 'monthly', now)),
            activePositions: open.length,
            pendingOrders: this.db.pendingOrders().length,
            unrealizedPnl: Math.round(open.reduce((s, t) => s + (t.unrealized_pnl || 0), 0) * 100) / 100,
            tradersRunning: this.traders.filter((t) => ['RUNNING', 'WAITING', 'AWAITING_AI'].includes(t.statusCache.status)).length,
            tradersTotal: this.traders.length,
            dailyPnl: pnlBy(all, 'day').slice(-30),
            equity: equityCurve(all),
        };
    }

    traderViews() {
        const open = this.positions.openPositionsView();
        const pending = this.db.pendingOrders();
        const rank = new Map(this.ranking('all').rows.map((r) => [r.strategy.id, r]));
        const today = sessionDate(this.now());
        return this.db.listStrategies().map((s) => {
            const trader = this.traders.find((t) => t.id === s.id);
            const positions = open.filter((t) => t.strategy_id === s.id);
            const r = rank.get(s.id);
            const todayTrades = this.db.closedTrades({ strategyId: s.id, from: today, to: today });
            return {
                id: s.id,
                key: s.key,
                code: s.code,
                name: s.name,
                source: s.source,
                sourceFiles: s.source_files,
                description: s.description,
                enabled: Boolean(s.enabled),
                status: s.status,
                statusDetail: s.status_detail,
                aiAvailable: trader ? trader.strategy.aiAvailable() : false,
                needsAiHint: trader ? trader.def.needsAiHint : false,
                schedule: trader ? { ...scheduleFor(trader.def, this.cfg), slots: trader.slots().map((x) => x.label) } : null,
                nextScanAt: trader && trader.def.roundTheClock ? (this.db.lastScan(s.id)?.finished_at ?? null) + 1000 * (trader.def.rescanMinutes ?? this.cfg.GOLD_SCAN_INTERVAL_MINUTES) * 60 : null,
                currentSignal: this.db.latestSignal(s.id),
                positions,
                pendingOrders: pending.filter((o) => o.strategy_id === s.id),
                lastScan: this.db.lastScan(s.id),
                lastError: trader?.lastError || null,
                rank: r ? { rank: r.rank, score: r.score, provisional: r.provisional } : null,
                metrics: r ? r.metrics : null,
                today: computeMetrics(todayTrades),
            };
        });
    }

    strategyDetail(id) {
        const s = this.db.getStrategy(Number(id));
        if (!s) return null;
        const view = this.traderViews().find((v) => v.id === s.id);
        const trades = this.db.closedTrades({ strategyId: s.id });
        return {
            ...view,
            metrics: computeMetrics(trades, { capital: this.cfg.CAPITAL_PER_STRATEGY }),
            periods: {
                today: computeMetrics(filterPeriod(trades, 'daily', this.now()), { capital: this.cfg.CAPITAL_PER_STRATEGY }),
                weekly: computeMetrics(filterPeriod(trades, 'weekly', this.now()), { capital: this.cfg.CAPITAL_PER_STRATEGY }),
                monthly: computeMetrics(filterPeriod(trades, 'monthly', this.now()), { capital: this.cfg.CAPITAL_PER_STRATEGY }),
            },
            equity: equityCurve(trades),
            dailyPnl: pnlBy(trades, 'day'),
            monthlyPnl: pnlBy(trades, 'month'),
            recentTrades: this.db.searchTrades({ strategyId: s.id, limit: 50 }).rows,
            recentSignals: this.db.listSignals({ strategyId: s.id, limit: 50 }),
            events: this.db.listEvents({ strategyId: s.id, limit: 100 }),
        };
    }

    setEnabled(id, enabled) {
        const s = this.db.getStrategy(Number(id));
        if (!s) return null;
        this.db.setStrategyEnabled(s.id, enabled);
        this.logger.info(this.codeById.get(s.id) || 'ENGINE', enabled ? 'ENABLED' : 'DISABLED', 'from dashboard');
        return this.db.getStrategy(s.id);
    }

    health() {
        const now = this.now();
        let dbOk = false;
        try {
            dbOk = this.db.ping();
        } catch {
            dbOk = false;
        }
        const ph = sessionPhase(this.cfg, now);
        const md = this.marketData.status();
        const monitorAgeS = this.loops.monitor.lastEnd ? Math.round((now - this.loops.monitor.lastEnd) / 1000) : null;
        const stalled = this.running && monitorAgeS != null && monitorAgeS > this.cfg.PRICE_POLL_SECONDS * 4;
        const traderErrors = this.traders.filter((t) => t.statusCache.status === 'ERROR').length;
        const ok = dbOk && !stalled && md.state !== 'DISCONNECTED';
        return {
            status: ok ? (traderErrors || md.state === 'DEGRADED' ? 'DEGRADED' : 'OK') : 'FAIL',
            now,
            uptimeSeconds: this.startedAt ? Math.round((now - this.startedAt) / 1000) : 0,
            running: this.running,
            paperTrading: true,
            liveTrading: false,
            database: { ok: dbOk },
            marketData: md,
            session: ph,
            loops: { ...this.loops, monitorAgeSeconds: monitorAgeS, stalled },
            lastMonitorPass: this.positions.lastPass,
            traders: this.traders.map((t) => ({ code: t.code, key: t.def.key, status: t.statusCache.status, detail: t.statusCache.detail, consecutiveErrors: t.consecutiveErrors })),
            memoryMb: Math.round(process.memoryUsage().rss / 1048576),
        };
    }

    publicConfig() {
        return publicConfig(this.cfg);
    }

    /** Live spot tick (gold or eth) for the dashboard hero panels. */
    async quoteFor(symbol, feed) {
        // Prefer the real-time socket quote; fall back to a fresh 1m bar.
        const live = this.marketData.spotQuote(symbol === 'ETHUSD' ? 'ETHUSD' : 'XAUTUSD');
        if (live && this.now() - live.ts < 15_000) {
            const cfg = this.cfg;
            const prefix = symbol === 'ETHUSD' ? 'ETH' : 'GOLD';
            return {
                symbol,
                feed: `${feed} · live socket`,
                price: live.price,
                barTs: live.ts,
                fetchedAt: this.now(),
                stale: false,
                marginInr: cfg[`${prefix}_MARGIN_INR`],
                leverage: cfg[`${prefix}_LEVERAGE`],
                stopRisk: cfg[`${prefix}_STOP_RISK`],
                minRR: cfg.MIN_RR,
            maxRR: cfg.MAX_RR,
            maxRiskInr: cfg.MAX_RISK_INR,
                inrUsdRate: cfg.INR_USD_RATE,
                traders: this.db.listStrategies().filter((s) => s.key.startsWith(prefix.toLowerCase())).map((s) => ({ id: s.id, code: s.code, key: s.key, name: s.name, status: s.status })),
            };
        }
        try { await this.marketData.getBars(symbol, { continuous: true, range: '1d' }); } catch { /* keep last known */ }
        const q = this.marketData.lastQuote(symbol);
        const cfg = this.cfg;
        const prefix = symbol === 'ETHUSD' ? 'ETH' : 'GOLD';
        return {
            symbol,
            feed,
            price: q?.price ?? null,
            barTs: q?.barTs ?? null,
            fetchedAt: q?.fetchedAt ?? null,
            stale: q ? this.marketData.isStale(symbol) : true,
            marginInr: cfg[`${prefix}_MARGIN_INR`],
            leverage: cfg[`${prefix}_LEVERAGE`],
            stopRisk: cfg[`${prefix}_STOP_RISK`],
            minRR: cfg.MIN_RR,
            maxRR: cfg.MAX_RR,
            maxRiskInr: cfg.MAX_RISK_INR,
            traders: this.db.listStrategies().filter((s) => s.key.startsWith(prefix.toLowerCase())).map((s) => ({ id: s.id, code: s.code, key: s.key, name: s.name, status: s.status })),
        };
    }

    async goldQuote() {
        return this.quoteFor('XAUUSD', 'XAUTUSD spot (Delta Exchange India, 1m)');
    }

    async ethQuote() {
        return this.quoteFor('ETHUSD', 'ETHUSD spot (Delta Exchange India, 1m)');
    }
}
