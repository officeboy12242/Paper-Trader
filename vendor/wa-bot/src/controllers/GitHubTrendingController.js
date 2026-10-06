/**
 * Daily GitHub repo posts — trending, popular & hidden gems (fresh each slot).
 */

import { logger } from '../utils/logger.js';
import { formatGitHubRepoMessage } from '../utils/githubFormatter.js';
import { sendTextWithLinkPreview } from '../utils/linkPreview.js';
import GitHubTrendingService, { GITHUB_SLOT_CATEGORIES } from '../services/GitHubTrendingService.js';
import AssistLlmRouter from '../services/AssistLlmRouter.js';

const GROUP_DELAY_MS = 500;
const REPO_DELAY_MS = 2000;

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

class GitHubTrendingController {
    constructor(config, groupManager, githubDatabase = null) {
        this.config = config;
        this.groupManager = groupManager;
        this.githubDatabase = githubDatabase;
        this.service = new GitHubTrendingService(config.GITHUB_TRENDING_COUNT, {
            timezone: config.GITHUB_TRENDING_TIMEZONE || 'Asia/Kolkata',
            collegeSaturday: config.GITHUB_COLLEGE_SATURDAY !== false,
            llm: new AssistLlmRouter(config),
        });
    }

    async fetchTrendingRepos() {
        return this.service.fetchMixedPool();
    }

    async filterUnpostedRepos(repos, chatId) {
        if (!this.githubDatabase || !chatId) {
            return repos || [];
        }
        return this.githubDatabase.filterUnpostedRepos(repos, chatId);
    }

    async isSlotDone(slotKey) {
        if (!this.githubDatabase) return false;
        return this.githubDatabase.isSlotDone(slotKey);
    }

    async markSlotDone(slotKey, meta = {}) {
        if (!this.githubDatabase) return;
        await this.githubDatabase.markSlotDone(slotKey, meta);
    }

    /**
     * @param {object} [opts]
     * @param {boolean} [opts.markPosted=true] — false for /github preview so confirm can still fan out
     */
    async sendRepoMessage(sock, chatId, repo, index, total, { markPosted = true } = {}) {
        if (markPosted && this.githubDatabase && (await this.githubDatabase.isRepoPosted(repo.fullName, chatId))) {
            logger.info(`Skipping duplicate GitHub repo ${repo.fullName} for ${chatId}`);
            return false;
        }

        const text = formatGitHubRepoMessage(repo, index, total);
        await sendTextWithLinkPreview(sock, chatId, text, repo.url);

        if (markPosted && this.githubDatabase) {
            await this.githubDatabase.markRepoPosted(repo.fullName, chatId);
        }
        return true;
    }

    async postSingleRepoToGroups(sock, repo, index, total) {
        if (!sock || !repo) {
            return { posted: 0, groups: 0, skipped: 0 };
        }

        const targetGroups = await this.groupManager.getGithubTrendingGroups();
        if (!targetGroups.length) {
            logger.warn('No groups with GitHub trending enabled. Use /activate and /githubon.');
            return { posted: 0, groups: 0, skipped: 0 };
        }

        logger.info(`Posting GitHub repo #${index}/${total} (${repo.fullName}) to ${targetGroups.length} group(s)...`);

        let posted = 0;
        let skipped = 0;
        for (const group of targetGroups) {
            try {
                const sent = await this.sendRepoMessage(sock, group.group_id, repo, index, total);
                if (sent) {
                    posted++;
                    logger.info(`🐙 #${index} posted to ${group.group_name || group.group_id}`);
                } else {
                    skipped++;
                }
                await delay(GROUP_DELAY_MS);
            } catch (err) {
                logger.error(`GitHub repo #${index} failed for ${group.group_id}: ${err.message}`);
            }
        }

        return { posted, groups: targetGroups.length, skipped };
    }

    async postAllReposIndividually(sock, repos) {
        if (!sock || !repos?.length) {
            return { posted: 0, groups: 0, messages: 0, skipped: 0 };
        }

        const total = repos.length;
        let totalPosted = 0;
        let totalSkipped = 0;
        let groups = 0;

        for (let i = 0; i < repos.length; i++) {
            const { posted, groups: g, skipped } = await this.postSingleRepoToGroups(
                sock,
                repos[i],
                i + 1,
                total,
            );
            totalPosted += posted;
            totalSkipped += skipped;
            groups = g;
            if (i < repos.length - 1) {
                await delay(REPO_DELAY_MS);
            }
        }

        return {
            posted: totalPosted > 0 ? groups : 0,
            groups,
            messages: totalPosted,
            skipped: totalSkipped,
        };
    }

