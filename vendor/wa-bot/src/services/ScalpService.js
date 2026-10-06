/**
 * ScalpService — /scalp command
 *
 * Fetches live NSE option chain for NIFTY, calculates:
 * - Scalp range (support/resistance from OI walls)
 * - Live premiums (ATM CE/PE)
 * - Confidence scores per setup
 * - Regime detection (normal / low VIX / trending)
 * - Visual scalp map card
 */

import { nseOptionChainService, findStrikeLeg } from './NseOptionChainService.js';
import { maxPain, delta } from '../utils/blackScholes.js';
import { buildVolumeProfile, calcSessionVWAP, detectBarAbsorption, auctionRegime, vwapLevels, confluenceScore } from '../utils/volumeProfile.js';
import { fetchIndexSessionBars } from '../utils/niftyIntradayProfile.js';
import { fetchBseOptionChain } from './BseOptionChainService.js';
import { SCALP_INDICES, resolveScalpIndex, netPoints } from '../data/scalpIndexConfig.js';
import { fetchIndiaVix, vixFitScore } from './IndiaVixService.js';
import { logger } from '../utils/logger.js';

// ── Regime thresholds ──────────────────────────────────────────────────────

const LOW_VIX_THRESHOLD = 12;
const HIGH_VIX_THRESHOLD = 18;
// Range thresholds now live per index in scalpIndexConfig.js — a single pair of
// NIFTY-scale literals silently mis-classified every SENSEX regime.

// ── Confidence weights ─────────────────────────────────────────────────────

const CONF_WEIGHTS = {
    oiWall: 0.30,
    pcr: 0.20,
    vix: 0.20,
    distance: 0.15,
    timeOfDay: 0.15,
};

// ── Helpers ────────────────────────────────────────────────────────────────

function istTime(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        hour: 'numeric',
        minute: '2-digit',
        hour12: false,
        hourCycle: 'h23',
    }).formatToParts(date);
    let h = Number(parts.find((p) => p.type === 'hour')?.value || 0);
    if (h === 24) h = 0;
    const m = Number(parts.find((p) => p.type === 'minute')?.value || 0);
    return { hour: h, minute: m };
}

function istDateLabel(date = new Date()) {
    return new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: 'numeric',
        month: 'short',
    }).format(date);
}

function round5(n) {
    return Math.round(n / 5) * 5;
}

/**
 * Nearest strike that actually exists in the chain.
 *
 * findStrikeLeg() matches strikes EXACTLY, but the strangle wings were built with
 * round5() — rounding to the nearest 5 while NIFTY strikes step in 50s. So a wing
 * at 24,425 matched nothing, both legs priced 0, and the setup failed its
 * `strangle > 20` check without any error. Measured across typical range widths,
 * 5 of 9 produced a non-existent wing, so SHORT STRANGLE was silently dead in
 * most sessions. Snapping to a real strike is what makes it reachable.
 */
function nearestStrike(chain, target) {
    let best = null;
    for (const s of chain) {
        if (!Number.isFinite(s?.strike)) continue;
        if (best === null || Math.abs(s.strike - target) < Math.abs(best - target)) best = s.strike;
    }
    return best;
}

function round2(n) {
    return Math.round(n * 100) / 100;
}

function confBar(pct) {
    const filled = Math.round(pct / 10);
    const empty = 10 - filled;
    return '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
}

function confLabel(pct) {
    if (pct >= 70) return '\u2705\u2705';
    if (pct >= 55) return '\u2705';
    if (pct >= 40) return '\u26A0\uFE0F';
    return '\u274C';
}

// ── Confidence calculation ─────────────────────────────────────────────────

/**
 * How much this wall LEADS the rest of its side, 0-100.
 *
 * The old `Math.min(100, (oiWallQty / 80) * 100)` needed open interest below 80
 * to score under full marks. Real walls measured 1,664 / 16,300 / 56,200 /
 * 160,000 / 282,973 — every one clamped to 100, so 30% of the confidence score
 * was a constant, and the constant was the OI wall the whole strategy rests on.
 *
 * Two obvious replacements are also constants, both measured before choosing:
 *   percentile rank  — the wall IS the maximum by construction, so this read
 *                      96-97% on every chain and side tested.
 *   ratio to median  — index-biased: NIFTY 3.9-5.4x against SENSEX 9.2-9.6x,
 *                      because SENSEX's chain carries a longer tail of dead
 *                      strikes, not because its walls are twice as strong.
 *
 * Ratio to the mean of the NEXT FIVE strikes avoids both. It ignores the dead
 * tail, and measured comparably across indices: NIFTY 1.48-1.85, SENSEX
 * 1.21-2.38. 1.0x means the "wall" is no bigger than its neighbours — no wall at
 * all; 2.5x is a genuinely dominant one.
 */
export function oiDominance(wallOi, sameSideOis) {
    const qty = Number(wallOi) || 0;
    const pool = (sameSideOis || []).filter((v) => Number.isFinite(v) && v > 0);
    if (!(qty > 0) || pool.length < 4) return 50; // unknown, not "perfect"

    const next5 = [...pool].sort((a, b) => b - a).slice(1, 6);
    if (!next5.length) return 50;
    const ref = next5.reduce((s, v) => s + v, 0) / next5.length;
    if (!(ref > 0)) return 50;

    const FLAT = 1.0;      // indistinguishable from its neighbours
    const DOMINANT = 2.5;  // a real wall
    const ratio = qty / ref;
    return Math.round(Math.max(0, Math.min(1, (ratio - FLAT) / (DOMINANT - FLAT))) * 100);
}

/**
 * Can the index realistically travel `needMove` in a scalp's holding time?
 *
 * India VIX is 30-day IMPLIED volatility. For a 2-5 minute trade that is the
 * wrong instrument, and it was being asked the wrong question: at VIX 11.34 the
 * directional term scored 9/100 while the same session's median 5-minute bar
 * range was 15.5 points — i.e. the 16-point move the chosen strike needed was a
 * ONE-BAR move. Realised intraday range answers "does it actually move enough",
 * which is what a scalp depends on.
 *
 * VIX is still the right input for the theta side, where the trade is literally
 * selling implied volatility.
 */
export function movementFit(realisedRange, needMove) {
    if (!(realisedRange > 0) || !(needMove > 0)) return null;
    const ratio = realisedRange / needMove;
    const LOW = 0.25;  // needs ~4 bars — not a scalp
    const HIGH = 1.0;  // one median bar covers it
    return Math.round(Math.max(0, Math.min(1, (ratio - LOW) / (HIGH - LOW))) * 100);
}

/** Median 5m bar range over the recent session — the realised-movement input. */
export function medianBarRange(bars, lookback = 24) {
    const r = (bars || [])
        .slice(-lookback)
        .map((b) => b.high - b.low)
        .filter((v) => Number.isFinite(v) && v > 0)
        .sort((a, b) => a - b);
    return r.length ? r[Math.floor(r.length / 2)] : null;
}

