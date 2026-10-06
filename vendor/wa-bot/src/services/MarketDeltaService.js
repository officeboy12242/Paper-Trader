/**
 * Snapshot delta — what changed since last scan (indian-market-tracker delta engine).
 */

import { getTodayDateStrIST } from '../utils/dateIST.js';

class MarketDeltaService {
    constructor(mongoDb = null) {
        this._col = mongoDb ? mongoDb.collection('trade_market_snapshots') : null;
    }

    async loadLastSnapshot() {
        if (!this._col) return null;
        const row = await this._col.findOne({}, { sort: { created_at: -1 } });
        return row?.payload || null;
    }

    async saveSnapshot(payload) {
        if (!this._col) return;
        await this._col.insertOne({
            alert_date: getTodayDateStrIST(),
            created_at: new Date(),
            payload,
        });
        const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000);
        await this._col.deleteMany({ created_at: { $lt: cutoff } }).catch(() => {});
    }

    computeDelta(prev, current) {
        const lines = [];
        if (!prev || !current) return { lines, hasChanges: false };

        const prevNifty = Number(prev.macro?.nifty?.pct);
        const curNifty = Number(current.macro?.nifty?.pct);
        if (Number.isFinite(prevNifty) && Number.isFinite(curNifty)) {
            const d = curNifty - prevNifty;
            if (Math.abs(d) >= 0.5) {
                lines.push(`NIFTY ${d >= 0 ? '+' : ''}${d.toFixed(2)}% since last scan`);
            }
        }

        const prevFii = Number(prev.macro?.fiiNet);
        const curFii = Number(current.macro?.fiiNet);
        if (Number.isFinite(prevFii) && Number.isFinite(curFii)) {
            const prevBuy = prevFii > 0;
            const curBuy = curFii > 0;
            if (prevBuy !== curBuy) {
                lines.push(`FII flow reversed (${curBuy ? 'buying' : 'selling'})`);
            }
        }

        const prevBias = prev.macro?.bias?.label;
        const curBias = current.macro?.bias?.label;
        if (prevBias && curBias && prevBias !== curBias) {
            lines.push(`Bias shift: ${prevBias} → ${curBias}`);
        }

        const prevHot = (prev.hotSectors?.hot || []).map((s) => s.label).join(',');
        const curHot = (current.hotSectors?.hot || []).map((s) => s.label).join(',');
        if (prevHot && curHot && prevHot !== curHot) {
            lines.push('Sector leadership rotated');
        }

        return { lines, hasChanges: lines.length > 0 };
    }
}

export function createMarketDeltaService(mongoDb) {
    return new MarketDeltaService(mongoDb);
}

export default MarketDeltaService;
