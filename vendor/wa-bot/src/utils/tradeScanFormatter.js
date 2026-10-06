/**
 * Rich WhatsApp formatting for trade scan preview & daily intro.
 */

import { formatNowLabelIST } from './dateIST.js';

function fmtPct(n) {
    if (n == null || !Number.isFinite(Number(n))) return 'n/a';
    const v = Number(n);
    return `${v >= 0 ? '+' : ''}${v}%`;
}

function fmtCr(n) {
    if (n == null || !Number.isFinite(Number(n))) return 'n/a';
    const v = Number(n);
    const sign = v >= 0 ? '+' : '−';
    return `${sign}₹${Math.abs(v).toLocaleString('en-IN')} Cr`;
}

/**
 * Full scan preview — `/tradelert scan` output.
 * @param {object} discovery
 */
export function formatTradeScanPreview(discovery) {
    const d = discovery || {};
    const lines = [];

    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('📡 *MARKET INTELLIGENCE SCAN* 📡');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('');

    const scanned = d.scannedAt
        ? new Date(d.scannedAt).toLocaleString('en-IN', {
              timeZone: 'Asia/Kolkata',
              dateStyle: 'medium',
              timeStyle: 'short',
          })
        : formatNowLabelIST();
    lines.push(`🕐 *Scanned:* ${scanned} IST`);
    lines.push(`📍 *Mode:* ${d.marketModeLabel || d.marketMode || 'MARKET'}`);
    if (d.discoverySource === 'heatmap2') {
        lines.push('📡 *Discovery:* Heatmap v2 — live intraday · VWAP · RS · ATR');
    } else if (d.discoverySource === 'heatmap') {
        lines.push('📡 *Discovery:* NSE Heatmap + 15m OR / 8 EMA');
    } else if (d.discoverySource === 'preopen') {
        lines.push('📡 *Discovery:* Pre-open auction — IEP · order imbalance');
    } else if (d.discoverySource === 'turnover') {
        lines.push('📡 *Discovery:* Turnover band — ranks 11-30 · EMA 8/21');
    } else if (d.discoverySource === 'nse') {
        lines.push('📡 *Discovery:* NSE NIFTY50 top gainers + losers');
    }
    if (d.freshness?.ok === false) {
        lines.push(`⚠️ *Freshness:* ${d.freshness.message || 'stale data — watch only'}`);
    } else {
        lines.push('🟢 *Data:* fresh');
    }
    lines.push('');

    // Heatmap v2 — different shape from v1: no `status`, targets are 1R/2R,
    // and a pick may legitimately carry no setup before the opening range closes.
    const hm = d.heatmap;
    // Pre-open has no sector sentiment, no regime and no `status` — rendering it
    // through either heatmap branch would print "15m OR / 8 EMA" for a scan that
    // ran before a single bar existed.
    if (hm?.version === 'preopen' && hm.picks?.length) {
        lines.push('┌─ *PRE-OPEN AUCTION* ─');
        lines.push(`│ Auction closed: ${hm.asOf || '09:08'}`);
        lines.push(`│ Board median: ${fmtPct(hm.marketGapPct)}`);
        for (const p of hm.picks) {
            const s = p.setup;
            const book = `book ${p.imbalance >= 0 ? '+' : ''}${Math.round(p.imbalance * 100)}%`;
            lines.push(
                `│ • *${p.symbol}* ${fmtPct(p.relGapPct)} vs board · ` +
                `${String(p.side).toUpperCase()} · ${book} · score ${p.score}`
            );
            if (s) {
                lines.push(`│    E ${s.entry} · SL ${s.stop} · T1 ${s.target1} · T2 ${s.target2}`);
            } else {
                lines.push(`│    IEP ₹${p.iep} · levels unavailable`);
            }
        }
        lines.push('└────────────────────────────');
        lines.push('│ _Auction consensus only — no opening range or VWAP yet._');
        lines.push('');
    } else if (hm?.version === 'turnover' && hm.picks?.length) {
        lines.push('┌─ *TURNOVER BAND* ─');
        lines.push(`│ Ranks ${hm.bandFrom}-${hm.bandTo} of ${hm.scanned} liquid names`);
        for (const p of hm.picks) {
            const s = p.setup;
            lines.push(
                `│ • *${p.symbol}* #${p.rank} · ${String(p.side).toUpperCase()} · ` +
                `₹${p.turnoverCr}cr · trend ${p.strength} ATR · score ${p.score}`
            );
            if (s) lines.push(`│    E ${s.entry} · SL ${s.stop} · T1 ${s.target1} · T2 ${s.target2}`);
        }
        lines.push('└────────────────────────────');
        lines.push('│ _Daily EMA trend — no intraday confirmation yet._');
        lines.push('');
    } else if (hm?.version === 2 && hm.picks?.length) {
        lines.push('┌─ *HEATMAP v2 — LIVE BREAKOUTS* ─');
        lines.push(`│ Sectors: ${hm.sentiment?.label || 'n/a'} (G${hm.sentiment?.green ?? '?'} / R${hm.sentiment?.red ?? '?'})`);
        lines.push(`│ Regime: ${hm.regime?.label || 'n/a'}`);
        if (hm.preOpeningRange) {
            lines.push('│ ⏳ Opening range still forming — watchlist only');
        }
        for (const p of hm.picks) {
            const s = p.setup;
            const rs = p.relStrength != null ? ` · RS ${fmtPct(p.relStrength)}` : '';
            if (!s) {
                lines.push(`│ • *${p.symbol}* ${fmtPct(p.changePct)} · ${String(p.side).toUpperCase()}${rs} · watch`);
                continue;
            }
            lines.push(
                `│ • *${p.symbol}* ${fmtPct(p.changePct)} · ${s.direction.toUpperCase()} · score ${s.score}${rs}`
            );
            lines.push(`│    E ${s.entry} · SL ${s.stop} · T1 ${s.target1} · T2 ${s.target2}`);
        }
        lines.push('└────────────────────────────');
        lines.push('');
    } else if (hm?.picks?.length) {
        lines.push('┌─ *HEATMAP + 15m OR / 8 EMA* ─');
        lines.push(`│ Bias: ${hm.sentiment?.label || 'n/a'} (G${hm.sentiment?.green ?? '?'} / R${hm.sentiment?.red ?? '?'})`);
        for (const p of hm.picks) {
            const s = p.setup || {};
            const chg = p.changePct != null ? fmtPct(p.changePct) : '';
            const st = s.status || 'watch';
            const dir = (s.direction || p.side || '').toUpperCase();
            let row = `│ • *${p.symbol}* ${chg} · ${dir} · ${st} (${s.score ?? 0})`;
            if (s.entry != null) row += ` · E ${s.entry} SL ${s.stop}`;
            lines.push(row);
        }
        lines.push('└────────────────────────────');
        lines.push('');
    }

    // NSE G/L (when discovery source = nse)
    const gl = d.niftyGl;
    if (gl && (gl.gainers?.length || gl.losers?.length)) {
        lines.push('┌─ *NSE NIFTY 50 GAINERS / LOSERS* ─');
        if (gl.timestamp) lines.push(`│ As of: ${gl.timestamp}`);
        for (const g of gl.gainers || []) {
            lines.push(`│ ▲ *${g.symbol}* ${fmtPct(g.changePct)}${g.last != null ? ` · ₹${g.last}` : ''}`);
        }
        for (const l of gl.losers || []) {
            lines.push(`│ ▼ *${l.symbol}* ${fmtPct(l.changePct)}${l.last != null ? ` · ₹${l.last}` : ''}`);
        }
        lines.push('└────────────────────────────');
        lines.push('');
    }

    // Macro block
    // Built separately so an empty macro (pre-open runs before the index ticks)
    // renders nothing at all rather than a bare header/footer pair.
    const macro = d.macro || {};
    const macroLines = [];
    if (macro.nifty?.pct != null) {
        macroLines.push(`│ NIFTY 50: *${fmtPct(macro.nifty.pct)}*`);
    }
    if (macro.vix?.last != null) {
        macroLines.push(`│ India VIX: *${macro.vix.last}*`);
    }
    if (macro.fiiNet != null) macroLines.push(`│ FII: *${fmtCr(macro.fiiNet)}*`);
    if (macro.diiNet != null) macroLines.push(`│ DII: *${fmtCr(macro.diiNet)}*`);
    if (macro.bias) {
        macroLines.push(
            `│ Bias: *${macro.bias.emoji} ${macro.bias.label}* (${macro.bias.score >= 0 ? '+' : ''}${macro.bias.score})`
        );
    }
    if (macroLines.length) {
        lines.push('┌─ *MACRO PULSE* ─────────────');
        lines.push(...macroLines);
        lines.push('└────────────────────────────');
        lines.push('');
    }

    // Delta
    if (d.delta?.lines?.length) {
        lines.push('📊 *What changed*');
        for (const ln of d.delta.lines) {
            lines.push(`  • ${ln}`);
        }
        lines.push('');
    }

    // Hot sectors
    const hot = d.hotSectors?.hot || [];
    if (hot.length) {
        lines.push('🔥 *HOT SECTORS*');
        for (const sec of hot) {
            const leaders = (sec.gainers || [])
                .slice(0, 3)
                .map((g) => `*${g.symbol}* ${fmtPct(g.changePct)}`)
                .join(' · ');
            lines.push(`  ▲ *${sec.label}* ${fmtPct(sec.indexPct)}`);
            if (leaders) lines.push(`     ${leaders}`);
        }
        lines.push('');
    }

    const cold = d.hotSectors?.cold || [];
    if (cold.length) {
        lines.push('🧊 *LAGGING SECTORS*');
        for (const sec of cold.slice(0, 3)) {
            lines.push(`  ▼ ${sec.label} ${fmtPct(sec.indexPct)}`);
        }
        lines.push('');
    }

    // Phase 4 picks
    if (d.phase4Picks?.length) {
        lines.push('🎯 *PHASE-4 TOP PICKS*');
        for (const p of d.phase4Picks.slice(0, 5)) {
            const score = Math.round(Number(p.score) || 0);
            lines.push(
                `  • *${p.symbol}* (${p.sector || '—'}) score ${score}` +
                    (p.changePct != null ? ` · ${fmtPct(p.changePct)}` : '')
            );
        }
        lines.push('');
    }

    // Momentum
    if (d.momentumAlerts?.length) {
        lines.push('⚡ *MOMENTUM SCANNER*');
        for (const m of d.momentumAlerts.slice(0, 6)) {
            lines.push(
                `  • *${m.symbol}* ${fmtPct(m.changePct)}` +
                    (m.rs != null ? ` RS${m.rs >= 0 ? '+' : ''}${m.rs.toFixed(1)}%` : '') +
                    (m.turnoverCr != null ? ` · ₹${m.turnoverCr}Cr` : '')
            );
        }
        lines.push('');
    }

    // Smart money
    if (d.smartMoney?.deals?.length) {
        lines.push('💰 *SMART MONEY (Bulk/Block)*');
        for (const deal of d.smartMoney.deals.slice(0, 5)) {
            const val = deal.valueCr != null ? ` ₹${deal.valueCr} Cr` : '';
            lines.push(`  • *${deal.symbol}* ${deal.kind}${val}`);
        }
        lines.push('');
    }

    // Catalyst radar
    if (d.catalystHighlights?.length) {
        lines.push('📰 *CATALYST RADAR*');
        for (const h of d.catalystHighlights.slice(0, 5)) {
            lines.push(`  ${h}`);
        }
        lines.push('');
    }

    // Final watchlist
    lines.push('📋 *TODAY\'S WATCHLIST*');
    if (d.symbols?.length) {
        lines.push(`  ${d.symbols.join(' · ')}`);
    } else {
        // A bare "n/a" gave no way to tell a filtered-out day from a broken
        // scan. The reject tally answers that in one line.
        lines.push('  _No qualifying names right now._');
        const r = d.heatmap?.rejects;
        if (r) {
            const why = [
                r.flat ? `${r.flat} moving too little` : null,
                r.noSetup ? `${r.noSetup} with no confirmed breakout` : null,
                r.lowScore ? `${r.lowScore} below the score floor` : null,
                r.wrongRs ? `${r.wrongRs} lagging the index` : null,
                r.illiquid ? `${r.illiquid} too illiquid` : null,
                r.noData ? `${r.noData} with no price data` : null,
                // pre-open reject reasons
                r.thinAuction ? `${r.thinAuction} with too thin an auction` : null,
                r.noRelMove ? `${r.noRelMove} moving with the board` : null,
                r.bookDisagrees ? `${r.bookDisagrees} where the order book disagreed` : null,
                r.lopsided ? `${r.lopsided} with a one-sided book` : null,
                r.noBook ? `${r.noBook} with no resting orders` : null,
                // turnover-band reject reasons
                r.emaFlat ? `${r.emaFlat} with EMAs disagreeing` : null,
                r.outsideBand ? `${r.outsideBand} outside the turnover band` : null,
                r.noAtr ? `${r.noAtr} with no ATR` : null,
            ].filter(Boolean);
            if (why.length) {
                const scanned = d.heatmap.candidatesScanned ?? d.heatmap.scanned ?? '?';
                lines.push(`  _Of ${scanned} scanned: ${why.join(', ')}._`);
            }
        }
    }
    if (d.hiddenGem) {
        lines.push(`  💎 *Gem:* ${d.hiddenGem}${d.hiddenGemReason ? ` — _${d.hiddenGemReason}_` : ''}`);
    }
    lines.push('');

    if (d.symbolMeta?.length) {
        lines.push('🔍 *PICK SOURCES*');
        for (const m of d.symbolMeta.slice(0, 12)) {
            const conf = m.confluence != null ? ` conf ${m.confluence}` : '';
            lines.push(`  • ${m.symbol}: ${m.sources?.join(', ') || 'mover'}${conf}`);
        }
        lines.push('');
    }

    lines.push('─────────────────────────────');
    lines.push(
        `_Gates: confluence ≥${d.gates?.minConfluence ?? 40} · AI confidence ≥${d.gates?.minConfidence ?? 70}%_`
    );
    lines.push('_Full CE+PE analysis at alert time; only VALID high-confluence BUYs posted._');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    return lines.join('\n');
}

