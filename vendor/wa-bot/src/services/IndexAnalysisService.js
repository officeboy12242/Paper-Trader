/**
 * On-demand index F&O read + sized entry — NIFTY / BANKNIFTY / FINNIFTY / MIDCPNIFTY.
 *
 * THE DIRECTION IS A FADE, NOT A BREAKOUT. That is the whole point.
 *
 * Index opening-range BREAKOUTS were measured over 23 sessions on real 5m closes
 * and lost at every setting: 36.7% at 1:1 (-0.267R), 16.7% at 1:2, long -0.667R.
 * Fading the same move won:
 *
 *   fade VWAP stretch >=1xATR   n=51  win=66.7%  exp=+0.333R
 *   fade a failed range break   n=32  win=65.6%  exp=+0.313R
 *
 * Positive in all four indices and in both directions, and a per-index holdout
 * (fit NIFTY+BANKNIFTY, judge FINNIFTY+MIDCPNIFTY) came out BETTER held out
 * (+0.417R) than fitted (+0.259R). Every other candidate tested collapsed on
 * exactly that check. There is a structural reason it works: an index is an
 * average of 50 stocks, so idiosyncratic breakouts cancel and what remains
 * mean-reverts, where a single stock trends on its own news.
 *
 * WHAT IS NOT ESTABLISHED, and must stay on the card:
 *   - n is 29-51 across 23 sessions of ONE month, so one regime.
 *   - 12 configurations were tried; the numbers above are the UNTUNED variant
 *     (1xATR, RR 1:1, 10:30), deliberately not the best-looking one (1.5xATR at
 *     10:30 showed 75.9%, which is very likely the multiple-comparisons winner).
 *   - It is measured on the INDEX move. A bought CE/PE lags it because theta runs
 *     against the holder, and this is a counter-trend entry, so the position
 *     usually goes against you before it works.
 *
 * Sizing is pinned to the measured ratio: target and stop are both 1R, because
 * 1:1 is where the edge was measured. Sizing up to fill the capital would raise
 * the loss by exactly as much as the profit, so one lot is usually correct —
 * at 1R it yields Rs608 (NIFTY) to Rs912 (FINNIFTY).
 */

import { nseOptionChainService } from './NseOptionChainService.js';
import { fetchYahooIntradayCandles } from '../utils/yahooIntradayCandles.js';
import { config } from '../config/config.js';
import { indianStockQuoteService } from './IndianStockQuoteService.js';
import { getIndexSpec, INDEX_KEYS, unsupportedIndexReason } from '../data/indexUniverse.js';
import { maxPain } from '../utils/blackScholes.js';
import { logger } from '../utils/logger.js';
import { evaluateStrategies, STRATEGY_META } from './IndexStrategyEngine.js';

const fmt = (n, d = 2) =>
    n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toFixed(d).replace(/\.00$/, '');
const inr = (n) =>
    n == null || !Number.isFinite(Number(n)) ? '—' : `₹${Math.round(Number(n)).toLocaleString('en-IN')}`;

/**
 * Where spot sits inside the day's range, 0 = at the low, 1 = at the high.
 * @returns {number|null}
 */
export function rangePosition(spot, low, high) {
    // Number(null) is 0 and Number.isFinite(0) is true, so a missing value would
    // silently read as a real zero — the same trap that let all-zero candles
    // through the Yahoo fetchers and broke the pre-open IEP fallbacks.
    const num = (v) => {
        if (v === null || v === undefined || v === '') return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    };
    const s = num(spot), lo = num(low), hi = num(high);
    if (s === null || lo === null || hi === null) return null;
    const span = hi - lo;
    if (!(span > 0)) return null;
    return Math.min(1, Math.max(0, (s - lo) / span));
}

/**
 * Nearest OI wall above and below spot. A "wall" is simply the highest-OI strike
 * on the side that would resist price — calls above, puts below.
 * @param {{strike:number, oi:number}[]} topCe
 * @param {{strike:number, oi:number}[]} topPe
 */
export function oiWalls(topCe, topPe, spot) {
    const s = Number(spot);
    const above = (topCe || [])
        .filter((r) => Number.isFinite(r?.strike) && r.strike >= s)
        .sort((a, b) => (b.oi || 0) - (a.oi || 0))[0] || null;
    const below = (topPe || [])
        .filter((r) => Number.isFinite(r?.strike) && r.strike <= s)
        .sort((a, b) => (b.oi || 0) - (a.oi || 0))[0] || null;
    return { resistance: above, support: below };
}

/**
 * Session VWAP. Indices frequently report zero volume on Yahoo, so a zero-volume
 * bar counts as weight 1 rather than being dropped — otherwise VWAP collapses to
 * NaN on exactly the instruments this is for.
 */
