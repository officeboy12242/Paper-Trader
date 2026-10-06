/**
 * Order book + position lifecycle for every strategy.
 *
 * All state lives in SQLite; this class keeps nothing in memory between passes,
 * which is what makes a restart (or a crash) lose nothing. Each pass replays the
 * 1-minute bars after the last fully-processed bar, so a stop that printed while
 * the process or the feed was down is still honoured, at the price it printed.
 *
 * Per-bar order of checks (pessimistic, as in WA-BOT's TradeOutcomeResolver):
 *   1. protective stop (initial or trailing)  -> exit
 *   2. target: trailing off -> exit at target; trailing on -> arm trailing
 *   3. trailing ratchet (closed bars only)
 * A bar is "closed" once a later bar exists (or it is >5 min old). Stops are
 * only ever tightened on closed bars, so a still-forming bar cannot both raise
 * and hit the same stop.
 */

import { LONG, dirSign, finalizeLevels, activateTrailing, ratchetTrailing, grossPnl, round2 } from './risk.js';
import { roundTripFees } from './fees.js';
import { validateSignal } from './signals.js';
import { istTimestamp, sessionDate } from '../market/clock.js';
import { mapPool } from '../market/marketData.js';
import { OptionsFeed, parseOptionSymbol, underlyingOf } from '../market/options.js';

const MIN = 60_000;

export const EXIT_REASONS = ['TARGET', 'TRAILING_STOP', 'STOP_LOSS', 'EOD_SQUARE_OFF'];

export class PositionManager {
    /**
     * @param {object} o
     * @param {import('../db/database.js').Database} o.db
     * @param {object} o.cfg
     * @param {import('./execution.js').PaperExecutionAdapter} o.adapter
     * @param {import('../logger.js').Logger} o.logger
     * @param {import('../market/marketData.js').MarketDataService} o.marketData
     * @param {import('../market/lotSizes.js').LotSizeService} o.lotSizes
     * @param {() => number} [o.now]
     * @param {(trade: object) => void} [o.onTradeClosed]
     * @param {(strategyId: number) => string} [o.codeOf]
     */
    constructor({ db, cfg, adapter, logger, marketData, lotSizes, now = Date.now, onTradeClosed = () => {}, codeOf = (id) => `Strategy-${String(id).padStart(2, '0')}`, strategyById = () => null }) {
        if (adapter?.mode !== 'PAPER') throw new Error('PositionManager requires the paper execution adapter');
        Object.assign(this, { db, cfg, adapter, logger, marketData, lotSizes, now, onTradeClosed, codeOf, strategyById });
        this.optionsFeed = new OptionsFeed({ logger, now });
        this.lastPass = null;
        this.lastPassError = null;
    }

    // ── entries ──────────────────────────────────────────────────────────────

