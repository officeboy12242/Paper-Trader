/**
 * News Controller
 * Scrapes Inshorts tech news and posts to activated groups
 */

import { logger } from '../utils/logger.js';
import { formatNewsArticleMessages } from '../utils/newsFormatter.js';
import { botTelemetry } from '../utils/botTelemetry.js';

const MESSAGE_DELAY_MS = 400;

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

class NewsController {
    constructor(newsDatabase, scraper, config, groupManager) {
        this.newsDatabase = newsDatabase;
        this.scraper = scraper;
        this.config = config;
        this.groupManager = groupManager;
    }

    async fetchFreshArticles() {
        await this.scraper.scrapeAndQueue();
        return this.scraper.getFreshArticlesForPosting(this.config.NEWS_MIN_ARTICLES);
    }

    async sendArticleMessages(sock, chatId, articles, { markPosted = false } = {}) {
        const messages = formatNewsArticleMessages(articles, this.config.NEWS_MIN_ARTICLES);
        if (!messages.length) {
            return 0;
        }

        for (let i = 0; i < messages.length; i++) {
            await sock.sendMessage(chatId, { text: messages[i] });
            if (i < messages.length - 1) {
                await delay(MESSAGE_DELAY_MS);
            }
        }

        if (markPosted) {
            await this.newsDatabase.markNewsPosted(
                articles.map((a) => a.title),
                chatId
            );
        }

        return messages.length;
    }

    async postNewsToGroup(sock, articles, groupId) {
        const unposted = [];
        for (const article of articles) {
            if (!(await this.newsDatabase.isNewsPosted(article.title, groupId))) {
                unposted.push(article);
            }
        }

        if (!unposted.length) {
            return false;
        }

        try {
            await this.sendArticleMessages(sock, groupId, unposted, { markPosted: true });
            botTelemetry.track('post', {
                kind: 'news',
                title: String(unposted[0]?.title || 'news').slice(0, 100),
                chatId: groupId,
                count: unposted.length,
            });
            return true;
        } catch (error) {
            logger.error(`Error posting news to ${groupId}: ${error.message}`);
            return false;
        }
    }

    async postNews(sock, articles) {
        if (!sock) {
            logger.error('WhatsApp socket not available for news');
            return { posted: 0, groups: 0 };
        }

        if (!articles.length) {
            return { posted: 0, groups: 0 };
        }

        const activeGroups = await this.groupManager.getNewsEnabledGroups();
        if (!activeGroups.length) {
            logger.warn('No groups with tech news enabled. Use /activate and /newson in a group.');
            return { posted: 0, groups: 0 };
        }

        logger.info(
            `Posting tech news (${articles.length} articles, up to ${this.config.NEWS_MIN_ARTICLES} messages) to ${activeGroups.length} group(s)...`
        );

        const results = await Promise.all(
            activeGroups.map(async (group) => {
                const ok = await this.postNewsToGroup(sock, articles, group.group_id);
                if (ok) {
                    logger.info(`Tech news posted to ${group.group_name}`);
                } else {
                    logger.info(`News skipped or already posted to ${group.group_name}`);
                }
                return ok;
            })
        );

        const successCount = results.filter(Boolean).length;
        if (successCount > 0) {
            logger.info(`Tech news posted to ${successCount} group(s)`);
        }

        return { posted: successCount, groups: activeGroups.length };
    }

    async checkAndPostNews(sock, botState) {
        if (!sock) {
            logger.info('Waiting for WhatsApp connection (news)...');
            return;
        }

        logger.info('─── Checking for tech news (Inshorts) ───');
        botState.lastNewsCheckTime = Date.now();

        try {
            const articles = await this.fetchFreshArticles();

            if (articles.length) {
                logger.info(`${articles.length} tech article(s) to post.`);
                await this.postNews(sock, articles);
                await this.newsDatabase.clearQueue();
            } else {
                logger.info('No new tech news.');
            }

            const removed = await this.newsDatabase.cleanupOldNews(7);
            if (removed > 0) {
                logger.info(`Cleaned ${removed} old posted_news record(s)`);
            }
        } catch (error) {
            logger.error(`Error in news check: ${error.message}`);
        }
    }

    async scrapeAndQueueOnly() {
        try {
            const count = await this.scraper.scrapeAndQueue();
            if (count > 0) {
                logger.info(`News queue updated (+${count} article(s))`);
            }
            await this.newsDatabase.cleanupOldNews(7);
        } catch (error) {
            logger.error(`News scrape/queue failed: ${error.message}`);
        }
    }

    async previewNews(sock, chatId, articles) {
        if (!articles.length) {
            await sock.sendMessage(chatId, {
                text: '📭 No fresh tech news right now. Try again later.',
            });
            return 0;
        }

        return this.sendArticleMessages(sock, chatId, articles, { markPosted: false });
    }
}

export default NewsController;
