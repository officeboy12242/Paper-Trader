/**
 * Fetch GitHub repos — trending, popular, hidden gems, and Saturday college/resume.
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import { logger } from '../utils/logger.js';
import {
    formatDayKey,
    isSaturdayInTimezone,
} from '../utils/newsScheduler.js';

const SEARCH_URL = 'https://api.github.com/search/repositories';

export const GITHUB_REPO_CATEGORIES = {
    trending: { label: '🔥 TRENDING', emoji: '🔥' },
    popular: { label: '⭐ POPULAR', emoji: '⭐' },
    underrated: { label: '💎 HIDDEN GEM', emoji: '💎' },
    college: { label: '🎓 COLLEGE / RESUME', emoji: '🎓' },
};

/** Slot order: mix categories across the day's 5 posts (non-Saturday). */
export const GITHUB_SLOT_CATEGORIES = ['trending', 'popular', 'underrated', 'trending', 'popular'];

/** Static mix when LLM is down — industry + classic college. */
export const COLLEGE_FALLBACK_TOPICS = [
    'RAG chatbot LangChain',
    'FastAPI Python full-stack',
    'Next.js TypeScript portfolio',
    'Flutter Firebase app',
    'MERN stack e-commerce',
    'Django hospital management',
    'Spring Boot library system',
    'IoT attendance dashboard',
    'Docker DevOps mini project',
    'final-year-project full-stack',
    'college-project portfolio',
    'React Native chat app',
];

export const COLLEGE_TOPIC_SYSTEM = `You pick GitHub search topics for student / early-career resume projects.

Return 8–12 short search phrases for TODAY (India tech hiring + college final-year).

Must mix BOTH buckets (roughly half each):

A) Industry / hiring (what companies want now), e.g.:
- agentic AI, RAG chatbot, LangChain, Next.js full-stack
- Python, FastAPI, TypeScript, Flutter, React Native
- DevOps basics, Docker, system design mini-projects
- data engineering, ML demo apps (not research papers)

B) College / academic (portfolio & viva-friendly), e.g.:
- college-project, final-year-project
- hospital management, library management, e-commerce
- attendance system, chat app, IoT dashboard
- MERN / Django / Spring Boot CRUD with auth

Rules:
- Prefer buildable apps a student can clone, run, and explain in an interview
- Avoid mega frameworks, crypto, NSFW, or abandoned toy scripts
- Mix languages: Python, JavaScript/TypeScript, Java, Dart/Flutter, etc.
- Phrases must work as GitHub search keywords (2–5 words each)
- No duplicates; no commentary

Reply JSON only:
{"topics":["...","..."],"why_now":"one short line on the mix for this week"}`;

const DEFAULT_HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
};

const API_HEADERS = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'whatsapp-course-bot',
};

function parseStarCount(text) {
    if (!text) return '';
    return text.replace(/\s+/g, ' ').trim();
}

function isoDaysAgo(days) {
    const d = new Date(Date.now() - days * 86400000);
    return d.toISOString().split('T')[0];
}

function mapApiItem(item, category, extra = {}) {
    return {
        owner: item.owner?.login || '',
        name: item.name || '',
        fullName: item.full_name || '',
        url: item.html_url || '',
        description: item.description || 'No description',
        language: item.language || '—',
        starsToday: '',
        totalStars: item.stargazers_count != null ? String(item.stargazers_count) : '',
        forks: item.forks_count != null ? String(item.forks_count) : '',
        category,
        ...extra,
    };
}

function parseRepoFromArticle($, article) {
    const link = $(article).find('h2 a').first();
    const href = link.attr('href') || '';
    const fullName = link.text().replace(/\s+/g, ' ').trim();
    if (!href || !fullName) return null;

    const parts = fullName.split('/').map((p) => p.trim()).filter(Boolean);
    const owner = parts[0] || '';
    const name = parts[1] || parts[0] || '';
    const description = $(article).find('p.col-9, p[class*="color-fg-muted"]').first().text().trim();
    const language = $(article).find('[itemprop="programmingLanguage"]').first().text().trim();

    let starsToday = '';
    $(article).find('span.d-inline-block').each((_, el) => {
        const text = $(el).text().replace(/\s+/g, ' ').trim();
        if (/stars?\s+today/i.test(text)) {
            starsToday = parseStarCount(text);
        }
    });

    const totalStars = parseStarCount(
        $(article).find(`a[href="${href}/stargazers"]`).first().text(),
    );
    const forks = parseStarCount(
        $(article).find(`a[href="${href}/forks"]`).first().text(),
    );

    return {
        owner,
        name,
        fullName: `${owner}/${name}`,
        url: `https://github.com${href}`,
        description: description || 'No description',
        language: language || '—',
        starsToday: starsToday || '',
        totalStars: totalStars || '',
        forks: forks || '',
        category: 'trending',
    };
}

