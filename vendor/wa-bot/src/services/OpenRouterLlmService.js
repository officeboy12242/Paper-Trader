/**
 * OpenRouter chat completions — fallback when Gemini/Groq/NVIDIA fail.
 */

import axios from 'axios';
import { logger } from '../utils/logger.js';
import { config } from '../config/config.js';
import { buildKeyPool } from '../utils/apiKeyPool.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
// Slugs verified reachable (Sept 2026): the older :free list (deepseek-v4-flash,
// llama-3.3-70b, gpt-oss-20b) now 404s as paid-only. Chain skips 404/429 slugs.
const DEFAULT_MODELS = [
    'minimax/minimax-m3:free',
    'z-ai/glm-5.2:free',
    'google/gemma-4-31b-it:free',
    'nvidia/nemotron-3.5-lightning:free',
];

/** Models that are poor at narrative chat recaps (JSON topics). */
const SUMMARY_SKIP_MODEL_RE = /coder|code-|devstral|codestral/i;

const DEFAULT_SUMMARY_MODELS = [
    'minimax/minimax-m3:free',
    'z-ai/glm-5.2:free',
    'google/gemma-4-31b-it:free',
    'nvidia/nemotron-3.5-lightning:free',
];

function parseList(raw, fallback) {
    const parts = String(raw || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    return parts.length ? parts : [...fallback];
}

export function isOpenRouterRateLimitError(err) {
    const status = err?.response?.status || err?.status;
    const msg = String(err?.message || err);
    return status === 429 || status === 402 || /rate.?limit|quota|credit|exhausted/i.test(msg);
}

export default class OpenRouterLlmService {
    constructor(cfg = config) {
        this.config = cfg;
        this.keyPool = buildKeyPool(cfg.OPENROUTER_API_KEYS, cfg.OPENROUTER_API_KEY);
        const fromCfg = [cfg.OPENROUTER_MODEL, ...(cfg.OPENROUTER_FALLBACK_MODELS || [])].filter(Boolean);
        this.models = parseList(cfg.OPENROUTER_MODELS, fromCfg.length ? fromCfg : DEFAULT_MODELS);
        this.summaryModels = this._buildSummaryModels(cfg);
        this.tradeModel = this.models[0];
        this.timeoutMs = Math.min(120_000, Math.max(30_000, Number(cfg.OPENROUTER_TIMEOUT_MS) || 90_000));
    }

    _buildSummaryModels(cfg) {
        const explicit = Array.isArray(cfg.OPENROUTER_SUMMARY_MODELS) && cfg.OPENROUTER_SUMMARY_MODELS.length
            ? cfg.OPENROUTER_SUMMARY_MODELS
            : [];
        const base = explicit.length ? explicit : [...DEFAULT_SUMMARY_MODELS, ...this.models];
        const seen = new Set();
        const out = [];
        for (const m of base) {
            const id = String(m || '').trim();
            if (!id || SUMMARY_SKIP_MODEL_RE.test(id) || seen.has(id)) continue;
            seen.add(id);
            out.push(id);
        }
        return out.length ? out : [...DEFAULT_SUMMARY_MODELS];
    }

    isConfigured() {
        return this.keyPool.size > 0;
    }

    async chat({ system, user, messages, temperature = 0.2, maxTokens = 4000, timeoutMs, models } = {}) {
        if (!this.keyPool.size) throw new Error('OPENROUTER_API_KEY is not configured');

        const modelList = Array.isArray(models) && models.length ? models : this.models;
        let lastErr;
        for (const model of modelList) {
            // Free-tier quotas are per key — rotate so a burst spreads across keys.
            const key = this.keyPool.next();
            try {
                const msgs = messages?.length
                    ? messages
                    : [
                          ...(system ? [{ role: 'system', content: system }] : []),
                          { role: 'user', content: user || '' },
                      ];
                const { data } = await axios.post(
                    OPENROUTER_URL,
                    {
                        model,
                        messages: msgs,
                        temperature,
                        max_tokens: maxTokens,
                    },
                    {
                        headers: {
                            Authorization: `Bearer ${key}`,
                            'Content-Type': 'application/json',
                            'HTTP-Referer': this.config.PUBLIC_URL || 'https://github.com/officeboy12242/WA-BOT',
                            'X-Title': 'WA-BOT',
                        },
                        timeout: timeoutMs || this.timeoutMs,
                    },
                );
                const text = data?.choices?.[0]?.message?.content?.trim();
                if (!text) throw new Error('empty OpenRouter response');
                return { text, provider: 'openrouter', model };
            } catch (err) {
                lastErr = err;
                const detail = err?.response?.data?.error?.message || err.message;
                logger.warn(`OpenRouter ${model} failed: ${detail}`);
                if (isOpenRouterRateLimitError(err)) {
                    this.keyPool.markRateLimited(key);
                }
                // Free model slugs go paid/deprecated without notice — skip to the
                // next model instead of killing the whole chain on one dead slug.
                if (isOpenRouterRateLimitError(err) || err?.response?.status === 404) {
                    continue;
                }
            }
        }
        throw lastErr || new Error('All OpenRouter models failed');
    }

    async complete(systemPrompt, userPrompt, opts = {}) {
        const { text } = await this.chat({
            system: systemPrompt,
            user: userPrompt,
            temperature: opts.temperature ?? 0.2,
            maxTokens: opts.maxTokens ?? 4000,
            timeoutMs: opts.timeoutMs,
        });
        return text;
    }

    async completeTrade(systemPrompt, userPrompt, opts = {}) {
        return this.complete(systemPrompt, userPrompt, {
            ...opts,
            maxTokens: opts.maxTokens ?? 900,
            timeoutMs: opts.timeoutMs ?? 55_000,
        });
    }

    async completeTradeAnalysis(systemPrompt, userPrompt, opts = {}) {
        const text = await this.complete(systemPrompt, userPrompt, {
            ...opts,
            maxTokens: opts.maxTokens ?? 4000,
            timeoutMs: opts.timeoutMs ?? 120_000,
        });
        logger.info('OpenRouter trade analysis done');
        return text;
    }
}

export const openRouterLlmService = new OpenRouterLlmService();
