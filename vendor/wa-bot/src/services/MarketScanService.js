/**
 * Scan liquid NSE F&O names for movers + index context (Yahoo Finance).
 */

import { logger } from '../utils/logger.js';
import { indianStockQuoteService } from './IndianStockQuoteService.js';
import { stockNewsService } from './StockNewsService.js';

const BATCH = 6;

/** Liquid F&O names scanned for today's % movers (refreshed every discovery run) */
export const FNO_UNIVERSE = [
    'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'HINDUNILVR', 'ITC', 'SBIN',
    'BHARTIARTL', 'KOTAKBANK', 'LT', 'AXISBANK', 'ASIANPAINT', 'MARUTI', 'TITAN',
    'SUNPHARMA', 'BAJFINANCE', 'WIPRO', 'HCLTECH', 'ULTRACEMCO', 'ONGC', 'NTPC',
    'POWERGRID', 'TMPV', 'TMCV', 'M&M', 'ADANIENT', 'ADANIPORTS', 'COALINDIA', 'TATASTEEL',
    'JSWSTEEL', 'HINDALCO', 'INDUSINDBK', 'BPCL', 'GRASIM', 'DIVISLAB', 'CIPLA',
    'DRREDDY', 'EICHERMOT', 'HEROMOTOCO', 'BAJAJFINSV', 'SBILIFE', 'HDFCLIFE',
    'TECHM', 'APOLLOHOSP', 'BRITANNIA', 'NESTLEIND', 'TRENT', 'BEL', 'DLF', 'VEDL',
    'HAL', 'IRFC', 'RVNL', 'JIOFIN', 'PNB', 'BANKBARODA', 'AMBUJACEM', 'GODREJCP',
    'SIEMENS', 'ABB', 'POLYCAB', 'DABUR', 'PIDILITIND', 'SHREECEM',
];

const INDICES = ['NIFTY', 'BANKNIFTY'];

/** Too obvious for "hidden gem" tag — still scannable, just not gem candidates */
export const MEGA_OBVIOUS_SYMBOLS = new Set([
    'NIFTY', 'BANKNIFTY', 'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK',
    'SBIN', 'ITC', 'HINDUNILVR', 'BHARTIARTL', 'KOTAKBANK',
]);

/** Minimum score to designate a hidden gem for the daily hunt */
const MIN_HIDDEN_GEM_SCORE = 35;

async function fetchQuoteRow(symbol) {
    const quote = await indianStockQuoteService.fetchQuote(symbol);
    if (!quote) return null;
    return {
        symbol: quote.symbol,
        name: quote.displayName,
        price: quote.price,
        changePct: quote.changePct,
        volume: quote.volume,
    };
}

async function mapPool(items, fn, poolSize = BATCH) {
    const results = [];
    for (let i = 0; i < items.length; i += poolSize) {
        const chunk = items.slice(i, i + poolSize);
        const rows = await Promise.all(chunk.map(fn));
        results.push(...rows.filter(Boolean));
    }
    return results;
}

class MarketScanService {
    /**
     * Full market snapshot for AI stock discovery.
     * @returns {Promise<{ context: string, movers: object[], indices: object[], marketNews: string }>}
     */
    async buildDiscoverySnapshot() {
        logger.info('📡 Market scan: fetching indices, movers, live news…');

        const [indexRows, universeRows, marketNews] = await Promise.all([
            mapPool(INDICES, (s) => indianStockQuoteService.fetchQuoteContext(s).then((q) => {
                if (!q) return null;
                return { symbol: s, context: q.context, name: q.displayName };
            })),
            mapPool(FNO_UNIVERSE, fetchQuoteRow),
            stockNewsService.fetchMarketHeadlines(),
        ]);

        const withChange = universeRows.filter((r) => r.changePct != null);
        const sorted = [...withChange].sort((a, b) => b.changePct - a.changePct);
        const gainers = sorted.filter((r) => r.changePct > 0).slice(0, 12);
        const losers = [...withChange].sort((a, b) => a.changePct - b.changePct).slice(0, 12);

        const lines = [];
        lines.push('=== INDICES ===');
        for (const idx of indexRows) {
            lines.push(`[${idx.symbol}] ${idx.context.replace(/\n/g, ' | ')}`);
        }

        lines.push('\n=== TOP GAINERS (% change today) ===');
        for (const g of gainers) {
            lines.push(`${g.symbol} (${g.name}): ${g.price} INR, ${g.changePct >= 0 ? '+' : ''}${g.changePct}%`);
        }

        lines.push('\n=== TOP LOSERS (% change today) ===');
        for (const l of losers) {
            lines.push(`${l.symbol} (${l.name}): ${l.price} INR, ${l.changePct}%`);
        }

        lines.push('\n=== LIVE MARKET NEWS (Google News RSS) ===');
        lines.push(marketNews.context);

        return {
            context: lines.join('\n'),
            movers: { gainers, losers },
            indices: indexRows,
            marketNews: marketNews.context,
            universeRows: withChange,
        };
    }

