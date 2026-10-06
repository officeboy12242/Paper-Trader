/**
 * SQLite persistence (Node's built-in `node:sqlite`, no native build step).
 *
 * Every timestamp is epoch milliseconds (UTC). Session dates are IST
 * `YYYY-MM-DD` strings so "today" means the NSE trading day.
 */

import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS strategies (
    id              INTEGER PRIMARY KEY,
    key             TEXT NOT NULL UNIQUE,
    code            TEXT NOT NULL,
    name            TEXT NOT NULL,
    source          TEXT NOT NULL,
    source_files    TEXT,
    description     TEXT,
    enabled         INTEGER NOT NULL DEFAULT 1,
    status          TEXT NOT NULL DEFAULT 'STOPPED',
    status_detail   TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scans (
    id              INTEGER PRIMARY KEY,
    strategy_id     INTEGER NOT NULL REFERENCES strategies(id),
    session_date    TEXT NOT NULL,
    trigger         TEXT,
    started_at      INTEGER NOT NULL,
    finished_at     INTEGER,
    ok              INTEGER,
    candidates      INTEGER DEFAULT 0,
    setups          INTEGER DEFAULT 0,
    accepted        INTEGER DEFAULT 0,
    rejected        INTEGER DEFAULT 0,
    error           TEXT,
    detail          TEXT
);
CREATE INDEX IF NOT EXISTS ix_scans_strategy ON scans(strategy_id, started_at);

CREATE TABLE IF NOT EXISTS signals (
    id              INTEGER PRIMARY KEY,
    strategy_id     INTEGER NOT NULL REFERENCES strategies(id),
    scan_id         INTEGER REFERENCES scans(id),
    session_date    TEXT NOT NULL,
    symbol          TEXT NOT NULL,
    direction       TEXT,
    timestamp       INTEGER NOT NULL,
    price           REAL,
    signal_type     TEXT NOT NULL,
    status          TEXT NOT NULL,
    reject_reason   TEXT,
    filter_condition TEXT,
    signal_metadata TEXT
);
CREATE INDEX IF NOT EXISTS ix_signals_day ON signals(strategy_id, session_date, symbol);

CREATE TABLE IF NOT EXISTS orders (
    id              INTEGER PRIMARY KEY,
    strategy_id     INTEGER NOT NULL REFERENCES strategies(id),
    signal_id       INTEGER NOT NULL REFERENCES signals(id),
    session_date    TEXT NOT NULL,
    symbol          TEXT NOT NULL,
    direction       TEXT NOT NULL,
    order_type      TEXT NOT NULL,
    quantity        INTEGER NOT NULL,
    lots            INTEGER NOT NULL,
    lot_size        INTEGER NOT NULL,
    lot_size_source TEXT,
    trigger_price   REAL NOT NULL,
    status          TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL,
    filled_at       INTEGER,
    fill_price      REAL,
    cancel_reason   TEXT,
    risk_plan       TEXT,
    last_bar_ts     INTEGER
);
CREATE INDEX IF NOT EXISTS ix_orders_status ON orders(status);

CREATE TABLE IF NOT EXISTS trades (
    id              INTEGER PRIMARY KEY,
    strategy_id     INTEGER NOT NULL REFERENCES strategies(id),
    signal_id       INTEGER REFERENCES signals(id),
    order_id        INTEGER REFERENCES orders(id),
    session_date    TEXT NOT NULL,
    symbol          TEXT NOT NULL,
    direction       TEXT NOT NULL,
    quantity        INTEGER NOT NULL,
    lots            INTEGER NOT NULL,
    lot_size        INTEGER NOT NULL,
    lot_size_source TEXT,
    entry_price     REAL NOT NULL,
    entry_time      INTEGER NOT NULL,
    source_entry    REAL,
    target_price    REAL NOT NULL,
    source_target   REAL,
    stop_loss_price REAL NOT NULL,
    source_stop     REAL,
    hard_stop       REAL NOT NULL,
    initial_stop    REAL NOT NULL,
    trailing_enabled INTEGER NOT NULL,
    trailing_active INTEGER NOT NULL DEFAULT 0,
    trailing_stop   REAL,
    trail_distance  REAL,
    trail_from_ts   INTEGER,
    high_water      REAL,
    last_price      REAL,
    last_price_time INTEGER,
    last_bar_ts     INTEGER,
    exit_price      REAL,
    exit_time       INTEGER,
    exit_reason     TEXT,
    gross_pnl       REAL,
    fees            REAL,
    net_pnl         REAL,
    holding_seconds INTEGER,
    status          TEXT NOT NULL,
    filter_condition TEXT,
    signal_metadata TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_trades_status ON trades(status);
CREATE INDEX IF NOT EXISTS ix_trades_strategy ON trades(strategy_id, exit_time);

CREATE TABLE IF NOT EXISTS trade_events (
    id              INTEGER PRIMARY KEY,
    strategy_id     INTEGER,
    trade_id        INTEGER,
    order_id        INTEGER,
    ts              INTEGER NOT NULL,
    type            TEXT NOT NULL,
    price           REAL,
    message         TEXT,
    detail          TEXT
);
CREATE INDEX IF NOT EXISTS ix_events_ts ON trade_events(ts);

CREATE TABLE IF NOT EXISTS strategy_performance (
    strategy_id     INTEGER NOT NULL REFERENCES strategies(id),
    period          TEXT NOT NULL,
    total_trades    INTEGER NOT NULL,
    winning_trades  INTEGER NOT NULL,
    losing_trades   INTEGER NOT NULL,
    win_rate        REAL,
    profit_factor   REAL,
    gross_profit    REAL NOT NULL,
    gross_loss      REAL NOT NULL,
    net_pnl         REAL NOT NULL,
    fees            REAL NOT NULL,
    avg_win         REAL,
    avg_loss        REAL,
    largest_win     REAL,
    largest_loss    REAL,
    max_drawdown    REAL NOT NULL,
    max_drawdown_pct REAL NOT NULL,
    avg_holding_seconds REAL,
    rank_score      REAL,
    updated_at      INTEGER NOT NULL,
    PRIMARY KEY (strategy_id, period)
);

CREATE TABLE IF NOT EXISTS kv (
    key             TEXT PRIMARY KEY,
    value           TEXT,
    updated_at      INTEGER NOT NULL
);
`;

const json = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
const parse = (v) => {
    if (v == null) return null;
    try {
        return JSON.parse(v);
    } catch {
        return null;
    }
};
const plain = (row) => (row ? { ...row } : row);

export class Database {
    /** @param {string} file path or ':memory:' */
    constructor(file) {
        this.file = file;
        this.db = new DatabaseSync(file);
        this.db.exec('PRAGMA busy_timeout = 5000;');
        if (file !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
        this.db.exec('PRAGMA foreign_keys = ON;');
        this.db.exec(SCHEMA);
        // Lightweight migration: add profit_booked to existing databases.
        const cols = this.db.prepare(`PRAGMA table_info(trades)`).all().map((c) => c.name);
        if (!cols.includes('profit_booked')) {
            this.db.exec('ALTER TABLE trades ADD COLUMN profit_booked INTEGER NOT NULL DEFAULT 0');
        }
        this.setKv('schema_version', String(SCHEMA_VERSION));
        this._open = true;
    }

    get isOpen() {
        return this._open;
    }

    close() {
        if (!this._open) return;
        this._open = false;
        this.db.close();
    }

    /** Cheap liveness probe used by health monitoring. */
    ping() {
        return this.db.prepare('SELECT 1 AS ok').get()?.ok === 1;
    }

    tx(fn) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const out = fn();
            this.db.exec('COMMIT');
            return out;
        } catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }
    }

    // ── kv ───────────────────────────────────────────────────────────────────
    setKv(key, value) {
        this.db
            .prepare('INSERT INTO kv(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
            .run(key, value, Date.now());
    }

    getKv(key) {
        return this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value ?? null;
    }

    // ── strategies ───────────────────────────────────────────────────────────
    upsertStrategy({ key, code, name, source, sourceFiles, description, enabled }) {
        const now = Date.now();
        const existing = this.db.prepare('SELECT id FROM strategies WHERE key = ?').get(key);
        if (existing) {
            this.db
                .prepare('UPDATE strategies SET code = ?, name = ?, source = ?, source_files = ?, description = ?, enabled = ?, updated_at = ? WHERE id = ?')
                .run(code, name, source, sourceFiles, description, enabled ? 1 : 0, now, existing.id);
            return existing.id;
        }
        return Number(
            this.db
                .prepare('INSERT INTO strategies(key, code, name, source, source_files, description, enabled, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
                .run(key, code, name, source, sourceFiles, description, enabled ? 1 : 0, 'STOPPED', now, now).lastInsertRowid
        );
    }

    setStrategyStatus(id, status, detail = null) {
        this.db.prepare('UPDATE strategies SET status = ?, status_detail = ?, updated_at = ? WHERE id = ?').run(status, detail, Date.now(), id);
    }

    setStrategyEnabled(id, enabled) {
        this.db.prepare('UPDATE strategies SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, Date.now(), id);
    }

    listStrategies() {
        return this.db.prepare('SELECT * FROM strategies ORDER BY id').all().map(plain);
    }

    getStrategy(id) {
        return plain(this.db.prepare('SELECT * FROM strategies WHERE id = ?').get(id));
    }

    // ── scans ────────────────────────────────────────────────────────────────
    startScan(strategyId, sessionDate, trigger) {
        return Number(
            this.db.prepare('INSERT INTO scans(strategy_id, session_date, trigger, started_at) VALUES (?, ?, ?, ?)').run(strategyId, sessionDate, trigger, Date.now()).lastInsertRowid
        );
    }

    finishScan(id, { ok, candidates = 0, setups = 0, accepted = 0, rejected = 0, error = null, detail = null }) {
        this.db
            .prepare('UPDATE scans SET finished_at = ?, ok = ?, candidates = ?, setups = ?, accepted = ?, rejected = ?, error = ?, detail = ? WHERE id = ?')
            .run(Date.now(), ok ? 1 : 0, candidates, setups, accepted, rejected, error, json(detail), id);
    }

    lastScan(strategyId) {
        const row = plain(this.db.prepare('SELECT * FROM scans WHERE strategy_id = ? ORDER BY id DESC LIMIT 1').get(strategyId));
        if (row) row.detail = parse(row.detail);
        return row;
    }

    scansOn(strategyId, sessionDate) {
        return this.db.prepare('SELECT trigger, ok FROM scans WHERE strategy_id = ? AND session_date = ?').all(strategyId, sessionDate).map(plain);
    }

    // ── signals ──────────────────────────────────────────────────────────────
    insertSignal(s) {
        return Number(
            this.db
                .prepare(
                    `INSERT INTO signals(strategy_id, scan_id, session_date, symbol, direction, timestamp, price, signal_type, status, reject_reason, filter_condition, signal_metadata)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                )
                .run(
                    s.strategyId, s.scanId ?? null, s.sessionDate, s.symbol, s.direction ?? null, s.timestamp ?? Date.now(),
                    s.price ?? null, s.signalType, s.status, s.rejectReason ?? null, s.filterCondition ?? null, json(s.metadata)
                ).lastInsertRowid
        );
    }

    updateSignalStatus(id, status, rejectReason = null) {
        this.db.prepare('UPDATE signals SET status = ?, reject_reason = ? WHERE id = ?').run(status, rejectReason, id);
    }

    /** Symbols already evaluated (accepted or gated) today, for one strategy. */
    evaluatedSymbols(strategyId, sessionDate) {
        return new Set(
            this.db
                .prepare(`SELECT DISTINCT symbol FROM signals WHERE strategy_id = ? AND session_date = ? AND status IN ('ACCEPTED', 'REJECTED')`)
                .all(strategyId, sessionDate)
                .map((r) => r.symbol)
        );
    }

    /** Most recent accepted signal of the latest session, else the most recent signal of any kind. */
    latestSignal(strategyId) {
        const last = this.db.prepare('SELECT session_date FROM signals WHERE strategy_id = ? ORDER BY id DESC LIMIT 1').get(strategyId);
        const row = plain(
            (last && this.db.prepare(`SELECT * FROM signals WHERE strategy_id = ? AND session_date = ? AND status = 'ACCEPTED' ORDER BY id DESC LIMIT 1`).get(strategyId, last.session_date)) ||
                this.db.prepare('SELECT * FROM signals WHERE strategy_id = ? ORDER BY id DESC LIMIT 1').get(strategyId)
        );
        if (row) row.signal_metadata = parse(row.signal_metadata);
        return row;
    }

    listSignals({ strategyId = null, sessionDate = null, limit = 200 } = {}) {
        const where = [];
        const args = [];
        if (strategyId) { where.push('strategy_id = ?'); args.push(strategyId); }
        if (sessionDate) { where.push('session_date = ?'); args.push(sessionDate); }
        const sql = `SELECT * FROM signals ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
        return this.db.prepare(sql).all(...args, limit).map((r) => ({ ...r, signal_metadata: parse(r.signal_metadata) }));
    }

    // ── orders ───────────────────────────────────────────────────────────────
    insertOrder(o) {
        return Number(
            this.db
                .prepare(
                    `INSERT INTO orders(strategy_id, signal_id, session_date, symbol, direction, order_type, quantity, lots, lot_size, lot_size_source, trigger_price, status, created_at, expires_at, risk_plan, last_bar_ts)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?)`
                )
                .run(
                    o.strategyId, o.signalId, o.sessionDate, o.symbol, o.direction, o.orderType, o.quantity, o.lots, o.lotSize,
                    o.lotSizeSource ?? null, o.triggerPrice, o.createdAt, o.expiresAt, json(o.riskPlan), o.lastBarTs ?? null
                ).lastInsertRowid
        );
    }

    getOrder(id) {
        const row = plain(this.db.prepare('SELECT * FROM orders WHERE id = ?').get(id));
        if (row) row.risk_plan = parse(row.risk_plan);
        return row;
    }

    pendingOrders() {
        return this.db.prepare(`SELECT * FROM orders WHERE status = 'PENDING' ORDER BY id`).all().map((r) => ({ ...r, risk_plan: parse(r.risk_plan) }));
    }

    markOrderFilled(id, fillPrice, filledAt) {
        this.db.prepare(`UPDATE orders SET status = 'FILLED', fill_price = ?, filled_at = ? WHERE id = ?`).run(fillPrice, filledAt, id);
    }

    closeOrder(id, status, reason) {
        this.db.prepare('UPDATE orders SET status = ?, cancel_reason = ? WHERE id = ?').run(status, reason, id);
    }

    setOrderBarCursor(id, ts) {
        this.db.prepare('UPDATE orders SET last_bar_ts = ? WHERE id = ?').run(ts, id);
    }

    // ── trades ───────────────────────────────────────────────────────────────
    insertTrade(t) {
        const now = Date.now();
        return Number(
            this.db
                .prepare(
                    `INSERT INTO trades(strategy_id, signal_id, order_id, session_date, symbol, direction, quantity, lots, lot_size, lot_size_source,
                        entry_price, entry_time, source_entry, target_price, source_target, stop_loss_price, source_stop, hard_stop, initial_stop,
                        trailing_enabled, trailing_active, trailing_stop, trail_distance, high_water, last_price, last_price_time, last_bar_ts,
                        status, filter_condition, signal_metadata, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?)`
                )
                .run(
                    t.strategyId, t.signalId ?? null, t.orderId ?? null, t.sessionDate, t.symbol, t.direction, t.quantity, t.lots, t.lotSize,
                    t.lotSizeSource ?? null, t.entryPrice, t.entryTime, t.sourceEntry ?? null, t.targetPrice, t.sourceTarget ?? null,
                    t.stopLossPrice, t.sourceStop ?? null, t.hardStop, t.initialStop, t.trailingEnabled ? 1 : 0, t.trailDistance ?? null,
                    t.entryPrice, t.entryPrice, t.entryTime, t.lastBarTs ?? null, t.filterCondition ?? null, json(t.metadata), now, now
                ).lastInsertRowid
        );
    }

    /** Persist the mutable part of an open trade after a monitoring pass. */
    updateTradeState(t) {
        this.db
            .prepare(
                `UPDATE trades SET stop_loss_price = ?, trailing_active = ?, trailing_stop = ?, trail_from_ts = ?, high_water = ?,
                    last_price = ?, last_price_time = ?, last_bar_ts = ?, updated_at = ? WHERE id = ? AND status = 'OPEN'`
            )
            .run(
                t.stop_loss_price, t.trailing_active ? 1 : 0, t.trailing_stop ?? null, t.trail_from_ts ?? null, t.high_water ?? null,
                t.last_price ?? null, t.last_price_time ?? null, t.last_bar_ts ?? null, Date.now(), t.id
            );
    }

    closeTrade(id, { exitPrice, exitTime, exitReason, grossPnl, fees, netPnl, holdingSeconds }) {
        return this.db
            .prepare(
                `UPDATE trades SET status = 'CLOSED', exit_price = ?, exit_time = ?, exit_reason = ?, gross_pnl = ?, fees = ?, net_pnl = ?,
                    holding_seconds = ?, last_price = ?, last_price_time = ?, updated_at = ? WHERE id = ? AND status = 'OPEN'`
            )
            .run(exitPrice, exitTime, exitReason, grossPnl, fees, netPnl, holdingSeconds, exitPrice, exitTime, Date.now(), id).changes;
    }

    getTrade(id) {
        const row = plain(this.db.prepare('SELECT * FROM trades WHERE id = ?').get(id));
        if (row) row.signal_metadata = parse(row.signal_metadata);
        return row;
    }

    getSignal(id) {
        const row = plain(this.db.prepare('SELECT * FROM signals WHERE id = ?').get(Number(id)));
        if (row) row.signal_metadata = parse(row.signal_metadata);
        return row;
    }

    openTrades() {
        return this.db.prepare(`SELECT * FROM trades WHERE status = 'OPEN' ORDER BY id`).all().map((r) => ({ ...r, signal_metadata: parse(r.signal_metadata) }));
    }

    countEntriesOn(strategyId, sessionDate) {
        const t = this.db.prepare('SELECT COUNT(*) AS n FROM trades WHERE strategy_id = ? AND session_date = ?').get(strategyId, sessionDate).n;
        const o = this.db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE strategy_id = ? AND session_date = ? AND status = 'PENDING'`).get(strategyId, sessionDate).n;
        return Number(t) + Number(o);
    }

    /** Any live exposure (open trade or pending order) in this symbol for this strategy. */
    hasLiveExposure(strategyId, symbol) {
        const t = this.db.prepare(`SELECT 1 FROM trades WHERE strategy_id = ? AND symbol = ? AND status = 'OPEN' LIMIT 1`).get(strategyId, symbol);
        const o = this.db.prepare(`SELECT 1 FROM orders WHERE strategy_id = ? AND symbol = ? AND status = 'PENDING' LIMIT 1`).get(strategyId, symbol);
        return Boolean(t || o);
    }

    closedTrades({ strategyId = null, from = null, to = null } = {}) {
        const where = [`status = 'CLOSED'`];
        const args = [];
        if (strategyId) { where.push('strategy_id = ?'); args.push(strategyId); }
        if (from) { where.push('session_date >= ?'); args.push(from); }
        if (to) { where.push('session_date <= ?'); args.push(to); }
        return this.db.prepare(`SELECT * FROM trades WHERE ${where.join(' AND ')} ORDER BY exit_time, id`).all(...args).map(plain);
    }

    /**
     * Trade history search.
     * @param {object} f filters: strategyId, symbol, direction, result ('WIN'|'LOSS'), from, to, exitReason, minPnl, maxPnl, status, limit, offset
     */
    searchTrades(f = {}) {
        const where = [];
        const args = [];
        if (f.status) { where.push('t.status = ?'); args.push(f.status); }
        if (f.strategyId) { where.push('t.strategy_id = ?'); args.push(Number(f.strategyId)); }
        if (f.symbol) { where.push('t.symbol LIKE ?'); args.push(`%${String(f.symbol).toUpperCase()}%`); }
        if (f.direction) { where.push('t.direction = ?'); args.push(String(f.direction).toUpperCase()); }
        if (f.result === 'WIN') where.push('t.net_pnl > 0');
        if (f.result === 'LOSS') where.push('t.net_pnl < 0');
        if (f.from) { where.push('t.session_date >= ?'); args.push(f.from); }
        if (f.to) { where.push('t.session_date <= ?'); args.push(f.to); }
        if (f.exitReason) { where.push('t.exit_reason = ?'); args.push(f.exitReason); }
        if (f.minPnl !== undefined && f.minPnl !== '' && f.minPnl !== null) { where.push('t.net_pnl >= ?'); args.push(Number(f.minPnl)); }
        if (f.maxPnl !== undefined && f.maxPnl !== '' && f.maxPnl !== null) { where.push('t.net_pnl <= ?'); args.push(Number(f.maxPnl)); }
        const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const total = this.db.prepare(`SELECT COUNT(*) AS n FROM trades t ${w}`).get(...args).n;
        const limit = Math.min(5000, Math.max(1, Number(f.limit) || 200));
        const offset = Math.max(0, Number(f.offset) || 0);
        const rows = this.db
            .prepare(
                `SELECT t.*, s.code AS strategy_code, s.name AS strategy_name, s.key AS strategy_key, s.source AS strategy_source
                 FROM trades t JOIN strategies s ON s.id = t.strategy_id ${w}
                 ORDER BY COALESCE(t.exit_time, t.entry_time) DESC, t.id DESC LIMIT ? OFFSET ?`
            )
            .all(...args, limit, offset)
            .map((r) => ({ ...r, signal_metadata: parse(r.signal_metadata) }));
        return { total: Number(total), rows };
    }

    // ── events ───────────────────────────────────────────────────────────────
    insertEvent({ strategyId = null, tradeId = null, orderId = null, ts = Date.now(), type, price = null, message = null, detail = null }) {
        this.db
            .prepare('INSERT INTO trade_events(strategy_id, trade_id, order_id, ts, type, price, message, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(strategyId, tradeId, orderId, ts, type, price, message, json(detail));
    }

    listEvents({ limit = 200, strategyId = null, tradeId = null } = {}) {
        const where = [];
        const args = [];
        if (strategyId) { where.push('strategy_id = ?'); args.push(strategyId); }
        if (tradeId) { where.push('trade_id = ?'); args.push(tradeId); }
        return this.db
            .prepare(`SELECT * FROM trade_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`)
            .all(...args, limit)
            .map((r) => ({ ...r, detail: parse(r.detail) }));
    }

    // ── performance snapshots ────────────────────────────────────────────────
    savePerformance(strategyId, period, m, rankScore = null) {
        this.db
            .prepare(
                `INSERT INTO strategy_performance(strategy_id, period, total_trades, winning_trades, losing_trades, win_rate, profit_factor,
                    gross_profit, gross_loss, net_pnl, fees, avg_win, avg_loss, largest_win, largest_loss, max_drawdown, max_drawdown_pct,
                    avg_holding_seconds, rank_score, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(strategy_id, period) DO UPDATE SET
                    total_trades = excluded.total_trades, winning_trades = excluded.winning_trades, losing_trades = excluded.losing_trades,
                    win_rate = excluded.win_rate, profit_factor = excluded.profit_factor, gross_profit = excluded.gross_profit,
                    gross_loss = excluded.gross_loss, net_pnl = excluded.net_pnl, fees = excluded.fees, avg_win = excluded.avg_win,
                    avg_loss = excluded.avg_loss, largest_win = excluded.largest_win, largest_loss = excluded.largest_loss,
                    max_drawdown = excluded.max_drawdown, max_drawdown_pct = excluded.max_drawdown_pct,
                    avg_holding_seconds = excluded.avg_holding_seconds, rank_score = excluded.rank_score, updated_at = excluded.updated_at`
            )
            .run(
                strategyId, period, m.totalTrades, m.winningTrades, m.losingTrades, m.winRate, Number.isFinite(m.profitFactor) ? m.profitFactor : null,
                m.grossProfit, m.grossLoss, m.netPnl, m.fees, m.avgWin, m.avgLoss, m.largestWin, m.largestLoss, m.maxDrawdown,
                m.maxDrawdownPct, m.avgHoldingSeconds, rankScore, Date.now()
            );
    }

    getPerformance(strategyId, period) {
        return plain(this.db.prepare('SELECT * FROM strategy_performance WHERE strategy_id = ? AND period = ?').get(strategyId, period));
    }
}
