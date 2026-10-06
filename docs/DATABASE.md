# Database schema

SQLite through Node's built-in `node:sqlite`. File: `DATABASE_URL` (default `sqlite:./data/papertrader.db`), WAL journal, foreign keys on. Times are epoch milliseconds (UTC); `session_date` is the IST trading day `YYYY-MM-DD`. Schema source: `src/db/database.js`.

## strategies

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| key | TEXT UNIQUE | WA-BOT source key: heatmap, heatmap2, preopen, turnover, nse, legacy |
| code | TEXT | Strategy-01 ... Strategy-06 |
| name | TEXT | upstream label (`discoverySourceLabel`) |
| source | TEXT | attribution to the original repository |
| source_files | TEXT | upstream files implementing the source |
| description | TEXT | |
| enabled | INTEGER | dashboard toggle, persists across restarts |
| status / status_detail | TEXT | RUNNING, WAITING, AWAITING_AI, ERROR, DISABLED, STOPPED |
| created_at / updated_at | INTEGER | |

## scans

One row per scan attempt: `strategy_id, session_date, trigger (slot label), started_at, finished_at, ok, candidates, setups, accepted, rejected, error, detail (JSON)`.

## signals

| Column | Notes |
|---|---|
| id, strategy_id, scan_id, session_date | |
| symbol, direction | LONG / SHORT (null for watch-only) |
| timestamp, price | entry trigger, or reference price for AI market signals |
| signal_type | SETUP, AI_DIRECTION, WATCH, ANALYSIS |
| status | ACCEPTED, REJECTED, WATCH, ERROR |
| reject_reason | original gate reason (for example `confluence 25 < 40`, `AI < 70%`, `daily_limit`) |
| filter_condition | which source filter / checks produced it |
| signal_metadata | JSON: setup levels and checks, confluence, AI card summary, soft-gate flag |

## orders

`strategy_id, signal_id, session_date, symbol, direction, order_type (STOP_ENTRY | MARKET), quantity, lots, lot_size, lot_size_source, trigger_price, status (PENDING | FILLED | EXPIRED | CANCELLED), created_at, expires_at, filled_at, fill_price, cancel_reason, risk_plan (JSON: source entry/stop/targets), last_bar_ts`.

## trades

| Column | Notes |
|---|---|
| id, strategy_id, signal_id, order_id, session_date | attribution chain back to the source |
| symbol, direction, quantity, lots, lot_size, lot_size_source | |
| entry_price, entry_time, source_entry | fill vs the source's level |
| target_price, source_target | effective target vs source T1 |
| stop_loss_price | current stop (moves when trailing) |
| initial_stop, hard_stop, source_stop | the 5% boundary and the source stop kept for audit |
| trailing_enabled, trailing_active, trailing_stop, trail_distance, trail_from_ts, high_water | trailing state |
| last_price, last_price_time, last_bar_ts | monitoring cursor |
| exit_price, exit_time, exit_reason | TARGET, TRAILING_STOP, STOP_LOSS, EOD_SQUARE_OFF |
| gross_pnl, fees, net_pnl, holding_seconds | |
| status | OPEN / CLOSED |
| filter_condition, signal_metadata | copied from the signal |

## trade_events

Append-only lifecycle log: `ORDER_PLACED, ORDER_EXPIRED, ENTRY, TRAILING_ACTIVATED, TRAIL_RAISED, EXIT` with price, message and JSON detail.

## strategy_performance

Primary key `(strategy_id, period)`; period is `ALL`, `DAY:YYYY-MM-DD`, `WEEK:YYYY-Www`, `MONTH:YYYY-MM`. Columns: `total_trades, winning_trades, losing_trades, win_rate, profit_factor, gross_profit, gross_loss, net_pnl, fees, avg_win, avg_loss, largest_win, largest_loss, max_drawdown, max_drawdown_pct, avg_holding_seconds, rank_score, updated_at`. Computed only from that strategy's own closed trades.

## kv

`schema_version`, `heartbeat`, and the cached NSE lot file (`nse_lots`).

## Useful queries

```sql
-- per-strategy all-time results
SELECT s.code, s.key, p.total_trades, p.win_rate, p.net_pnl, p.profit_factor, p.max_drawdown_pct
FROM strategy_performance p JOIN strategies s ON s.id = p.strategy_id WHERE p.period = 'ALL';

-- why signals were rejected today
SELECT s.code, g.symbol, g.reject_reason FROM signals g JOIN strategies s ON s.id = g.strategy_id
WHERE g.session_date = date('now') AND g.status = 'REJECTED';
```
