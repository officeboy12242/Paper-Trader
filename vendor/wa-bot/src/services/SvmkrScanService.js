/**
 * SVMKR index scan — standalone CE/PE setup finder for NIFTY (and the other
 * F&O indices on demand).
 *
 * Deliberately independent of IndexStrategyEngine: that engine votes across five
 * strategies and posts the best one, whereas this fires on one specific
 * condition (a UT Bot cross confirmed by HMA and slope). Mixing them would make
 * it impossible to tell which idea produced a given win.
 *
 * WHAT IS AND IS NOT MEASURED
 *   - Signals come only from CLOSED 5m bars, so a card never contradicts itself
 *     mid-bar.
 *   - Index risk is the live distance to the UT Bot trailing stop, not a generic
 *     ATR multiple — the stop IS the strategy's exit, so sizing follows it.
 *   - Premium entry is the ATM leg's last traded price at scan time, valid only
 *     as of the chain's own timestamp. It is quoted with that timestamp because
 *     an alert that lands a minute later is already quoting a stale premium.
 */

import { logger } from '../utils/logger.js';
import { fetchYahooIntradayCandles } from '../utils/yahooIntradayCandles.js';
import { nseOptionChainService } from './NseOptionChainService.js';
import { getIndexSpec } from '../data/indexUniverse.js';
import { sizeIndexTrade } from './IndexAnalysisService.js';
import { utBot, hma, lrsState, closedBarsOnly, wilderAtr } from '../utils/svmkrIndicators.js';
import { istMinutesOfDay } from '../utils/intradaySeries.js';

const BAR_MS = 5 * 60 * 1000;

export const SVMKR_DEFAULTS = {
    atrPeriod: 10,
    sensitivity: 1,
    useHeikinAshi: false,
    hmaPeriod: 21,
    lrsPeriod: 20,
    lrsSmooth: 3,
    /** Entries stop well before the close — a 5m signal at 15:25 cannot resolve. */
    lastEntryMin: 15 * 60,
    /** A signal older than this many bars is not actionable any more. */
    maxSignalAgeBars: 1,
};

class SvmkrScanService {
    /**
     * @param {object} config
     */
    constructor(config = {}) {
        this.config = config;
        this.capital = config.INDEX_TRADE_CAPITAL || 30_000;
        this.minProfit = config.INDEX_TRADE_MIN_PROFIT || 600;
        this.maxProfit = config.INDEX_TRADE_MAX_PROFIT || 1_200;
        this.opts = {
            ...SVMKR_DEFAULTS,
            atrPeriod: config.SVMKR_ATR_PERIOD ?? SVMKR_DEFAULTS.atrPeriod,
            sensitivity: config.SVMKR_SENSITIVITY ?? SVMKR_DEFAULTS.sensitivity,
            useHeikinAshi: config.SVMKR_HEIKIN_ASHI === true,
            hmaPeriod: config.SVMKR_HMA_PERIOD ?? SVMKR_DEFAULTS.hmaPeriod,
            lrsPeriod: config.SVMKR_LRS_PERIOD ?? SVMKR_DEFAULTS.lrsPeriod,
            lastEntryMin: config.SVMKR_LAST_ENTRY_MIN ?? SVMKR_DEFAULTS.lastEntryMin,
        };
    }

