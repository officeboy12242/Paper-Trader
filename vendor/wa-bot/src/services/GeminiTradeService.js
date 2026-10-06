/**
 * Google Gemini for trade discovery, research brief, and CE/PE analysis.
 * Replaces GLM/NVIDIA for /tradelert and /tradenow.
 */

import axios from 'axios';
import { logger } from '../utils/logger.js';
import { config } from '../config/config.js';
import { buildKeyPool } from '../utils/apiKeyPool.js';

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_TRADE_MODELS = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'];
const MAX_TRADE_TIMEOUT_MS = 180_000;

function shortModelName(model) {
    return String(model || '').replace(/^models\//, '').split('/').pop() || model;
}

function clampTimeoutMs(raw, cap = MAX_TRADE_TIMEOUT_MS) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return 120_000;
    return Math.min(cap, Math.max(25_000, n));
}

export function isGeminiRateLimitError(err) {
    if (err?.isRateLimit) return true;
    const status = err?.response?.status ?? err?.cause?.response?.status;
    const msg = String(
        err?.response?.data?.error?.message ||
            err?.cause?.response?.data?.error?.message ||
            err?.message ||
            err
    );
    return status === 429 || /quota|rate.?limit|resource.?exhausted/i.test(msg);
}

function rateLimitError(message, cause) {
    const e = new Error(message);
    e.isRateLimit = true;
    if (cause) e.cause = cause;
    return e;
}

export default class GeminiTradeService {
    constructor(cfg = config) {
        this.keyPool = buildKeyPool(
            cfg.GEMINI_API_KEYS || process.env.GEMINI_API_KEYS,
            cfg.GEMINI_API_KEY || process.env.GEMINI_API_KEY
        );
        this.models = this._parseModelChain(cfg.GEMINI_TRADE_MODELS || cfg.GEMINI_TRADE_MODEL);
        this.tradeModel = this.models[0];
        this.tradeTimeoutMs = clampTimeoutMs(cfg.TRADE_ANALYSIS_TIMEOUT_MS || 150_000);
        this.researchTimeoutMs = clampTimeoutMs(
            cfg.TRADE_RESEARCH_TIMEOUT_MS || 55_000,
            90_000
        );
    }

