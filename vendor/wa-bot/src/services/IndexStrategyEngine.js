/**
 * Index strategy engine — Keltner Channels + Supertrend.
 *
 * Two complementary strategies:
 *   1. Keltner Channels (Mean Reversion) — ~77% WR, best for sideways/choppy markets
 *   2. Supertrend (Trend Following) — ~67% WR, best for trending markets
 *
 * Each fires independently. The /index card shows BOTH results side-by-side
 * with entry, SL, target, and confidence so the user can pick the better one.
 */

import { emaPandas, rsi, adx, lastFinite, keltnerChannels, supertrend } from '../utils/indicators.js';

export const STRATEGY_KEYS = {
    KELTNER: 'keltner',
    SUPERTREND: 'supertrend',
};

export const STRATEGY_META = {
    [STRATEGY_KEYS.KELTNER]: {
        name: 'Keltner Channels (Mean Reversion)',
        short: 'Keltner',
        baseWin: 77,
        rank: 40,
        tag: '~77%',
        bestFor: 'Sideways / choppy markets',
        description: 'Buy at lower band, sell at upper band. Works best when ADX < 20.',
    },
    [STRATEGY_KEYS.SUPERTREND]: {
        name: 'Supertrend (Trend Following)',
        short: 'Supertrend',
        baseWin: 67,
        rank: 35,
        tag: '~67%',
        bestFor: 'Trending markets',
        description: 'ATR-based trend line. Entry on flip, ride the trend. High R:R (3:1).',
    },
};

const DEFAULTS = {
    // Keltner Channels settings
    keltnerEmaPeriod: 20,
    keltnerAtrPeriod: 10,
    keltnerMultiplier: 1.5,

    // Supertrend settings
    supertrendPeriod: 10,
    supertrendMultiplier: 3.0,

    // General
    minAdx: 16,
    lastEntryMin: 15 * 60, // 15:00 IST
};

