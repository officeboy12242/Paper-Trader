/**
 * One WA-BOT discovery source, run as an independent strategy.
 *
 * Fidelity rules:
 *  - Discovery is the ORIGINAL `TradeAlertController.runDiscovery()` (which
 *    calls the original TradeDiscoveryEngine and, for non-prescriptive sources,
 *    the original AI overlay + hidden-gem pick). Nothing is re-implemented.
 *  - Gates are the ORIGINAL `_passesSendGates()` / `_isSoftDailyEligible()`,
 *    and post selection is the ORIGINAL `_selectDailyPosts()`.
 *  - AI analysis is the ORIGINAL `_runDailyAnalysis()` (LLM CE/PE card).
 *  - Each strategy owns its own controller instance, so no state is shared.
 *
 * Without an AI key the AI terms of the gate are neutralised (a synthetic
 * actionable signal) so every non-AI gate still applies: watch-only session,
 * data freshness, catalyst AVOID block, confluence floor and soft fallback.
 */

import TradeAlertController from '../../vendor/wa-bot/src/controllers/TradeAlertController.js';
import { config as vendorConfig } from '../../vendor/wa-bot/src/config/config.js';
import { isPrescriptiveSource } from '../../vendor/wa-bot/src/utils/discoverySource.js';
import { marketScanService } from '../../vendor/wa-bot/src/services/MarketScanService.js';
import { scoreConfluence } from '../../vendor/wa-bot/src/utils/tradeConfluenceScore.js';
import { getIndiaMarketMode, checkQuoteFreshness } from '../../vendor/wa-bot/src/utils/indianMarketCalendar.js';
import { LONG, SHORT } from '../engine/risk.js';
import { mapPool } from '../market/marketData.js';

/** Stub for the WhatsApp group store; discovery and gates never touch it. */
const NO_GROUPS = {
    getTradeAlertDiscoverySource: async () => null,
    getTradeAlertMode: async () => 'auto',
    getTradeAlertSymbols: async () => [],
    getTradeAlertGroups: async () => [],
};

const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

/** Map a WA-BOT setup object (four shapes across sources) to plain levels. */
export function normalizeSetup(setup) {
    if (!setup || typeof setup !== 'object') return null;
    const dirRaw = String(setup.direction || '').toLowerCase();
    const direction = dirRaw === 'long' ? LONG : dirRaw === 'short' ? SHORT : null;
    const entry = num(setup.entry);
    const stop = num(setup.stop);
    const target = num(setup.target1 ?? setup.target15);
    const target2 = num(setup.target2 ?? setup.target20);
    if (!direction || entry == null || stop == null) return null;
    return { direction, entry, stop, target, target2, score: num(setup.score), status: setup.status || null, checks: setup.checks || null };
}

function describeFilter(key, meta, setup) {
    const parts = [...(meta?.sources || [])];
    if (setup?.score != null && !parts.some((p) => /score/.test(p))) parts.push(`score ${setup.score}`);
    if (setup?.status) parts.push(`status ${setup.status}`);
    if (setup?.checks) {
        const on = Object.entries(setup.checks).filter(([, v]) => v === true).map(([k]) => k);
        if (on.length) parts.push(`checks: ${on.join(', ')}`);
    }
    if (meta?.confluence != null) parts.push(`confluence ${meta.confluence}`);
    return `${key}: ${parts.join(' · ')}`;
}

export class SourceStrategy {
    /**
     * @param {object} o
     * @param {object} o.def registry entry
     * @param {object} o.cfg platform config
     * @param {object} [o.controller] injectable (tests); defaults to a fresh original controller
     * @param {() => number} [o.now]
     */
    constructor({ def, cfg, controller = null, now = Date.now }) {
        this.def = def;
        this.cfg = cfg;
        this.now = now;
        this.controller = controller || new TradeAlertController(NO_GROUPS, vendorConfig, null);
    }