    _parseModelChain(raw) {
        if (!raw) return [...DEFAULT_TRADE_MODELS];
        const parts = String(raw)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        return parts.length ? [...new Set(parts)] : [...DEFAULT_TRADE_MODELS];
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

    /**
     * @param {string} systemPrompt
     * @param {string} userPrompt
     * @param {{ model?: string, maxTokens?: number, timeoutMs?: number, temperature?: number }} [opts]
     */
    async complete(systemPrompt, userPrompt, opts = {}) {
        if (!this.keyPool.size) {
            throw new Error('GEMINI_API_KEY is not configured');
        }

        const model = opts.model || this.tradeModel;
        const body = {
            contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
            systemInstruction: { parts: [{ text: systemPrompt }] },
            generationConfig: {
                temperature: opts.temperature ?? 0.35,
                maxOutputTokens: opts.maxTokens ?? 8192,
            },
        };

        // Quotas are per key — rotate through spare keys before escalating providers.
        let data;
        let lastErr;
        for (let attempt = 0; attempt < this.keyPool.size; attempt++) {
            const key = this.keyPool.next();
            const url = `${API_ROOT}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
            try {
                ({ data } = await axios.post(url, body, {
                    timeout: opts.timeoutMs ?? this.tradeTimeoutMs,
                    headers: { 'Content-Type': 'application/json' },
                    validateStatus: (s) => s >= 200 && s < 300,
                }));
                lastErr = null;
                break;
            } catch (err) {
                lastErr = err;
                if (!isGeminiRateLimitError(err)) throw err;
                this.keyPool.markRateLimited(key);
                if (attempt < this.keyPool.size - 1) {
                    logger.warn(`Gemini key ${attempt + 1} rate limited — rotating to next key`);
                }
            }
        }
        if (lastErr) {
            throw rateLimitError('Gemini rate limit — switching provider', lastErr);
        }

        const parts = data?.candidates?.[0]?.content?.parts || [];
        let text = parts.map((p) => p?.text || '').join('').trim();

        if (!text && data?.candidates?.[0]?.finishReason === 'SAFETY') {
            throw new Error('Gemini blocked response (safety)');
        }
        if (!text) {
            throw new Error('Gemini empty response');
        }

        return text
            .replace(/^```(?:markdown|text)?\s*/i, '')
            .replace(/\s*```$/i, '')
            .trim();
    }

    /**
     * Short vision caption for group-recap logging. Fail-soft caller should
     * fall back to plain [image] on throw.
     * @param {Buffer} buffer
     * @param {{ mimeType?: string, caption?: string, model?: string, timeoutMs?: number }} [opts]
     * @returns {Promise<string>}
     */
    async describeImage(buffer, opts = {}) {
        if (!this.keyPool.size) {
            throw new Error('GEMINI_API_KEY is not configured');
        }
        if (!Buffer.isBuffer(buffer) || buffer.length < 32) {
            throw new Error('Gemini describeImage: empty image buffer');
        }
        // Keep payloads small — WhatsApp photos are usually fine; skip monsters.
        if (buffer.length > 4 * 1024 * 1024) {
            throw new Error('Gemini describeImage: image too large (>4MB)');
        }

        const mimeType = String(opts.mimeType || 'image/jpeg').split(';')[0].trim() || 'image/jpeg';
        const caption = String(opts.caption || '').trim().slice(0, 200);
        const model = opts.model || this.tradeModel;
        const prompt = [
            'Describe this WhatsApp group-chat image in 1-2 short sentences for a daily recap.',
            'Be concrete: readable on-screen text, charts/tickers, memes, products, people, documents.',
            'No preamble, no markdown — just the description.',
            caption ? `Sender caption: ${caption}` : '',
        ]
            .filter(Boolean)
            .join(' ');

        const body = {
            contents: [
                {
                    role: 'user',
                    parts: [
                        { inlineData: { mimeType, data: buffer.toString('base64') } },
                        { text: prompt },
                    ],
                },
            ],
            generationConfig: {
                temperature: 0.2,
                maxOutputTokens: 120,
            },
        };

        let data;
        let lastErr;
        for (let attempt = 0; attempt < this.keyPool.size; attempt++) {
            const key = this.keyPool.next();
            const url = `${API_ROOT}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
            try {
                ({ data } = await axios.post(url, body, {
                    timeout: opts.timeoutMs ?? 20_000,
                    headers: { 'Content-Type': 'application/json' },
                    validateStatus: (s) => s >= 200 && s < 300,
                }));
                lastErr = null;
                break;
            } catch (err) {
                lastErr = err;
                if (!isGeminiRateLimitError(err)) throw err;
                this.keyPool.markRateLimited(key);
                if (attempt < this.keyPool.size - 1) {
                    logger.warn(`Gemini vision key ${attempt + 1} rate limited — rotating`);
                }
            }
        }
        if (lastErr) {
            throw rateLimitError('Gemini rate limit — image describe skipped', lastErr);
        }

        const parts = data?.candidates?.[0]?.content?.parts || [];
        const text = parts
            .map((p) => p?.text || '')
            .join('')
            .trim()
            .replace(/\s+/g, ' ');
        if (!text) {
            throw new Error('Gemini describeImage: empty response');
        }
        return text.slice(0, 280);
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
        // Rate limits are project-wide — do not burn retries across Gemini models; escalate to router.
        for (const model of chain) {
            for (let i = 0; i < attempts.length; i++) {
                const attempt = attempts[i];
                try {
                    if (i > 0) {
                        logger.warn(
                            `Gemini trade retry ${i + 1} (${shortModelName(model)}, ${attempt.prompt.length} chars)`
                        );
                    }
                    const text = await this.complete(systemPrompt, attempt.prompt, {
                        model,
                        maxTokens: attempt.maxTokens,
                        timeoutMs: attempt.timeoutMs,
                    });
                    return { text, model: shortModelName(model) };
                } catch (err) {
                    lastErr = err;
                    const msg = String(err?.response?.data?.error?.message || err?.message || err);
                    const status = err?.response?.status;
                    if (isGeminiRateLimitError(err)) {
                        logger.warn(
                            `Gemini rate limited (${shortModelName(model)}) — escalating to next trade provider`
                        );
                        throw rateLimitError('Gemini rate limit — switching provider', err);
                    }
                    if (status === 404 || /not found|invalid.*model/i.test(msg)) {
                        break; // next model
                    }
                    if (!this.isTimeoutError(err) && i === attempts.length - 1) {
                        break;
                    }
                    // timeout / empty → try smaller prompt on same model
                    if (!this.isTimeoutError(err) && !/empty response/i.test(msg)) {
                        break;
                    }
                }
            }
        }
        throw lastErr || new Error('All Gemini trade models failed');
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
        logger.info(`Gemini trade analysis done (${model})`);
        return text;
    }
}

export const geminiTradeService = new GeminiTradeService();
