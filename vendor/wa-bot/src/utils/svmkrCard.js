/**
 * SVMKR alert cards: the entry card, the live follow-ups, and the stats block.
 *
 * Every premium on a card is stamped with the chain timestamp it came from. A
 * card that says "Entry ₹142" without saying when ₹142 was true is unusable by
 * the time it reaches a phone.
 */

const fmt = (v, d = 2) => (Number.isFinite(Number(v)) ? Number(v).toFixed(d) : 'n/a');
const inr = (v) => (Number.isFinite(Number(v)) ? `₹${Math.round(Number(v)).toLocaleString('en-IN')}` : 'n/a');

function istTime(ms) {
    return new Date(ms).toLocaleTimeString('en-IN', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });
}

/**
 * Entry card. An on-demand read can produce a setup whose confirmations do NOT
 * agree (the auto-loop would never post it) — that must not look like a fired
 * signal, or the card talks someone into a trade the strategy did not take.
 */
export function formatSvmkrCard(scan, { nowMs = Date.now() } = {}) {
    const { label, key, tech, setup, snapshot } = scan;
    const s = setup;
    const p = s.plan;
    const dir = s.side === 'CE' ? '🟢 BUY CALL' : '🔴 BUY PUT';
    const fired = s.fresh && s.confirmations === 2;

    const L = [];
    L.push('┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓');
    L.push(fired ? '  ⚡ *SVMKR SIGNAL* ⚡' : '  👁️ *SVMKR READ — NOT A SIGNAL*');
    L.push('┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛');
    L.push('');
    // AI verdict lands at the top so the reader sees BUY / SKIP / WAIT before
    // any premium. Missing when the LLM was skipped or every model failed —
    // in that case the card renders like it always did.
    if (scan.verdict) {
        const v = scan.verdict;
        const badge = v.verdict === 'BUY' ? '🟢' : v.verdict === 'SKIP' ? '⛔' : '⏸️';
        L.push(`🤖 *AI VERDICT: ${v.verdict} · ${v.confidence}%* ${badge}`);
        L.push(`_${v.why}_`);
        L.push('');
    }
    if (!fired) {
        L.push(
            s.fresh
                ? '⚠️ _A cross printed but its confirmations disagree — the scanner would NOT post this._'
                : '⚠️ _No fresh cross. This is the standing trend, shown on request — not a trade the scanner took._'
        );
        L.push('');
    }
    L.push(`📊 *${label}* · ${dir}`);
    L.push(`🎯 *${s.strike} ${s.side}* · expiry ${s.expiry}`);
    L.push('─────────────────────────────');
    L.push('');
    L.push(`*Index:* ${fmt(tech.close, 2)}  ·  *UT stop:* ${fmt(tech.trailingStop, 2)}`);
    L.push(`*Risk:* ${fmt(s.indexRisk, 1)} index pts to the stop`);
    L.push('');

    if (p && p.lots > 0) {
        L.push(fired ? '💰 *THE TRADE*' : '💰 *WHAT IT WOULD BE*');
        L.push(`│ Entry premium: *₹${fmt(p.premEntry)}*`);
        L.push(`│ Stop loss:     *₹${fmt(p.premStop)}*  →  risk ${inr(p.riskRs)}`);
        L.push(`│ Target 1:      *₹${fmt(p.premT1)}*  →  profit ${inr(p.t1Rs)}`);
        L.push(`│ Target 2:      ₹${fmt(p.premT2)}  →  profit ${inr(p.t2Rs)} _(runner)_`);
        L.push(`│ Lots: *${p.lots}* (${p.qty} qty) · capital ${inr(p.capitalUsed)}`);
        L.push('');
    } else {
        L.push('💰 *THE TRADE*');
        L.push(`│ Entry premium: *₹${fmt(s.premium)}*`);
        L.push(`│ ⚠️ Not sized: ${p?.blocked || 'one lot does not fit the configured capital'}`);
        L.push('');
    }

    L.push('🔍 *WHY*');
    for (const r of s.reasons) L.push(`│ • ${r}`);
    L.push('');

    if (s.iv != null) L.push(`_IV ${fmt(s.iv, 1)}% · theta works against a bought option._`);
    L.push(`_Premium as of chain ${snapshot?.chainTimestamp || 'n/a'}; bar ${istTime(tech.barTs)} IST._`);
    L.push('');
    L.push('─────────────────────────────');
    L.push(`🕐 _${istTime(nowMs)} IST · ${key} · 5m bar close_`);
    L.push('_Signal only, not advice. Position sized to the configured capital._');
    return L.join('\n');
}

