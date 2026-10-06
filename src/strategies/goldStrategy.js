/**
 * 24-hour gold strategy runner. Mirrors the SourceStrategy interface
 * (discover / evaluateBatch / aiAvailable) so the Trader can drive it exactly
 * like a WA-BOT source, but instead of the vendored TradeAlertController it
 * scans its own signal function over continuous 1m XAUUSD bars.
 */

const SYMBOL = 'XAUUSD';

/** Spot feeds served by Delta India, keyed by internal symbol. */
export const SPOT_FEED_SYMBOLS = new Map([['XAUUSD', 'XAUTUSD'], ['ETHUSD', 'ETHUSD']]);

const r2 = (n) => Math.round(n * 100) / 100;

export class GoldStrategy {
    /**
     * @param {object} o
     * @param {object} o.def gold registry entry (has .run)
     * @param {object} o.cfg platform config
     * @param {import('../market/marketData.js').MarketDataService} o.marketData
     * @param {() => number} [o.now]
     */
    constructor({ def, cfg, marketData, now = Date.now }) {
        this.def = def;
        this.cfg = cfg;
        this.marketData = marketData;
        this.now = now;
        this.symbol = def.symbol || SYMBOL;
    }

    get key() {
        return this.def.key;
    }

    aiAvailable() {
        return false;
    }

    /** Fetch continuous bars and try this strategy's signal function. */
    async discover() {
        const bars = await this.marketData.getBars(this.symbol, { continuous: true });
        const refPrice = bars.length ? bars[bars.length - 1].close : null;
        let setup = null;
        try {
            setup = this.def.run(bars, {
                stopRisk: this.cfg[`${this.def.prefix}_STOP_RISK`] ?? 15,
                target: this.cfg[`${this.def.prefix}_TARGET`] ?? 40,
            });
        } catch (err) {
            throw new Error(`gold signal failed: ${err.message}`);
        }
        const candidates = [{ symbol: this.symbol, setup, meta: setup ? { checks: setup.checks } : null, refPrice, bars: bars.slice(-90) }];
        return { discovery: { heatmap: null, macro: null }, candidates };
    }

    /**
     * Gate exactly like the source strategies, minus the AI/confluence gates
     * (gold has no LLM card). A confirmed setup is always actionable here and
     * the per-day cap in the Trader is the only limit.
     */
    async evaluateBatch(candidates, discovery, { useAi, capacity }) {
        const decisions = [];
        let accepted = 0;
        for (const c of candidates) {
            if (!c.setup) {
                decisions.push({
                    symbol: c.symbol,
                    setup: null,
                    decision: 'NO_SETUP',
                    reason: 'no confirmed setup in the last hour (watch)',
                    confluence: null,
                    filterCondition: `${this.def.key}: watching`,
                    refPrice: c.refPrice,
                });
                continue;
            }
            const s = c.setup;
            const lotSize = this._lotSize(c.refPrice ?? s.entry);
            const pass = accepted < capacity;
            decisions.push({
                symbol: c.symbol,
                setup: s,
                decision: pass ? 'PASS' : 'REJECT',
                reason: pass ? null : 'daily_limit',
                direction: s.direction,
                confidence: s.score ?? 70,
                confluence: 70,
                filterCondition: `${this.def.key}: ${Object.keys(s.checks || {}).join(', ') || 'setup'}`,
                lotSize,
                refPrice: c.refPrice,
                selected: pass,
                softGate: false,
                isHiddenGem: false,
                bars: c.bars ?? null,
            });
            if (pass) accepted += 1;
        }
        return { decisions, usedSoft: false };
    }

    /** Delta-style sizing: qty = margin x leverage / (price x INR/USD), INR-settled. */
    _lotSize(price) {
        const px = Number(price);
        if (!(px > 0)) return 1;
        const margin = this.cfg[`${this.def.prefix}_MARGIN_INR`] ?? 40000;
        const lev = this.cfg[`${this.def.prefix}_LEVERAGE`] ?? 50;
        const rate = this.cfg.INR_USD_RATE || 84;
        return Math.max(1, Math.round((margin * lev) / (px * rate)));
    }
}
