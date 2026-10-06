/**
 * IPO Controller — WhatsApp command handler for /ipo
 *
 * Commands:
 *   /ipo          — List all current/upcoming IPOs with GMP
 *   /ipo <name>   — Full analysis card (computed score + AI verdict)
 *   /ipo gmp      — Show GMP leaderboard
 *   /ipo sub <name> — Subscription status only
 */

import { logger } from '../utils/logger.js';
import { editMessageText } from '../utils/waMessage.js';
import IndianIpoService from '../services/IndianIpoService.js';
import { IPO_ANALYSIS_SYSTEM_PROMPT, buildIpoUserPrompt } from '../prompts/ipoAnalysisPrompt.js';

class IpoController {
    constructor(config, mongoDb) {
        this.config = config;
        this.ipoService = new IndianIpoService();
        this.mongoDb = mongoDb;
        this._snapshotCollection = null;
    }

    async init() {
        if (this.mongoDb) {
            this._snapshotCollection = this.mongoDb.collection('ipo_snapshots');
            await this._snapshotCollection.createIndex({ name: 1, date: 1 }, { unique: true });
            await this._snapshotCollection.createIndex({ closeDate: 1 });
            await this._snapshotCollection.createIndex({ listingDate: 1 });
            logger.info('📊 IPO snapshot store ready');
        }
    }

    /** Save a snapshot of IPO data for day-1 vs later comparison. */
    async _saveSnapshot(ipo, scoreData) {
        if (!this._snapshotCollection || !ipo?.name) return;
        try {
            const today = new Date().toISOString().slice(0, 10);
            await this._snapshotCollection.updateOne(
                { name: ipo.name, date: today },
                {
                    $setOnInsert: { name: ipo.name, date: today },
                    $set: {
                        priceBand: ipo.priceBand,
                        priceHigh: ipo.priceHigh,
                        lotSize: ipo.lotSize,
                        gmp: ipo.latestGmp?.gmp || null,
                        gmpPct: ipo.latestGmp?.gain || null,
                        subscription: ipo.subscription || null,
                        score: scoreData?.score || null,
                        openDate: ipo.openDate,
                        closeDate: ipo.closeDate,
                        listingDate: ipo.listingDate,
                        updatedAt: new Date(),
                    },
                },
                { upsert: true }
            );
        } catch (err) {
            logger.debug(`IPO snapshot save failed: ${err.message}`);
        }
    }

    /** Get the earliest snapshot for an IPO (day 1 data) for comparison. */
    async _getDay1Snapshot(name) {
        if (!this._snapshotCollection || !name) return null;
        try {
            return await this._snapshotCollection.findOne(
                { name },
                { sort: { date: 1 } }
            );
        } catch {
            return null;
        }
    }

    /**
     * IPO analysis LLM call. Uses OrcaRouter DeepSeek V4 Flash (free) first;
     * falls back to the standard trade LLM chain (Gemini/Groq/NVIDIA/OpenRouter)
     * — now with OrcaRouter as its own head — via the public
     * TradeLlmRouterService.completeTradeAnalysis surface. Never throws just
     * because telemetry is off: this file is intentionally free of the old
     * LlmTelemetry service that the observability commit added, since we
     * reverted that commit.
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
                        temperature: 0.4,
                        max_tokens: 16000,
                        reasoning_effort: 'low',
                    }),
                    signal: AbortSignal.timeout(150_000),
                });
                if (resp.ok) {
                    const data = await resp.json();
                    const content = data.choices?.[0]?.message?.content || '';
                    if (content) return content;
                    logger.warn('OrcaRouter IPO LLM returned empty content');
                } else {
                    logger.warn(`OrcaRouter IPO LLM failed: HTTP ${resp.status}`);
                }
            } catch (err) {
                logger.warn(`OrcaRouter IPO LLM error: ${err.message}`);
            }
        }

        // Fallback: existing trade LLM chain (its own head is OrcaRouter too now).
        try {
            const { default: TradeLlmRouterService } = await import('../services/TradeLlmRouterService.js');
            const router = new TradeLlmRouterService(this.config);
            if (router.isConfigured?.()) {
                return await router.completeTradeAnalysis(systemPrompt, userPrompt, {
                    temperature: 0.4,
                    maxTokens: 4000,
                });
            }
        } catch (err) {
            logger.warn(`IPO LLM fallback (trade router) failed: ${err.message}`);
        }

        throw new Error('No LLM provider available (set ORCAROUTER_API_KEY or a trade LLM key)');
    }

    /** Handle /ipo command. */
    async handle(sock, chatId, senderJid, args, originalMsg) {
        const subCommand = (args[0] || '').toLowerCase();

        if (!subCommand || subCommand === 'list') {
            return this._handleList(sock, chatId, originalMsg);
        }
        if (subCommand === 'gmp') {
            return this._handleGmpLeaderboard(sock, chatId, originalMsg);
        }
        if (subCommand === 'sub') {
            const name = args.slice(1).join(' ');
            if (!name) return this._sendText(sock, chatId, '❌ Usage: `/ipo sub Horizon`', originalMsg);
            return this._handleSubscription(sock, chatId, name, originalMsg);
        }

        // /ipo <number> — full analysis by list position
        const num = parseInt(subCommand, 10);
        if (Number.isFinite(num) && num > 0) {
            return this._handleAnalysisByNumber(sock, chatId, num, originalMsg);
        }

        // /ipo <name> — full analysis
        const name = args.join(' ');
        return this._handleAnalysis(sock, chatId, name, originalMsg);
    }

