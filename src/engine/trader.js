/**
 * One independent virtual trader per strategy.
 *
 * Owns: its schedule, its scans, its gating decisions, its orders. A failure in
 * one trader is caught, logged and retried here; it never stops another trader.
 */

import { sessionPhase, hhmmToMinutes, istMinutes, sessionDate } from '../market/clock.js';
import { scheduleFor } from '../strategies/registry.js';
import { OptionsFeed } from '../market/options.js';
import { signalText } from '../db/mongo.js';

const RETRY_AFTER_MS = 2 * 60_000;
const MAX_ATTEMPTS_PER_SLOT = 3;

const pad = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export class Trader {
    /**
     * @param {object} o
     * @param {object} o.def registry entry
     * @param {number} o.strategyId DB id
     * @param {import('../strategies/sourceStrategy.js').SourceStrategy} o.strategy
     * @param {object} o.ctx shared services { cfg, db, logger, positions, marketData, now }
     */
    constructor({ def, strategyId, strategy, ctx }) {
        this.def = def;
        this.id = strategyId;
        this.code = def.code;
        this.strategy = strategy;
        this.ctx = ctx;
        this.busy = false;
        this.lastError = null;
        this.consecutiveErrors = 0;
        this.lastScanSummary = null;
        this.statusCache = { status: 'STOPPED', detail: null };
        this.optionsFeed = new OptionsFeed({ logger: ctx.logger });
    }

    get enabled() {
        return Boolean(this.ctx.db.getStrategy(this.id)?.enabled);
    }

    setStatus(status, detail = null) {
        if (this.statusCache.status === status && this.statusCache.detail === detail) return;
        this.statusCache = { status, detail };
        this.ctx.db.setStrategyStatus(this.id, status, detail);
    }

    /** Scan slots for today as minutes past midnight IST, with labels. */
    slots() {
        const { cfg } = this.ctx;
        if (this.def.roundTheClock) {
            const m = this.def.rescanMinutes ?? (String(this.def.key || '').startsWith('eth_') ? cfg.ETH_SCAN_INTERVAL_MINUTES : cfg.GOLD_SCAN_INTERVAL_MINUTES);
            return [{ minute: 0, label: `24h every ${m}m` }];
        }
        const { clock, rescanMinutes } = scheduleFor(this.def, cfg);
        const cutoff = hhmmToMinutes(cfg.ENTRY_CUTOFF);
        const out = new Map();
        for (const t of clock) {
            const m = hhmmToMinutes(t);
            if (m < cutoff) out.set(m, `clock ${pad(m)}`);
        }
        if (rescanMinutes > 0 && out.size) {
            const first = Math.min(...out.keys());
            for (let m = first + rescanMinutes; m < cutoff; m += rescanMinutes) if (!out.has(m)) out.set(m, `rescan ${pad(m)}`);
        }
        return [...out.entries()].sort((a, b) => a[0] - b[0]).map(([minute, label]) => ({ minute, label }));
    }

    nextSlotLabel(now) {
        const m = istMinutes(now);
        const next = this.slots().find((s) => s.minute > m);
        return next ? next.label : null;
    }

    /** Called by the engine scheduler. Never throws. */
    async tick() {
        const { cfg, db, now } = this.ctx;
        const t = now();
        try {
            if (!this.enabled) return this.setStatus('DISABLED', 'disabled in dashboard or STRATEGY_<KEY>_ENABLED=false');
            if (this.def.roundTheClock) return this._tick247(t);
            const ph = sessionPhase(cfg, t);
            if (!ph.tradingDay) return this.setStatus('WAITING', `market closed: ${ph.reason}`);
            if (ph.phase === 'PRE_OPEN') return this.setStatus('WAITING', `first scan ${this.slots()[0]?.label || 'n/a'}`);
            if (ph.phase !== 'OPEN') {
                return this.setStatus('RUNNING', ph.phase === 'ENTRY_CLOSED' ? 'monitoring open positions, no new entries' : 'session complete');
            }
            if (this.busy) return;

            const m = istMinutes(t);
            const due = this.slots().filter((s) => s.minute <= m).pop();
            if (!due) return this.setStatus('WAITING', `first scan ${this.slots()[0]?.label || 'n/a'}`);

            const day = ph.date;
            const attempts = db.scansOn(this.id, day).filter((s) => s.trigger === due.label);
            if (attempts.some((s) => s.ok === 1)) return this._idleStatus(t);
            if (attempts.length >= MAX_ATTEMPTS_PER_SLOT) return;
            if (attempts.length && this.lastError && t - this.lastError.at < RETRY_AFTER_MS) return;

            await this.runScan(due.label, day);
        } catch (err) {
            this._fail(err, 'tick');
        }
    }

    /** 24h scanner: no trading-day / session-phase gating, rescans on an interval. */
    async _tick247(t) {
        const { cfg, db, now } = this.ctx;
        if (this.busy) return;
        const intervalMs = (this.def.rescanMinutes ?? this._roundInterval(cfg)) * 60_000;
        const last = db.lastScan(this.id);
        const age = last?.finished_at ? now() - last.finished_at : Infinity;
        if (age < intervalMs) {
            if (this.consecutiveErrors === 0) {
                const remainMs = Math.max(0, intervalMs - age);
                const mm = Math.floor(remainMs / 60_000);
                const ss = Math.ceil((remainMs % 60_000) / 1000);
                this.setStatus('RUNNING', `24h · next scan in ${mm}m ${String(ss).padStart(2, '0')}s`);
            }
            return;
        }
        if (this.lastError && now() - this.lastError.at < RETRY_AFTER_MS) return;
        await this.runScan('24h', sessionDate(now()));
    }

    /** Rescan interval for a 24h trader: ETH has its own, gold has its own. */
    _roundInterval(cfg) {
        if (String(this.def.key || '').startsWith('eth_')) return cfg.ETH_SCAN_INTERVAL_MINUTES;
        return cfg.GOLD_SCAN_INTERVAL_MINUTES;
    }

    _idleStatus(t) {
        if (this.consecutiveErrors > 0) return;
        const aiOk = this.strategy.aiAvailable();
        if (!aiOk && this.lastScanSummary && this.lastScanSummary.setups === 0 && this.def.needsAiHint) {
            return this.setStatus('AWAITING_AI', 'source gives no levels; add an AI key to .env to trade it');
        }
        if (this.def.roundTheClock) {
            const m = this.def.rescanMinutes ?? this._roundInterval(this.ctx.cfg);
            return this.setStatus('RUNNING', `24h · scanning every ${m}m`);
        }
        const next = this.nextSlotLabel(t);
        this.setStatus('RUNNING', next ? `next scan ${next}` : 'last scan of the day done');
    }

    _fail(err, where) {
        this.consecutiveErrors += 1;
        this.lastError = { at: this.ctx.now(), message: String(err?.message || err), where };
        this.ctx.logger.error(this.code, 'ERROR', `${where}: ${this.lastError.message}`);
        this.setStatus('ERROR', `${where}: ${this.lastError.message}`.slice(0, 300));
    }

    /**
     * Scan -> gate -> select -> place orders. Public for tests and manual runs.
     * @param {string} trigger slot label
     * @param {string} [day] IST session date
     */
    async runScan(trigger = 'manual', day = sessionDate(this.ctx.now())) {
        const { cfg, db, logger } = this.ctx;
        if (this.busy) return null;
        this.busy = true;
        const scanId = db.startScan(this.id, day, trigger);
        const summary = { candidates: 0, setups: 0, accepted: 0, rejected: 0, watch: 0, errors: 0 };
        try {
            this.setStatus('RUNNING', `scanning (${trigger})`);
            logger.info(this.code, 'SCAN', `${this.def.key} [${trigger}]`);
            const { discovery, candidates } = await this.strategy.discover();
            summary.candidates = candidates.length;
            summary.setups = candidates.filter((c) => c.setup).length;

            const evaluated = cfg.ALLOW_DUPLICATE_POSITIONS ? new Set() : db.evaluatedSymbols(this.id, day);
            const fresh = [];
            for (const c of candidates) {
                if (evaluated.has(c.symbol) || db.hasLiveExposure(this.id, c.symbol)) {
                    logger.debug(this.code, 'DUPLICATE', `${c.symbol} already handled today, ignored`);
                    continue;
                }
                fresh.push(c);
            }

            const capacity = cfg.MAX_TRADES_PER_STRATEGY_PER_DAY - db.countEntriesOn(this.id, day);
            const useAi = this.strategy.aiAvailable();

            // Risk controls first: a blocked strategy skips evaluation entirely
            // (no wasted AI calls, no silent entries).
            const riskBlock = this._riskBlock(day);
            if (riskBlock) {
                logger.info(this.code, 'RISK BLOCK', riskBlock);
                db.finishScan(scanId, { ok: true, ...summary, detail: { useAi, capacity, riskBlock } });
                this.lastScanSummary = { ...summary, at: this.ctx.now(), trigger };
                this._idleStatus(this.ctx.now());
                return summary;
            }

            const { decisions } = capacity > 0 && fresh.length
                ? await this.strategy.evaluateBatch(fresh, discovery, { useAi, capacity })
                : { decisions: [] };

            for (const d of decisions) await this._record(d, { scanId, day, summary, discovery, useAi });

            if (capacity <= 0) logger.info(this.code, 'DAILY LIMIT', `${cfg.MAX_TRADES_PER_STRATEGY_PER_DAY} entries reached today`);
            db.finishScan(scanId, {
                ok: true,
                ...summary,
                detail: {
                    useAi,
                    capacity,
                    symbols: candidates.map((c) => c.symbol),
                    sentiment: discovery.heatmap?.sentiment?.label || discovery.macro?.bias?.label || null,
                    regime: discovery.heatmap?.regime?.label || null,
                    marketMode: discovery.marketModeLabel || null,
                },
            });
            this.lastScanSummary = { ...summary, at: this.ctx.now(), trigger };
            this.consecutiveErrors = 0;
            this.lastError = null;
            this._idleStatus(this.ctx.now());
            logger.info(this.code, 'SCAN DONE', `${summary.candidates} candidates, ${summary.setups} setups, ${summary.accepted} accepted, ${summary.rejected} rejected`);
            return summary;
        } catch (err) {
            db.finishScan(scanId, { ok: false, ...summary, error: String(err?.message || err).slice(0, 500) });
            this._fail(err, `scan ${trigger}`);
            return null;
        } finally {
            this.busy = false;
        }
    }

    /** Cooldown after a stop-loss, or a daily loss limit hit. Null when clear to trade. */
    _riskBlock(day) {
        const { cfg, db, now } = this.ctx;
        const cooldownMs = cfg.STRATEGY_COOLDOWN_MINUTES * 60_000;
        if (cooldownMs > 0) {
            const lastStop = db
                .closedTrades({ strategyId: this.id })
                .filter((t) => t.exit_reason === 'STOP_LOSS' || t.exit_reason === 'TRAILING_STOP')
                .sort((a, b) => b.exit_time - a.exit_time)[0];
            if (lastStop && now() - lastStop.exit_time < cooldownMs) {
                return `cooldown ${Math.ceil((cooldownMs - (now() - lastStop.exit_time)) / 60000)}m after stop`;
            }
        }
        if (cfg.DAILY_LOSS_LIMIT_INR > 0) {
            const todayPnl = db.closedTrades({ strategyId: this.id, from: day, to: day })
                .reduce((s, t) => s + (t.net_pnl || 0), 0);
            if (todayPnl <= -cfg.DAILY_LOSS_LIMIT_INR) {
                return `daily loss limit ₹${cfg.DAILY_LOSS_LIMIT_INR} hit (₹${Math.round(todayPnl)})`;
            }
        }
        return null;
    }

    /** Build an ATM CE/PE option signal from an NSE underlying setup.
     * Premium risk matches the position overlay: stop at NSE_OPTION_STOP_PCT
     * of the premium, target 2x that (1:2 R:R). */
    async _optionSignal(d, setup) {
        const { cfg } = this.ctx;
        const quote = await this.optionsFeed.entryQuote(d.symbol, d.direction);
        if (!quote) return { optionSignal: null, metaPatch: {} };
        const entry = quote.premium;
        const stopPct = (cfg.NSE_OPTION_STOP_PCT ?? 30) / 100;
        if (!(entry > 0)) return { optionSignal: null, metaPatch: {} };
        const premiumRisk = entry * stopPct;
        const stop = Math.round((entry - premiumRisk) * 100) / 100;
        const target = Math.round((entry + 2 * premiumRisk) * 100) / 100;
        if (!(stop > 0)) return { optionSignal: null, metaPatch: {} };
        const optionSignal = {
            symbol: quote.symbol,
            direction: 'LONG', // buy the CE/PE premium
            orderType: 'MARKET',
            referencePrice: entry,
            entry,
            stop,
            target,
            metadata: null,
        };
        return {
            optionSignal,
            metaPatch: {
                underlying: d.symbol,
                option: { type: quote.type, strike: quote.strike, entryPremium: entry, spot: quote.spot },
                underlyingSetup: { entry: setup.entry, stop: setup.stop, target: setup.target },
            },
        };
    }

    async _record(d, { scanId, day, summary, useAi }) {
        const { db, logger, positions } = this.ctx;
        const meta = {
            source: this.def.key,
            strategyCode: this.code,
            setup: d.setup || null,
            confluence: d.confluence ?? null,
            ai: d.ai || null,
            aiMode: useAi ? 'AI_GATE' : 'NO_AI',
            softGate: Boolean(d.softGate),
            isHiddenGem: Boolean(d.isHiddenGem),
            // Last ~90 1m bars at decision time — the training feature window.
            featureBars: d.bars ?? null,
        };
        const base = { strategyId: this.id, scanId, sessionDate: day, symbol: d.symbol, direction: d.direction ?? null, filterCondition: d.filterCondition ?? null, metadata: meta };
        // Mirror every signal to MongoDB for future AI/RAG work. Never throws.
        const mirror = (signalType, status, extra = {}) => {
            try {
                const mongo = this.ctx.mongo;
                if (!mongo?.enabled) return;
                const doc = {
                    ts: this.ctx.now(),
                    sessionDate: day,
                    strategyCode: this.code,
                    source: this.def.key,
                    symbol: d.symbol,
                    direction: d.direction ?? null,
                    signalType,
                    status,
                    price: extra.price ?? d.refPrice ?? null,
                    reason: extra.reason ?? d.reason ?? null,
                    filterCondition: d.filterCondition ?? null,
                    setup: d.setup || null,
                    confluence: d.confluence ?? null,
                    ai: d.ai || null,
                    aiMode: useAi ? 'AI_GATE' : 'NO_AI',
                    softGate: Boolean(d.softGate),
                    isHiddenGem: Boolean(d.isHiddenGem),
                    featureBars: d.bars ?? null,
                    option: meta.option || null,
                    underlying: meta.underlying || null,
                };
                doc.text = signalText(doc);
                mongo.push('signals', doc);
            } catch {
                /* mirroring must never break trading */
            }
        };

        if (d.decision === 'NO_SETUP') {
            summary.watch += 1;
            if (!db.listSignals({ strategyId: this.id, sessionDate: day, limit: 500 }).some((s) => s.symbol === d.symbol && s.status === 'WATCH')) {
                db.insertSignal({ ...base, signalType: 'WATCH', status: 'WATCH', rejectReason: d.reason, price: d.refPrice ?? null });
                mirror('WATCH', 'WATCH');
            }
            return;
        }
        if (d.decision === 'ERROR') {
            summary.errors += 1;
            db.insertSignal({ ...base, signalType: 'ANALYSIS', status: 'ERROR', rejectReason: d.reason });
            logger.warn(this.code, 'SIGNAL ERROR', `${d.symbol}: ${d.reason}`);
            mirror('ANALYSIS', 'ERROR');
            return;
        }

        const setup = d.setup;
        let signal = setup
            ? { symbol: d.symbol, direction: d.direction, orderType: 'STOP_ENTRY', entry: setup.entry, stop: setup.stop, target: setup.target, target2: setup.target2 }
            : { symbol: d.symbol, direction: d.direction, orderType: 'MARKET', referencePrice: d.refPrice ?? this.ctx.marketData.lastQuote(d.symbol)?.price ?? null };

        // NSE sources trade the CE/PE option premium instead of the underlying.
        if (this.ctx.cfg.NSE_TRADE_OPTIONS && !this.def.roundTheClock && d.selected && setup) {
            try {
                const { optionSignal, metaPatch } = await this._optionSignal(d, setup);
                if (optionSignal) {
                    signal = optionSignal;
                    Object.assign(meta, metaPatch);
                }
            } catch (err) {
                db.insertSignal({ ...base, signalType: 'ANALYSIS', status: 'ERROR', rejectReason: `option chain: ${err.message}` });
                summary.errors += 1;
                mirror('ANALYSIS', 'ERROR', { reason: `option chain: ${err.message}` });
                return;
            }
        }

        if (d.lotSize) signal.lotSize = d.lotSize;
        signal.filterCondition = d.filterCondition;
        signal.metadata = meta;
        const price = signal.orderType === 'MARKET' ? signal.referencePrice : setup?.entry;

        if (!d.selected) {
            summary.rejected += 1;
            db.insertSignal({ ...base, signalType: setup ? 'SETUP' : 'AI_DIRECTION', status: 'REJECTED', rejectReason: d.reason || 'gate', price });
            logger.info(this.code, 'SIGNAL REJECTED', `${d.direction ? (d.direction === 'LONG' ? 'BUY' : 'SELL') + ' ' : ''}${d.symbol}: ${d.reason || 'gate'}`);
            mirror(setup ? 'SETUP' : 'AI_DIRECTION', 'REJECTED', { price });
            return;
        }

        const signalId = db.insertSignal({ ...base, signalType: setup ? 'SETUP' : 'AI_DIRECTION', status: 'ACCEPTED', price });
        mirror(setup ? 'SETUP' : 'AI_DIRECTION', 'ACCEPTED', { price });
        logger.info(this.code, 'SIGNAL', `${d.direction === 'LONG' ? 'BUY' : 'SELL'} ${d.symbol} @ ${price ?? 'market'}${d.softGate ? ' (soft gate)' : ''}`, { filter: d.filterCondition });
        const placed = positions.placeEntry({ strategyId: this.id, signalId, signal, sessionDate: day });
        if (!placed.ok) {
            db.updateSignalStatus(signalId, 'REJECTED', placed.reason);
            summary.rejected += 1;
            logger.warn(this.code, 'SIGNAL REJECTED', `${d.symbol}: ${placed.reason}`);
            return;
        }
        summary.accepted += 1;
    }
}

