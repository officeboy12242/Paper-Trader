/**
 * Live stock news via Google News RSS (no API key).
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import { logger } from '../utils/logger.js';

const UA = 'Mozilla/5.0 (compatible; SassyBot/1.0; +https://github.com)';
const TIMEOUT_MS = 14_000;
const RSS_BASE = 'https://news.google.com/rss/search';

function dedupeHeadlines(items) {
    const seen = new Set();
    const out = [];
    for (const item of items) {
        const key = item.title.toLowerCase().replace(/\s+/g, ' ').slice(0, 80);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
    }
    return out;
}

function parseRss(xml) {
    const $ = cheerio.load(xml, { xmlMode: true });
    return $('item')
        .map((_, el) => {
            const title = $(el).find('title').text().trim();
            const pubDate = $(el).find('pubDate').text().trim();
            const source = $(el).find('source').text().trim();
            if (!title) return null;
            return { title, pubDate, source };
        })
        .get()
        .filter(Boolean);
}

async function fetchRss(query) {
    const { data } = await axios.get(RSS_BASE, {
        params: { q: query, hl: 'en-IN', gl: 'IN', ceid: 'IN:en' },
        headers: { 'User-Agent': UA },
        timeout: TIMEOUT_MS,
    });
    return parseRss(data);
}

class StockNewsService {
    /**
     * @param {string} symbol e.g. TCS
     * @param {string} [displayName]
     * @returns {Promise<{ headlines: Array<{title:string,pubDate:string,source:string}>, context: string }>}
     */
    async fetchForSymbol(symbol, displayName = '') {
        const sym = String(symbol || '').trim().toUpperCase();
        const name = displayName || sym;
        const queries = [
            `${name} NSE stock India`,
            `${sym} earnings results quarterly India`,
            `${sym} F&O options India`,
        ];

        const batches = await Promise.all(
            queries.map((q) => fetchRss(q).catch((err) => {
                logger.debug(`News RSS failed (${q}): ${err.message}`);
                return [];
            }))
        );

        const headlines = dedupeHeadlines(batches.flat()).slice(0, 8);
        const context = this.formatContext(headlines);
        return { headlines, context };
    }

    /** @returns {Promise<{ headlines: object[], context: string }>} */
    async fetchMarketHeadlines() {
        const queries = [
            'Nifty Bank Nifty Indian stock market today',
            'India stock market F&O movers results',
            'SEBI RBI India markets',
        ];

        const batches = await Promise.all(
            queries.map((q) => fetchRss(q).catch(() => []))
        );
        const headlines = dedupeHeadlines(batches.flat()).slice(0, 10);
        return { headlines, context: this.formatContext(headlines) };
    }

    /**
     * Options / F&O focused headlines for CE and PE context.
     * @param {string} symbol
     * @param {string} [displayName]
     */
    async fetchOptionsNews(symbol, displayName = '') {
        const sym = String(symbol || '').trim().toUpperCase();
        const name = displayName || sym;
        const queries = [
            `${sym} put call ratio open interest NSE`,
            `${name} options trading F&O India`,
            `${sym} call put options premium NSE`,
        ];

        const batches = await Promise.all(
            queries.map((q) => fetchRss(q).catch((err) => {
                logger.debug(`Options news RSS failed (${q}): ${err.message}`);
                return [];
            }))
        );

        const headlines = dedupeHeadlines(batches.flat()).slice(0, 6);
        return { headlines, context: this.formatContext(headlines) };
    }

    formatContext(headlines) {
        if (!headlines.length) {
            return 'No recent headlines fetched from live news feeds.';
        }
        return headlines
            .map((h, i) => {
                const src = h.source ? ` (${h.source})` : '';
                const when = h.pubDate ? ` — ${h.pubDate}` : '';
                return `${i + 1}. ${h.title}${src}${when}`;
            })
            .join('\n');
    }
}

export const stockNewsService = new StockNewsService();
export default StockNewsService;
