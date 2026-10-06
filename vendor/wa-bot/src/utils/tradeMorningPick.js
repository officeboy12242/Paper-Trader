/**
 * Morning "best of posted alerts" pick — Format B card + live ATM premium refresh.
 */

import { parsePremium, parseTargets } from './tradePlanFormatter.js';
import { nseOptionChainService } from '../services/NseOptionChainService.js';
import { logger } from './logger.js';
import { normalizeDiscoverySource } from './discoverySource.js';

const CE_SECTION =
    /━━━\s*CALL\s*\(CE\)\s*SETUP\s*━━━[\s\S]*?(?=━━━\s*PUT\s*\(PE\)\s*SETUP|Primary Pick:|$)/i;
const PE_SECTION =
    /━━━\s*PUT\s*\(PE\)\s*SETUP\s*━━━[\s\S]*?(?=Primary Pick:|$)/i;

const STRATEGIES = {
    orEma: 'Opening Range Breakout + 8 EMA',
    momentum: 'Momentum continuation',
    pcrOi: 'PCR / OI confirmation',
    vwap: 'VWAP reclaim / reject',
    preOpen: 'Pre-open auction + order imbalance',
    turnoverBand: 'Turnover band + EMA 8/21 trend',
};

function pad(s, n) {
    const t = String(s ?? '').slice(0, n);
    return t.length >= n ? t : t + ' '.repeat(n - t.length);
}

function sideFromSignal(signal) {
    const rec = String(signal?.recommendation || '');
    if (/BUY\s*PE|\bPE\b/i.test(rec) && signal?.isBuyPut) return 'PE';
    if (/BUY\s*CE|\bCE\b/i.test(rec) && signal?.isBuyCall) return 'CE';
    if (signal?.isBuyPut && !signal?.isBuyCall) return 'PE';
    if (signal?.isBuyCall) return 'CE';
    if (/PE/i.test(rec)) return 'PE';
    return 'CE';
}

function parseField(block, names) {
    for (const name of names) {
        const re = new RegExp(`^${name}:\\s*(.+)$`, 'im');
        const match = block.match(re);
        if (match) return match[1].trim();
    }
    return null;
}

/** Extract strike / entry / SL / targets from the winning CE or PE block. */
export function parseLegLevels(body, side) {
    const text = String(body || '');
    const block =
        (side === 'PE' ? text.match(PE_SECTION)?.[0] : text.match(CE_SECTION)?.[0]) || '';
    const entry = parsePremium(parseField(block, ['Entry']));
    const sl = parsePremium(parseField(block, ['Stop Loss', 'SL']));
    const { t1, t2, t3 } = parseTargets(block, entry);
    const strikeRaw = parseField(block, ['Strike']) || '';
    const strikeNum = strikeRaw.match(/(\d+(?:\.\d+)?)/)?.[1] || null;
    return {
        entry,
        sl,
        t1,
        t2,
        t3,
        strikeLabel: strikeRaw || null,
        strike: strikeNum != null ? Number(strikeNum) : null,
    };
}

function rescaleLevel(oldLevel, oldEntry, liveEntry) {
    if (oldLevel == null || oldEntry == null || !liveEntry || oldEntry <= 0) return oldLevel;
    return Number(((oldLevel / oldEntry) * liveEntry).toFixed(2));
}

/**
 * Pick strategy label from discovery + signal shape (all 4 available; auto best-fit).
 */
export function pickStrategy({ discoverySource, confluence, signal, softGate } = {}) {
    const src = normalizeDiscoverySource(discoverySource);
    const conf = Number(confluence || 0);
    const ai = Number(signal?.confidence || 0);

    // Both heatmap generations select on an opening-range break, so the pick
    // must be labelled that way. Matching the literal 'heatmap' let 'heatmap2'
    // fall through to the confluence heuristics below and get tagged VWAP —
    // naming a strategy the trade was not chosen by.
    if (src === 'heatmap' || src === 'heatmap2') {
        return STRATEGIES.orEma;
    }
    // A pre-open pick was chosen by the auction clearing price and the resting
    // order book, before any bar existed. Labelling it ORB/VWAP/momentum would
    // name a strategy that had no data to run on at selection time.
    if (src === 'preopen') {
        return STRATEGIES.preOpen;
    }
    // Chosen from a daily-timeframe EMA stack inside a turnover band. No opening
    // range or VWAP was involved, so it must not borrow their labels either.
    if (src === 'turnover') {
        return STRATEGIES.turnoverBand;
    }
    if (conf >= 55 && ai >= 78 && !softGate) {
        return STRATEGIES.momentum;
    }
    if (conf >= 45 && (signal?.isBuyCall || signal?.isBuyPut)) {
        return STRATEGIES.pcrOi;
    }
    return STRATEGIES.vwap;
}

