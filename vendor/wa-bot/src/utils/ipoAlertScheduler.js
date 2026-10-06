/**
 * IPO Alert Scheduler
 *
 * Automatically posts to trade groups:
 * 1. CLOSE DAY ALERT — when an IPO's last application day arrives (morning)
 *    Shows: updated GMP, subscription status, comparison with day 1, final verdict
 * 2. LISTING DAY ALERT — when an IPO lists (after market open)
 *    Shows: final GMP, listing price estimate, expected profit
 *
 * Runs daily at a configured time (default 08:30 IST for close day, 09:45 IST for listing day).
 */

import { logger } from './logger.js';
import { msUntilTimeInTimezone } from './newsScheduler.js';
import IndianIpoService from '../services/IndianIpoService.js';
import { buildHiddenMentionAll, withHiddenMentions } from './hiddenMentionAll.js';

/** IST date string for a Date object. */
function istDateStr(date = new Date()) {
    const d = new Date(date.getTime() + 5.5 * 3600e3);
    return d.toISOString().slice(0, 10);
}

/** Parse "August 19, 2026" → "2026-08-19" for comparison. */
function parseIpoDate(str) {
    if (!str) return null;
    try {
        const d = new Date(str);
        if (isNaN(d.getTime())) return null;
        return d.toISOString().slice(0, 10);
    } catch {
        return null;
    }
}

class IpoAlertScheduler {
    constructor({ config, groupManager, mongoDb, getSock }) {
        this.config = config;
        this.groupManager = groupManager;
        this.mongoDb = mongoDb;
        this.getSock = getSock;
        this.ipoService = new IndianIpoService();
        this._timer = null;
        this._running = false;
        this._postedCollection = null;
    }

    async init() {
        if (this.mongoDb) {
            this._postedCollection = this.mongoDb.collection('ipo_alerts_posted');
            await this._postedCollection.createIndex({ ipoName: 1, alertType: 1, date: 1 }, { unique: true });
        }
    }

    /** Check if we already posted a specific alert for an IPO today. */
    async _alreadyPosted(ipoName, alertType) {
        if (!this._postedCollection) return false;
        const today = istDateStr();
        const row = await this._postedCollection.findOne({ ipoName, alertType, date: today });
        return Boolean(row);
    }

    /** Mark an alert as posted. */
    async _markPosted(ipoName, alertType) {
        if (!this._postedCollection) return;
        const today = istDateStr();
        try {
            await this._postedCollection.updateOne(
                { ipoName, alertType, date: today },
                { $setOnInsert: { ipoName, alertType, date: today, postedAt: new Date() } },
                { upsert: true }
            );
        } catch (err) {
            logger.debug(`IPO alert markPosted failed: ${err.message}`);
        }
    }

    /**
     * Get day-1 snapshot for comparison.
     */
    async _getDay1Snapshot(name) {
        if (!this.mongoDb) return null;
        try {
            const snapshots = this.mongoDb.collection('ipo_snapshots');
            return await snapshots.findOne({ name }, { sort: { date: 1 } });
        } catch {
            return null;
        }
    }

