/**
 * Expiry-day index option engine.
 *
 * Two slots, each running the strategy that actually suits that time of day:
 *
 *   09:35 — DIRECTIONAL. The 15m opening range is complete. On a confirmed
 *           break we buy the ATM option (delta ~0.5) with a tight premium stop.
 *           ~40-45% win rate at 1:2.5, which is positive expectancy if the stop
 *           is honoured. Inside the range we post levels and no trade.
 *
 *   13:15 — HERO-ZERO. Decay has crushed premiums and only gamma is left. Deep
 *           OTM strikes are selected by DELTA BAND, and every card states the
 *           model probability of finishing ITM plus the index move required.
 *
 * On hero-zero specifically: delta is the market's own estimate of the odds. A
 * ₹2 strike is cheap because it prices a ~2-5% chance, not because it is
 * mispriced. The engine prints that number rather than hiding it — win rate and
 * payoff are one dial, and this end of it is a lottery ticket by construction.
 * SEBI's F&O study finds expiry-focused traders are the worst-performing
 * subgroup of an already 93%-losing population.
 */

import { logger } from '../utils/logger.js';
import { config as defaultConfig } from '../config/config.js';
import { F_AND_O_INDICES } from '../data/indexUniverse.js';
import { nseGet, getNseCookie } from '../utils/nseClient.js';
import { fetchYahooIntradayCandles, findOpeningRangeCandle } from '../utils/yahooIntradayCandles.js';
import { delta, probabilityItm, breakevenMove, maxPain } from '../utils/blackScholes.js';
import {
    getExpiriesOn,
    parseNseExpiry,
    yearsToExpiry,
    hoursToExpiry,
} from '../utils/expiryCalendar.js';

/**
 * Underlying feeds. Every Yahoo symbol here was verified to match the option
 * chain's own `underlyingValue`. MIDCPNIFTY is Nifty Midcap SELECT (~14.9k),
 * NOT Midcap 100 (~63k) — an easy and completely silent mistake to make.
 * Lot sizes move at SEBI revisions; override via config when they change.
 */
/**
 * Aliased from the shared map. This used to be a second, independent copy — the
 * correct one — while IndianStockQuoteService carried a shorter one that was
 * missing MIDCPNIFTY and FINNIFTY. One definition now, so they cannot disagree.
 *
 * Imported and re-exported rather than `export { X } from` because this file uses
 * the binding internally; a pure re-export creates no local name.
 */
export const EXPIRY_INDICES = F_AND_O_INDICES;

/** Reject Yahoo intraday data whose last price disagrees with the chain spot. */
const SPOT_TOLERANCE_PCT = 1;

export default class ExpiryTradeService {
    constructor(cfg = defaultConfig) {
        this.config = cfg;
        this.riskFree = Number(cfg.EXPIRY_RISK_FREE_RATE) || 0.065;
        this.heroDeltaMin = Number(cfg.EXPIRY_HERO_DELTA_MIN) || 0.02;
        this.heroDeltaMax = Number(cfg.EXPIRY_HERO_DELTA_MAX) || 0.12;
        this.heroMaxPremium = Number(cfg.EXPIRY_HERO_MAX_PREMIUM) || 25;
        this.atmStopPct = Number(cfg.EXPIRY_ATM_STOP_PCT) || 20;
        this.atmTarget1Pct = Number(cfg.EXPIRY_ATM_T1_PCT) || 50;
        this.atmTarget2Pct = Number(cfg.EXPIRY_ATM_T2_PCT) || 100;
        /**
         * Yahoo reports zero volume on index feeds, so the usual volume-expansion
         * confirmation is unavailable. Range expansion — the breakout bar being a
         * meaningful fraction of the opening range — is the workable substitute.
         */
        this.minRangeExpansion = Number(cfg.EXPIRY_MIN_RANGE_EXPANSION) || 0.3;
        this.lotOverrides = this._parseLots(cfg.EXPIRY_LOT_SIZES);
    }

    _parseLots(raw) {
        const out = {};
        for (const part of String(raw || '').split(',')) {
            const [k, v] = part.split(':').map((s) => s?.trim());
            const n = Number(v);
            if (k && Number.isFinite(n) && n > 0) out[k.toUpperCase()] = n;
        }
        return out;
    }

    lotSize(index) {
        return this.lotOverrides[index] || EXPIRY_INDICES[index]?.lot || 1;
    }

    /** Indices expiring today (empty array on a non-expiry day). */
    expiringToday(nowMs = Date.now()) {
        const r = getExpiriesOn(nowMs, this.config);
        return r.isExpiry ? r.indices.filter((i) => EXPIRY_INDICES[i]) : [];
    }