    formatMoversBrief(movers) {
        const g = movers.gainers.slice(0, 5).map((x) => `${x.symbol} +${x.changePct}%`).join(', ');
        const l = movers.losers.slice(0, 5).map((x) => `${x.symbol} ${x.changePct}%`).join(', ');
        return `Gainers: ${g || 'n/a'}\nLosers: ${l || 'n/a'}`;
    }

    /** Higher score = stronger intraday move (prefers liquid names with volume). */
    scoreMover(row) {
        if (row?.changePct == null) return 0;
        const pct = Math.abs(Number(row.changePct) || 0);
        const vol = Number(row.volume) || 0;
        const volBoost = vol > 1_000_000 ? 1.15 : vol > 300_000 ? 1.08 : 1;
        return pct * volBoost;
    }

    buildMoverScoreMap(movers) {
        const map = new Map();
        for (const row of [...(movers?.gainers || []), ...(movers?.losers || [])]) {
            if (!row?.symbol) continue;
            map.set(row.symbol.toUpperCase(), this.scoreMover(row));
        }
        return map;
    }

    /** Score overlooked F&O names with catalyst + momentum (excludes mega-obvious tickers). */
    scoreHiddenGem(row, marketNews = '', aiBoost = false) {
        const sym = String(row?.symbol || '').trim().toUpperCase();
        if (!sym || MEGA_OBVIOUS_SYMBOLS.has(sym)) return 0;

        let score = 0;
        const pct = Math.abs(Number(row.changePct) || 0);
        if (pct >= 2) score += 30;
        else if (pct >= 1.5) score += 20;
        else if (pct >= 1) score += 10;

        const vol = Number(row.volume) || 0;
        if (vol > 1_000_000) score += 15;
        else if (vol > 300_000) score += 8;

        const newsLower = String(marketNews || '').toLowerCase();
        const nameLower = String(row.name || '').toLowerCase();
        if (newsLower.includes(sym.toLowerCase()) || (nameLower && newsLower.includes(nameLower))) {
            score += 25;
        }

        if (aiBoost) score += 20;
        return score;
    }

    /**
     * Rank hidden gem candidates from universe quotes + movers.
     * @returns {{ symbol: string, score: number, changePct: number, reason: string }[]}
     */
    findHiddenGemCandidates(universeRows, movers, marketNews, aiHiddenGem = null) {
        const aiSym = String(aiHiddenGem || '').trim().toUpperCase();
        const rows = [];
        const seen = new Set();

        const addRow = (row) => {
            const sym = String(row?.symbol || '').trim().toUpperCase();
            if (!sym || seen.has(sym)) return;
            seen.add(sym);
            rows.push(row);
        };

        for (const row of universeRows || []) addRow(row);
        for (const row of [...(movers?.gainers || []), ...(movers?.losers || [])]) addRow(row);

        const candidates = [];
        for (const row of rows) {
            const sym = row.symbol.toUpperCase();
            const aiBoost = Boolean(aiSym && sym === aiSym);
            const score = this.scoreHiddenGem(row, marketNews, aiBoost);
            if (score < 25) continue;

            const pct = Number(row.changePct) || 0;
            const parts = [];
            if (Math.abs(pct) >= 1) parts.push(`${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% move`);
            if (aiBoost) parts.push('AI catalyst pick');
            else if (score >= 40) parts.push('strong momentum + news');

            candidates.push({
                symbol: sym,
                score,
                changePct: pct,
                reason: parts.join(' · ') || 'overlooked F&O mover',
            });
        }

        return candidates.sort((a, b) => b.score - a.score);
    }

