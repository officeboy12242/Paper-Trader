/**
 * Tech news scraper from Inshorts.
 * Fetches articles, filters ads/sponsored, deduplicates.
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import { logger } from '../utils/logger.js';

const INSHORTS_URL = 'https://inshorts.com/en/read/technology';

const SPAM_KEYWORDS = [
    'flipkart',
    'amazon sale',
    'best deals',
    'oneblade',
    'brand ambassador',
    'sponsored',
    'buy now',
    'discount',
    'offer',
    'coupon',
    'sale starting',
    'checkout now',
];

const DEFAULT_HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Cache-Control': 'no-cache, no-store',
    Pragma: 'no-cache',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
};

function isSpam(title, summary) {
    const combined = `${title} ${summary}`.toLowerCase();
    return SPAM_KEYWORDS.some((kw) => combined.includes(kw));
}

class InshortsScraper {
    constructor(newsDatabase, url = INSHORTS_URL) {
        this.newsDatabase = newsDatabase;
        this.url = url;
    }

    async fetchPageHtml() {
        const cacheBustUrl = `${this.url}?t=${Date.now()}`;
        const resp = await axios.get(cacheBustUrl, {
            headers: DEFAULT_HEADERS,
            timeout: 15000,
            maxRedirects: 5,
            validateStatus: (status) => status < 500,
        });
        if (resp.status !== 200) {
            logger.warn(`Inshorts returned HTTP ${resp.status}`);
            return null;
        }
        return resp.data;
    }

    parseArticles(html, { minArticles = 10, skipPosted = true } = {}) {
        const $ = cheerio.load(html);
        const cards = $('div[itemtype="http://schema.org/NewsArticle"]');
        if (!cards.length) {
            logger.warn('Inshorts: no NewsArticle cards found (page may have changed)');
            return [];
        }

        const articles = [];
        const seenTitles = new Set();

        cards.each((_, el) => {
            if (articles.length >= minArticles) {
                return false;
            }

            const card = $(el);
            const title = card.find('[itemprop="headline"]').first().text().trim();
            if (!title) {
                return;
            }

            const summary = card.find('[itemprop="articleBody"]').first().text().trim();
            if (isSpam(title, summary)) {
                return;
            }
            if (seenTitles.has(title.toLowerCase())) {
                return;
            }

            seenTitles.add(title.toLowerCase());
            articles.push({ title, summary });
        });

        return articles;
    }

    async scrapeInshorts(minArticles = 10, skipPosted = true) {
        try {
            const html = await this.fetchPageHtml();
            if (!html) {
                return [];
            }

            const raw = this.parseArticles(html, { minArticles, skipPosted: false });
            const articles = [];

            for (const article of raw) {
                if (skipPosted && (await this.newsDatabase.isNewsPostedGlobally(article.title))) {
                    continue;
                }
                articles.push(article);
                if (articles.length >= minArticles) {
                    break;
                }
            }

            return articles;
        } catch (error) {
            logger.error(`Inshorts fetch failed: ${error.message}`);
            return [];
        }
    }

    async scrapeAndQueue() {
        const articles = await this.scrapeInshorts(10, true);
        if (articles.length) {
            await this.newsDatabase.queueArticles(articles);
            logger.info(`Queued ${articles.length} new articles from Inshorts`);
        }
        return articles.length;
    }

    async getFreshArticlesForPosting(minArticles = 10) {
        const liveArticles = await this.scrapeInshorts(minArticles, true);
        const queued = await this.newsDatabase.getQueuedArticles();

        const seen = new Set();
        const combined = [];
        for (const article of [...liveArticles, ...queued]) {
            const hash = this.newsDatabase.hashTitle(article.title);
            if (!seen.has(hash)) {
                seen.add(hash);
                combined.push(article);
            }
        }

        return combined.slice(0, minArticles);
    }
}

export default InshortsScraper;
