/**
 * WhatsApp cards for expiry-day option alerts.
 *
 * Hero-zero cards always carry the model probability and the required index
 * move. That is the whole point — a ₹2 premium looks like a bargain until you
 * see the 3% next to it.
 */

function n0(v) {
    return Number.isFinite(v) ? Math.round(v).toLocaleString('en-IN') : '—';
}
function n1(v) {
    return Number.isFinite(v) ? v.toFixed(1) : '—';
}
function n2(v) {
    return Number.isFinite(v) ? v.toFixed(2) : '—';
}
function pct(v, d = 1) {
    return Number.isFinite(v) ? `${v.toFixed(d)}%` : '—';
}

function contextBlock(ctx, expiry, hours) {
    let s = `📅 *Expiry:* ${expiry}  ·  ⏳ ${hours < 1 ? `${Math.round(hours * 60)}m` : `${n1(hours)}h`} left\n`;
    s += `📍 *Spot:* ${n1(ctx.spot)}  ·  ATM ${ctx.atmStrike}\n`;
    if (ctx.straddle != null) {
        s += `🎚 *ATM straddle:* ₹${n1(ctx.straddle)} → market implies ±${pct(ctx.impliedDayMovePct, 2)} left\n`;
    }
    if (ctx.maxPain != null) {
        const dir = ctx.maxPainDistPct > 0 ? 'above' : 'below';
        s += `🧲 *Max pain:* ${ctx.maxPain} (spot ${pct(Math.abs(ctx.maxPainDistPct), 2)} ${dir})\n`;
    }
    if (ctx.pcr != null) s += `⚖️ *PCR:* ${n2(ctx.pcr)}  ·  IV ~${n1(ctx.avgIv)}%\n`;
    return s;
}