    /**
     * Normalised option chain for the nearest expiry.
     * @returns {Promise<{ spot: number, expiry: string, rows: object[], strikeStep: number }|null>}
     */
    async fetchChain(index) {
        const sym = String(index || '').toUpperCase();
        if (!EXPIRY_INDICES[sym]) throw new Error(`Unsupported index ${sym}`);

        const cookie = await getNseCookie();
        const contract = await nseGet(`option-chain-contract-info?symbol=${sym}`, { cookie });
        const expiries = contract?.expiryDates || contract?.records?.expiryDates || [];
        const expiry = expiries[0];
        if (!expiry) return null;

        const chain = await nseGet(
            `option-chain-v3?type=Indices&symbol=${encodeURIComponent(sym)}&expiry=${encodeURIComponent(expiry)}`,
            { cookie }
        );
        const raw = chain?.records?.data || [];
        const spot = chain?.records?.underlyingValue;
        if (!raw.length || !Number.isFinite(spot)) return null;

        const rows = raw
            .filter((r) => Number.isFinite(r?.strikePrice))
            .map((r) => ({
                strike: r.strikePrice,
                ce: r.CE
                    ? { ltp: r.CE.lastPrice ?? null, iv: r.CE.impliedVolatility ?? null, oi: r.CE.openInterest ?? 0 }
                    : null,
                pe: r.PE
                    ? { ltp: r.PE.lastPrice ?? null, iv: r.PE.impliedVolatility ?? null, oi: r.PE.openInterest ?? 0 }
                    : null,
            }))
            .sort((a, b) => a.strike - b.strike);

        // Derive the strike step from the chain itself rather than hardcoding it.
        const diffs = [];
        for (let i = 1; i < rows.length; i++) diffs.push(rows[i].strike - rows[i - 1].strike);
        const strikeStep = diffs.length ? diffs.sort((a, b) => a - b)[Math.floor(diffs.length / 2)] : 50;

        return { spot, expiry, rows, strikeStep };
    }

    /** Chain-wide context: max pain, PCR, ATM straddle, prevailing IV. */
    buildContext(chain) {
        const { spot, rows } = chain;
        const oiRows = rows.map((r) => ({ strike: r.strike, ceOi: r.ce?.oi || 0, peOi: r.pe?.oi || 0 }));
        const totalCe = oiRows.reduce((s, r) => s + r.ceOi, 0);
        const totalPe = oiRows.reduce((s, r) => s + r.peOi, 0);

        const atmRow = rows.reduce((best, r) =>
            Math.abs(r.strike - spot) < Math.abs(best.strike - spot) ? r : best
        );
        const straddle =
            Number.isFinite(atmRow.ce?.ltp) && Number.isFinite(atmRow.pe?.ltp)
                ? atmRow.ce.ltp + atmRow.pe.ltp
                : null;

        const ivs = rows
            .flatMap((r) => [r.ce?.iv, r.pe?.iv])
            .filter((v) => Number.isFinite(v) && v > 0);
        const avgIv = ivs.length ? ivs.reduce((s, v) => s + v, 0) / ivs.length : null;

        const mp = maxPain(oiRows);
        return {
            spot,
            atmStrike: atmRow.strike,
            atmRow,
            straddle,
            // The straddle is the market's own estimate of the remaining day range.
            impliedDayMovePct: straddle != null ? (straddle / spot) * 100 : null,
            pcr: totalCe ? totalPe / totalCe : null,
            maxPain: mp,
            maxPainDistPct: mp != null ? ((spot - mp) / spot) * 100 : null,
            avgIv,
        };
    }

    /**
     * 15m opening range from the index feed, validated against the chain spot so
     * a wrong underlying can never silently produce plausible-looking levels.
     */
    async getOpeningRange(index, chainSpot) {
        const meta = EXPIRY_INDICES[index];
        if (!meta) return null;
        let candles;
        try {
            candles = await fetchYahooIntradayCandles(meta.yahoo, { interval: '15m', range: '1d' });
        } catch (err) {
            logger.warn(`Expiry OR fetch failed for ${index}: ${err.message}`);
            return null;
        }
        if (!candles?.length) return null;

        const or = findOpeningRangeCandle(candles);
        if (!or) return null;

        const last = candles[candles.length - 1];
        if (Number.isFinite(chainSpot) && chainSpot > 0) {
            const divergePct = (Math.abs(last.close - chainSpot) / chainSpot) * 100;
            if (divergePct > SPOT_TOLERANCE_PCT) {
                logger.warn(
                    `Expiry ${index}: intraday feed ${meta.yahoo} at ${last.close} diverges ` +
                        `${divergePct.toFixed(1)}% from chain spot ${chainSpot} — discarding OR`
                );
                return null;
            }
        }

        const after = candles.filter((c) => c.ts > or.ts);
        const orRange = or.high - or.low;
        // How decisively has price travelled beyond the range since it broke?
        const extension = last.close > or.high
            ? last.close - or.high
            : last.close < or.low
              ? or.low - last.close
              : 0;

        return {
            high: or.high,
            low: or.low,
            range: orRange,
            rangePct: (orRange / or.close) * 100,
            last: last.close,
            dayHigh: Math.max(...candles.map((c) => c.high)),
            dayLow: Math.min(...candles.map((c) => c.low)),
            barsAfterOr: after.length,
            extension,
            rangeExpansion: orRange > 0 ? extension / orRange : 0,
            brokeUp: last.close > or.high,
            brokeDown: last.close < or.low,
        };
    }

