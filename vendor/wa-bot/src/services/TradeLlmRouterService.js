/**
 * Trade LLM router: OrcaRouter (free DeepSeek V4 Flash) → Gemini → Groq → NVIDIA
 * → OpenRouter fallback chain.
 *
 * OrcaRouter sits at the head of the chain because it is free — /tradenow and
 * the daily scan cost nothing on the happy path. If OrcaRouter's key is unset
 * or its bucket is drained, everything else works exactly as before.
 *
 * Two things keep repeated `/tradenow` calls from failing:
 *  1. LlmRateGate — per-provider RPM budget + concurrency cap, so a burst of
 *     commands spreads across providers instead of stampeding provider[0].
 *  2. Every provider error falls through to the next provider. Only a genuine
 *     "nothing left to try" state surfaces an error to the user.
 * Rate-limited providers are cooled so the next symbol skips straight to a working one.
 */

import { logger } from '../utils/logger.js';
import { config } from '../config/config.js';
import GeminiTradeService, { isGeminiRateLimitError } from './GeminiTradeService.js';
import GroqTradeService, { isGroqRateLimitError } from './GroqTradeService.js';
import NvidiaDeepSeekService from './NvidiaDeepSeekService.js';
import OpenRouterLlmService, { isOpenRouterRateLimitError } from './OpenRouterLlmService.js';
import OrcaRouterTradeService, { isOrcaRouterRateLimitError } from './OrcaRouterTradeService.js';
import LlmRateGate, { parseRpmMap } from './LlmRateGate.js';

const DEFAULT_PROVIDER_ORDER = ['orcarouter', 'gemini', 'groq', 'nvidia', 'openrouter'];
/** After a 429, skip this provider for a bit (shared across daily scan symbols). */
const DEFAULT_COOLDOWN_MS = 90_000;
/** A bad/expired key is not going to fix itself in 90s. */
const AUTH_COOLDOWN_MS = 10 * 60_000;

/** 401/403 — the key is wrong, not busy. Cool it long and move on. */
export function isAuthError(err) {
    const status = err?.response?.status ?? err?.cause?.response?.status ?? err?.status;
    return status === 401 || status === 403;
}

function errorDetail(err) {
    const msg =
        err?.response?.data?.error?.message ||
        err?.cause?.response?.data?.error?.message ||
        err?.message ||
        String(err);
    return String(msg).replace(/\s+/g, ' ').slice(0, 160);
}

export function isTradeLlmRateLimitError(err) {
    if (err?.isRateLimit) return true;
    if (
        isOrcaRouterRateLimitError(err) ||
        isGeminiRateLimitError(err) ||
        isGroqRateLimitError(err) ||
        isOpenRouterRateLimitError(err)
    ) {
        return true;
    }
    const status = err?.response?.status ?? err?.cause?.response?.status;
    const msg = String(
        err?.response?.data?.error?.message ||
            err?.cause?.response?.data?.error?.message ||
            err?.message ||
            err
    );
    return (
        status === 429 ||
        /rate limit|quota|resource.?exhausted|too many requests|switching provider/i.test(msg)
    );
}

export function isTradeLlmFallbackError(err) {
    const msg = String(err?.message || err);
    const status = err?.response?.status ?? err?.cause?.response?.status;
    if (isTradeLlmRateLimitError(err)) return true;
    if (status === 503 || status === 502 || status === 504) return true;
    if (/timeout|ETIMEDOUT|ECONNABORTED|empty response|503|502|504|overloaded|unavailable/i.test(msg)) {
        return true;
    }
    return false;
}

