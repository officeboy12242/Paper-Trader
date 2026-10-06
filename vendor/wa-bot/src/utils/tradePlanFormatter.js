/**
 * Multi-target trade plan blocks (1 lot, 50/30/20 booking, ₹ P&L).
 */

import { getNseLotSize } from '../data/nseLotSizes.js';

const CE_SECTION =
    /(━━━\s*CALL\s*\(CE\)\s*SETUP\s*━━━[\s\S]*?)(?=━━━\s*PUT\s*\(PE\)\s*SETUP|Primary Pick:|$)/i;
const PE_SECTION =
    /(━━━\s*PUT\s*\(PE\)\s*SETUP\s*━━━[\s\S]*?)(?=Primary Pick:|$)/i;

const DEFAULT_PARTIALS = [50, 30, 20];

function parsePremium(raw) {
    if (raw == null) {
        return null;
    }
    const m = String(raw).replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
    return m ? Number(m[1]) : null;
}

function parseField(block, names) {
    for (const name of names) {
        const re = new RegExp(`^${name}:\\s*(.+)$`, 'im');
        const match = block.match(re);
        if (match) {
            return match[1].trim();
        }
    }
    return null;
}

function parseVerdict(block) {
    const line = parseField(block, ['Verdict']) || '';
    if (/AVOID/i.test(line)) {
        return 'AVOID';
    }
    if (/WEAK/i.test(line)) {
        return 'WEAK';
    }
    if (/BUY/i.test(line)) {
        return 'BUY';
    }
    return 'UNKNOWN';
}

function parseTargets(block, entry) {
    const t1 = parsePremium(parseField(block, ['Target 1', 'Target1', 'T1']));
    const t2 = parsePremium(parseField(block, ['Target 2', 'Target2', 'T2']));
    const t3 = parsePremium(parseField(block, ['Target 3', 'Target3', 'T3']));
    const legacy = parsePremium(parseField(block, ['Target']));

    if (t1 != null && t2 != null && t3 != null) {
        return { t1, t2, t3 };
    }

    const top = t3 ?? legacy ?? t2 ?? t1;
    if (top == null || entry == null) {
        return { t1: t1 ?? null, t2: t2 ?? null, t3: t3 ?? null };
    }

    const diff = Math.abs(top - entry);
    if (diff <= 0) {
        return { t1: top, t2: top, t3: top };
    }

    const sign = top >= entry ? 1 : -1;
    return {
        t1: t1 ?? Number((entry + sign * diff * 0.35).toFixed(2)),
        t2: t2 ?? Number((entry + sign * diff * 0.65).toFixed(2)),
        t3: top,
    };
}

function formatRupee(n) {
    const rounded = Math.round(n);
    const sign = rounded >= 0 ? '+' : '−';
    return `${sign}₹${Math.abs(rounded).toLocaleString('en-IN')}`;
}

function formatPremium(n) {
    if (n == null) {
        return 'n/a';
    }
    const val = Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '');
    return `₹${val}`;
}

function profitAt(entry, target, lotSize) {
    if (entry == null || target == null || lotSize == null) {
        return null;
    }
    return (target - entry) * lotSize;
}

function formatRiskReward(entry, sl, t1, lotSize) {
    const loss = profitAt(entry, sl, lotSize);
    const gain = profitAt(entry, t1, lotSize);
    if (loss == null || gain == null || loss >= 0 || gain <= 0) {
        return null;
    }
    const ratio = Math.abs(gain / loss);
    return `1:${ratio.toFixed(1)} (to T1)`;
}

/**
 * @param {{ leg: 'CE'|'PE', entry: number|null, sl: number|null, t1: number|null, t2: number|null, t3: number|null, lotSize: number, verdict: string, partials?: number[] }} opts
 */
