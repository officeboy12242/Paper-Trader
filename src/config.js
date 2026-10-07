/**
 * Central configuration. Every value comes from the environment (.env) with a
 * documented default. Secrets are read here and never leave the process: the
 * dashboard only ever receives `publicConfig()`.
 *
 * SAFETY: this build has no live execution path. PAPER_TRADING must be true and
 * LIVE_TRADING is a constant, not a setting.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

dotenv.config({ path: path.join(ROOT_DIR, '.env') });

// The vendored WA-BOT modules build a pino logger at import time from
// process.env.LOG_LEVEL, and pino only accepts lowercase names. Our own log
// level is read first, then the env var is rewritten for the vendor logger.
// The original value is kept in PAPERTRADER_LOG_LEVEL so the rewrite does not
// leak into child processes (or a second import) as our own level.
const OWN_LOG_LEVEL = String(process.env.PAPERTRADER_LOG_LEVEL || process.env.LOG_LEVEL || 'INFO').toUpperCase();
process.env.PAPERTRADER_LOG_LEVEL = OWN_LOG_LEVEL;
process.env.LOG_LEVEL = String(process.env.VENDOR_LOG_LEVEL || 'warn').toLowerCase();

/** Live trading is not implemented in this build. Not configurable. */
export const LIVE_TRADING_ENABLED = false;

const num = (name, def, { min = -Infinity, max = Infinity } = {}) => {
    const raw = process.env[name];
    if (raw === undefined || String(raw).trim() === '') return def;
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`Config ${name} must be a number (got "${raw}")`);
    if (n < min || n > max) throw new Error(`Config ${name}=${n} out of range [${min}, ${max}]`);
    return n;
};

const bool = (name, def) => {
    const raw = process.env[name];
    if (raw === undefined || String(raw).trim() === '') return def;
    return !/^(false|0|no|off)$/i.test(String(raw).trim());
};

const str = (name, def) => {
    const raw = process.env[name];
    return raw === undefined || String(raw).trim() === '' ? def : String(raw).trim();
};

const oneOf = (name, def, allowed) => {
    const v = str(name, def).toLowerCase();
    if (!allowed.includes(v)) throw new Error(`Config ${name} must be one of ${allowed.join('|')} (got "${v}")`);
    return v;
};

const hhmm = (name, def) => {
    const v = str(name, def);
    if (!/^\d{1,2}:\d{2}$/.test(v)) throw new Error(`Config ${name} must be HH:MM (got "${v}")`);
    return v;
};

function parseWeights(raw) {
    const out = { netPnl: 0.35, profitFactor: 0.25, winRate: 0.15, drawdown: 0.15, trades: 0.1 };
    if (!raw) return out;
    for (const part of String(raw).split(',')) {
        const [k, v] = part.split(':').map((s) => s.trim());
        if (!(k in out)) throw new Error(`RANK_WEIGHTS: unknown metric "${k}" (allowed ${Object.keys(out).join(', ')})`);
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) throw new Error(`RANK_WEIGHTS: bad weight for ${k}`);
        out[k] = n;
    }
    return out;
}

function databasePath(url) {
    const raw = url.replace(/^sqlite:/, '').replace(/^file:/, '');
    if (raw === ':memory:') return raw;
    return path.isAbsolute(raw) ? raw : path.join(ROOT_DIR, raw);
}