    async _handleAnalysisByNumber(sock, chatId, num, originalMsg) {
        const loading = await this._sendText(
            sock,
            chatId,
            `🔍 _Fetching IPO #${num}…_`,
            originalMsg
        );
        try {
            const ipos = await this.ipoService.getCurrentIpos();
            if (num > ipos.length) {
                return editMessageText(sock, chatId, loading?.key, `❌ Only ${ipos.length} IPOs in list. Use /ipo to see them.`);
            }
            const target = ipos[num - 1];
            await editMessageText(sock, chatId, loading?.key, `🔍 _Analyzing ${target.name}…_`);
            return this._handleAnalysis(sock, chatId, target.name, originalMsg);
        } catch (err) {
            logger.error(`IPO #${num} failed: ${err.message}`);
            await editMessageText(sock, chatId, loading?.key, `❌ ${err.message}`);
        }
    }

    async _handleList(sock, chatId, originalMsg) {
        const loading = await this._sendText(sock, chatId, '📊 _Fetching current Indian IPOs…_', originalMsg);
        try {
            const ipos = await this.ipoService.getCurrentIpos();
            if (!ipos.length) {
                return editMessageText(sock, chatId, loading?.key, '📭 No current/upcoming IPOs found right now.');
            }
            const card = this.ipoService.formatListCard(ipos);
            await editMessageText(sock, chatId, loading?.key, card);
        } catch (err) {
            logger.error(`IPO list failed: ${err.message}`);
            await editMessageText(sock, chatId, loading?.key, `❌ Failed to fetch IPO list: ${err.message}`);
        }
    }

    async _handleGmpLeaderboard(sock, chatId, originalMsg) {
        const loading = await this._sendText(sock, chatId, '📊 _Fetching GMP data…_', originalMsg);
        try {
            const gmpList = await this.ipoService.getLiveGmpList();
            if (!gmpList.length) {
                return editMessageText(sock, chatId, loading?.key, '📭 No GMP data available right now.');
            }
            await editMessageText(sock, chatId, loading?.key, this.ipoService.formatGmpLeaderboard(gmpList));
        } catch (err) {
            logger.error(`IPO GMP failed: ${err.message}`);
            await editMessageText(sock, chatId, loading?.key, `❌ GMP fetch failed: ${err.message}`);
        }
    }

    async _handleSubscription(sock, chatId, name, originalMsg) {
        const loading = await this._sendText(sock, chatId, `📊 _Fetching subscription for ${name}…_`, originalMsg);
        try {
            const ipo = await this.ipoService.getIpoByName(name);
            if (!ipo?.subscription) {
                return editMessageText(sock, chatId, loading?.key, `❌ No subscription data for "${name}"`);
            }
            const text = this.ipoService.formatSubscription(ipo.subscription);
            await editMessageText(sock, chatId, loading?.key, text);
        } catch (err) {
            await editMessageText(sock, chatId, loading?.key, `❌ ${err.message}`);
        }
    }

    async _handleAnalysis(sock, chatId, name, originalMsg) {
        const loading = await this._sendText(
            sock,
            chatId,
            `🔍 _Analyzing ${name} IPO…\n📊 GMP + Subscription + Financials + Peers + Score\n🤖 AI DeepSeek V4 Flash (~15–30s)_`,
            originalMsg
        );

        try {
            // Step 1: Fetch all data
            const ipo = await this.ipoService.getIpoByName(name);
            if (!ipo) {
                return editMessageText(sock, chatId, loading?.key, `❌ IPO "${name}" not found.\n\nTry: /ipo to see all IPOs`);
            }

            // Step 2: Compute IPO score
            const scoreData = this.ipoService.computeIpoScore(ipo);

            // Step 3: Save snapshot for future comparison
            await this._saveSnapshot(ipo, scoreData);

            // Step 4: Get day 1 snapshot for comparison
            const day1 = await this._getDay1Snapshot(ipo.name);

            // Step 5: Build the computed card (always works, no LLM needed)
            const dataCard = this.ipoService.formatIpoCard(ipo, scoreData, day1);

            // Step 6: Optionally enhance with LLM analysis
            try {
                const userPrompt = buildIpoUserPrompt(ipo);
                const analysis = await this._callLlm(IPO_ANALYSIS_SYSTEM_PROMPT, userPrompt);

                if (analysis && analysis.length > 100) {
                    // Combine computed card + AI insights
                    const aiInsights = this._extractInsights(analysis);
                    const fullMsg = aiInsights
                        ? `${dataCard}\n\n━━━━━━━━━━━━━━━━━\n\n🤖 *AI INSIGHTS:*\n\n${aiInsights}`
                        : dataCard;
                    await editMessageText(sock, chatId, loading?.key, fullMsg);
                } else {
                    await editMessageText(sock, chatId, loading?.key, dataCard);
                }
            } catch (llmErr) {
                // Card works without LLM — just show it
                await editMessageText(sock, chatId, loading?.key, dataCard);
            }
        } catch (err) {
            logger.error(`IPO analysis failed: ${err.message}`);
            await editMessageText(sock, chatId, loading?.key, `❌ Analysis failed: ${err.message}`);
        }
    }

    /** Extract only the insightful parts from LLM response (skip what card already shows). */
    _extractInsights(llmText) {
        if (!llmText) return '';
        // Extract verdict and key reasoning — skip sections already in the card
        const sections = llmText.split(/━+/).filter(Boolean);
        const insights = sections
            .filter((s) => /VERDICT|REASON|INSIGHT|STRATEGY/i.test(s))
            .map((s) => s.trim())
            .join('\n\n');
        return insights || '';
    }

    async _sendText(sock, chatId, text, originalMsg) {
        try {
            return await sock.sendMessage(chatId, { text });
        } catch (err) {
            logger.warn(`IPO send failed: ${err.message}`);
            return null;
        }
    }
}

export default IpoController;
