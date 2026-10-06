/**
 * News catalyst classification (trading-copilot patterns).
 */

const BULLISH_TYPES = {
    ORDER_WIN: /order win|wins order|bagged order|crore order|contract award|awarded contract/i,
    BROKER_UPGRADE: /upgrade|target raised|target upgrade|outperform|overweight|accumulate/i,
    RESULT_BEAT: /result beat|profit rises|earnings beat|q[1-4] profit/i,
    STAKE_BUY: /stake buy|acquires stake|promoter buying/i,
    REGULATORY_APPROVAL: /approval granted|regulatory approval|fda approval/i,
    DIVIDEND: /dividend|bonus issue|stock split/i,
};

const BEARISH_TYPES = {
    BROKER_DOWNGRADE: /downgrade|target cut|underperform|underweight|sell rating/i,
    REGULATORY_RISK: /probe|penalty|fine|sebi notice|regulatory risk|fraud/i,
    RESULT_MISS: /profit falls|loss widens|misses estimate|disappointing results/i,
    STAKE_SALE: /stake sale|promoter selling|ofs\b|block sale/i,
};

const TYPE_RANK = {
    ORDER_WIN: 92,
    BROKER_UPGRADE: 85,
    RESULT_BEAT: 75,
    STAKE_BUY: 88,
    REGULATORY_APPROVAL: 84,
    DIVIDEND: 70,
    BROKER_DOWNGRADE: 82,
    REGULATORY_RISK: 80,
    RESULT_MISS: 78,
    STAKE_SALE: 86,
};

function classifyHeadline(text) {
    const t = String(text || '');
    for (const [type, re] of Object.entries(BULLISH_TYPES)) {
        if (re.test(t)) return { type, side: 'BULLISH', priority: TYPE_RANK[type] || 50 };
    }
    for (const [type, re] of Object.entries(BEARISH_TYPES)) {
        if (re.test(t)) return { type, side: 'BEARISH', priority: TYPE_RANK[type] || 50 };
    }
    if (/sector|industry|theme/i.test(t)) {
        return { type: 'SECTOR_NEWS', side: 'NEUTRAL', priority: 20 };
    }
    return { type: 'GENERAL_NEWS', side: 'NEUTRAL', priority: 10 };
}

function extractSymbols(text, knownSymbols = new Set()) {
    const found = new Set();
    const upper = String(text || '').toUpperCase();
    for (const sym of knownSymbols) {
        if (upper.includes(sym)) found.add(sym);
    }
    const tickerRe = /\b([A-Z]{2,12})\b/g;
    let m;
    while ((m = tickerRe.exec(upper))) {
        const sym = m[1];
        if (knownSymbols.has(sym)) found.add(sym);
    }
    return [...found];
}

class CatalystRadarService {
    /**
     * @param {string[]} headlines
     * @param {Set<string>} symbolUniverse
     */
    scanHeadlines(headlines, symbolUniverse = new Set()) {
        const items = [];
        for (const headline of headlines || []) {
            const text = typeof headline === 'string' ? headline : headline?.title || headline?.text || '';
            if (!text.trim()) continue;
            const cat = classifyHeadline(text);
            const symbols = extractSymbols(text, symbolUniverse);
            items.push({
                headline: text.slice(0, 120),
                ...cat,
                symbols,
            });
        }
        return items.sort((a, b) => b.priority - a.priority);
    }

    /**
     * @param {object[]} catalystItems
     * @param {string} symbol
     */
    getSymbolCatalyst(symbol, catalystItems) {
        const sym = String(symbol || '').toUpperCase();
        const hits = (catalystItems || []).filter((c) => c.symbols?.includes(sym));
        const bearish = hits.find((h) => h.side === 'BEARISH' && h.priority >= 75);
        const bullish = hits.find((h) => h.side === 'BULLISH');
        return {
            hits,
            avoid: Boolean(bearish),
            avoidReason: bearish?.type || null,
            boost: bullish ? Math.min(30, Math.round(bullish.priority / 3)) : 0,
            topCatalyst: hits[0] || null,
        };
    }

    formatHighlights(items, limit = 5) {
        return (items || [])
            .filter((i) => i.side !== 'NEUTRAL' && i.symbols?.length)
            .slice(0, limit)
            .map((i) => {
                const side = i.side === 'BULLISH' ? '🟢' : '🔴';
                return `${side} ${i.symbols.join('/')} — ${i.type.replace(/_/g, ' ')}`;
            });
    }
}

export const catalystRadarService = new CatalystRadarService();
export default CatalystRadarService;