export function loadConfig() {
    const paper = bool('PAPER_TRADING', true);
    if (!paper) {
        throw new Error(
            'PAPER_TRADING=false is not supported. This build has no live execution adapter; ' +
                'set PAPER_TRADING=true.'
        );
    }

    const cfg = {
        PAPER_TRADING: true,
        LIVE_TRADING_ENABLED,

        // Position sizing. 1 lot per trade, never scaled by confidence or balance.
        LOT_SIZE: num('LOT_SIZE', 1, { min: 1, max: 100 }),

        // Risk overlay applied on top of each source's own levels.
        MIN_TARGET: num('MIN_TARGET', 10, { min: 0 }),
        MIN_TARGET_UNIT: oneOf('MIN_TARGET_UNIT', 'points', ['points', 'rupees', 'percent']),
        STOP_LOSS_PERCENT: num('STOP_LOSS_PERCENT', 5, { min: 0.1, max: 5 }),
        TRAILING_ENABLED: bool('TRAILING_ENABLED', true),
        TRAIL_DISTANCE: num('TRAIL_DISTANCE', 0.5, { min: 0.01 }),
        TRAIL_DISTANCE_UNIT: oneOf('TRAIL_DISTANCE_UNIT', 'percent', ['percent', 'points', 'r']),
        TRAIL_LOCK_PCT: num('TRAIL_LOCK_PCT', 100, { min: 0, max: 100 }),

        // Session handling (IST). Entries stop at ENTRY_CUTOFF; everything is
        // squared off at EOD_SQUARE_OFF because every source is intraday.
        MARKET_TZ: 'Asia/Kolkata',
        SESSION_OPEN: hhmm('SESSION_OPEN', '09:15'),
        ENTRY_CUTOFF: hhmm('ENTRY_CUTOFF', '15:00'),
        EOD_SQUARE_OFF: hhmm('EOD_SQUARE_OFF', '15:20'),

        // Scheduling. First scan per source follows the original WA-BOT clocks.
        TRADE_ALERT_TIME: hhmm('TRADE_ALERT_TIME', '09:20'),
        TRADE_ALERT_MORNING_VOLATILITY_TIME: str('TRADE_ALERT_MORNING_VOLATILITY_TIME', '09:35'),
        TRADE_ALERT_HEATMAP2_TIMES: str('TRADE_ALERT_HEATMAP2_TIMES', ''),
        TRADE_ALERT_PREOPEN_TIME: str('TRADE_ALERT_PREOPEN_TIME', ''),
        TRADE_ALERT_TURNOVER_TIME: str('TRADE_ALERT_TURNOVER_TIME', ''),
        SCAN_INTERVAL_MINUTES: num('SCAN_INTERVAL_MINUTES', 15, { min: 0, max: 120 }),
        PRICE_POLL_SECONDS: num('PRICE_POLL_SECONDS', 30, { min: 5, max: 300 }),
        SCHEDULER_TICK_SECONDS: num('SCHEDULER_TICK_SECONDS', 20, { min: 5, max: 120 }),

        // Original daily cap (TRADE_ALERT_MAX_SENDS) applied per strategy.
        MAX_TRADES_PER_STRATEGY_PER_DAY: num('MAX_TRADES_PER_STRATEGY_PER_DAY', num('TRADE_ALERT_MAX_SENDS', 20), { min: 1, max: 50 }),
        ALLOW_DUPLICATE_POSITIONS: bool('ALLOW_DUPLICATE_POSITIONS', false),
        SOFT_FALLBACK: bool('TRADE_ALERT_DAILY_SOFT_FALLBACK', true),

        // AI gate: 'auto' turns on the original LLM check as soon as a key exists.
        AI_GATE_MODE: oneOf('AI_GATE_MODE', 'auto', ['auto', 'off']),
        // NSE sources trade CE/PE option premiums (ATM leg) instead of the underlying.
        NSE_TRADE_OPTIONS: bool('NSE_TRADE_OPTIONS', true),
        // Option premium risk scale (premiums need wider room than equity).
        NSE_OPTION_STOP_PCT: num('NSE_OPTION_STOP_PCT', 30, { min: 1, max: 90 }),
        NSE_OPTION_MIN_TARGET_PCT: num('NSE_OPTION_MIN_TARGET_PCT', 20, { min: 1, max: 500 }),
        NSE_OPTION_TRAIL_PCT: num('NSE_OPTION_TRAIL_PCT', 3, { min: 0.1, max: 50 }),
        // Risk controls: short cooldown after a stop-loss, and a daily loss limit per strategy.
        STRATEGY_COOLDOWN_MINUTES: num('STRATEGY_COOLDOWN_MINUTES', 5, { min: 0, max: 1440 }),
        DAILY_LOSS_LIMIT_INR: num('DAILY_LOSS_LIMIT_INR', 15000, { min: 0 }),
        // Gold/ETH: once unrealized profit reaches this, the stop locks that
        // profit (breakeven + booking level) so a winner can never become a loser.
        PROFIT_BOOK_INR: num('PROFIT_BOOK_INR', 2000, { min: 0 }),
        // Per-trade SL/TP for the 24h gold/ETH traders — derived from each
        // trade's own setup, never a fixed number:
        //   stop   = the setup's invalidation point, capped at ATR_STOP_MULT x
        //            ATR and at <PREFIX>_STOP_RISK
        //   target = the nearest structural level paying at least MIN_RR,
        //            capped at MAX_RR; setups that cannot pay are refused
        MIN_RR: num('MIN_RR', 1.5, { min: 1, max: 10 }),
        MAX_RR: num('MAX_RR', 4, { min: 1, max: 20 }),
        ATR_STOP_MULT: num('ATR_STOP_MULT', 3, { min: 0.5, max: 20 }),
        // Hard cap on what a single stop-loss may cost, in rupees. Position
        // size is cut to fit it, so a wide stop never means a bigger loss.
        MAX_RISK_INR: num('MAX_RISK_INR', 3000, { min: 0 }),

        // Execution simulation.
        SLIPPAGE_BPS: num('SLIPPAGE_BPS', 2, { min: 0, max: 200 }),
        FEE_BROKERAGE_FLAT: num('FEE_BROKERAGE_FLAT', 20, { min: 0 }),
        FEE_BROKERAGE_PCT: num('FEE_BROKERAGE_PCT', 0.03, { min: 0 }),
        FEE_STT_SELL_PCT: num('FEE_STT_SELL_PCT', 0.02, { min: 0 }),
        FEE_EXCHANGE_PCT: num('FEE_EXCHANGE_PCT', 0.00173, { min: 0 }),
        FEE_SEBI_PER_CRORE: num('FEE_SEBI_PER_CRORE', 10, { min: 0 }),
        FEE_STAMP_BUY_PCT: num('FEE_STAMP_BUY_PCT', 0.002, { min: 0 }),
        FEE_GST_PCT: num('FEE_GST_PCT', 18, { min: 0 }),

        // Delta Exchange fees for gold + ETH. Charged per side on notional,
        // plus 18% GST (FEE_GST_PCT) on the fee. Source, pulled live from
        // GET https://api.india.delta.exchange/v2/products:
        //   XAUTUSD (gold)  maker 0.01%  taker 0.01%
        //   ETHUSD          maker 0.02%  taker 0.05%
        // Every order this engine fires (market entry, stop entry, stop/target
        // exit) takes liquidity, so both legs fill as taker.
        DELTA_FEE_SIDE: oneOf('DELTA_FEE_SIDE', 'taker', ['maker', 'taker']),
        DELTA_FEE_GOLD_MAKER_PCT: num('DELTA_FEE_GOLD_MAKER_PCT', 0.01, { min: 0 }),
        DELTA_FEE_GOLD_TAKER_PCT: num('DELTA_FEE_GOLD_TAKER_PCT', 0.01, { min: 0 }),
        DELTA_FEE_ETH_MAKER_PCT: num('DELTA_FEE_ETH_MAKER_PCT', 0.02, { min: 0 }),
        DELTA_FEE_ETH_TAKER_PCT: num('DELTA_FEE_ETH_TAKER_PCT', 0.05, { min: 0 }),

        // Nightly self-training: an in-process loop rebuilds a small logistic
        // regression gate from closed trades and swaps it in only when it beats
        // a walk-forward test. Nothing trains until ML_MIN_TRADES closed trades
        // exist — before that the summary is simply "not enough data".
        ML_TRAIN_ENABLED: bool('ML_TRAIN_ENABLED', true),
        ML_TRAIN_HOUR_IST: num('ML_TRAIN_HOUR_IST', 3, { min: 0, max: 23 }),
        ML_MIN_TRADES: num('ML_MIN_TRADES', 100, { min: 0 }),
        ML_MIN_TEST: num('ML_MIN_TEST', 20, { min: 0 }),
        ML_MIN_ACC: num('ML_MIN_ACC', 0.55, { min: 0, max: 1 }),
        //  off     — never score
        //  shadow  — score and record the number, never veto (default)
        //  on      — veto accepted setups scoring below ML_GATE_THRESHOLD
        ML_GATE_MODE: oneOf('ML_GATE_MODE', 'shadow', ['off', 'shadow', 'on']),
        ML_GATE_THRESHOLD: num('ML_GATE_THRESHOLD', 0.45, { min: 0, max: 1 }),
        ML_KEEP_VERSIONS: num('ML_KEEP_VERSIONS', 12, { min: 1 }),

        // System-1 decision gate (Jev/Laya-style). Every setup that passes the
        // rules is given to the model as a "state" and it must answer with ONLY
        // a typed verdict (no reasoning): take yes/no/noul, direction,
        // conviction 0-100 and a nuance label. Same gate semantics as the ML
        // gate: shadow records the verdict, on vetoes weak ones.
        SYSTEM1_GATE_MODE: oneOf('SYSTEM1_GATE_MODE', 'shadow', ['off', 'shadow', 'on']),
        // Provider for the verdicts: groq (OpenAI-compatible, strict json_schema
        // decoding) or gemini (REST + responseSchema constrained decoding).
        SYSTEM1_PROVIDER: oneOf('SYSTEM1_PROVIDER', 'groq', ['groq', 'gemini']),
        // Empty = provider default (groq: openai/gpt-oss-120b, gemini: gemini-2.0-flash).
        SYSTEM1_MODEL: str('SYSTEM1_MODEL', ''),
        // A clean confirmation needs at least this conviction (0-100) in "on".
        SYSTEM1_CONVICTION_MIN: num('SYSTEM1_CONVICTION_MIN', 60, { min: 0, max: 100 }),
        SYSTEM1_TIMEOUT_MS: num('SYSTEM1_TIMEOUT_MS', 15000, { min: 1000, max: 120000 }),
        // Daily call budget (0 = unlimited). Keeps cost and latency bounded.
        SYSTEM1_MAX_PER_DAY: num('SYSTEM1_MAX_PER_DAY', 120, { min: 0 }),
        // After 3 consecutive failures the gate cools down for this long.
        SYSTEM1_COOLDOWN_MS: num('SYSTEM1_COOLDOWN_MS', 600000, { min: 0 }),
        // Optional dedicated Groq key; defaults to GROQ_API_KEY when unset.
        SYSTEM1_API_KEY: str('SYSTEM1_API_KEY', ''),
        // Optional dedicated Gemini key for the System-1 gate; falls back to
        // GEMINI_API_KEY then SYSTEM1_API_KEY. Used only when
        // SYSTEM1_PROVIDER=gemini.
        SYSTEM1_GEMINI_API_KEY: str('SYSTEM1_GEMINI_API_KEY', ''),

        LOT_SIZE_SOURCE: oneOf('LOT_SIZE_SOURCE', 'nse', ['nse', 'repo']),

        // Statistics and ranking.
        CAPITAL_PER_STRATEGY: num('CAPITAL_PER_STRATEGY', 500000, { min: 1 }),
        RANK_WEIGHTS: parseWeights(process.env.RANK_WEIGHTS),
        RANK_PF_CAP: num('RANK_PF_CAP', 3, { min: 1 }),
        RANK_DD_CAP_PCT: num('RANK_DD_CAP_PCT', 20, { min: 1 }),
        RANK_FULL_SAMPLE_TRADES: num('RANK_FULL_SAMPLE_TRADES', 30, { min: 1 }),

        // Infrastructure.
        DATABASE_URL: str('DATABASE_URL', 'sqlite:./data/papertrader.db'),
        // Backend for the engine's source-of-truth store: 'mongo' (production,
        // Atlas-backed via the driver wrapper in src/db/mongoDatabase.js — the
        // default) or 'sqlite' (file DB, kept for offline/dev fallback).
        DB_BACKEND: oneOf('DB_BACKEND', (process.env.MONGODB_URI || '').trim() ? 'mongo' : 'sqlite', ['mongo', 'sqlite']),
        // MongoDB mirror for future AI/RAG work (optional; engine runs fine without it).
        MONGODB_URI: str('MONGODB_URI', ''),
        MONGODB_DB: str('MONGODB_DB', 'papertrader'),
        // On a wiped SQLite (e.g., Render redeploy), boot restores engine state
        // from the latest Mongo snapshot. Turn off to start each deploy empty.
        MONGO_RESTORE: bool('MONGO_RESTORE', true),
        LOG_LEVEL: OWN_LOG_LEVEL,
        LOG_DIR: path.resolve(ROOT_DIR, str('LOG_DIR', './logs')),
        // Hosted platforms (Render/Railway/Heroku) inject PORT and require
        // 0.0.0.0 — bind it unconditionally when PORT is present, ignoring any
        // DASHBOARD_HOST that would keep the service on localhost.
        DASHBOARD_HOST: process.env.PORT ? '0.0.0.0' : str('DASHBOARD_HOST', '127.0.0.1'),
        // Render/Heroku-style hosts inject PORT; honour it when DASHBOARD_PORT is unset.
        DASHBOARD_PORT: num('DASHBOARD_PORT', Number(process.env.PORT) || 8080, { min: 0, max: 65535 }),
        MARKET_DATA_CONCURRENCY: num('MARKET_DATA_CONCURRENCY', 4, { min: 1, max: 16 }),
        STALE_PRICE_SECONDS: num('STALE_PRICE_SECONDS', 300, { min: 30 }),

        // Gold 24h trader (XAUUSD spot via Delta India, paper only).
        // Delta India model: USD-quoted, INR-margined and INR-settled.
        GOLD_MARGIN_INR: num('GOLD_MARGIN_INR', 40000, { min: 1 }),
        GOLD_LEVERAGE: num('GOLD_LEVERAGE', 50, { min: 1, max: 100 }),
        GOLD_STOP_RISK: num('GOLD_STOP_RISK', 15, { min: 1 }),
        // Gold rescans continuously (24h); SCAN_INTERVAL_MINUTES still governs NSE.
        GOLD_SCAN_INTERVAL_MINUTES: num('GOLD_SCAN_INTERVAL_MINUTES', 1, { min: 1, max: 120 }),
        // Real-time spot ticker socket (gold/ETH) for lag-free quotes.
        SPOT_SOCKET_ENABLED: bool('SPOT_SOCKET_ENABLED', true),
        // INR per USD — converts the USD gold/ETH quote to the INR margin base.
        INR_USD_RATE: num('INR_USD_RATE', 84, { min: 1 }),

        // ETH 24h trader (ETHUSD spot via Delta India, paper only).
        ETH_MARGIN_INR: num('ETH_MARGIN_INR', 40000, { min: 1 }),
        ETH_LEVERAGE: num('ETH_LEVERAGE', 50, { min: 1, max: 100 }),
        ETH_STOP_RISK: num('ETH_STOP_RISK', 25, { min: 1 }),
        ETH_SCAN_INTERVAL_MINUTES: num('ETH_SCAN_INTERVAL_MINUTES', 1, { min: 1, max: 120 }),
    };
    cfg.DATABASE_PATH = databasePath(cfg.DATABASE_URL);
    if (cfg.ENTRY_CUTOFF >= cfg.EOD_SQUARE_OFF) {
        throw new Error('ENTRY_CUTOFF must be earlier than EOD_SQUARE_OFF');
    }
    if (cfg.MIN_RR > cfg.MAX_RR) {
        throw new Error(`MIN_RR=${cfg.MIN_RR} must not exceed MAX_RR=${cfg.MAX_RR}`);
    }
    return cfg;
}