/** IST minute-of-day (market clock). */
export function istMinuteOfDay(nowMs = Date.now()) {
    const d = new Date(nowMs + 5.5 * 3600e3);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** Session VWAP. */
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

/** Resample 5m bars into 15m bars. */
export function resample15m(bars) {
    const out = [];
    for (const b of bars || []) {
        const min = b.min;
        if (!Number.isFinite(min)) continue;
        const slot = Math.floor(min / 15);
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
 * Build the technical snapshot for the two strategies.
 */
export function buildTech({ today5m = [], full5m = [], hourly = null, chain = null, quote = null } = {}) {
    const spot = Number(chain?.spot) || null;
    const fifteen = resample15m(full5m);
    const closes15 = fifteen.map((b) => b.close).filter(Number.isFinite);
    const highs15 = fifteen.map((b) => b.high).filter(Number.isFinite);
    const lows15 = fifteen.map((b) => b.low).filter(Number.isFinite);
    const today15 = resample15m(today5m);
    const todayCloses = today15.map((b) => b.close).filter(Number.isFinite);

    const ema9 = lastFinite(emaPandas(closes15, 9));
    const ema21 = lastFinite(emaPandas(closes15, 21));

    // 4-bar lookback momentum
    let momPct = null;
    if (closes15.length > 5) {
        const ref = closes15[closes15.length - 5];
        if (ref) momPct = ((closes15[closes15.length - 1] - ref) / ref) * 100;
    }

    const prevClose = Number(quote?.prevClose) || null;
    let dayPct = null;
    if (spot != null && prevClose != null && prevClose > 0) {
        dayPct = ((spot - prevClose) / prevClose) * 100;
    }

    return {
        spot,
        vwap: sessionVwap(today5m),
        ema9,
        ema21,
        rsi: rsi(closes15, 7),
        adx: adx({
            high: fifteen.map((b) => b.high),
            low: fifteen.map((b) => b.low),
            close: closes15,
        }),
        closes15,
        highs15,
        lows15,
        momPct,
        dayPct,
        atr15: barAtr(today15.length ? today15 : fifteen, 6),
        lastBarMin: today5m.length ? today5m[today5m.length - 1].min : null,
        todayCloses,
    };
}

// ──────────────────── STRATEGY 1: Keltner Channels (Mean Reversion) ────────────────────

/**
 * Keltner Channels — buy near lower band, sell near upper band.
 * Works best in sideways markets (ADX < 20).
 *
 * @returns {{key, side, strength, reasons, entry, sl, target1, target2}|null}
 */
export function checkKeltner(tech, chain, opts) {
    const { spot, adx: adxV, rsi: rsiV, vwap, closes15, highs15, lows15 } = tech;
    if (spot == null || !closes15?.length) return null;

    // Hard ADX gate: Keltner is a mean-reversion strategy, and mean reversion loses
    // in a strong trend. The old code let KC fire in any ADX regime and only
    // downgraded the score — which produced low-confidence CE calls in the middle
    // of a bearish trend. Refuse to fire when ADX says the market is trending.
    if (adxV != null && adxV >= (opts.keltnerMaxAdx ?? 25)) return null;

    const kc = keltnerChannels(closes15, highs15, lows15,
        opts.keltnerEmaPeriod, opts.keltnerAtrPeriod, opts.keltnerMultiplier);
    if (!kc) return null;

    const atr = kc.atr || tech.atr15;
    if (!atr || atr <= 0) return null;

    const pcr = Number(chain?.pcr) != null ? Number(chain.pcr) : 1;
    const reasons = [];
    const kcRange = kc.upper - kc.lower;
    if (!(kcRange > 0)) return null;

    // Position within Keltner Channel (0 = lower, 1 = upper)
    const position = (spot - kc.lower) / kcRange;

    let side = null;

    // BUY near lower band (mean reversion bounce)
    if (position < 0.2 && rsiV != null && rsiV < 35) {
        side = 'CE';
        reasons.push(`Price near lower KC band ${kc.lower.toFixed(0)}`);
        reasons.push(`RSI ${rsiV.toFixed(0)} oversold — bounce expected`);
        reasons.push(`KC range: ${kc.lower.toFixed(0)} – ${kc.upper.toFixed(0)}`);
        if (vwap != null && spot < vwap) reasons.push(`Below VWAP ${vwap.toFixed(0)} — snap-back target`);
        if (pcr > 1.1) reasons.push(`PCR ${pcr.toFixed(2)} supports bounce`);
        if (adxV != null && adxV < 20) reasons.push(`ADX ${adxV.toFixed(0)} — sideways, mean reversion zone`);
    }
    // SELL near upper band (mean reversion fade)
    else if (position > 0.8 && rsiV != null && rsiV > 65) {
        side = 'PE';
        reasons.push(`Price near upper KC band ${kc.upper.toFixed(0)}`);
        reasons.push(`RSI ${rsiV.toFixed(0)} overbought — pullback expected`);
        reasons.push(`KC range: ${kc.lower.toFixed(0)} – ${kc.upper.toFixed(0)}`);
        if (vwap != null && spot > vwap) reasons.push(`Above VWAP ${vwap.toFixed(0)} — fade target`);
        if (pcr < 0.9) reasons.push(`PCR ${pcr.toFixed(2)} supports pullback`);
        if (adxV != null && adxV < 20) reasons.push(`ADX ${adxV.toFixed(0)} — sideways, mean reversion zone`);
    }

    if (!side) return null;

    // Calculate entry, SL, targets
    const entry = spot;
    const sl = side === 'CE' ? kc.lower - 0.3 * atr : kc.upper + 0.3 * atr;
    const target1 = side === 'CE' ? kc.middle : kc.middle;
    const target2 = side === 'CE' ? kc.upper : kc.lower;

    return {
        key: STRATEGY_KEYS.KELTNER,
        side,
        strength: position < 0.1 || position > 0.9 ? 'STRONG' : 'MODERATE',
        layers: 'KC+RSI',
        reasons,
        entry,
        sl,
        target1,
        target2,
        kc,
        atr,
    };
}

// ──────────────────── STRATEGY 2: Supertrend (Trend Following) ────────────────────

/**
 * Supertrend — enter on trend flip, ride the trend.
 * Best in trending markets (ADX > 20).
 *
 * @returns {{key, side, strength, reasons, entry, sl, target1, target2}|null}
 */
export function checkSupertrend(tech, chain, opts) {
    const { spot, adx: adxV, rsi: rsiV, ema9, ema21, closes15, highs15, lows15 } = tech;
    if (spot == null || !closes15?.length) return null;

    const st = supertrend(highs15, lows15, closes15,
        opts.supertrendPeriod, opts.supertrendMultiplier);
    if (!st) return null;

    const atr = tech.atr15;
    if (!atr || atr <= 0) return null;

    const pcr = Number(chain?.pcr) != null ? Number(chain.pcr) : 1;
    const reasons = [];

    // Two ways ST fires on an on-demand /index read:
    //   1. Fresh flip — the last few bars just changed direction. The old code
    //      only accepted a flip on the LAST bar; /index is manual and 15m bars
    //      are 15 minutes wide, so almost no user ever hit that. We now accept a
    //      flip within the last `freshFlipBars` completed bars (default 3, ~45m).
    //   2. Trend continuation — direction is established and price pulled back
    //      near the ST line, so the entry is at a sensible risk point (not late
    //      chasing). This requires ADX-confirmed trend + EMA alignment so we
    //      don't call every faint drift a trend.
    const freshFlipBars = opts.supertrendFreshBars ?? 3;
    const continuationMaxBars = opts.supertrendContinuationMaxBars ?? 10;
    const continuationBandAtr = opts.supertrendContinuationBandAtr ?? 0.6;
    const trendAdxMin = opts.supertrendTrendAdxMin ?? 20;

    const barsSince = Number.isFinite(st.barsSinceFlip) ? st.barsSinceFlip : 0;
    const freshFlip = st.prevDirection !== 0 && barsSince <= freshFlipBars;
    const bullEmaAligned = ema9 != null && ema21 != null && ema9 > ema21;
    const bearEmaAligned = ema9 != null && ema21 != null && ema9 < ema21;
    const proximityAtr = atr > 0 ? Math.abs(spot - st.supertrend) / atr : Infinity;
    const strongAdx = adxV != null && adxV >= trendAdxMin;
    const continuation =
        !freshFlip &&
        barsSince <= continuationMaxBars &&
        proximityAtr <= continuationBandAtr &&
        strongAdx &&
        ((st.direction === 1 && bullEmaAligned) || (st.direction === -1 && bearEmaAligned));

    let side = null;
    let kind = null;

    if (st.direction === 1 && (freshFlip || continuation)) {
        side = 'CE';
        kind = freshFlip ? 'fresh-flip' : 'continuation';
        if (freshFlip) {
            reasons.push(`Supertrend flipped BULLISH at ${st.supertrend.toFixed(0)}`);
            reasons.push(barsSince === 0
                ? 'Fresh trend flip on this bar'
                : `Recent trend flip (${barsSince} bar${barsSince === 1 ? '' : 's'} ago)`);
        } else {
            reasons.push(`Bullish trend intact — ${barsSince} bars since flip`);
            reasons.push(`Pullback near ST line (${proximityAtr.toFixed(2)}×ATR) — entry on retest`);
        }
        if (ema9 != null && ema21 != null) {
            if (bullEmaAligned) reasons.push(`EMA9(${ema9.toFixed(0)}) > EMA21(${ema21.toFixed(0)}) uptrend`);
            else reasons.push('EMA alignment pending — trend early stage');
        }
        if (strongAdx) reasons.push(`ADX ${adxV.toFixed(0)} — strong trend`);
        if (pcr > 1.0) reasons.push(`PCR ${pcr.toFixed(2)} — put writing supports upside`);
    }
    else if (st.direction === -1 && (freshFlip || continuation)) {
        side = 'PE';
        kind = freshFlip ? 'fresh-flip' : 'continuation';
        if (freshFlip) {
            reasons.push(`Supertrend flipped BEARISH at ${st.supertrend.toFixed(0)}`);
            reasons.push(barsSince === 0
                ? 'Fresh trend flip on this bar'
                : `Recent trend flip (${barsSince} bar${barsSince === 1 ? '' : 's'} ago)`);
        } else {
            reasons.push(`Bearish trend intact — ${barsSince} bars since flip`);
            reasons.push(`Pullback near ST line (${proximityAtr.toFixed(2)}×ATR) — entry on retest`);
        }
        if (ema9 != null && ema21 != null) {
            if (bearEmaAligned) reasons.push(`EMA9(${ema9.toFixed(0)}) < EMA21(${ema21.toFixed(0)}) downtrend`);
            else reasons.push('EMA alignment pending — trend early stage');
        }
        if (strongAdx) reasons.push(`ADX ${adxV.toFixed(0)} — strong trend`);
        if (pcr < 1.0) reasons.push(`PCR ${pcr.toFixed(2)} — call writing supports downside`);
    }

    if (!side) return null;

    const entry = spot;
    const sl = st.supertrend;
    const risk = Math.abs(entry - sl);
    const target1 = side === 'CE' ? entry + 1.5 * risk : entry - 1.5 * risk;
    const target2 = side === 'CE' ? entry + 2.5 * risk : entry - 2.5 * risk;

    // Continuation is a weaker read than a fresh flip: entry is later in the move
    // and stops are wider. Downgrade the strength label so scoring reflects that.
    const strongTrend = adxV != null && adxV >= 25;
    let strength;
    if (kind === 'continuation') strength = strongTrend ? 'MODERATE' : 'WEAK';
    else strength = strongTrend ? 'STRONG' : 'MODERATE';

    return {
        key: STRATEGY_KEYS.SUPERTREND,
        side,
        strength,
        layers: 'ST+EMA',
        kind,
        reasons,
        entry,
        sl,
        target1,
        target2,
        supertrend: st,
        atr,
    };
}

/** Quality score for ranking strategies. */
export function qualityScore(result, tech, chain) {
    let score = 0;
    const { key, side } = result;
    const { adx: adxV, ema9, ema21, spot, rsi: rsiV } = tech;

    if (key === STRATEGY_KEYS.KELTNER) {
        // Keltner benefits from low ADX (sideways)
        if (adxV != null) {
            if (adxV < 15) score += 25;
            else if (adxV < 20) score += 15;
            else score += 5;
        }
        // RSI confirmation
        if (rsiV != null) {
            if ((side === 'CE' && rsiV < 30) || (side === 'PE' && rsiV > 70)) score += 20;
            else if ((side === 'CE' && rsiV < 40) || (side === 'PE' && rsiV > 60)) score += 10;
        }
        // Strong signal (very close to band)
        if (result.strength === 'STRONG') score += 15;
    }

    if (key === STRATEGY_KEYS.SUPERTREND) {
        // Supertrend benefits from high ADX (trending)
        if (adxV != null) {
            if (adxV >= 25) score += 25;
            else if (adxV >= 20) score += 15;
            else score += 5;
        }
        // EMA alignment
        if (ema9 != null && ema21 != null && spot != null) {
            const aligned = (side === 'CE' && ema9 > ema21 && spot > ema9) ||
                (side === 'PE' && ema9 < ema21 && spot < ema9);
            if (aligned) score += 20;
        }
        // Freshness bonus — heavier the closer to the flip bar. A continuation
        // read is intentionally scored lower than a fresh flip.
        const barsSince = Number(result.supertrend?.barsSinceFlip);
        if (result.kind === 'continuation') score += 3;
        else if (Number.isFinite(barsSince)) {
            if (barsSince === 0) score += 12;
            else if (barsSince <= 1) score += 8;
            else score += 5;
        } else if (result.supertrend?.direction !== result.supertrend?.prevDirection) {
            score += 10;
        }
    }

    return score + 10;
}

/** Win-confidence estimate. */
export function strategyConfidence(key, score) {
    const base = STRATEGY_META[key]?.baseWin ?? 60;
    const adj = (Number(score) - 55) * 0.4;
    const pct = Math.max(40, Math.min(92, Math.round(base + adj)));
    const label = pct >= 75 ? 'high' : pct >= 62 ? 'medium' : 'low';
    return { pct, label };
}

/**
 * Run both strategies and return results.
 * Each strategy fires independently — the card shows BOTH.
 */
export function evaluateStrategies({ chain, quote, today5m = [], full5m = [], hourly = null, nowMin = null, opts = {} } = {}) {
    const o = { ...DEFAULTS, ...opts };
    const now = nowMin != null ? nowMin : istMinuteOfDay();
    const tech = buildTech({ today5m, full5m, hourly, chain, quote });

    // Clock gate
    if (now >= o.lastEntryMin) {
        return { list: [], winner: null, evaluated: false, noneReason: `past last entry time (${Math.floor(o.lastEntryMin / 60)}:00 IST)` };
    }
    if (tech.lastBarMin != null && now - tech.lastBarMin > 45) {
        return { list: [], winner: null, evaluated: false, noneReason: 'no fresh session bars — market closed or feed stale' };
    }
    if (tech.spot == null) {
        return { list: [], winner: null, evaluated: false, noneReason: 'no spot price from the option chain' };
    }

    // Run both strategies independently
    const checks = [
        [STRATEGY_KEYS.KELTNER, (t) => checkKeltner(t, chain, o)],
        [STRATEGY_KEYS.SUPERTREND, (t) => checkSupertrend(t, chain, o)],
    ];

    const list = [];
    const quiet = [];
    for (const [key, fn] of checks) {
        let r = null;
        try { r = fn(tech, chain, o, now); } catch { r = null; }
        if (!r) { quiet.push(key); continue; }
        const meta = STRATEGY_META[r.key] || {};
        const score = qualityScore(r, tech, chain);
        const conf = strategyConfidence(r.key, score);
        list.push({
            ...r,
            name: meta.name || r.key,
            winRateTag: meta.tag || '',
            bestFor: meta.bestFor || '',
            description: meta.description || '',
            score,
            confidence: conf.pct,
            confidenceLabel: conf.label,
            atr15: tech.atr15,
        });
    }

    // Sort by score (higher = better setup right now)
    list.sort((a, b) => (b.score - a.score) || (STRATEGY_META[b.key]?.rank || 0) - (STRATEGY_META[a.key]?.rank || 0));

    // Pick winner (best setup right now)
    const winner = list[0] || null;

    // If both fired, add comparison note
    if (list.length === 2) {
        const [a, b] = list;
        const better = a.score >= b.score ? a : b;
        const worse = a.score >= b.score ? b : a;
        better.comparisonNote = `Better setup right now (score ${better.score} vs ${worse.score})`;
        worse.comparisonNote = `Weaker setup — ${better.name} preferred`;
    }

    const noneReason = list.length
        ? null
        : `no strategy fired — Keltner needs price near KC band + RSI <35/>65, Supertrend needs fresh flip`;

    return { list, quiet, winner, evaluated: true, noneReason };
}
