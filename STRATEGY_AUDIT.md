# Strategy Audit: WA-BOT trading sources

Repository: https://github.com/officeboy12242/WA-BOT (branch `main`, commit `a9f334a`)
Local clone: `E:\Projects\WA-BOT`
Audit date: 2026-10-06

## 1. Scope

WA-BOT is a multi-purpose WhatsApp bot (courses, movies, stickers, news, moderation and more). Trading is one feature area among many. Per the project owner's instruction, this audit covers the **/tradelert discovery sources** only. The continuously running index scanners (SVMKR / UT Bot, scalp, liquidity sweep), and the on-demand tools (/expiry, /swing, /index, /backtest, /tradenow auto) are out of scope and are listed in section 9 for completeness.

The six sources are defined in one place, `src/utils/discoverySource.js`:

```js
export const DISCOVERY_SOURCES = ['heatmap', 'heatmap2', 'preopen', 'turnover', 'nse', 'legacy'];
```

The paper-trading platform registers strategies from this list at runtime, so adding or removing a source in the repository changes the number of traders without code edits in the platform.

## 2. End-to-end pipeline in the original bot

```
tradeAlertScheduler (09:20 IST default, extra clocks per source)
  -> TradeAlertController.postDailyAlerts()
     -> isIndianEquityTradingDay()            (weekend + NSE holiday calendar)
     -> REQUIRES a trade LLM key, else returns ("no trade LLM API key")
     -> TradeDiscoveryEngine.run({ source })  (deterministic per-source scan)
     -> for each symbol (max 8-10):
          _runDailyAnalysis(symbol)           (LLM call: CE/PE card with premiums)
          parseTradeSignal(body)              (AI confidence, BUY CE / BUY PE / NO TRADE)
          scoreConfluence(...)                (deterministic 0-100 score)
          _passesSendGates(...)               (see 2.1)
     -> post up to TRADE_ALERT_MAX_SENDS (5) alerts per group, sorted by AI confidence
     -> soft fallback: if none pass, AI>=70 and confluence>=25 may post
     -> _logPostedAlert() -> trade_alert_outcomes (Mongo)
TradeOutcomeResolver (16:15 IST) grades rows WIN / LOSS / EXPIRED / NO_DATA
```

### 2.1 Send gates (`TradeAlertController._passesSendGates`)

| Gate | Rule | Default |
|---|---|---|
| Watch-only session | blocked if market mode is watch-only and live entry not allowed | session from `getIndiaMarketMode()` |
| Freshness | discovery data must be < 5 min old | `checkQuoteFreshness` |
| AI confidence | `signal.isActionable && signal.confidence >= minConfidence` | 70 (calibration; 75 in strict macro mode) |
| Catalyst | blocked if a bearish catalyst headline marks the symbol AVOID | `CatalystRadarService` |
| Confluence | `confluence.score >= minConfluence` | 40 (`TRADE_ALERT_MIN_CONFLUENCE`) |
| Entry state | blocked on ENTRY_MISSED / NO_ACTIVE_ENTRY | `computeEntryState` |
| Soft fallback | AI >= 70 and confluence >= 25, only when the sole failure was confluence | `TRADE_ALERT_DAILY_SOFT_*` |
| Daily cap | 5 posts per group per day, gem slot reserved | `TRADE_ALERT_MAX_SENDS` |
| Dedupe | one alert per (group, date, symbol) | Mongo unique index |

### 2.2 Two layers, two instruments

1. **Discovery layer (deterministic, no AI).** Selects symbols. Four sources also compute an **equity setup on the underlying stock**: direction, entry, stop, target1, target2 in rupees per share.
2. **Analysis layer (LLM, required).** Produces a CE/PE option card. Entry, targets and stop are **option premiums**. The LLM is not given the discovery setup; it decides CE or PE independently from quote, news and option-chain context.

The repository itself grades outcomes on the **underlying equity levels** where a setup exists (`TradeOutcomeResolver`, `basis: 'levels'`), because historical option premiums are not retrievable. Premium-only rows are graded on direction only, and reported separately.

Observation: `_logPostedAlert` records `side` from the LLM (BUY_CE / BUY_PE) together with the setup's underlying levels. If the LLM picks the side opposite to the setup direction, the journal row mixes a long setup with a short side. The paper platform avoids this by requiring agreement (section 7).

