/**
 * Fetch AI updates — tools/apps, India-specific AI news, and model releases —
 * from real RSS feeds (verified live before hardcoding):
 *
 *   tools  → TechCrunch's AI category feed (already AI-only, no filtering needed)
 *   india  → YourStory + Inc42 general feeds, keyword-filtered for AI content
 *   model  → OpenAI, Google AI, and Google DeepMind official blogs
 *
 * No new dependency: cheerio (already used for GitHub trending's HTML scrape)
 * parses RSS/Atom XML just as well in xmlMode.
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import { logger } from '../utils/logger.js';
import { parseLooseJson, tidySentence } from '../utils/summaryText.js';

const FEEDS = {
    tools: [
        { name: 'TechCrunch AI', url: 'https://techcrunch.com/category/artificial-intelligence/feed/', filterKeywords: false },
    ],
    india: [
        { name: 'YourStory', url: 'https://yourstory.com/feed', filterKeywords: true },
        { name: 'Inc42', url: 'https://inc42.com/feed', filterKeywords: true },
    ],
    model: [
        { name: 'OpenAI', url: 'https://openai.com/blog/rss.xml', filterKeywords: false },
        { name: 'Google AI', url: 'https://blog.google/innovation-and-ai/technology/ai/rss/', filterKeywords: false },
        { name: 'Google DeepMind', url: 'https://deepmind.google/blog/rss.xml', filterKeywords: false },
    ],
};

/** Slot order across the day's 5 posts. */
export const AI_UPDATES_SLOT_CATEGORIES = ['tools', 'india', 'model', 'tools', 'india'];

/**
 * Feeds used only to ground the card's "project idea" field in something real
 * — buildable tools, launches, and dev write-ups — instead of the LLM
 * inventing an idea from a bare headline. Never posted as the main item, and
 * doesn't add a 4th slot category; tools/india/model stay exactly as they are.
 */
const PROJECT_RESOURCE_FEEDS = [
    { name: 'Hugging Face Blog', url: 'https://huggingface.co/blog/feed.xml', filterKeywords: false },
    { name: 'DEV Community (AI)', url: 'https://dev.to/feed/tag/ai', filterKeywords: false },
    { name: 'Product Hunt (AI)', url: 'https://www.producthunt.com/feed?category=artificial-intelligence', filterKeywords: false },
];

/** Refetched at most once an hour — these are grounding context, not the headline. */
const PROJECT_RESOURCE_CACHE_MS = 60 * 60 * 1000;

/** Words too generic to count as topical overlap when picking references. */
const STOPWORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'for', 'with', 'to', 'of', 'in', 'on', 'is', 'are',
    'new', 'how', 'why', 'what', 'this', 'that', 'its', 'your', 'you', 'ai', 'now',
]);

function significantWords(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

const AI_KEYWORDS = [
    'artificial intelligence', ' ai ', 'a.i.', 'genai', 'gen ai', 'llm', 'large language model',
    'machine learning', 'chatgpt', 'openai', 'anthropic', 'claude', 'gemini', 'copilot',
    'deepmind', 'neural network', 'generative ai', 'agentic', 'chatbot',
];

const HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'application/rss+xml, application/xml, text/xml, */*',
};

function looksAiRelated(text) {
    const t = ` ${String(text || '').toLowerCase()} `;
    return AI_KEYWORDS.some((kw) => t.includes(kw));
}

function stripHtml(html) {
    return String(html || '')
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&#8217;|&rsquo;/g, "'")
        .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"')
        .replace(/\s+/g, ' ')
        .trim();
}

function completeSummary(text, max = 500) {
    return tidySentence(text, max);
}

/**
 * @param {{ name: string, url: string, filterKeywords: boolean }} feed
 * @param {string} category
 * @returns {Promise<Array<{ title: string, summary: string, url: string, source: string, category: string, publishedAt: Date }>>}
 */
async function fetchFeed(feed, category) {
    try {
        const resp = await axios.get(feed.url, {
            headers: HEADERS,
            timeout: 15000,
            validateStatus: (status) => status < 500,
        });
        if (resp.status !== 200 || !resp.data) {
            logger.warn(`AI updates: ${feed.name} returned HTTP ${resp.status}`);
            return [];
        }

        const $ = cheerio.load(resp.data, { xmlMode: true });
        const items = [];

        $('item, entry').each((_, el) => {
            const $el = $(el);
            const title = stripHtml($el.find('title').first().text());
            const link =
                $el.find('link').first().text().trim() ||
                $el.find('link').first().attr('href') ||
                '';
            const rawSummary =
                $el.find('description').first().text() ||
                $el.find('content\\:encoded').first().text() ||
                $el.find('summary').first().text() ||
                '';
            // Keep enough article context for the LLM. The old raw 220-char
            // slice routinely ended mid-sentence and made cards look broken.
            const summary = completeSummary(stripHtml(rawSummary), 4000);
            const pubDateRaw =
                $el.find('pubDate').first().text() || $el.find('published').first().text() || '';
            const publishedAt = pubDateRaw ? new Date(pubDateRaw) : new Date();

            if (!title || !link) return;
            if (feed.filterKeywords && !looksAiRelated(`${title} ${summary}`)) return;

            items.push({
                title,
                summary,
                url: link.trim(),
                source: feed.name,
                category,
                publishedAt: Number.isNaN(publishedAt.getTime()) ? new Date() : publishedAt,
            });
        });

        return items;
    } catch (err) {
        logger.warn(`AI updates: ${feed.name} fetch failed: ${err.message}`);
        return [];
    }
}

