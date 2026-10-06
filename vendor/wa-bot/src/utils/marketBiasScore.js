/**
 * Market bias score (-100 to +100) — indian-market-tracker style.
 */

export function computeMarketBias({
    fiiNet = null,
    diiNet = null,
    niftyChangePct = null,
    breadthAdvPct = null,
    vix = null,
    vixChangePct = null,
} = {}) {
    let score = 0;

    if (fiiNet != null) {
        if (fiiNet > 500) score += 15;
        else if (fiiNet < -500) score -= 15;
    }
    if (diiNet != null) {
        if (diiNet > 500) score += 10;
        else if (diiNet < -500) score -= 10;
    }

    const nifty = Number(niftyChangePct);
    if (Number.isFinite(nifty)) {
        if (nifty > 1) score += 20;
        else if (nifty > 0.3) score += 10;
        else if (nifty < -1) score -= 20;
        else if (nifty < -0.3) score -= 10;
    }

    const breadth = Number(breadthAdvPct);
    if (Number.isFinite(breadth)) {
        if (breadth >= 60) score += 20;
        else if (breadth < 40) score -= 20;
    }

    const v = Number(vix);
    if (Number.isFinite(v)) {
        if (v < 13) score += 15;
        else if (v > 18 && v <= 24) score -= 10;
        else if (v > 24) score -= 20;
    }

    const vixChg = Number(vixChangePct);
    if (Number.isFinite(vixChg) && vixChg > 5) score -= 5;

    let label = 'NEUTRAL';
    let emoji = '😐';
    if (score > 15) {
        label = 'BULLISH';
        emoji = '🐂';
    } else if (score < -15) {
        label = 'BEARISH';
        emoji = '🐻';
    }

    return {
        score: Math.max(-100, Math.min(100, score)),
        label,
        emoji,
        preferCe: score > 15,
        preferPe: score < -15,
        strictMode: score >= -15 && score <= 15,
    };
}