    get key() {
        return this.def.key;
    }

    aiAvailable() {
        return this.cfg.AI_GATE_MODE === 'auto' && Boolean(this.controller.tradeLlm?.isConfigured?.());
    }

    /** Run the original discovery for this source. Throws on failure. */
    async discover() {
        const discovery = await this.controller.runDiscovery({ forceRefresh: true, persist: false, source: this.key });
        let symbols = [...(discovery.symbols || [])];
        // Same ordering the original applies before analysis.
        if (discovery.movers && !isPrescriptiveSource(this.key)) {
            symbols = marketScanService.orderSymbolsByMovers(symbols, discovery.movers);
        }
        const metaBySymbol = new Map((discovery.symbolMeta || []).map((m) => [m.symbol, m]));
        const priceBySymbol = new Map((discovery.intelligence?.universeRows || []).map((r) => [r.symbol, num(r.price)]));
        const candidates = symbols.map((symbol) => {
            const meta = metaBySymbol.get(symbol) || null;
            return {
                symbol,
                meta,
                setup: normalizeSetup(meta?.setup),
                isHiddenGem: Boolean(discovery.hiddenGem && symbol === discovery.hiddenGem),
                refPrice: priceBySymbol.get(symbol) ?? null,
            };
        });
        return { discovery, candidates };
    }

    _confluence(candidate, discovery) {
        const m = candidate.meta;
        return m
            ? { score: m.confluence, blocked: m.blocked, blockReason: m.blocked ? 'catalyst' : null, passes: m.confluencePass }
            : scoreConfluence({ symbol: candidate.symbol, movers: discovery?.movers, macro: discovery?.macro });
    }

    /**
     * Gate one candidate exactly as the original daily scan does.
     * @returns {Promise<object>} decision
     */
    async evaluate(candidate, discoveryForGates, { useAi, setupless = false }) {
        const { symbol, setup } = candidate;
        const confluence = this._confluence(candidate, discoveryForGates);
        const marketMode = getIndiaMarketMode(this.now());
        const base = {
            symbol,
            setup,
            isHiddenGem: candidate.isHiddenGem,
            confluence: confluence?.score ?? null,
            filterCondition: describeFilter(this.key, candidate.meta, setup),
        };

        if (!useAi) {
            if (!setup) {
                return { ...base, decision: 'NO_SETUP', reason: this.def.needsAiHint ? 'source gives no levels; needs AI to pick a side' : 'no confirmed setup yet (watch)' };
            }
            // AI terms neutralised: everything else in the original gate applies.
            const signal = { isActionable: true, confidence: 100, recommendation: setup.direction === LONG ? 'SETUP LONG' : 'SETUP SHORT' };
            const gate = this.controller._passesSendGates({ signal, confluence, entryState: null, marketMode, discovery: discoveryForGates });
            const soft = !gate.pass && this.controller._isSoftDailyEligible({ signal, confluence, gate, discovery: discoveryForGates });
            return {
                ...base,
                decision: gate.pass ? 'PASS' : soft ? 'SOFT' : 'REJECT',
                reason: gate.pass ? null : gate.reason,
                direction: setup.direction,
                confidence: setup.score ?? 0,
                ai: null,
            };
        }

        if (!setup && !this.def.needsAiHint && !setupless) {
            // A setup source that has not confirmed this name yet: nothing to agree with.
            return { ...base, decision: 'NO_SETUP', reason: 'no confirmed setup yet (watch)' };
        }

        let analysis;
        try {
            analysis = await this.controller._runDailyAnalysis(symbol, { isHiddenGem: candidate.isHiddenGem });
        } catch (err) {
            return { ...base, decision: 'ERROR', reason: `AI analysis failed: ${err.message}` };
        }
        const { signal, entryState } = analysis;
        const gate = this.controller._passesSendGates({ signal, confluence, entryState, marketMode, discovery: discoveryForGates });
        const soft = !gate.pass && this.controller._isSoftDailyEligible({ signal, confluence, gate, discovery: discoveryForGates });
        // Same side mapping the original journal uses (`_logPostedAlert`).
        const aiDirection = signal.isActionable ? (signal.isBuyPut ? SHORT : LONG) : null;
        const ai = {
            recommendation: signal.recommendation,
            confidence: signal.confidence,
            ceConfidence: signal.ceConfidence,
            peConfidence: signal.peConfidence,
            direction: aiDirection,
            entryState: entryState?.label || null,
            card: String(analysis.body || '').slice(0, 4000),
        };
        let decision = gate.pass ? 'PASS' : soft ? 'SOFT' : 'REJECT';
        let reason = gate.pass ? null : gate.reason;
        if (decision !== 'REJECT' && setup && aiDirection !== setup.direction) {
            decision = 'REJECT';
            reason = `AI ${signal.recommendation} disagrees with ${setup.direction} setup`;
        }
        return { ...base, decision, reason, direction: setup ? setup.direction : aiDirection, confidence: signal.confidence ?? 0, ai, refPrice: candidate.refPrice };
    }