function calcConfidence({
    oiWallQty, sameSideOis, pcr, vix, spotDistance, regime,
    fitScore = undefined,
    nearZone = 0,
    cfg = SCALP_INDICES.NIFTY,
}) {
    const oiScore = oiDominance(oiWallQty, sameSideOis);
    const pcrScore = Math.min(100, Math.abs(pcr - 1) * 200 + 50);
    // Directional setups pass a realised-movement fit; theta passes nothing and
    // falls through to the implied-vol mapping. null in either case means the
    // term is dropped rather than silently defaulted, which is what the
    // hardcoded 13 was doing.
    const vixScore = fitScore !== undefined && fitScore !== null
        ? fitScore
        : vixFitScore(vix, regime === 'theta' ? 'theta' : 'directional');
    // The two setup types want OPPOSITE things from distance, and one rule
    // cannot serve both:
    //
    //   directional — mean reversion AT a wall. The wall is the entry, so sitting
    //                 on it is the best case and drifting off it is worse. Scored
    //                 against nearZone, the band that actually gates the setup.
    //   theta       — short premium wants price parked MID-range, as far from
    //                 both walls as possible, so decay can run without either
    //                 side being threatened. Scored against the per-index span.
    //
    // Getting this backwards is not cosmetic: scoring theta the directional way
    // paid it most when spot was pinned against a wall, which is precisely when a
    // short straddle is in danger.
    const isTheta = regime === 'theta';
    const span = !isTheta && nearZone > 0 ? nearZone : cfg.zoneSpan;
    const zonePct = Math.min(1, Math.max(0, spotDistance) / span);
    const distScore = isTheta
        ? Math.max(40, Math.min(90, 40 + zonePct * 50))
        : Math.max(40, Math.min(90, 90 - zonePct * 50));

    const { hour, minute } = istTime();
    const timeDecimal = hour + minute / 60;
    let timeScore = 50;
    if (timeDecimal >= 10.5 && timeDecimal <= 12.5) timeScore = 90;
    else if (timeDecimal >= 9.5 && timeDecimal < 10.5) timeScore = 60;
    else if (timeDecimal > 12.5 && timeDecimal <= 14.5) timeScore = 70;
    else timeScore = 30;

    // Weights are renormalised over the terms actually available, so a missing
    // VIX lowers nobody's score by 20 points — it just stops voting.
    const terms = [
        [oiScore, CONF_WEIGHTS.oiWall],
        [pcrScore, CONF_WEIGHTS.pcr],
        [vixScore, CONF_WEIGHTS.vix],
        [distScore, CONF_WEIGHTS.distance],
        [timeScore, CONF_WEIGHTS.timeOfDay],
    ].filter(([v]) => Number.isFinite(v));

    const weightSum = terms.reduce((s, [, w]) => s + w, 0);
    if (!weightSum) return 20;
    const raw = terms.reduce((s, [v, w]) => s + v * w, 0) / weightSum;

    return Math.round(Math.max(20, Math.min(90, raw)));
}

// ── Regime detection ───────────────────────────────────────────────────────

function detectRegime({ spot, maxPainVal, rangeWidth, vix, pcr, cfg = SCALP_INDICES.NIFTY }) {
    if (vix < LOW_VIX_THRESHOLD && rangeWidth < cfg.tightRange) return 'low_vol';
    if (vix > HIGH_VIX_THRESHOLD || rangeWidth > cfg.wideRange) return 'trending';
    const spotVsMp = spot != null && maxPainVal != null ? Math.abs(spot - maxPainVal) : 0;
    // Same proportion of spot as the original 100pts was of NIFTY.
    if (spotVsMp > cfg.tightRange) return 'trending';
    return 'normal';
}

// ── Best strike selection for 5pt scalps ──────────────────────────────────

const EXPIRY_MONTHS = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Years to expiry from either exchange's format — NSE "08-Sep-2026", BSE
 * "10 Sep 2026". Floored at half a day so expiry-day maths cannot divide by zero.
 */
export function expiryYears(expiryStr, now = Date.now()) {
    const m = String(expiryStr || '').trim().match(/^(\d{1,2})[\s-]([A-Za-z]{3})[\s-](\d{4})$/);
    if (!m) return null;
    const mon = EXPIRY_MONTHS[m[2].toLowerCase()];
    if (mon == null) return null;
    // Contracts settle at the 15:30 IST close = 10:00 UTC, not midnight.
    const expMs = Date.UTC(Number(m[3]), mon, Number(m[1]), 10, 0);
    const days = Math.max(0.5, (expMs - now) / 86_400_000);
    return days / 365;
}

/**
 * How far the INDEX must travel for this strike's premium to move `targetPts`.
 *
 * This is the number that decides whether an 8-point scalp is reachable at all,
 * and nothing in the old scorer measured it. Premium move ≈ delta × index move,
 * so a low-delta OTM strike needs a far bigger move for the same rupees.
 *
 * Measured on the live 08-Sep NIFTY chain (spot 23,873) for a +8 target:
 *   23850 ATM  delta 0.574 ->  14 index pts
 *   24000      delta 0.332 ->  24 index pts
 *   24100      delta 0.207 ->  39 index pts
 *   24200      delta 0.121 ->  66 index pts
 *
 * The old scorer's ₹30-90 band picked 24000-24100 — 24 to 39 points — and its
 * `isOTM ? +15` bonus actively steered there. In a 2-5 minute hold that is the
 * difference between a routine move and one that essentially never arrives.
 */
export function requiredIndexMove({ side, spot, strike, iv, years, targetPts }) {
    if (!(iv > 0) || !(years > 0)) return null;
    const d = delta(side === 'PE' ? 'PE' : 'CE', { spot, strike, iv, years });
    if (d == null || Math.abs(d) < 0.01) return null;
    return targetPts / Math.abs(d);
}

/**
 * Score a strike for scalping: can it actually deliver the target, and is it
 * liquid and sanely priced while doing so?
 *
 * Reachability (delta) is now the largest single term. The stop is the same
 * number of premium points whichever strike is chosen, so rupee risk per lot
 * does not change with delta — only the capital deployed does. A higher-delta
 * strike therefore buys a materially better chance of hitting the target at the
 * SAME risk, which is why it outranks a cheap lottery ticket here.
 */
export function scoreStrikeForScalp(strike, side, spot, atmStrike, allStrikes, cfg = SCALP_INDICES.NIFTY, years = null) {
    const row = allStrikes.find((s) => s.strike === strike);
    if (!row) return 0;
    const leg = side === 'CE' ? row.ce : row.pe;
    if (!leg) return 0;

    const ltp = leg.ltp || 0;
    if (ltp <= 0) return 0;

    // ── Reachability (0-45): the dominant term ───────────────────────────────
    // How many index points this strike needs to deliver the premium target.
    // The old scorer never measured this and paid a +15 bonus for being OTM,
    // which is precisely the low-delta end where the target is hardest to reach.
    const ivPct = leg.iv || 0;
    const need = requiredIndexMove({
        side, spot, strike, iv: ivPct / 100, years, targetPts: cfg.targetPts,
    });
    let reachScore;
    if (need == null) {
        // No IV or no expiry — fall back to distance from ATM, which is the
        // crude proxy for delta. Neutral-ish, never a confident full mark.
        const steps = Math.abs(strike - atmStrike) / cfg.strikeStep;
        reachScore = Math.max(0, 30 - steps * 6);
    } else if (need <= cfg.reachMove) {
        reachScore = 45;
    } else if (need >= cfg.maxMove) {
        reachScore = 0;
    } else {
        reachScore = 45 * (1 - (need - cfg.reachMove) / (cfg.maxMove - cfg.reachMove));
    }

    // ── Premium band (0-25): cost and liquidity guard ────────────────────────
    // Kept as a guard, not a target. Rupee RISK per lot is set by the stop and
    // is identical across strikes, so a dearer strike costs capital, not risk —
    // but spreads widen and size gets awkward at the extremes.
    const pMin = cfg.premiumMin, pMax = cfg.premiumMax, pSweet = cfg.premiumSweet;
    let premScore;
    if (ltp >= pMin && ltp <= pMax) {
        const span = Math.max(pSweet - pMin, pMax - pSweet, 1);
        premScore = 25 - Math.min(10, (Math.abs(ltp - pSweet) / span) * 10);
    } else if (ltp > pMax) {
        premScore = Math.max(0, 12 - ((ltp - pMax) / Math.max(pMax, 1)) * 24);
    } else {
        premScore = Math.max(0, 12 - ((pMin - ltp) / Math.max(pMin, 1)) * 24);
    }

    // ── Liquidity (0-20), scored within this chain rather than a magic cap ───
    const oi = leg.oi || 0;
    const sideOis = allStrikes
        .map((s) => (side === 'CE' ? s.ce?.oi : s.pe?.oi))
        .filter((v) => Number.isFinite(v) && v > 0);
    const maxOi = sideOis.length ? Math.max(...sideOis) : 0;
    const oiScore = maxOi > 0 ? Math.min(20, (oi / maxOi) * 20) : 0;

    // ── IV sanity (0-10): avoid the most overpriced strike on the board ──────
    const ivScore = ivPct > 0 && ivPct <= 12 ? 10 : ivPct > 12 ? Math.max(0, 10 - (ivPct - 12)) : 5;

    return Math.max(0, Math.round(reachScore + premScore + oiScore + ivScore));
}

/**
 * Find the best strike for a given side (CE/PE) near a target level.
 * Returns the strike with highest momentum score.
 */