## 3. The six sources

### 3.1 `heatmap` (v1): NSE Heatmap + 15m Opening Range + 8 EMA

- Files: `TradeDiscoveryEngine.runHeatmapBreakout`, `HeatmapBreakoutScanService.js`, `utils/ema.js`, `utils/yahooIntradayCandles.js`
- Universe: stocks in the top momentum sectors (`NSE_SECTOR_STOCKS`, 14 sector indices), padded from `FNO_UNIVERSE` (66 liquid F&O names) when fewer than 5 candidates.
- Sentiment: count sector indices with `indexPct > +0.05%` (green) vs `< -0.05%` (red). Majority sets BULLISH / BEARISH; ties fall back to macro bias (FII/DII, NIFTY %, VIX via `marketBiasScore`).
- Candidate filter: top 3 sectors in bias direction (bearish adds 2 more cold sectors), stock `|change| >= 2%` (`TRADE_ALERT_HEATMAP_MIN_MOVE_PCT`) in the bias direction, max 14 candidates.
- Setup (`evaluateOrEmaSetup`, 15m bars, today only):
  - OR = 09:15 candle.
  - Long: `close > OR.high`, solid green (body/range >= 0.55), `close > EMA8`, EMA slope >= 0.
  - Short: mirror (`close < OR.low`, solid red, below EMA8, slope <= 0).
  - Score 40 + solid 12 + OR 12 + EMA 10 + slope 8 + volume spike (>= 1.4x 8-bar avg) 10 + consolidation 8 + follow-through 10, capped 100. Best score of the day wins.
  - Entry: follow-through bar high (long) / low (short) when follow-through exists, else breakout bar extreme.
  - Stop: `min(breakout low, EMA8)` long; `max(breakout high, EMA8)` short.
  - Targets: `target15 = entry +/- 1.5R`, `target20 = entry +/- 2R`.
  - Status: `triggered` (follow-through), `breakout`, or `watch` (no levels).
- Output: up to 8 picks (`TRADE_ALERT_HEATMAP_MAX`).

### 3.2 `heatmap2`: live intraday sector momentum + VWAP / RS / ATR

- Files: `runHeatmapV2`, `HeatmapV2ScanService.js`, `utils/intradaySeries.js`, `utils/swingIndicators.js`, `data/nseHeatmapSectors.js`
- Universe: `HEATMAP_SECTORS` constituents (per-index lists drawn from the 248-name swing universe).
- Regime: NIFTY (`^NSEI`) daily close vs 200 DMA. Fails closed.
- Sentiment: sector counts beyond +/-0.3%, bias needs a spread of >= 3 sectors.
- Sides allowed: long if regime ok OR bullish; short if regime not ok OR bearish. Top 4 sectors per side, max 45 candidates.
- Per-symbol filters (one 15m `5d` series per symbol):
  - live move `|change| >= scaledMinMove(1.5%, bars)` (starts at 50% of threshold, full by bar 13)
  - side = sign of change, must be allowed
  - session turnover >= Rs 2 crore prorated over the first 8 bars
  - relative strength vs NIFTY must agree with side
  - before 3 NIFTY bars (pre-09:45): watch only, **no levels**
- Setup (`evaluateSetupV2`), walking back from the latest bar, max 6 bars old, breakout bar at or before 12:00 IST:
  - break: close beyond OR, solid body (>= 0.55), beyond EMA8
  - VWAP side must agree; follow-through (next bar exceeds breakout extreme) is mandatory
  - Entry: breakout bar high (long) / low (short), a resting stop order
  - Stop: `min(low, EMA8)` / `max(high, EMA8)`; rejected if risk > 2.0 x ATR14; widened to 0.6 x ATR14 if tighter
  - Targets: `T1 = entry +/- 1.0R`, `T2 = entry +/- 2.0R`; rejected if price already past T1
  - Score: VWAP 20, volume spike 18, follow-through 15, RS (>= 0.5pp 15, else 7), fresh (<= 2 bars) 12, consolidation 10, before noon 10. Minimum 60 (`HEATMAP_V2_MIN_SCORE`).