    /**
     * Read the indicators for one index and report whether a setup just fired.
     *
     * @param {string} rawIndex e.g. "NIFTY"
     * @param {{ nowMs?: number, requireFresh?: boolean }} [o]
     *   requireFresh=false answers "what does it look like right now" for the
     *   on-demand command, instead of "did a signal just print".
     * @returns {Promise<object>} always resolves; `setup` is null when nothing fired
     */
    async scan(rawIndex = 'NIFTY', { nowMs = Date.now(), requireFresh = true } = {}) {
        const spec = getIndexSpec(rawIndex);
        if (!spec) {
            throw new Error(`${rawIndex} is not a supported F&O index`);
        }
        const key = spec.nse;

        const [candlesRaw, chainRes] = await Promise.all([
            fetchYahooIntradayCandles(spec.yahoo, { interval: '5m', range: '5d' }),
            nseOptionChainService.fetchOptionContext(key),
        ]);

        const bars = closedBarsOnly(candlesRaw, BAR_MS, nowMs);
        const snapshot = chainRes?.snapshot || null;

        const need = Math.max(this.opts.hmaPeriod, this.opts.lrsPeriod, this.opts.atrPeriod) + 5;
        if (bars.length < need) {
            return this._empty(key, spec, snapshot, `only ${bars.length} closed 5m bars — need ${need}`);
        }

        const last = bars[bars.length - 1];
        const ageMin = Math.round((nowMs - last.ts) / 60_000);
        // A stale feed silently turns into a confident-looking wrong signal.
        if (ageMin > 20) {
            return this._empty(key, spec, snapshot, `last closed bar is ${ageMin}m old — feed stale or market shut`);
        }

        const closes = bars.map((b) => b.close);
        const ut = utBot(bars, {
            atrPeriod: this.opts.atrPeriod,
            sensitivity: this.opts.sensitivity,
            useHeikinAshi: this.opts.useHeikinAshi,
        });
        const hmaSeries = hma(closes, this.opts.hmaPeriod);
        const lrs = lrsState(closes, { period: this.opts.lrsPeriod, smooth: this.opts.lrsSmooth });
        const atrSeries = wilderAtr(bars, this.opts.atrPeriod);

        const i = bars.length - 1;
        const stop = ut.stop[i];
        const hmaNow = hmaSeries[i];
        const close = closes[i];
        const atr = atrSeries[i];

        const tech = {
            close,
            trailingStop: Number.isFinite(stop) ? Number(stop.toFixed(2)) : null,
            pos: ut.pos[i],
            hma: Number.isFinite(hmaNow) ? Number(hmaNow.toFixed(2)) : null,
            aboveHma: Number.isFinite(hmaNow) ? close > hmaNow : null,
            slope: lrs.slope != null ? Number(lrs.slope.toFixed(4)) : null,
            slopeAvg: lrs.avg != null ? Number(lrs.avg.toFixed(4)) : null,
            lrsBull: lrs.bull,
            lrsBear: lrs.bear,
            atr: Number.isFinite(atr) ? Number(atr.toFixed(2)) : null,
            barTs: last.ts,
            barAgeMin: ageMin,
            barMin: istMinutesOfDay(last.ts),
        };

        // A cross on the last closed bar is the signal. "Price is still above the
        // stop" is true for hours and is explicitly NOT a signal.
        const crossedUp = ut.buy[i];
        const crossedDown = ut.sell[i];
        const side = crossedUp ? 'CE' : crossedDown ? 'PE' : null;

        const nowMin = istMinutesOfDay(nowMs);
        if (nowMin >= this.opts.lastEntryMin) {
            return this._empty(key, spec, snapshot, `past last entry (${Math.floor(this.opts.lastEntryMin / 60)}:00 IST)`, tech);
        }

        // On-demand reads fall back to the standing position when no cross just
        // printed, so `/svmkr` says something useful mid-trend.
        const effectiveSide = side || (requireFresh ? null : tech.pos > 0 ? 'CE' : tech.pos < 0 ? 'PE' : null);
        if (!effectiveSide) {
            return this._empty(key, spec, snapshot, 'no UT Bot cross on the last closed bar', tech);
        }

        const confirms = this._confirmations(effectiveSide, tech);
        if (side && !confirms.ok) {
            return this._empty(key, spec, snapshot, `UT Bot ${side} cross but ${confirms.blockedBy}`, tech);
        }

        if (!snapshot) {
            return this._empty(key, spec, null, 'no option chain — cannot price a leg', tech);
        }

        const leg = effectiveSide === 'CE' ? snapshot.atmCe : snapshot.atmPe;
        if (!leg || !Number.isFinite(Number(leg.ltp)) || Number(leg.ltp) <= 0) {
            return this._empty(key, spec, snapshot, `no tradeable ATM ${effectiveSide} premium in the chain`, tech);
        }

        // Risk = distance to the trailing stop, floored so a stop sitting almost
        // on top of price cannot size into an absurd number of lots.
        const rawRisk = tech.trailingStop != null ? Math.abs(close - tech.trailingStop) : null;
        const indexRisk = Math.max(rawRisk || 0, (tech.atr || 0) * 0.5, close * 0.0008);

        const plan = sizeIndexTrade({
            premium: Number(leg.ltp),
            lot: spec.lot,
            indexAtr: indexRisk,
            capital: this.capital,
            minProfit: this.minProfit,
            maxProfit: this.maxProfit,
        });

        return {
            key,
            label: spec.label,
            spec,
            snapshot,
            tech,
            setup: {
                side: effectiveSide,
                fresh: Boolean(side),
                strike: leg.strike,
                expiry: snapshot.expiry,
                premium: Number(leg.ltp),
                iv: leg.iv ?? null,
                indexRisk: Number(indexRisk.toFixed(2)),
                reasons: confirms.reasons,
                confirmations: confirms.count,
                plan,
            },
            noneReason: null,
        };
    }