    /**
     * Turn an accepted, validated signal into a resting paper order.
     * @returns {{ ok: true, orderId: number } | { ok: false, reason: string }}
     */
    placeEntry({ strategyId, signalId, signal, sessionDate: day }) {
        const v = validateSignal(signal);
        if (!v.ok) return v;
        if (!this.cfg.ALLOW_DUPLICATE_POSITIONS && this.db.hasLiveExposure(strategyId, signal.symbol)) {
            return { ok: false, reason: 'duplicate: position or order already live for this symbol' };
        }
        const lotUnderlying = underlyingOf(signal.symbol);
        const { lotSize, source } = this.lotSizes.resolve(lotUnderlying);
        const effLotSize = signal.lotSize ?? lotSize;
        const effSource = signal.lotSize ? 'strategy' : source;
        const lots = this.cfg.LOT_SIZE;
        const quantity = lots * effLotSize;
        const createdAt = this.now();
        const roundTheClock = Boolean(this.strategyById(strategyId)?.roundTheClock);
        const orderId = this.db.insertOrder({
            strategyId,
            signalId,
            sessionDate: day,
            symbol: signal.symbol,
            direction: signal.direction,
            orderType: signal.orderType,
            quantity,
            lots,
            lotSize: effLotSize,
            lotSizeSource: effSource,
            triggerPrice: signal.orderType === 'MARKET' ? signal.referencePrice : signal.entry,
            createdAt,
            expiresAt: roundTheClock ? createdAt + 24 * 3600_000 : istTimestamp(day, this.cfg.ENTRY_CUTOFF),
            riskPlan: {
                sourceEntry: signal.entry ?? null,
                sourceStop: signal.stop ?? null,
                sourceTarget: signal.target ?? null,
                sourceTarget2: signal.target2 ?? null,
                filterCondition: signal.filterCondition ?? null,
                metadata: signal.metadata ?? null,
            },
        });
        const code = this.codeOf(strategyId);
        const what = signal.orderType === 'MARKET' ? 'at market' : `stop @ ${signal.entry}`;
        this.logger.info(code, 'ORDER', `${signal.direction === LONG ? 'BUY' : 'SELL'} ${lots} LOT ${signal.symbol} (${quantity} qty, ${what})`);
        this.db.insertEvent({ strategyId, orderId, type: 'ORDER_PLACED', price: signal.entry ?? signal.referencePrice, message: `${signal.orderType} ${signal.direction} ${signal.symbol} qty ${quantity}`, detail: { lotSize: effLotSize, lotSizeSource: effSource } });
        return { ok: true, orderId };
    }

    // ── monitoring pass ──────────────────────────────────────────────────────

    /** One full pass over every pending order and open trade. Never throws. */
    /** Synthetic 1m premium bar for an option position; also updates its live quote. */
    async _optionBars(symbol) {
        const bar = await this.optionsFeed.premiumBar(symbol);
        if (!bar) return null;
        this.marketData.setQuote(symbol, bar.close, bar.ts);
        return [bar];
    }

    async monitor() {
        const started = this.now();
        try {
            const orders = this.db.pendingOrders();
            const trades = this.db.openTrades();
            const groups = new Map();
            for (const o of orders) this._group(groups, o.symbol, o.session_date, o.strategy_id).orders.push(o);
            for (const t of trades) this._group(groups, t.symbol, t.session_date, t.strategy_id).trades.push(t);

            const results = await mapPool([...groups.values()], this.cfg.MARKET_DATA_CONCURRENCY, async (g) => {
                let bars = null;
                try {
                    const continuous = Boolean(this.strategyById(g.strategyId)?.roundTheClock);
                    if (g.symbol.startsWith('OPT-')) {
                        bars = await this._optionBars(g.symbol);
                    } else {
                        bars = await this.marketData.getBars(g.symbol, { session: g.session, continuous });
                    }
                } catch {
                    bars = null; // feed failure: positions untouched, retried next pass
                }
                this._processGroup(g, bars);
            });
            const failed = results.filter((r) => !r.ok);
            for (const f of failed) this.logger.error('ENGINE', 'MONITOR ERROR', String(f.error?.stack || f.error));
            this.lastPass = { at: started, ms: this.now() - started, symbols: groups.size, orders: orders.length, trades: trades.length, failed: failed.length };
            this.lastPassError = null;
            return this.lastPass;
        } catch (err) {
            this.lastPassError = { at: started, message: String(err?.message || err) };
            this.logger.error('ENGINE', 'MONITOR ERROR', String(err?.stack || err));
            return null;
        }
    }

    _group(map, symbol, session, strategyId) {
        const key = `${symbol}|${session}|${strategyId}`;
        if (!map.has(key)) map.set(key, { symbol, session, strategyId, orders: [], trades: [] });
        return map.get(key);
    }

    _processGroup(g, bars) {
        const now = this.now();
        for (const order of g.orders) this._processOrder(order, bars, now);
        for (const trade of g.trades) this._processTrade(trade, bars, now);
    }

    _isClosed(bar, bars, now) {
        return bar !== bars[bars.length - 1] || now - bar.ts > 5 * MIN;
    }

    // ── orders ───────────────────────────────────────────────────────────────

