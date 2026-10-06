/**
 * Parse CE/PE dual-scenario trade analysis from AI output.
 */

const MIN_CONFIDENCE = 70;

/** Keep mega-obvious names out of AI gem slot */
const MEGA_OBVIOUS_FOR_GEM = new Set([
    'NIFTY', 'BANKNIFTY', 'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK',
    'SBIN', 'ITC', 'HINDUNILVR', 'BHARTIARTL', 'KOTAKBANK',
]);

function parseSectionConfidence(text, sectionPattern) {
    const block = text.match(sectionPattern)?.[0] || '';
    const conf = block.match(/Confidence:\s*(\d{1,3})\s*%?/i)?.[1];
    return conf ? Math.min(100, parseInt(conf, 10)) : 0;
}

function parseSectionVerdict(text, sectionPattern) {
    const block = text.match(sectionPattern)?.[0] || '';
    const verdict = block.match(/Verdict:\s*(.+)/i)?.[1]?.trim() || '';
    const isBuy = /✅\s*BUY/i.test(verdict) && !/AVOID/i.test(verdict);
    return { verdict, isBuy };
}

/**
 * @param {string} body        AI analysis card
 * @param {{minConfidence?: number}} [opts]
 *   Gate for "actionable". Defaults to MIN_CONFIDENCE (70) so every existing
 *   caller is unchanged; the continuous auto-trigger passes its own threshold.
 */
export function parseTradeSignal(body, { minConfidence = MIN_CONFIDENCE } = {}) {
    const text = String(body || '');
    const gate = Number.isFinite(minConfidence) ? minConfidence : MIN_CONFIDENCE;

    const ceBlock = /━━━\s*CALL\s*\(CE\)\s*SETUP\s*━━━[\s\S]*?(?=━━━\s*PUT|Primary Pick:|$)/i;
    const peBlock = /━━━\s*PUT\s*\(PE\)\s*SETUP\s*━━━[\s\S]*?(?=Primary Pick:|$)/i;

    const ceConf = parseSectionConfidence(text, ceBlock);
    const peConf = parseSectionConfidence(text, peBlock);
    const ce = parseSectionVerdict(text, ceBlock);
    const pe = parseSectionVerdict(text, peBlock);

    const primaryLine = text.match(/Primary Pick:\s*(.+)/i)?.[1]?.trim() || '';
    const primaryConfMatch = text.match(/Primary Confidence:\s*(\d{1,3})\s*%?/i);
    const primaryConfidence = primaryConfMatch
        ? Math.min(100, parseInt(primaryConfMatch[1], 10))
        : Math.max(ceConf, peConf);

    const isBuyCall =
        (/BUY\s*CE/i.test(primaryLine) && !/NO\s*TRADE/i.test(primaryLine)) ||
        (ce.isBuy && ceConf >= gate);
    const isBuyPut =
        (/BUY\s*PE/i.test(primaryLine) && !/NO\s*TRADE/i.test(primaryLine)) ||
        (pe.isBuy && peConf >= gate);
    const isNoTrade =
        /NO\s*TRADE/i.test(primaryLine) ||
        (!isBuyCall && !isBuyPut && primaryConfidence < gate);

    const isActionable =
        (isBuyCall || isBuyPut) &&
        primaryConfidence >= gate &&
        !/NO\s*TRADE/i.test(primaryLine);

  // Fallback: strong CE or PE even if Primary line missing
    const actionableFallback =
        (ce.isBuy && ceConf >= gate) || (pe.isBuy && peConf >= gate);

    return {
        confidence: primaryConfidence,
        ceConfidence: ceConf,
        peConfidence: peConf,
        isBuyCall: isBuyCall || (ce.isBuy && ceConf >= gate),
        isBuyPut: isBuyPut || (pe.isBuy && peConf >= gate),
        isNoTrade: isNoTrade && !actionableFallback,
        isActionable: isActionable || actionableFallback,
        recommendation: primaryLine || (isBuyCall ? 'BUY CE' : isBuyPut ? 'BUY PE' : 'NO TRADE'),
        ceVerdict: ce.verdict,
        peVerdict: pe.verdict,
    };
}

/**
 * Extract JSON symbol list from AI discovery response.
 * @returns {string[]}
 */
export function parseDiscoverySymbols(raw) {
    const text = String(raw || '').trim();
    if (!text) return [];

    const jsonBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    const candidate = jsonBlock || text;

    try {
        const parsed = JSON.parse(candidate);
        if (Array.isArray(parsed)) {
            return parsed.map((s) => String(s).trim().toUpperCase()).filter(Boolean);
        }
        if (Array.isArray(parsed.symbols)) {
            return parsed.symbols.map((s) => String(s).trim().toUpperCase()).filter(Boolean);
        }
        if (Array.isArray(parsed.picks)) {
            return parsed.picks
                .map((p) => (typeof p === 'string' ? p : p?.symbol))
                .filter(Boolean)
                .map((s) => String(s).trim().toUpperCase());
        }
    } catch {
        // fall through
    }

    const arrayMatch = candidate.match(/\[[\s\S]*?\]/);
    if (arrayMatch) {
        try {
            const arr = JSON.parse(arrayMatch[0]);
            if (Array.isArray(arr)) {
                return arr.map((s) => String(s).trim().toUpperCase()).filter(Boolean);
            }
        } catch {
            // ignore
        }
    }

    return [];
}

function extractDiscoveryJson(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;

    const jsonBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    const candidate = jsonBlock || text;

    try {
        return JSON.parse(candidate);
    } catch {
        const objectMatch = candidate.match(/\{[\s\S]*\}/);
        if (objectMatch) {
            try {
                return JSON.parse(objectMatch[0]);
            } catch {
                return null;
            }
        }
    }
    return null;
}

/**
 * Extract symbols + optional hidden gem from AI discovery response.
 * @returns {{ symbols: string[], hiddenGem: string|null, hiddenGemReason: string|null }}
 */
export function parseDiscoveryResult(raw) {
    const symbols = parseDiscoverySymbols(raw);
    const parsed = extractDiscoveryJson(raw);
    if (!parsed) {
        return { symbols, hiddenGem: null, hiddenGemReason: null };
    }

    let hiddenGem = null;
    let hiddenGemReason = null;
    const gem = parsed.hidden_gem ?? parsed.hiddenGem ?? null;

    if (typeof gem === 'string' && gem.trim()) {
        hiddenGem = gem.trim().toUpperCase();
    } else if (gem && typeof gem === 'object' && gem.symbol) {
        hiddenGem = String(gem.symbol).trim().toUpperCase();
        hiddenGemReason = String(gem.reason || parsed.reasons?.[hiddenGem] || '').trim() || null;
    }

    if (hiddenGem && MEGA_OBVIOUS_FOR_GEM?.has?.(hiddenGem)) {
        hiddenGem = null;
        hiddenGemReason = null;
    }

    return { symbols, hiddenGem, hiddenGemReason };
}
