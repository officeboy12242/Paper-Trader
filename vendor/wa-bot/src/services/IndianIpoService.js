/**
 * Indian IPO Data Service
 * Scrapes current/upcoming IPO data from ipowatch.in (WordPress REST API + page scraping).
 * Provides: GMP, subscription status, lot size, price band, dates, financials, peers.
 * Computes: investment required, expected listing, profit/lot, IPO score.
 */

import { logger } from '../utils/logger.js';

const IPO_WATCH_BASE = 'https://ipowatch.in';
const WP_API = `${IPO_WATCH_BASE}/wp-json/wp/v2/posts`;
const DEFAULT_HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'text/html,application/json',
};

function cleanHtml(str) {
    return String(str || '')
        .replace(/<[^>]+>/g, '')
        .replace(/&#8377;/g, '₹')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&#8211;/g, '–')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Extract key-value pairs from alternating <td>key</td><td>value</td> tables. */
function extractTableData(html) {
    const cells = [...html.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)];
    const vals = cells.map((c) => cleanHtml(c[1])).filter(Boolean);
    const pairs = {};
    for (let i = 0; i < vals.length - 1; i += 2) {
        const key = vals[i].replace(/[:\s]+$/, '').trim();
        const value = vals[i + 1].trim();
        if (key && value) pairs[key] = value;
    }
    return pairs;
}

/** Parse subscription table into { categories, days, data: { cat: [day1x, day2x, ...] } } */
function extractSubscriptionData(html) {
    const cells = [...html.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)];
    const vals = cells.map((c) => cleanHtml(c[1])).filter(Boolean);
    if (!vals.length) return null;

    const CATEGORIES = ['QIB', 'NII', 'bNII', 'sNII', 'RII', 'EMP', 'Total'];
    const result = { categories: [], days: 0, data: {} };

    // Find first category cell to start parsing
    let i = vals.findIndex((v) => CATEGORIES.includes(v));
    if (i < 0) return null;

    while (i < vals.length) {
        const val = vals[i];
        if (CATEGORIES.includes(val)) {
            result.categories.push(val);
            result.data[val] = [];
            i++;
            // Collect numeric day values until next category
            while (i < vals.length && !CATEGORIES.includes(vals[i])) {
                const num = parseFloat(vals[i]);
                result.data[val].push(isNaN(num) ? vals[i] : num);
                i++;
            }
        } else {
            i++;
        }
    }

    // Compute max days from any category
    for (const cat of result.categories) {
        result.days = Math.max(result.days, (result.data[cat] || []).length);
    }
    return result;
}

/** Extract GMP history from GMP table — array of { date, gmp, trend, gain } */
function extractGmpHistory(html) {
    const cells = [...html.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)];
    const vals = cells.map((c) => cleanHtml(c[1])).filter(Boolean);
    if (!vals.length) return [];

    const dayPattern = /^\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)$/i;
    const gmpEntries = [];

    for (let i = 0; i < vals.length; i++) {
        if (dayPattern.test(vals[i])) {
            gmpEntries.push({
                date: vals[i],
                gmp: vals[i + 1] || '',
                trend: vals[i + 2] || '',
                gain: vals[i + 3] || '',
            });
            i += 4; // skip date, gmp, trend, gain, last_updated
        }
    }
    return gmpEntries;
}

/** Parse the peers/comparison table — first row is headers, rest are data rows. */
function extractPeersTable(html) {
    const tables = [...html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)];
    for (const t of tables) {
        const cells = [...t[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)];
        const vals = cells.map((c) => cleanHtml(c[1])).filter(Boolean);

        // Look for a table that has "P/E" or "RONW" in it — that's the peers table
        const hasPe = vals.some((v) => /P\/E|RONW|EPS/i.test(v));
        if (!hasPe || vals.length < 12) continue;

        // Find the header row — starts with "Name of the Company" or "Company"
        const headerIdx = vals.findIndex((v) => /name|company/i.test(v));
        if (headerIdx < 0) continue;

        const numCols = 6; // Company, Face Value, EPS, Diluted EPS, RONW, P/E
        const headers = vals.slice(headerIdx, headerIdx + numCols);
        const rows = [];
        for (let r = headerIdx + numCols; r + numCols <= vals.length; r += numCols) {
            const row = vals.slice(r, r + numCols);
            // Skip if this looks like a header row repeated
            if (/name|company|listed peers/i.test(row[0])) continue;
            rows.push(row);
        }
        if (rows.length > 0) return { headers, rows };
    }
    return null;
}

