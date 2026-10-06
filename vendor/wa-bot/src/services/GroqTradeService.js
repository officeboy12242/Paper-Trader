/**
 * Groq OpenAI-compatible API for trade analysis fallback.
 */

import axios from 'axios';
import { logger } from '../utils/logger.js';
import { config } from '../config/config.js';
import { buildKeyPool } from '../utils/apiKeyPool.js';

const API_URL = 'https://api.groq.com/openai/v1/chat/completions';
// Verified live against the Groq API (2026-09-08): old llama names 404 now.
const DEFAULT_MODELS = ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b'];
const MAX_TRADE_TIMEOUT_MS = 180_000;

function clampTimeoutMs(raw, cap = MAX_TRADE_TIMEOUT_MS) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return 120_000;
    return Math.min(cap, Math.max(25_000, n));
}

export function isGroqRateLimitError(err) {
    const status = err?.response?.status;
    const msg = String(err?.response?.data?.error?.message || err?.message || err);
    return status === 429 || /quota|rate.?limit|resource.?exhausted|too many requests/i.test(msg);
}

function stripFences(text) {
    return String(text || '')
        .replace(/^```(?:markdown|text)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
}

export default class GroqTradeService {
    constructor(cfg = config) {
        this.keyPool = buildKeyPool(
            cfg.GROQ_API_KEYS || process.env.GROQ_API_KEYS,
            cfg.GROQ_API_KEY || process.env.GROQ_API_KEY
        );
        this.models = this._parseModelChain(cfg.GROQ_TRADE_MODELS || cfg.GROQ_TRADE_MODEL);
        this.tradeModel = this.models[0];
        this.tradeTimeoutMs = clampTimeoutMs(cfg.TRADE_ANALYSIS_TIMEOUT_MS || 150_000);
        this.researchTimeoutMs = clampTimeoutMs(cfg.TRADE_RESEARCH_TIMEOUT_MS || 55_000, 90_000);
    }

    _parseModelChain(raw) {
        if (!raw) return [...DEFAULT_MODELS];
        const parts = String(raw)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        return parts.length ? [...new Set(parts)] : [...DEFAULT_MODELS];
    }

    getModelChain() {
        return [...this.models];
    }

    isConfigured() {
        return this.keyPool.size > 0;
    }

    isTimeoutError(err) {
        return /timeout|ETIMEDOUT|ECONNABORTED/i.test(String(err?.message || err));
    }

    async complete(systemPrompt, userPrompt, opts = {}) {
        if (!this.keyPool.size) {
            throw new Error('GROQ_API_KEY is not configured');
        }

        const model = opts.model || this.tradeModel;
        const body = {
            model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            temperature: opts.temperature ?? 0.35,
            max_tokens: opts.maxTokens ?? 8192,
        };

        // Quotas are per key — rotate through spare keys before escalating providers.
        let data;
        let lastErr;
        for (let attempt = 0; attempt < this.keyPool.size; attempt++) {
            const key = this.keyPool.next();
            try {
                ({ data } = await axios.post(API_URL, body, {
                    timeout: opts.timeoutMs ?? this.tradeTimeoutMs,
                    headers: {
                        Authorization: `Bearer ${key}`,
                        'Content-Type': 'application/json',
                    },
                }));
                lastErr = null;
                break;
            } catch (err) {
                lastErr = err;
                if (!isGroqRateLimitError(err)) throw err;
                this.keyPool.markRateLimited(key);
                if (attempt < this.keyPool.size - 1) {
                    logger.warn(`Groq key ${attempt + 1} rate limited — rotating to next key`);
                }
            }
        }
        if (lastErr) throw lastErr;

        const text = stripFences(data?.choices?.[0]?.message?.content || '');
        if (!text) {
            throw new Error('Groq empty response');
        }
        return text;
    }

    async _completeWithFallback(systemPrompt, userPrompt, opts = {}) {
        const chain = [...new Set((opts.models || this.models).filter(Boolean))];
        const attempts = [
            { prompt: userPrompt, maxTokens: opts.maxTokens ?? 2200, timeoutMs: opts.timeoutMs ?? this.tradeTimeoutMs },
            {
                prompt: userPrompt.slice(0, 9000) + (userPrompt.length > 9000 ? '\n\n[...trimmed...]' : ''),
                maxTokens: 2000,
                timeoutMs: Math.min(MAX_TRADE_TIMEOUT_MS, (opts.timeoutMs ?? this.tradeTimeoutMs) + 15_000),
            },
            {
                prompt: userPrompt.slice(0, 5000) + (userPrompt.length > 5000 ? '\n\n[...trimmed...]' : ''),
                maxTokens: 1800,
                timeoutMs: MAX_TRADE_TIMEOUT_MS,
            },
        ];

        let lastErr;
        for (const model of chain) {
            for (let i = 0; i < attempts.length; i++) {
                const attempt = attempts[i];
                try {
                    if (i > 0) {
                        logger.warn(`Groq trade retry ${i + 1} (${model}, ${attempt.prompt.length} chars)`);
                    }
                    const text = await this.complete(systemPrompt, attempt.prompt, {
                        model,
                        maxTokens: attempt.maxTokens,
                        timeoutMs: attempt.timeoutMs,
                    });
                    return { text, model };
                } catch (err) {
                    lastErr = err;
                    if (isGroqRateLimitError(err)) {
                        logger.warn(`Groq rate limited (${model}) — escalating to next trade provider`);
                        const e = new Error('Groq rate limit — switching provider');
                        e.isRateLimit = true;
                        e.cause = err;
                        throw e;
                    }
                    break;
                }
            }
        }
        throw lastErr || new Error('All Groq trade models failed');
    }

    async completeTrade(systemPrompt, userPrompt, opts = {}) {
        const { text } = await this._completeWithFallback(systemPrompt, userPrompt, {
            ...opts,
            maxTokens: opts.maxTokens ?? 900,
            timeoutMs: opts.timeoutMs ?? this.researchTimeoutMs,
        });
        return text;
    }

    async completeTradeAnalysis(systemPrompt, userPrompt, opts = {}) {
        const { text, model } = await this._completeWithFallback(systemPrompt, userPrompt, opts);
        logger.info(`Groq trade analysis done (${model})`);
        return text;
    }
}

export const groqTradeService = new GroqTradeService();