    _processOrder(order, bars, now) {
        const code = this.codeOf(order.strategy_id);
        if (bars) {
            const firstTs = Math.floor(order.created_at / MIN) * MIN + MIN; // bars that start after the signal
            const cursor = order.last_bar_ts ?? -Infinity;
            let newCursor = order.last_bar_ts;
            for (const bar of bars) {
                if (bar.ts < firstTs || bar.ts <= cursor || bar.ts >= order.expires_at) continue;
                const fill = order.order_type === 'MARKET'
                    ? this.adapter.marketEntry({ direction: order.direction, bar })
                    : this.adapter.stopEntry({ direction: order.direction, trigger: order.trigger_price, bar });
                if (fill) {
                    const trade = this._openTrade(order, fill, bar);
                    this._processTrade(trade, bars, now);
                    return;
                }
                if (this._isClosed(bar, bars, now)) newCursor = bar.ts;
            }
            if (newCursor !== order.last_bar_ts) this.db.setOrderBarCursor(order.id, newCursor);
        }
        // Expiry is final only once the feed has had a chance to show every bar before it.
        if (now >= order.expires_at && (bars || now >= order.expires_at + 30 * MIN)) {
            const ttl = this.strategyById(order.strategy_id)?.roundTheClock ? '24h TTL' : this.cfg.ENTRY_CUTOFF;
            this.db.closeOrder(order.id, 'EXPIRED', `not triggered by ${ttl}`);
            this.db.insertEvent({ strategyId: order.strategy_id, orderId: order.id, type: 'ORDER_EXPIRED', price: order.trigger_price, message: `${order.symbol} entry not triggered by ${ttl}` });
            this.logger.info(code, 'ORDER EXPIRED', `${order.symbol} trigger ${order.trigger_price} never traded`);
        }
    }

    _openTrade(order, fill, bar) {
        const plan = order.risk_plan || {};
        // Option premiums need their own risk scale: a 5% equity stop on a
        // ₹100 premium is noise. Use the option overlay instead.
        const effCfg = order.symbol.startsWith('OPT-')
            ? {
                ...this.cfg,
                STOP_LOSS_PERCENT: this.cfg.NSE_OPTION_STOP_PCT,
                MIN_TARGET: this.cfg.NSE_OPTION_MIN_TARGET_PCT,
                MIN_TARGET_UNIT: 'percent',
                TRAIL_DISTANCE: this.cfg.NSE_OPTION_TRAIL_PCT,
                TRAIL_DISTANCE_UNIT: 'percent',
            }
            : this.cfg;
        const lv = finalizeLevels(
            { direction: order.direction, fill: fill.price, quantity: order.quantity, sourceStop: plan.sourceStop, sourceTarget: plan.sourceTarget },
            effCfg
        );
        const entryTime = Math.max(bar.ts, order.created_at);
        const filter = plan.filterCondition || null;
        const tradeId = this.db.tx(() => {
            this.db.markOrderFilled(order.id, fill.price, entryTime);
            return this.db.insertTrade({
                strategyId: order.strategy_id,
                signalId: order.signal_id,
                orderId: order.id,
                sessionDate: order.session_date,
                symbol: order.symbol,
                direction: order.direction,
                quantity: order.quantity,
                lots: order.lots,
                lotSize: order.lot_size,
                lotSizeSource: order.lot_size_source,
                entryPrice: fill.price,
                entryTime,
                sourceEntry: plan.sourceEntry,
                targetPrice: lv.target,
                sourceTarget: plan.sourceTarget,
                stopLossPrice: lv.stop,
                sourceStop: plan.sourceStop,
                hardStop: lv.hardStop,
                initialStop: lv.stop,
                trailingEnabled: this.cfg.TRAILING_ENABLED,
                trailDistance: lv.trailDistance,
                lastBarTs: bar.ts - 1, // the fill bar itself is checked for a stop (pessimistic)
                filterCondition: filter,
                metadata: { ...(plan.metadata || {}), levels: lv, fill: { basePrice: fill.basePrice, gapped: fill.gapped, barTs: bar.ts }, sourceTarget2: plan.sourceTarget2 },
            });
        });
        const code = this.codeOf(order.strategy_id);
        this.logger.info(code, 'PAPER ENTRY', `${order.lots} LOT ${order.symbol} ${order.direction} @ ${fill.price} qty ${order.quantity} | SL ${lv.stop} (${lv.stopBasis}) TGT ${lv.target} (${lv.targetBasis})`);
        this.db.insertEvent({ strategyId: order.strategy_id, tradeId, orderId: order.id, ts: entryTime, type: 'ENTRY', price: fill.price, message: `${order.direction} ${order.quantity} ${order.symbol}`, detail: lv });
        return this.db.getTrade(tradeId);
    }

