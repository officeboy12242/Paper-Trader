/**
 * F&O lot size resolution for "1 lot".
 *
 * Order of preference:
 *  1. NSE's official `fo_mktlots.csv` (near-month column), cached per day
 *  2. the original WA-BOT table `src/data/nseLotSizes.js`
 *  3. the WA-BOT default (100) for symbols in neither
 * The source used is stored on every trade.
 */

import axios from 'axios';
import { getNseLotSize, NSE_LOT_SIZES, DEFAULT_LOT } from '../../vendor/wa-bot/src/data/nseLotSizes.js';
import { sessionDate } from './clock.js';

const NSE_LOTS_URL = 'https://nsearchives.nseindia.com/content/fo/fo_mktlots.csv';

/** Parse NSE's padded CSV into SYMBOL -> near-month lot size. */
export function parseMktLots(csv) {
    const map = new Map();
    const lines = String(csv || '').split(/\r?\n/);
    for (const line of lines.slice(1)) {
        const cells = line.split(',').map((c) => c.trim());
        const symbol = cells[1]?.toUpperCase();
        if (!symbol || symbol === 'SYMBOL') continue;
        const lot = cells.slice(2).map(Number).find((n) => Number.isFinite(n) && n > 0);
        if (lot) map.set(symbol, lot);
    }
    return map;
}

export class LotSizeService {
    constructor({ cfg, db = null, logger, fetchCsv = null, now = Date.now }) {
        this.cfg = cfg;
        this.db = db;
        this.logger = logger;
        this.now = now;
        this.fetchCsv = fetchCsv || (async () => {
            const { data } = await axios.get(NSE_LOTS_URL, {
                timeout: 20_000,
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/121 Safari/537.36', Accept: 'text/csv,*/*' },
            });
            return data;
        });
        this.map = null;
        this.mapDate = null;
    }

    async refresh() {
        if (this.cfg.LOT_SIZE_SOURCE !== 'nse') return;
        const today = sessionDate(this.now());
        if (this.mapDate === today && this.map?.size) return;
        // Same-day cache survives restarts.
        const cached = this.db?.getKv('nse_lots');
        if (cached) {
            try {
                const { date, csv } = JSON.parse(cached);
                if (date === today) {
                    this.map = parseMktLots(csv);
                    this.mapDate = today;
                    return;
                }
            } catch {
                /* refetch */
            }
        }
        try {
            const csv = await this.fetchCsv();
            const map = parseMktLots(csv);
            if (map.size < 50) throw new Error(`only ${map.size} rows parsed`);
            this.map = map;
            this.mapDate = today;
            this.db?.setKv('nse_lots', JSON.stringify({ date: today, csv }));
            this.logger.info('LOTS', 'LOADED', `${map.size} NSE F&O lot sizes`);
        } catch (err) {
            this.logger.warn('LOTS', 'FALLBACK', `NSE lot file unavailable (${err.message}); using WA-BOT table`);
        }
    }

    /** @returns {{ lotSize: number, source: 'nse'|'repo'|'repo-default' }} */
    resolve(symbol) {
        const sym = String(symbol || '').toUpperCase();
        if (this.map?.has(sym)) return { lotSize: this.map.get(sym), source: 'nse' };
        const inTable = NSE_LOT_SIZES[sym] != null || NSE_LOT_SIZES[sym.replace(/&/g, '_')] != null;
        return { lotSize: getNseLotSize(sym), source: inTable ? 'repo' : 'repo-default' };
    }
}

export { DEFAULT_LOT };
