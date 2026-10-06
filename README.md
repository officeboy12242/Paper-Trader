# PaperTrader

Multi-strategy **paper-trading** platform built from the trade-alert sources of [officeboy12242/WA-BOT](https://github.com/officeboy12242/WA-BOT). Each of the six `/tradelert` discovery sources runs as its own virtual trader, with its own statistics, on NSE intraday sessions.

> **PAPER TRADING MODE. LIVE TRADING DISABLED.** No broker is connected and no real order can be placed. All fills are simulated.

| Document | Contents |
|---|---|
| [STRATEGY_AUDIT.md](STRATEGY_AUDIT.md) | Every source, filter, level formula, AI and data dependency found in WA-BOT |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Pipeline, loops, execution and risk model, recovery, safety |
| [docs/DATABASE.md](docs/DATABASE.md) | SQLite schema and useful queries |
| [.env.example](.env.example) | Every setting with defaults |

## The six traders

| Code | Source | What it trades | Needs AI |
|---|---|---|---|
| Strategy-01 | `heatmap` | NSE sector heatmap + 15m opening-range break + 8 EMA | Optional (original gate) |
| Strategy-02 | `heatmap2` | Live sector momentum, VWAP / RS / ATR filters, fresh OR break | Optional (original gate) |
| Strategy-03 | `preopen` | Pre-open auction IEP gap with order-book agreement | Optional (original gate) |
| Strategy-04 | `turnover` | Turnover ranks 11-30, daily EMA 8/21 trend | Optional (original gate) |
| Strategy-05 | `nse` | NIFTY 50 top gainers / losers | **Yes** (no levels without it) |
| Strategy-06 | `legacy` | Hot sectors, momentum, smart money, movers | **Yes** (no levels without it) |

Strategies are discovered from WA-BOT's own `DISCOVERY_SOURCES` list, not hard-coded. The original strategy code is vendored unmodified in `vendor/wa-bot/src` and called directly.

## Requirements

- Node.js 22.13 or newer (uses the built-in `node:sqlite`; tested on Node 24.18, Windows 11)
- Internet access to `nseindia.com`, `nsearchives.nseindia.com`, `query1/query2.finance.yahoo.com`, `news.google.com`
- An Indian IP for NSE, or `NSE_PROXY_URL` / `SCRAPER_API_KEY` (NSE blocks many foreign datacentre IPs)
- Optional: one LLM key to enable the original AI gate and the nse / legacy traders

No paid market-data feed, broker account or database server is needed.

## Install

```powershell
cd E:\Projects\PaperTrader
npm install
copy .env.example .env      # then edit if needed
```

## Start

```powershell
npm start
```

Open the dashboard at **http://127.0.0.1:8080**. Stop with Ctrl+C (graceful: open positions stay in the database).

Dry run of every source without placing orders:

```powershell
npm run scan            # all sources
npm run scan heatmap2   # one source
```

## Run continuously (24/7)

All state is in SQLite, so any restart resumes open positions and pending orders and replays the bars it missed.

**Windows (this machine), watchdog:**

```powershell
deploy\windows\run-papertrader.cmd
```

Restarts the engine 5 seconds after any exit. Create a file named `STOP` in the project folder and stop the node process to end it. Output goes to `logs\run.log`.

**Windows, start at logon (Task Scheduler, no admin):**

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\install-task.ps1
Start-ScheduledTask -TaskName PaperTrader
# remove: ... install-task.ps1 -Uninstall
```

For a server that must run with nobody logged on, wrap `deploy\windows\run-papertrader.cmd` with NSSM (`nssm install PaperTrader cmd.exe /c <path>\run-papertrader.cmd`).

**pm2 (any OS):**

```bash
npm i -g pm2
pm2 start deploy/ecosystem.config.cjs
pm2 save
```

**Linux VPS (systemd):** see `deploy/linux/papertrader.service`.

**Render (recommended cloud option):** this repo ships a `render.yaml` blueprint.

1. Push this folder to GitHub so `package.json` is at the repo root (or set
   Render's Root Directory to the folder containing it).
2. Render Dashboard → New → Blueprint → select the repo. It provisions a
   `starter` web service (always-on — the free tier sleeps and has no disks,
   which would kill a 24/7 trader) with a 1 GB persistent disk for SQLite.
3. Add secrets in the dashboard (Environment tab): `ORCAROUTER_API_KEY`
   and/or `GEMINI_API_KEY` / `GROQ_API_KEY`. Never commit keys.
4. Deploy. The dashboard is served at your `*.onrender.com` URL; Render hits
   `GET /api/health` for health checks.

Notes: the build step (`npm install && npm run build`) compiles the React UI;
`DASHBOARD_HOST=0.0.0.0` and Render's injected `PORT` are honoured
automatically; logs stream to Render's log viewer and JSONL files persist on
the disk.

Health check for external monitors: `GET /api/health` (`status` OK / DEGRADED / FAIL) and the `kv.heartbeat` row, refreshed every minute.

## Enabling the AI gate

Put any one key in `.env` (never in the code or the dashboard):

```
ORCAROUTER_API_KEY=...   # or GEMINI_API_KEY / GROQ_API_KEY / NVIDIA_API_KEY / OPENROUTER_API_KEY
```

Restart. With `AI_GATE_MODE=auto` the original WA-BOT AI check turns on for all six traders: setups only trade when the AI side agrees and confidence is at least 70%, and nse / legacy start trading the AI side. Set `AI_GATE_MODE=off` to never call an LLM.

## Risk defaults

| Setting | Default | Meaning |
|---|---|---|
| `LOT_SIZE` | 1 | lots per trade; quantity = lots x NSE lot size |
| `MIN_TARGET` | 10 | points (Rs per share), the repo's price convention |
| `STOP_LOSS_PERCENT` | 5 | hard maximum from the fill; a tighter source stop wins |
| `TRAILING_ENABLED` | true | the target arms a trailing stop that only tightens |
| `TRAIL_DISTANCE` | 0.5 percent | distance from the best price |
| `TRAIL_LOCK_PCT` | 100 | on activation the stop locks the full target profit |
| `EOD_SQUARE_OFF` | 15:20 IST | every source is intraday |

## Dashboard

| Page | Contents |
|---|---|
| Dashboard | Overall P&L (total, today, unrealized), trades, wins, losses, win rate, profit factor, drawdown, equity curve, daily P&L, one TRADER card per strategy, sortable ranking |
| Strategy detail | Description, original source and files, status, schedule, current signal and positions, full statistics, equity curve, daily and monthly P&L, recent trades and signals (with rejection reasons), enable / disable |
| Live Monitor | Every open trade and pending order, colour coded (green profit, red loss, blue pending signal, amber trailing, grey stale) |
| Trade History | Filters (strategy, symbol, BUY/SELL, win/loss, dates, exit reason, P&L range) and CSV export |
| Ranking | Composite score by period, components and the formula with its weights |
| Event Log | Persisted trade lifecycle events |
| Risk & Config | Effective settings (no secrets) |

## Tests

```powershell
npm test                                  # 63 offline tests
$env:LIVE_TESTS="1"; npm test             # adds 7 live tests against NSE / Yahoo
```

Covered: strategy registration and isolation, signal generation for every source, invalid and duplicate signals, 5% stop LONG and SHORT, tighter source stop, minimum target, trailing (never loosens), 1-lot sizing, fills and gaps, EOD square-off, fees and P&L, win rate, drawdown, ranking, restart recovery with replay, database persistence and restart, API failure and reconnect, feed outage, missing price, holiday handling, safety (no live path, no secrets in the API), process boot and graceful shutdown, vendored code integrity.

## Logs

- Console: `[10:32:14] Strategy-01 SIGNAL BUY RELIANCE @ 1218.9`
- `logs/papertrader-YYYY-MM-DD.jsonl`: structured, one JSON object per line (signals, rejections, entries, exits, P&L, API failures, errors)
- `bot.log`: warnings from the vendored WA-BOT modules
- Database `trade_events`: every order and trade lifecycle event

## Known limitations

- Prices come from Yahoo 1-minute bars (about 10 seconds behind live in testing) and NSE public endpoints. They are not an exchange feed.
- NSE options are paper-traded on the live NSE option chain: the ATM CE leg is bought on a LONG setup and the ATM PE leg on a SHORT setup (`NSE_TRADE_OPTIONS=true`, default). Historical 1m premium bars are not available, so stops/targets/trailing are monitored against the polled chain premium (a synthetic 1m bar). This is a simulation of the option contract, not a live broker order.
- A 10-point minimum target is large for low-priced stocks (for example a Rs 13 stock). Those positions usually exit at the stop, the trail or the square-off. Use `MIN_TARGET_UNIT=percent` if preferred.
- Fee rates are configurable defaults; verify them against your broker.