/** Parse the financials table — Revenue, Expense, PAT rows. */
function extractFinancialsTable(html) {
    const tables = [...html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)];
    for (const t of tables) {
        const cells = [...t[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)];
        const vals = cells.map((c) => cleanHtml(c[1])).filter(Boolean);

        // Look for a table that has "Revenue" or "PAT" in it
        const hasFin = vals.some((v) => /revenue|pat|expense/i.test(v));
        if (!hasFin || vals.length < 10) continue;

        // Find header row
        const headerIdx = vals.findIndex((v) => /period|revenue|year/i.test(v));
        if (headerIdx < 0) continue;

        const numCols = 5; // Period, Revenue, Expense, PAT, Assets
        const headers = vals.slice(headerIdx, headerIdx + numCols);
        const rows = [];
        for (let r = headerIdx + numCols; r + numCols <= vals.length; r += numCols) {
            const row = vals.slice(r, r + numCols);
            if (/period|revenue/i.test(row[0])) continue;
            rows.push(row);
        }
        if (rows.length > 0) return { headers, rows };
    }
    return null;
}

/** Parse a number from strings like "₹57 to ₹60", "₹2,600 Crores", "10" */
function parsePrice(str) {
    if (!str) return null;
    const cleaned = String(str).replace(/[₹,\s]/g, '');
    const nums = cleaned.match(/\d+\.?\d*/g);
    if (!nums || !nums.length) return null;
    return parseFloat(nums[nums.length - 1]); // last number (upper band or value)
}

function parsePriceRange(str) {
    if (!str) return null;
    const cleaned = String(str).replace(/[₹,\s]/g, '');
    const nums = cleaned.match(/\d+\.?\d*/g);
    if (!nums || nums.length < 2) return parsePrice(str);
    return { low: parseFloat(nums[0]), high: parseFloat(nums[1]) };
}

function parseLotSize(details) {
    // Try to find lot size from issue details — often not explicitly in ipowatch
    // We'll infer from price band: lot_size = investment / price
    // For now return null — controller will compute from price band
    return null;
}

class IndianIpoService {
    constructor() {
        this._cache = new Map();
        this._cacheTtlMs = 30 * 60 * 1000; // 30 min
    }

    async _fetchWpPosts(perPage = 15, search = '') {
        const cacheKey = `wp:${search}:${perPage}`;
        const cached = this._cache.get(cacheKey);
        if (cached && Date.now() - cached.ts < this._cacheTtlMs) return cached.data;

        const url = new URL(WP_API);
        url.searchParams.set('per_page', String(perPage));
        url.searchParams.set('_fields', 'title,link,content');
        if (search) url.searchParams.set('search', search);

        try {
            const resp = await fetch(url.toString(), { headers: DEFAULT_HEADERS });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            const posts = data.map((p) => ({
                title: cleanHtml(p.title?.rendered || ''),
                link: p.link || '',
                contentHtml: p.content?.rendered || '',
            }));
            this._cache.set(cacheKey, { data: posts, ts: Date.now() });
            return posts;
        } catch (err) {
            logger.warn(`IPO WP API failed: ${err.message}`);
            return [];
        }
    }