/** The "nothing fired" read, for the on-demand command. */
export function formatSvmkrIdle(scan, { nowMs = Date.now() } = {}) {
    const { label, tech, noneReason } = scan;
    const L = [];
    L.push(`⚡ *SVMKR — ${label}*`);
    L.push('─────────────────────────────');
    L.push(`No setup: _${noneReason}_`);
    if (tech) {
        L.push('');
        L.push(`*Index:* ${fmt(tech.close, 2)}`);
        L.push(`*UT stop:* ${fmt(tech.trailingStop, 2)} · standing ${tech.pos > 0 ? '🟢 long' : tech.pos < 0 ? '🔴 short' : 'flat'}`);
        L.push(`*HMA(${'21'}):* ${fmt(tech.hma, 2)} · price ${tech.aboveHma ? 'above' : 'below'}`);
        L.push(`*Slope:* ${fmt(tech.slope, 4)} vs avg ${fmt(tech.slopeAvg, 4)} ${tech.lrsBull ? '🟢' : tech.lrsBear ? '🔴' : '⚪'}`);
        L.push(`*ATR(10):* ${fmt(tech.atr, 2)}`);
        L.push('');
        L.push(`_Last closed 5m bar ${istTime(tech.barTs)} IST (${tech.barAgeMin}m ago)._`);
    }
    L.push(`🕐 _${istTime(nowMs)} IST_`);
    return L.join('\n');
}

const STAGE_TEXT = {
    HOLD: '🟡 *HOLD* — thesis intact',
    T1: '🟢 *TARGET 1 HIT* — book part, trail the rest to entry',
    T2: '🟢 *TARGET 2 HIT* — close it',
    SL: '🔴 *STOP LOSS HIT* — out',
    FLIP: '🔴 *EXIT* — UT Bot flipped against the trade',
    STALE: '⚪ *STALE* — not moving, theta is the only thing working',
    TIME: '⏰ *TIME EXIT* — session ending',
};

/**
 * Follow-up posted as a reply to the original card.
 * @param {object} pos position document
 * @param {{ stage: string, premium: number, pnlRs: number, pnlPct: number, note?: string }} u
 */
export function formatSvmkrUpdate(pos, u, { nowMs = Date.now() } = {}) {
    const sign = u.pnlRs >= 0 ? '+' : '−';
    const L = [];
    L.push(`${STAGE_TEXT[u.stage] || u.stage}`);
    L.push(`*${pos.index} ${pos.strike} ${pos.side}*`);
    L.push('─────────────────────────────');
    L.push(`Entry ₹${fmt(pos.prem_entry)} → now *₹${fmt(u.premium)}*  (${sign}${fmt(Math.abs(u.pnlPct), 1)}%)`);
    L.push(`P&L on ${pos.qty} qty: *${sign}${inr(Math.abs(u.pnlRs))}*`);
    if (u.note) L.push(`_${u.note}_`);
    L.push(`🕐 _${istTime(nowMs)} IST_`);
    return L.join('\n');
}

/** Closing message with the realized result. */
export function formatSvmkrClose(pos, u, { nowMs = Date.now() } = {}) {
    const win = u.pnlRs > 0;
    const sign = win ? '+' : '−';
    const L = [];
    L.push(win ? '✅ *TRADE CLOSED — WIN*' : '❌ *TRADE CLOSED — LOSS*');
    L.push(`*${pos.index} ${pos.strike} ${pos.side}* · ${STAGE_TEXT[u.stage] || u.stage}`);
    L.push('─────────────────────────────');
    L.push(`Entry ₹${fmt(pos.prem_entry)} → exit *₹${fmt(u.premium)}*`);
    L.push(`Result on ${pos.qty} qty: *${sign}${inr(Math.abs(u.pnlRs))}* (${sign}${fmt(Math.abs(u.pnlPct), 1)}%)`);
    const heldMin = Math.round((nowMs - new Date(pos.opened_at).getTime()) / 60_000);
    L.push(`Held ${heldMin} min`);
    L.push(`🕐 _${istTime(nowMs)} IST_`);
    return L.join('\n');
}

/**
 * Measured stats block. Deliberately says how many trades it is based on —
 * a win rate over four trades is not a win rate.
 */
export function formatSvmkrStats(stats) {
    if (!stats || !stats.closed) {
        return (
            '⚡ *SVMKR stats*\n' +
            '─────────────────────────────\n' +
            '_No closed trades yet. This counter starts from the first live-tracked SVMKR trade — ' +
            'it is separate from `/tradelert stats` and shares no history with it._'
        );
    }

    const L = [];
    L.push('⚡ *SVMKR — MEASURED RESULTS*');
    L.push('─────────────────────────────');
    L.push(`Closed trades: *${stats.closed}*  ·  open now: ${stats.open}`);
    L.push(`Win rate: *${fmt(stats.winRate * 100, 1)}%*  (${stats.wins}W / ${stats.losses}L)`);
    L.push(`Net P&L: *${stats.netRs >= 0 ? '+' : '−'}${inr(Math.abs(stats.netRs))}*`);
    if (stats.avgWinRs != null) L.push(`Avg win ${inr(stats.avgWinRs)} · avg loss ${inr(stats.avgLossRs)}`);
    if (stats.bySide?.length) {
        L.push('');
        for (const b of stats.bySide) {
            L.push(`│ ${b.side}: ${b.closed} trades, ${fmt(b.winRate * 100, 0)}% win, ${b.netRs >= 0 ? '+' : '−'}${inr(Math.abs(b.netRs))}`);
        }
    }
    L.push('');
    L.push('_Graded on the actual traded premium, polled live while each trade was open —_');
    L.push('_not on the underlying\'s direction. Exits at the stop count as losses in full._');
    return L.join('\n');
}