function findBestStrike(strikes, targetLevel, side, spot, atmStrike, cfg = SCALP_INDICES.NIFTY, years = null) {
    // For scalping, we want OTM strikes near the trigger price:
    // - BUY CE triggers when spot touches SUPPORT → OTM CE at support = strike > support + 50
    // - BUY PE triggers when spot touches RESISTANCE → OTM PE at resistance = strike < resistance - 50
    // We use targetLevel (support/resistance) as the reference, NOT current spot,
    // because the setup fires when price reaches that level.
    // This ensures symmetric premium selection regardless of current spot position.

    const STRIKE_STEP = cfg.strikeStep; // 50 on NIFTY, 100 on SENSEX

    // OTM at the TRIGGER PRICE (targetLevel), not current spot
    const isOTM = (s) => side === 'CE'
        ? s.strike >= targetLevel + STRIKE_STEP    // CE: OTM when spot is at support
        : s.strike <= targetLevel - STRIKE_STEP;   // PE: OTM when spot is at resistance
    const isATM = (s) => s.strike === atmStrike;

    // Tier 1: OTM at trigger price, ₹30-₹90 premium (best for 8pt scalps)
    // Using the same premium range for both CE and PE ensures symmetric selection
    // regardless of asymmetric support/resistance distances from ATM.
    const PREM_MIN = cfg.premiumMin;
    const PREM_MAX = cfg.premiumMax;
    let candidates = strikes
        .filter((s) => Math.abs(s.strike - targetLevel) <= 300)
        .filter((s) => isOTM(s))
        .filter((s) => {
            const leg = side === 'CE' ? s.ce : s.pe;
            return leg?.ltp > 0 && leg.ltp >= PREM_MIN && leg.ltp <= PREM_MAX;
        });

    // Tier 2: ATM strike (if OTM candidates are too expensive)
    if (!candidates.length || candidates.every(s => {
        const ltp = (side === 'CE' ? s.ce : s.pe)?.ltp || 0;
        return ltp > 150;
    })) {
        const atm = strikes.find((s) => isATM(s));
        if (atm) {
            const leg = side === 'CE' ? atm.ce : atm.pe;
            if (leg?.ltp > 0 && leg.ltp <= 150) {
                candidates = [atm, ...candidates.filter(s => s.strike !== atm.strike)];
            }
        }
    }

    // Tier 3: Any strike with cheap premium within 150pts of target
    if (!candidates.length) {
        candidates = strikes
            .filter((s) => Math.abs(s.strike - targetLevel) <= 150)
            .filter((s) => { const leg = side === 'CE' ? s.ce : s.pe; return leg?.ltp > 0 && leg.ltp <= 120; });
    }

    if (!candidates.length) return null;

    let bestStrike = null;
    let bestScore = -1;
    let bestLtp = 0;

    for (const s of candidates) {
        const score = scoreStrikeForScalp(s.strike, side, spot, atmStrike, strikes, cfg, years);
        const ltp = (side === 'CE' ? s.ce : s.pe)?.ltp || 0;
        // Prefer higher score; break ties by lower premium (cheaper entry)
        if (score > bestScore || (score === bestScore && ltp < bestLtp)) {
            bestScore = score;
            bestStrike = s.strike;
            bestLtp = ltp;
        }
    }

    return { strike: bestStrike, score: bestScore, ltp: bestLtp };
}

/**
 * Return top N strikes for a side, sorted by momentum score descending.
 * Each entry: { strike, ltp, iv, oi, score }
 */
