# Architecture

PaperTrader runs every WA-BOT `/tradelert` discovery source as an independent paper trader. It reuses the original strategy code unchanged and adds execution simulation, risk control, persistence, statistics and a dashboard.

## Pipeline

```
                 vendor/wa-bot/src  (unmodified upstream, commit a9f334a)
                 ┌──────────────────────────────────────────────────────┐
 NSE / Yahoo ──► │ TradeDiscoveryEngine.run(source)  (6 scanners)        │
 Google News     │ TradeAlertController: runDiscovery, _passesSendGates, │
 LLM (optional)  │   _isSoftDailyEligible, _selectDailyPosts,            │
                 │   _runDailyAnalysis (AI)                              │
                 └──────────────────────────────────────────────────────┘
                                   │
 Strategy Registry  src/strategies/registry.js        DISCOVERY_SOURCES -> 6 definitions
        │
 Strategy Workers   src/engine/trader.js               one Trader per strategy (own schedule,
        │                                              own controller, own error handling)
 Signal Engine      src/strategies/sourceStrategy.js   discover -> gate -> select (original code)
        │           src/engine/signals.js              validation, rejects invalid signals
 Risk Manager       src/engine/risk.js                 5% hard stop, min target, trailing
        │
 Paper Execution    src/engine/execution.js            PaperExecutionAdapter (the only adapter)
        │
 Position Manager   src/engine/positions.js            orders, fills, stops, targets, trail, EOD,
        │                                              replay of missed bars
 Database           src/db/database.js                 SQLite (node:sqlite), WAL
        │
 Statistics         src/stats/statistics.js, ranking.js
        │
 Dashboard          src/web/server.js + public/        JSON API, CSV, trader terminal UI
```

Market data (`src/market/marketData.js`) feeds the Position Manager with Yahoo 1-minute bars through the original WA-BOT fetcher. Lot sizes (`src/market/lotSizes.js`) come from NSE's official file with the WA-BOT table as fallback. The session clock (`src/market/clock.js`) delegates trading-day decisions to the original NSE holiday calendar.

## Runtime loops (src/engine/engine.js)

| Loop | Interval | Work |
|---|---|---|
| scheduler | `SCHEDULER_TICK_SECONDS` (20 s) | each trader checks if a scan slot is due; traders run concurrently and never block each other |
| monitor | `PRICE_POLL_SECONDS` (30 s) | fetch bars for every symbol with a pending order or open trade; fill, stop, target, trail, square-off |
| stats | 5 min and on every close | recompute `strategy_performance` (ALL, DAY, WEEK, MONTH) |
| lots | 60 min | refresh NSE lot sizes (cached per day) |
| heartbeat | 60 s | `kv.heartbeat` for external monitors |

Each loop is guarded against overlap and catches its own errors. A failing trader goes to `ERROR`, retries the slot after 2 minutes (3 attempts max), and the other traders continue.

## Scan schedule per strategy

Mirrors WA-BOT `tradeAlertScheduler`: every source first runs at `TRADE_ALERT_TIME` (09:20) unless it has its own clock; heatmap2 also runs at 09:35 (`TRADE_ALERT_MORNING_VOLATILITY_TIME`). Sources whose inputs change intraday (heatmap, heatmap2, nse, legacy) are then rescanned every `SCAN_INTERVAL_MINUTES` until `ENTRY_CUTOFF`. preopen (auction data) and turnover (previous session) are fixed for the day and scan once. After a late start, the latest missed slot runs immediately.

## Signal handling

1. `runDiscovery({ forceRefresh: true, persist: false, source })`: original discovery, including the AI hidden-gem overlay for legacy when a key exists.
2. Symbols already evaluated today, or with live exposure, are skipped (dedupe = WA-BOT `trade_alert_sent`).
3. Each remaining candidate is gated with the original `_passesSendGates`. Without AI, the AI terms are neutralised so the other gates still apply; with AI, `_runDailyAnalysis` produces the CE/PE signal and the side must match the setup.
4. Selection with the original `_selectDailyPosts` (gem slot, confidence order), soft fallback only when nothing strict passed, then the per-day cap.
5. Accepted signals are validated and placed as paper orders: `STOP_ENTRY` at the source entry, or `MARKET` for AI-direction signals with no levels.

Every decision is stored in `signals` with its reason, including rejections and watch-only names.

## Execution and risk model

- Fills are evaluated on 1-minute bars (minute-aligned). Stop entries fill when traded through; a bar that opens beyond the trigger fills at the open. Slippage `SLIPPAGE_BPS` applies to stop and market fills.
- Levels are computed from the actual fill: stop = tighter of the source stop and `fill x (1 -/+ 5%)`; target = further of the source T1 and `fill +/- MIN_TARGET`.
- Per bar: stop first, then target (pessimistic). Trailing off: exit at the target. Trailing on: the target arms the trail on the closed bar; the stop moves to the lock level and then follows the best price by `TRAIL_DISTANCE`; it only tightens, and only on closed bars.
- Square-off at `EOD_SQUARE_OFF` uses the last bar before the cut-off. With no data for 30 minutes after the cut-off, the last known price is used and the reason is recorded.
- Fees per leg: brokerage (min of flat and %), STT on the sell side, exchange charges, SEBI fee, stamp duty on the buy side, GST.

## Recovery and failure behaviour

Nothing lives only in memory. Orders and trades keep a bar cursor (`last_bar_ts`), so every pass, and every restart, replays bars after the cursor. A stop that printed while the process or the feed was down is filled at the price it printed (or the gap open). A feed failure leaves positions untouched and marks the feed `DEGRADED` / `DISCONNECTED`; each poll retries. Unexpected exceptions exit the process with code 1 so the process manager restarts it.

## Safety

- `PAPER_TRADING=false` refuses to start; `LIVE_TRADING_ENABLED` is a constant `false`.
- `createExecutionAdapter()` throws for any mode except `PAPER`; `PositionManager` refuses any adapter whose mode is not `PAPER`.
- No broker SDK is installed; a test scans `src/` for order endpoints.
- The dashboard binds to 127.0.0.1 by default, never receives secrets, and refuses cross-origin writes.

## Extending to live trading later

Add a new `ExecutionAdapter` subclass, extend the factory and the `PositionManager` guard deliberately, and add a separate order-routing step. The current design keeps the paper path as the only path so nothing can switch it by configuration alone.