export default class TradeLlmRouterService {
    constructor(cfg = config) {
        this.config = cfg;
        this.orcarouter = new OrcaRouterTradeService(cfg);
        this.gemini = new GeminiTradeService(cfg);
        this.groq = new GroqTradeService(cfg);
        this.nvidia = new NvidiaDeepSeekService(cfg);
        this.openrouter = new OpenRouterLlmService(cfg);
        this.providerOrder = this._parseProviderOrder(cfg.TRADE_LLM_PROVIDERS);
        this.lastProvider = null;
        /** @type {Map<string, number>} provider → cooledUntil epoch ms */
        this._cooledUntil = new Map();
        this.cooldownMs = Math.max(
            15_000,
            Math.min(5 * 60_000, Number(cfg.TRADE_LLM_COOLDOWN_MS) || DEFAULT_COOLDOWN_MS)
        );
        /** How long a queued request may wait for provider capacity before best-effort firing. */
        this.queueWaitMs = Math.max(
            0,
            Math.min(120_000, Number(cfg.TRADE_LLM_QUEUE_WAIT_MS) ?? 45_000)
        );
        this.gate = new LlmRateGate({
            rpm: parseRpmMap(cfg.TRADE_LLM_RPM),
            perProvider: Number(cfg.TRADE_LLM_MAX_PER_PROVIDER) || 2,
            maxConcurrent: Number(cfg.TRADE_LLM_MAX_CONCURRENT) || 3,
        });
        // Extra keys on a provider raise its effective per-minute budget.
        for (const { name, svc } of Object.values(this._providerMap())) {
            const keys = svc?.keyPool?.size;
            if (keys > 1) this.gate.setKeyCount(name, keys);
        }
    }

    _parseProviderOrder(raw) {
        const allowed = new Set(DEFAULT_PROVIDER_ORDER);
        const parts = String(raw || '')
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter((s) => allowed.has(s));
        return parts.length ? parts : [...DEFAULT_PROVIDER_ORDER];
    }

    _providerMap() {
        return {
            orcarouter: {
                name: 'orcarouter',
                svc: this.orcarouter,
                label: () => `OrcaRouter ${this.orcarouter.tradeModel}`,
            },
            gemini: { name: 'gemini', svc: this.gemini, label: () => `Gemini ${this.gemini.tradeModel}` },
            groq: { name: 'groq', svc: this.groq, label: () => `Groq ${this.groq.tradeModel}` },
            nvidia: {
                name: 'nvidia',
                svc: this.nvidia,
                label: () => `NVIDIA ${this.nvidia.tradeModel}`,
            },
            openrouter: {
                name: 'openrouter',
                svc: this.openrouter,
                label: () => `OpenRouter ${this.openrouter.tradeModel}`,
            },
        };
    }

    _providers() {
        const map = this._providerMap();
        return this.providerOrder
            .map((key) => map[key])
            .filter((p) => p && p.svc.isConfigured());
    }

    _isCooled(name) {
        return (this._cooledUntil.get(name) || 0) > Date.now();
    }

    /** Prefer live providers; cooled (rate-limited) ones go last. */
    _providersForAttempt() {
        const all = this._providers();
        const live = all.filter((p) => !this._isCooled(p.name));
        const cooled = all.filter((p) => this._isCooled(p.name));
        return [...live, ...cooled];
    }

    _markCooled(name, ms = this.cooldownMs) {
        this._cooledUntil.set(name, Date.now() + ms);
        logger.warn(`Trade LLM provider ${name} cooled for ${Math.round(ms / 1000)}s`);
    }

    /**
     * Choose the next provider to try: live before cooled, ready before queued,
     * least-loaded before busy, configured priority as the tiebreak.
     * Returns the provider together with its already-reserved gate slot, so no
     * other concurrent request can claim the same capacity in between.
     * @param {Set<string>} tried
     * @param {number} queueDeadline epoch ms — shared across all hops of one request
     * @returns {Promise<{ provider: object, release: () => void }|null>}
     */
    async _pickProvider(all, tried, queueDeadline = 0) {
        const pool = all.filter((p) => !tried.has(p.name));
        if (!pool.length) return null;

        const live = pool.filter((p) => !this._isCooled(p.name));
        // Everything cooled → the cooldowns are stale guesses, retry anyway.
        const candidates = live.length ? live : pool;
        const rank = (p) => this.providerOrder.indexOf(p.name);
        const byLoad = (a, b) =>
            this.gate.inflight(a.name) - this.gate.inflight(b.name) || rank(a) - rank(b);

        let queued = false;
        for (;;) {
            for (const provider of [...candidates].sort(byLoad)) {
                const release = this.gate.tryTake(provider.name);
                if (release) {
                    if (queued) logger.info(`Trade LLM dequeued onto ${provider.name}`);
                    return { provider, release };
                }
            }

            // All at capacity — wait rather than burning a guaranteed 429.
            // The budget is shared across hops so a 4-provider chain can't wait 4×.
            const budget = Math.max(0, queueDeadline - Date.now());
            if (!budget) break;
            if (!queued) {
                queued = true;
                logger.info(
                    `Trade LLM queueing — [${candidates.map((p) => p.name).join(', ')}] at capacity`
                );
            }
            const freed = await this.gate.waitForAny(
                candidates.map((p) => p.name),
                budget
            );
            // freed may have been claimed by another request — loop and re-reserve.
            if (!freed) break;
        }

        // Queue budget spent: fire best-effort rather than failing without trying.
        const provider = [...candidates].sort(byLoad)[0];
        return { provider, release: this.gate.take(provider.name) };
    }