function getTopStrikes(strikes, side, spot, atmStrike, n = 4, cfg = SCALP_INDICES.NIFTY, years = null) {
    const candidates = strikes
        .filter((s) => { const leg = side === 'CE' ? s.ce : s.pe; return leg?.ltp > 0; })
        .map((s) => {
            const leg = side === 'CE' ? s.ce : s.pe;
            return {
                strike: s.strike,
                ltp: leg.ltp || 0,
                iv: leg.iv || 0,
                oi: leg.oi || 0,
                score: scoreStrikeForScalp(s.strike, side, spot, atmStrike, strikes, cfg, years),
            };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, n);
    return candidates;
}

// ── Main function ──────────────────────────────────────────────────────────

class ScalpService {
    constructor() {
        this.nse = nseOptionChainService;
        this.bse = fetchBseOptionChain;
    }

    /**
     * Chain for one index, from whichever exchange lists it.
     *
     * BSE returns settlement figures outside market hours and flags them with
     * `isLive: false` \u2014 measured after close, ATM SENSEX CE read Rs.0.05. Quoting
     * that as a scalp entry is the stale-premium failure again, so a non-live BSE
     * chain is refused here rather than being formatted into a card.
     */
    async _fetchSnapshot(cfg) {
        if (cfg.exchange === 'BSE') {
            const snap = await this.bse(cfg.key);
            if (!snap) return { error: `Could not fetch BSE option chain for ${cfg.label}.` };
            if (snap.isLive === false) {
                const age = snap.ageMinutes != null ? `${snap.ageMinutes} min old` : snap.freshness;
                return {
                    error: `${cfg.label} chain is not live (${age}) \u2014 these are settlement prices, `
                        + 'not tradeable premiums. No scalp setups while the chain is stale.',
                };
            }
            return { snap };
        }

        const ctx = await this.nse.fetchOptionContext(cfg.key);
        if (!ctx?.snapshot) {
            return { error: 'Could not fetch NSE option chain. Market may be closed or NSE is unreachable.' };
        }
        return { snap: ctx.snapshot };
    }

    /**
     * Card plus the snapshot it was built from.
     *
     * The alert scanner needs the chain to grade open scalps against the live
     * premium of the strike it quoted. Returning the snapshot it already fetched
     * keeps that to one request per index per scan instead of two.
     */
    async buildScalpCardWithContext(symbol = 'NIFTY') {
        const cfg = resolveScalpIndex(symbol) || SCALP_INDICES.NIFTY;
        const { snap, error } = await this._fetchSnapshot(cfg);
        if (error) return { card: `\u26A0\uFE0F ${error}`, snapshot: null, cfg };
        const { card, support, resistance, nearZone } = await this._render(cfg, snap);
        // support/resistance/nearZone ride along for consumers that watch the
        // OI-wall levels between scans (the scalp level-heads-up watcher) — they
        // are the exact numbers the card's setups trigger on, so a watcher never
        // re-derives wall logic and can never disagree with the card.
        return { card, support, resistance, nearZone, snapshot: snap, cfg };
    }

    async buildScalpCard(symbol = 'NIFTY') {
        const { card } = await this.buildScalpCardWithContext(symbol);
        return card;
    }

    async _render(cfg, snap) {
        const spot = Number(snap.spot);
        const pcr = snap.pcr;
        const strikes = snap.strikes || [];
        const atmStrike = snap.atmStrike;
        const atmCe = snap.atmCe;
        const atmPe = snap.atmPe;

        if (!spot || !strikes.length) {
            return '\u26A0\uFE0F Incomplete option chain data \u2014 cannot build scalp card.';
        }

        // Near-spot strike universe. Half-width is per index: 600 pts is ~2.5% of
        // NIFTY but only ~0.8% of SENSEX, which would cut the usable chain to a
        // third of the strikes.
        const nearStrikes = strikes.filter(
            (s) => Math.abs(Number(s.strike) - spot) <= cfg.nearWindow
        );
        const chain = nearStrikes.length >= 5 ? nearStrikes : strikes;

        // Max pain
        const mpRows = chain
            .filter((s) => s.ce && s.pe)
            .map((s) => ({
                strike: s.strike,
                CE: { openInterest: s.ce.oi || 0 },
                PE: { openInterest: s.pe.oi || 0 },
            }));
        const mpVal = maxPain(mpRows);

        // OI walls — OTM only relative to spot:
        // resistance = biggest CE wall ABOVE spot, support = biggest PE wall BELOW spot.
        // Without this filter both walls can collapse onto one crowded ATM strike
        // (expiry week), giving range = 0 and a degenerate directional bias.
        const sortedByCe = [...chain].filter((s) => s.ce?.oi && s.strike > spot).sort((a, b) => b.ce.oi - a.ce.oi);
        const sortedByPe = [...chain].filter((s) => s.pe?.oi && s.strike < spot).sort((a, b) => b.pe.oi - a.pe.oi);

        let topCeWall = sortedByCe[0] || null;
        let topPeWall = sortedByPe[0] || null;

        // Fallbacks: if no OTM wall on one side, use the nearest strike on that side
        // that still has OI; otherwise the synthetic round5 level kicks in below.
        if (!topCeWall) {
            topCeWall = [...chain].filter((s) => s.strike > spot && s.ce?.oi > 0).sort((a, b) => a.strike - b.strike)[0] || null;
        }
        if (!topPeWall) {
            topPeWall = [...chain].filter((s) => s.strike < spot && s.pe?.oi > 0).sort((a, b) => b.strike - a.strike)[0] || null;
        }

        const resistance = topCeWall?.strike || round5(spot + cfg.tightRange);
        const support = topPeWall?.strike || round5(spot - cfg.tightRange);
        const rangeWidth = resistance - support;

        // Guard: never fire directional setups inside a degenerate/too-tight range
        const rangeValid = rangeWidth >= cfg.minRange;

        // Per-side OI distributions, so a wall is scored against its own chain
        // rather than a fixed divisor.
        const ceOis = chain.map((x) => x.ce?.oi).filter((v) => Number.isFinite(v) && v > 0);
        const peOis = chain.map((x) => x.pe?.oi).filter((v) => Number.isFinite(v) && v > 0);
        const allOis = [...ceOis, ...peOis];

        const spotPct = rangeWidth > 0
            ? Math.round(((spot - support) / rangeWidth) * 100)
            : 50;

        // Live India VIX, fetched once and shared by every setup on this card.
        // null is passed through deliberately: calcConfidence drops the term
        // rather than substituting a number, which is what `vix: 13` was doing.
        const vix = await fetchIndiaVix();
        // Time to expiry drives delta, and delta decides whether an 8-point
        // premium target is reachable at all. Null on an unparsable expiry —
        // the strike scorer then falls back to distance-from-ATM.
        const years = expiryYears(snap.expiry);

        // ── Auction Market Theory, on REAL intraday bars ────────────────────
        //
        // POC/VAH/VAL/VWAP describe where the market transacted over time, so they
        // need session candles. These were previously fed option-chain rows dressed
        // as candles (`{ close: strike, volume: OI }`), which measures where options
        // are HELD rather than where price traded: the "VWAP" was really the
        // OI-weighted average strike, and it shared its input with the profile, so
        // the confluence score was counting one signal twice.
        //
        // Best-effort by design — /scalp must still produce setups when Yahoo is
        // unreachable, so these stay null and their card sections are omitted
        // rather than failing the card.
        let vp = null;
        let vwapData = null;
        let vwapInfo = null;
        let amtRegime = null;
        let absorption = null;
        let profileMeta = null;
        let realisedRange = null;
        try {
            const session = await fetchIndexSessionBars({ index: cfg.yahoo, volumeProxy: cfg.volumeProxy });
            if (session?.bars?.length >= 10) {
                profileMeta = {
                    sessionDate: session.sessionDate,
                    volumeSource: session.volumeSource,
                    barCount: session.barCount,
                };
                vp = buildVolumeProfile(session.bars, cfg.vpTick);
                vwapData = calcSessionVWAP(session.bars);
                vwapInfo = vwapData ? vwapLevels(vwapData, spot) : null;
                amtRegime = vp ? auctionRegime(spot, vp) : null;
                absorption = detectBarAbsorption(session.bars);
                // Realised 5m movement — what a directional scalp actually needs.
                realisedRange = medianBarRange(session.bars);
            }
        } catch (err) {
            logger.debug(`Scalp AMT layer unavailable: ${err.message}`);
        }

        const regime = detectRegime({
            spot, maxPainVal: mpVal, rangeWidth, vix: vix ?? 13, pcr: pcr || 1, cfg,
        });

        // ── Confluence Score (combines all indicators) ─────────────────────
        const confScore = confluenceScore(vp, vwapInfo, {
            pcr: pcr || 1,
            oiWall: Math.max(topCeWall?.ce?.oi || 0, topPeWall?.pe?.oi || 0),
            regime,
            spotDistance: Math.min(Math.abs(spot - support), Math.abs(spot - resistance)),
        });

        // ── Confidence gates ─────────────────────────────────────────────────
        //
        // 70, not 75, and the reason is calibration rather than taste.
        //
        // The 75 line was set when two of the five inputs were constants pinned
        // at their maximum: oiScore returned 100 for every real wall, and VIX was
        // hardcoded to 13. Together they contributed a fixed ~35 points to every
        // score. Replacing them with live values (wall dominance vs its
        // neighbours, realised 5m movement) removed that floor and shifted the
        // whole distribution down ~10-15 points — but the gate stayed put, so the
        // filter silently became about twice as strict as it had ever been.
        //
        // Measured over 3,456 realistic input combinations:
        //   old scoring, gate 75 -> 27.7% of conditions passed
        //   new scoring, gate 75 -> 15.1%
        //   new scoring, gate 70 -> 27.8%   <- same selectivity, honest inputs
        // New-scoring distribution: max 90, p90 77, median 63.
        //
        // This restores the alert frequency the bot always had; it does not lower
        // the bar. Nothing here has a measured win rate yet — outcome logging
        // began 2026-09-04 — so preserving prior selectivity is the only
        // defensible anchor until the data can speak.
        const MIN_CONF = Number(process.env.SCALP_MIN_CONF || 70);
        const MIN_CONF_THETA = Number(process.env.SCALP_MIN_CONF_THETA || 70);
        // Per index: SENSEX's lot of 20 makes NIFTY's 8pt target smaller than
        // its own round-trip cost. See src/data/scalpIndexConfig.js.
        const TARGET_PTS = cfg.targetPts;
        const STOP_PTS = cfg.stopPts;
        const setups = [];

        // ── Directional bias: mean reversion at the OI walls ─────────────────
        //
        // The walls ARE the thesis of /scalp — a big CE wall is where the move is
        // expected to stall, a big PE wall is where it is expected to hold. So the
        // direction follows position in the range: near support buy CE, near
        // resistance buy PE. Nothing else decides it.
        //
        // What this replaces was two opposite strategies fighting. The block below
        // is named "Support bounce" (mean reversion: buy CE when price is LOW in
        // the range) while the old bias was VWAP trend-following (buy PE when
        // price is BELOW VWAP). Near support price is usually below VWAP, so the
        // mean-reversion half lost every time. Measured over the full input space:
        //   BUY PE fired in 40% of it, BUY CE in 4% — a 10:1 skew to puts
        //   spotPct 0-40 could fire NOTHING, because `spotPct < 45` forced
        //     preferPE while the PE leg demanded proximity to resistance
        //   BUY CE could only fire at spotPct 45-59, the MIDDLE of the range,
        //     never at the support it is named for
        // The skew came from the OR-chain: the bearish branch was tested first, so
        // a bearish signal overrode a bullish VWAP but never the reverse.
        //
        // nearZone is what "at the level" means, sized from how far this index
        // actually travels in a bar rather than as a share of the range. The old
        // `rangeWidth * 0.6` fired up to 300 points from support on a 500-point
        // range while the card said "Spot touches 23,800".
        const nearZone = realisedRange > 0
            ? Math.min(rangeWidth * 0.25, Math.max(rangeWidth * 0.06, realisedRange * 2.5))
            : rangeWidth * 0.15;

        const distToSupport = spot - support;
        const distToResistance = resistance - spot;
        // Negative means the level is already gone — that is a breakout, and the
        // breakout setup below handles it. Fading a broken level is not this trade.
        let preferCE = distToSupport >= 0 && distToSupport <= nearZone;
        let preferPE = distToResistance >= 0 && distToResistance <= nearZone;

        // A range tight enough to sit at both walls: take the nearer one, and let
        // VWAP break an exact tie. Symmetric by construction — neither side is
        // privileged by the order of the checks.
        if (preferCE && preferPE) {
            if (distToSupport < distToResistance) preferPE = false;
            else if (distToResistance < distToSupport) preferCE = false;
            else if (vwapData) {
                if (spot < vwapData.vwap) preferCE = false;
                else preferPE = false;
            } else preferPE = false;
        }
        // Mid-range: no level in play, so no directional trade. Waiting is correct.

        // 1) Support bounce — Buy CE at the PE wall
        // Proximity is already decided by nearZone above; re-testing it here with
        // a different rule is what let the two disagree in the first place.
        if (preferCE && rangeValid) {
            const bestCe = findBestStrike(chain, support, 'CE', spot, atmStrike, cfg, years);
            // Index points this strike needs to pay the premium target — the
            // number the movement fit is scored against.
            const ceNeedMove = bestCe ? requiredIndexMove({
                side: 'CE', spot, strike: bestCe.strike,
                iv: (findStrikeLeg({ strikes }, bestCe.strike, 'CE')?.iv || 0) / 100,
                years, targetPts: cfg.targetPts,
            }) : null;
            // Only use strike from findBestStrike (no ATM fallback — it picks ITM)
            const entryPrem = bestCe?.ltp ? round2(bestCe.ltp) : null;
            if (entryPrem && entryPrem >= 15 && entryPrem <= 200) {
                const target = round2(entryPrem + TARGET_PTS);
                const stop = round2(entryPrem - STOP_PTS);
                const conf = calcConfidence({
                    oiWallQty: topPeWall?.pe?.oi || 0,
                    sameSideOis: peOis, pcr: pcr || 1, vix, cfg,
                    fitScore: movementFit(realisedRange, ceNeedMove),
                    spotDistance: distToSupport, nearZone, regime: 'directional',
                });
                if (conf >= MIN_CONF) {
                    setups.push({
                    type: 'BUY CE', emoji: '\uD83D\uDFE2',
                    rank: 'primary',
                    strike: bestCe.strike,
                    optionType: 'CE',
                    momentumScore: bestCe.score || 0,
                    needMove: ceNeedMove,
                    trigger: `Spot at ${fmtNum(support)} support (within ${Math.round(nearZone)} pts)`,
                    entry: entryPrem, target, stop, speed: '2-5 min',
                    confidence: conf,
                    why: `PE OI wall ${formatOi(topPeWall?.pe?.oi)} at ${fmtNum(support)} · Strike ${fmtNum(bestCe.strike)} CE ₹${entryPrem}`,
                    topPick: conf >= 80,
                    });
                }
            }
        }

        // 2) Resistance rejection — Buy PE (cheap OTM strike near resistance)
        // 2) Resistance rejection — Buy PE at the CE wall
        if (preferPE && rangeValid) {
            const bestPe = findBestStrike(chain, resistance, 'PE', spot, atmStrike, cfg, years);
            const peNeedMove = bestPe ? requiredIndexMove({
                side: 'PE', spot, strike: bestPe.strike,
                iv: (findStrikeLeg({ strikes }, bestPe.strike, 'PE')?.iv || 0) / 100,
                years, targetPts: cfg.targetPts,
            }) : null;
            // Only use strike from findBestStrike (no ATM fallback — it picks ITM)
            const entryPrem = bestPe?.ltp ? round2(bestPe.ltp) : null;
            if (entryPrem && entryPrem >= 15 && entryPrem <= 200) {
                const target = round2(entryPrem + TARGET_PTS);
                const stop = round2(entryPrem - STOP_PTS);
                const conf = calcConfidence({
                    oiWallQty: topCeWall?.ce?.oi || 0,
                    sameSideOis: ceOis, pcr: pcr || 1, vix, cfg,
                    fitScore: movementFit(realisedRange, peNeedMove),
                    spotDistance: distToResistance, nearZone, regime: 'directional',
                });
                if (conf >= MIN_CONF) {
                    setups.push({
                    type: 'BUY PE', emoji: '\uD83D\uDD34',
                    rank: 'primary',
                    strike: bestPe.strike,
                    optionType: 'PE',
                    momentumScore: bestPe.score || 0,
                    needMove: peNeedMove,
                    trigger: `Spot at ${fmtNum(resistance)} resistance (within ${Math.round(nearZone)} pts)`,
                    entry: entryPrem, target, stop, speed: '2-5 min',
                    confidence: conf,
                    why: `CE OI wall ${formatOi(topCeWall?.ce?.oi)} at ${fmtNum(resistance)} · Strike ${fmtNum(bestPe.strike)} PE ₹${entryPrem}`,
                    topPick: conf >= 80,
                    });
                }
            }
        }

        // 3) & 4) Short Straddle / Strangle.
        //
        // These were removed citing a backtest showing 47%/38% win rates. That
        // backtest priced a straddle as CALL + CALL — its pricer only ever returned
        // a call value, and its "mirror strike" 2*atm - atm is just atm — and it
        // pinned T at 1/365 at both entry and exit, so there was no theta decay at
        // all. That deletes the only profit source a short-premium setup has. The
        // numbers measured a bug, not these setups, so they are restored here.
        // If they should go, cut them on real option data.

        // 3) Short Straddle
        if (spotPct >= 30 && spotPct <= 70) {
            const straddle = round2((atmCe?.ltp || 0) + (atmPe?.ltp || 0));
            if (straddle > 50) {
                const target = round2(straddle - cfg.straddleTargetPts);
                const stop = round2(straddle + cfg.straddleStopPts);
                const conf = calcConfidence({
                    oiWallQty: Math.max(topCeWall?.ce?.oi || 0, topPeWall?.pe?.oi || 0),
                    sameSideOis: allOis,
                    pcr: pcr || 1, vix, cfg,
                    spotDistance: Math.min(spot - support, resistance - spot),
                    regime: 'theta',
                });
                if (conf >= MIN_CONF_THETA) {
                    setups.push({
                    type: 'SHORT STRADDLE', emoji: '⚡',
                    rank: 'secondary',
                    strike: atmStrike,
                    legs: [
                        { action: 'SELL', optionType: 'CE', strike: atmStrike, price: atmCe?.ltp || 0 },
                        { action: 'SELL', optionType: 'PE', strike: atmStrike, price: atmPe?.ltp || 0 },
                    ],
                    trigger: `Spot mid-range (${spotPct}%)`,
                    entry: straddle, target, stop, speed: '5-15 min',
                    confidence: conf,
                    why: `ATM straddle ₹${straddle}, theta decay working`,
                    topPick: regime === 'low_vol' && conf >= 80,
                    });
                }
            }
        }

        // 4) Short Strangle
        if (spotPct >= 25 && spotPct <= 75 && rangeWidth >= cfg.tightRange) {
            const wingStep = Math.max(50, round5(rangeWidth / 4));
            // Snap to strikes the chain actually lists — see nearestStrike().
            const otmCeStrike = nearestStrike(chain, atmStrike + wingStep);
            const otmPeStrike = nearestStrike(chain, atmStrike - wingStep);
            const otmCe = findStrikeLeg({ strikes }, otmCeStrike, 'CE');
            const otmPe = findStrikeLeg({ strikes }, otmPeStrike, 'PE');
            const strangle = round2((otmCe?.ltp || 0) + (otmPe?.ltp || 0));
            if (strangle > 20) {
                const floor = cfg.strangleFloorPts;
                const target = round2(strangle - Math.max(floor, Math.round(strangle * 0.2)));
                const stop = round2(strangle + Math.max(Math.round(floor * 0.8), Math.round(strangle * 0.2)));
                const conf = calcConfidence({
                    oiWallQty: Math.max(topCeWall?.ce?.oi || 0, topPeWall?.pe?.oi || 0),
                    sameSideOis: allOis,
                    pcr: pcr || 1, vix, cfg,
                    spotDistance: Math.min(spot - support, resistance - spot),
                    regime: 'theta',
                });
                if (conf >= MIN_CONF_THETA) {
                    setups.push({
                    type: 'SHORT STRANGLE', emoji: '🪁',
                    rank: 'secondary',
                    legs: [
                        { action: 'SELL', optionType: 'CE', strike: otmCeStrike, price: otmCe?.ltp || 0 },
                        { action: 'SELL', optionType: 'PE', strike: otmPeStrike, price: otmPe?.ltp || 0 },
                    ],
                    trigger: `Sell ${fmtNum(otmCeStrike)} CE + ${fmtNum(otmPeStrike)} PE`,
                    entry: strangle, target, stop, speed: '10-30 min',
                    confidence: conf,
                    why: `OTM wings collect ₹${strangle}, both legs safe`,
                    topPick: false,
                    });
                }
            }
        }

        // 5) Breakout/Breakdown scalp
        if (regime === 'trending') {
            const bullBreak = spot > resistance;
            const bearBreak = spot < support;
            if (bullBreak || bearBreak) {
                const leg = findStrikeLeg({ strikes }, atmStrike, bullBreak ? 'CE' : 'PE');
                const entryPrem = round2(leg?.ltp || (bullBreak ? atmCe?.ltp : atmPe?.ltp));
                if (entryPrem && entryPrem > 10) {
                    const target = round2(entryPrem + TARGET_PTS);
                    const stop = round2(entryPrem - STOP_PTS);
                    const conf = calcConfidence({
                        oiWallQty: bullBreak ? topCeWall?.ce?.oi || 0 : topPeWall?.pe?.oi || 0,
                        sameSideOis: bullBreak ? ceOis : peOis,
                        pcr: pcr || 1, vix, cfg,
                        fitScore: movementFit(realisedRange, cfg.targetPts / 0.5),
                        // A breakout enters just beyond the wall, so it is by
                        // definition at the near edge of the zone.
                        spotDistance: cfg.strikeStep * 0.4, regime: 'directional',
                    });
                    if (conf >= MIN_CONF) {
                        setups.push({
                        type: bullBreak ? 'BREAKOUT CE' : 'BREAKDOWN PE',
                        emoji: bullBreak ? '\uD83D\uDE80' : '\uD83E\uDE79',
                        rank: 'secondary',
                        trigger: `Spot broke ${bullBreak ? 'above resistance' : 'below support'} ${fmtNum(bullBreak ? resistance : support)}`,
                        entry: entryPrem, target, stop, speed: '1-3 min',
                        confidence: conf,
                        why: 'Spot beyond the wall \u2014 momentum trade, exit fast',
                        topPick: conf >= 80,
                        });
                    }
                }
            }
        }

        setups.sort((a, b) => {
            if (a.topPick && !b.topPick) return -1;
            if (!a.topPick && b.topPick) return 1;
            return b.confidence - a.confidence;
        });

        const primarySetups = setups.filter(s => s.rank === 'primary' && s.optionType);
        const strikeTables = {};
        for (const ps of primarySetups) {
            const topN = getTopStrikes(chain, ps.optionType, spot, atmStrike, 4, cfg, years);
            if (topN.length) strikeTables[ps.optionType] = topN;
        }

        const card = this._formatCard({
            spot, pcr, mpVal, resistance, support, rangeWidth, spotPct,
            atmStrike, atmCe, atmPe, topCeWall, topPeWall, regime, setups,
            strikeTables, vp, vwapData, vwapInfo, amtRegime,
            absorption, profileMeta, confScore, cfg, snapshot: snap,
            minConf: Math.min(MIN_CONF, MIN_CONF_THETA),
        });

        // The trigger zone widths ride with the card so watchers can alert when
        // spot enters exactly the band the primary setups would consider.
        return { card, support, resistance, nearZone };
    }

    _formatCard({ spot, pcr, mpVal, resistance, support, rangeWidth, spotPct, atmStrike, atmCe, atmPe, topCeWall, topPeWall, regime, setups, strikeTables, vp, vwapData, vwapInfo, amtRegime, absorption, profileMeta, confScore, cfg = SCALP_INDICES.NIFTY, snapshot, minConf = 70 }) {
        const L = [];
        const { hour, minute } = istTime();
        const timeLabel = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
        const dateLabel = istDateLabel();

        const regimeBadge = {
            low_vol: '\u26A0\uFE0F LOW VOL',
            trending: '\uD83D\uDD25 TRENDING',
            normal: '\uD83D\uDCCA NORMAL',
        }[regime] || '\uD83D\uDCCA NORMAL';

        const ladder = buildPriceLadder({ spot, resistance, support, mpVal, atmStrike, atmCe, atmPe, topCeWall, topPeWall });

        L.push('\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557');
        const title = `\u26A1 /scalp \u00B7 ${cfg.label} MICRO SCALP`;
        L.push('\u2551  ' + title.padEnd(33) + '\u2551');
        L.push('\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D');
        L.push('');
        L.push(`\uD83D\uDCC5 ${dateLabel} \u00B7 ${timeLabel} IST`);
        L.push(`\uD83D\uDCCD Spot: ${fmtNum(spot)} \u00B7 ${regimeBadge}`);
        L.push('');

        // ── YOUR MOVE — the one-line directive ─────────────────────────────
        // The analysis sections describe the market; this block states what to
        // actually do. When a setup cleared its gate, that setup IS the directive
        // (top pick first, else best primary, else any). When nothing fired, the
        // directive is "do nothing" plus the exact levels that would change the
        // answer — so the card always answers "buy CE or PE?" in one glance.
        const actionSetup =
            setups.find((s) => s.topPick) ||
            setups.find((s) => s.rank === 'primary') ||
            setups[0];
        if (actionSetup) {
            const isShort = actionSetup.type.startsWith('SHORT');
            const strikeLabel = actionSetup.strike && actionSetup.optionType
                ? `${actionSetup.optionType} ${fmtNum(actionSetup.strike)}`
                : '';
            const actionTxt = isShort
                ? `SELL ${actionSetup.type.replace('SHORT ', '')}`
                : `${actionSetup.type}${strikeLabel ? ` ${strikeLabel}` : ''}`;
            L.push(`👉 *YOUR MOVE: ${actionTxt}*${actionSetup.topPick ? ' ⭐ TOP PICK' : ''}`);
            if (isShort) {
                L.push(`   Collect \u20B9${actionSetup.entry} \u00B7 buyback TGT \u20B9${actionSetup.target} \u00B7 SL \u20B9${actionSetup.stop}`);
            } else {
                L.push(`   Entry \u20B9${actionSetup.entry} \u00B7 SL \u20B9${actionSetup.stop} \u00B7 TGT \u20B9${actionSetup.target}`);
            }
            if (actionSetup.trigger) L.push(`   ${actionSetup.trigger}`);
        } else {
            L.push('👉 *YOUR MOVE: NO TRADE \u2014 do nothing yet*');
            L.push(`   \uD83D\uDFE2 If spot hits ${fmtNum(support)} (support) \u2192 BUY CE setup fires`);
            L.push(`   \uD83D\uDD34 If spot hits ${fmtNum(resistance)} (resistance) \u2192 BUY PE setup fires`);
            if (regime === 'trending') {
                L.push(`   \uD83D\uDE80 If spot breaks ${fmtNum(resistance)} \u2192 BREAKOUT setup fires`);
            }
        }
        L.push('');
        L.push('\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501');
        L.push('');
        L.push('\uD83D\uDCCA *SCALP MAP*');
        L.push('');
        for (const row of ladder) {
            L.push(row);
        }
        L.push('');
        L.push(`  Max Pain: ${fmtNum(mpVal)} \u00B7 Range: ${rangeWidth} pts`);
        L.push('');
        L.push('\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501');
        L.push('');

        // ── Volume Profile Section ────────────────────────────────────────
        if (vp) {
            const vpBias = amtRegime?.regime === 'buy_zone' ? '\uD83D\uDFE2 BUY ZONE' 
                : amtRegime?.regime === 'sell_zone' ? '\uD83D\uDD34 SELL ZONE' 
                : amtRegime?.regime === 'balanced' ? '\u26A1 BALANCED' 
                : amtRegime?.regime === 'breakout' ? '\uD83D\uDE80 OUT OF VALUE'
                : '\u2753 UNKNOWN';
            // Name the construction. With ETF volume this is a volume profile;
            // without it buildVolumeProfile weights every bar equally, which is a
            // time-at-price (TPO) profile \u2014 related, but not the same thing.
            const kind = profileMeta?.volumeSource === 'etf-proxy' ? 'volume' : 'time-at-price';
            L.push(`\uD83D\uDCCA *AUCTION MARKET THEORY* (${kind})`);
            L.push('');
            L.push(`  POC: ${fmtNum(vp.poc)}  VAH: ${fmtNum(vp.vah)}  VAL: ${fmtNum(vp.val)}`);
            // Gap to the value area itself. The old card printed the distance from
            // VWAP under a "vs VA" label, which is a different measurement.
            const vaGap = spot > vp.vah ? spot - vp.vah : spot < vp.val ? spot - vp.val : 0;
            const vaTxt = vaGap === 0
                ? 'inside value'
                : `${vaGap > 0 ? '+' : ''}${fmtNum(round2(vaGap))} pts`;
            L.push(`  Spot vs VA: ${vaTxt} ${vpBias}`);
            if (vp.lvns && vp.lvns.length > 0) {
                const lvnStr = vp.lvns.slice(0, 3).map(l => `${fmtNum(l.low)}-${fmtNum(l.high)}`).join(', ');
                L.push(`  LVN zones: ${lvnStr}`);
            }
            L.push('');
        }

        // ── VWAP Section ──────────────────────────────────────────────────
        // Printed only when real volume backed it. Without volume every bar
        // weighs the same, making this a mean of typical prices rather than a
        // VWAP — printing that under this heading would be a false label.
        if (vwapInfo && profileMeta?.volumeSource === 'etf-proxy') {
            L.push('\uD83D\uDCCA *VWAP DYNAMIC S/R*');
            L.push('');
            L.push(`  VWAP: ${fmtNum(vwapInfo.vwap)}  \u00B11\u03C3: ${fmtNum(vwapData.lower1)}-${fmtNum(vwapData.upper1)}`);
            L.push(`  \u00B12\u03C3: ${fmtNum(vwapData.lowerBand)}-${fmtNum(vwapData.upperBand)}  Bias: ${vwapInfo.bias}`);
            L.push('');
        }

        // ── Absorption Detection ──────────────────────────────────────────
        if (absorption?.isAbsorbing) {
            const who = absorption.side === 'buyers'
                ? 'buyers absorbing the selling'
                : absorption.side === 'sellers'
                    ? 'sellers capping the buying'
                    : 'two-sided, no clear winner';
            L.push('\uD83D\uDD0D *ABSORPTION DETECTED*');
            L.push('');
            L.push(`  ${fmtNum(absorption.level)} \u00B7 score ${absorption.score} \u2014 ${who}`);
            L.push(`  ${absorption.volRatio}\u00D7 volume on ${absorption.rangeRatio}\u00D7 range`);
            L.push('');
        }

        // ── Confluence Score ───────────────────────────────────────────────
        if (confScore) {
            const confFacts = confScore.factors.map(f => `${f.name} ${f.score}`).join(' \u00B7 ');
            L.push(`\u2B50 *CONFLUENCE: ${confScore.score}/100* \u2014 ${confFacts}`);
            L.push('');
        }

        L.push('\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501');
        L.push('');

        L.push('\uD83D\uDC8E *PREMIUM LIVE*');
        L.push('');
        L.push('\u250C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510');
        if (atmCe) {
            L.push(`\u2502 CE ${fmtNum(atmStrike)} \u2502 \u20B9${atmCe.ltp ?? '\u2013'} \u2502 LTP`);
        }
        if (atmPe) {
            L.push(`\u2502 PE ${fmtNum(atmStrike)} \u2502 \u20B9${atmPe.ltp ?? '\u2013'} \u2502 LTP`);
        }
        const straddle = round2((atmCe?.ltp || 0) + (atmPe?.ltp || 0));
        if (straddle > 0) {
            L.push(`\u2502 Straddle  \u2502 \u20B9${straddle} \u2502 Total`);
        }
        L.push('\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518');
        L.push('');
        L.push('\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501');
        L.push('');

        if (setups.length) {
            const primary = setups.filter((s) => s.rank === 'primary');
            const secondary = setups.filter((s) => s.rank !== 'primary');

            if (primary.length) {
                L.push(`\uD83C\uDFAF *\uD83D\uDD35 PRIMARY \u00B7 Best for ${cfg.targetPts}pt scalps*`);
                L.push('');
                for (const s of primary) {
                    const pick = s.topPick ? ' \u2B50 TOP PICK' : '';
                    const strikeLabel = s.strike && s.optionType ? `Buy ${s.optionType} ${fmtNum(s.strike)}` : '';
                    L.push(`*${s.emoji} ${s.type}${pick}*`);
                    if (strikeLabel) L.push(`  ${strikeLabel}`);
                    if (s.trigger) L.push(`  Trigger: ${s.trigger}`);
                    L.push(`  Entry: \u20B9${s.entry} \u00B7 Target: \u20B9${s.target} \u00B7 Stop: \u20B9${s.stop}`);
                    L.push(`  Conf: ${s.confidence}% ${confBar(s.confidence)} ${confLabel(s.confidence)}`);
                    if (s.momentumScore) L.push(`  Momentum: ${s.momentumScore}/100`);
                    if (Number.isFinite(s.needMove)) {
                        const warn = s.needMove > cfg.maxMove ? ' ⚠️ far'
                            : s.needMove > cfg.reachMove ? ' · stretched' : '';
                        L.push(`  Needs ~${Math.round(s.needMove)} index pts for +${cfg.targetPts}${warn}`);
                    }
                    if (s.why) L.push(`  \uD83D\uDCCA ${s.why}`);
                    L.push('');
                }

                // Strike comparison table
                for (const side of ['CE', 'PE']) {
                    const tbl = strikeTables?.[side];
                    if (!tbl?.length) continue;
                    const best = tbl[0];
                    L.push(`\uD83C\uDFB2 *WHY ${side} ${fmtNum(best.strike)}?*`);
                    L.push('');
                    for (let i = 0; i < tbl.length; i++) {
                        const r = tbl[i];
                        const isBest = i === 0;
                        const star = isBest ? ' \u2B50' : '';
                        L.push(`  ${fmtNum(r.strike)} \u2524 \u20B9${r.ltp} \u2502 IV ${r.iv.toFixed(1)}% \u2502 OI ${formatOi(r.oi)}`);
                        const barLen = Math.round(r.score / 5);
                        const bar = '\u2588'.repeat(barLen) + '\u2591'.repeat(20 - barLen);
                        L.push(`         \u2502 ${bar} ${r.score}/100${star}`);
                        if (i < tbl.length - 1) L.push('  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
                    }
                    const reasons = [];
                    if (best.iv >= 6) reasons.push(`IV ${best.iv.toFixed(1)}%`);
                    if (best.oi >= 100000) reasons.push(`OI ${formatOi(best.oi)}`);
                    const distFromAtm = Math.abs(best.strike - atmStrike);
                    if (distFromAtm <= 50) reasons.push('Near ATM');
                    else if (distFromAtm <= 100) reasons.push('Moderate delta');
                    L.push(`  \uD83D\uDCA1 Best pick: ${fmtNum(best.strike)} (${reasons.join(' + ') || 'Best score'})`);
                    L.push('');
                }
            }

            if (secondary.length) {
                L.push('\u26A1 *\uD83D\uDFE3 SECONDARY \u00B7 Theta & Momentum*');
                L.push('');
                for (const s of secondary) {
                    const pick = s.topPick ? ' \u2B50' : '';
                    const isShort = s.type.startsWith('SHORT');
                    L.push(`*${s.emoji} ${s.type}${pick}*`);
                    if (s.trigger) L.push(`  Trigger: ${s.trigger}`);
                    if (isShort && s.legs && s.legs.length) {
                        for (const leg of s.legs) {
                            L.push(`  ${leg.action} ${fmtNum(leg.strike)} ${leg.optionType} \u20B9${round2(leg.price)}`);
                        }
                        const profit = round2(s.entry - s.target);
                        const loss = round2(s.stop - s.entry);
                        L.push(`  Entry: \u20B9${s.entry} (collect) \u2192 Target: \u20B9${s.target} (buy back) \u00B7 +\u20B9${profit}`);
                        L.push(`  Stop: \u20B9${s.stop} (buy back) \u00B7 \u2212\u20B9${loss}`);
                    } else if (isShort) {
                        L.push(`  Entry: \u20B9${s.entry} (collect) \u2192 Target: \u20B9${s.target} (buy back)`);
                        L.push(`  Stop: \u20B9${s.stop} (buy back)`);
                    } else {
                        L.push(`  Entry: \u20B9${s.entry} \u00B7 Target: \u20B9${s.target} \u00B7 Stop: \u20B9${s.stop}`);
                    }
                    L.push(`  Conf: ${s.confidence}% ${confBar(s.confidence)} ${confLabel(s.confidence)}`);
                    L.push('');
                }
            }
        }
        if (setups.length === 0) {
            L.push('\u26A0\uFE0F *NO CLEAR SETUP NOW*');
            L.push('  Spot is mid-range \u2014 wait for trigger');
            L.push('');
        }

        L.push('\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501');
        L.push('');

        const hasPrimary = setups.some((s) => s.rank === 'primary');
        if (!hasPrimary && spotPct >= 30 && spotPct <= 70) {
            L.push('\u26A0\uFE0F *WAIT FOR SPOT TO HIT SUPPORT OR RESISTANCE*');
            L.push('  Primary scalp setups trigger near OI walls');
            L.push('');
        }

        const isLowVol = regime === 'low_vol';
        const isTrending = regime === 'trending';
        L.push('\u26A1 *SCALP RULES*');
        L.push(`  \uD83C\uDFAF +${cfg.targetPts} pt target \u00B7 \uD83D\uDED1 \u2212${cfg.stopPts} pt stop`);
        // Quoted per index. On a SENSEX lot of 20 the same rupee cost is ~12.8
        // points, so NIFTY's "3.4 pts" would understate SENSEX cost by ~4x and
        // make an 8pt target look profitable when fees alone would exceed it.
        const net = netPoints(cfg);
        L.push(`  \uD83D\uDCCA Fees: ~${cfg.feePts} pts \u00B7 Net: +${net.win} pts win / \u2212${net.loss} pts loss`);
        L.push(`  \uD83D\uDCCF Lot ${cfg.lot} \u00B7 target +${cfg.targetPts} \u00B7 stop \u2212${cfg.stopPts}`);
        L.push(`  \u2705 Only ${minConf}%+ confidence setups shown`);
        L.push(`  \u23F0 2-5 min hold \u00B7 \uD83D\uDCE6 ${isLowVol ? '1 lot' : '2-3 lots'}`);
        L.push(`  \u25BB Max ${isLowVol ? '3' : '4'} trades/day`);
        if (isLowVol) L.push('  \u26A0\uFE0F Low vol \u2014 tighter stops, faster exits');
        if (isTrending) L.push('  \u26A0\uFE0F Trending \u2014 only trade in trend direction');
        L.push('  \u274C Skip if range < 50 pts');
        L.push('');
        L.push('\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501');
        L.push('');
        L.push('\uD83D\uDD04 _Refresh: /scalp_');

        return L.join('\n');
    }
}

// ── Formatting helpers ─────────────────────────────────────────────────────

function fmtNum(n) {
    if (n == null || !Number.isFinite(n)) return '\u2013';
    return Number(n).toLocaleString('en-IN');
}

function formatOi(oi) {
    if (!oi) return '0';
    if (oi >= 10000000) return `${(oi / 10000000).toFixed(1)}Cr`;
    if (oi >= 100000) return `${(oi / 100000).toFixed(1)}L`;
    if (oi >= 1000) return `${(oi / 1000).toFixed(1)}K`;
    return String(oi);
}

/**
 * Build a TradingView-style price ladder.
 * Always includes: CE OI wall (+RESISTANCE), PE OI wall (+SUPPORT),
 * ATM, YOU, MAX PAIN.  Ladder extends at most 1 step beyond the
 * outermost key level so blank rows don't dominate.
 */
function buildPriceLadder({ spot, resistance, support, mpVal, atmStrike, atmCe, atmPe, topCeWall, topPeWall }) {
    const rows = [];
    const pad = (s, len) => String(s).padStart(len);

    // 1. Collect key levels (deduplicated)
    const keySet = new Set();
    const addKey = (v) => { if (v != null && Number.isFinite(v)) keySet.add(v); };

    addKey(topCeWall?.strike);
    addKey(topPeWall?.strike);
    addKey(resistance);
    addKey(support);
    addKey(atmStrike);
    addKey(mpVal);
    addKey(Math.round(spot));

    const keyArr = [...keySet].sort((a, b) => b - a);
    const rangeHigh = Math.max(...keyArr);
    const rangeLow  = Math.min(...keyArr);
    const range = rangeHigh - rangeLow || 100;
    const step = Math.max(10, Math.round(range / 8 / 5) * 5);

    // 2. Cap max pain / outermost key to 1 step beyond the visible wall range
    //    so the ladder doesn't stretch to 23,750 when spot is 24,300.
    const wallHigh = Math.max(topCeWall?.strike || resistance, resistance);
    const wallLow  = Math.min(topPeWall?.strike || support, support);
    const cappedHigh = wallHigh + step;
    const cappedLow  = wallLow - step;

    const allLevels = new Set();
    // Add key levels only if within capped range
    for (const k of keySet) {
        if (k >= cappedLow && k <= cappedHigh) allLevels.add(k);
    }
    // Always include spot itself
    const spotRound = Math.round(spot);
    if (spotRound >= cappedLow && spotRound <= cappedHigh) allLevels.add(spotRound);

    // Fill between with step lines
    for (let p = cappedHigh; p >= cappedLow; p -= step) allLevels.add(p);
    const levels = [...allLevels].sort((a, b) => b - a);

    // 3. Nearest level to spot for YOU marker
    const nearestToSpot = levels.reduce((best, v) =>
        Math.abs(v - spot) < Math.abs(best - spot) ? v : best, levels[0]);

    // 4. Premium strings
    const ce = atmCe?.ltp != null ? 'CE \u20B9' + atmCe.ltp : '';
    const pe = atmPe?.ltp != null ? 'PE \u20B9' + atmPe.ltp : '';
    const premStr = ce && pe ? ce + ' / ' + pe : ce || pe || '';

    const oiWall = (wall, side) => {
        const label = side === 'CE' ? 'CE OI WALL' : 'PE OI WALL';
        const zone  = side === 'CE' ? 'SELL ZONE'  : 'BUY ZONE';
        const isAlsoResist = side === 'CE' && wall?.strike === resistance;
        const isAlsoSup    = side === 'PE' && wall?.strike === support;
        let extra = '';
        if (isAlsoResist) extra = ' \u00B7 RESISTANCE';
        if (isAlsoSup)    extra = ' \u00B7 SUPPORT';
        // Read the leg this wall IS. `wall?.ce?.oi || wall?.pe?.oi` took CE first,
        // so the PE wall printed the CE open interest sitting at that strike \u2014
        // wrong on every chain where the strike has both legs, which is all of them.
        const oi = side === 'CE' ? wall?.ce?.oi : wall?.pe?.oi;
        return `\u2593\u2593\u2593 ${label} (${formatOi(oi)}) \u2190 ${zone}${extra}`;
    };

    // 5. Render rows
    for (const price of levels) {
        const p = pad(fmtNum(price), 8);
        const isCeWall = topCeWall?.strike === price;
        const isPeWall = topPeWall?.strike === price;
        const isSpot   = price === nearestToSpot;
        const isAtm    = price === atmStrike && !isSpot;
        const isMp     = price === mpVal && !isSpot && !isAtm;

        let line;
        if (isCeWall) {
            line = p + ' \u2524 ' + oiWall(topCeWall, 'CE');
        } else if (isPeWall) {
            line = p + ' \u2524 ' + oiWall(topPeWall, 'PE');
        } else if (price === resistance && !isCeWall) {
            line = p + ' \u2524 \u2591\u2591\u2591 \u00B7\u00B7\u00B7\u00B7\u00B7RESISTANCE\u00B7\u00B7\u00B7\u00B7\u00B7';
        } else if (price === support && !isPeWall) {
            line = p + ' \u2524 \u2591\u2591\u2591 \u00B7\u00B7\u00B7\u00B7\u00B7\u00B7SUPPORT\u00B7\u00B7\u00B7\u00B7\u00B7\u00B7';
        } else if (isAtm) {
            line = p + ' \u2524 \u2500\u2500\u2500 ATM' + (premStr ? ' ' + premStr : '') + ' \u2500\u2500\u2500';
        } else if (isMp) {
            line = p + ' \u2524 \u00B7\u00B7\u00B7\u00B7\u00B7\u00B7MAX PAIN ' + fmtNum(mpVal) + '\u00B7\u00B7\u00B7\u00B7\u00B7\u00B7';
        } else if (isSpot) {
            line = p + ' \u2524 \u25C4\u25C4\u25C4 YOU ARE HERE \u25BA\u25BA\u25BA' + (premStr ? ' \u2500\u2500\u2500 ' + premStr : '');
        } else {
            line = p + ' \u2524';
        }

        rows.push(line);
    }

    return rows;
}

export default ScalpService;
