/**
 * Awesome lists — preview + scheduled one-random-list posts (GitHub-style).
 */

import { logger } from '../utils/logger.js';
import { formatAwesomeListMessage } from '../utils/awesomeFormatter.js';
import { sendTextWithLinkPreview } from '../utils/linkPreview.js';
import AwesomeListsService from '../services/AwesomeListsService.js';
import { isSaturdayInTimezone } from '../utils/newsScheduler.js';

const GROUP_DELAY_MS = 500;
const LIST_DELAY_MS = 2000;

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

class AwesomeListsController {
    constructor(config, groupManager, awesomeDatabase = null) {
        this.config = config;
        this.groupManager = groupManager;
        this.awesomeDatabase = awesomeDatabase;
        this.service = new AwesomeListsService(config.AWESOME_LISTS_COUNT);
    }

    async fetchPreviewLists() {
        return this.service.fetchPreviewLists();
    }

    async filterUnpostedLists(lists, chatId) {
        if (!this.awesomeDatabase || !chatId) return lists || [];
        return this.awesomeDatabase.filterUnpostedLists(lists, chatId);
    }

    async sendListMessage(sock, chatId, list, index, total) {
        if (this.awesomeDatabase && (await this.awesomeDatabase.isListPosted(list.fullName, chatId))) {
            logger.info(`Skipping duplicate awesome list ${list.fullName} for ${chatId}`);
            return false;
        }

        const text = formatAwesomeListMessage(list, index, total);
        await sendTextWithLinkPreview(sock, chatId, text, list.url);

        if (this.awesomeDatabase) {
            await this.awesomeDatabase.markListPosted(list.fullName, chatId);
        }
        return true;
    }

    async postSingleListToGroups(sock, list, index, total) {
        if (!sock || !list) {
            return { posted: 0, groups: 0, skipped: 0 };
        }

        const targetGroups = await this.groupManager.getAwesomeListsGroups();
        if (!targetGroups.length) {
            logger.warn('No groups with awesome lists enabled. Use /activate and /awesomeon.');
            return { posted: 0, groups: 0, skipped: 0 };
        }

        logger.info(`Posting awesome list #${index}/${total} (${list.fullName}) to ${targetGroups.length} group(s)...`);

        let posted = 0;
        let skipped = 0;
        for (const group of targetGroups) {
            try {
                const sent = await this.sendListMessage(sock, group.group_id, list, index, total);
                if (sent) {
                    posted++;
                    logger.info(`⭐ #${index} awesome posted to ${group.group_name || group.group_id}`);
                } else {
                    skipped++;
                }
                await delay(GROUP_DELAY_MS);
            } catch (err) {
                logger.error(`Awesome list #${index} failed for ${group.group_id}: ${err.message}`);
            }
        }

        return { posted, groups: targetGroups.length, skipped };
    }

    async postAllListsIndividually(sock, lists) {
        if (!sock || !lists?.length) {
            return { posted: 0, groups: 0, messages: 0, skipped: 0 };
        }

        const total = lists.length;
        let totalPosted = 0;
        let totalSkipped = 0;
        let groups = 0;

        for (let i = 0; i < lists.length; i++) {
            const { posted, groups: g, skipped } = await this.postSingleListToGroups(
                sock,
                lists[i],
                i + 1,
                total
            );
            totalPosted += posted;
            totalSkipped += skipped;
            groups = g;
            if (i < lists.length - 1) await delay(LIST_DELAY_MS);
        }

        return {
            posted: totalPosted > 0 ? groups : 0,
            groups,
            messages: totalPosted,
            skipped: totalSkipped,
        };
    }

    async resolveFreshRandomList() {
        const targetGroups = await this.groupManager.getAwesomeListsGroups();
        const groupIds = targetGroups.map((g) => g.group_id);

        const pool = await this.service.fetchPool(40);
        if (!pool.length) return null;

        if (this.awesomeDatabase && groupIds.length) {
            const fresh = await this.awesomeDatabase.pickFreshList(pool, groupIds);
            if (fresh) return fresh;
        }

        return pool[Math.floor(Math.random() * pool.length)];
    }

    /** Post one random awesome list at a scheduled slot. */
    async checkAndPostList(sock, botState, slotIndex) {
        if (!this.config.AWESOME_LISTS_ENABLED) return;

        // Saturdays are college/resume GitHub only — skip awesome that day.
        if (
            this.config.GITHUB_COLLEGE_SATURDAY !== false
            && isSaturdayInTimezone(new Date(), this.config.AWESOME_LISTS_TIMEZONE || 'Asia/Kolkata')
        ) {
            logger.info(`⭐ Awesome slot ${slotIndex + 1}: skipped — Saturday college/resume day`);
            return { posted: 0, skipped: true, reason: 'saturday_college' };
        }

        if (!sock) {
            logger.info('Waiting for WhatsApp connection (awesome lists)...');
            return;
        }

        try {
            const list = await this.resolveFreshRandomList();
            if (!list) {
                logger.info(`No fresh awesome list for slot ${slotIndex + 1}`);
                return;
            }

            const total = this.config.AWESOME_LISTS_COUNT;
            logger.info(`Awesome slot ${slotIndex + 1}: ${list.fullName} (random)`);

            const { posted, groups } = await this.postSingleListToGroups(sock, list, slotIndex + 1, total);
            if (posted > 0) {
                logger.info(`⭐ Awesome #${slotIndex + 1} posted to ${posted}/${groups} group(s)`);
            }

            if (slotIndex === 0 && this.awesomeDatabase) {
                const removed = await this.awesomeDatabase.cleanupOldPosted(14);
                if (removed > 0) {
                    logger.info(`Cleaned ${removed} old posted_awesome_lists record(s)`);
                }
            }
        } catch (err) {
            logger.error(`Awesome lists slot ${slotIndex + 1} failed: ${err.message}`);
        }
    }

    async selectFreshLists(lists, limit = null) {
        const max = limit ?? this.config.AWESOME_LISTS_COUNT;
        const targetGroups = await this.groupManager.getAwesomeListsGroups();
        const groupIds = targetGroups.map((g) => g.group_id);

        if (!this.awesomeDatabase || !groupIds.length) {
            return (lists || []).slice(0, max);
        }

        const fresh = await this.awesomeDatabase.filterFreshForGroups(lists, groupIds);
        return fresh.slice(0, max);
    }

    async previewAll(sock, chatId, lists) {
        if (!lists?.length) return { sent: 0, skipped: 0 };

        const total = lists.length;
        let sent = 0;
        let skipped = 0;

        for (let i = 0; i < lists.length; i++) {
            const ok = await this.sendListMessage(sock, chatId, lists[i], i + 1, total);
            if (ok) sent++;
            else skipped++;
            if (i < lists.length - 1) await delay(LIST_DELAY_MS);
        }

        return { sent, skipped };
    }
}

export default AwesomeListsController;