    /** Pick best hidden gem or null if none qualifies. */
    pickHiddenGem(universeRows, movers, marketNews, aiHiddenGem = null, aiReason = null) {
        const candidates = this.findHiddenGemCandidates(universeRows, movers, marketNews, aiHiddenGem);
        const top = candidates[0];
        if (!top || top.score < MIN_HIDDEN_GEM_SCORE) {
            return { hiddenGem: null, hiddenGemReason: null, candidates };
        }
        return {
            hiddenGem: top.symbol,
            hiddenGemReason: aiReason || top.reason,
            candidates,
        };
    }

    /**
     * Today's watchlist = top intraday movers (fresh each scan). No fixed repeat list.
     * @param {object[]} universeRows — rows with live quote + changePct today
     * @param {number} targetCount
     * @param {{ hiddenGem?: string|null }} opts
     */
    buildFreshMoversWatchlist(universeRows, targetCount = 10, { hiddenGem = null } = {}) {
        const target = Math.max(8, targetCount);
        const quoted = new Set((universeRows || []).map((r) => r.symbol?.toUpperCase()).filter(Boolean));
        const ranked = [...(universeRows || [])]
            .filter((r) => r?.symbol && r.changePct != null)
            .sort((a, b) => this.scoreMover(b) - this.scoreMover(a));

        const ordered = [];
        const seen = new Set();

        const push = (symbol) => {
            const sym = String(symbol || '').trim().toUpperCase();
            if (!sym || seen.has(sym) || !quoted.has(sym)) return;
            seen.add(sym);
            ordered.push(sym);
        };

        if (hiddenGem) push(hiddenGem);

        for (const row of ranked) {
            if (ordered.length >= target) break;
            push(row.symbol);
        }

        return ordered.slice(0, target);
    }

    /** Replace missing quotes with next best movers from snapshot. */
    finalizeWatchlist(symbols, universeRows, targetCount = 10) {
        const target = Math.max(8, targetCount);
        const quoted = new Set((universeRows || []).map((r) => r.symbol?.toUpperCase()).filter(Boolean));
        const ranked = [...(universeRows || [])]
            .filter((r) => r?.symbol && quoted.has(r.symbol.toUpperCase()))
            .sort((a, b) => this.scoreMover(b) - this.scoreMover(a));

        const out = [];
        const seen = new Set();
        const push = (sym) => {
            const s = String(sym || '').trim().toUpperCase();
            if (!s || seen.has(s) || !quoted.has(s)) return;
            seen.add(s);
            out.push(s);
        };

        for (const sym of symbols || []) push(sym);
        for (const row of ranked) {
            if (out.length >= target) break;
            push(row.symbol);
        }
        return out.slice(0, target);
    }

    formatTopMoversLine(movers) {
        const g = (movers?.gainers || []).slice(0, 6).map((x) => `${x.symbol} +${x.changePct}%`).join(', ');
        const l = (movers?.losers || []).slice(0, 6).map((x) => `${x.symbol} ${x.changePct}%`).join(', ');
        return `Gainers: ${g || 'n/a'} | Losers: ${l || 'n/a'}`;
    }

    /**
     * @deprecated Use buildFreshMoversWatchlist — kept for tests
     */
    buildDiscoveryWatchlist(aiSymbols, movers, targetCount = 10, { hiddenGem = null } = {}) {
        const ranked = [...(movers?.gainers || []), ...(movers?.losers || [])]
            .sort((a, b) => this.scoreMover(b) - this.scoreMover(a));
        const rows = ranked.map((r) => ({ symbol: r.symbol, changePct: r.changePct, volume: r.volume }));
        return this.buildFreshMoversWatchlist(rows, targetCount, { hiddenGem });
    }

    orderSymbolsByMovers(symbols, movers) {
        const scores = this.buildMoverScoreMap(movers);
        return [...symbols].sort((a, b) => (scores.get(b) || 0) - (scores.get(a) || 0));
    }
}

export const marketScanService = new MarketScanService();
export default MarketScanService;
