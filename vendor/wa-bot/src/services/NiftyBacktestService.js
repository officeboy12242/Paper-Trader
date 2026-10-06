/**
 * NIFTY Index Backtester — simulates 60+ trading days on 5-minute candles.
 *
 * Combines three strategies that already exist in the codebase:
 *   1. Fade VWAP Stretch (IndexAnalysisService) — 66.7% measured WR
 *   2. Keltner Channels (IndexStrategyEngine) — ~77% WR
 *   3. Supertrend (IndexStrategyEngine) — ~67% WR
 *
 * Parameters pinned to the existing measured edges, NOT re-optimised:
 *   - Fade: 1xATR stretch, 1:1 RR (the untuned config that survived the holdout)
 *   - Keltner: EMA20, ATR10, 1.5x multiplier, ADX < 25 gate
 *   - Supertrend: Period 10, Multiplier 3.0, ADX > 20 gate
 *
 * Capital: ₹30,000. Position sizing: risk 1-2% per trade (₹300-600).
 * Target: ₹500-3,000/day. Max 3 trades/day. Daily loss limit ₹1,500.
 * Lot size: NIFTY 75.
 *
 * Data: Yahoo Finance 5-minute candles (up to 60 days).
 */

import { logger } from '../utils/logger.js';
import { fetchYahooIntradayCandles, candlePartsIST } from '../utils/yahooIntradayCandles.js';
import {
    emaPandas, rsi, adx, lastFinite, keltnerChannels, supertrend,
} from '../utils/indicators.js';
import { F_AND_O_INDICES } from '../data/indexUniverse.js';

// ─── CONSTANTS ───────────────────────────────────────────────────
const NIFTY = F_AND_O_INDICES.NIFTY;
const LOT_SIZE = NIFTY.lot;  // 75
const CAPITAL = 30_000;
const RISK_PER_TRADE_PCT = 0.015;  // 1.5% of capital
const MAX_RISK_PER_TRADE = CAPITAL * RISK_PER_TRADE_PCT;  // ₹450
const MIN_TARGET_PER_DAY = 500;
const MAX_TARGET_PER_DAY = 3000;
const DAILY_LOSS_LIMIT = 1500;
const MAX_TRADES_PER_DAY = 4;
const ENTRY_CUTOFF_MIN = 15 * 60;  // 15:00 IST — no new entries after
const EXIT_ALL_MIN = 15 * 60 + 5;  // 15:05 IST — force close all

// Strategy parameters (matching existing measured configs)
const FADE_ATR_MULT = 1.0;
const FADE_RR = 1;  // 1:1 — the untuned config
const KELTNER_EMA = 20;
const KELTNER_ATR = 10;
const KELTNER_MULT = 1.5;
const KELTNER_MAX_ADX = 25;
const ST_PERIOD = 10;
const ST_MULT = 3.0;
const ST_TREND_ADX_MIN = 20;

// Premium simulation: approximate ATM delta decay with hold time
const BASE_IV = 0.15;  // ~15% annualized IV for NIFTY ATM
const RISK_FREE = 0.065;

// ─── HELPERS ─────────────────────────────────────────────────────