- Max 3 per sector (`HEATMAP_V2_MAX_PER_SECTOR`), max 8 picks.
- Schedule: shares 09:20, plus `TRADE_ALERT_MORNING_VOLATILITY_TIME` (09:35) and optional `TRADE_ALERT_HEATMAP2_TIMES`.

### 3.3 `preopen`: NSE pre-open auction (IEP + order imbalance)

- Files: `runPreOpen`, `PreOpenScanService.js`
- Data: `nseindia.com/api/market-data-pre-open?key=FO` (~208 F&O names), Yahoo daily candles (3 months) for ATR.
- Filters per row: auction turnover >= Rs 1 cr; `|gap vs board median| >= 0.3%`; order book present; `|imbalance| <= 0.98`; book imbalance must agree with gap direction.
- Score: turnover percentile x35 + move strength x30 + book strength x25 + ATO agreement x10.
- Setup (`buildPreOpenSetup`): entry = IEP (opening price); risk = 0.75 x daily ATR14 bounded to [0.6, 2.0] x ATR; stop = entry -/+ risk; T1 = +/-1R; T2 = +/-2R.
- Max 8 picks. Self-described as **unvalidated** (no history for the endpoint).
- Schedule: optional own clock `TRADE_ALERT_PREOPEN_TIME` (09:15), else 09:20.

### 3.4 `turnover`: previous-session turnover band, ranks 11-30, EMA 8/21

- Files: `runTurnoverBand`, `TurnoverBandScanService.js`
- Universe: `HEATMAP_UNIVERSE` + `NSE_SWING_UNIVERSE`, filtered to symbols present in NSE's live F&O pre-open list (static `FNO_UNIVERSE` fallback).
- Data: Yahoo daily candles, 6 months, per symbol.
- Filters: >= 40 candles; turnover (close x volume of last completed session) >= Rs 20 cr; rank by turnover; keep ranks 11-30 (`TURNOVER_BAND_FROM/TO`); daily ATR14 present; EMA stack must agree (`close > EMA8 > EMA21` long, mirror short).
- Score: trend strength in ATR units x 20, capped 100. Sorted by strength. Max 8.
- Setup (`buildSetup`): entry = last close; risk = 0.75 x ATR bounded [0.6, 2.0]; stop / T1 (1R) / T2 (2R).
- Self-described as **thin evidence** (n = 38-100 per band).
- Schedule: optional `TRADE_ALERT_TURNOVER_TIME`, else 09:20.

### 3.5 `nse`: NIFTY 50 top 5 gainers + top 5 losers