    // ── open trades ──────────────────────────────────────────────────────────

    _processTrade(trade, bars, now) {
        const roundTheClock = Boolean(this.strategyById(trade.strategy_id)?.roundTheClock);
        const eodTs = roundTheClock ? Infinity : istTimestamp(trade.session_date, this.cfg.EOD_SQUARE_OFF);
        const code = this.codeOf(trade.strategy_id);
        const d = dirSign(trade.direction);
        let changed = false;

        if (bars) {
            const entryBarTs = Math.floor(trade.entry_time / MIN) * MIN;
            const cursor = trade.last_bar_ts ?? entryBarTs - 1;
            for (const bar of bars) {
                if (bar.ts <= cursor || bar.ts < entryBarTs || bar.ts >= eodTs) continue;
                const closed = this._isClosed(bar, bars, now);

                const stopHit = this.adapter.stopExit({ direction: trade.direction, stop: trade.stop_loss_price, bar });
                if (stopHit) {
                    const reason = trade.trailing_active ? 'TRAILING_STOP' : 'STOP_LOSS';
                    this._close(trade, stopHit.price, Math.max(bar.ts, trade.entry_time), reason, { stop: trade.stop_loss_price, gapped: stopHit.gapped });
                    return;
                }

                if (!trade.trailing_active) {
                    const targetHit = d > 0 ? bar.high >= trade.target_price : bar.low <= trade.target_price;
                    if (targetHit && !trade.trailing_enabled) {
                        const t = this.adapter.targetExit({ direction: trade.direction, target: trade.target_price, bar });
                        this._close(trade, t.price, Math.max(bar.ts, trade.entry_time), 'TARGET', { target: trade.target_price });
                        return;
                    }
                    if (targetHit && closed) {
                        const r = activateTrailing(trade, d > 0 ? bar.high : bar.low, this.cfg);
                        Object.assign(trade, { trailing_active: 1, stop_loss_price: r.stop, trailing_stop: r.stop, high_water: r.highWater, trail_from_ts: bar.ts + MIN });
                        changed = true;
                        this.logger.info(code, 'TRAILING STOP ACTIVATED', `${trade.symbol} target ${trade.target_price} reached, stop -> ${r.stop} (trail ${trade.trail_distance})`);
                        this.db.insertEvent({ strategyId: trade.strategy_id, tradeId: trade.id, ts: bar.ts, type: 'TRAILING_ACTIVATED', price: r.stop, message: `target ${trade.target_price} reached` });
                    }
                } else if (closed) {
                    const r = ratchetTrailing(trade, d > 0 ? bar.high : bar.low);
                    if (r.moved) {
                        this.db.insertEvent({ strategyId: trade.strategy_id, tradeId: trade.id, ts: bar.ts, type: 'TRAIL_RAISED', price: r.stop, message: `${trade.stop_loss_price} -> ${r.stop}` });
                        this.logger.debug(code, 'TRAIL RAISED', `${trade.symbol} ${trade.stop_loss_price} -> ${r.stop}`);
                    }
                    Object.assign(trade, { stop_loss_price: r.stop, trailing_stop: r.stop, high_water: r.highWater });
                    changed = true;
                }

                trade.last_price = bar.close;
                trade.last_price_time = closed ? bar.ts + MIN : now;
                if (closed) trade.last_bar_ts = bar.ts;
                changed = true;
            }
        }

        if (now >= eodTs) {
            const before = (bars || []).filter((b) => b.ts < eodTs && b.ts >= Math.floor(trade.entry_time / MIN) * MIN);
            const last = before[before.length - 1];
            // Without bars we wait up to 30 min for the feed, then use the last known price.
            if (last || now >= eodTs + 30 * MIN) {
                const px = last ? last.close : trade.last_price ?? trade.entry_price;
                const ex = this.adapter.marketExit({ direction: trade.direction, price: px });
                this._close(trade, ex.price, eodTs, 'EOD_SQUARE_OFF', { basis: last ? 'last bar before square-off' : 'last known price (feed unavailable)' });
                return;
            }
        }
        if (changed) this.db.updateTradeState(trade);
    }