function directionalCard(r) {
    const s = r.setup;
    let out = `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    out += `⚡ *EXPIRY SETUP — ${r.label}* ⚡\n`;
    out += `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    out += contextBlock(r.context, r.expiry, r.hoursToExpiry);
    out += '\n';

    if (!s.tradeable) {
        out += `⏸ *No directional trade* — ${s.reason}\n`;
        if (s.or) {
            out += `\n📊 *15m opening range:* ${n1(s.or.low)} – ${n1(s.or.high)} (${pct(s.or.rangePct, 2)})\n`;
            out += `📈 Now ${n1(s.or.last)}\n\n`;
            out += `*Triggers:*\n`;
            out += `🟢 Above *${n1(s.or.high)}* → buy ATM CE\n`;
            out += `🔴 Below *${n1(s.or.low)}* → buy ATM PE\n`;
            out += `_Wait for a close beyond the level, not a wick._\n`;
        }
        out += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
        return out;
    }

    const arrow = s.direction === 'BULLISH' ? '🟢 BULLISH' : '🔴 BEARISH';
    out += `${arrow} — broke the 15m range\n`;
    out += `📊 OR ${n1(s.or.low)} – ${n1(s.or.high)} · now ${n1(s.or.last)}\n\n`;
    out += `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    out += `🎯 *BUY ${r.index} ${s.leg.strike} ${s.leg.type}*\n`;
    out += `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    out += `💰 *Premium (entry):* ₹${n2(s.entry)}\n`;
    out += `🛑 *Stop:* ₹${n2(s.stop)}  (−${n0(100 - (s.stop / s.entry) * 100)}%)\n`;
    out += `✅ *T1:* ₹${n2(s.target1)}  (${n1(s.rr1)}R)\n`;
    out += `🚀 *T2:* ₹${n2(s.target2)}  (${n1(s.rr2)}R)\n\n`;
    out += `📦 *Lot ${s.lot}* → cost ₹${n0(s.costPerLot)} · risk ₹${n0(s.riskPerLot)}\n`;
    if (s.leg.probItm != null) {
        out += `📐 Delta ${n2(s.leg.delta)} · P(ITM) ${pct(s.leg.probItm * 100)}\n`;
    }
    if (s.againstMaxPain) {
        out += `\n⚠️ _Trading away from max pain (${r.context.maxPain}) — expiry sessions often drift back toward it._\n`;
    }
    out += `\n📋 Exit everything by *15:15*. Premium goes to intrinsic at the close.\n`;
    out += `━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
    return out;
}

function heroLeg(c) {
    const p = c.probItm != null ? c.probItm * 100 : null;
    let s = `*${c.strike} ${c.type}* — ₹${n2(c.premium)}\n`;
    s += `   🎲 P(ITM) *${pct(p)}*  ·  delta ${n2(Math.abs(c.delta))}\n`;
    s += `   📏 Needs *${n0(c.breakeven.absPoints)} pts* (${pct(c.breakeven.pct, 2)}) → ${n0(c.breakeven.breakeven)}\n`;
    s += `   📦 ₹${n0(c.costPerLot)}/lot (${c.lot})\n`;
    return s;
}

function heroZeroCard(r) {
    const s = r.setup;
    let out = `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    out += `🎰 *HERO-ZERO — ${r.label}* 🎰\n`;
    out += `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    out += contextBlock(r.context, r.expiry, r.hoursToExpiry);
    out += '\n';

    if (!s.tradeable) {
        out += `⏸ *No hero-zero candidates* — ${s.reason}\n`;
        out += `\n_That is usually the right answer. Nothing in the delta band means\n`;
        out += `every cheap strike is priced for near-certain expiry at zero._\n`;
        out += `━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
        return out;
    }

    if (s.warning) out += `⚠️ ${s.warning}\n\n`;

    if (s.ce?.length) {
        out += `📈 *UPSIDE (CE)*\n`;
        s.ce.forEach((c) => { out += heroLeg(c); });
        out += '\n';
    }
    if (s.pe?.length) {
        out += `📉 *DOWNSIDE (PE)*\n`;
        s.pe.forEach((c) => { out += heroLeg(c); });
        out += '\n';
    }

    const best = [...(s.ce || []), ...(s.pe || [])].sort(
        (a, b) => (b.probItm || 0) - (a.probItm || 0)
    )[0];

    out += `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    out += `🧮 *Read the odds before you click*\n`;
    if (best?.probItm != null) {
        const p = best.probItm * 100;
        const oneIn = p > 0 ? Math.round(100 / p) : null;
        out += `Best listed strike wins roughly *1 time in ${oneIn}*.\n`;
    }
    out += `These are cheap because the market prices them to expire worthless —\n`;
    out += `not because they are mispriced. Size as a lottery ticket: money you\n`;
    out += `are fully willing to lose, never averaged into.\n\n`;
    out += `🛑 *Hard rule:* one ticket per expiry, no re-entry after a zero.\n`;
    out += `_SEBI: 93% of F&O traders lose; expiry-focused traders do worst of all._\n`;
    out += `━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
    return out;
}

/** Single-index card. */
export function formatExpiryAlert(result) {
    if (!result?.setup) return '❌ No expiry data.';
    return result.setup.strategy === 'HERO_ZERO' ? heroZeroCard(result) : directionalCard(result);
}

/** Multi-index digest for the scheduled post. */
export function formatExpiryDigest({ indices, results }, { slot } = {}) {
    if (!indices?.length) {
        return (
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
            '📅 *NO EXPIRY TODAY* 📅\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
            'NIFTY settles every Tuesday; BANKNIFTY, FINNIFTY and MIDCPNIFTY on the\n' +
            'last Tuesday of the month.\n\n' +
            '_Use_ `/expiry nifty` _to analyse the next expiry anyway._\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━'
        );
    }
    if (!results?.length) {
        return `⚠️ Expiry today (${indices.join(', ')}) but no option chain could be fetched. NSE may be rate-limiting — try \`/expiry nifty\` shortly.`;
    }

    const header =
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `${slot === 'afternoon' ? '🎰' : '⚡'} *EXPIRY DAY — ${indices.join(' · ')}* ${slot === 'afternoon' ? '🎰' : '⚡'}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    return header + results.map((r) => formatExpiryAlert(r)).join('\n\n');
}
