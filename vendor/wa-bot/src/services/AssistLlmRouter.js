/**
 * Assist DM chat router: Gemini → Groq → NVIDIA → OpenRouter.
 */

import axios from 'axios';
import { logger } from '../utils/logger.js';
import { config } from '../config/config.js';
import { isGeminiRateLimitError } from './GeminiTradeService.js';
import { isGroqRateLimitError } from './GroqTradeService.js';
import NvidiaDeepSeekService from './NvidiaDeepSeekService.js';
import OpenRouterLlmService, { isOpenRouterRateLimitError } from './OpenRouterLlmService.js';

const GEMINI_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const NVIDIA_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

const DEFAULT_GEMINI = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-pro'];
// Verified live against the Groq API (2026-09-08): the old llama-3.1-8b-instant /
// llama-3.3-70b-versatile names now 404 on every key — every provider in the
// chain died at once and callers saw "LLM hiccup". These two respond and are fast.
const DEFAULT_GROQ = ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b'];
const DEFAULT_PROVIDERS = ['gemini', 'groq', 'nvidia', 'openrouter'];

function parseList(raw, fallback) {
    const parts = String(raw || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    return parts.length ? parts : [...fallback];
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * A quota/limit that will NOT clear on a short retry, so the provider should be
 * cooled and skipped rather than re-walked model by model.
 *
 * Distinguished from a transient 429: a burst limit recovers in seconds, a daily
 * quota does not. Google says "exceeded your current quota ... check your plan",
 * which is the daily one.
 */
export function isQuotaExhaustedError(err) {
    const msg = String(err?.message || err);
    const detail = String(
        err?.response?.data?.error?.message || err?.response?.data?.error || ''
    );
    const both = `${msg} ${detail}`;
    if (/RESOURCE_EXHAUSTED|exceeded your current quota|check your plan|insufficient_quota|billing/i.test(both)) {
        return true;
    }
    // A plain 429 with no burst hint is treated as a limit worth cooling for.
    return err?.response?.status === 429 && !/retry|temporar|burst|per minute|slow down/i.test(both);
}

export function isAssistLlmFallbackError(err) {
    const msg = String(err?.message || err);
    const status = err?.response?.status;
    if (isGeminiRateLimitError(err) || isGroqRateLimitError(err) || isOpenRouterRateLimitError(err)) return true;
    if (status === 429 || status === 503 || status === 502 || status === 504 || status === 408) return true;
    if (status === 402 || status === 401 || status === 403) return true;
    return /rate limit|quota|timeout|ETIMEDOUT|ECONNABORTED|empty response|overloaded|unavailable|credit|exhausted|capacity|RESOURCE_EXHAUSTED|high demand/i.test(
        msg
    );
}

function toOpenAiMessages(systemPrompt, history, userBlock) {
    const messages = [{ role: 'system', content: systemPrompt }];
    for (const turn of history || []) {
        messages.push({
            role: turn.role === 'assistant' ? 'assistant' : 'user',
            content: String(turn.text || '').slice(0, 800),
        });
    }
    messages.push({ role: 'user', content: userBlock });
    return messages;
}

export default class AssistLlmRouter {
    constructor(cfg = config) {
        this.cfg = cfg;
        this.geminiKey = (cfg.GEMINI_API_KEY || '').trim();
        this.groqKey = (cfg.GROQ_API_KEY || '').trim();
        this.nvidiaKey = (cfg.NVIDIA_API_KEY || '').trim();
        this.geminiModels = parseList(cfg.ASSIST_GEMINI_MODELS || cfg.ASSIST_GEMINI_MODEL, DEFAULT_GEMINI);
        this.groqModels = parseList(cfg.ASSIST_GROQ_MODELS || cfg.ASSIST_GROQ_MODEL || cfg.GROQ_TRADE_MODEL, DEFAULT_GROQ);
        // deepseek-v4-flash was the old default here AND the .env value, and it is
        // not on the NVIDIA endpoint any more (404). With Groq unkeyed, Gemini out
        // of quota and OpenRouter's free llama slug withdrawn, that made every
        // provider in this chain dead at once — which is what silently stopped the
        // Interview Q scheduler on 2026-08-08. Default to a verified model.
        this.nvidiaModels = parseList(
            cfg.ASSIST_NVIDIA_MODELS || cfg.ASSIST_NVIDIA_MODEL || cfg.NVIDIA_MODEL,
            ['nvidia/nemotron-3-super-120b-a12b']
        );
        this.openrouter = new OpenRouterLlmService(cfg);
        this.providerOrder = this._normalizeProviderOrder(
            parseList(cfg.ASSIST_LLM_PROVIDERS || cfg.TRADE_LLM_PROVIDERS, DEFAULT_PROVIDERS)
        );
        this.timeoutMs = Math.min(60_000, Math.max(15_000, Number(cfg.ASSIST_TIMEOUT_MS) || 45_000));
        this.nvidia = new NvidiaDeepSeekService(cfg);
        /**
         * provider -> epoch ms until which it is skipped.
         *
         * Without this, a provider whose DAILY quota is exhausted was retried from
         * scratch on every call: 4 Gemini models x 2 attempts before reaching a
         * working provider, which is why one Interview Q generation took 163s. A
         * 1.5s retry cannot fix a daily quota, so cool the provider and move on.
         * @type {Map<string, number>}
         */
        this._cooledUntil = new Map();
        this.cooldownMs = Math.min(
            60 * 60_000,
            Math.max(60_000, Number(cfg.ASSIST_LLM_COOLDOWN_MS) || 15 * 60_000)
        );
    }

    /** True when this provider is currently cooled off. */
    isCooled(provider, nowMs = Date.now()) {
        const until = this._cooledUntil.get(provider);
        return Boolean(until && until > nowMs);
    }

    _coolProvider(provider, reason) {
        this._cooledUntil.set(provider, Date.now() + this.cooldownMs);
        logger.warn(
            `Assist provider ${provider} cooled ${Math.round(this.cooldownMs / 60_000)}m — ${reason}`
        );
    }

    /** Live providers first, cooled ones last rather than dropped — a cooled
     *  provider still beats failing outright when everything else is down. */
    _orderedProviders() {
        const all = this._availableProviders();
        const live = all.filter((p) => !this.isCooled(p));
        const cooled = all.filter((p) => this.isCooled(p));
        return [...live, ...cooled];
    }

    /** Always keep OpenRouter as last-resort when an API key exists. */
    _normalizeProviderOrder(order) {
        const out = [];
        for (const p of order || []) {
            const id = String(p || '').toLowerCase().trim();
            if (!id || out.includes(id)) continue;
            out.push(id);
        }
        if (this.openrouter.isConfigured() && !out.includes('openrouter')) {
            out.push('openrouter');
        }
        return out.length ? out : [...DEFAULT_PROVIDERS];
    }

    _availableProviders() {
        return this.providerOrder.filter((p) => {
            if (p === 'gemini') return Boolean(this.geminiKey);
            if (p === 'groq') return Boolean(this.groqKey);
            if (p === 'nvidia') return Boolean(this.nvidiaKey);
            if (p === 'openrouter') return this.openrouter.isConfigured();
            return false;
        });
    }

    isConfigured() {
        return Boolean(this.geminiKey || this.groqKey || this.nvidiaKey || this.openrouter.isConfigured());
    }

    getProviderChain() {
        const out = [];
        for (const p of this._availableProviders()) {
            if (p === 'gemini') out.push(`Gemini ${this.geminiModels[0]}`);
            else if (p === 'groq') out.push(`Groq ${this.groqModels[0]}`);
            else if (p === 'nvidia') out.push(`NVIDIA ${this.nvidiaModels[0].split('/').pop()}`);
            else if (p === 'openrouter') out.push(`OpenRouter ${this.openrouter.tradeModel}`);
        }
        return out;
    }

    async completeChat({ systemPrompt, history, userBlock, maxTokens = 512, temperature = 0.75, maxChars = 2000 }) {
        const outLimit = Math.min(50_000, Math.max(200, Number(maxChars) || 2000));
        const providers = this._orderedProviders();

        if (!providers.length) {
            throw new Error('No assist LLM configured (GEMINI, GROQ, NVIDIA, or OPENROUTER API key)');
        }

        let lastErr;
        for (let pi = 0; pi < providers.length; pi++) {
            const provider = providers[pi];
            const models =
                provider === 'gemini'
                    ? this.geminiModels
                    : provider === 'groq'
                      ? this.groqModels
                      : provider === 'openrouter'
                        ? ['openrouter']
                        : this.nvidiaModels;

            let providerCooled = false;
            for (const model of models) {
                if (providerCooled) break;      // quota is per-provider, not per-model
                for (let rateTry = 0; rateTry < 2; rateTry++) {
                    try {
                        let text;
                        let usedModel = model;
                        if (provider === 'gemini') {
                            text = await this._callGemini(model, systemPrompt, history, userBlock, {
                                maxTokens,
                                temperature,
                            });
                        } else if (provider === 'groq') {
                            text = await this._callGroq(model, systemPrompt, history, userBlock, {
                                maxTokens,
                                temperature,
                            });
                        } else if (provider === 'openrouter') {
                            const res = await this.openrouter.chat({
                                messages: toOpenAiMessages(systemPrompt, history, userBlock),
                                temperature,
                                maxTokens,
                                timeoutMs: Math.max(this.timeoutMs, 90_000),
                            });
                            text = res.text;
                            usedModel = res.model;
                        } else {
                            text = await this._callNvidia(model, systemPrompt, history, userBlock, {
                                maxTokens,
                                temperature,
                            });
                        }

                        if (!text?.trim()) {
                            throw new Error(`${provider} empty reply`);
                        }

                        if (pi > 0) {
                            logger.info(`Assist fallback succeeded via ${provider}/${usedModel}`);
                        }
                        return { text: text.trim().slice(0, outLimit), provider, model: usedModel };
                    } catch (err) {
                        lastErr = err;
                        // A daily quota will not recover in 1.5s. Cool the whole
                        // provider and jump to the next one instead of walking its
                        // remaining models.
                        if (isQuotaExhaustedError(err)) {
                            this._coolProvider(provider, err.message.slice(0, 80));
                            providerCooled = true;
                            break;
                        }
                        if (isAssistLlmFallbackError(err) && rateTry < 1) {
                            await sleep(1500);
                            continue;
                        }
                        logger.warn(`Assist ${provider}/${model} failed: ${err.message}`);
                        break;
                    }
                }
            }

            if (pi < providers.length - 1) {
                logger.warn(
                    `Assist ${provider} exhausted — trying next provider` +
                        (lastErr ? ` (last: ${lastErr.message})` : '')
                );
            }
        }

        throw lastErr || new Error('All assist LLM providers failed');
    }

    async _callGemini(model, systemPrompt, history, userBlock, { maxTokens, temperature }) {
        const contents = [];
        for (const turn of history || []) {
            contents.push({
                role: turn.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: turn.text }],
            });
        }
        contents.push({ role: 'user', parts: [{ text: userBlock }] });

        const url = `${GEMINI_ROOT}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(this.geminiKey)}`;
        const { data } = await axios.post(
            url,
            {
                contents,
                systemInstruction: { parts: [{ text: systemPrompt }] },
                generationConfig: {
                    temperature,
                    maxOutputTokens: maxTokens,
                    // Gemini 2.5+ spends "thinking" tokens out of maxOutputTokens, so a
                    // JSON reply gets truncated mid-object and the caller sees "No JSON
                    // object in AI response". Measured: 1200 tokens returned 56 chars.
                    // These callers want structured output, not reasoning — spend the
                    // whole budget on the answer.
                    thinkingConfig: { thinkingBudget: 0 },
                },
            },
            {
                timeout: this.timeoutMs,
                headers: { 'Content-Type': 'application/json' },
                validateStatus: (s) => s >= 200 && s < 300,
            }
        );

        const parts = data?.candidates?.[0]?.content?.parts || [];
        const text = parts.map((p) => p?.text || '').join('').trim();
        if (!text && data?.candidates?.[0]?.finishReason === 'SAFETY') {
            throw new Error('Gemini safety block');
        }
        return text;
    }

    async _callGroq(model, systemPrompt, history, userBlock, { maxTokens, temperature }) {
        const messages = toOpenAiMessages(systemPrompt, history, userBlock);
        const { data } = await axios.post(
            GROQ_URL,
            {
                model,
                messages,
                temperature,
                max_tokens: maxTokens,
            },
            {
                timeout: this.timeoutMs,
                headers: {
                    Authorization: `Bearer ${this.groqKey}`,
                    'Content-Type': 'application/json',
                },
            }
        );
        return data?.choices?.[0]?.message?.content || '';
    }

    async _callNvidia(model, systemPrompt, history, userBlock, { maxTokens, temperature }) {
        const messages = toOpenAiMessages(systemPrompt, history, userBlock);
        const { data } = await axios.post(
            NVIDIA_URL,
            {
                model,
                messages,
                temperature,
                max_tokens: maxTokens,
                stream: false,
            },
            {
                timeout: this.timeoutMs,
                headers: {
                    Authorization: `Bearer ${this.nvidiaKey}`,
                    'Content-Type': 'application/json',
                },
            }
        );
        const content = this.nvidia.extractMessageContent(data);
        return content || '';
    }
}

export const assistLlmRouter = new AssistLlmRouter();
