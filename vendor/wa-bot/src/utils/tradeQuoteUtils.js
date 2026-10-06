/**
 * Ensure trade analysis uses verified live spot price, not AI guesses.
 */

const CE_SECTION =
    /(━━━\s*CALL\s*\(CE\)\s*SETUP\s*━━━[\s\S]*?)(?=━━━\s*PUT\s*\(PE\)\s*SETUP|Primary Pick:|$)/i;
const PE_SECTION =
    /(━━━\s*PUT\s*\(PE\)\s*SETUP\s*━━━[\s\S]*?)(?=Primary Pick:|$)/i;

function parsePremiumRaw(raw) {
    if (raw == null) return null;
    const m = String(raw).replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
    return m ? Number(m[1]) : null;
}

function parseFieldLine(block, names) {
    for (const name of names) {
        const re = new RegExp(`^${name}:\\s*(.+)$`, 'im');
        const match = block.match(re);
        if (match) return match[1].trim();
    }
    return null;
}

/** True when Entry looks like underlying spot (or nonsense), not option premium. */
export function isBogusOptionPremium(entry, spot) {
    if (entry == null || !Number.isFinite(entry) || entry <= 0) return true;
    if (spot == null || !Number.isFinite(spot) || spot <= 0) return false;
    // Spot pasted as premium, or deep-ITM futures-like number
    if (Math.abs(entry - spot) / spot < 0.08) return true;
    if (entry > spot * 0.22) return true;
    return false;
}

function defaultPremiumLadder(entry) {
    return {
        t1: Number((entry * 1.25).toFixed(2)),
        t2: Number((entry * 1.5).toFixed(2)),
        t3: Number((entry * 1.85).toFixed(2)),
        sl: Number((entry * 0.7).toFixed(2)),
    };
}

function scalePremium(n, scale) {
    if (n == null || !Number.isFinite(n) || !Number.isFinite(scale)) return null;
    return Number((n * scale).toFixed(2));
}

function rewriteOptionSection(section, leg, snapshot) {
    const primary = leg === 'CE' ? snapshot.atmCe : snapshot.atmPe;
    let atm = primary;
    const livePrimary = primary?.ltp != null ? Number(primary.ltp) : null;
    if (!(livePrimary > 0)) {
        const list = leg === 'CE' ? snapshot.topCe : snapshot.topPe;
        const atmStrike = snapshot.atmStrike;
        if (list?.length && atmStrike != null) {
            const near = [...list]
                .filter((r) => r.ltp != null && Number(r.ltp) > 0)
                .sort((a, b) => Math.abs(a.strike - atmStrike) - Math.abs(b.strike - atmStrike))[0];
            if (near) atm = { strike: near.strike, ltp: near.ltp, oi: near.oi, iv: near.iv };
        }
    }
    const liveEntry = atm?.ltp != null ? Number(atm.ltp) : null;
    if (liveEntry == null || !Number.isFinite(liveEntry) || liveEntry <= 0) return section;

    const spot = snapshot.spot != null ? Number(snapshot.spot) : null;
    const strike = atm.strike ?? snapshot.atmStrike;
    const expiry = snapshot.expiry ? String(snapshot.expiry) : '';
    const strikeLine = expiry
        ? `Strike: ${strike} · ${expiry} (ATM · NSE LTP)`
        : `Strike: ${strike} (ATM · NSE LTP)`;

    const oldEntry = parsePremiumRaw(parseFieldLine(section, ['Entry']));
    const oldT1 = parsePremiumRaw(parseFieldLine(section, ['Target 1', 'Target1', 'T1']));
    const oldT2 = parsePremiumRaw(parseFieldLine(section, ['Target 2', 'Target2', 'T2']));
    const oldT3 = parsePremiumRaw(parseFieldLine(section, ['Target 3', 'Target3', 'T3']));
    const oldSl = parsePremiumRaw(parseFieldLine(section, ['Stop Loss', 'SL']));

    let t1 = oldT1;
    let t2 = oldT2;
    let t3 = oldT3;
    let sl = oldSl;

    if (isBogusOptionPremium(oldEntry, spot) || isBogusOptionPremium(oldT1, spot)) {
        ({ t1, t2, t3, sl } = defaultPremiumLadder(liveEntry));
    } else if (oldEntry && Math.abs(oldEntry - liveEntry) / liveEntry > 0.12) {
        const scale = liveEntry / oldEntry;
        t1 = scalePremium(oldT1, scale) ?? defaultPremiumLadder(liveEntry).t1;
        t2 = scalePremium(oldT2, scale) ?? defaultPremiumLadder(liveEntry).t2;
        t3 = scalePremium(oldT3, scale) ?? defaultPremiumLadder(liveEntry).t3;
        sl = scalePremium(oldSl, scale) ?? defaultPremiumLadder(liveEntry).sl;
    }

    let out = section;
    if (/^Strike:\s*/im.test(out)) out = out.replace(/^Strike:\s*.+$/im, strikeLine);
    else out = out.replace(/^(Verdict:\s*.+)$/im, `$1\n${strikeLine}`);

    const entryLine = `Entry: ₹${liveEntry} (NSE ATM LTP)`;
    if (/^Entry:\s*/im.test(out)) out = out.replace(/^Entry:\s*.+$/im, entryLine);
    else out = out.replace(/^(Strike:\s*.+)$/im, `$1\n${entryLine}`);

    if (t1 != null) {
        if (/^Target 1:\s*/im.test(out)) out = out.replace(/^Target 1:\s*.+$/im, `Target 1: ₹${t1}`);
        else if (/^Target1:\s*/im.test(out)) out = out.replace(/^Target1:\s*.+$/im, `Target 1: ₹${t1}`);
    }
    if (t2 != null) {
        if (/^Target 2:\s*/im.test(out)) out = out.replace(/^Target 2:\s*.+$/im, `Target 2: ₹${t2}`);
        else if (/^Target2:\s*/im.test(out)) out = out.replace(/^Target2:\s*.+$/im, `Target 2: ₹${t2}`);
    }
    if (t3 != null) {
        if (/^Target 3:\s*/im.test(out)) out = out.replace(/^Target 3:\s*.+$/im, `Target 3: ₹${t3}`);
        else if (/^Target3:\s*/im.test(out)) out = out.replace(/^Target3:\s*.+$/im, `Target 3: ₹${t3}`);
    }
    if (sl != null) {
        if (/^Stop Loss:\s*/im.test(out)) out = out.replace(/^Stop Loss:\s*.+$/im, `Stop Loss: ₹${sl}`);
        else if (/^SL:\s*/im.test(out)) out = out.replace(/^SL:\s*.+$/im, `Stop Loss: ₹${sl}`);
    }
    return out;
}