    async resolveFreshRepoForSlot(slotIndex) {
        const targetGroups = await this.groupManager.getGithubTrendingGroups();
        const groupIds = targetGroups.map((g) => g.group_id);

        const candidates = await this.service.fetchForSlot(slotIndex);
        if (!candidates.length) {
            return null;
        }

        if (this.githubDatabase && groupIds.length) {
            const fresh = await this.githubDatabase.pickFreshRepo(candidates, groupIds);
            if (fresh) return fresh;

            const mixed = await this.service.fetchMixedPool();
            return this.githubDatabase.pickFreshRepo(mixed, groupIds);
        }

        return candidates[0];
    }

    /**
     * Post one fresh repo at a scheduled slot (0-based index).
     * @returns {{ posted: number, groups: number, ok: boolean, reason: string, repo?: string }}
     */
    async checkAndPostRepo(sock, botState, slotIndex) {
        if (!this.config.GITHUB_TRENDING_ENABLED) {
            return { posted: 0, groups: 0, ok: false, reason: 'disabled' };
        }

        if (!sock) {
            logger.info('Waiting for WhatsApp connection (GitHub trending)...');
            return { posted: 0, groups: 0, ok: false, reason: 'no_sock' };
        }

        try {
            const targetGroups = await this.groupManager.getGithubTrendingGroups();
            if (!targetGroups.length) {
                logger.warn('No groups with GitHub trending enabled. Use /activate and /githubon.');
                return { posted: 0, groups: 0, ok: false, reason: 'no_groups' };
            }

            const repo = await this.resolveFreshRepoForSlot(slotIndex);
            if (!repo) {
                logger.info(`No fresh GitHub repo for slot ${slotIndex + 1}`);
                return { posted: 0, groups: targetGroups.length, ok: false, reason: 'no_repo' };
            }

            const total = this.config.GITHUB_TRENDING_COUNT;
            const category = this.service.isCollegeSaturday()
                ? 'college'
                : (GITHUB_SLOT_CATEGORIES[slotIndex] || repo.category || 'trending');
            if (!repo.category) repo.category = category;
            logger.info(`GitHub slot ${slotIndex + 1}: ${repo.fullName} (${category})`);

            const { posted, groups } = await this.postSingleRepoToGroups(sock, repo, slotIndex + 1, total);
            if (posted > 0) {
                logger.info(`🐙 GitHub #${slotIndex + 1} posted to ${posted}/${groups} group(s)`);
            } else {
                logger.warn(`🐙 GitHub #${slotIndex + 1} sent to 0/${groups} group(s)`);
            }

            if (slotIndex === 0 && this.githubDatabase) {
                const removed = await this.githubDatabase.cleanupOldPosted(14);
                if (removed > 0) {
                    logger.info(`Cleaned ${removed} old GitHub posted/slot record(s)`);
                }
            }

            return {
                posted,
                groups,
                ok: posted > 0,
                reason: posted > 0 ? 'posted' : 'send_failed',
                repo: repo.fullName,
            };
        } catch (err) {
            logger.error(`GitHub trending slot ${slotIndex + 1} failed: ${err.message}`);
            return { posted: 0, groups: 0, ok: false, reason: 'error' };
        }
    }

    async selectFreshRepos(repos, limit = null) {
        const max = limit ?? this.config.GITHUB_TRENDING_COUNT;
        const targetGroups = await this.groupManager.getGithubTrendingGroups();
        const groupIds = targetGroups.map((g) => g.group_id);

        if (!this.githubDatabase || !groupIds.length) {
            return (repos || []).slice(0, max);
        }

        const fresh = await this.githubDatabase.filterFreshForGroups(repos, groupIds);
        return fresh.slice(0, max);
    }

    async previewAll(sock, chatId, repos) {
        if (!repos?.length) {
            return { sent: 0, skipped: 0 };
        }

        const total = repos.length;
        let sent = 0;
        let skipped = 0;

        for (let i = 0; i < repos.length; i++) {
            // Preview must NOT mark posted — otherwise confirm finds nothing fresh for groups.
            const ok = await this.sendRepoMessage(sock, chatId, repos[i], i + 1, total, {
                markPosted: false,
            });
            if (ok) {
                sent++;
            } else {
                skipped++;
            }
            if (i < repos.length - 1) {
                await delay(REPO_DELAY_MS);
            }
        }

        return { sent, skipped };
    }
}

export default GitHubTrendingController;
