/**
 * Option Chain AI Service
 * Orchestrates live NSE chain fetch → market data → LLM deep analysis.
 * Uses DeepSeek V4 Flash via OrcaRouter (free) with Gemini/Groq/NVIDIA fallback.
 */

import { nseOptionChainService } from './NseOptionChainService.js';
import { indianStockQuoteService } from './IndianStockQuoteService.js';
import { maxPain } from '../utils/blackScholes.js';
import { oiWalls, pcrLabel } from './IndexAnalysisService.js';
import { CHAIN_AI_SYSTEM_PROMPT, buildChainAiUserPrompt, formatChainAiAnalysis } from '../prompts/optionChainPrompt.js';
import { logger } from '../utils/logger.js';

/**
 * Loud warning when the chain came from cache because NSE was unreachable.
 *
 * Serving stale data silently on a trading command would be worse than the
 * "unavailable" error it replaces — a stale PCR or ATM premium looks exactly
 * like a live one. Anything built on this snapshot has to say so up front.
 */
export function staleBanner(snapshot) {
    if (!snapshot) return '';

    if (snapshot.stale) {
        const age = Number(snapshot.ageSec) || 0;
        const mins = Math.floor(age / 60);
        const label = mins >= 1 ? `${mins} min` : `${age}s`;
        return `⚠️ *STALE DATA — ${label} old*\n`
            + `_NSE is unreachable right now; this is the last chain we fetched._\n`
            + `_Do not treat these premiums as live._\n\n`;
    }

    // Live, but from the backup feed rather than NSE. Measured against NSE in
    // session the premiums track within about a rupee, but say so anyway —
    // silently swapping the source behind a premium is how you get a wrong
    // entry nobody can explain.
    if (snapshot.source && snapshot.source !== 'nse') {
        return `ℹ️ _NSE unreachable — chain via ${snapshot.source} (live). `
            + `Premiums may differ by ~₹1; verify before entering._\n\n`;
    }
    return '';
}

/**
 * Reuse window for the advisory chain card. Short on purpose: this card also
 * prints ATM premiums, and a stale LTP reads exactly like a live one.
 */
const CHAIN_REUSE_MS = 15_000;

class OptionChainAiService {
    constructor(config = {}) {
        this.config = config;
    }

    /**
     * Fetch all data needed for AI analysis.
     * @param {string} symbol - e.g. "NIFTY", "BANKNIFTY", "RELIANCE"
     * @returns {Promise<{snapshot, quote, chainMeta, error}|null>}
     */
    async _fetchAllData(symbol) {
        const [chainRes, quoteRes] = await Promise.allSettled([
            // Advisory card only, and it renders staleBanner() when the chain
            // is cached — so this is the one caller allowed to fall back.
            nseOptionChainService.fetchOptionContext(symbol, { allowStale: true, maxAgeMs: CHAIN_REUSE_MS }),
            indianStockQuoteService.fetchQuote(symbol),
        ]);

        const chain = chainRes.status === 'fulfilled' ? chainRes.value : null;
        const quote = quoteRes.status === 'fulfilled' ? quoteRes.value : null;

        if (!chain?.snapshot) {
            return { error: `Option chain unavailable for ${symbol}` };
        }

        const snap = chain.snapshot;
        const spot = snap.spot ?? quote?.price ?? null;

        const mp = maxPain(
            (snap.topCe || []).map((c) => ({
                strike: c.strike,
                ceOi: c.oi,
                peOi: (snap.topPe || []).find((p) => p.strike === c.strike)?.oi || 0,
            }))
        );

        const walls = oiWalls(snap.topCe, snap.topPe, spot);
        const pcrLbl = pcrLabel(snap.pcr);

        return {
            snapshot: snap,
            quote,
            chainMeta: {
                maxPain: mp,
                walls,
                pcrLabel: pcrLbl,
            },
        };
    }