export function dedupeRepos(repos) {
    const seen = new Set();
    return (repos || []).filter((repo) => {
        const key = repo.fullName?.trim().toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/** Turn a search phrase into "Why now" tags for the WA card. */
export function topicToWhyNow(topic) {
    const parts = String(topic || '')
        .split(/[\s,/·|]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 1)
        .slice(0, 4);
    if (!parts.length) return '';
    return parts
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' · ');
}

export function parseCollegeTopicsJson(raw) {
    const text = String(raw || '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) {
        throw new Error('No JSON object in LLM reply');
    }
    const parsed = JSON.parse(text.slice(start, end + 1));
    const topics = (parsed.topics || [])
        .map((t) => String(t || '').trim())
        .filter((t) => t.length >= 3 && t.length <= 80);
    const uniq = [...new Set(topics)];
    if (uniq.length < 4) {
        throw new Error(`Need ≥4 topics, got ${uniq.length}`);
    }
    return {
        topics: uniq.slice(0, 12),
        whyNow: String(parsed.why_now || '').trim().slice(0, 160),
    };
}

class GitHubTrendingService {
    /**
     * @param {number} count
     * @param {{ timezone?: string, llm?: import('./AssistLlmRouter.js').default | null, collegeSaturday?: boolean }} [opts]
     */
    constructor(count = 5, opts = {}) {
        this.count = count;
        this.timezone = opts.timezone || 'Asia/Kolkata';
        this.collegeSaturday = opts.collegeSaturday !== false;
        this.llm = opts.llm || null;
        /** @type {{ dayKey: string, topics: string[], blurb: string } | null} */
        this._collegeTopicsCache = null;
    }

    async fetchFromTrendingPage(limit = 15, since = 'daily', category = 'trending') {
        const url = `https://github.com/trending?since=${since}`;
        const resp = await axios.get(url, {
            headers: DEFAULT_HEADERS,
            timeout: 20000,
            validateStatus: (status) => status < 500,
        });

        if (resp.status !== 200 || !resp.data) {
            logger.warn(`GitHub trending page returned HTTP ${resp.status}`);
            return [];
        }

        const $ = cheerio.load(resp.data);
        const repos = [];

        $('article.Box-row').each((_, article) => {
            if (repos.length >= limit) return false;
            const repo = parseRepoFromArticle($, article);
            if (repo?.fullName) {
                repo.category = category;
                repos.push(repo);
            }
        });

        return repos;
    }

    async searchRepos(query, { sort = 'stars', order = 'desc', limit = 15, category = 'popular', extra = {} } = {}) {
        const resp = await axios.get(SEARCH_URL, {
            params: {
                q: query,
                sort,
                order,
                per_page: Math.min(limit, 30),
            },
            headers: API_HEADERS,
            timeout: 15000,
        });

        return (resp.data?.items || []).slice(0, limit).map((item) => mapApiItem(item, category, extra));
    }

    /** Hot repos this week (GitHub weekly trending) */
    async fetchPopular(limit = 15) {
        const weekly = await this.fetchFromTrendingPage(limit, 'weekly', 'popular');
        if (weekly.length >= 3) {
            return weekly;
        }

        const since = isoDaysAgo(14);
        return this.searchRepos(
            `stars:>2500 pushed:>${since} fork:false archived:false`,
            { sort: 'stars', order: 'desc', limit, category: 'popular' },
        );
    }

    /** Active repos with modest stars — underrated / hidden gems */
    async fetchUnderrated(limit = 15) {
        const since = isoDaysAgo(30);
        return this.searchRepos(
            `stars:80..2500 forks:>5 pushed:>${since} fork:false archived:false`,
            { sort: 'updated', order: 'desc', limit, category: 'underrated' },
        );
    }

    /**
     * LLM (or fallback) topic list for Saturday college/resume posts.
     * Cached once per calendar day in timezone.
     */
    async resolveCollegeTopics(now = new Date()) {
        const dayKey = formatDayKey(now, this.timezone);
        if (this._collegeTopicsCache?.dayKey === dayKey && this._collegeTopicsCache.topics?.length) {
            return this._collegeTopicsCache;
        }

        let topics = COLLEGE_FALLBACK_TOPICS;
        let blurb = 'Industry + college project mix (fallback topics).';

        if (this.llm?.isConfigured?.()) {
            try {
                const { text, provider, model } = await this.llm.completeChat({
                    systemPrompt: COLLEGE_TOPIC_SYSTEM,
                    history: [],
                    userBlock: `Today is ${dayKey} (${this.timezone}). Pick this week's topics as JSON.`,
                    maxTokens: 500,
                    temperature: 0.7,
                    maxChars: 2000,
                });
                const parsed = parseCollegeTopicsJson(text);
                topics = parsed.topics;
                blurb = parsed.whyNow || blurb;
                logger.info(
                    `🎓 College topics via ${provider}/${model}: ${topics.length} — ${blurb}`,
                );
            } catch (err) {
                logger.warn(`🎓 College topic LLM failed, using fallback: ${err.message}`);
            }
        } else {
            logger.info('🎓 College topics: no LLM configured, using fallback list');
        }

        this._collegeTopicsCache = { dayKey, topics, blurb };
        return this._collegeTopicsCache;
    }

    /**
     * Search GitHub for resume/college-friendly repos using LLM (or fallback) topics.
     * @param {number} limit
     * @param {{ slotIndex?: number, now?: Date }} [opts]
     */
    async fetchCollege(limit = 15, opts = {}) {
        const slotIndex = Number.isFinite(opts.slotIndex) ? opts.slotIndex : 0;
        const now = opts.now || new Date();
        const { topics } = await this.resolveCollegeTopics(now);
        const since = isoDaysAgo(365);
        const order = topics.map((_, i) => topics[(slotIndex + i) % topics.length]);

        const found = [];
        for (const topic of order) {
            if (found.length >= limit) break;
            try {
                const q = `${topic} stars:40..12000 fork:false archived:false pushed:>${since}`;
                const batch = await this.searchRepos(q, {
                    sort: 'stars',
                    order: 'desc',
                    limit: 8,
                    category: 'college',
                    extra: { whyNow: topicToWhyNow(topic), topic },
                });
                for (const repo of batch) {
                    found.push(repo);
                    if (found.length >= limit) break;
                }
            } catch (err) {
                logger.warn(`🎓 College search "${topic}" failed: ${err.message}`);
            }
        }

        return dedupeRepos(found).slice(0, limit);
    }

    async fetchCategory(category, limit = 15, opts = {}) {
        switch (category) {
            case 'popular':
                return dedupeRepos(await this.fetchPopular(limit));
            case 'underrated':
                return dedupeRepos(await this.fetchUnderrated(limit));
            case 'college':
                return dedupeRepos(await this.fetchCollege(limit, opts));
            case 'trending':
            default:
                return dedupeRepos(await this.fetchFromTrendingPage(limit, 'daily', 'trending'));
        }
    }

    isCollegeSaturday(now = new Date()) {
        return this.collegeSaturday && isSaturdayInTimezone(now, this.timezone);
    }

    /** Fresh mixed pool for manual /github preview (one per category, then extras) */
    async fetchMixedPool() {
        const perCategory = Math.max(3, Math.ceil(this.count / 3) + 2);
        const [trending, popular, underrated] = await Promise.allSettled([
            this.fetchCategory('trending', perCategory),
            this.fetchCategory('popular', perCategory),
            this.fetchCategory('underrated', perCategory),
        ]);

        const pick = (result) => (result.status === 'fulfilled' ? result.value : []);
        const merged = dedupeRepos([
            ...pick(trending),
            ...pick(popular),
            ...pick(underrated),
        ]);

        if (merged.length) {
            logger.info(
                `GitHub pool: ${pick(trending).length} trending, ${pick(popular).length} popular, `
                + `${pick(underrated).length} hidden gem(s)`,
            );
        }

        return merged.slice(0, this.count * 2);
    }

    /** Fresh fetch for one scheduled slot — Saturday = college only; else category mix. */
    async fetchForSlot(slotIndex, now = new Date()) {
        if (this.isCollegeSaturday(now)) {
            try {
                const repos = await this.fetchCategory('college', 20, { slotIndex, now });
                if (repos.length) {
                    logger.info(`GitHub slot ${slotIndex + 1}: ${repos.length} college/resume repo(s) (Saturday)`);
                    return repos;
                }
            } catch (err) {
                logger.warn(`GitHub college fetch failed: ${err.message}`);
            }
            return [];
        }

        const primary = GITHUB_SLOT_CATEGORIES[slotIndex] || 'trending';
        const fallbacks = ['trending', 'popular', 'underrated'].filter(
            (c, i, arr) => c !== primary && arr.indexOf(c) === i,
        );
        const order = [primary, ...fallbacks];

        for (const category of order) {
            try {
                const repos = await this.fetchCategory(category, 20);
                if (repos.length) {
                    logger.info(`GitHub slot ${slotIndex + 1}: ${repos.length} ${category} repo(s)`);
                    return repos;
                }
            } catch (err) {
                logger.warn(`GitHub ${category} fetch failed: ${err.message}`);
            }
        }

        return [];
    }

    /** @deprecated use fetchMixedPool */
    async fetchTrending() {
        return this.fetchMixedPool();
    }
}

export default GitHubTrendingService;
