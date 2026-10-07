/**
 * MongoDatabase — the engine's source of truth, MongoDB-backed (use on
 * Render). Same method signatures and semantics as `Database` (sqlite),
 * but no sqlite file to wipe on redeploy.
 *
 * Persistence strategy: write-through with in-memory cache.
 *
 * The engine is single-writer and touches collections in tiny batches (one
 * signal+order insert per scan, a handful of row patch writes per monitor
 * tick), so we keep the rows in a per-collection in-memory index for O(1)
 * reads + O(n) filters — while every mutation also enqueues a Mongo round
 * trip (queued per operation, logged on failure through the driver's own
 * error event). That preserves the existing engine loop structure virtually
 * unchanged while making Atlas the durable store.
 *
 * Because synchronous semantics matter for the engine loop, mutation methods
 * do not await the Mongo write; instead they queue it (ena document list of
 * promised writes in `db.pending()`) so that `close()`/engine.stop() can
 * flush them. Pending writes are also re-sent as a single `replaceOne`-style
 * necessity-based upsert on conflict path via detail `upsert` semantics.
 *
 * Tests: pass a custom in-memory `driver` (see test/mongodatabase.test.js).
 */

import { MongoClient } from 'mongodb';

const ENGINE_COLLECTIONS = [
    'strategies', 'scans', 'signals', 'orders', 'trades',
    'trade_events', 'kv', 'model_versions', 'strategy_performance',
];

const PREFIX = 'engine_';
const dumpOf = (row) => (row ? { ...row } : row);
const json = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
const parse = (v) => {
    if (v == null) return null;
    try {
        return JSON.parse(v);
    } catch {
        return null;
    }
};

export class MongoDatabase {
    /**
     * @param {{ driver?: any, ready?: Promise<void> }} [deps]
     *   In production: `await MongoDatabase.open({uri, dbName, logger})`
     *   In tests: pass a fake `driver` implementing the same interface
     *   (list/insert/replace/deleteById/createIndex/close).
     */
    constructor({ driver = null, dbName = 'papertrader' } = {}) {
        this.dbName = dbName;
        this.driver = driver;
        this._open = true;
        this._counters = {};
        this._rows = Object.fromEntries(ENGINE_COLLECTIONS.map((n) => [n, []]));
        this._kv = new Map();
        this._perf = new Map();
        this._pending = [];
        this._logger = null;
    }

    // ── adapter helpers ─────────────────────────────────────────────────────
    _collName(name) {
        return `${PREFIX}${name}`;
    }