    /** Pick the strike nearest `spot`, then step `n` strikes out. */
    _strikeAt(chain, offsetSteps) {
        const { spot, rows, strikeStep } = chain;
        const atm = rows.reduce((b, r) => (Math.abs(r.strike - spot) < Math.abs(b.strike - spot) ? r : b));
        const target = atm.strike + offsetSteps * strikeStep;
        return rows.find((r) => r.strike === target) || null;
    }

    /** Greeks for one leg, or null when the strike has no usable quote. */
    _legGreeks(type, strike, leg, spot, years) {
        const ivPct = leg?.iv;
        const ltp = leg?.ltp;
        if (!Number.isFinite(ltp) || ltp <= 0) return null;
        const iv = Number.isFinite(ivPct) && ivPct > 0 ? ivPct / 100 : null;
        const params = iv ? { spot, strike, iv, years, rate: this.riskFree } : null;
        return {
            type,
            strike,
            premium: ltp,
            iv: ivPct ?? null,
            oi: leg.oi ?? 0,
            delta: params ? delta(type, params) : null,
            probItm: params ? probabilityItm(type, params) : null,
            breakeven: breakevenMove(type, { spot, strike, premium: ltp }),
        };
    }

    /**
     * 09:35 slot — ATM directional on a confirmed opening-range break.
     */
    async getDirectionalSetup(index, chain, ctx, nowMs = Date.now()) {
        const expiryMs = parseNseExpiry(chain.expiry);
        const or = await this.getOpeningRange(index, chain.spot);
        if (!or) {
            return { index, strategy: 'DIRECTIONAL', tradeable: false, reason: 'no intraday data for the underlying' };
        }
        if (!or.brokeUp && !or.brokeDown) {
            return {
                index,
                strategy: 'DIRECTIONAL',
                tradeable: false,
                reason: 'price still inside the 15m opening range',
                or,
            };
        }
        if (or.rangeExpansion < this.minRangeExpansion) {
            return {
                index,
                strategy: 'DIRECTIONAL',
                tradeable: false,
                reason:
                    `marginal break — only ${(or.rangeExpansion * 100).toFixed(0)}% beyond the range ` +
                    `(need ${(this.minRangeExpansion * 100).toFixed(0)}%)`,
                or,
            };
        }

        const type = or.brokeUp ? 'CE' : 'PE';
        const years = yearsToExpiry(expiryMs, nowMs);
        const atm = this._strikeAt(chain, 0);
        const leg = type === 'CE' ? atm?.ce : atm?.pe;
        const greeks = atm ? this._legGreeks(type, atm.strike, leg, chain.spot, years) : null;
        if (!greeks) {
            return { index, strategy: 'DIRECTIONAL', tradeable: false, reason: 'no quote on the ATM strike', or };
        }

        const entry = greeks.premium;
        const lot = this.lotSize(index);
        const stop = entry * (1 - this.atmStopPct / 100);
        const t1 = entry * (1 + this.atmTarget1Pct / 100);
        const t2 = entry * (1 + this.atmTarget2Pct / 100);

        return {
            index,
            strategy: 'DIRECTIONAL',
            tradeable: true,
            direction: or.brokeUp ? 'BULLISH' : 'BEARISH',
            or,
            leg: greeks,
            lot,
            entry,
            stop,
            target1: t1,
            target2: t2,
            riskPerLot: (entry - stop) * lot,
            costPerLot: entry * lot,
            rr1: (t1 - entry) / (entry - stop),
            rr2: (t2 - entry) / (entry - stop),
            // The pin is the main thing that kills a directional expiry trade.
            againstMaxPain:
                ctx.maxPain != null &&
                ((or.brokeUp && chain.spot > ctx.maxPain) || (or.brokeDown && chain.spot < ctx.maxPain)),
        };
    }