    /**
     * Call OrcaRouter DeepSeek V4 Flash for option chain analysis.
     * Falls back to the standard trade LLM chain (Gemini/Groq/NVIDIA) when
     * OrcaRouter is unset or fails.
     */
    async _callLlm(systemPrompt, userPrompt) {
        const orcaKey = this.config.ORCAROUTER_API_KEY;
        if (orcaKey) {
            try {
                const resp = await fetch('https://api.orcarouter.ai/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${orcaKey}`,
                    },
                    body: JSON.stringify({
                        model: 'deepseek/deepseek-v4-flash-free',
                        messages: [
                            { role: 'system', content: systemPrompt },
                            { role: 'user', content: userPrompt },
                        ],
                        temperature: 0.3,
                        max_tokens: 16000,
                        reasoning_effort: 'low',
                    }),
                    signal: AbortSignal.timeout(150_000),
                });
                if (resp.ok) {
                    const data = await resp.json();
                    const content = data.choices?.[0]?.message?.content || '';
                    if (content) return content;
                    logger.warn('OrcaRouter chain AI returned empty content');
                } else {
                    logger.warn(`OrcaRouter chain AI failed: HTTP ${resp.status}`);
                }
            } catch (err) {
                logger.warn(`OrcaRouter chain AI error: ${err.message}`);
            }
        }

        // Fallback: use the existing trade LLM chain (Gemini → Groq → NVIDIA → OpenRouter)
        try {
            const { default: TradeLlmRouterService } = await import('./TradeLlmRouterService.js');
            const router = new TradeLlmRouterService(this.config);
            if (router.isConfigured?.()) {
                return await router.completeTradeAnalysis(systemPrompt, userPrompt, {
                    temperature: 0.3,
                    maxTokens: 4000,
                });
            }
        } catch (err) {
            logger.warn(`Chain AI fallback (trade router) failed: ${err.message}`);
        }

        throw new Error('No LLM provider available (set ORCAROUTER_API_KEY, or configure Gemini/Groq/NVIDIA/OpenRouter)');
    }

    /**
     * Full AI analysis pipeline for a symbol.
     * @param {string} symbol - e.g. "NIFTY", "BANKNIFTY"
     * @returns {Promise<{text: string, data: object}|null>}
     */
    async analyze(symbol) {
        const upper = String(symbol || '').trim().toUpperCase();
        if (!upper) return null;

        const data = await this._fetchAllData(upper);
        if (data.error) {
            return { text: `❌ ${data.error}`, data: null };
        }

        const userPrompt = buildChainAiUserPrompt(data.snapshot, data.quote, data.chainMeta);

        try {
            const raw = await this._callLlm(CHAIN_AI_SYSTEM_PROMPT, userPrompt);
            if (raw && raw.length > 100) {
                return {
                    text: staleBanner(data.snapshot) + formatChainAiAnalysis(raw),
                    data,
                };
            }
            return {
                text: this._formatFallback(data),
                data,
            };
        } catch (err) {
            logger.warn(`Chain AI LLM failed: ${err.message}`);
            return {
                text: this._formatFallback(data),
                data,
            };
        }
    }

    /**
     * Fallback card when LLM is unavailable — shows raw chain data.
     */
    _formatFallback(data) {
        const { snapshot: s, chainMeta: m } = data;
        const L = [];
        const banner = staleBanner(s);
        if (banner) L.push(banner.trimEnd(), '');
        L.push('┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓');
        L.push('┃  🧠 *OPTION CHAIN ANALYSIS* ┃');
        L.push('┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛');
        L.push('');
        L.push(`📊 *${s.symbol}* · Spot: ₹${s.spot} · Expiry: ${s.expiry}`);
        L.push('');

        if (s.pcr != null) L.push(`PCR: *${s.pcr.toFixed(2)}* — ${m?.pcrLabel || ''}`);
        if (m?.maxPain != null) L.push(`Max Pain: *${m.maxPain}*`);
        if (m?.walls?.resistance) L.push(`🔴 Resistance: ${m.walls.resistance.strike} (OI: ${Number(m.walls.resistance.oi).toLocaleString('en-IN')})`);
        if (m?.walls?.support) L.push(`🟢 Support: ${m.walls.support.strike} (OI: ${Number(m.walls.support.oi).toLocaleString('en-IN')})`);
        L.push('');

        if (s.atmStrike) {
            L.push(`*ATM ${s.atmStrike}*`);
            if (s.atmCe) L.push(`  CE: ₹${s.atmCe.ltp} · IV ${s.atmCe.iv}% · OI ${s.atmCe.oi}`);
            if (s.atmPe) L.push(`  PE: ₹${s.atmPe.ltp} · IV ${s.atmPe.iv}% · OI ${s.atmPe.oi}`);
        }

        L.push('');
        L.push('⚠️ _AI analysis unavailable — showing raw chain data_');
        L.push('💡 _Set ORCAROUTER_API_KEY for AI-powered deep analysis_');
        return L.join('\n');
    }
}

export default OptionChainAiService;
export const optionChainAiService = new OptionChainAiService();