export function sessionVwap(bars) {
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

/** ATR over the last `n` completed bars. */
export function barAtr(bars, n = 6) {
    if (!Array.isArray(bars) || bars.length < n + 1) return null;
    const s = bars.slice(-(n + 1));
    let t = 0;
    for (let i = 1; i < s.length; i++) {
        t += Math.max(s[i].high - s[i].low, Math.abs(s[i].high - s[i - 1].close), Math.abs(s[i].low - s[i - 1].close));
    }
    const a = t / n;
    return a > 0 ? a : null;
}

/**
 * Measured window: 10:30 was the tested time; the rule measured NEGATIVE after
 * 12:30. The clock was once a hard gate (10:00-12:30 only) — removed on request
 * so /index gives a read ANY time the command runs. The window now survives as
 * an honesty tier: `degraded` past 11:30 and `veryLate` past 12:30 both cut the
 * confidence and print a warning on the card, instead of refusing to look.
 */
export const SIGNAL_WINDOW = { openMin: 10 * 60, bestMin: 10 * 60 + 30, closeMin: 11 * 60 + 30, deadMin: 12 * 60 + 30 };
export const STRETCH_ATR = 1.0;   // the UNTUNED threshold that survived the holdout
const OR_END_MIN = 9 * 60 + 30;

/**
 * Is there a fade signal right now?
 *
 * Two rules, both measured (see the header): price stretched from VWAP, and a
 * failed opening-range break. Direction is always AGAINST the stretch — indices
 * revert where single stocks trend.
 *
 * @param {{high:number,low:number,close:number,volume:number,min:number}[]} bars session bars, ascending
 * @param {number} nowMin current IST minute-of-day
 */
export function evaluateIndexSignal(bars, nowMin) {
    // No clock gate: /index must give a read any time it is run. The data gate
    // below (need ~40 minutes of trade) is what stops a nonsense early read, and
    // `degraded`/`veryLate` keep the measured-window honesty after 11:30/12:30.
    const session = (bars || []).filter((b) => Number.isFinite(b?.min) && b.min <= nowMin);
    if (session.length < 8) {
        return { side: null, reason: 'not enough bars yet — needs ~40 minutes of trade', kind: null };
    }

    const vwap = sessionVwap(session);
    const atr = barAtr(session);
    if (!vwap || !atr) return { side: null, reason: 'VWAP/ATR unavailable', kind: null };

    const last = session[session.length - 1];
    const stretch = (last.close - vwap) / atr;

    // rule 1 — stretched from VWAP
    if (Math.abs(stretch) >= STRETCH_ATR) {
        return {
            side: stretch > 0 ? 'short' : 'long',
            kind: 'vwap-stretch',
            reason: `${Math.abs(stretch).toFixed(2)}×ATR ${stretch > 0 ? 'above' : 'below'} VWAP — stretched, fade toward VWAP`,
            vwap, atr, stretch,
            degraded: nowMin > SIGNAL_WINDOW.closeMin,
            veryLate: nowMin > SIGNAL_WINDOW.deadMin,
        };
    }

    // rule 2 — failed opening-range break
    const or = session.filter((b) => b.min < OR_END_MIN);
    if (or.length >= 2) {
        const orHigh = Math.max(...or.map((b) => b.high));
        const orLow = Math.min(...or.map((b) => b.low));
        const after = session.filter((b) => b.min >= OR_END_MIN);
        let broke = 0, brokeIdx = -1;
        for (let i = 0; i < after.length; i++) {
            if (after[i].close > orHigh) { broke = 1; brokeIdx = i; break; }
            if (after[i].close < orLow) { broke = -1; brokeIdx = i; break; }
        }
        if (broke) {
            const since = after.slice(brokeIdx + 1);
            const backInside = since.some((b) => b.close < orHigh && b.close > orLow);
            const stillInside = last.close < orHigh && last.close > orLow;
            if (backInside && stillInside) {
                return {
                    side: broke > 0 ? 'short' : 'long',
                    kind: 'failed-break',
                    reason: `broke the opening range ${broke > 0 ? 'up' : 'down'} then closed back inside — failed break, fade it`,
                    vwap, atr, stretch,
                    degraded: nowMin > SIGNAL_WINDOW.closeMin,
                    veryLate: nowMin > SIGNAL_WINDOW.deadMin,
                };
            }
        }
    }

    return {
        side: null,
        kind: null,
        reason: `no setup — ${Math.abs(stretch).toFixed(2)}×ATR from VWAP (needs ≥${STRETCH_ATR}) and no failed range break`,
        vwap, atr, stretch,
    };
}

function hhmm(min) {
    return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

/**
 * Confidence in the fade signal, as a percentage — derived from the measured
 * edge and NEVER above it, so the number cannot over-claim the study.
 *
 * Base is the holdout-measured win rate per rule: 66.7% for a vwap-stretch
 * (n=51), 65.6% for a failed range break (n=32). Two adjustments, both bounded:
 *   - late window honesty — −15pts past 11:30 (`degraded`), −25pts past 12:30
 *     (`veryLate`), where the same rule measured NEGATIVE. A late signal never
 *     reads as strong as a fresh one.
 *   - stretch magnitude (vwap-stretch only) — up to +6pts for how far past the
 *     1.0xATR threshold price sits, which only ever offsets part of the
 *     late penalty. A fresh stretch is exactly the measured rate.
 *
 * @param {object|null} signal from evaluateIndexSignal
 * @returns {{pct:number, label:string}|null} null when there is no side
 */
export function signalConfidence(signal) {
    if (!signal?.side || !signal?.kind) return null;
    const base = signal.kind === 'failed-break' ? 0.656 : 0.667;
    let pts = base * 100;
    if (signal.veryLate) pts -= 25;
    else if (signal.degraded) pts -= 15;
    if (signal.kind === 'vwap-stretch' && Number.isFinite(signal.stretch)) {
        const extra = Math.min(6, Math.max(0, (Math.abs(signal.stretch) - STRETCH_ATR) * 4));
        pts += extra;
    }
    // Cap at the measured rate: confidence can fall with a late window, never rise.
    pts = Math.min(Math.round(base * 100), Math.max(40, Math.round(pts)));
    const label = pts >= 65 ? 'high' : pts >= 56 ? 'moderate' : 'low';
    return { pct: pts, label };
}

/**
 * A soft directional read from the option chain, for times when the measured
 * fade rule is not live (before 10:00, after 12:30, or a flat session).
 *
 * DELIBERATELY NOT a signal: none of this is backtested. It is conventional
 * options-market reasoning, presented as a lean so the card is not a dead end
 * — and labeled unmeasured so it is never mistaken for the 66.7% fade edge.
 *
 * Factors (each ±1, summed):
 *   1. PCR contrarian — a crowded put side (high PCR) reads as bearish
 *      sentiment, so the lean is UP; a crowded call side reads bullish → DOWN.
 *   2. Max pain drift — price tends to drift toward max pain: above it → DOWN,
 *      below it → UP. Neutral within a small band around max pain.
 *   3. OI walls — the nearest big wall acts as a magnet: support closer below
 *      → UP, resistance closer above → DOWN.
 *
 * @returns {{factors: {score:number, detail:string}[], net:number, netLabel:string}|null}
 */
export function chainLean({ pcr, maxPain, spot, walls } = {}) {
    const s = Number(spot);
    if (!Number.isFinite(s)) return null;

    const factors = [];

    // 1. PCR — contrarian to the crowd. Symmetric around 1.0 so a mildly
    //    call-heavy read (e.g. 0.75) leans DOWN exactly like the pcrLabel words it.
    if (pcr != null && Number.isFinite(Number(pcr))) {
        const v = Number(pcr);
        if (v >= 1.15) factors.push({ score: 1, detail: `PCR ${fmt(v)} → put-heavy crowd → lean UP` });
        else if (v <= 0.85) factors.push({ score: -1, detail: `PCR ${fmt(v)} → call-heavy crowd → lean DOWN` });
        else factors.push({ score: 0, detail: `PCR ${fmt(v)} → balanced crowd → no lean` });
    }

    // 2. Max pain drift (neutral within ~0.2% of spot, min 10 pts)
    if (maxPain != null && Number.isFinite(Number(maxPain))) {
        const gap = s - Number(maxPain);
        const neutral = Math.max(s * 0.002, 10);
        if (Math.abs(gap) <= neutral) {
            factors.push({ score: 0, detail: `max pain ${fmt(maxPain)} → spot is right on it → no drift` });
        } else if (gap > 0) {
            factors.push({ score: -1, detail: `max pain ${fmt(maxPain)} → spot ${fmt(gap)} ABOVE → drift DOWN` });
        } else {
            factors.push({ score: 1, detail: `max pain ${fmt(maxPain)} → spot ${fmt(-gap)} BELOW → drift UP` });
        }
    }

    // 3. OI walls — the nearest wall wins
    const res = walls?.resistance, sup = walls?.support;
    if (res || sup) {
        const dRes = res?.strike != null ? Math.abs(s - Number(res.strike)) : null;
        const dSup = sup?.strike != null ? Math.abs(s - Number(sup.strike)) : null;
        if (dRes != null && dSup != null) {
            if (dSup < dRes) {
                factors.push({ score: 1, detail: `nearest wall: support ${fmt(dSup)} below vs resistance ${fmt(dRes)} above → lean UP` });
            } else if (dRes < dSup) {
                factors.push({ score: -1, detail: `nearest wall: resistance ${fmt(dRes)} above vs support ${fmt(dSup)} below → lean DOWN` });
            } else {
                factors.push({ score: 0, detail: `walls equidistant (${fmt(dSup)}) → no lean` });
            }
        } else if (dSup != null) {
            factors.push({ score: 1, detail: `nearest wall: support ${fmt(dSup)} below → lean UP` });
        } else if (dRes != null) {
            factors.push({ score: -1, detail: `nearest wall: resistance ${fmt(dRes)} above → lean DOWN` });
        }
    }

    if (!factors.length) return null;

    const net = factors.reduce((sum, f) => sum + f.score, 0);
    const bull = factors.filter((f) => f.score > 0).length;
    const bear = factors.filter((f) => f.score < 0).length;
    let netLabel;
    if (net >= 2) netLabel = `${bull} of ${factors.length} lean BULLISH — weak conviction`;
    else if (net === 1) netLabel = 'mildly BULLISH — weak conviction';
    else if (net === 0) netLabel = 'balanced — no clear lean';
    else if (net === -1) netLabel = 'mildly BEARISH — weak conviction';
    else netLabel = `${bear} of ${factors.length} lean BEARISH — weak conviction`;

    return { factors, net, netLabel };
}

/**
 * Size the trade so ONE R of index movement lands inside the caller's rupee band.
 *
 * The measured edge is at 1:1, so target and risk are the same size — sizing up to
 * fill the capital would push BOTH past the band. ATM delta is taken as 0.5: the
 * strike is at-the-money by construction, where delta is ~0.5 largely regardless
 * of IV and time, so the premium moves about half the index move.
 *
 * @returns {object|null} null when even one lot breaches the capital
 */
export function sizeIndexTrade({ premium, lot, indexAtr, capital, minProfit, maxProfit, delta = 0.5 }) {
    if (!(premium > 0) || !(lot > 0) || !(indexAtr > 0) || !(capital > 0)) return null;

    const premMove = delta * indexAtr;            // premium move for a 1R index move
    const pnlPerLot = premMove * lot;
    const costPerLot = premium * lot;
    if (costPerLot > capital) {
        return { lots: 0, blocked: `one lot costs ₹${Math.round(costPerLot).toLocaleString('en-IN')}, above the ₹${capital.toLocaleString('en-IN')} capital` };
    }

    // Fewest lots that reach minProfit at 1R, then trimmed to respect maxProfit
    // and capital. Never zero — one lot is the floor if it fits.
    let lots = Math.max(1, Math.ceil(minProfit / pnlPerLot));
    while (lots > 1 && (lots * pnlPerLot > maxProfit || lots * costPerLot > capital)) lots--;
    if (lots * costPerLot > capital) {
        return { lots: 0, blocked: `cannot fit a lot inside ₹${capital.toLocaleString('en-IN')}` };
    }

    const qty = lots * lot;
    const t1Prem = Number((premium + premMove).toFixed(2));
    const t2Prem = Number((premium + premMove * 2).toFixed(2));
    const slPrem = Number(Math.max(0.05, premium - premMove).toFixed(2));

    return {
        lots,
        qty,
        capitalUsed: Math.round(lots * costPerLot),
        premEntry: Number(premium.toFixed(2)),
        premStop: slPrem,
        premT1: t1Prem,
        premT2: t2Prem,
        indexRisk: Number(indexAtr.toFixed(2)),
        riskRs: Math.round((premium - slPrem) * qty),
        t1Rs: Math.round((t1Prem - premium) * qty),
        t2Rs: Math.round((t2Prem - premium) * qty),
        pnlPerLotAt1R: Math.round(pnlPerLot),
    };
}

/**
 * Turn a strategy's index-level entry/SL/target into a sized ATM option trade,
 * with a rupee risk and reward. The fade path already does this via
 * `sizeIndexTrade` (which assumes 1:1 R:R at 1×ATR). Strategies (KC/ST) have
 * asymmetric R:R and different SL/target distances, so this sizer uses the
 * strategy's OWN entry/SL/target1/target2 and translates them to premium via
 * ATM delta ≈ 0.5 — the same simplification the fade sizing uses.
 *
 * Returns { lots, qty, capitalUsed, premEntry, premStop, premT1, premT2,
 *           riskRs, t1Rs, t2Rs } on success, or { blocked: "..." } when the
 * smallest lot doesn't fit inside `capital`. Null when inputs are missing —
 * callers fall back to the index-only display.
 */
export function sizeStrategyOption(strat, ctx = {}) {
    if (!strat) return null;
    const leg = strat.side === 'CE' ? ctx?.atmCe : strat.side === 'PE' ? ctx?.atmPe : null;
    const premium = Number(leg?.ltp);
    const lot = Number(ctx?.lot);
    const capital = Number(ctx?.capital);
    const entry = Number(strat.entry);
    const sl = Number(strat.sl);
    const target1 = Number(strat.target1);
    if (!Number.isFinite(premium) || !(premium > 0)) return null;
    if (!Number.isFinite(lot) || !(lot > 0)) return null;
    if (!Number.isFinite(capital) || !(capital > 0)) return null;
    if (![entry, sl, target1].every(Number.isFinite)) return null;
    const risk = Math.abs(entry - sl);
    const t1Dist = Math.abs(target1 - entry);
    if (!(risk > 0) || !(t1Dist > 0)) return null;

    const delta = 0.5;
    const minProfit = Number(ctx?.minProfit) || 600;
    const maxProfit = Number(ctx?.maxProfit) || 1200;
    const target2 = Number(strat.target2);
    const t2Dist = Number.isFinite(target2) ? Math.abs(target2 - entry) : null;

    const premEntry = Number(premium.toFixed(2));
    const premStop = Number(Math.max(0.05, premEntry - delta * risk).toFixed(2));
    const premT1 = Number((premEntry + delta * t1Dist).toFixed(2));
    const premT2 = t2Dist != null ? Number((premEntry + delta * t2Dist).toFixed(2)) : null;

    const costPerLot = premEntry * lot;
    if (costPerLot > capital) {
        return { blocked: `one lot costs ₹${Math.round(costPerLot).toLocaleString('en-IN')}, above the ₹${capital.toLocaleString('en-IN')} capital` };
    }
    const pnlPerLot = (premT1 - premEntry) * lot;
    let lots = pnlPerLot > 0 ? Math.max(1, Math.ceil(minProfit / pnlPerLot)) : 1;
    while (lots > 1 && (lots * pnlPerLot > maxProfit || lots * costPerLot > capital)) lots--;
    if (lots * costPerLot > capital) {
        return { blocked: `cannot fit a lot inside ₹${capital.toLocaleString('en-IN')}` };
    }
    const qty = lots * lot;
    return {
        lots,
        qty,
        capitalUsed: Math.round(lots * costPerLot),
        premEntry,
        premStop,
        premT1,
        premT2,
        riskRs: Math.round((premEntry - premStop) * qty),
        t1Rs: Math.round((premT1 - premEntry) * qty),
        t2Rs: premT2 != null ? Math.round((premT2 - premEntry) * qty) : null,
    };
}

/** PCR read in words. Thresholds are conventional, not fitted to anything. */
export function pcrLabel(pcr) {
    if (pcr == null || !Number.isFinite(Number(pcr))) return null;
    const v = Number(pcr);
    if (v >= 1.3) return 'put-heavy (crowded downside protection)';
    if (v >= 1.0) return 'mildly put-heavy';
    if (v >= 0.7) return 'mildly call-heavy';
    return 'call-heavy (crowded upside)';
}

/** IST minute-of-day, so the signal window is evaluated in market time. */
export function istMinuteOfDay(nowMs = Date.now()) {
    const d = new Date(nowMs + 5.5 * 3600e3);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** Bars belonging to the most recent session present in the series. */
export function todaySessionBars(candles) {
    if (!Array.isArray(candles) || !candles.length) return [];
    const dayOf = (ts) => new Date(ts + 5.5 * 3600e3).toISOString().slice(0, 10);
    const withMin = candles
        // The 09:15 bar is a zero-volume pre-open placeholder with high === low.
        .filter((c) => Number.isFinite(c?.close) && !(!(c.volume > 0) && c.high === c.low))
        .map((c) => ({ ...c, min: istMinuteOfDay(c.ts), day: dayOf(c.ts) }));
    if (!withMin.length) return [];
    const latest = withMin.reduce((a, b) => (b.day > a ? b.day : a), withMin[0].day);
    return withMin.filter((c) => c.day === latest).sort((a, b) => a.min - b.min);
}

class IndexAnalysisService {
    constructor(cfg = {}) {
        this.capital = cfg.capital ?? config.INDEX_TRADE_CAPITAL ?? 30_000;
        this.minProfit = cfg.minProfit ?? config.INDEX_TRADE_MIN_PROFIT ?? 600;
        this.maxProfit = cfg.maxProfit ?? config.INDEX_TRADE_MAX_PROFIT ?? 1_200;
        this.strategyOpts = {
            minLayers: cfg.strategyMinLayers ?? config.INDEX_STRATEGY_MIN_LAYERS ?? 3,
            orbBreakPct: cfg.strategyOrbBreakPct ?? config.INDEX_STRATEGY_ORB_BREAK_PCT ?? 0.08,
            minAdx: cfg.strategyMinAdx ?? config.INDEX_STRATEGY_MIN_ADX ?? 16,
            lastEntryMin: cfg.strategyLastEntryMin ?? config.INDEX_STRATEGY_LAST_ENTRY_MIN ?? 15 * 60,
        };
    }

    /**
     * @param {string} rawSymbol
     * @returns {Promise<object>} analysis payload
     * @throws when the symbol is not a supported index
     */
    async analyze(rawSymbol) {
        const spec = getIndexSpec(rawSymbol);
        if (!spec) {
            const reason = unsupportedIndexReason(rawSymbol);
            throw new Error(
                reason
                    ? `${String(rawSymbol).toUpperCase()}: ${reason}. Supported: ${INDEX_KEYS.join(', ')}`
                    : `Not an F&O index. Supported: ${INDEX_KEYS.join(', ')}`
            );
        }

        const [chainRes, quoteRes, barsRes, hourlyRes] = await Promise.allSettled([
            nseOptionChainService.fetchOptionContext(spec.nse),
            indianStockQuoteService.fetchQuote(spec.nse),
            fetchYahooIntradayCandles(spec.yahoo, { interval: '5m', range: '5d' }),
            fetchYahooIntradayCandles(spec.yahoo, { interval: '1h', range: '1mo' }),
        ]);
        const chain = chainRes.status === 'fulfilled' ? chainRes.value : null;
        const quote = quoteRes.status === 'fulfilled' ? quoteRes.value : null;
        const rawBars = barsRes.status === 'fulfilled'
            ? (Array.isArray(barsRes.value) ? barsRes.value : barsRes.value?.candles)
            : null;
        const hourly = hourlyRes.status === 'fulfilled'
            ? (Array.isArray(hourlyRes.value) ? hourlyRes.value : hourlyRes.value?.candles)
            : null;
        const snap = chain?.snapshot || null;

        if (!snap) {
            const chainErr = chainRes.status === 'rejected' ? chainRes.reason?.message : '';
            const hint = chainErr.includes('rate limit') || chainErr.includes('429')
                ? 'Try again in 30–60 seconds.'
                : 'Try again shortly.';
            throw new Error(`Option chain unavailable for ${spec.label}. ${hint}`);
        }

        // Prefer the chain's own underlyingValue: it is the number the strikes are
        // priced against, so a Yahoo/chain disagreement would misplace the ATM.
        const spot = snap.spot ?? quote?.price ?? null;
        const walls = oiWalls(snap.topCe, snap.topPe, spot);
        const mp = maxPain(
            (snap.topCe || []).map((c) => ({
                strike: c.strike,
                ceOi: c.oi,
                peOi: (snap.topPe || []).find((p) => p.strike === c.strike)?.oi || 0,
            }))
        );

        const lot = spec.lot;
        const ceCapital = snap.atmCe?.ltp != null ? snap.atmCe.ltp * lot : null;
        const peCapital = snap.atmPe?.ltp != null ? snap.atmPe.ltp * lot : null;

        // ---- directional read, from the fade rules that survived the holdout ----
        const nowMin = istMinuteOfDay();
        const todayBars = todaySessionBars(rawBars);
        const signal = evaluateIndexSignal(todayBars, nowMin);

        // A fade long buys the CE; a fade short buys the PE.
        const leg = signal.side === 'long' ? snap.atmCe : signal.side === 'short' ? snap.atmPe : null;
        const legName = signal.side === 'long' ? 'CE' : signal.side === 'short' ? 'PE' : null;
        const plan = signal.side && leg?.ltp != null && signal.atr
            ? sizeIndexTrade({
                  premium: leg.ltp,
                  lot,
                  indexAtr: signal.atr,
                  capital: this.capital,
                  minProfit: this.minProfit,
                  maxProfit: this.maxProfit,
              })
            : null;

        const confidence = signalConfidence(signal);

        // ---- the tgbot2 strategy engines: fire almost all day so the card does
        // not dead-end whenever the measured fade rule is quiet ----
        const full5m = (rawBars || [])
            .filter((c) => Number.isFinite(c?.close) && !(!(c.volume > 0) && c.high === c.low))
            .map((c) => ({ ...c, min: istMinuteOfDay(c.ts) }));
        const strategies = evaluateStrategies({
            chain: { ...snap, walls },
            quote,
            today5m: todayBars,
            full5m,
            hourly,
            nowMin,
            opts: this.strategyOpts,
        });

        // Attach a sized ATM option plan to each firing strategy so the card can
        // show `Lots / ₹ entry / ₹ exit / ₹ stop / rupee profit + loss` — the
        // same treatment the fade path gets. Old KC/ST cards printed INDEX levels
        // only, which left the user to translate 30-point moves into premium by
        // hand.
        if (Array.isArray(strategies?.list)) {
            const sizingCtx = {
                atmCe: snap.atmCe,
                atmPe: snap.atmPe,
                lot,
                capital: this.capital,
                minProfit: this.minProfit,
                maxProfit: this.maxProfit,
            };
            for (const strat of strategies.list) {
                strat.optionPlan = sizeStrategyOption(strat, sizingCtx);
            }
            if (strategies.winner && !strategies.winner.optionPlan) {
                strategies.winner.optionPlan = sizeStrategyOption(strategies.winner, sizingCtx);
            }
        }

        logger.info(`📐 Index read ${spec.nse}: spot ${fmt(spot)} ATM ${snap.atmStrike} exp ${snap.expiry}`);

        return {
            key: spec.nse,
            label: spec.label,
            lot,
            spot,
            changePct: quote?.changePct ?? null,
            // The quote exposes `high`/`low` (session extremes), not dayHigh/dayLow —
            // reading the wrong names made the range line vanish silently.
            dayLow: quote?.low ?? null,
            dayHigh: quote?.high ?? null,
            prevClose: quote?.prevClose ?? null,
            rangePos: rangePosition(spot, quote?.low, quote?.high),
            expiry: snap.expiry ?? null,
            atmStrike: snap.atmStrike ?? null,
            atmCe: snap.atmCe ?? null,
            atmPe: snap.atmPe ?? null,
            ceCapital,
            peCapital,
            pcr: snap.pcr ?? null,
            pcrLabel: pcrLabel(snap.pcr),
            walls,
            maxPain: mp,
            topCe: snap.topCe || [],
            topPe: snap.topPe || [],
            capital: this.capital,
            nowMin,
            signal,
            confidence,
            legName,
            leg,
            plan,
            strategies,
        };
    }

    /**
     * The live trade this analysis card is showing, if any — the handler uses
     * it to journal the read for grading. Same sizing path as `format()`, so
     * what gets journaled is exactly what the card shows. Null when the card
     * shows no entry or is size-blocked.
     * @returns {object|null} { side, source, confidence, indexRisk, strike, expiry }
     */
    tradePayload(a) {
        const s = a?.signal || {};
        const p = a?.plan;
        if (s.side && p && !p.blocked) {
            return {
                side: s.side === 'long' ? 'BUY_CE' : 'BUY_PE',
                source: `index-fade-${s.kind || 'unknown'}`,
                confidence: a.confidence?.pct ?? null,
                indexRisk: p.indexRisk,
                strike: a.atmStrike,
                expiry: a.expiry,
            };
        }
        const strat = a?.strategies?.winner;
        if (strat) {
            const leg = strat.side === 'CE' ? a.atmCe : a.atmPe;
            const sp = strat.side && leg?.ltp != null && strat.atr15
                ? sizeIndexTrade({
                      premium: leg.ltp,
                      lot: a.lot,
                      indexAtr: strat.atr15,
                      capital: a.capital ?? this.capital,
                      minProfit: this.minProfit,
                      maxProfit: this.maxProfit,
                  })
                : null;
            if (sp && !sp.blocked) {
                return {
                    side: strat.side === 'CE' ? 'BUY_CE' : 'BUY_PE',
                    source: `index-${strat.key || 'unknown'}`,
                    confidence: strat.confidence ?? null,
                    indexRisk: sp.indexRisk,
                    strike: a.atmStrike,
                    expiry: a.expiry,
                };
            }
        }
        return null;
    }

    /** WhatsApp card. States what it is not, so nobody reads a call into it. */
    format(a) {
        const L = [];
        L.push('┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓');
        L.push(`┃  📐 *INDEX F&O READ* 📐  ┃`);
        L.push('┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛');
        L.push('');
        L.push(`*${a.label}* · lot ${a.lot}`);
        const chg = a.changePct == null ? '' : ` (${a.changePct >= 0 ? '+' : ''}${fmt(a.changePct)}%)`;
        L.push(`Spot: *${fmt(a.spot)}*${chg}`);
        if (a.dayLow != null && a.dayHigh != null) {
            const pos = a.rangePos == null ? '' : ` · ${Math.round(a.rangePos * 100)}% of range`;
            L.push(`Day range: ${fmt(a.dayLow)} – ${fmt(a.dayHigh)}${pos}`);
        }
        L.push(`Expiry: *${a.expiry || '—'}*`);
        L.push('');

        L.push('┌─ *ATM OPTIONS* ─');
        L.push(`│ Strike: *${a.atmStrike ?? '—'}*`);
        if (a.atmCe) {
            L.push(`│ CE ₹${fmt(a.atmCe.ltp)}  ·  1 lot = ${inr(a.ceCapital)}${a.atmCe.iv != null ? `  ·  IV ${fmt(a.atmCe.iv, 1)}%` : ''}`);
        }
        if (a.atmPe) {
            L.push(`│ PE ₹${fmt(a.atmPe.ltp)}  ·  1 lot = ${inr(a.peCapital)}${a.atmPe.iv != null ? `  ·  IV ${fmt(a.atmPe.iv, 1)}%` : ''}`);
        }
        L.push('└────────────────────────────');
        L.push('');

        L.push('┌─ *WHAT THE CHAIN IS PRICING* ─');
        if (a.pcr != null) L.push(`│ PCR: *${fmt(a.pcr)}* — ${a.pcrLabel}`);
        if (a.maxPain != null) L.push(`│ Max pain: *${a.maxPain}*`);
        if (a.walls?.resistance) {
            L.push(`│ Call wall above: *${a.walls.resistance.strike}* (OI ${Number(a.walls.resistance.oi).toLocaleString('en-IN')})`);
        }
        if (a.walls?.support) {
            L.push(`│ Put wall below: *${a.walls.support.strike}* (OI ${Number(a.walls.support.oi).toLocaleString('en-IN')})`);
        }
        L.push('└────────────────────────────');
        L.push('');

        if (a.topCe?.length) {
            L.push(`*Top CE OI:* ${a.topCe.slice(0, 3).map((r) => `${r.strike} (${Number(r.oi).toLocaleString('en-IN')})`).join(' · ')}`);
        }
        if (a.topPe?.length) {
            L.push(`*Top PE OI:* ${a.topPe.slice(0, 3).map((r) => `${r.strike} (${Number(r.oi).toLocaleString('en-IN')})`).join(' · ')}`);
        }
        L.push('');

        // ------------------------------------------------------- the verdict
        const s = a.signal || {};
        const p = a.plan;
        if (!s.side) {
            // The measured fade rule is quiet — show both Keltner and Supertrend results
            const ranked = a.strategies?.list || [];
            const quiet = a.strategies?.quiet || [];
            const winner = a.strategies?.winner;

            if (ranked.length > 0) {
                L.push('┌─ *🎯 STRATEGY RESULTS — Keltner vs Supertrend* ─');
                L.push('│ _Both strategies run independently — pick the better setup_');
                L.push('│');

                for (const strat of ranked) {
                    const dirWord = strat.side === 'CE' ? 'BUY CE' : 'BUY PE';
                    const medal = strat === winner ? '🥇' : '🥈';
                    const betterNote = strat.comparisonNote ? ` _${strat.comparisonNote}_` : '';
                    const wrSuffix = winRateSuffix(a, strat);

                    L.push(`│ ${medal} *${strat.name}*`);
                    L.push(`│ ${dirWord} · ${strat.strength} · Confidence: *${strat.confidence}%* (${strat.confidenceLabel})`);
                    L.push(`│ Win rate: ${strat.winRateTag}${wrSuffix} — ${strat.bestFor}`);
                    L.push('│');

                    if (strat.entry != null && strat.sl != null) {
                        const risk = Math.abs(strat.entry - strat.sl);
                        const t1Dist = strat.target1 != null ? Math.abs(strat.target1 - strat.entry) : null;
                        const t2Dist = strat.target2 != null ? Math.abs(strat.target2 - strat.entry) : null;
                        L.push(`│ 🟢 ENTRY   ${fmt(strat.entry, 0)}`);
                        L.push(`│ 🎯 TARGET1 ${fmt(strat.target1, 0)}  (${t1Dist != null ? '+' + fmt(t1Dist, 0) + ' pts' : '—'})`);
                        L.push(`│ 🎯 TARGET2 ${fmt(strat.target2, 0)}  (${t2Dist != null ? '+' + fmt(t2Dist, 0) + ' pts' : '—'})`);
                        L.push(`│ 🛑 STOP    ${fmt(strat.sl, 0)}  (${fmt(risk, 0)} pts risk)`);
                        if (risk > 0 && t1Dist != null) {
                            const rr = (t1Dist / risk).toFixed(1);
                            L.push(`│ ⚖️ R:R = 1:${rr}`);
                        }

                        // Sized option trade — same UX as the fade card so the
                        // user does not have to translate index points to premium
                        // by hand. Falls back gracefully when there's no leg or
                        // one lot doesn't fit in `capital`.
                        const op = strat.optionPlan;
                        if (op && !op.blocked) {
                            L.push('│');
                            L.push(`│ *${a.atmStrike} ${strat.side}* · ${a.expiry || '—'}`);
                            L.push(`│ Lots: *${op.lots}* (${op.qty} qty) · capital used *${inr(op.capitalUsed)}* of ${inr(a.capital)}`);
                            L.push(`│ 🟢 PREM ENTRY ₹${fmt(op.premEntry)}`);
                            L.push(`│ 🎯 EXIT AT   ₹${fmt(op.premT1)}  →  profit *${inr(op.t1Rs)}*`);
                            L.push(`│ 🛑 PREM STOP  ₹${fmt(op.premStop)}  →  loss *${inr(op.riskRs)}*`);
                            if (op.premT2 != null && op.t2Rs != null) {
                                L.push(`│ 🏃 runner    ₹${fmt(op.premT2)}  →  profit ${inr(op.t2Rs)}`);
                            }
                        } else if (op?.blocked) {
                            L.push('│');
                            L.push(`│ ⚠️ Size blocked: ${op.blocked}`);
                        }
                    }

                    L.push('│');
                    L.push(`│ Why: ${(strat.reasons || []).join(' · ')}`);
                    if (betterNote) L.push(`│ ${betterNote}`);
                    L.push('│ ─────────────────────────');
                }

                for (const key of quiet) {
                    L.push(`│ ➖ ${STRATEGY_META[key]?.short || key} · no setup`);
                }

                L.push('└────────────────────────────');
            } else {
                L.push('┌─ *🚫 NO ENTRY* ─');
                L.push(`│ ${s.reason || 'no setup'}`);
                if (s.vwap != null) L.push(`│ VWAP ${fmt(s.vwap)} · spot is ${fmt(Math.abs(s.stretch ?? 0), 2)}×ATR away`);
                // /too (early|late)|NEGATIVE/ = the measured rule window is closed,
                // not that the market is flat — label it as such so the read is honest.
                const windowClosed = /too (early|late)|NEGATIVE/.test(s.reason || '');
                L.push(`│ 📊 Confidence: *0%* — ${windowClosed ? 'rule window closed (10:00–12:30 IST)' : 'no setup fired'}`);
                const none = a.strategies?.noneReason;
                if (none && !windowClosed) L.push(`│ 🧩 Strategies: ${none}`);
                L.push('└────────────────────────────');

                // When the measured fade rule is not live, give the chain-based lean
                // so the card is not a dead end. Clearly NOT the tested edge.
                const lean = chainLean(a);
                if (lean) {
                    L.push('');
                    L.push('┌─ *📊 CHAIN LEAN* ─');
                    L.push('│ _Unmeasured — conventional options reasoning, not the tested edge_');
                    for (const f of lean.factors) L.push(`│ ${f.detail}`);
                    L.push(`│ NET: *${lean.netLabel}*`);
                    L.push('└────────────────────────────');
                }
            }
        } else if (p?.blocked) {
            const conf = signalConfidence(s);
            L.push('┌─ *🚫 NO ENTRY (size)* ─');
            L.push(`│ 🧠 Strategy: *${FADE_STRATEGY_NAMES[s.kind] || s.kind}*`);
            L.push(`│ Setup present but ${p.blocked}`);
            if (conf) L.push(`│ 📊 Confidence: *${conf.pct}%* — ${conf.label}`);
            L.push('└────────────────────────────');
            appendStrategyRanking(L, a);
        } else if (p) {
            const dirWord = s.side === 'long' ? 'BUY CE' : 'BUY PE';
            const conf = signalConfidence(s);
            const fadeName = FADE_STRATEGY_NAMES[s.kind] || s.kind;
            L.push(`┌─ *✅ ENTER — ${dirWord}* ─`);
            L.push(`│ 🧠 Strategy: *${fadeName}* — the measured fade edge`);
            L.push(`│ Why: ${s.reason}`);
            if (s.veryLate) L.push(`│ ⚠️ past ${hhmm(SIGNAL_WINDOW.deadMin)} — the study measured this window NEGATIVE (late fade)`);
            else if (s.degraded) L.push(`│ ⚠️ past ${hhmm(SIGNAL_WINDOW.closeMin)} — weaker than the tested window`);
            if (conf) L.push(`│ 📊 Confidence: *${conf.pct}%* — ${conf.label}`);
            L.push('│');
            L.push(`│ *${a.atmStrike} ${a.legName}* · ${a.expiry}`);
            L.push(`│ Lots: *${p.lots}* (${p.qty} qty) · capital used *${inr(p.capitalUsed)}* of ${inr(a.capital)}`);
            L.push('│');
            L.push(`│ 🟢 ENTRY  ₹${fmt(p.premEntry)}`);
            L.push(`│ 🎯 EXIT AT ₹${fmt(p.premT1)}  →  profit *${inr(p.t1Rs)}*`);
            L.push(`│ 🛑 STOP   ₹${fmt(p.premStop)}  →  loss *${inr(p.riskRs)}*`);
            L.push(`│ 🏃 runner ₹${fmt(p.premT2)}  →  profit ${inr(p.t2Rs)} _(beyond the tested target)_`);
            L.push('└────────────────────────────');
            L.push('');
            L.push(`_Exit at ₹${fmt(p.premT1)} is the measured target: a ${fmt(p.indexRisk)}-point index move_`);
            L.push(`_toward VWAP, ~half of which reaches the ATM premium. Stop and target are_`);
            L.push('_the same size (1:1) — that is the ratio the edge was measured at, so_');
            L.push('_do not widen one without the other._');
            appendStrategyRanking(L, a);
        }
        L.push('');
        L.push('─────────────────────────────');
        L.push('*How this was measured*');
        L.push('_Indices REVERT where single stocks trend. Fading a stretch from VWAP_');
        L.push('_scored *66.7% at 1:1* (n=51) over 23 sessions; the same opening-range_');
        L.push('_BREAKOUT scored 36.7%. Positive in all four indices and both_');
        L.push('_directions, and the held-out pair (FINNIFTY/MIDCPNIFTY) came out_');
        L.push('_better than the fitted pair._');
        L.push('_Caveats: n=51, one month, one regime. Measured on the INDEX move —_');
        L.push('_theta works against a bought option, so the premium lags it._');
        L.push('⚠️ _Not financial advice · education only · size small_');
        return L.join('\n');
    }
}

/** Display names for the two measured fade rules (what /index is actually reading). */
export const FADE_STRATEGY_NAMES = {
    'vwap-stretch': 'VWAP Stretch Fade',
    'failed-break': 'Failed Range Break Fade',
};

/**
 * The "everything was scanned" block, rendered on EVERY verdict card — even when
 * the measured fade fires (that is what hid the strategy UI before: NIFTY stays
 * stretched above VWAP for long stretches, so /index kept printing the same fade
 * card and the strategy work was invisible). The fade leads when live, then the
 * five tgbot2 engines ranked by quality score, quiet ones marked "no setup".
 */
/**
 * Measured per-strategy win rate from live journaled /index trades, once a
 * source has enough decided rows (>=3) to mean anything. Grading is on the
 * underlying's direction — option premiums are not retrievable historically —
 * so the number is a direction hit-rate, not the option's P&L.
 */
function liveStatTag(a, source) {
    const st = a?.liveStats?.[source];
    if (!st) return null;
    const decided = (st.win || 0) + (st.loss || 0);
    if (decided >= 3) return ` · live ${st.win}W/${st.loss}L (${Math.round((st.winRate || 0) * 100)}%)`;
    if (st.pending > 0) return ` · live ${st.pending} pending`;
    return null;
}

/**
 * Suffix for the Keltner/Supertrend win-rate label. Until we have >=3 decided
 * live trades for a given strategy source, its 77%/67% number is a backtest
 * CLAIM, not a measured edge like the fade (which cites n=51, 23 sessions).
 * Callers append this to `strat.winRateTag` so readers can't confuse the two.
 */
function winRateSuffix(a, strat) {
    if (!strat?.key) return '';
    const source = `index-${strat.key}`;
    const st = a?.liveStats?.[source];
    const decided = (st?.win || 0) + (st?.loss || 0);
    if (decided >= 3) return '';
    return ' _(backtest claim, unjournaled)_';
}

function appendStrategyRanking(L, a) {
    const ranked = a.strategies?.list || [];
    const quiet = a.strategies?.quiet || [];
    const s = a.signal || {};
    if (!ranked.length && !quiet.length && !s.side) return;

    L.push('');
    L.push('┌─ *📊 STRATEGY COMPARISON* ─');
    L.push('│ _Both strategies run independently — pick the better setup_');
    L.push('│');

    // Show the measured fade as the lead row when it fires
    if (s.side && s.kind) {
        const fadeName = FADE_STRATEGY_NAMES[s.kind] || s.kind;
        const fadeSideWord = s.side === 'long' ? 'BUY CE' : 'BUY PE';
        const fadeTag = liveStatTag(a, `index-fade-${s.kind}`);
        const conf = signalConfidence(s);
        L.push(`│ 🥇 *Fade* — ${fadeName} · ${fadeSideWord} · ${conf ? conf.pct + '%' : '?'}${fadeTag || ''}`);
        L.push('│ ─────────────────────────');
    }

    // Show each firing strategy with full details
    for (const r of ranked) {
        const sideWord = r.side === 'CE' ? 'BUY CE' : 'BUY PE';
        const short = STRATEGY_META[r.key]?.short || r.key;
        const tag = liveStatTag(a, `index-${r.key}`);
        const wrSuffix = tag ? '' : winRateSuffix(a, r);
        const medal = r === ranked[0] ? '🥇' : '🥈';
        const betterNote = r.comparisonNote ? ` _${r.comparisonNote}_` : '';

        L.push(`│ ${medal} *${short}* — ${sideWord}`);
        L.push(`│ Win rate: ${r.winRateTag}${wrSuffix} · Confidence: *${r.confidence}%*${tag || ''}`);
        L.push(`│ Best for: ${r.bestFor}`);
        L.push(`│`);

        if (r.entry != null && r.sl != null) {
            const risk = Math.abs(r.entry - r.sl);
            const t1Dist = r.target1 != null ? Math.abs(r.target1 - r.entry) : null;
            const t2Dist = r.target2 != null ? Math.abs(r.target2 - r.entry) : null;
            L.push(`│ 🟢 ENTRY   ${fmt(r.entry, 0)}`);
            L.push(`│ 🎯 TARGET1 ${fmt(r.target1, 0)}  (${t1Dist != null ? '+' + fmt(t1Dist, 0) + ' pts' : '—'})`);
            L.push(`│ 🎯 TARGET2 ${fmt(r.target2, 0)}  (${t2Dist != null ? '+' + fmt(t2Dist, 0) + ' pts' : '—'})`);
            L.push(`│ 🛑 STOP    ${fmt(r.sl, 0)}  (${fmt(risk, 0)} pts risk)`);
            if (risk > 0 && t1Dist != null) {
                const rr = (t1Dist / risk).toFixed(1);
                L.push(`│ ⚖️ R:R = 1:${rr}`);
            }

            // Premium sizing for the top-ranked strategy so the fade-fired path
            // also names the option, lots and rupee outcomes.
            if (r === ranked[0] && r.optionPlan && !r.optionPlan.blocked) {
                const op = r.optionPlan;
                L.push(`│`);
                L.push(`│ *${a.atmStrike} ${r.side}* · ${a.expiry || '—'} · Lots *${op.lots}* (${op.qty} qty)`);
                L.push(`│ 🟢 PREM ENTRY ₹${fmt(op.premEntry)} · 🎯 EXIT ₹${fmt(op.premT1)} → *${inr(op.t1Rs)}* · 🛑 STOP ₹${fmt(op.premStop)} → loss *${inr(op.riskRs)}*`);
            } else if (r === ranked[0] && r.optionPlan?.blocked) {
                L.push(`│`);
                L.push(`│ ⚠️ Size blocked: ${r.optionPlan.blocked}`);
            }
        }

        L.push(`│`);
        L.push(`│ Why: ${(r.reasons || []).join(' · ')}`);
        if (betterNote) L.push(`│ ${betterNote}`);
        L.push('│ ─────────────────────────');
    }

    // Show quiet strategies
    for (const key of quiet) {
        L.push(`│ ➖ ${STRATEGY_META[key]?.short || key} · no setup`);
    }

    L.push('└────────────────────────────');
}

export const indexAnalysisService = new IndexAnalysisService();
export default IndexAnalysisService;