    _close(trade, exitPrice, exitTime, reason, detail = {}) {
        const price = round2(exitPrice);
        const rate = this.strategyById(trade.strategy_id)?.roundTheClock ? this.cfg.INR_USD_RATE || 84 : 1;
        const gross = round2(grossPnl(trade.direction, trade.entry_price, price, trade.quantity) * rate);
        // Fees are computed in quote currency (USD for gold/ETH) — convert like gross.
        const fees = round2(roundTripFees({ direction: trade.direction, entryPrice: trade.entry_price, exitPrice: price, quantity: trade.quantity }, this.cfg) * rate);
        const net = round2(gross - fees);
        const holdingSeconds = Math.max(0, Math.round((exitTime - trade.entry_time) / 1000));
        // Persist the final stop / trailing state first, so the closed record shows how it got here.
        this.db.updateTradeState(trade);
        const changes = this.db.closeTrade(trade.id, { exitPrice: price, exitTime, exitReason: reason, grossPnl: gross, fees, netPnl: net, holdingSeconds });
        if (!changes) return; // already closed by another pass
        const code = this.codeOf(trade.strategy_id);
        const sign = net >= 0 ? '+' : '-';
        this.logger.info(code, `EXIT ${reason}`, `${trade.symbol} @ ${price}`);
        this.logger.info(code, 'P&L', `${sign}₹${Math.abs(net).toLocaleString('en-IN')} net (gross ${gross}, fees ${fees})`);
        this.db.insertEvent({ strategyId: trade.strategy_id, tradeId: trade.id, ts: exitTime, type: 'EXIT', price, message: `${reason} net ${net}`, detail: { ...detail, gross, fees, net } });
        try {
            this.onTradeClosed(this.db.getTrade(trade.id));
        } catch (err) {
            this.logger.error('ENGINE', 'STATS ERROR', String(err?.message || err));
        }
    }

    /** Live view of open trades with unrealized P&L (uses the newest quote). */
    openPositionsView() {
        const now = this.now();
        return this.db.openTrades().map((t) => {
            const q = this.marketData.lastQuote(t.symbol);
            const price = q && q.barTs >= (t.last_price_time ?? 0) - MIN ? q.price : t.last_price;
            const rate = this.strategyById(t.strategy_id)?.roundTheClock ? this.cfg.INR_USD_RATE || 84 : 1;
            const unrealized = grossPnl(t.direction, t.entry_price, price, t.quantity) * rate;
            // Margin base for the % return: premium paid for options, the fixed
            // ₹40k paper margin for the gold/eth traders, symbol notional otherwise.
            const key = this.strategyById(t.strategy_id)?.key ?? '';
            const margin = t.symbol.startsWith('OPT-')
                ? Math.max(1, t.quantity * t.entry_price)
                : key.startsWith('gold_')
                    ? this.cfg.GOLD_MARGIN_INR
                    : key.startsWith('eth_')
                        ? this.cfg.ETH_MARGIN_INR
                        : Math.max(1, t.quantity * t.entry_price);
            return {
                ...t,
                current_price: price,
                unrealized_pnl: unrealized,
                margin,
                roi_pct: price != null && Number.isFinite(unrealized) ? Math.round((unrealized / margin) * 1000) / 10 : null,
                duration_seconds: Math.round((now - t.entry_time) / 1000),
                stale: this.marketData.isStale(t.symbol),
                today: t.session_date === sessionDate(now),
            };
        });
    }
}