/**
 * Shorter intro sent before daily analysis in groups.
 */
export function formatDailyScanIntro(discovery, { symbols = [], hiddenGem, hiddenGemReason, maxSends = 5 } = {}) {
    const preview = formatTradeScanPreview({
        ...discovery,
        symbols,
        hiddenGem,
        hiddenGemReason,
    });

    const header =
        `📡 *Daily F&O Scan* · ${formatNowLabelIST()}\n` +
        `_Analyzing ${symbols.length} names — may take several minutes._\n\n`;

    const macro = discovery?.macro;
    let brief = '';
    if (macro?.bias) {
        brief += `${macro.bias.emoji} *${macro.bias.label}* market`;
        if (macro.nifty?.pct != null) brief += ` · NIFTY ${fmtPct(macro.nifty.pct)}`;
        brief += '\n';
    }
    if (discovery?.hotSectors?.hot?.length) {
        const top = discovery.hotSectors.hot
            .slice(0, 3)
            .map((s) => `${s.label} ${fmtPct(s.indexPct)}`)
            .join(' · ');
        brief += `🔥 Hot: ${top}\n`;
    }
    brief += `📋 Scan: *${symbols.join(', ')}*\n`;
    if (hiddenGem) {
        brief += `💎 Gem hunt: *${hiddenGem}*${hiddenGemReason ? ` — _${hiddenGemReason}_` : ''}\n`;
    }
    brief += `_Max ${maxSends} actionable alerts · confluence + ≥70% AI_\n\n`;

    return brief + preview;
}

