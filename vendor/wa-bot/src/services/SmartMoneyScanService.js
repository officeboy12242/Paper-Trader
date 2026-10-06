/**
 * Bulk / block deal scan from NSE (smart-money signals).
 */

import { nseGetSafe } from '../utils/nseClient.js';
import { logger } from '../utils/logger.js';

function parseDealRow(row, kind) {
    const symbol = String(row?.symbol || row?.secSymbol || '').trim().toUpperCase();
    if (!symbol) return null;
    const qty = Number(row?.quantity || row?.qty || 0);
    const price = Number(row?.tradePrice || row?.price || row?.avgPrice || 0);
    const valueCr = price && qty ? (price * qty) / 1e7 : null;
    return {
        symbol,
        kind,
        quantity: qty,
        price,
        valueCr: valueCr != null ? Number(valueCr.toFixed(2)) : null,
        client: row?.clientName || row?.buyerName || row?.name || '',
    };
}

class SmartMoneyScanService {
    async fetchTodayDeals() {
        const [bulk, block] = await Promise.all([
            nseGetSafe('snapshot-capital-market-largedeal'),
            nseGetSafe('block-deal'),
        ]);

        const deals = [];

        const bulkRows = bulk?.data || bulk?.bulk || bulk || [];
        if (Array.isArray(bulkRows)) {
            for (const row of bulkRows.slice(0, 40)) {
                const d = parseDealRow(row, 'BULK');
                if (d) deals.push(d);
            }
        }

        const blockRows = block?.data || block || [];
        if (Array.isArray(blockRows)) {
            for (const row of blockRows.slice(0, 40)) {
                const d = parseDealRow(row, 'BLOCK');
                if (d) deals.push(d);
            }
        }

        const bySymbol = new Map();
        for (const d of deals) {
            const prev = bySymbol.get(d.symbol);
            if (!prev || (d.valueCr || 0) > (prev.valueCr || 0)) {
                bySymbol.set(d.symbol, d);
            }
        }

        const ranked = [...bySymbol.values()].sort((a, b) => (b.valueCr || 0) - (a.valueCr || 0));
        logger.info(`💰 Smart money: ${ranked.length} symbols with bulk/block activity`);
        return { deals: ranked, fetchedAt: new Date() };
    }

    formatLines(deals, limit = 5) {
        return (deals || []).slice(0, limit).map((d) => {
            const val = d.valueCr != null ? `₹${d.valueCr} Cr` : '';
            return `• ${d.symbol} ${d.kind}${val ? ` ${val}` : ''}`;
        });
    }
}

export const smartMoneyScanService = new SmartMoneyScanService();
export default SmartMoneyScanService;
