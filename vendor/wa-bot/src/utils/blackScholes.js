/**
 * Black-Scholes greeks — used to state the ODDS on an expiry-day option card.
 *
 * The point of this file is honesty. An option's delta is the market's own
 * estimate of the probability it finishes in the money; N(d2) is the risk-neutral
 * probability proper. A hero-zero strike quoting ₹2 is not cheap because it is
 * mispriced — it is cheap because the market prices a ~2-5% chance of it paying.
 * Printing that number next to the premium is the difference between a trade and
 * a lottery ticket sold as a trade.
 */

/** Abramowitz & Stegun 7.1.26 — max error ~1.5e-7, ample for probabilities. */
export function erf(x) {
    const sign = x < 0 ? -1 : 1;
    const ax = Math.abs(x);
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;
    const t = 1 / (1 + p * ax);
    const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
    return sign * y;
}

/** Standard normal CDF. */
export function normCdf(x) {
    return 0.5 * (1 + erf(x / Math.SQRT2));
}

/** Standard normal PDF. */
export function normPdf(x) {
    return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * @param {object} p
 * @param {number} p.spot
 * @param {number} p.strike
 * @param {number} p.iv       annualised, as a fraction (0.18 = 18%)
 * @param {number} p.years    time to expiry in years
 * @param {number} [p.rate]   risk-free rate
 * @returns {{ d1: number, d2: number }|null}
 */
function dTerms({ spot, strike, iv, years, rate = 0.065 }) {
    if (![spot, strike, iv, years].every(Number.isFinite)) return null;
    if (spot <= 0 || strike <= 0 || iv <= 0 || years <= 0) return null;
    const volSqrtT = iv * Math.sqrt(years);
    if (volSqrtT <= 0) return null;
    const d1 = (Math.log(spot / strike) + (rate + 0.5 * iv * iv) * years) / volSqrtT;
    return { d1, d2: d1 - volSqrtT };
}

/**
 * Option delta. Returns null when inputs cannot support a calculation
 * (e.g. after the close, or a strike with no quoted IV).
 * @param {'CE'|'PE'} type
 */
export function delta(type, params) {
    const d = dTerms(params);
    if (!d) return null;
    const nd1 = normCdf(d.d1);
    return type === 'CE' ? nd1 : nd1 - 1;
}

/**
 * Risk-neutral probability of finishing in the money — N(d2) for calls,
 * N(-d2) for puts. This is the number to show a user, not |delta|, though the
 * two are close for short-dated options.
 */
export function probabilityItm(type, params) {
    const d = dTerms(params);
    if (!d) return null;
    return type === 'CE' ? normCdf(d.d2) : normCdf(-d.d2);
}

/** Theoretical premium — used to sanity-check quoted LTP against model value. */
export function theoreticalPrice(type, params) {
    const d = dTerms(params);
    if (!d) return null;
    const { spot, strike, years, rate = 0.065 } = params;
    const disc = Math.exp(-rate * years);
    if (type === 'CE') {
        return spot * normCdf(d.d1) - strike * disc * normCdf(d.d2);
    }
    return strike * disc * normCdf(-d.d2) - spot * normCdf(-d.d1);
}

/**
 * Move required in the underlying for an option to reach breakeven at expiry,
 * i.e. strike ± premium. Reported in points and percent — the plainest possible
 * statement of what has to happen for the trade to make money.
 */
export function breakevenMove(type, { spot, strike, premium }) {
    if (![spot, strike, premium].every(Number.isFinite) || spot <= 0) return null;
    const breakeven = type === 'CE' ? strike + premium : strike - premium;
    const points = breakeven - spot;
    return {
        breakeven,
        points,
        absPoints: Math.abs(points),
        pct: (Math.abs(points) / spot) * 100,
    };
}

/**
 * Max pain: the strike at which total option-buyer payout is smallest. Expiry
 * sessions frequently drift toward it, so a hero-zero strike on the far side of
 * max pain is fighting the pin.
 * @param {{ strike: number, ceOi: number, peOi: number }[]} rows
 */
export function maxPain(rows) {
    const valid = (rows || []).filter((r) => Number.isFinite(r.strike));
    if (valid.length < 3) return null;

    let best = null;
    for (const candidate of valid) {
        let pain = 0;
        for (const r of valid) {
            // Calls held by buyers pay out when settlement is above their strike.
            if (candidate.strike > r.strike) pain += (candidate.strike - r.strike) * (r.ceOi || 0);
            // Puts pay out below.
            if (candidate.strike < r.strike) pain += (r.strike - candidate.strike) * (r.peOi || 0);
        }
        if (best == null || pain < best.pain) best = { strike: candidate.strike, pain };
    }
    return best?.strike ?? null;
}