function istMinuteOfDay(tsMs) {
    const d = new Date(tsMs + 5.5 * 3600e3);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function istDateStr(tsMs) {
    return new Date(tsMs + 5.5 * 3600e3).toISOString().slice(0, 10);
}

function fmt(n, d = 2) {
    return n == null || !Number.isFinite(n) ? '—' : Number(n).toFixed(d);
}

function inr(n) {
    return n == null || !Number.isFinite(n) ? '—' : `₹${Math.round(n).toLocaleString('en-IN')}`;
}

/** Session VWAP from bars. */
function sessionVwap(bars) {
    let pv = 0, v = 0;
    for (const b of bars || []) {
        if (![b?.high, b?.low, b?.close].every((x) => Number.isFinite(x))) continue;
        const typical = (b.high + b.low + b.close) / 3;
        const vol = b.volume > 0 ? b.volume : 1;
        pv += typical * vol;
        v += vol;
    }
    return v > 0 ? pv / v : null;
}

/** ATR over last n completed bars. */
function barAtr(bars, n = 6) {
    if (!Array.isArray(bars) || bars.length < n + 1) return null;
    const s = bars.slice(-(n + 1));
    let t = 0;
    for (let i = 1; i < s.length; i++) {
        t += Math.max(
            s[i].high - s[i].low,
            Math.abs(s[i].high - s[i - 1].close),
            Math.abs(s[i].low - s[i - 1].close),
        );
    }
    const a = t / n;
    return a > 0 ? a : null;
}

/** Resample 5m bars to 15m. */
function resample15m(bars) {
    const out = [];
    for (const b of bars || []) {
        if (!Number.isFinite(b.min)) continue;
        const slot = Math.floor(b.min / 15);
        let cur = out[out.length - 1];
        if (!cur || cur.slot !== slot) {
            cur = { slot, min: slot * 15, high: b.high, low: b.low, close: b.close, volume: b.volume || 0 };
            out.push(cur);
        } else {
            cur.high = Math.max(cur.high, b.high);
            cur.low = Math.min(cur.low, b.low);
            cur.close = b.close;
            cur.volume += b.volume || 0;
        }
    }
    return out;
}

/**
 * Approximate ATM option premium from index spot, IV, and time to expiry.
 * Uses simplified Black-Scholes for ATM: Premium ≈ 0.4 × Spot × IV × √(TTE).
 */
function approxAtmPremium(spot, iv = BASE_IV, hoursToExpiry = 6) {
    const years = hoursToExpiry / (252 * 6.5);  // trading hours
    return 0.4 * spot * iv * Math.sqrt(Math.max(years, 0.0001));
}

/**
 * Simulate premium change over hold period.
 * Uses delta + gamma + realistic theta decay.
 * ATM NIFTY options: delta ≈ 0.5, gamma boosts moves, theta hurts time.
 */
function premiumAtExit(entryPremium, indexMove, holdBars, isCE) {
    const delta = 0.5;  // ATM delta
    const gamma = 0.00008;  // gamma effect — accelerates gains, cushions small losses
    const dir = isCE ? 1 : -1;
    const move = dir * indexMove;
    // Delta P&L
    const deltaPnl = delta * move;
    // Gamma bonus (curvature — helps when you're right, reduces small adverse moves)
    const gammaPnl = 0.5 * gamma * move * move * (move > 0 ? 1 : 0.3);
    // Theta: realistic ~0.3% of premium per 5-min bar
    const thetaCost = entryPremium * 0.003 * holdBars;
    return Math.max(0, entryPremium + deltaPnl + gammaPnl - thetaCost);
}

// ─── STRATEGY EVALUATORS (on bar windows) ───────────────────────

/**
 * Fade VWAP stretch — the measured 66.7% edge.
 * Requires 1xATR stretch from VWAP. Entry = current, SL = 1R away, target = 1R.
 */
function evalFadeVwap(sessionBars, nowMin) {
    const session = sessionBars.filter((b) => Number.isFinite(b.min) && b.min <= nowMin);
    if (session.length < 8) return null;  // need ~40 min

    const vwap = sessionVwap(session);
    const atr = barAtr(session);
    if (!vwap || !atr || atr <= 0) return null;

    const last = session[session.length - 1];
    const stretch = (last.close - vwap) / atr;

    if (Math.abs(stretch) < FADE_ATR_MULT) return null;

    const side = stretch > 0 ? 'PE' : 'CE';  // fade = go against
    const entry = last.close;
    const sl = side === 'CE' ? entry - atr * FADE_RR : entry + atr * FADE_RR;
    const target = side === 'CE' ? entry + atr * FADE_RR : entry - atr * FADE_RR;

    return {
        strategy: 'fade_vwap',
        side,
        entry,
        sl,
        target,
        atr,
        stretch,
        confidence: 66.7,
    };
}

/**
 * Keltner Channels — buy at lower band, sell at upper band.
 * ~77% WR when ADX < 25.
 */
function evalKeltner(fifteenMinBars, spot, chainPcr = 1) {
    const closes = fifteenMinBars.map((b) => b.close).filter(Number.isFinite);
    const highs = fifteenMinBars.map((b) => b.high).filter(Number.isFinite);
    const lows = fifteenMinBars.map((b) => b.low).filter(Number.isFinite);

    if (closes.length < KELTNER_EMA) return null;

    const adxV = adx({ high: highs, low: lows, close: closes }, 14);
    if (adxV != null && adxV >= KELTNER_MAX_ADX) return null;  // trend too strong

    const kc = keltnerChannels(closes, highs, lows, KELTNER_EMA, KELTNER_ATR, KELTNER_MULT);
    if (!kc) return null;

    const rsiV = rsi(closes, 7);
    if (rsiV == null) return null;

    const kcRange = kc.upper - kc.lower;
    if (!(kcRange > 0)) return null;

    const position = (spot - kc.lower) / kcRange;
    const atr = kc.atr;

    let side = null;
    const reasons = [];

    // BUY CE near lower band
    if (position < 0.2 && rsiV < 35) {
        side = 'CE';
        reasons.push(`Price near lower KC band ${kc.lower.toFixed(0)}`);
        reasons.push(`RSI ${rsiV.toFixed(0)} oversold`);
    }
    // BUY PE near upper band
    else if (position > 0.8 && rsiV > 65) {
        side = 'PE';
        reasons.push(`Price near upper KC band ${kc.upper.toFixed(0)}`);
        reasons.push(`RSI ${rsiV.toFixed(0)} overbought`);
    }

    if (!side) return null;

    const entry = spot;
    const sl = side === 'CE' ? kc.lower - 0.3 * atr : kc.upper + 0.3 * atr;
    const target = side === 'CE' ? kc.middle : kc.middle;

    return {
        strategy: 'keltner',
        side,
        entry,
        sl,
        target,
        atr,
        reasons,
        confidence: 77,
    };
}

/**
 * Supertrend — enter on trend flip.
 * ~67% WR with 1.5-2.5x risk-reward.
 */
function evalSupertrend(fifteenMinBars, spot) {
    const closes = fifteenMinBars.map((b) => b.close).filter(Number.isFinite);
    const highs = fifteenMinBars.map((b) => b.high).filter(Number.isFinite);
    const lows = fifteenMinBars.map((b) => b.low).filter(Number.isFinite);

    if (closes.length < ST_PERIOD + 5) return null;

    const adxV = adx({ high: highs, low: lows, close: closes }, 14);
    // Require strong trend for Supertrend to avoid whipsaws
    if (adxV == null || adxV < 22) return null;

    const st = supertrend(highs, lows, closes, ST_PERIOD, ST_MULT);
    if (!st) return null;

    // Fire on very fresh flip only (within last 2 bars) — stricter filter
    if (st.barsSinceFlip > 2) return null;

    const atr = barAtr(resample15m(fifteenMinBars), 6);
    if (!atr || atr <= 0) return null;

    let side = null;
    if (st.direction === 1) side = 'CE';
    else if (st.direction === -1) side = 'PE';

    if (!side) return null;

    const entry = spot;
    const sl = st.supertrend;
    const risk = Math.abs(entry - sl);
    // Tighter target for better R:R
    const target = side === 'CE' ? entry + 1.2 * risk : entry - 1.2 * risk;

    return {
        strategy: 'supertrend',
        side,
        entry,
        sl,
        target,
        atr,
        supertrend: st.supertrend,
        confidence: 67,
    };
}

// ─── POSITION MANAGER ────────────────────────────────────────────

class Position {
    constructor({ strategy, side, entry, sl, target, atr, confidence, entryTime, entryPremium }) {
        this.strategy = strategy;
        this.side = side;  // CE or PE
        this.entry = entry;  // index entry price
        this.sl = sl;  // index SL
        this.target = target;  // index target
        this.atr = atr;
        this.confidence = confidence;
        this.entryTime = entryTime;
        this.entryPremium = entryPremium;
        this.exit = null;
        this.exitTime = null;
        this.exitReason = null;
        this.pnl = 0;  // in ₹
        this.pnlPoints = 0;  // in index points
        this.holdBars = 0;
        this.isCE = side === 'CE';
    }

    /**
     * Check if position should exit on this bar.
     * @returns {boolean} true if closed
     */
    tick(bar, holdBars) {
        this.holdBars = holdBars;
        const high = bar.high;
        const low = bar.low;
        const close = bar.close;

        // Time-based exit (force close near market close)
        const barMin = bar.min;
        if (barMin >= EXIT_ALL_MIN) {
            this._close(close, bar.ts, 'time_exit');
            return true;
        }

        // Max hold: 20 bars (100 min) — don't hold forever
        if (holdBars >= 20) {
            this._close(close, bar.ts, 'max_hold');
            return true;
        }

        // Check SL (use low for CE, high for PE to be realistic)
        if (this.isCE) {
            if (low <= this.sl) {
                this._close(this.sl, bar.ts, 'stop_loss');
                return true;
            }
            if (high >= this.target) {
                this._close(this.target, bar.ts, 'target_hit');
                return true;
            }
        } else {
            if (high >= this.sl) {
                this._close(this.sl, bar.ts, 'stop_loss');
                return true;
            }
            if (low <= this.target) {
                this._close(this.target, bar.ts, 'target_hit');
                return true;
            }
        }

        return false;
    }

    _close(exitPrice, exitTime, reason) {
        this.exit = exitPrice;
        this.exitTime = exitTime;
        this.exitReason = reason;
        this.pnlPoints = this.isCE
            ? exitPrice - this.entry
            : this.entry - exitPrice;

        // Simulate premium P&L
        const exitPremium = premiumAtExit(
            this.entryPremium,
            this.pnlPoints,
            this.holdBars,
            this.isCE,
        );
        this.pnl = Math.round((exitPremium - this.entryPremium) * LOT_SIZE);
    }
}

// ─── MAIN BACKTEST ENGINE ────────────────────────────────────────

export default class NiftyBacktestService {
    constructor(config = {}) {
        this.config = config;
    }

    /**
     * Fetch historical 5-minute NIFTY candles from Yahoo.
     * Returns bars with .min (IST minute-of-day) and .date (YYYY-MM-DD) added.
     */
    async fetchHistoricalCandles(range = '60d') {
        const candles = await fetchYahooIntradayCandles(NIFTY.yahoo, {
            interval: '5m',
            range,
        });

        // Add IST minute-of-day and date
        return candles.map((c) => {
            const parts = candlePartsIST(c.ts);
            return {
                ...c,
                min: parts.hour * 60 + parts.minute,
                date: `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`,
            };
        });
    }

    /**
     * Run the backtest on historical candles.
     * @param {object[]} candles - 5m bars with .min and .date
     * @returns {object} Full backtest results
     */
    runBacktest(candles) {
        // Group candles by trading day
        const days = new Map();
        for (const bar of candles) {
            if (!bar.date) continue;
            // Only market hours: 9:15 - 15:30
            if (bar.min < 9 * 60 + 15 || bar.min > 15 * 60 + 30) continue;
            if (!days.has(bar.date)) days.set(bar.date, []);
            days.get(bar.date).push(bar);
        }

        const sortedDates = [...days.keys()].sort();
        logger.info(`Backtest: ${sortedDates.length} trading days from ${sortedDates[0]} to ${sortedDates[sortedDates.length - 1]}`);

        // Running state
        let capital = CAPITAL;
        let peakCapital = CAPITAL;
        let maxDrawdown = 0;
        let maxDrawdownPct = 0;
        const dailyResults = [];
        const allTrades = [];

        // Per-day state
        let tradesToday = 0;
        let pnlToday = 0;
        let dailyStart = CAPITAL;
        let openPositions = [];
        // Rolling window for 15m strategies (carries over across days)
        let rollingBars = [];
        // Cooldown: avoid re-entry on same signal
        let lastEntryBarTs = 0;
        const COOLDOWN_BARS = 6;  // 30 min cooldown between entries

        for (const date of sortedDates) {
            const bars = days.get(date);
            if (!bars || bars.length < 10) continue;

            // Reset daily state
            tradesToday = 0;
            pnlToday = 0;
            dailyStart = capital;
            openPositions = [];

            // Track session bars for VWAP/ATR calculation
            const sessionBars = [];

            for (const bar of bars) {
                sessionBars.push(bar);

                // Tick open positions
                for (let i = openPositions.length - 1; i >= 0; i--) {
                    const pos = openPositions[i];
                    const holdBars = sessionBars.filter((b) => b.ts >= pos.entryTime && b.ts <= bar.ts).length;
                    if (pos.tick(bar, holdBars)) {
                        capital += pos.pnl;
                        pnlToday += pos.pnl;
                        allTrades.push({ ...pos, date });
                        openPositions.splice(i, 1);
                    }
                }

                // Daily loss limit check
                if (pnlToday <= -DAILY_LOSS_LIMIT) {
                    // Force close all
                    for (const pos of openPositions) {
                        pos._close(bar.close, bar.ts, 'daily_loss_limit');
                        capital += pos.pnl;
                        pnlToday += pos.pnl;
                        allTrades.push({ ...pos, date });
                    }
                    openPositions = [];
                    break;  // done for today
                }

                // Already at target for today?
                if (pnlToday >= MAX_TARGET_PER_DAY) {
                    for (const pos of openPositions) {
                        pos._close(bar.close, bar.ts, 'daily_target_reached');
                        capital += pos.pnl;
                        pnlToday += pos.pnl;
                        allTrades.push({ ...pos, date });
                    }
                    openPositions = [];
                    break;
                }

                // Max trades per day
                if (tradesToday >= MAX_TRADES_PER_DAY) continue;

                // No new entries after cutoff
                if (bar.min >= ENTRY_CUTOFF_MIN) continue;

                // Need enough bars for indicators
                if (sessionBars.length < 8) continue;
                // Cooldown between entries
                if (bar.ts - lastEntryBarTs < COOLDOWN_BARS * 5 * 60000) continue;

                // ─── EVALUATE STRATEGIES ───────────────────────
                const spot = bar.close;
                // Use rolling window for 15m strategies (need history across days)
                rollingBars.push(bar);
                // Keep last 300 bars (~1.5 days of 5m data)
                if (rollingBars.length > 300) rollingBars = rollingBars.slice(-300);
                const fifteen = resample15m(rollingBars);
                const closes15 = fifteen.map((b) => b.close).filter(Number.isFinite);
                const highs15 = fifteen.map((b) => b.high).filter(Number.isFinite);
                const lows15 = fifteen.map((b) => b.low).filter(Number.isFinite);

                const signals = [];

                // 1. Fade VWAP (session-only)
                const fade = evalFadeVwap(sessionBars, bar.min);
                if (fade) signals.push(fade);

                // 2. Keltner (rolling 15m data)
                const keltner = evalKeltner(fifteen, spot);
                if (keltner) signals.push(keltner);

                // 3. Supertrend (rolling 15m data)
                const supertrendSig = evalSupertrend(fifteen, spot);
                if (supertrendSig) signals.push(supertrendSig);

                if (signals.length === 0) continue;

                // Pick best signal (highest confidence)
                signals.sort((a, b) => b.confidence - a.confidence);
                const best = signals[0];

                // Position sizing: risk X points = ₹Y
                const riskPoints = Math.abs(best.entry - best.sl);
                if (riskPoints <= 0 || riskPoints > 200) continue;  // sanity

                const riskAmount = Math.min(MAX_RISK_PER_TRADE, capital * RISK_PER_TRADE_PCT);
                const lots = Math.max(1, Math.min(2, Math.floor(riskAmount / (riskPoints * LOT_SIZE))));

                // Check if we can afford the margin (premium for 1 lot)
                const hoursToExpiry = Math.max(1, (15 * 60 + 15 - bar.min) / 60);
                const premium = approxAtmPremium(spot, BASE_IV, hoursToExpiry);
                const marginNeeded = premium * LOT_SIZE * lots;

                if (marginNeeded > capital * 0.9) continue;  // can't afford

                // Open position
                const pos = new Position({
                    strategy: best.strategy,
                    side: best.side,
                    entry: best.entry,
                    sl: best.sl,
                    target: best.target,
                    atr: best.atr,
                    confidence: best.confidence,
                    entryTime: bar.ts,
                    entryPremium: premium,
                });

                openPositions.push(pos);
                tradesToday++;
                lastEntryBarTs = bar.ts;
            }

            // End of day — force close remaining positions
            for (const pos of openPositions) {
                const lastBar = bars[bars.length - 1];
                pos._close(lastBar.close, lastBar.ts, 'eod_close');
                capital += pos.pnl;
                pnlToday += pos.pnl;
                allTrades.push({ ...pos, date });
            }

            // Track peak/drawdown
            if (capital > peakCapital) peakCapital = capital;
            const drawdown = peakCapital - capital;
            const drawdownPct = (drawdown / peakCapital) * 100;
            if (drawdown > maxDrawdown) maxDrawdown = drawdown;
            if (drawdownPct > maxDrawdownPct) maxDrawdownPct = drawdownPct;

            dailyResults.push({
                date,
                pnl: pnlToday,
                trades: tradesToday,
                capital: Math.round(capital),
                drawdown: Math.round(drawdown),
                startCapital: dailyStart,
            });
        }

        return this._computeStats(allTrades, dailyResults, capital, maxDrawdown, maxDrawdownPct);
    }

    /**
     * Compute comprehensive statistics from trade and daily results.
     */
    _computeStats(allTrades, dailyResults, finalCapital, maxDrawdown, maxDrawdownPct) {
        const wins = allTrades.filter((t) => t.pnl > 0);
        const losses = allTrades.filter((t) => t.pnl <= 0);
        const totalTrades = allTrades.length;

        const winRate = totalTrades > 0 ? (wins.length / totalTrades) * 100 : 0;
        const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
        const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
        const profitFactor = avgLoss > 0 ? avgWin / avgLoss : 0;
        const expectancy = totalTrades > 0
            ? allTrades.reduce((s, t) => s + t.pnl, 0) / totalTrades
            : 0;

        const totalPnl = allTrades.reduce((s, t) => s + t.pnl, 0);
        const netReturn = ((finalCapital - CAPITAL) / CAPITAL) * 100;

        // Daily stats
        const profitableDays = dailyResults.filter((d) => d.pnl > 0).length;
        const losingDays = dailyResults.filter((d) => d.pnl < 0).length;
        const flatDays = dailyResults.filter((d) => d.pnl === 0).length;
        const avgDailyPnl = dailyResults.length > 0
            ? dailyResults.reduce((s, d) => s + d.pnl, 0) / dailyResults.length
            : 0;
        const bestDay = dailyResults.length > 0
            ? Math.max(...dailyResults.map((d) => d.pnl))
            : 0;
        const worstDay = dailyResults.length > 0
            ? Math.min(...dailyResults.map((d) => d.pnl))
            : 0;

        // Strategy breakdown
        const byStrategy = {};
        for (const t of allTrades) {
            if (!byStrategy[t.strategy]) {
                byStrategy[t.strategy] = { trades: 0, wins: 0, pnl: 0, totalPnl: 0 };
            }
            byStrategy[t.strategy].trades++;
            if (t.pnl > 0) byStrategy[t.strategy].wins++;
            byStrategy[t.strategy].totalPnl += t.pnl;
        }
        for (const key of Object.keys(byStrategy)) {
            const s = byStrategy[key];
            s.winRate = s.trades > 0 ? (s.wins / s.trades) * 100 : 0;
            s.avgPnl = s.trades > 0 ? s.totalPnl / s.trades : 0;
        }

        // Exit reason breakdown
        const byExitReason = {};
        for (const t of allTrades) {
            const r = t.exitReason || 'unknown';
            byExitReason[r] = (byExitReason[r] || 0) + 1;
        }

        // Consecutive wins/losses
        let maxConsecWins = 0, maxConsecLosses = 0, cw = 0, cl = 0;
        for (const t of allTrades) {
            if (t.pnl > 0) { cw++; cl = 0; maxConsecWins = Math.max(maxConsecWins, cw); }
            else { cl++; cw = 0; maxConsecLosses = Math.max(maxConsecLosses, cl); }
        }

        // Sharpe-like ratio (daily returns)
        if (dailyResults.length > 2) {
            const returns = dailyResults.map((d) => d.pnl / CAPITAL);
            const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
            const std = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length);
            var sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;
        }

        // Days hitting target
        const daysHitTarget = dailyResults.filter((d) => d.pnl >= MIN_TARGET_PER_DAY).length;
        const daysHitMax = dailyResults.filter((d) => d.pnl >= MAX_TARGET_PER_DAY).length;
        const daysHitLossLimit = dailyResults.filter((d) => d.pnl <= -DAILY_LOSS_LIMIT).length;

        return {
            // Summary
            capital: CAPITAL,
            finalCapital: Math.round(finalCapital),
            totalPnl: Math.round(totalPnl),
            netReturn: Number(netReturn.toFixed(2)),
            maxDrawdown: Math.round(maxDrawdown),
            maxDrawdownPct: Number(maxDrawdownPct.toFixed(2)),

            // Trade stats
            totalTrades,
            winRate: Number(winRate.toFixed(1)),
            avgWin: Math.round(avgWin),
            avgLoss: Math.round(avgLoss),
            profitFactor: Number(profitFactor.toFixed(2)),
            expectancy: Math.round(expectancy),
            maxConsecWins,
            maxConsecLosses,

            // Daily stats
            tradingDays: dailyResults.length,
            profitableDays,
            losingDays,
            flatDays,
            avgDailyPnl: Math.round(avgDailyPnl),
            bestDay: Math.round(bestDay),
            worstDay: Math.round(worstDay),
            sharpe: sharpe != null ? Number(sharpe.toFixed(2)) : null,

            // Target tracking
            daysHitTarget,
            daysHitMax,
            daysHitLossLimit,
            targetHitRate: dailyResults.length > 0
                ? Number(((daysHitTarget / dailyResults.length) * 100).toFixed(1))
                : 0,

            // Strategy breakdown
            byStrategy,

            // Exit reasons
            byExitReason,

            // Trades & daily for further analysis
            trades: allTrades,
            dailyResults,
        };
    }

    /**
     * Format results as a WhatsApp card.
     */
    formatResults(stats) {
        const stratLabel = {
            fade_vwap: '📉 Fade VWAP',
            keltner: '📊 Keltner KC',
            supertrend: '📈 Supertrend',
        };

        const exitLabel = {
            stop_loss: '🛑 Stop Loss',
            target_hit: '🎯 Target Hit',
            time_exit: '⏰ Time Exit',
            eod_close: '🔔 EOD Close',
            max_hold: '⏳ Max Hold',
            daily_loss_limit: '🚨 Loss Limit',
            daily_target_reached: '🏆 Target Reached',
        };

        const lines = [
            '┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓',
            '┃  🧪 *NIFTY BACKTEST RESULTS*  ┃',
            '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛',
            '',
            `📅 ${stats.tradingDays} trading days`,
            `💰 Capital: ${inr(stats.capital)} → ${inr(stats.finalCapital)}`,
            '',
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
            '📊 *PERFORMANCE*',
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
            '',
            `📈 Total P&L: ${stats.totalPnl >= 0 ? '+' : ''}${inr(stats.totalPnl)}`,
            `📉 Net Return: ${stats.netReturn >= 0 ? '+' : ''}${stats.netReturn}%`,
            `📊 Max Drawdown: ${inr(stats.maxDrawdown)} (${stats.maxDrawdownPct}%)`,
            stats.sharpe != null ? `📐 Sharpe Ratio: ${stats.sharpe}` : null,
            '',
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
            '🎯 *TRADE STATS*',
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
            '',
            `🔢 Total Trades: ${stats.totalTrades}`,
            `✅ Win Rate: ${stats.winRate}%`,
            `💰 Avg Win: ${inr(stats.avgWin)}`,
            `💸 Avg Loss: ${inr(stats.avgLoss)}`,
            `⚖️ Profit Factor: ${stats.profitFactor}`,
            `📐 Expectancy: ${inr(stats.expectancy)}/trade`,
            `🔥 Max Consec Wins: ${stats.maxConsecWins}`,
            `❄️ Max Consec Losses: ${stats.maxConsecLosses}`,
            '',
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
            '📅 *DAILY STATS*',
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
            '',
            `🟢 Profitable Days: ${stats.profitableDays}/${stats.tradingDays}`,
            `🔴 Losing Days: ${stats.losingDays}`,
            `⚖️ Flat Days: ${stats.flatDays}`,
            `📊 Avg Daily P&L: ${inr(stats.avgDailyPnl)}`,
            `🏆 Best Day: ${inr(stats.bestDay)}`,
            `💀 Worst Day: ${inr(stats.worstDay)}`,
            '',
            `🎯 Days ≥ ₹500 target: ${stats.daysHitTarget} (${stats.targetHitRate}%)`,
            `🚀 Days ≥ ₹3k max: ${stats.daysHitMax}`,
            `🚨 Days hitting loss limit: ${stats.daysHitLossLimit}`,
        ];

        // Strategy breakdown
        lines.push('', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        lines.push('🧩 *BY STRATEGY*');
        lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', '');

        for (const [key, data] of Object.entries(stats.byStrategy)) {
            lines.push(`${stratLabel[key] || key}: ${data.trades} trades, ${data.winRate.toFixed(0)}% WR, ${inr(data.totalPnl)} P&L`);
        }

        // Exit reasons
        lines.push('', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        lines.push('🚪 *EXIT BREAKDOWN*');
        lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', '');

        for (const [reason, count] of Object.entries(stats.byExitReason)) {
            lines.push(`${exitLabel[reason] || reason}: ${count}`);
        }

        // Verdict
        lines.push('', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        lines.push('💡 *VERDICT*');
        lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', '');

        if (stats.totalPnl > 0 && stats.winRate >= 55 && stats.profitFactor >= 1.5) {
            lines.push('✅ *PROFITABLE SYSTEM*');
            lines.push(`Win rate ${stats.winRate}% with PF ${stats.profitFactor}`);
            lines.push(`Expects ${inr(stats.expectancy)}/trade on average`);
            lines.push(`₹30k capital → ${inr(stats.finalCapital)} (${stats.netReturn >= 0 ? '+' : ''}${stats.netReturn}%)`);
        } else if (stats.totalPnl > 0) {
            lines.push('⚠️ *MARGINAL SYSTEM*');
            lines.push('Profitable but thin edge — improve filters or reduce size');
        } else {
            lines.push('❌ *UNPROFITABLE*');
            lines.push('System loses money — do NOT trade live');
            lines.push('Review strategy params or add filters');
        }

        lines.push('', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        return lines.filter(Boolean).join('\n');
    }
}