/**
 * Rank posted daily alerts; higher = better morning pick.
 * @param {{ symbol: string, signal: object, resultEntry: object, softGate?: boolean, body?: string, text?: string }[]} posted
 */
export function selectMorningPick(posted, { discoverySource = 'heatmap' } = {}) {
    const rows = (posted || [])
        .filter((p) => p?.symbol && p?.signal?.isActionable !== false)
        .map((p) => {
            const signal = p.signal || {};
            const conf = Number(p.resultEntry?.confluence ?? p.confluence ?? 0);
            const ai = Number(signal.confidence || 0);
            const soft = Boolean(p.softGate || p.resultEntry?.softGate);
            const gem = Boolean(p.resultEntry?.isHiddenGem);
            const side = sideFromSignal(signal);
            const levels = parseLegLevels(p.body || p.text || '', side);
            let score = ai + conf * 0.55;
            if (soft) score -= 18;
            if (gem) score += 4;
            if (levels.entry != null && levels.t1 != null && levels.sl != null) {
                const risk = Math.abs(levels.entry - levels.sl);
                const reward = Math.abs(levels.t1 - levels.entry);
                if (risk > 0 && reward / risk >= 1.5) score += 8;
            }
            const strategy = pickStrategy({
                discoverySource,
                confluence: conf,
                signal,
                softGate: soft,
            });
            return {
                symbol: String(p.symbol).toUpperCase(),
                side,
                ai,
                confluence: conf,
                soft,
                gem,
                score,
                strategy,
                levels,
                signal,
                body: p.body || '',
                text: p.text || '',
            };
        });

    rows.sort((a, b) => b.score - a.score || b.ai - a.ai || b.confluence - a.confluence);
    return { winner: rows[0] || null, ranked: rows };
}

/**
 * Fresh NSE ATM LTP for the winning leg only (no LLM — keeps pick card snappy).
 * @param {string} symbol
 * @param {'CE'|'PE'} side
 * @param {{ timeoutMs?: number }} [opts]
 */
export async function fetchLiveAtmPremium(symbol, side, opts = {}) {
    const timeoutMs = Math.min(12_000, Math.max(4_000, Number(opts.timeoutMs) || 8_000));
    try {
        const pack = await Promise.race([
            nseOptionChainService.fetchOptionContext(symbol),
            new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
        ]);
        const snap = pack?.snapshot;
        if (!snap) return null;
        const leg = side === 'PE' ? snap.atmPe : snap.atmCe;
        const ltp = leg?.ltp != null ? Number(leg.ltp) : null;
        if (ltp == null || !Number.isFinite(ltp) || ltp <= 0) return null;
        return {
            entry: ltp,
            strike: snap.atmStrike ?? leg?.strike ?? null,
            expiry: snap.expiry || null,
            spot: snap.spot ?? null,
            pcr: snap.pcr ?? null,
            at: new Date().toISOString(),
        };
    } catch (err) {
        logger.warn(`Morning pick live premium failed for ${symbol}: ${err.message}`);
        return null;
    }
}

function fmtPrem(n) {
    if (n == null || !Number.isFinite(Number(n))) return '—';
    const v = Number(n);
    return Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, '');
}

/**
 * Format B card with comparison table + live entry premium.
 * @param {{ winner: object, ranked: object[] }} pick
 * @param {{ live?: object|null, discoverySource?: string }} [meta]
 */