/** Per-strategy overrides: STRATEGY_<KEY>_ENABLED / _RESCAN_MINUTES / _SCAN_TIMES. */
export function strategyOverrides(key) {
    const p = `STRATEGY_${String(key).toUpperCase()}_`;
    const rescan = process.env[`${p}RESCAN_MINUTES`];
    const times = process.env[`${p}SCAN_TIMES`];
    return {
        enabled: bool(`${p}ENABLED`, true),
        rescanMinutes: rescan !== undefined && rescan !== '' ? Number(rescan) : null,
        scanTimes: times ? times.split(',').map((t) => t.trim()).filter(Boolean) : null,
    };
}

/** True when any provider key the original trade LLM router accepts is set. */
export function aiKeyPresent(env = process.env) {
    return [
        'ORCAROUTER_API_KEY', 'GEMINI_API_KEY', 'GEMINI_API_KEYS', 'GROQ_API_KEY', 'GROQ_API_KEYS',
        'NVIDIA_API_KEY', 'NVIDIA_API_KEYS', 'OPENROUTER_API_KEY', 'OPENROUTER_API_KEYS',
    ].some((k) => String(env[k] || '').trim());
}

/** Safe subset for the dashboard. Never includes keys, tokens or URLs with credentials. */
export function publicConfig(cfg) {
    return {
        paperTrading: true,
        liveTrading: false,
        lotSize: cfg.LOT_SIZE,
        minTarget: cfg.MIN_TARGET,
        minTargetUnit: cfg.MIN_TARGET_UNIT,
        stopLossPercent: cfg.STOP_LOSS_PERCENT,
        trailing: {
            enabled: cfg.TRAILING_ENABLED,
            distance: cfg.TRAIL_DISTANCE,
            unit: cfg.TRAIL_DISTANCE_UNIT,
            lockPctOfTarget: cfg.TRAIL_LOCK_PCT,
        },
        session: {
            timezone: cfg.MARKET_TZ,
            open: cfg.SESSION_OPEN,
            entryCutoff: cfg.ENTRY_CUTOFF,
            eodSquareOff: cfg.EOD_SQUARE_OFF,
        },
        maxTradesPerStrategyPerDay: cfg.MAX_TRADES_PER_STRATEGY_PER_DAY,
        allowDuplicatePositions: cfg.ALLOW_DUPLICATE_POSITIONS,
        slippageBps: cfg.SLIPPAGE_BPS,
        lotSizeSource: cfg.LOT_SIZE_SOURCE,
        capitalPerStrategy: cfg.CAPITAL_PER_STRATEGY,
        ranking: {
            weights: cfg.RANK_WEIGHTS,
            pfCap: cfg.RANK_PF_CAP,
            ddCapPct: cfg.RANK_DD_CAP_PCT,
            fullSampleTrades: cfg.RANK_FULL_SAMPLE_TRADES,
        },
        aiGateMode: cfg.AI_GATE_MODE,
        aiConfigured: aiKeyPresent(),
        nseTradeOptions: cfg.NSE_TRADE_OPTIONS,
        nseOptionRisk: { stopPct: cfg.NSE_OPTION_STOP_PCT, minTargetPct: cfg.NSE_OPTION_MIN_TARGET_PCT, trailPct: cfg.NSE_OPTION_TRAIL_PCT },
        scanIntervalMinutes: cfg.SCAN_INTERVAL_MINUTES,
        pricePollSeconds: cfg.PRICE_POLL_SECONDS,
        gold: {
            symbol: 'XAUUSD',
            marginInr: cfg.GOLD_MARGIN_INR,
            leverage: cfg.GOLD_LEVERAGE,
            stopRisk: cfg.GOLD_STOP_RISK,
            minRR: cfg.MIN_RR,
            maxRR: cfg.MAX_RR,
            roundTheClock: true,
        },
        eth: {
            symbol: 'ETHUSD',
            marginInr: cfg.ETH_MARGIN_INR,
            leverage: cfg.ETH_LEVERAGE,
            stopRisk: cfg.ETH_STOP_RISK,
            minRR: cfg.MIN_RR,
            maxRR: cfg.MAX_RR,
            roundTheClock: true,
        },
        // Per-trade SL/TP model: levels come from each trade's own setup.
        riskPlan: {
            atrStopMult: cfg.ATR_STOP_MULT,
            minRR: cfg.MIN_RR,
            maxRR: cfg.MAX_RR,
            maxRiskInr: cfg.MAX_RISK_INR,
            profitBookInr: cfg.PROFIT_BOOK_INR,
        },
        inrUsdRate: cfg.INR_USD_RATE,
        // Self-training: what the nightly trainer is allowed to do, and where
        // it currently stands (the live model status is filled in by the
        // engine, which owns the database).
        ml: {
            enabled: cfg.ML_TRAIN_ENABLED,
            trainHourIst: cfg.ML_TRAIN_HOUR_IST,
            minTrades: cfg.ML_MIN_TRADES,
            minTest: cfg.ML_MIN_TEST,
            minAcc: cfg.ML_MIN_ACC,
            gateMode: cfg.ML_GATE_MODE,
            gateThreshold: cfg.ML_GATE_THRESHOLD,
            keepVersions: cfg.ML_KEEP_VERSIONS,
            features: 16,
        },
        // System-1 decision gate (Jev/Laya-style). Live stats (calls today,
        // last verdict, error state) are filled in by the engine.
        system1: {
            provider: cfg.SYSTEM1_PROVIDER,
            model: (cfg.SYSTEM1_MODEL || '').trim() || (cfg.SYSTEM1_PROVIDER === 'gemini' ? 'gemini-3.8-flash' : 'openai/gpt-oss-120b'),
            mode: cfg.SYSTEM1_GATE_MODE,
            convictionMin: cfg.SYSTEM1_CONVICTION_MIN,
            timeoutMs: cfg.SYSTEM1_TIMEOUT_MS,
            maxPerDay: cfg.SYSTEM1_MAX_PER_DAY,
            cooldownMs: cfg.SYSTEM1_COOLDOWN_MS,
            configured: cfg.SYSTEM1_PROVIDER === 'gemini'
                ? Boolean((cfg.SYSTEM1_GEMINI_API_KEY || cfg.GEMINI_API_KEY || cfg.SYSTEM1_API_KEY || '').trim())
                : Boolean((cfg.SYSTEM1_API_KEY || cfg.GROQ_API_KEY || '').trim()),
        },
        // Where each venue's charges come from, so the dashboard can show them.
        fees: {
            gold: { venue: 'Delta Exchange', side: cfg.DELTA_FEE_SIDE, pct: cfg.DELTA_FEE_SIDE === 'maker' ? cfg.DELTA_FEE_GOLD_MAKER_PCT : cfg.DELTA_FEE_GOLD_TAKER_PCT, gstPct: cfg.FEE_GST_PCT },
            eth: { venue: 'Delta Exchange', side: cfg.DELTA_FEE_SIDE, pct: cfg.DELTA_FEE_SIDE === 'maker' ? cfg.DELTA_FEE_ETH_MAKER_PCT : cfg.DELTA_FEE_ETH_TAKER_PCT, gstPct: cfg.FEE_GST_PCT },
            nse: { venue: 'NSE F&O', brokerageFlat: cfg.FEE_BROKERAGE_FLAT, brokeragePct: cfg.FEE_BROKERAGE_PCT, gstPct: cfg.FEE_GST_PCT },
        },
    };
}

export function ensureDirs(cfg) {
    fs.mkdirSync(cfg.LOG_DIR, { recursive: true });
    if (cfg.DATABASE_PATH !== ':memory:') fs.mkdirSync(path.dirname(cfg.DATABASE_PATH), { recursive: true });
}