    /**
     * Build close-day alert card.
     * Shows: updated data vs day 1, final subscription, GMP trend, verdict.
     */
    _buildCloseDayCard(ipo, scoreData, day1Snapshot) {
        const L = [];
        const name = ipo.name;

        L.push(`🔔 *LAST DAY TO APPLY* | ${name}`);
        L.push('');

        // Price & investment
        L.push(`💰 *Price Band:* ${ipo.priceBand}`);
        const lotSize = ipo.lotSize || this.ipoService.computeLotSize(ipo.priceHigh);
        if (lotSize) L.push(`📦 *Lot Size:* ${lotSize} Shares`);
        const investment = lotSize ? lotSize * ipo.priceHigh : null;
        if (investment) L.push(`💵 *Investment:* ₹${investment.toLocaleString('en-IN')}`);
        L.push('');

        L.push('━━━━━━━━━━━━━━━━━');
        L.push('');

        // GMP with trend
        const gmpVal = ipo.latestGmp ? parseFloat(String(ipo.latestGmp.gmp).replace('₹', '')) || 0 : 0;
        const gmpPct = ipo.priceHigh > 0 ? ((gmpVal / ipo.priceHigh) * 100).toFixed(0) : '0';
        const gmpEmoji = gmpVal > 0 ? '🔥' : gmpVal < 0 ? '📉' : '➡️';
        L.push(`${gmpEmoji} *GMP:* ${ipo.latestGmp?.gmp || '₹–'} (${gmpPct}%)`);

        if (day1Snapshot?.gmp) {
            const day1Gmp = parseFloat(String(day1Snapshot.gmp).replace('₹', '')) || 0;
            const change = gmpVal - day1Gmp;
            if (change !== 0) {
                const arrow = change > 0 ? '📈' : '📉';
                L.push(`${arrow} *GMP Change:* Day 1 ₹${day1Gmp} → Now ₹${gmpVal} (${change > 0 ? '+' : ''}₹${change})`);
            } else {
                L.push(`📊 *GMP:* Stable since day 1 (₹${gmpVal})`);
            }
        }

        const expectedListing = ipo.priceHigh + gmpVal;
        if (expectedListing > ipo.priceHigh) {
            L.push(`📈 *Expected Listing:* ₹${expectedListing}`);
        }
        if (lotSize && gmpVal) {
            L.push(`💸 *Expected Profit/Lot:* ₹${(gmpVal * lotSize).toLocaleString('en-IN')}`);
        }
        L.push('');

        // Updated subscription status
        if (ipo.subscription?.data) {
            L.push('📊 *Final Subscription Status*');
            const sub = ipo.subscription;
            for (const cat of sub.categories) {
                const vals = sub.data[cat];
                if (!vals?.length) continue;
                const latest = vals[vals.length - 1];
                const emoji = { QIB: '🏦', NII: '💎', RII: '👤', Total: '📈' }[cat] || '•';
                const label = cat === 'Total' ? '*Overall*' : emoji + ' ' + cat;
                L.push(`${label}: ${typeof latest === 'number' ? latest.toFixed(2) + 'x' : latest}`);
            }

            // Day 1 vs Now comparison
            if (day1Snapshot?.subscription?.data?.Total) {
                const day1Total = day1Snapshot.subscription.data.Total[0];
                const latestTotal = sub.data.Total?.slice(-1)?.[0];
                if (typeof day1Total === 'number' && typeof latestTotal === 'number') {
                    L.push('');
                    L.push(`📊 _Day 1: ${day1Total.toFixed(2)}x → Final: ${latestTotal.toFixed(2)}x_`);
                    if (day1Total > 0) {
                        const growth = ((latestTotal - day1Total) / day1Total * 100).toFixed(0);
                        L.push(`📈 _Demand grew ${growth}% since opening_`);
                    }
                }
            }
            L.push('');
        }

        // Score & verdict
        L.push(`🎯 *IPO Score:* ${scoreData.score}/100`);
        const verdict = scoreData.score >= 65 ? '✅ APPLY' : scoreData.score >= 45 ? '⚠️ SMALL QTY' : '❌ AVOID';
        L.push(`✅ *Verdict:* ${verdict}`);
        L.push('');

        L.push('━━━━━━━━━━━━━━━━━');
        L.push('');
        L.push('⏰ _Application closes today — apply before 5 PM_');
        L.push(`📅 Listing: ${ipo.listingDate || 'TBA'}`);

        return L.join('\n');
    }

    /**
     * Build listing-day alert card.
     */
    _buildListingDayCard(ipo, scoreData, day1Snapshot) {
        const L = [];
        const name = ipo.name;

        L.push(`📈 *IPO LISTING TODAY* | ${name}`);
        L.push('');

        const lotSize = ipo.lotSize || this.ipoService.computeLotSize(ipo.priceHigh);
        const gmpVal = ipo.latestGmp ? parseFloat(String(ipo.latestGmp.gmp).replace('₹', '')) || 0 : 0;
        const expectedListing = ipo.priceHigh + gmpVal;

        L.push(`💰 *Issue Price:* ₹${ipo.priceHigh}`);
        if (lotSize) L.push(`📦 *Lot Size:* ${lotSize} Shares`);
        L.push('');

        L.push('━━━━━━━━━━━━━━━━━');
        L.push('');

        L.push(`🟢 *Final GMP:* ₹${gmpVal || '–'} (${ipo.latestGmp?.gain || '–'})`);
        L.push(`📈 *Expected Listing:* ₹${expectedListing}`);

        if (lotSize && gmpVal) {
            const profit = gmpVal * lotSize;
            L.push(`💸 *Expected Profit/Lot:* ₹${profit.toLocaleString('en-IN')}`);
        }
        L.push('');

        // GMP trend over time
        if (ipo.gmpHistory?.length > 1) {
            L.push('📊 *GMP Trend:*');
            for (const g of ipo.gmpHistory.slice(0, 5)) {
                L.push(`  ${g.date}: ${g.gmp} (${g.gain || '–'})`);
            }
            L.push('');
        }

        // Subscription summary
        if (ipo.subscription?.data?.Total) {
            const total = ipo.subscription.data.Total;
            const final = total[total.length - 1];
            L.push(`📊 *Final Subscription:* ${typeof final === 'number' ? final.toFixed(2) + 'x' : '–'}`);
            L.push('');
        }

        // Score
        L.push(`🎯 *IPO Score:* ${scoreData.score}/100`);

        // Comparison with day 1
        if (day1Snapshot) {
            L.push('');
            L.push('📊 *Day 1 vs Listing:*');
            if (day1Snapshot.gmp) {
                const day1Gmp = parseFloat(String(day1Snapshot.gmp).replace('₹', '')) || 0;
                const change = gmpVal - day1Gmp;
                L.push(`  GMP: ₹${day1Gmp} → ₹${gmpVal} (${change >= 0 ? '+' : ''}₹${change})`);
            }
            if (day1Snapshot.score) {
                L.push(`  Score: ${day1Snapshot.score} → ${scoreData.score}`);
            }
        }

        L.push('');
        L.push('━━━━━━━━━━━━━━━━━');
        L.push('⚠️ _Listing gains are not guaranteed — book partial profits if needed_');

        return L.join('\n');
    }