export function formatMorningPickCard(pick, meta = {}) {
    const ranked = pick?.ranked || [];
    const winner = pick?.winner;
    if (!winner || !ranked.length) return '';

    const live = meta.live || null;
    const alertEntry = winner.levels?.entry ?? null;
    const liveEntry = live?.entry ?? null;
    const entry = liveEntry ?? alertEntry;
    const strike =
        live?.strike != null
            ? `${live.strike}${live.expiry ? ` · ${live.expiry}` : ''} (ATM)`
            : winner.levels?.strikeLabel || (winner.levels?.strike != null ? String(winner.levels.strike) : '—');

    const oldEntry = alertEntry;
    const sl = liveEntry
        ? rescaleLevel(winner.levels?.sl, oldEntry, liveEntry) ?? winner.levels?.sl
        : winner.levels?.sl;
    const t1 = liveEntry
        ? rescaleLevel(winner.levels?.t1, oldEntry, liveEntry) ?? winner.levels?.t1
        : winner.levels?.t1;
    const t2 = liveEntry
        ? rescaleLevel(winner.levels?.t2, oldEntry, liveEntry) ?? winner.levels?.t2
        : winner.levels?.t2;
    const t3 = liveEntry
        ? rescaleLevel(winner.levels?.t3, oldEntry, liveEntry) ?? winner.levels?.t3
        : winner.levels?.t3;

    const lines = [];
    lines.push('════════════════════');
    lines.push('🏆 *MORNING PICK*');
    lines.push('════════════════════');
    lines.push('');
    lines.push('Compared today\'s posted alerts');
    lines.push('┌──────────┬──────┬──────┬──────┬────────┐');
    lines.push('│ Symbol   │ Side │ AI%  │ Conf │ Prem   │');
    lines.push('├──────────┼──────┼──────┼──────┼────────┤');

    for (const row of ranked.slice(0, 6)) {
        const star = row.symbol === winner.symbol ? ' ★' : '';
        const prem =
            row.symbol === winner.symbol && liveEntry != null
                ? fmtPrem(liveEntry)
                : fmtPrem(row.levels?.entry);
        lines.push(
            `│ ${pad(row.symbol, 8)} │ ${pad(row.side, 4)} │ ${pad(row.ai, 4)} │ ${pad(row.confluence, 4)} │ ${pad(prem, 6)} │${star}`
        );
    }
    lines.push('└──────────┴──────┴──────┴──────┴────────┘');
    lines.push('');
    lines.push(`★ TAKE: *${winner.symbol} ${winner.side}*`);
    lines.push(`Strategy → ${winner.strategy}`);
    lines.push('');
    lines.push(`Why ${winner.symbol} over the others`);
    lines.push(
        `• Highest score among posted (AI ${winner.ai}% · confluence ${winner.confluence})`
    );
    if (winner.soft) {
        lines.push('• Soft-gate day — size smaller than usual');
    } else {
        lines.push('• Passed strict daily gates (not soft-fill)');
    }
    if (live?.pcr != null) {
        lines.push(`• Live PCR ${Number(live.pcr).toFixed(2)} · ATM refreshed just now`);
    } else {
        lines.push('• Best R:R / premium structure among today’s set');
    }
    lines.push('');
    lines.push('──────── LIVE ENTRY ────────');
    if (liveEntry != null) {
        lines.push(`Premium (fresh NSE ATM LTP): *₹${fmtPrem(liveEntry)}*`);
        if (alertEntry != null && Math.abs(alertEntry - liveEntry) / liveEntry > 0.03) {
            lines.push(`_Alert had ₹${fmtPrem(alertEntry)} — refreshed after scan_`);
        } else {
            lines.push('_Refreshed from NSE option chain right before this card_');
        }
    } else {
        lines.push(`Premium (from alert): *₹${fmtPrem(alertEntry)}*`);
        lines.push('_Live chain refresh unavailable — using alert premium_');
    }
    lines.push(`Strike: ${strike}`);
    lines.push(
        `SL ₹${fmtPrem(sl)}  │  T1 ₹${fmtPrem(t1)}  │  T2 ₹${fmtPrem(t2)}  │  T3 ₹${fmtPrem(t3)}`
    );
    lines.push('');
    if (winner.strategy === STRATEGIES.orEma) {
        lines.push('Invalidation: 15m close back inside OR / below 8 EMA');
    } else if (winner.strategy === STRATEGIES.preOpen) {
        lines.push('Invalidation: opening price rejects the auction level / book flips');
    } else if (winner.strategy === STRATEGIES.turnoverBand) {
        lines.push('Invalidation: daily close back through the 8 EMA against the trade');
    } else if (winner.strategy === STRATEGIES.momentum) {
        lines.push('Invalidation: momentum stall + loss of VWAP / prior swing');
    } else if (winner.strategy === STRATEGIES.pcrOi) {
        lines.push('Invalidation: PCR/OI flip against the trade');
    } else {
        lines.push('Invalidation: failed VWAP reclaim/reject on 15m');
    }
    lines.push('');
    lines.push('⚠️ Not financial advice · education only · size small');
    return lines.join('\n');
}

/**
 * Build pick + kick off live premium ASAP (call while alerts are still sending).
 * @param {object[]} toPost
 * @param {{ discoverySource?: string }} [opts]
 */
export function startMorningPick(toPost, opts = {}) {
    const pick = selectMorningPick(toPost, opts);
    if (!pick.winner) {
        return { pick, livePromise: Promise.resolve(null) };
    }
    const livePromise = fetchLiveAtmPremium(pick.winner.symbol, pick.winner.side, {
        timeoutMs: 8_000,
    });
    return { pick, livePromise };
}