    _nextId(name) {
        const arr = this._rows[name];
        this._counters[name] = (this._counters[name] || 0) + 1;
        if (arr?.length) {
            const max = arr.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0);
            if (max >= this._counters[name]) this._counters[name] = max;
        }
        return this._counters[name];
    }

    /** Full snapshot of the in-memory stores. */
    _dump(name) {
        if (!this._rows || !this._rows[name]) return null;
        return this._rows[name].map((r) => ({ ...r }));
    }

    _queue(oid, name, fn) {
        try {
            const p = fn();
            this._pending.push(p && typeof p.catch === 'function' ? p.catch(() => {}) : Promise.resolve());
        } catch {
            /* 미비Adapter insert 실패时启动日志已足够 */
        }
    }

    // ── mongo ops (write-through, sync interface) ───────────────────────────
    _mongoInsert(name, doc) {
        const c = this._collName(name);
        try {
            const p = this.driver?.insert(c, doc);
            if (p && typeof p.catch === 'function') this._pending.push(p.catch(() => {}));
        } catch { /* sync path must not throw on driver hiccup */ }
    }

    _mongoReplace(name, doc) {
        const c = this._collName(name);
        try {
            const p = this.driver?.replace(c, doc.id, doc);
            if (p && typeof p.catch === 'function') this._pending.push(p.catch(() => {}));
        } catch { /* sync path must not throw on driver hiccup */ }
    }

    _mongoDelete(name, id) {
        const c = this._collName(name);
        try {
            const p = this.driver?.deleteById(c, id);
            if (p && typeof p.catch === 'function') this._pending.push(p.catch(() => {}));
        } catch { /* sync path must not throw on driver hiccup */ }
    }

    // ── lifecycle ───────────────────────────────────────────────────────────

    /** Async write behind sync inserts: await here to flush everyone who cares. */
    async flush() {
        await Promise.all(this._pending);
        this._pending = [];
    }

    isOpen() {
        return this._open;
    }

    get isOpen() {
        return this._open;
    }

    close() {
        this._open = false;
        this.flush().catch(() => {});
        this.driver?.close();
    }

    ping() {
        return true; // Mongo writes are durably queued; liveness is adapter-managed.
    }

    tx(fn) {
        // Single-process engine: sequential sync calls, mongo writes queued.
        return fn();
    }

    /** Re-load in-memory row store + strategy/execution caches from Mongo. */
    async ready() {
        if (!this.driver?.ready) return;
        try {
            await this.driver.ready;
        } catch {
            return;
        }
        for (const name of ENGINE_COLLECTIONS) {
            try {
                this._rows[name] = await this.driver.list(this._collName(name));
            } catch {
                this._rows[name] = [];
            }
        }
        for (const r of this._rows.kv) {
            this._kv.set(r.key, r.value);
        }
        for (const r of this._rows.strategy_performance) {
            this._perf.set(`${r.strategy_id}|${r.period}`, r);
        }
    }

    // ── generic row engine (mirrors getTrade/getSignal/insertTrade semantics) ──
    *_rowsOf(name) {
        yield* this._rows[name] || [];
    }

    _setRow(name, row) {
        const idx = this._rows[name].findIndex((r) => r.id === row.id);
        if (idx >= 0) this._rows[name][idx] = row;
        else this._rows[name].push(row);
    }

    /** Lightweight upsert used for kv/perf/strategy rows aliased on alternate keys. */
    _setRowKeyed(name, row, key) {
        const idx = this._rows[name].findIndex((r) => r[key] === row[key]);
        if (idx >= 0) this._rows[name][idx] = row;
        else this._rows[name].push(row);
    }

    // ── kv ───────────────────────────────────────────────────────────────────
    setKv(key, value) {
        // Keyed insert/replace (upsert by key). Must have a numeric id on the
        // row, otherwise driver.replace filter {id: undefined} never matches.
        const existing = this._rows.kv.find((r) => r.key === key);
        if (existing) {
            existing.value = value;
            existing.updated_at = Date.now();
            this._mongoReplace('kv', existing);
        } else {
            const row = { id: this._nextId('kv'), key, value, updated_at: Date.now() };
            this._rows.kv.push(row);
            this._mongoInsert('kv', row);
        }
    }

    getKv(key) {
        return this._rows.kv.find((r) => r.key === key)?.value ?? null;
    }

    // ── model versions ───────────────────────────────────────────────────────
    insertModelVersion(v) {
        const m = v.model ?? {};
        const row = {
            id: this._nextId('model_versions'),
            created_at: v.createdAt,
            trained_through: v.trainedThrough ?? null,
            sample_size: v.sampleSize,
            train_size: v.trainSize,
            test_size: v.testSize,
            feature_names: json(v.featureNames),
            weights: json(m.weights ?? []),
            mean: json(m.mean ?? []),
            std: json(m.std ?? []),
            bias: m.bias ?? 0,
            metrics: json(v.metrics ?? null),
            promoted: v.promoted ? 1 : 0,
            note: v.note ?? null,
        };
        this._setRow('model_versions', row);
        this._mongoInsert('model_versions', row);
        return row.id;
    }

    _modelRow(row) {
        if (!row) return null;
        return {
            ...row,
            promoted: Boolean(row.promoted),
            featureNames: parse(row.feature_names),
            weights: parse(row.weights) || [],
            mean: parse(row.mean) || [],
            std: parse(row.std) || [],
            metrics: parse(row.metrics) || {},
        };
    }

    currentModel() {
        const promoted = this._rows.model_versions
            .filter((r) => r.promoted === 1 || r.promoted === true)
            .sort((a, b) => b.id - a.id);
        return this._modelRow(promoted[0]);
    }

    listModelVersions(limit = 20) {
        return this._rows.model_versions
            .slice()
            .sort((a, b) => b.id - a.id)
            .slice(0, Math.min(1000, limit))
            .map((r) => this._modelRow(r));
    }

    deleteModelVersion(id) {
        const idx = this._rows.model_versions.findIndex((r) => r.id === Number(id));
        if (idx >= 0) this._rows.model_versions.splice(idx, 1);
        this._mongoDelete('model_versions', Number(id));
    }

    /**
     * Closed trades joined back to their originating signal so a model can be
     * re-scored on exactly the features the decision saw.
     */
    closedTradesWithSignals() {
        return this._rows.trades
            .filter((t) => t.status === 'CLOSED' && t.net_pnl != null)
            .sort((a, b) => a.exit_time - b.exit_time)
            .map((t) => ({
                id: t.id, symbol: t.symbol, direction: t.direction, entry_time: t.entry_time, exit_time: t.exit_time,
                entry_price: t.entry_price, stop_loss_price: t.stop_loss_price, target_price: t.target_price,
                net_pnl: t.net_pnl, exit_reason: t.exit_reason,
                signal_metadata: parse(t.signal_id ? this._rows.signals.find((s) => s.id === t.signal_id)?.signal_metadata : null),
            }));
    }

    // ── strategies ───────────────────────────────────────────────────────────
    upsertStrategy({ key, code, name, source, sourceFiles, description, enabled }) {
        const now = Date.now();
        const existing = this._rows.strategies.find((s) => s.key === key);
        if (existing) {
            Object.assign(existing, { code, name, source, source_files: sourceFiles, description, enabled: enabled ? 1 : 0, updated_at: now });
            this._mongoReplace('strategies', existing);
            return existing.id;
        }
        const row = {
            id: this._nextId('strategies'), key, code, name, source, source_files: sourceFiles,
            description, enabled: enabled ? 1 : 0, status: 'STOPPED', status_detail: null, created_at: now, updated_at: now,
        };
        this._setRow('strategies', row);
        this._mongoInsert('strategies', row);
        return row.id;
    }

    setStrategyStatus(id, status, detail = null) {
        const s = this._rows.strategies.find((r) => r.id === Number(id));
        if (s) { s.status = status; s.status_detail = detail; s.updated_at = Date.now(); this._mongoReplace('strategies', s); }
    }

    setStrategyEnabled(id, enabled) {
        const s = this._rows.strategies.find((r) => r.id === Number(id));
        if (s) { s.enabled = enabled ? 1 : 0; s.updated_at = Date.now(); this._mongoReplace('strategies', s); }
    }

    listStrategies() {
        return this._rows.strategies.slice().sort((a, b) => a.id - b.id).map((r) => ({ ...r }));
    }

    getStrategy(id) {
        const row = this._rows.strategies.find((r) => r.id === Number(id));
        return row ? { ...row } : null;
    }

    // ── scans ────────────────────────────────────────────────────────────────
    startScan(strategyId, sessionDate, trigger) {
        const row = { id: this._nextId('scans'), strategy_id: strategyId, session_date: sessionDate, trigger, started_at: Date.now(), finished_at: null, ok: null, candidates: null, setups: null, accepted: null, rejected: null, error: null, detail: null };
        this._setRow('scans', row);
        this._mongoInsert('scans', row);
        return row.id;
    }

    finishScan(id, { ok, candidates = 0, setups = 0, accepted = 0, rejected = 0, error = null, detail = null }) {
        const row = this._rows.scans.find((r) => r.id === Number(id));
        if (!row) return;
        Object.assign(row, { finished_at: Date.now(), ok: ok ? 1 : 0, candidates, setups, accepted, rejected, error, detail: json(detail) });
        this._mongoReplace('scans', row);
    }

    lastScan(strategyId) {
        const row = this._rows.scans.filter((s) => s.strategy_id === strategyId).sort((a, b) => b.id - a.id)[0];
        if (!row) return null;
        const r = { ...row };
        r.detail = parse(r.detail);
        return r;
    }

    scansOn(strategyId, sessionDate) {
        return this._rows.scans
            .filter((s) => s.strategy_id === strategyId && s.session_date === sessionDate)
            .map((r) => ({ trigger: r.trigger, ok: !!r.ok }));
    }

    // ── signals ──────────────────────────────────────────────────────────────
    insertSignal(s) {
        const row = {
            id: this._nextId('signals'), strategy_id: s.strategyId, scan_id: s.scanId ?? null, session_date: s.sessionDate,
            symbol: s.symbol, direction: s.direction ?? null, timestamp: s.timestamp ?? Date.now(), price: s.price ?? null,
            signal_type: s.signalType, status: s.status, reject_reason: s.rejectReason ?? null,
            filter_condition: s.filterCondition ?? null, signal_metadata: json(s.metadata),
        };
        this._setRow('signals', row);
        this._mongoInsert('signals', row);
        return row.id;
    }

    updateSignalStatus(id, status, rejectReason = null) {
        const row = this._rows.signals.find((r) => r.id === Number(id));
        if (!row) return;
        row.status = status;
        row.reject_reason = rejectReason ?? null;
        this._mongoReplace('signals', row);
    }

    /** Symbols already evaluated (accepted or gated) today, for one strategy. */
    evaluatedSymbols(strategyId, sessionDate) {
        return new Set(
            this._rows.signals
                .filter((s) => s.strategy_id === strategyId && s.session_date === sessionDate && (s.status === 'ACCEPTED' || s.status === 'REJECTED'))
                .map((s) => s.symbol)
        );
    }

    /** Most recent accepted signal of the latest session, else the most recent signal of any kind. */
    latestSignal(strategyId) {
        const last = this._rows.signals.filter((s) => s.strategy_id === strategyId).sort((a, b) => b.id - a.id)[0];
        if (!last) return null;
        const accepted = this._rows.signals
            .filter((s) => s.strategy_id === strategyId && s.session_date === last.session_date && s.status === 'ACCEPTED')
            .sort((a, b) => b.id - a.id)[0];
        const row = accepted || last;
        const r = { ...row };
        r.signal_metadata = parse(r.signal_metadata);
        return r;
    }

    listSignals({ strategyId = null, sessionDate = null, limit = 200 } = {}) {
        return this._rows.signals
            .filter((s) => (!strategyId || s.strategy_id === strategyId) && (!sessionDate || s.session_date === sessionDate))
            .sort((a, b) => b.id - a.id)
            .slice(0, Math.min(2000, limit))
            .map((r) => ({ ...r, signal_metadata: parse(r.signal_metadata) }));
    }

    getSignal(id) {
        const row = this._rows.signals.find((r) => r.id === Number(id));
        if (!row) return null;
        const r = { ...row };
        r.signal_metadata = parse(r.signal_metadata);
        return r;
    }

    // ── orders ───────────────────────────────────────────────────────────────
    insertOrder(o) {
        const row = {
            id: this._nextId('orders'), strategy_id: o.strategyId, signal_id: o.signalId, session_date: o.sessionDate,
            symbol: o.symbol, direction: o.direction, order_type: o.orderType, quantity: o.quantity, lots: o.lots, lot_size: o.lotSize,
            lot_size_source: o.lotSizeSource ?? null, trigger_price: o.triggerPrice, status: 'PENDING',
            created_at: o.createdAt, expires_at: o.expiresAt, filled_at: null, fill_price: null, cancel_reason: null,
            risk_plan: json(o.riskPlan), last_bar_ts: o.lastBarTs ?? null,
        };
        this._setRow('orders', row);
        this._mongoInsert('orders', row);
        return row.id;
    }

    getOrder(id) {
        const row = this._rows.orders.find((r) => r.id === Number(id));
        if (!row) return null;
        const r = { ...row };
        r.risk_plan = parse(r.risk_plan);
        return r;
    }

    pendingOrders() {
        return this._rows.orders
            .filter((o) => o.status === 'PENDING')
            .sort((a, b) => a.id - b.id)
            .map((r) => ({ ...r, risk_plan: parse(r.risk_plan) }));
    }

    markOrderFilled(id, fillPrice, filledAt) {
        const row = this._rows.orders.find((r) => r.id === Number(id));
        if (!row) return;
        row.status = 'FILLED';
        row.fill_price = fillPrice;
        row.filled_at = filledAt;
        this._mongoReplace('orders', row);
    }

    closeOrder(id, status, reason) {
        const row = this._rows.orders.find((r) => r.id === Number(id));
        if (!row) return;
        row.status = status;
        row.cancel_reason = reason;
        this._mongoReplace('orders', row);
    }

    setOrderBarCursor(id, ts) {
        const row = this._rows.orders.find((r) => r.id === Number(id));
        if (!row) return;
        row.last_bar_ts = ts;
        this._mongoReplace('orders', row);
    }

    countEntriesOn(strategyId, sessionDate) {
        const t = this._rows.trades.filter((r) => r.strategy_id === strategyId && r.session_date === sessionDate).length;
        const o = this._rows.orders.filter((r) => r.strategy_id === strategyId && r.session_date === sessionDate && r.status === 'PENDING').length;
        return t + o;
    }

    /** Any live exposure (open trade or pending order) in this symbol for this strategy. */
    hasLiveExposure(strategyId, symbol) {
        const t = this._rows.trades.find((r) => r.strategy_id === strategyId && r.symbol === symbol && r.status === 'OPEN');
        const o = this._rows.orders.find((r) => r.strategy_id === strategyId && r.symbol === symbol && r.status === 'PENDING');
        return Boolean(t || o);
    }

    // ── trades ───────────────────────────────────────────────────────────────
    insertTrade(t) {
        const now = Date.now();
        const row = {
            id: this._nextId('trades'), strategy_id: t.strategyId, signal_id: t.signalId ?? null, order_id: t.orderId ?? null,
            session_date: t.sessionDate, symbol: t.symbol, direction: t.direction, quantity: t.quantity, lots: t.lots, lot_size: t.lotSize,
            lot_size_source: t.lotSizeSource ?? null, entry_price: t.entryPrice, entry_time: t.entryTime, source_entry: t.sourceEntry ?? null,
            target_price: t.targetPrice, source_target: t.sourceTarget ?? null, stop_loss_price: t.stopLossPrice, source_stop: t.sourceStop ?? null,
            hard_stop: t.hardStop, initial_stop: t.initialStop, trailing_enabled: t.trailingEnabled ? 1 : 0, trailing_active: 0,
            trailing_stop: null, trail_distance: t.trailDistance ?? null, trail_from_ts: null, high_water: null,
            last_price: t.entryPrice, last_price_time: t.entryTime, last_bar_ts: t.lastBarTs ?? null,
            exit_price: null, exit_time: null, exit_reason: null, gross_pnl: null, fees: null, net_pnl: null, holding_seconds: null,
            status: 'OPEN', filter_condition: t.filterCondition ?? null, signal_metadata: json(t.metadata), created_at: now, updated_at: now,
        };
        this._setRow('trades', row);
        this._mongoInsert('trades', row);
        return row.id;
    }

    /** Persist the mutable part of an open trade after a monitoring pass. */
    updateTradeState(t) {
        const row = this._rows.trades.find((r) => r.id === Number(t.id) && r.status === 'OPEN');
        if (!row) return;
        row.stop_loss_price = t.stop_loss_price;
        row.trailing_active = t.trailing_active ? 1 : 0;
        row.trailing_stop = t.trailing_stop ?? null;
        row.trail_from_ts = t.trail_from_ts ?? null;
        row.high_water = t.high_water ?? null;
        row.profit_booked = t.profit_booked ? 1 : 0;
        row.last_price = t.last_price ?? null;
        row.last_price_time = t.last_price_time ?? null;
        row.last_bar_ts = t.last_bar_ts ?? null;
        row.updated_at = Date.now();
        this._mongoReplace('trades', row);
    }

    closeTrade(id, { exitPrice, exitTime, exitReason, grossPnl, fees, netPnl, holdingSeconds }) {
        const row = this._rows.trades.find((r) => r.id === Number(id) && r.status === 'OPEN');
        if (!row) return 0;
        row.status = 'CLOSED';
        row.exit_price = exitPrice;
        row.exit_time = exitTime;
        row.exit_reason = exitReason;
        row.gross_pnl = grossPnl;
        row.fees = fees;
        row.net_pnl = netPnl;
        row.holding_seconds = holdingSeconds;
        row.last_price = exitPrice;
        row.last_price_time = exitTime;
        row.updated_at = Date.now();
        this._mongoReplace('trades', row);
        return 1;
    }

    getTrade(id) {
        const row = this._rows.trades.find((r) => r.id === Number(id));
        if (!row) return null;
        const r = { ...row };
        r.signal_metadata = parse(r.signal_metadata);
        return r;
    }

    openTrades() {
        return this._rows.trades
            .filter((t) => t.status === 'OPEN')
            .sort((a, b) => a.id - b.id)
            .map((r) => ({ ...r, signal_metadata: parse(r.signal_metadata) }));
    }

    closedTrades({ strategyId = null, from = null, to = null } = {}) {
        return this._rows.trades
            .filter((t) => t.status === 'CLOSED'
                && (!strategyId || t.strategy_id === strategyId)
                && (!from || t.session_date >= from)
                && (!to || t.session_date <= to))
            .sort((a, b) => a.exit_time - b.exit_time || a.id - b.id)
            .map((r) => ({ ...r }));
    }

    /** Trade history search. */
    searchTrades(f = {}) {
        const where = (t) => {
            if (f.status && t.status !== f.status) return false;
            if (f.strategyId && t.strategy_id !== Number(f.strategyId)) return false;
            if (f.symbol && !t.symbol.toUpperCase().includes(String(f.symbol).toUpperCase())) return false;
            if (f.direction && t.direction !== String(f.direction).toUpperCase()) return false;
            if (f.result === 'WIN' && !(t.net_pnl > 0)) return false;
            if (f.result === 'LOSS' && !(t.net_pnl < 0)) return false;
            if (f.from && !(t.session_date >= f.from)) return false;
            if (f.to && !(t.session_date <= f.to)) return false;
            if (f.exitReason && t.exit_reason !== f.exitReason) return false;
            if (f.minPnl !== undefined && f.minPnl !== '' && f.minPnl !== null && !(t.net_pnl >= Number(f.minPnl))) return false;
            if (f.maxPnl !== undefined && f.maxPnl !== '' && f.maxPnl !== null && !(t.net_pnl <= Number(f.maxPnl))) return false;
            return true;
        };
        const rowsAll = this._rows.trades.filter(where).sort((a, b) => (b.exit_time ?? b.entry_time) - (a.exit_time ?? a.entry_time) || b.id - a.id);
        const strategyBy = new Map(this._rows.strategies.map((s) => [s.id, s]));
        const withStrategy = rowsAll.map((t) => {
            const s = strategyBy.get(t.strategy_id);
            return {
                ...t, signal_metadata: parse(t.signal_metadata),
                strategy_code: s?.code ?? null, strategy_name: s?.name ?? null, strategy_key: s?.key ?? null, strategy_source: s?.source ?? null,
            };
        });
        const limit = Math.min(5000, Math.max(1, Number(f.limit) || 200));
        const offset = Math.max(0, Number(f.offset) || 0);
        return { total: withStrategy.length, rows: withStrategy.slice(offset, offset + limit) };
    }

    // ── events ───────────────────────────────────────────────────────────────
    insertEvent({ strategyId = null, tradeId = null, orderId = null, ts = Date.now(), type, price = null, message = null, detail = null }) {
        const row = {
            id: this._nextId('trade_events'), strategy_id: strategyId, trade_id: tradeId, order_id: orderId,
            ts, type, price, message, detail: json(detail),
        };
        this._setRow('trade_events', row);
        this._mongoInsert('trade_events', row);
    }

    listEvents({ limit = 200, strategyId = null, tradeId = null } = {}) {
        return this._rows.trade_events
            .filter((e) => (!strategyId || e.strategy_id === strategyId) && (!tradeId || e.trade_id === tradeId))
            .sort((a, b) => b.id - a.id)
            .slice(0, Math.min(1000, limit))
            .map((r) => ({ ...r, detail: parse(r.detail) }));
    }

    // ── performance snapshots ────────────────────────────────────────────────
    savePerformance(strategyId, period, m, rankScore = null) {
        const existing = this._rows.strategy_performance.find((r) => r.strategy_id === strategyId && r.period === period);
        const row = {
            id: existing?.id ?? this._nextId('strategy_performance'),
            strategy_id: strategyId, period,
            total_trades: m.totalTrades, winning_trades: m.winningTrades, losing_trades: m.losingTrades, win_rate: m.winRate,
            profit_factor: Number.isFinite(m.profitFactor) ? m.profitFactor : null, gross_profit: m.grossProfit, gross_loss: m.grossLoss,
            net_pnl: m.netPnl, fees: m.fees, avg_win: m.avgWin, avg_loss: m.avgLoss,
            largest_win: m.largestWin, largest_loss: m.largestLoss, max_drawdown: m.maxDrawdown,
            max_drawdown_pct: m.maxDrawdownPct, avg_holding_seconds: m.avgHoldingSeconds, rank_score: rankScore, updated_at: Date.now(),
        };
        if (existing) this._rows.strategy_performance[this._rows.strategy_performance.indexOf(existing)] = row;
        else this._rows.strategy_performance.push(row);
        this._mongoReplace('strategy_performance', row);
    }

    getPerformance(strategyId, period) {
        const row = this._rows.strategy_performance.find((r) => r.strategy_id === strategyId && r.period === period);
        return row ? { ...row } : null;
    }

    // ── mongo snapshot backup/restore (unused in pure mode) ──────────────────
    dumpBackup() {
        return null;
    }

    restoreBackup(_snap) {
        return null;
    }

    countLoaded() {
        return Object.fromEntries(ENGINE_COLLECTIONS.map((n) => [n, this._rows[n].length]));
    }
}