export function formatAlertMetaFooter(meta = {}) {
    const parts = [];
    if (meta.entryState?.label) parts.push(meta.entryState.label);
    if (meta.confluence != null) parts.push(`Confluence: ${meta.confluence}/100`);
    if (meta.freshness) parts.push(`Fresh: ${meta.freshness}`);
    if (!parts.length) return '';
    return `\n📋 _${parts.join(' · ')}_`;
}

/** Premium quotes older than this get an explicit staleness warning. */
export const STALE_PREMIUM_MIN = 10;

/** HH:MM:SS in IST. Seconds matter here — delivery lag is measured in seconds. */
export function istClock(ms = Date.now()) {
    const d = new Date(ms + 5.5 * 3600e3);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/**
 * Timing block for a trade alert.
 *
 * Three different clocks, because they answer different questions:
 *   scanned  — when the setup was found
 *   priced   — NSE's own timestamp for the CE/PE premiums on this card
 *   sent     — when the bot handed the message to WhatsApp
 *
 * The gap between `sent` and the time the message actually appears in the group
 * is delivery lag, which is exactly what was impossible to see before: a card
 * showing an entry premium gave no clue whether that price was 5 seconds or 5
 * minutes old by the time it was read.
 *
 * @param {{ scannedAt?: Date|string|number, chainTimestamp?: string, pricedAt?: Date|string|number, sentAt?: Date|string|number }} t
 */
export function formatAlertTimings(timings = {}) {
    // A default parameter only fires for undefined, so an explicit null still
    // reaches the body — and `meta?.timings` yields null readily enough.
    const t = timings || {};
    const toMs = (v) => {
        if (v == null) return null;
        const ms = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v);
        return Number.isFinite(ms) ? ms : null;
    };
    const rows = [];
    const scanned = toMs(t.scannedAt);
    if (scanned) rows.push(`🔍 Scanned ${istClock(scanned)}`);

    // NSE ships its timestamp as a display string ("12-Aug-2026 15:29:59"); keep its
    // own clock rather than reformatting a value we cannot reliably parse.
    if (t.chainTimestamp) {
        const clock = String(t.chainTimestamp).match(/(\d{1,2}:\d{2}(?::\d{2})?)/)?.[1];
        rows.push(`💰 Priced ${clock || t.chainTimestamp}`);
    } else {
        const priced = toMs(t.pricedAt);
        if (priced) rows.push(`💰 Priced ${istClock(priced)}`);
    }

    const sent = toMs(t.sentAt);
    if (sent) rows.push(`📤 Sent ${istClock(sent)}`);

    if (!rows.length) return '';
    let out = `\n🕐 _${rows.join('  ·  ')} IST_`;

    // Say it plainly when the quote is old. Discovering a 5-hour-old premium by
    // mentally subtracting two timestamps is exactly the work this should remove.
    const ageMin = premiumAgeMinutes(t.chainTimestamp, t.nowMs ?? Date.now());
    if (ageMin != null && ageMin >= STALE_PREMIUM_MIN) {
        const label = ageMin >= 120 ? `${Math.floor(ageMin / 60)}h ${ageMin % 60}m` : `${ageMin}m`;
        out += `\n⚠️ _Premiums are ${label} old — re-check the chain before entering._`;
    }
    return out;
}