    /**
     * HMA and slope must agree with the cross. Both disagreeing is the classic
     * UT Bot failure — a whipsaw cross against the prevailing trend.
     */
    _confirmations(side, tech) {
        const reasons = [];
        let count = 0;
        let blockedBy = null;

        if (side === 'CE') {
            reasons.push(
                tech.trailingStop != null
                    ? `UT Bot flipped long — price ${tech.close.toFixed(0)} crossed above trailing stop ${tech.trailingStop.toFixed(0)}`
                    : 'UT Bot flipped long'
            );
            if (tech.aboveHma === true) {
                count += 1;
                reasons.push(`Price above HMA(${this.opts.hmaPeriod}) at ${tech.hma?.toFixed(0)} — trend agrees`);
            } else if (tech.aboveHma === false) {
                blockedBy = `price is below HMA ${tech.hma?.toFixed(0)}`;
                reasons.push(`⚠️ Below HMA ${tech.hma?.toFixed(0)} — trend disagrees`);
            }
            if (tech.lrsBull) {
                count += 1;
                reasons.push(`Regression slope ${tech.slope} rising above its average ${tech.slopeAvg} — momentum building`);
            } else if (tech.lrsBear) {
                blockedBy = blockedBy || 'the regression slope is falling';
                reasons.push(`⚠️ Slope ${tech.slope} below average ${tech.slopeAvg} — momentum against`);
            }
        } else {
            reasons.push(
                tech.trailingStop != null
                    ? `UT Bot flipped short — price ${tech.close.toFixed(0)} crossed below trailing stop ${tech.trailingStop.toFixed(0)}`
                    : 'UT Bot flipped short'
            );
            if (tech.aboveHma === false) {
                count += 1;
                reasons.push(`Price below HMA(${this.opts.hmaPeriod}) at ${tech.hma?.toFixed(0)} — trend agrees`);
            } else if (tech.aboveHma === true) {
                blockedBy = `price is above HMA ${tech.hma?.toFixed(0)}`;
                reasons.push(`⚠️ Above HMA ${tech.hma?.toFixed(0)} — trend disagrees`);
            }
            if (tech.lrsBear) {
                count += 1;
                reasons.push(`Regression slope ${tech.slope} falling below its average ${tech.slopeAvg} — momentum building`);
            } else if (tech.lrsBull) {
                blockedBy = blockedBy || 'the regression slope is rising';
                reasons.push(`⚠️ Slope ${tech.slope} above average ${tech.slopeAvg} — momentum against`);
            }
        }

        // Both confirmations required for an auto-posted trade.
        return { ok: count === 2, count, reasons, blockedBy: blockedBy || 'confirmations incomplete' };
    }

    _empty(key, spec, snapshot, noneReason, tech = null) {
        return { key, label: spec?.label || key, spec, snapshot, tech, setup: null, noneReason };
    }

    /** Scan several indices, skipping the ones that error. */
    async scanMany(keys, opts = {}) {
        const out = [];
        for (const k of keys) {
            try {
                out.push(await this.scan(k, opts));
            } catch (err) {
                logger.warn(`SVMKR scan ${k} failed: ${err.message}`);
            }
        }
        return out;
    }
}

export default SvmkrScanService;