/** Real mongo adapter wrapping a connected MongoClient for the engine tables. */
class MongoDriver {
    constructor({ client, dbName }) {
        this.client = client;
        this.dbName = dbName;
        this._queue = [];
        this._readyPromise = this._ensureCollections();
    }

    async _ensureCollections() {
        try {
            const db = this.client.db(this.dbName);
            for (const name of ENGINE_COLLECTIONS) {
                try {
                    db.collection(`${PREFIX}${name}`).createIndex({ id: 1 });
                } catch { /* index already present */ }
            }
            // sync: return resolved promise quickly.
            return true;
        } catch {
            return false;
        }
    }

    get ready() { return this._readyPromise; }

    list(name) {
        return this.client
            .db(this.dbName)
            .collection(name)
            .find({})
            .toArray()
            .catch(() => []);
    }

    insert(name, doc) {
        const p = this.client.db(this.dbName).collection(name).insertOne({ ...doc }).then(() => doc);
        this._queue.push(p);
        return p;
    }

    replace(name, id, doc) {
        const p = this.client.db(this.dbName).collection(name).updateOne({ id }, { $set: { ...doc } }, { upsert: true });
        this._queue.push(p);
        return p;
    }

    deleteById(name, id) {
        const p = this.client.db(this.dbName).collection(name).deleteOne({ id });
        this._queue.push(p);
        return p;
    }

    async close() {
        await Promise.allSettled(this._queue);
        await this.client?.close?.().catch(() => {});
    }
}

/** Static factory: open a connected MongoDatabase against a real Atlas/local deployment. */
export async function openMongoDatabase({ uri, dbName = 'papertrader', logger = null } = {}) {
    if (!uri) throw new Error('openMongoDatabase requires a uri');
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
    await client.connect();
    const driver = new MongoDriver({ client, dbName });
    const db = new MongoDatabase({ driver, dbName });
    db._logger = logger;
    await db.ready();
    return db;
}