    isConfigured() {
        return this._providers().length > 0;
    }

    getModelChain() {
        return this._providers().map((p) => p.label());
    }

    getPrimaryLabel() {
        const providers = this._providersForAttempt();
        if (!providers.length) return 'none';
        return providers[0].label();
    }

    isTimeoutError(err) {
        return /timeout|ETIMEDOUT|ECONNABORTED/i.test(String(err?.message || err));
    }

    async _route(method, systemPrompt, userPrompt, opts = {}) {
        const all = this._providers();
        if (!all.length) {
            throw new Error(
                'No trade LLM configured (set ORCAROUTER_API_KEY [free], GEMINI_API_KEY, GROQ_API_KEY, NVIDIA_API_KEY, or OPENROUTER_API_KEY)'
            );
        }

        const tried = new Set();
        const failures = [];
        const queueDeadline = Date.now() + this.queueWaitMs;
        let lastErr;
        let sawRateLimit = false;

        // One hop per configured provider — every failure falls through to the next.
        for (let hop = 0; hop < all.length; hop++) {
            const picked = await this._pickProvider(all, tried, queueDeadline);
            if (!picked) break;
            const { provider, release } = picked;
            tried.add(provider.name);

            if (!provider.svc[method]) {
                release();
                failures.push(`${provider.name}: missing ${method}`);
                continue;
            }

            try {
                const text = await provider.svc[method](systemPrompt, userPrompt, opts);
                this.lastProvider = provider.name;
                this._cooledUntil.delete(provider.name);
                if (tried.size > 1) {
                    logger.info(`Trade LLM fallback succeeded via ${provider.name}`);
                }
                return text;
            } catch (err) {
                lastErr = err;
                failures.push(`${provider.name}: ${errorDetail(err)}`);
                if (isTradeLlmRateLimitError(err)) {
                    sawRateLimit = true;
                    this._markCooled(provider.name);
                } else if (isAuthError(err)) {
                    this._markCooled(provider.name, AUTH_COOLDOWN_MS);
                } else if (!isTradeLlmFallbackError(err)) {
                    // Prompt too long, safety block, bad model id — provider-specific,
                    // so cool it briefly and let a different provider handle it.
                    this._markCooled(provider.name, Math.min(this.cooldownMs, 30_000));
                }
                logger.warn(`Trade ${provider.name} failed — trying next provider: ${errorDetail(err)}`);
            } finally {
                release();
            }
        }

        if (sawRateLimit) {
            const e = new Error(
                'All trade LLM providers rate limited — wait 30–60 seconds and try `/tradenow` again.'
            );
            e.isRateLimit = true;
            e.cause = lastErr;
            e.providerErrors = failures;
            throw e;
        }
        const e = new Error(`All trade LLM providers failed — ${failures.join(' | ')}`);
        e.cause = lastErr;
        e.providerErrors = failures;
        throw e;
    }

    /** Per-provider budget snapshot for `/tradelert status`. */
    getGateStatus() {
        return this.gate.snapshot(this._providers().map((p) => p.name)).map((s) => ({
            ...s,
            cooled: this._isCooled(s.name),
        }));
    }

    async completeTrade(systemPrompt, userPrompt, opts = {}) {
        return this._route('completeTrade', systemPrompt, userPrompt, opts);
    }

    async completeTradeAnalysis(systemPrompt, userPrompt, opts = {}) {
        return this._route('completeTradeAnalysis', systemPrompt, userPrompt, opts);
    }
}

export const tradeLlmRouterService = new TradeLlmRouterService();
