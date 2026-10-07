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

/** Resample 1m bars into a higher‑timeframe (e.g. 15m) series. */
function resample(bars, every) {
    const out = [];
    for (let i = 0; i + every <= bars.length; i += every) {
        const group = bars.slice(i, i + every);
        out.push({
            ts: group[0].ts,
            open: group[0].open,
            high: Math.max(...group.map((b) => b.high)),
            low: Math.min(...group.map((b) => b.low)),
            close: group[group.length - 1].close,
            volume: group.reduce((a, b) => a + b.volume, 0),
        });
    }
    return out;
}

/**
 * Follow‑through gate: only keep a freshly fired setup if the entry bar's
 * liquidity confirms it — the latest 1m bar must trade in the setup direction
 * and have not already swept through our stop. Prevents pulling a setup that
 * has already burned out in a 1m wick.
 */
function followThrough(bars, s) {
    if (!bars.length) return false;
    const last = bars[bars.length - 1];
    const risk = Math.abs(Number(s.entry) - Number(s.stop));
    const tol = Math.max(risk * 0.25, 1e-9);
    if (s.direction === 'LONG') return last.close >= last.open && last.low > Number(s.stop) - tol;
    return last.close <= last.open && last.high < Number(s.stop) + tol;
}

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

    /** Fetch continuous bars and try this strategy's signal function on 15m bars. */
    async discover() {
        const bars1m = await this.marketData.getBars(this.symbol, { continuous: true });
        const bars15 = resample(bars1m, 15);
        const refPrice = bars1m.length ? bars1m[bars1m.length - 1].close : null;
        let setup = null;
        try {
            // Fix B: evaluate the setup on 15m bars (escapes 1m noise wicks) and
            // apply a stricter reward floor (≥ 2R) so a full target ATR clears.
            setup = this.def.run(bars15, {
                stopRisk: this.cfg[`${this.def.prefix}_STOP_RISK`] ?? 15,
                minRR: Math.max(this.cfg.MIN_RR, 2),
                maxRR: this.cfg.MAX_RR,
                atrStopMult: this.cfg.ATR_STOP_MULT,
            });
        } catch (err) {
            throw new Error(`gold signal failed: ${err.message}`);
        }
        // Fix A: require a follow‑through 1m bar so we don't enter into the wick.
        if (setup && !followThrough(bars1m, setup)) setup = null;
        const candidates = [{ symbol: this.symbol, setup, meta: setup ? { checks: setup.checks } : null, refPrice, bars: bars1m.slice(-90) }];
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
            const lotSize = this._sizing(c.refPrice ?? s.entry, s);
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

    /**
     * Size a trade so its worst case is bounded.
     *
     * Start from the Delta-style notional (margin x leverage), then cut the
     * size down if this trade's own stop would cost more than MAX_RISK_INR.
     * A wide stop therefore gets fewer units and a tight stop gets more, so
     * every trade can lose roughly the same number of rupees — the stop
     * distance decides the size, not the other way round.
     *
     * @param {number} price reference price
     * @param {{ entry: number, stop: number } | null} [setup] this trade's levels
     */
    _sizing(price, setup) {
        const px = Number(price);
        if (!(px > 0)) return 1;
        const margin = this.cfg[`${this.def.prefix}_MARGIN_INR`] ?? 40000;
        const lev = this.cfg[`${this.def.prefix}_LEVERAGE`] ?? 50;
        const rate = this.cfg.INR_USD_RATE || 84;
        const notional = Math.max(1, Math.round((margin * lev) / (px * rate)));
        const stopDist = setup ? Math.abs(Number(setup.entry) - Number(setup.stop)) : 0;
        const cap = this.cfg.MAX_RISK_INR;
        if (!(stopDist > 0) || !(cap > 0)) return notional;
        const byRisk = Math.floor(cap / (stopDist * rate));
        return Math.max(1, Math.min(notional, byRisk));
    }
}