/**
 * Pin CE/PE Strike + Entry (+ rescale targets) to live NSE ATM LTP.
 * Stops the model from pasting spot as premium or inventing far-OTM prices.
 * @param {string} body
 * @param {{ atmStrike?: number, expiry?: string, spot?: number, atmCe?: object, atmPe?: object } | null} snapshot
 */
export function enforceLiveOptionPremiums(body, snapshot) {
    if (!body || !snapshot?.atmStrike) return body;
    let out = body;
    const ce = out.match(CE_SECTION);
    if (ce?.[1] && snapshot.atmCe?.ltp != null) {
        out = out.replace(CE_SECTION, rewriteOptionSection(ce[1], 'CE', snapshot));
    }
    const pe = out.match(PE_SECTION);
    if (pe?.[1] && snapshot.atmPe?.ltp != null) {
        out = out.replace(PE_SECTION, rewriteOptionSection(pe[1], 'PE', snapshot));
    }
    return out;
}

/**
 * @param {string} body
 * @param {{ price?: number, changePct?: number | null, currency?: string } | null} quote
 * @returns {string}
 */
export function enforceLiveSpotPrice(body, quote) {
    if (!body || quote?.price == null) return body;

    const currency = quote.currency || 'INR';
    let line = `Spot Price: ${quote.price} ${currency}`;
    if (quote.changePct != null) {
        const sign = quote.changePct >= 0 ? '+' : '';
        line += ` (${sign}${quote.changePct}% today, live market data)`;
    } else {
        line += ' (live market data)';
    }

    if (/Spot Price:/i.test(body)) {
        return body.replace(/^Spot Price:.*$/im, line);
    }

    if (/^Stock:/im.test(body)) {
        return body.replace(/^(Stock:.*)$/im, `$1\n${line}`);
    }

    return `${line}\n${body}`;
}

/**
 * @param {{ price?: number, changePct?: number | null, currency?: string } | null} quote
 * @returns {string}
 */
export function formatMandatorySpotLine(quote) {
    if (quote?.price == null) {
        return 'MANDATORY: No live spot price — you MUST output ❌ NO TRADE only. Do not guess price.';
    }
    const currency = quote.currency || 'INR';
    const pct =
        quote.changePct != null
            ? `, ${quote.changePct >= 0 ? '+' : ''}${quote.changePct}% today`
            : '';
    return (
        `MANDATORY Spot Price line — copy EXACTLY (do not use analyst targets or old prices):\n` +
        `Spot Price: ${quote.price} ${currency}${pct} (live market data)`
    );
}
