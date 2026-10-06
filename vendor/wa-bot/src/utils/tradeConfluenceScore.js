/**
 * Deterministic confluence score before AI alert send (trading-copilot + IMT).
 */

import { catalystRadarService } from '../services/CatalystRadarService.js';

const DEFAULT_MIN = 40;

export function scoreConfluence({
    symbol,
    quote = null,
    optionChainSnapshot = null,
    movers = null,
    macro = null,
    catalystItems = [],
    smartMoneyDeals = [],
    sectorTag = null,
} = {}) {
    const sym = String(symbol || '').toUpperCase();
    let score = 0;
    const reasons = [];
    const risks = [];

    const changePct = Number(quote?.changePct);
    const volume = Number(quote?.volume) || 0;
    const niftyPct = Number(macro?.nifty?.pct) || 0;

    const moverRows = [...(movers?.gainers || []), ...(movers?.losers || [])];
    const moverHit = moverRows.find((m) => m.symbol === sym);
    if (moverHit) {
        score += 25;
        reasons.push(`mover ${moverHit.changePct >= 0 ? '+' : ''}${moverHit.changePct}%`);
    }

    if (volume > 1_000_000) {
        score += 10;
        reasons.push('high volume');
    }

    const rs = Number.isFinite(changePct) && Number.isFinite(niftyPct) ? changePct - niftyPct : null;
    if (rs != null && rs >= 1.5) {
        score += 15;
        reasons.push(`RS +${rs.toFixed(1)}% vs NIFTY`);
    }

    const catalyst = catalystRadarService.getSymbolCatalyst(sym, catalystItems);
    if (catalyst.avoid) {
        score -= 30;
        risks.push(`catalyst AVOID: ${catalyst.avoidReason}`);
    } else if (catalyst.boost) {
        score += catalyst.boost;
        reasons.push(`catalyst ${catalyst.topCatalyst?.type || 'news'}`);
    }

    const deal = (smartMoneyDeals || []).find((d) => d.symbol === sym);
    if (deal) {
        score += 20;
        reasons.push(`${deal.kind} deal`);
    }

    if (optionChainSnapshot?.pcr != null) {
        const pcr = Number(optionChainSnapshot.pcr);
        const bullishPcr = pcr > 1.0;
        const bearishPcr = pcr < 0.8;
        if (macro?.bias?.preferCe && bullishPcr) {
            score += 15;
            reasons.push(`PCR ${pcr.toFixed(2)} supports CE`);
        } else if (macro?.bias?.preferPe && bearishPcr) {
            score += 15;
            reasons.push(`PCR ${pcr.toFixed(2)} supports PE`);
        }
    }

    if (macro?.bias?.label === 'BULLISH' && changePct > 0) {
        score += 10;
        reasons.push('macro bullish alignment');
    } else if (macro?.bias?.label === 'BEARISH' && changePct < 0) {
        score += 10;
        reasons.push('macro bearish alignment');
    }

    if (sectorTag) {
        score += 5;
        reasons.push(`hot sector: ${sectorTag}`);
    }

    return {
        symbol: sym,
        score: Math.max(0, Math.min(100, score)),
        reasons,
        risks,
        blocked: catalyst.avoid,
        blockReason: catalyst.avoid ? catalyst.avoidReason : null,
        passes: !catalyst.avoid && score >= DEFAULT_MIN,
    };
}

export function getMinConfluenceScore(config = {}) {
    const n = parseInt(config.TRADE_ALERT_MIN_CONFLUENCE, 10);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_MIN;
}

export function adjustConfidenceFloor(macro, baseMin = 70) {
    if (macro?.bias?.strictMode) return Math.max(baseMin, 75);
    if (macro?.bias?.label === 'BEARISH' || macro?.bias?.label === 'BULLISH') return baseMin;
    return baseMin;
}