    async _scrapeIpoPage(url) {
        const cacheKey = `page:${url}`;
        const cached = this._cache.get(cacheKey);
        if (cached && Date.now() - cached.ts < this._cacheTtlMs) return cached.data;

        try {
            const resp = await fetch(url, { headers: DEFAULT_HEADERS });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const html = await resp.text();

            const result = {
                gmpHistory: [],
                details: {},
                financials: null,
                peers: null,
                dates: {},
            };

            // Extract all tables
            const gmpHistory = extractGmpHistory(html);
            if (gmpHistory.length) result.gmpHistory = gmpHistory;

            // Key-value tables (details, dates)
            const tables = [...html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)];
            for (const t of tables) {
                const data = extractTableData(t[0]);
                if (data['IPO Price Band'] || data['IPO Open Date']) {
                    Object.assign(result.details, data);
                }
                if (data['Basis of Allotment'] || data['IPO Listing Date']) {
                    Object.assign(result.dates, data);
                }
            }

            // Structured tables (peers, financials)
            result.peers = extractPeersTable(html);
            result.financials = extractFinancialsTable(html);

            this._cache.set(cacheKey, { data: result, ts: Date.now() });
            return result;
        } catch (err) {
            logger.warn(`IPO page scrape failed for ${url}: ${err.message}`);
            return { gmpHistory: [], details: {}, financials: null, peers: null, dates: {} };
        }
    }

    async getLiveGmpList() {
        const posts = await this._fetchWpPosts(15, 'grey market premium');
        const gmpIpos = [];

        for (const post of posts) {
            if (!post.title.includes('GMP')) continue;
            const slug = post.title
                .replace(/Grey Market Premium.*$/i, '')
                .replace(/,?\s*Today.*$/i, '')
                .replace(/IPO\s*/i, '')
                .replace(/,\s*$/, '')
                .trim();
            if (!slug) continue;

            const gmpEntries = extractGmpHistory(post.contentHtml);
            const latest = gmpEntries[0] || {};
            gmpIpos.push({
                name: slug,
                gmp: latest.gmp || '₹–',
                trend: latest.trend || '',
                gain: latest.gain || '',
                date: latest.date || '',
                link: post.link,
                gmpHistory: gmpEntries,
            });
        }
        return gmpIpos;
    }

    /**
     * Fetch IPO dashboard data from chittorgarh.com.
     * Returns analyst ratings: { name: { apply, mayApply, neutral, avoid, notRated } }
     */
    async _fetchChittorgarhDashboard() {
        const cacheKey = 'chittorgarh:dashboard';
        const cached = this._cache.get(cacheKey);
        if (cached && Date.now() - cached.ts < this._cacheTtlMs) return cached.data;

        try {
            const resp = await fetch('https://www.chittorgarh.com/ipo/ipo_dashboard.asp', {
                headers: DEFAULT_HEADERS,
                redirect: 'follow',
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const html = await resp.text();

            const tables = [...html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)];
            const ratings = {};

            // Table 1 has: Company | Apply | May Apply | Neutral | Avoid | Not Rated
            if (tables[1]) {
                const cells = [...tables[1][0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)];
                const vals = cells.map((c) => c[1].replace(/<[^>]+>/g, '').replace(/&#8377;/g, '₹').replace(/&nbsp;/g, ' ').trim()).filter(Boolean);

                for (let i = 0; i < vals.length; i += 6) {
                    if (i + 5 >= vals.length) break;
                    const name = vals[i].replace(/\s*IPO$/i, '').trim();
                    if (!name) continue;
                    ratings[name.toLowerCase()] = {
                        name,
                        apply: parseInt(vals[i + 1], 10) || 0,
                        mayApply: parseInt(vals[i + 2], 10) || 0,
                        neutral: parseInt(vals[i + 3], 10) || 0,
                        avoid: parseInt(vals[i + 4], 10) || 0,
                        notRated: parseInt(vals[i + 5], 10) || 0,
                    };
                }
            }

            this._cache.set(cacheKey, { data: ratings, ts: Date.now() });
            return ratings;
        } catch (err) {
            logger.warn(`Chittorgarh dashboard fetch failed: ${err.message}`);
            return {};
        }
    }

    /** Match a chittorgarh rating to an IPO name (fuzzy). */
    _matchChittorgarhRating(ipoName, ratings) {
        const lower = ipoName.toLowerCase();
        // Exact match
        if (ratings[lower]) return ratings[lower];
        // Partial match
        for (const [key, val] of Object.entries(ratings)) {
            if (key.includes(lower) || lower.includes(key)) return val;
        }
        return null;
    }

    async getCurrentIpos() {
        const posts = await this._fetchWpPosts(25, 'ipo');
        const gmpPosts = await this._fetchWpPosts(15, 'grey market premium');
        const allPosts = [...posts, ...gmpPosts];
        const ipos = new Map();

        // Build GMP lookup from GMP posts
        const gmpLookup = new Map();
        for (const post of gmpPosts) {
            if (!post.title.includes('GMP')) continue;
            const slug = post.title
                .replace(/Grey Market Premium.*$/i, '')
                .replace(/,?\s*Today.*$/i, '')
                .replace(/IPO\s*/i, '')
                .replace(/,\s*$/, '')
                .trim();
            if (!slug) continue;
            const gmpEntries = extractGmpHistory(post.contentHtml);
            const latest = gmpEntries[0] || {};
            gmpLookup.set(slug.toLowerCase(), {
                gmp: latest.gmp || '₹–',
                trend: latest.trend || '',
                gain: latest.gain || '',
                date: latest.date || '',
                gmpHistory: gmpEntries,
            });
        }

        for (const post of allPosts) {
            const title = post.title;
            let name = title
                .replace(/\s*(IPO\s*)?(GMP|Subscription|Listing|Review|Allotment|Grey Market|Recommendation|Date).*$/i, '')
                .replace(/,\s*$/, '')
                .trim();
            if (!name || name.length < 3) continue;

            if (!ipos.has(name)) {
                // Try to match GMP data
                const gmpKey = name.toLowerCase();
                const gmpData = gmpLookup.get(gmpKey) ||
                    [...gmpLookup.entries()].find(([k]) => k.includes(gmpKey) || gmpKey.includes(k))?.[1] || null;

                ipos.set(name, {
                    name,
                    hasGmp: Boolean(gmpData),
                    hasSubscription: false,
                    hasListing: false,
                    link: post.link,
                    gmp: gmpData?.gmp || null,
                    gmpPct: gmpData?.gain || null,
                    gmpHistory: gmpData?.gmpHistory || null,
                    subscriptionUrl: '',
                    detailsUrl: '',
                });
            }

            const ipo = ipos.get(name);
            // Check ALL posts for SME indicators
            const content = post.contentHtml || '';
            if (/NSE\s*SME|BSE\s*SME/i.test(content)) {
                ipo.isSme = true;
            }

            if (/gmp|grey market/i.test(title)) {
                ipo.hasGmp = true;
                ipo.link = post.link;
                // Extract GMP from this post's content
                const gmpEntries = extractGmpHistory(post.contentHtml);
                if (gmpEntries.length) {
                    ipo.gmp = gmpEntries[0].gmp || '₹–';
                    ipo.gmpPct = gmpEntries[0].gain || '';
                    ipo.gmpHistory = gmpEntries;
                }
            } else if (/subscription/i.test(title)) {
                ipo.hasSubscription = true;
                ipo.subscriptionUrl = post.link;
                const subData = extractSubscriptionData(post.contentHtml);
                if (subData) ipo.subscriptionData = subData;
            } else if (/listing/i.test(title)) {
                ipo.hasListing = true;
                ipo.detailsUrl = post.link;
            } else {
                ipo.detailsUrl = ipo.detailsUrl || post.link;
            }
        }

        let result = Array.from(ipos.values()).filter((ipo) => !ipo.isSme);

        // Dedup: if one IPO name is a substring of another, keep the longer one
        result.sort((a, b) => b.name.length - a.name.length);
        const deduped = [];
        const seen = new Set();
        for (const ipo of result) {
            const lower = ipo.name.toLowerCase();
            // Check if this name is a substring of any already-accepted name
            let isDupe = false;
            for (const s of seen) {
                if (s.includes(lower) || lower.includes(s)) {
                    isDupe = true;
                    break;
                }
            }
            if (!isDupe) {
                deduped.push(ipo);
                seen.add(lower);
            }
        }

        // Fetch chittorgarh analyst ratings
        const cgRatings = await this._fetchChittorgarhDashboard();

        // Enrich: fetch missing GMP + subscription data for each IPO
        for (const ipo of deduped) {
            // Attach chittorgarh analyst rating
            const cgRating = this._matchChittorgarhRating(ipo.name, cgRatings);
            if (cgRating) {
                ipo.analystRating = cgRating;
            }
            // Fetch GMP + issue size if missing
            if (!ipo.gmp || !ipo.issueSize) {
                try {
                    const gmpPosts = await this._fetchWpPosts(5, `${ipo.name} gmp`);
                    const gmpPost = gmpPosts.find((p) => /gmp|grey market/i.test(p.title));
                    if (gmpPost) {
                        const entries = extractGmpHistory(gmpPost.contentHtml);
                        if (entries.length) {
                            ipo.gmp = ipo.gmp || entries[0].gmp || '₹–';
                            ipo.gmpPct = ipo.gmpPct || entries[0].gain || '';
                            ipo.gmpHistory = entries;
                        }
                        // Extract issue size from GMP post table content
                        if (!ipo.issueSize) {
                            const html = gmpPost.contentHtml || '';
                            const sizeMatch = html.match(/Issue\s+Size[^<]*<\/t[dh]>\s*<t[dh][^>]*>([^<]+)/i);
                            if (sizeMatch) {
                                ipo.issueSize = sizeMatch[1].trim();
                            }
                        }
                    }
                } catch {}
            }

            // Fetch subscription if missing
            if (!ipo.subscriptionData) {
                try {
                    const subPosts = await this._fetchWpPosts(5, `${ipo.name} subscription`);
                    const subPost = subPosts.find((p) => /subscription/i.test(p.title));
                    if (subPost) {
                        const subData = extractSubscriptionData(subPost.contentHtml);
                        if (subData) ipo.subscriptionData = subData;
                    }
                } catch {}
            }
        }

        return deduped;
    }

    /**
     * Get full analysis data for a specific IPO by name.
     * Returns a rich object with all fields needed for the card.
     */
    async getIpoByName(name) {
        const posts = await this._fetchWpPosts(30, name);
        if (!posts.length) return null;

        const lowerName = name.toLowerCase();
        const matchingPosts = posts.filter((p) => {
            const title = p.title.toLowerCase();
            return title.includes(lowerName) || lowerName.split(' ').some((w) => w.length > 3 && title.includes(w));
        });

        if (!matchingPosts.length) return null;

        // Collect URLs
        let gmpUrl = '', subUrl = '', detailUrl = '';
        for (const post of matchingPosts) {
            const t = post.title;
            if (/gmp|grey market/i.test(t)) gmpUrl = post.link;
            else if (/subscription/i.test(t)) subUrl = post.link;
            else detailUrl = detailUrl || post.link;
        }

        // Scrape the GMP/details page
        const pageUrl = gmpUrl || detailUrl || subUrl || matchingPosts[0]?.link;
        const pageData = pageUrl ? await this._scrapeIpoPage(pageUrl) : {};

        // Get subscription data from the subscription post
        let subscription = null;
        const subPost = matchingPosts.find((p) => /subscription/i.test(p.title));
        if (subPost) {
            subscription = extractSubscriptionData(subPost.contentHtml);
        }

        // Parse price band for lot size computation
        const priceBand = pageData.details['IPO Price Band'] || '';
        const priceRange = parsePriceRange(priceBand);
        const upperBand = priceRange?.high || parsePrice(priceBand);

        // Parse lot size from details (some IPOs include it)
        const lotText = pageData.details['Lot Size'] || pageData.details['Market Lot'] || '';
        let lotSize = parseInt(String(lotText).replace(/[^\d]/g, ''), 10);
        if (!lotSize || lotSize < 1) {
            // Estimate lot size from common Indian IPO lot values
            // Most SME IPOs: ₹1-2L investment, Mainboard: ₹12-15L
            // We'll set a default and let the controller compute
            lotSize = null;
        }

        const displayName = matchingPosts[0]?.title?.replace(/IPO.*$/i, '').trim() || name;

        return {
            name: displayName,
            priceBand: priceRange ? `₹${priceRange.low} - ₹${priceRange.high}` : priceBand,
            priceLow: priceRange?.low || null,
            priceHigh: priceRange?.high || upperBand,
            lotSize,
            faceValue: pageData.details['Face Value'] || '₹10',
            issueSize: pageData.details['Issue Size'] || '',
            freshIssue: pageData.details['Fresh Issue'] || '',
            ofp: pageData.details['Offer for Sale'] || '',
            issueType: pageData.details['Issue Type'] || '',
            listing: pageData.details['IPO Listing'] || '',
            openDate: pageData.dates['IPO Open Date'] || pageData.details['IPO Open Date'] || '',
            closeDate: pageData.dates['IPO Close Date'] || pageData.details['IPO Close Date'] || '',
            allotmentDate: pageData.dates['Basis of Allotment'] || '',
            refundDate: pageData.dates['Refunds'] || '',
            dematDate: pageData.dates['Credit to Demat Account'] || '',
            listingDate: pageData.dates['IPO Listing Date'] || pageData.dates['Listing Date'] || '',
            gmpHistory: pageData.gmpHistory || [],
            latestGmp: pageData.gmpHistory?.[0] || null,
            subscription,
            financials: pageData.financials,
            peers: pageData.peers,
            urls: { gmp: gmpUrl, subscription: subUrl, details: detailUrl },
        };
    }

    /**
     * Compute IPO score (0-100) from available data.
     * Factors: GMP trend, subscription demand, QIB response, financials, issue type.
     */
    computeIpoScore(ipo) {
        let score = 50; // base
        const reasons = { positives: [], risks: [] };

        // GMP factor (up to +20)
        if (ipo.latestGmp) {
            const gmpVal = parseFloat(String(ipo.latestGmp.gmp).replace('₹', '')) || 0;
            const priceHigh = ipo.priceHigh || 100;
            const gmpPct = priceHigh > 0 ? (gmpVal / priceHigh) * 100 : 0;

            if (gmpPct > 20) { score += 20; reasons.positives.push('Very strong GMP trend'); }
            else if (gmpPct > 10) { score += 15; reasons.positives.push('Strong GMP trend'); }
            else if (gmpPct > 5) { score += 10; reasons.positives.push('Healthy GMP'); }
            else if (gmpPct > 0) { score += 5; reasons.positives.push('Positive GMP'); }
            else if (gmpPct < -5) { score -= 15; reasons.risks.push('Negative GMP — listing below issue price likely'); }
            else if (gmpPct < 0) { score -= 5; reasons.risks.push('GMP below issue price'); }
        }

        // Subscription factor (up to +20)
        if (ipo.subscription?.data?.Total) {
            const total = ipo.subscription.data.Total;
            const latest = total[total.length - 1];
            if (typeof latest === 'number') {
                if (latest > 10) { score += 20; reasons.positives.push('Exceptional overall demand'); }
                else if (latest > 5) { score += 15; reasons.positives.push('Very high investor demand'); }
                else if (latest > 2) { score += 10; reasons.positives.push('Healthy subscription'); }
                else if (latest > 1) { score += 5; reasons.positives.push('Moderate demand'); }
                else { score -= 5; reasons.risks.push('Low subscription demand'); }
            }

            // QIB factor (up to +10)
            const qib = ipo.subscription.data.QIB;
            if (qib?.length) {
                const latestQib = qib[qib.length - 1];
                if (typeof latestQib === 'number') {
                    if (latestQib > 5) { score += 10; reasons.positives.push('Strong QIB institutional interest'); }
                    else if (latestQib > 2) { score += 5; reasons.positives.push('Moderate QIB interest'); }
                    else if (latestQib < 0.5) { score -= 5; reasons.risks.push('Weak QIB response'); }
                }
            }
        }

        // Issue type factor
        if (/SME/i.test(ipo.issueType)) {
            score -= 5;
            reasons.risks.push('SME IPO — higher volatility, lower liquidity');
        }

        // Fresh issue vs OFS
        if (ipo.freshIssue && !ipo.ofp) {
            score += 5;
            reasons.positives.push('Fresh issue — funds go to company growth');
        } else if (ipo.ofp && !ipo.freshIssue) {
            score -= 3;
            reasons.risks.push('Pure OFS — existing shareholders exiting');
        }

        // Financials (if available)
        if (ipo.financials?.rows?.length) {
            const latestRow = ipo.financials.rows[ipo.financials.rows.length - 1];
            if (latestRow?.length >= 4) {
                const revenue = parseFloat(String(latestRow[1]).replace(/[₹,\s]/g, '')) || 0;
                const prevRevenue = ipo.financials.rows.length >= 2
                    ? parseFloat(String(ipo.financials.rows[ipo.financials.rows.length - 2][1]).replace(/[₹,\s]/g, '')) || 0
                    : 0;
                if (prevRevenue > 0) {
                    const growth = ((revenue - prevRevenue) / prevRevenue) * 100;
                    if (growth > 20) { score += 5; reasons.positives.push(`Revenue growth ${Math.round(growth)}% YoY`); }
                    else if (growth < -10) { score -= 5; reasons.risks.push(`Revenue declining ${Math.round(growth)}% YoY`); }
                }

                const pat = parseFloat(String(latestRow[3]).replace(/[₹,\s]/g, '')) || 0;
                if (pat < 0) { score -= 10; reasons.risks.push('Company is loss-making'); }
                else if (pat > 0) { reasons.positives.push('Profitable company'); }
            }
        }

        // Chittorgarh analyst ratings (up to ±10)
        if (ipo.analystRating) {
            const r = ipo.analystRating;
            const total = r.apply + r.mayApply + r.neutral + r.avoid + r.notRated;
            if (total > 0) {
                const applyPct = (r.apply / total) * 100;
                const avoidPct = (r.avoid / total) * 100;
                if (applyPct > 70) { score += 10; reasons.positives.push(`Strong analyst consensus: ${r.apply}/${total} recommend APPLY`); }
                else if (applyPct > 40) { score += 5; reasons.positives.push(`Analysts lean APPLY: ${r.apply}/${total}`); }
                else if (avoidPct > 50) { score -= 10; reasons.risks.push(`Analysts lean AVOID: ${r.avoid}/${total}`); }
                else if (avoidPct > 30) { score -= 5; reasons.risks.push(`Mixed analyst view: ${r.avoid}/${total} AVOID`); }
            }
        }

        // Cap score
        score = Math.max(10, Math.min(100, score));
        return { score, ...reasons };
    }

    /**
     * Compute lot size by trying common values.
     * Indian IPOs typically have lot sizes that result in ₹12,000-15,000 investment.
     */
    computeLotSize(priceHigh) {
        if (!priceHigh || priceHigh <= 0) return null;
        // Try common lot sizes to get investment in ₹12,000-15,000 range
        const targets = [14000, 14500, 15000, 12000, 13000, 16000];
        for (const target of targets) {
            const lot = Math.round(target / priceHigh);
            if (lot > 0 && lot < 500) {
                const investment = lot * priceHigh;
                if (investment >= 10000 && investment <= 20000) return lot;
            }
        }
        // Fallback: assume ₹15,000 investment
        return Math.round(15000 / priceHigh);
    }

    /**
     * Compute profit scenarios from GMP and lot size.
     */
    computeProfitScenarios(gmpVal, lotSize) {
        if (!gmpVal || !lotSize) return null;
        const conservative = Math.round(gmpVal * 0.5 * lotSize);
        const base = Math.round(gmpVal * lotSize);
        const bull = Math.round(gmpVal * 1.5 * lotSize);
        return { conservative, base, bull };
    }

    /**
     * Compute allotment chance estimate based on subscription.
     */
    computeAllotmentChance(subscription) {
        if (!subscription?.data?.Total) return '15-25%';
        const total = subscription.data.Total;
        const latest = total[total.length - 1];
        if (typeof latest !== 'number') return '15-25%';
        if (latest > 20) return '1-5%';
        if (latest > 10) return '5-10%';
        if (latest > 5) return '10-15%';
        if (latest > 2) return '15-25%';
        if (latest > 1) return '25-40%';
        return '40-60%';
    }

    /**
     * Build the full IPO card matching the desired format.
     * @param {object} ipo - from getIpoByName()
     * @param {object} [scoreData] - from computeIpoScore()
     * @param {object} [snapshot] - previous snapshot for comparison (day 1 data)
     */
    formatIpoCard(ipo, scoreData = null, snapshot = null) {
        if (!ipo) return '❌ IPO not found';

        const L = [];
        const displayName = ipo.name;

        // Compute fields
        const priceHigh = ipo.priceHigh || 0;
        const lotSize = ipo.lotSize || this.computeLotSize(priceHigh);
        const gmpVal = ipo.latestGmp ? parseFloat(String(ipo.latestGmp.gmp).replace('₹', '')) || 0 : 0;
        const gmpPct = priceHigh > 0 ? ((gmpVal / priceHigh) * 100).toFixed(0) : '0';
        const expectedListing = priceHigh + gmpVal;
        const investmentRequired = lotSize ? lotSize * priceHigh : null;
        const profitPerLot = lotSize ? gmpVal * lotSize : null;

        // Score
        const score = scoreData || this.computeIpoScore(ipo);
        const verdict = score.score >= 65 ? '✅ APPLY' : score.score >= 45 ? '⚠️ MAYBE — small qty' : '❌ AVOID';

        // Allotment chance
        const allotmentChance = this.computeAllotmentChance(ipo.subscription);

        // Profit scenarios
        const scenarios = this.computeProfitScenarios(gmpVal, lotSize);

        // ── Card header ──
        L.push(`🚀 *IPO ${ipo.openDate ? 'OPEN' : 'UPCOMING'}* | ${displayName}`);
        L.push('');

        // ── Basic info ──
        L.push(`💰 *Price Band:* ${ipo.priceBand}`);
        if (ipo.faceValue) L.push(`📝 *Face Value:* ${ipo.faceValue}`);
        if (ipo.issueSize) L.push(`📦 *Issue Size:* ${ipo.issueSize}`);
        if (ipo.freshIssue) L.push(`🆕 *Fresh Issue:* ${ipo.freshIssue}`);
        if (ipo.ofp) L.push(`🔄 *Offer for Sale:* ${ipo.ofp}`);
        if (lotSize) L.push(`📦 *Lot Size:* ${lotSize} Shares`);
        if (investmentRequired) L.push(`💵 *Investment Required:* ₹${investmentRequired.toLocaleString('en-IN')}`);
        if (ipo.issueType) L.push(`📋 *Issue Type:* ${ipo.issueType}`);
        if (ipo.listing) L.push(`🏦 *Listing:* ${ipo.listing}`);
        L.push('');
        L.push('━━━━━━━━━━━━━━━━━');
        L.push('');

        // ── GMP & Expected Listing ──
        const gmpEmoji = gmpVal > 0 ? '🔥' : gmpVal < 0 ? '📉' : '➡️';
        L.push(`${gmpEmoji} *GMP:* ${ipo.latestGmp?.gmp || '₹–'} (${gmpPct}%)`);
        if (expectedListing > priceHigh) {
            L.push(`📈 *Expected Listing:* ₹${expectedListing}`);
        }
        if (profitPerLot) {
            const profitEmoji = profitPerLot > 0 ? '💸' : '⚠️';
            L.push(`${profitEmoji} *Expected Profit/Lot:* ₹${profitPerLot.toLocaleString('en-IN')}`);
        }
        L.push('');

        // ── Subscription / Demand Status ──
        if (ipo.subscription?.data) {
            L.push('📊 *Demand Status*');
            const sub = ipo.subscription;
            const catEmoji = { QIB: '🏦', NII: '💎', bNII: '💎', sNII: '🎯', RII: '👤', EMP: '🏢', Total: '📈' };
            for (const cat of sub.categories) {
                const vals = sub.data[cat];
                if (!vals?.length) continue;
                const latest = vals[vals.length - 1];
                const label = cat === 'Total' ? '*Overall*' : (catEmoji[cat] || '•') + ' ' + cat;
                L.push(`${label}: ${typeof latest === 'number' ? latest.toFixed(2) + 'x' : latest}`);
            }

            // Compare with day 1 if snapshot available
            if (snapshot?.subscription?.data?.Total) {
                const day1Total = snapshot.subscription.data.Total[0];
                const latestTotal = sub.data.Total?.slice(-1)?.[0];
                if (typeof day1Total === 'number' && typeof latestTotal === 'number' && day1Total > 0) {
                    const growth = ((latestTotal - day1Total) / day1Total * 100).toFixed(0);
                    L.push(`📊 _Day 1: ${day1Total.toFixed(2)}x → Now: ${latestTotal.toFixed(2)}x (+${growth}%)_`);
                }
            }
            L.push('');
        }

        // ── IPO Score ──
        L.push(`🎯 *IPO Score:* ${score.score}/100`);
        L.push(`🤖 *AI Confidence:* ${score.score}%`);
        L.push(`🎲 *Allotment Chance:* ${allotmentChance}`);
        L.push('');
        L.push(`✅ *Verdict:* ${verdict}`);
        L.push('');
        L.push('━━━━━━━━━━━━━━━━━');
        L.push('');

        // ── Positives ──
        if (score.positives?.length) {
            L.push('🟢 *Positives*');
            for (const p of score.positives) L.push(`• ${p}`);
            L.push('');
        }

        // ── Risks ──
        if (score.risks?.length) {
            L.push('🔴 *Risks*');
            for (const r of score.risks) L.push(`• ${r}`);
            L.push('');
        }

        L.push('━━━━━━━━━━━━━━━━━');
        L.push('');

        // ── Profit Scenarios ──
        if (scenarios) {
            L.push('💰 *Profit Scenarios*');
            L.push(`🟡 *Conservative:* ₹${scenarios.conservative.toLocaleString('en-IN')}`);
            L.push(`🟢 *Base Case:* ₹${scenarios.base.toLocaleString('en-IN')}`);
            L.push(`🚀 *Bull Case:* ₹${scenarios.bull.toLocaleString('en-IN')}`);
            L.push('');
        }

        // ── Suitable For ──
        L.push('📌 *Suitable For:*');
        if (score.score >= 65) {
            L.push('✔ Listing Gain Investors');
            if (score.score >= 75) L.push('✔ Moderate Risk Investors');
        } else if (score.score >= 45) {
            L.push('✔ Small Position Investors');
            L.push('⚠️ Higher risk — apply with caution');
        } else {
            L.push('❌ Not recommended for most investors');
        }
        L.push('');

        // ── Key Dates ──
        L.push('📅 *Key Dates:*');
        if (ipo.openDate) L.push(`• Open: ${ipo.openDate}`);
        if (ipo.closeDate) L.push(`• Close: ${ipo.closeDate}`);
        if (ipo.allotmentDate) L.push(`• Allotment: ${ipo.allotmentDate}`);
        if (ipo.listingDate) L.push(`• Listing: ${ipo.listingDate}`);

        return L.join('\n');
    }

    /**
     * Format the list card for /ipo command.
     */
    formatListCard(ipos) {
        const L = [];
        L.push('┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓');
        L.push('┃  📊 *CURRENT INDIAN IPOs* 📊  ┃');
        L.push('┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛');
        L.push('');

        let idx = 1;
        for (const ipo of ipos) {
            const sub = ipo.subscriptionData;
            const totalSub = sub?.data?.Total?.slice(-1)?.[0];
            const subStr = typeof totalSub === 'number' ? totalSub.toFixed(1) + 'x' : '–';

            // Use GMP from ipo object (already matched in getCurrentIpos)
            const gmpStr = ipo.gmp || '–';
            const gmpPct = ipo.gmpPct || '';

            const statusEmoji = ipo.hasListing ? '📈' : '🔜';
            L.push(`${statusEmoji} *${idx}. ${ipo.name}*`);
            if (ipo.issueSize) L.push(`   📦 Size: ${ipo.issueSize}`);
            L.push(`   📊 GMP: ${gmpStr}${gmpPct ? ' (' + gmpPct + ')' : ''}`);
            L.push(`   📈 Sub: ${subStr}`);
            if (ipo.analystRating) {
                const r = ipo.analystRating;
                const total = r.apply + r.mayApply + r.neutral + r.avoid;
                if (total > 0) L.push(`   🏦 Analysts: ${r.apply} Apply · ${r.mayApply} Maybe · ${r.neutral} Neutral · ${r.avoid} Avoid`);
            }
            L.push('');
            idx++;
        }

        L.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        L.push('💡 *Commands:*');
        L.push('• `/ipo <name>` — Full AI analysis');
        L.push('• `/ipo gmp` — GMP leaderboard');
        L.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        return L.join('\n');
    }

    /**
     * Format GMP leaderboard card.
     */
    formatGmpLeaderboard(gmpList) {
        const L = [];
        L.push('┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓');
        L.push('┃  📊 *IPO GMP LEADERBOARD* 📊  ┃');
        L.push('┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛');
        L.push('');

        gmpList.sort((a, b) => {
            const aVal = parseFloat(String(a.gmp).replace('₹', '')) || 0;
            const bVal = parseFloat(String(b.gmp).replace('₹', '')) || 0;
            return bVal - aVal;
        });

        for (const ipo of gmpList) {
            const gmpVal = parseFloat(String(ipo.gmp).replace('₹', '')) || 0;
            const emoji = gmpVal > 0 ? '🟢' : gmpVal < 0 ? '🔴' : '⚪';
            L.push(`${emoji} *${ipo.name}*`);
            L.push(`   GMP: ${ipo.gmp} (${ipo.gain || '–'})`);
            L.push('');
        }

        L.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        L.push('💡 `/ipo <name>` for full analysis');
        L.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        return L.join('\n');
    }

    formatSubscription(subData) {
        if (!subData?.data?.categories?.length) return 'No subscription data available';
        const L = ['📊 *SUBSCRIPTION STATUS*'];
        const catLabels = { QIB: '🏦 QIB', NII: '💰 NII', bNII: '💎 bNII (>₹10L)', sNII: '🎯 sNII', RII: '👥 RII', EMP: '🏢 Employees', Total: '📈 *Total*' };
        for (const cat of subData.categories) {
            const vals = subData.data[cat];
            if (!vals?.length) continue;
            const label = catLabels[cat] || cat;
            const dayStr = vals.map((v, i) => `${i + 1}D: ${typeof v === 'number' ? v.toFixed(2) + 'x' : v}`).join(' · ');
            L.push(`${label}: ${dayStr}`);
        }
        return L.join('\n');
    }
}

export default IndianIpoService;
export const indianIpoService = new IndianIpoService();