export function formatTradePlanBlock(opts) {
    const { leg, entry, sl, t1, t2, t3, lotSize, verdict } = opts;
    const partials = opts.partials || DEFAULT_PARTIALS;

    if (entry == null || lotSize == null) {
        return '';
    }

    const lines = [];
    const legLabel = leg === 'CE' ? 'CE' : 'PE';
    lines.push(`📋 *${legLabel} Trade Plan (1 lot · ${lotSize} qty)*`);

    const capital = entry * lotSize;
    lines.push(`Capital: ~*₹${Math.round(capital).toLocaleString('en-IN')}* (${formatPremium(entry)} × ${lotSize})`);
    lines.push('');
    lines.push('🎯 *Targets*');

    const targets = [
        { key: 'T1', premium: t1, pct: partials[0] ?? 50 },
        { key: 'T2', premium: t2, pct: partials[1] ?? 30 },
        { key: 'T3', premium: t3, pct: partials[2] ?? 20 },
    ];

    for (const row of targets) {
        if (row.premium == null) {
            continue;
        }
        const pnl = profitAt(entry, row.premium, lotSize);
        const bookedQty = Math.round((lotSize * row.pct) / 100);
        const pnlStr = pnl != null ? formatRupee(pnl) : 'n/a';
        lines.push(
            `• ${row.key} → ${formatPremium(row.premium)}  │  ${pnlStr}  │  book *${row.pct}%* (${bookedQty} qty)`
        );
    }

    lines.push('');
    if (sl != null) {
        const maxLoss = profitAt(entry, sl, lotSize);
        if (maxLoss != null) {
            const abs = Math.abs(Math.round(maxLoss));
            lines.push(
                `🛑 SL ${formatPremium(sl)}  │  max loss ~*₹${abs.toLocaleString('en-IN')}* (full lot)`
            );
        }
    }

    const rr = formatRiskReward(entry, sl, t1, lotSize);
    if (rr) {
        lines.push(`R:R ≈ ${rr}`);
    }

    if (verdict === 'AVOID') {
        lines.push('_Note: AVOID — plan for reference only._');
    } else if (verdict === 'WEAK') {
        lines.push('_Note: WEAK — wait for better confirmation._');
    }

    return lines.join('\n');
}

function stripLegacyTargetLines(block) {
    return block
        .replace(/^Target:\s*.+$/gim, '')
        .replace(/^Target 1:\s*.+$/gim, '')
        .replace(/^Target 2:\s*.+$/gim, '')
        .replace(/^Target 3:\s*.+$/gim, '')
        .replace(/\n{3,}/g, '\n\n');
}

function injectPlanIntoSection(sectionText, leg, symbol, partials) {
    const lotSize = getNseLotSize(symbol);
    const entry = parsePremium(parseField(sectionText, ['Entry']));
    const sl = parsePremium(parseField(sectionText, ['Stop Loss', 'SL']));
    const { t1, t2, t3 } = parseTargets(sectionText, entry);
    const verdict = parseVerdict(sectionText);

    const plan = formatTradePlanBlock({
        leg,
        entry,
        sl,
        t1,
        t2,
        t3,
        lotSize,
        verdict,
        partials,
    });

    if (!plan) {
        return sectionText;
    }

    let block = stripLegacyTargetLines(sectionText);

    if (block.includes('📋 *CE Trade Plan') || block.includes('📋 *PE Trade Plan')) {
        block = block.replace(/\n📋 \*(CE|PE) Trade Plan[\s\S]*?(?=\nWhy:|\n━━━|$)/i, '\n');
    }

    const whyIdx = block.search(/\nWhy:\s*\n/i);
    if (whyIdx >= 0) {
        return `${block.slice(0, whyIdx)}\n\n${plan}\n${block.slice(whyIdx)}`;
    }

    return `${block.trim()}\n\n${plan}\n`;
}

/**
 * Inject CE + PE trade plan blocks into AI analysis body.
 * @param {string} body
 * @param {string} symbol
 * @param {{ partials?: number[] }} [opts]
 */
export function injectTradePlans(body, symbol, opts = {}) {
    if (!body?.trim()) {
        return body;
    }

    const partials = opts.partials || DEFAULT_PARTIALS;
    let out = body;

    const ceMatch = out.match(CE_SECTION);
    if (ceMatch) {
        const updated = injectPlanIntoSection(ceMatch[1], 'CE', symbol, partials);
        out = out.replace(CE_SECTION, updated);
    }

    const peMatch = out.match(PE_SECTION);
    if (peMatch) {
        const updated = injectPlanIntoSection(peMatch[1], 'PE', symbol, partials);
        out = out.replace(PE_SECTION, updated);
    }

    return out;
}

export { parsePremium, parseTargets, profitAt };
