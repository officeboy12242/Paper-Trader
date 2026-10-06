/**
 * WhatsApp formatting for swing momentum picks.
 */

/** Whole rupees — sub-rupee precision is noise at these position sizes. */
function inr(n) {
    if (!Number.isFinite(n)) return '—';
    return Math.round(n).toLocaleString('en-IN');
}

/** Two decimals, for per-share prices where the paise matter. */
function inr2(n) {
    if (!Number.isFinite(n)) return '—';
    return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function sectorLabel(s) {
    return String(s || 'OTHER').replace(/_/g, '/').toLowerCase();
}

function oiScoreBar(score) {
    if (score == null) return '';
    const pct = Math.round((score / 2) * 100);
    const filled = Math.round(pct / 10);
    const empty = 10 - filled;
    const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
    return bar + ' ' + pct + '%';
}

function formatPick(p, idx) {
    const { plan } = p;
    const rr2 = ((plan.target1 - plan.entry) / plan.risk).toFixed(1);
    const rr3 = ((plan.target2 - plan.entry) / plan.risk).toFixed(1);

    let s = `*${idx + 1}. ${p.symbol}* ${p.isNewHigh ? '🚀 new 52w high' : '📈 near high'}\n`;
    s += `_${p.displayName}_\n`;
    s += `💰 CMP *₹${inr2(p.price)}*  ·  ${p.pctFromHigh.toFixed(1)}% off 52w high\n`;
    s += `🏅 Momentum *#${p.rank}* (top ${p.topPct}%)  ·  vol *${p.volRatio.toFixed(1)}×*  ·  ${sectorLabel(p.sector)}\n`;
    if (p.oiScore != null) {
        s += `📊 OI *${oiScoreBar(p.oiScore)}*  ·  PCR ${p.oi?.pcr ?? '—'}\n`;
        if (p.oi) {
            const ceLabel = p.oi.ceOiChange > 0
                ? `CE OI ▲${inr(p.oi.ceOiChange)}`
                : (p.oi.ceOiChange < 0 ? `CE unwind ▼${inr(Math.abs(p.oi.ceOiChange))}` : 'CE flat');
            const peLabel = p.oi.peOiChange > 0
                ? `PE OI ▲${inr(p.oi.peOiChange)}`
                : (p.oi.peOiChange < 0 ? `PE unwind ▼${inr(Math.abs(p.oi.peOiChange))}` : 'PE flat');
            s += `   ${ceLabel} · ${peLabel}\n`;
        }
    }
    s += `\n`;
    s += `🎯 Entry: *₹${inr2(plan.entry)}*\n`;
    s += `🛑 Stop: *₹${inr2(plan.stop)}*  (−${plan.riskPct.toFixed(1)}%, 2×ATR)\n`;
    s += `✅ T1: *₹${inr2(plan.target1)}* (${rr2}R)  ·  T2: *₹${inr2(plan.target2)}* (${rr3}R)\n`;
    s += `📦 Qty *${plan.qty}*  ·  deploy ₹${inr(plan.capitalRequired)}  ·  risk ₹${inr(plan.riskAmount)}\n`;
    // Whole-share rounding can leave real risk far under the intended budget.
    if (plan.riskUtilisation < 0.7) {
        s += `⚠️ _Share price forces qty ${plan.qty} — actual risk is only ${Math.round(plan.riskUtilisation * 100)}% of budget._\n`;
    }
    return s;
}

/**
 * @param {object} result output of SwingMomentumScanService.scan()
 */
export function formatSwingScan(result) {
    const {
        regime, halted, picks = [], nearMisses = [], unsizeable = [], scanned, ranked,
        universeSize, elapsedMs, capital, riskPctPerTrade, topRanked = [],
        sectorSpread = [], maxPerSector,
    } = result;

    let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    r += '📊 *SWING MOMENTUM SCAN* 📊\n';
    r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
    r += `🌐 *Regime:* ${regime.ok ? '🟢' : '🔴'} ${regime.label}\n`;

    if (halted) {
        r += '\n🛑 *No new long setups.*\n\n';
        r += 'The ranking and breakout filters both fail in downtrends — ';
        r += '90% of momentum gains come in confirmed uptrends, so the scan ';
        r += 'stands down rather than handing you setups with the odds inverted.\n\n';
        r += '_Force it anyway with_ `/swing force` _(not advised)._';
        r += '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━';
        return r;
    }

    r += `🔍 *Scanned:* ${scanned}/${universeSize} · ranked ${ranked} · ${(elapsedMs / 1000).toFixed(0)}s\n`;
    r += `💼 *Sizing:* ₹${inr(capital)} capital @ ${riskPctPerTrade}% risk/trade\n\n`;

    if (!picks.length) {
        // Distinguish "nothing qualified" from "everything qualified but you
        // cannot afford a single share" — very different situations.
        if (unsizeable.length) {
            const cheapest = Math.min(...unsizeable.map((u) => u.minCapitalNeeded));
            r += '⚠️ *Setups found — but none are sizeable at your capital.*\n\n';
            r += `${unsizeable.length} name${unsizeable.length > 1 ? 's' : ''} passed every filter `;
            r += `(${unsizeable.map((u) => u.symbol).join(', ')}), but one share risks more `;
            r += `than ${riskPctPerTrade}% of ₹${inr(capital)}.\n\n`;
            r += `💡 *Options:* raise \`SWING_CAPITAL\` to ~₹${inr(cheapest)}+, `;
            r += `raise \`SWING_RISK_PCT\`, or trade these via a broker offering fractional/GTT sizing.\n\n`;
            r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━';
            return r;
        }

        r += '⚠️ *No qualifying setups today.*\n\n';
        r += 'Strong stocks exist but none are entryable — momentum ranks high ';
        r += 'while price sits extended or volume is thin. Waiting is the trade.\n\n';
        if (topRanked.length) {
            r += '*Strongest by momentum (not entryable):*\n';
            for (const t of topRanked.slice(0, 5)) {
                r += `• ${t.symbol} — ${t.pctFromHigh != null ? t.pctFromHigh.toFixed(1) + '% off high' : '—'}\n`;
            }
            r += '\n';
        }
        if (nearMisses.length) {
            r += '*Closest misses:*\n';
            for (const n of nearMisses.slice(0, 3)) {
                r += `• ${n.symbol} (#${n.rank}) — ${n.reasons[0]}\n`;
            }
            r += '\n';
        }
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━';
        return r;
    }

    r += `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    r += `*${picks.length} SETUP${picks.length > 1 ? 'S' : ''}*\n`;
    r += `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    picks.forEach((p, i) => {
        r += formatPick(p, i);
        if (i < picks.length - 1) r += '\n─────────────\n\n';
    });

    r += '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

    if (sectorSpread.length) {
        const spread = sectorSpread.map((s) => `${sectorLabel(s.sector)} ${s.n}`).join(' · ');
        r += `🧩 *Spread:* ${spread}  _(max ${maxPerSector}/sector)_\n`;
    }
    if (unsizeable.length) {
        const names = unsizeable.map((u) => u.symbol).join(', ');
        r += `🚫 *Too pricey to size:* ${names}\n`;
        r += `_Needs ~₹${inr(Math.min(...unsizeable.map((u) => u.minCapitalNeeded)))}+ capital at ${riskPctPerTrade}% risk._\n`;
    }
    r += '\n';
    r += '📋 *Rules*\n';
    r += '• Hold 2–6 weeks · exit on stop or T2\n';
    r += '• Trail to breakeven once T1 hits\n';
    r += '• Exit all longs if NIFTY loses its 200 DMA\n';
    r += `• Never risk more than ${riskPctPerTrade}% on one name\n\n`;
    r += '_Ranking: 70% momentum (6M+12M vol-adjusted) + 30% OI confluence (PCR, CE unwind, PE buildup)_\n';
    r += '_Not investment advice — you carry the risk._\n';
    r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━';
    return r;
}

/** Compact one-liner list for `/swing top`. */
export function formatSwingRanking(result, limit = 15) {
    const { regime, topRanked = [], ranked, universeSize } = result;
    let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    r += '🏅 *MOMENTUM LEADERBOARD* 🏅\n';
    r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
    r += `🌐 ${regime.ok ? '🟢' : '🔴'} ${regime.label}\n`;
    r += `📊 Ranked ${ranked}/${universeSize} by 6M+12M risk-adjusted momentum\n\n`;
    if (!topRanked.length) {
        r += '_No ranking available._\n━━━━━━━━━━━━━━━━━━━━━━━━━━━';
        return r;
    }
    topRanked.slice(0, limit).forEach((t, i) => {
        const off = t.pctFromHigh != null ? `${t.pctFromHigh.toFixed(1)}% off high` : '—';
        r += `${String(i + 1).padStart(2)}. *${t.symbol}* — ${off} · ${sectorLabel(t.sector)}\n`;
    });
    r += '\n_Ranking only — use_ `/swing` _for entryable setups._\n';
    r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━';
    return r;
}
