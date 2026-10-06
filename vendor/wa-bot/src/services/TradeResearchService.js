/**
 * Two-step trade intelligence: live feeds → LLM research → CE/PE analysis.
 */

import { stockIntelligenceService } from './StockIntelligenceService.js';
import TradeLlmRouterService from './TradeLlmRouterService.js';
import {
    TRADE_RESEARCH_SYSTEM_PROMPT,
    buildResearchUserPrompt,
} from '../prompts/tradeResearchPrompt.js';
import { logger } from '../utils/logger.js';

class TradeResearchService {
    constructor(config = {}) {
        this.tradeLlm = new TradeLlmRouterService(config);
        this.enabled = config.TRADE_TWO_STEP_RESEARCH !== false;
        this.researchTimeoutMs = Math.min(
            90_000,
            Math.max(35_000, parseInt(config.TRADE_RESEARCH_TIMEOUT_MS, 10) || 55_000)
        );
    }

    /** @param {string} symbol @param {{ includeMarketBrief?: boolean }} [opts] */
    async gatherIntel(symbol, opts = {}) {
        return stockIntelligenceService.gatherForSymbol(symbol, opts);
    }

    /**
     * Step 1: LLM synthesizes live data into CE/PE research brief.
     * @param {object} intel
     */
    async runResearchBrief(intel) {
        if (!this.enabled || !this.tradeLlm.isConfigured()) {
            return null;
        }

        const userPrompt = buildResearchUserPrompt({
            symbol: intel.symbol,
            displayName: intel.displayName,
            quoteContext: intel.quoteContext,
            quote: intel.quote,
            optionChainContext: intel.optionChainContext,
            newsContext: intel.newsContext,
            optionsNewsContext: intel.optionsNewsContext,
            marketBrief: intel.marketBrief,
        });

        logger.info(`🔬 Research brief for ${intel.symbol}…`);
        try {
            const brief = await this.tradeLlm.completeTrade(TRADE_RESEARCH_SYSTEM_PROMPT, userPrompt, {
                maxTokens: 700,
                timeoutMs: this.researchTimeoutMs,
            });
            return brief?.trim() || null;
        } catch (err) {
            logger.warn(`Research brief skipped for ${intel.symbol}: ${err.message}`);
            return null;
        }
    }
}

export const createTradeResearchService = (config) => new TradeResearchService(config);
export default TradeResearchService;