- Files: `runNseGainersLosers`, `NseMarketDataService.fetchNiftyTopGainersLosers`
- Data: `live-analysis-variations?index=gainers` and `?index=loosers` (NSE's spelling).
- Selection: top N each side (`TRADE_ALERT_NSE_GL_EACH`, default 5). Confluence scored.
- **No setup, no levels.** The only implied direction is the list membership (gainer / loser). Trade side and premium levels come only from the LLM card.

### 3.6 `legacy`: sectors + movers + smart money

- Files: `runLegacy`, `MarketScanService.js`, `SmartMoneyScanService.js`, `CatalystRadarService.js`, `MarketDeltaService.js`
- Data: Yahoo quotes for 66 `FNO_UNIVERSE` names + NIFTY/BANKNIFTY, NSE hot sectors, bulk/block deals, Google News RSS.
- Watchlist merge order: hidden gem, phase-4 picks (hot sector gainers and RS >= 1.5 with turnover >= Rs 500 cr), momentum alerts, smart-money deals, movers by `|change| x volume boost`. Finalized to 8-15 symbols (`TRADE_ALERT_DISCOVERY_COUNT`, default 10).
- Optional AI overlay (non-prescriptive source): LLM discovery prompt may add a hidden gem; skipped silently if no key.
- **No setup, no direction, no levels.** Everything tradeable comes from the LLM card.

## 4. Symbols and instruments

| Source | Universe | Instrument in original alert | Underlying levels |
|---|---|---|---|
| heatmap | sector stocks + 66 F&O names | Stock option CE/PE (LLM) | Yes (equity) |
| heatmap2 | `HEATMAP_SECTORS` constituents | Stock option CE/PE (LLM) | Yes (equity) |
| preopen | ~208 NSE F&O names | Stock option CE/PE (LLM) | Yes (equity) |
| turnover | swing + heatmap universe, F&O-eligible only | Stock option CE/PE (LLM) | Yes (equity) |
| nse | NIFTY 50 constituents | Stock option CE/PE (LLM) | No |
| legacy | 66 F&O names + sector leaders | Stock option CE/PE (LLM) | No |

Lot sizes: `src/data/nseLotSizes.js` (`getNseLotSize`, default 100 for unknown symbols). Example: RELIANCE 500, TCS 175, SBIN 750.

## 5. Targets, stops, trailing, exits in the original code

| Source | Stop | Target | Trailing | Exit / horizon |
|---|---|---|---|---|
| heatmap | breakout bar extreme or EMA8 | 1.5R (T1), 2R (T2) | none | session close |
| heatmap2 | bar extreme or EMA8, ATR-bounded 0.6-2.0x | 1.0R (T1), 2.0R (T2) | none | session close |
| preopen | 0.75 x daily ATR (bounded) | 1R, 2R | none | session close |
| turnover | 0.75 x daily ATR (bounded) | 1R, 2R | none | session close |
| nse | LLM premium SL | LLM premium T1/T2/T3 | none | n/a |
| legacy | LLM premium SL | LLM premium T1/T2/T3 | none | n/a |

Grading rules (`TradeOutcomeResolver.walkToOutcome`):
- entry is a **stop order**: it fills only once price trades through it
- after fill, stop and target are checked bar by bar; if both are inside one bar, the outcome is **LOSS** (pessimistic)
- intraday horizon is 8 hours (the posting session); unresolved filled trades are EXPIRED
- the LLM card suggests 50/30/20 partial booking across T1/T2/T3 (`TRADE_PLAN_PARTIALS`), display only

No trailing-stop logic exists in any of the six sources. (Trailing exists only in the excluded SVMKR UT-Bot and sweep scanners.)

## 6. Unit of "10" (minimum target)

Every level in these sources is a **rupee price per share** of an NSE equity (1 point = Rs 1). Lot P&L in the repo is computed as `points x lot quantity` (`tradePlanFormatter`, "1 lot, Rs P&L"). Therefore the platform interprets `MIN_TARGET=10` as **10 price points (Rs 10 per share) on the underlying**, so 1 lot of RELIANCE (500) at the minimum target earns Rs 5,000 gross. The unit is configurable (`MIN_TARGET_UNIT=points|rupees|percent`).

Known consequence: for low-priced F&O names (for example a Rs 100 stock), a 10-point target is a 10% move, which is larger than the 5% maximum stop and unlikely intraday. Those trades will usually close at the stop, the trailing stop, or the end-of-day square-off.

## 7. AI / LLM dependency

| Source | Discovery needs AI | Original posted alert needs AI | What AI decides |
|---|---|---|---|
| heatmap | No | **Yes** | CE/PE side, confidence >= 70 gate, premiums |
| heatmap2 | No | **Yes** | same |
| preopen | No | **Yes** | same |
| turnover | No | **Yes** | same |
| nse | No | **Yes** | **side and all levels** (no setup exists) |
| legacy | Optional overlay | **Yes** | **side and all levels** (no setup exists) |

- Provider chain (`TradeLlmRouterService`): OrcaRouter (DeepSeek V4 Flash, free) -> Gemini -> Groq -> NVIDIA NIM -> OpenRouter.
- Environment variables: `ORCAROUTER_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `NVIDIA_API_KEY`, `OPENROUTER_API_KEY` (any one is enough), plus optional `*_API_KEYS`, `TRADE_LLM_PROVIDERS`, model overrides.
- Functionality: chat completion of a fixed system prompt (`TRADE_ANALYSIS_SYSTEM_PROMPT`) returning a structured CE/PE text card, parsed by regex (`parseTradeSignal`).
- `StockSymbolResolverService` also calls NVIDIA on Yahoo lookup failure. Optional; Yahoo direct lookup comes first.

## 8. Data, storage, scheduling, UI

- Market data: NSE India JSON API with cookie warm-up (`nseClient.js`; blocks foreign datacenter IPs, proxy via `NSE_PROXY_URL` / `SCRAPER_API_KEY`), Yahoo Finance chart API (quotes, 15m intraday, daily), Google News RSS. No paid feed, no broker API, no websocket. Yahoo NSE data is typically delayed about 15 minutes for some feeds.
- Calendar: `indianMarketCalendar.js` (weekends, NSE holidays 2025-2027, force-open days, session modes PREMARKET / PREOPEN / MARKET_HOURS 09:15-15:30 / AFTER_HOURS).
- Storage: MongoDB (`trade_alert_sent`, `trade_discovery_cache`, `trade_alert_outcomes`, `trade_alert_calibration`, `trade_market_snapshots`). All discovery modules accept `mongoDb = null` and fall back to defaults (calibration 70 / 40).
- Scheduling: `tradeAlertScheduler.js` daily clocks; `outcomeResolverScheduler.js` 16:15; durable slot markers in Mongo.
- UI: web admin panel (`adminPanel.js`, `cyberGirlyDashboard.js`) for bot ops; no trading dashboard. Output channel is WhatsApp text.
- Delivery coupling: WhatsApp (Baileys) socket only for posting; none of the scan code needs it.

## 9. Excluded trading features (present in repo, out of scope by instruction)

SVMKR / UT Bot index scanner (`SvmkrScanService`, `SvmkrPositionTracker`), scalp cards and auto alerts (`ScalpService`, `ScalpAlertService`), liquidity sweep (`LiquiditySweepScanService`), expiry-day options (`ExpiryTradeService`), swing momentum (`SwingMomentumScanService`), /tradenow auto-trigger (LLM confidence), IndexStrategyEngine, NiftyBacktestService, option-chain AI, IPO alerts.

## 10. Further observations (upstream behaviour, preserved as-is)

- `HEATMAP_V2_MIN_MOVE_PCT`, `HEATMAP_V2_MIN_SCORE`, `HEATMAP_V2_MAX_PER_SECTOR` and `HEATMAP_V2_CONCURRENCY` are parsed in `config.js`, but `heatmapV2ScanService` is a singleton constructed with `{}`, so the coded defaults always apply (1.5%, 60, 3, 6).
- `nseLotSizes.js` is partly stale (for example KOTAKBANK 400 vs NSE's current 2000) and covers about 66 symbols, with 100 for everything else. The platform prefers NSE's official lot file and records which source was used.
- heatmap v1 keeps the highest-scoring break of the whole day, so a late scan can report an early entry level. Upstream documents this; the platform fills such orders at the current market (a stop order already through its trigger), not at the stale level.

## 11. Integration decisions (owner-approved 2026-10-06)

- The platform calls the **original code unchanged** from `vendor/wa-bot/src` (byte-identical to commit `a9f334a`, verified by `test/vendor.test.js`): `TradeAlertController.runDiscovery()`, `_passesSendGates()`, `_isSoftDailyEligible()`, `_selectDailyPosts()` and, when AI is on, `_runDailyAnalysis()`. No filter is re-implemented.
- Each source runs as an independent trader with its own controller instance. Six traders, discovered from `DISCOVERY_SOURCES`.
- **AI: "build now, AI later".** With no key: heatmap, heatmap2, preopen and turnover trade their own setups through every non-AI gate (session, freshness, catalyst block, confluence >= 40, soft fallback >= 25, daily cap 5). nse and legacy show AWAITING_AI. When any key is present in `.env`, the original AI gate switches on for all six automatically.
- **AI agreement (original behaviour):** with AI on, a setup source only trades when the AI side (BUY CE = long, BUY PE = short) matches the setup direction and passes AI >= 70%. nse and legacy trade the AI side at market with the platform risk overlay, because the source gives option premiums only.
- Instrument: the underlying equity setup (the levels WA-BOT itself grades), quantity `LOT_SIZE x lot size`, simulated like a stock-futures lot.
- Entry semantics follow `walkToOutcome`: resting stop order, fills only when traded through; pessimistic same-bar stop-before-target.
- Risk overlay: 5% hard stop (tighter source stop wins), 10-point minimum target (source target kept if further), trailing armed at the target, square-off at 15:20 IST.
- Trailing is a **platform addition** (no source has one): documented and configurable.