export function dedupeAiUpdates(items) {
    const seen = new Set();
    return (items || []).filter((item) => {
        const key = item.url?.trim().toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

class AiUpdatesService {
    /**
     * @param {{
     *   llm?: import('./AssistLlmRouter.js').default | null,
     *   orca?: import('./OrcaRouterTradeService.js').default | null
     * }} [opts]
     */
    constructor(opts = {}) {
        this.llm = opts.llm || null;
        this.orca = opts.orca || null;
        this.cardCache = new Map();
        /** @type {{ at: number, items: Array<object> } | null} */
        this._projectResourceCache = null;
    }

    /**
     * @param {'tools'|'india'|'model'} category
     * @param {number} [limit]
     */
    async fetchCategory(category, limit = 15) {
        const feeds = FEEDS[category] || [];
        const results = await Promise.allSettled(feeds.map((feed) => fetchFeed(feed, category)));
        const merged = dedupeAiUpdates(results.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])));
        merged.sort((a, b) => b.publishedAt - a.publishedAt);
        return merged.slice(0, limit);
    }

    /** Fresh fetch for one scheduled slot — falls back to the other categories if empty. */
    async fetchForSlot(slotIndex) {
        const primary = AI_UPDATES_SLOT_CATEGORIES[slotIndex] || 'tools';
        const fallbacks = ['tools', 'india', 'model'].filter((c) => c !== primary);
        const order = [primary, ...fallbacks];

        for (const category of order) {
            try {
                const items = await this.fetchCategory(category, 20);
                if (items.length) {
                    logger.info(`AI updates slot ${slotIndex + 1}: ${items.length} ${category} item(s)`);
                    return items;
                }
            } catch (err) {
                logger.warn(`AI updates ${category} fetch failed: ${err.message}`);
            }
        }
        return [];
    }

    /** Fresh mixed pool — one fetch per category, merged (used for manual preview). */
    async fetchMixedPool(perCategory = 6) {
        const [tools, india, model] = await Promise.allSettled([
            this.fetchCategory('tools', perCategory),
            this.fetchCategory('india', perCategory),
            this.fetchCategory('model', perCategory),
        ]);
        const pick = (r) => (r.status === 'fulfilled' ? r.value : []);
        return dedupeAiUpdates([...pick(tools), ...pick(india), ...pick(model)]);
    }

    _normalizeCardData(value, item) {
        const whatHappened = tidySentence(
            value?.what_happened || value?.whatHappened || value?.summary || item.summary,
            420
        );
        const industryImpact = tidySentence(
            value?.industry_impact || value?.industryImpact ||
                'The update shows where AI products, investment, and technical priorities are moving.',
            280
        );
        const rawAngles = value?.student_career_angle || value?.studentCareerAngle;
        const studentCareerAngle = (Array.isArray(rawAngles) ? rawAngles : [rawAngles])
            .map((line) => tidySentence(line, 140))
            .filter(Boolean)
            .slice(0, 4);
        if (!studentCareerAngle.length) {
            studentCareerAngle.push('Use the update to identify skills and project ideas worth exploring.');
        }
        const projectIdea = tidySentence(
            value?.project_idea || value?.projectIdea ||
                'Build a small proof of concept inspired by the update and document its trade-offs.',
            500
        );
        return { whatHappened, industryImpact, studentCareerAngle, projectIdea };
    }

    /**
     * Fetch + merge the project-resource feeds, cached for an hour.
     * Caps each feed's contribution BEFORE merging — Dev.to's community AI tag
     * posts far more often than Hugging Face's official blog or Product Hunt's
     * curated launches, so sorting the merged pool by freshness alone let its
     * volume (including a fair amount of low-signal filler) crowd out the
     * higher-signal feeds entirely. A fixed per-feed slice keeps all three
     * represented regardless of posting frequency.
     */
    async _fetchProjectResourcePool(perFeedLimit = 6) {
        const now = Date.now();
        if (this._projectResourceCache && now - this._projectResourceCache.at < PROJECT_RESOURCE_CACHE_MS) {
            return this._projectResourceCache.items;
        }

        const results = await Promise.allSettled(
            PROJECT_RESOURCE_FEEDS.map((feed) => fetchFeed(feed, 'project-resource'))
        );
        const perFeed = results.map((r) => {
            const feedItems = r.status === 'fulfilled' ? r.value : [];
            feedItems.sort((a, b) => b.publishedAt - a.publishedAt);
            return feedItems.slice(0, perFeedLimit);
        });
        const items = dedupeAiUpdates(perFeed.flat());

        // Only cache a real result — an all-down fetch shouldn't lock in "no
        // references" for the next hour once the feeds recover.
        if (items.length) {
            this._projectResourceCache = { at: now, items };
        }
        return items;
    }

    /**
     * A few fresh, real references (tools launched, models shipped, dev
     * write-ups) to ground the project-idea suggestion instead of the LLM
     * inventing one from a bare headline. Ranked by topical overlap with the
     * news item, falling back to just-freshest when nothing overlaps.
     *
     * Scores against each candidate's TITLE only, not its RSS summary — a
     * community tag feed's summaries are often generic filler ("developers",
     * "building", "apps") that matched almost anything and buried precise,
     * genuinely on-topic titles (e.g. a model-release headline losing to
     * unrelated posts that merely shared those common words).
     */
    async _pickProjectResources(item, n = 3) {
        let pool;
        try {
            pool = await this._fetchProjectResourcePool();
        } catch (err) {
            logger.warn(`AI updates: project resource pool fetch failed: ${err.message}`);
            return [];
        }
        if (!pool.length) return [];

        const itemWords = new Set(significantWords(`${item.title} ${item.summary}`));
        const scored = pool.map((res) => {
            const resWords = significantWords(res.title);
            const overlap = resWords.filter((w) => itemWords.has(w)).length;
            return { res, overlap };
        });
        scored.sort((a, b) => b.overlap - a.overlap || b.res.publishedAt - a.res.publishedAt);
        return scored.slice(0, n).map((s) => s.res);
    }

    async _generateCardData(item) {
        const references = await this._pickProjectResources(item, 3);
        const referencesBlock = references.length
            ? '\n\nReal, currently-live references for the project idea only (tools, models, and dev ' +
              'write-ups — NOT facts about the headline, do not use these for what_happened or ' +
              'industry_impact):\n' +
              references
                  .map((r, i) => `${i + 1}. [${r.source}] ${r.title} — ${r.summary.slice(0, 160)}`)
                  .join('\n')
            : '';

        const systemPrompt =
            'Turn one AI news item into a concise WhatsApp update for a mixed audience of students, ' +
            'developers, working professionals, and corporate members. ' +
            'Use only facts present in the supplied headline and RSS description for what_happened and ' +
            'industry_impact; never invent details there. ' +
            'For project_idea: when reference material is supplied, ground the idea in it — name the ' +
            'kind of tool, model, or approach a reference points to and how it applies to the headline\'s ' +
            'topic, rather than a generic suggestion. Must stay feasible for a student or small team to ' +
            'actually build. ' +
            'Keep every sentence complete, concrete, and hype-free. Return JSON only with: ' +
            '{"what_happened":"2 complete sentences, 35-65 words",' +
            '"industry_impact":"1-2 complete sentences",' +
            '"student_career_angle":["2-4 short skill, career, or learning takeaways"],' +
            '"project_idea":"one specific buildable project idea"}.';
        const userPrompt =
            `Headline: ${item.title}\nSource: ${item.source}\nCategory: ${item.category}\n` +
            `RSS description: ${item.summary}${referencesBlock}`;

        if (this.orca?.isConfigured?.()) {
            try {
                const text = await this.orca.completeTrade(systemPrompt, userPrompt, {
                    maxTokens: 500,
                    temperature: 0.25,
                    timeoutMs: 45_000,
                });
                const parsed = parseLooseJson(text);
                if (parsed?.value?.what_happened || parsed?.value?.summary) {
                    logger.info(`AI updates summary via OrcaRouter ${this.orca.tradeModel}`);
                    return this._normalizeCardData(parsed.value, item);
                }
                throw new Error('invalid summary JSON');
            } catch (err) {
                logger.warn(`AI updates: OrcaRouter summary failed: ${err.message}`);
            }
        }

        if (this.llm?.isConfigured?.()) {
            try {
                const { text, provider, model } = await this.llm.completeChat({
                    systemPrompt,
                    history: [],
                    userBlock: userPrompt,
                    maxTokens: 700,
                    temperature: 0.25,
                    maxChars: 2600,
                });
                const parsed = parseLooseJson(text);
                if (parsed?.value?.what_happened || parsed?.value?.summary) {
                    logger.info(`AI updates summary via ${provider}/${model}`);
                    return this._normalizeCardData(parsed.value, item);
                }
                throw new Error('invalid summary JSON');
            } catch (err) {
                logger.warn(`AI updates: fallback summary LLM failed: ${err.message}`);
            }
        }

        return this._normalizeCardData({}, item);
    }

    /**
     * Complete card prose, cached by source URL so fan-out to many groups costs
     * one LLM call rather than one call per group.
     */
    async generateCardData(item) {
        const key = item.url || item.title;
        if (!this.cardCache.has(key)) {
            this.cardCache.set(key, this._generateCardData(item));
        }
        try {
            return await this.cardCache.get(key);
        } catch (err) {
            this.cardCache.delete(key);
            throw err;
        }
    }
}

export default AiUpdatesService;