    /**
     * Evaluate a batch and pick what to trade, mirroring postDailyAlerts():
     * strict passes first (gem slot reserved), soft fallback only when nothing
     * strict passed, then the per-day cap.
     */
    async evaluateBatch(candidates, discovery, { useAi, capacity }) {
        const discoveryForGates = { ...discovery, freshness: checkQuoteFreshness(discovery.scannedAt) };
        const setupless = candidates.length > 0 && candidates.every((c) => !c.setup);
        const concurrency = useAi ? Math.max(1, Math.min(3, Number(vendorConfig.TRADE_ALERT_SCAN_CONCURRENCY) || 2)) : 8;
        const results = await mapPool(candidates, concurrency, (c) => this.evaluate(c, discoveryForGates, { useAi, setupless }));
        const decisions = results.map((r, i) => (r.ok ? r.value : { symbol: candidates[i].symbol, decision: 'ERROR', reason: String(r.error?.message || r.error) }));

        const item = (d) => ({ symbol: d.symbol, signal: { confidence: d.confidence || 0 }, resultEntry: { confluence: d.confluence || 0 }, d });
        const strict = decisions.filter((d) => d.decision === 'PASS');
        const soft = decisions.filter((d) => d.decision === 'SOFT');
        let picked = this.controller._selectDailyPosts(strict.filter((d) => !d.isHiddenGem).map(item), strict.find((d) => d.isHiddenGem) ? item(strict.find((d) => d.isHiddenGem)) : null);
        let usedSoft = false;
        if (!picked.length && this.cfg.SOFT_FALLBACK && soft.length) {
            const regular = soft.filter((d) => !d.isHiddenGem).map(item)
                .sort((a, b) => b.signal.confidence - a.signal.confidence || b.resultEntry.confluence - a.resultEntry.confluence);
            const gem = soft.find((d) => d.isHiddenGem);
            picked = this.controller._selectDailyPosts(regular, gem ? item(gem) : null);
            usedSoft = picked.length > 0;
        }
        const selected = picked.slice(0, Math.max(0, capacity)).map((p) => p.d);
        const selectedSet = new Set(selected.map((d) => d.symbol));
        for (const d of decisions) {
            if (selectedSet.has(d.symbol)) {
                d.selected = true;
                d.softGate = d.decision === 'SOFT';
            } else if (d.decision === 'PASS' || d.decision === 'SOFT') {
                d.selected = false;
                d.reason = picked.some((p) => p.symbol === d.symbol) ? 'daily_limit' : d.decision === 'SOFT' ? (usedSoft ? 'soft_not_selected' : `confluence (${d.reason})`) : 'daily_limit';
            }
        }
        return { decisions, selected, usedSoft };
    }
}