    /**
     * 13:15 slot — hero-zero candidates chosen by delta band, odds attached.
     */
    getHeroZero(index, chain, ctx, nowMs = Date.now()) {
        const expiryMs = parseNseExpiry(chain.expiry);
        const years = yearsToExpiry(expiryMs, nowMs);
        const hours = hoursToExpiry(expiryMs, nowMs);
        if (years <= 0) {
            return { index, strategy: 'HERO_ZERO', tradeable: false, reason: 'expiry session has closed', hours: 0 };
        }

        const lot = this.lotSize(index);
        const candidates = [];
        for (const row of chain.rows) {
            for (const [type, leg] of [['CE', row.ce], ['PE', row.pe]]) {
                const g = this._legGreeks(type, row.strike, leg, chain.spot, years);
                if (!g || g.delta == null) continue;
                const absDelta = Math.abs(g.delta);
                if (absDelta < this.heroDeltaMin || absDelta > this.heroDeltaMax) continue;
                if (g.premium > this.heroMaxPremium) continue;
                // Wrong side of the money is not a hero-zero, it is an ITM option.
                if (type === 'CE' && row.strike <= chain.spot) continue;
                if (type === 'PE' && row.strike >= chain.spot) continue;
                candidates.push({ ...g, absDelta, lot, costPerLot: g.premium * lot });
            }
        }

        if (!candidates.length) {
            return {
                index,
                strategy: 'HERO_ZERO',
                tradeable: false,
                reason: `no strike inside the ${this.heroDeltaMin}-${this.heroDeltaMax} delta band under ₹${this.heroMaxPremium}`,
                hours,
            };
        }

        // Highest odds first — if someone is buying a lottery ticket, sell them
        // the one with the best price per unit of probability.
        candidates.sort((a, b) => b.absDelta - a.absDelta);
        const ce = candidates.filter((c) => c.type === 'CE').slice(0, 2);
        const pe = candidates.filter((c) => c.type === 'PE').slice(0, 2);

        // Pin risk: a tight range sitting on max pain is the worst hero-zero tape.
        const nearPin = ctx.maxPainDistPct != null && Math.abs(ctx.maxPainDistPct) < 0.25;

        return {
            index,
            strategy: 'HERO_ZERO',
            tradeable: true,
            hours,
            ce,
            pe,
            nearPin,
            warning: nearPin
                ? `Spot is sitting on max pain (${ctx.maxPain}) — the tape is pinned and both sides likely expire worthless.`
                : null,
        };
    }

    /**
     * Adaptive entry point: runs whichever strategy suits the slot.
     * @param {string} index
     * @param {{ slot?: 'morning'|'afternoon'|'auto', nowMs?: number }} [opts]
     */
    async analyze(index, { slot = 'auto', nowMs = Date.now() } = {}) {
        const sym = String(index || '').toUpperCase();
        if (!EXPIRY_INDICES[sym]) throw new Error(`Unsupported index: ${sym}`);

        const chain = await this.fetchChain(sym);
        if (!chain) throw new Error(`No option chain available for ${sym}`);
        const ctx = this.buildContext(chain);
        const expiryMs = parseNseExpiry(chain.expiry);
        const hours = hoursToExpiry(expiryMs, nowMs);
        // Only an expiry-day session has a meaningful hero-zero window.
        const isExpiryToday = this.expiringToday(nowMs).includes(sym);

        // "Whichever suits that time": the opening range only means something
        // early; once decay has done its work only gamma is left.
        let resolved = slot;
        if (slot === 'auto') resolved = !isExpiryToday || hours > 3.5 ? 'morning' : 'afternoon';

        const setup =
            resolved === 'morning'
                ? await this.getDirectionalSetup(sym, chain, ctx, nowMs)
                : this.getHeroZero(sym, chain, ctx, nowMs);

        return {
            index: sym,
            label: EXPIRY_INDICES[sym].label,
            expiry: chain.expiry,
            slot: resolved,
            hoursToExpiry: hours,
            isExpiryToday,
            context: ctx,
            setup,
            lot: this.lotSize(sym),
        };
    }

    /** Analyse every index expiring today. */
    async analyzeAllExpiring({ slot = 'auto', nowMs = Date.now() } = {}) {
        const indices = this.expiringToday(nowMs);
        const out = [];
        for (const idx of indices) {
            try {
                out.push(await this.analyze(idx, { slot, nowMs }));
            } catch (err) {
                logger.warn(`Expiry analysis failed for ${idx}: ${err.message}`);
            }
        }
        return { indices, results: out };
    }
}

export function createExpiryTradeService(cfg) {
    return new ExpiryTradeService(cfg);
}