    /**
     * Run one tick: check all current IPOs for close day / listing day alerts.
     */
    async tick() {
        if (this._running) return;
        this._running = true;

        try {
            const sock = this.getSock?.();
            if (!sock) return;

            const today = istDateStr();
            const ipos = await this.ipoService.getCurrentIpos();

            for (const ipo of ipos) {
                // Get full data
                const fullIpo = await this.ipoService.getIpoByName(ipo.name);
                if (!fullIpo) continue;

                const closeDate = parseIpoDate(fullIpo.closeDate);
                const listingDate = parseIpoDate(fullIpo.listingDate);
                const scoreData = this.ipoService.computeIpoScore(fullIpo);

                // CLOSE DAY ALERT
                if (closeDate && closeDate === today) {
                    if (await this._alreadyPosted(ipo.name, 'close_day')) continue;

                    const day1 = await this._getDay1Snapshot(ipo.name);
                    const card = this._buildCloseDayCard(fullIpo, scoreData, day1);

                    await this._postToTradeGroups(sock, card);
                    await this._markPosted(ipo.name, 'close_day');
                    logger.info(`🔔 IPO close day alert posted: ${ipo.name}`);
                }

                // LISTING DAY ALERT
                if (listingDate && listingDate === today) {
                    if (await this._alreadyPosted(ipo.name, 'listing_day')) continue;

                    const day1 = await this._getDay1Snapshot(ipo.name);
                    const card = this._buildListingDayCard(fullIpo, scoreData, day1);

                    await this._postToTradeGroups(sock, card);
                    await this._markPosted(ipo.name, 'listing_day');
                    logger.info(`📈 IPO listing day alert posted: ${ipo.name}`);
                }
            }
        } catch (err) {
            logger.error(`IPO alert tick failed: ${err.message}`);
        } finally {
            this._running = false;
        }
    }

    /** Post a message to all trade alert groups simultaneously (parallel). */
    async _postToTradeGroups(sock, text) {
        try {
            const groups = await this.groupManager.getTradeAlertGroups();
            // Send to all groups in parallel so they arrive at the same time
            await Promise.all(
                groups.map(async (g) => {
                    const chatId = g.group_id || g.groupId || g;
                    try {
                        const pack = await buildHiddenMentionAll(sock, chatId);
                        const payload = withHiddenMentions(text, pack);
                        await sock.sendMessage(chatId, {
                            text: payload.text,
                            mentions: payload.mentions,
                        });
                    } catch (err) {
                        logger.warn(`IPO alert post failed for ${chatId}: ${err.message}`);
                    }
                })
            );
        } catch (err) {
            logger.warn(`IPO alert postToTradeGroups failed: ${err.message}`);
        }
    }
}

/**
 * Start the IPO alert scheduler.
 * Checks daily at configured times for close-day and listing-day IPOs.
 */
export function startIpoAlertScheduler({ config, groupManager, mongoDb, getSock }) {
    const closeTime = config.IPO_ALERT_CLOSE_TIME || '08:30';
    const listingTime = config.IPO_ALERT_LISTING_TIME || '09:45';
    const timezone = config.IPO_ALERT_TIMEZONE || 'Asia/Kolkata';

    const scheduler = new IpoAlertScheduler({ config, groupManager, mongoDb, getSock });

    // Initialize in background
    scheduler.init().catch((err) => logger.warn(`IPO scheduler init failed: ${err.message}`));

    let closeTimer = null;
    let listingTimer = null;

    function scheduleNext() {
        // Schedule close-day check
        const closeMs = msUntilTimeInTimezone(closeTime, timezone);
        closeTimer = setTimeout(async () => {
            await scheduler.tick();
            scheduleNext(); // reschedule for tomorrow
        }, closeMs);

        // Schedule listing-day check (30 min after close check)
        const listingMs = msUntilTimeInTimezone(listingTime, timezone);
        listingTimer = setTimeout(async () => {
            await scheduler.tick();
        }, listingMs);

        logger.info(`📊 IPO alerts scheduled: close=${closeTime} IST, listing=${listingTime} IST`);
    }

    scheduleNext();

    return {
        stop() {
            if (closeTimer) clearTimeout(closeTimer);
            if (listingTimer) clearTimeout(listingTimer);
            logger.info('📊 IPO alert scheduler stopped');
        },
        tick: () => scheduler.tick(),
    };
}
