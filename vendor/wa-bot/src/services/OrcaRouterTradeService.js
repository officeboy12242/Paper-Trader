/**
 * OrcaRouter trade completions — free DeepSeek V4 Flash tried first, so
 * /tradenow (and the daily scan) burn no paid budget on the happy path. Same
 * OpenAI-compatible schema as OpenRouter; only host, model list, and default
 * token budget differ. When OrcaRouter is unset or rate-limited, the router
 * falls through to Gemini → Groq → NVIDIA → OpenRouter unchanged.
 */

import axios from 'axios';
import { logger } from '../utils/logger.js';
import { config } from '../config/config.js';
import { buildKeyPool } from '../utils/apiKeyPool.js';

const ORCAROUTER_URL = 'https://api.orcarouter.ai/v1/chat/completions';
const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash-free';
/** 16k so a full trade analysis + verdict + why never hits mid-JSON truncation. */
const DEFAULT_MAX_TOKENS = 16_000;

export function isOrcaRouterRateLimitError(err) {
    const status = err?.response?.status || err?.status;
    const msg = String(err?.response?.data?.error?.message || err?.message || err);
    return status === 429 || status === 402 || /rate.?limit|quota|credit|exhausted|too many/i.test(msg);
}

export default class OrcaRouterTradeService {
    constructor(cfg = config) {
        this.config = cfg;
        this.keyPool = buildKeyPool(cfg.ORCAROUTER_API_KEYS, cfg.ORCAROUTER_API_KEY);
        this.tradeModel = String(cfg.ORCAROUTER_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
        this.timeoutMs = Math.min(
            180_000,
            Math.max(30_000, Number(cfg.ORCAROUTER_TIMEOUT_MS) || 150_000)
        );
    }

    isConfigured() {
        return this.keyPool.size > 0;
    }

    async _chat({ system, user, temperature = 0.3, maxTokens = DEFAULT_MAX_TOKENS, timeoutMs }) {
        if (!this.keyPool.size) throw new Error('ORCAROUTER_API_KEY is not configured');

        const key = this.keyPool.next();
        try {
            const { data } = await axios.post(
                ORCAROUTER_URL,
                {
                    model: this.tradeModel,
                    messages: [
                        ...(system ? [{ role: 'system', content: system }] : []),
                        { role: 'user', content: user || '' },
                    ],
                    temperature,
                    max_tokens: maxTokens,
                    // DeepSeek's reasoning knob — 'low' keeps latency sane for a WhatsApp reply
                    // while still letting the model think through the chain analysis.
                    reasoning_effort: 'low',
                },
                {
                    headers: {
                        Authorization: `Bearer ${key}`,
                        'Content-Type': 'application/json',
                    },
                    timeout: timeoutMs || this.timeoutMs,
                }
            );
            const text = data?.choices?.[0]?.message?.content?.trim();
            if (!text) throw new Error('empty OrcaRouter response');
            return { text, provider: 'orcarouter', model: this.tradeModel };
        } catch (err) {
            if (isOrcaRouterRateLimitError(err)) {
                this.keyPool.markRateLimited(key);
            }
            const detail = err?.response?.data?.error?.message || err.message;
            logger.warn(`OrcaRouter ${this.tradeModel} failed: ${detail}`);
            throw err;
        }
    }

    async completeTrade(systemPrompt, userPrompt, opts = {}) {
        const { text } = await this._chat({
            system: systemPrompt,
            user: userPrompt,
            temperature: opts.temperature ?? 0.3,
            maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
            timeoutMs: opts.timeoutMs ?? 90_000,
        });
        return text;
    }

    async completeTradeAnalysis(systemPrompt, userPrompt, opts = {}) {
        const { text } = await this._chat({
            system: systemPrompt,
            user: userPrompt,
            temperature: opts.temperature ?? 0.3,
            maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
            timeoutMs: opts.timeoutMs ?? 180_000,
        });
        logger.info(`OrcaRouter trade analysis done (${this.tradeModel})`);
        return text;
    }
}

export const orcaRouterTradeService = new OrcaRouterTradeService();