/**
 * Stamp the send time onto a finished alert, at the moment of sending.
 *
 * Appending at send time rather than substituting a placeholder is deliberate: a
 * caller that forgets this leaves the line off, instead of leaking a raw
 * `{{SENT_AT}}` token into a subscriber's chat.
 */
export function withSentStamp(text, sentAt = Date.now()) {
    const body = String(text ?? '');
    if (!body.trim()) return body;
    // Deliberately does NOT claim the premiums were live at this moment. When the
    // market is shut, NSE returns the previous session's clock, so a card sent at
    // 20:51 can be quoting 15:40 prices — asserting freshness here would be false
    // in exactly the case this stamp exists to expose. The Priced clock above says
    // when the premiums were real; this one only says when the card left.
    return `${body}\n🕐 _Sent ${istClock(sentAt)} IST_`;
}

/** NSE ships "12-Aug-2026 15:40:00". Returns epoch ms in IST, or null. */
export function parseNseTimestamp(raw) {
    const m = String(raw || '').match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (!m) return null;
    const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    const mon = months[m[2].toLowerCase()];
    if (mon === undefined) return null;
    // The string is IST wall-clock, so build it as UTC then subtract the offset.
    const utc = Date.UTC(Number(m[3]), mon, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6] || 0));
    return utc - 5.5 * 3600e3;
}

/** Minutes between the quote and now, or null when unknown. */
export function premiumAgeMinutes(chainTimestamp, nowMs = Date.now()) {
    const ms = parseNseTimestamp(chainTimestamp);
    if (ms == null) return null;
    return Math.round((nowMs - ms) / 60_000);
}
