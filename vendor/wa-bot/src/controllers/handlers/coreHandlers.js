/**
 * Core handlers: ping, status, posted, clear, confirm, cancel, pause, resume, facts, help
 */

import axios from 'axios';
import os from 'os';
import { logger } from '../../utils/logger.js';
import { extractPhoneNumber, isDirectMessage } from '../../utils/permissions.js';
import { formatHelpText } from '../../commands/registry.js';
import { sendAndDelete } from '../../utils/autoDelete.js';
import { safeSendMessage } from '../../utils/waMessage.js';
import { fetchMonthlyBandwidthMB, formatBandwidth } from '../../utils/renderMetrics.js';
import { formatProgressLine } from '../../utils/progressBar.js';

function formatUptime(milliseconds) {
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
}

function getSystemStats() {
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    
    let totalIdle = 0, totalTick = 0;
    for (const cpu of cpus) {
        for (const type in cpu.times) totalTick += cpu.times[type];
        totalIdle += cpu.times.idle;
    }
    const cpuUsage = ((1 - totalIdle / totalTick) * 100).toFixed(1);
    const memUsage = ((usedMem / totalMem) * 100).toFixed(1);
    const processMemMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
    
    return { cpuUsage, memUsage, processMemMB, cores: cpus.length, platform: os.platform(), arch: os.arch() };
}

export async function handlePing(sock, chatId, { botState, botStartTime, originalMsg }) {
    try {
        const uptime = Date.now() - botStartTime;
        const uptimeFormatted = formatUptime(uptime);
        const stats = getSystemStats();
        const bandwidthMB = await Promise.race([
            fetchMonthlyBandwidthMB(),
            new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
        ]).catch(() => null);
        const statusEmoji = botState.isPaused ? '🟡' : '🟢';
        const statusText = botState.isPaused ? 'COURSES PAUSED' : 'ACTIVE';
        
        const currentTime = new Date().toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
            dateStyle: 'medium',
            timeStyle: 'short',
        });

        const bandwidthText = bandwidthMB == null ? null : formatBandwidth(bandwidthMB);

        let r = `        ⚡ *SASSY BOT TERMINAL* v2.0
        ════════════════════════

*$ system --status*
> ${statusEmoji} Status: *${statusText}*
> ⏱️ Uptime: *${uptimeFormatted}*

*$ monitor --resources*
${formatProgressLine('CPU', stats.cpuUsage, { decimals: 1 })}
${formatProgressLine('MEM', stats.memUsage, { decimals: 1 })}
> PROC: ${stats.processMemMB} MB | CORES: ${stats.cores}
${bandwidthText ? `> BW   ${bandwidthText} this month\n` : ''}

*$ info --system*
> 🖥️ OS: ${stats.platform}/${stats.arch}
> 📗 NODE: ${process.version}
> ⏰ TIME: ${currentTime}

✅ *PONG!* All systems operational 🚀

_⏰ Auto-deletes in 5 hours_`;

        await sendAndDelete(sock, chatId, { text: r }, originalMsg);
        logger.info(`🏓 Ping response sent to ${chatId}`);
    } catch (error) {
        logger.error(`Error handling ping command: ${error.message}`);
    }
}

export async function handlePosted(sock, chatId, { database, originalMsg }) {
    try {
        const stats = await database.getPostedStats(chatId);

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '📊 *COURSE STATISTICS* 📊\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += `📚 *Total Courses Posted:* ${stats.total}\n\n`;
        r += `📅 *Today:* ${stats.today} courses\n`;
        r += `📆 *This Week:* ${stats.thisWeek} courses\n`;
        r += `📈 *This Month:* ${stats.thisMonth} courses\n\n`;
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '✨ Keep learning and growing! ✨\n\n';
        r += '💡 Stats shown for this group only\n';
        r += '_⏰ Auto-deletes in 5 hours_';

        await sendAndDelete(sock, chatId, { text: r }, originalMsg);
        logger.info(`📊 Stats sent to ${chatId}`);
    } catch (error) {
        logger.error(`Error sending stats: ${error.message}`);
    }
}

export async function handleClear(sock, chatId, { database, pendingClearConfirmations, originalMsg }) {
    try {
        const totalCourses = await database.getTotalPosted(chatId);

        if (totalCourses === 0) {
            await safeSendMessage(sock, chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📭 *DATABASE EMPTY* 📭\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'There are no courses in the database for this group.',
            }, originalMsg);
            return;
        }

        pendingClearConfirmations.set(chatId, Date.now());
        setTimeout(() => {
            if (pendingClearConfirmations.has(chatId)) {
                pendingClearConfirmations.delete(chatId);
            }
        }, 30000);

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '⚠️ *CONFIRMATION REQUIRED* ⚠️\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += `You are about to delete *${totalCourses}* course(s) from THIS GROUP.\n\n`;
        r += '⚠️ *This action cannot be undone!*\n\n';
        r += 'To confirm, reply with:\n';
        r += '• `/confirm` - Delete courses for this group\n';
        r += '• `/cancel` - Cancel operation\n\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += "⏱️ This confirmation expires in 30 seconds\n";
        r += "💡 Only this group's data will be cleared";

        await safeSendMessage(sock, chatId, { text: r }, originalMsg);
        logger.info(`⚠️ Clear confirmation requested for ${chatId} (${totalCourses} courses)`);
    } catch (error) {
        logger.error(`Error handling clear command: ${error.message}`);
    }
}

export async function handleConfirm(sock, chatId, { database, pendingClearConfirmations, originalMsg }) {
    try {
        if (!pendingClearConfirmations.has(chatId)) {
            await safeSendMessage(sock, chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n❌ *NO PENDING CONFIRMATION* ❌\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'There is no pending clear operation.\n\nUse `/clear` first to initiate deletion.',
            }, originalMsg);
            return;
        }

        pendingClearConfirmations.delete(chatId);
        const deletedCount = await database.clearAllPosted(chatId);

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '✅ *DATABASE CLEARED* ✅\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += `🗑️ Successfully deleted *${deletedCount}* course(s) from this group\n\n`;
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '💡 These courses will be posted again on next check!\n';
        r += '💡 Other groups are not affected';

        await safeSendMessage(sock, chatId, { text: r }, originalMsg);
        logger.info(`🗑️ Database cleared for group ${chatId}: ${deletedCount} courses deleted`);
    } catch (error) {
        logger.error(`Error confirming clear: ${error.message}`);
    }
}

export async function handleCancel(sock, chatId, senderJid, { pendingClearConfirmations, pendingGithubPosts, originalMsg }) {
    try {
        if (pendingGithubPosts && senderJid) {
            const githubKey = `${chatId}:${senderJid}`;
            if (pendingGithubPosts.has(githubKey)) {
                pendingGithubPosts.delete(githubKey);
                await safeSendMessage(sock, chatId, {
                    text: '❌ GitHub post cancelled.',
                }, originalMsg);
                return;
            }
        }

        if (!pendingClearConfirmations.has(chatId)) {
            await safeSendMessage(sock, chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\nℹ️ *NO PENDING OPERATION* ℹ️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'There is nothing to cancel.',
            }, originalMsg);
            return;
        }

        pendingClearConfirmations.delete(chatId);

        await safeSendMessage(sock, chatId, {
            text:
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n✅ *OPERATION CANCELLED* ✅\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                'Clear operation has been cancelled.\nNo courses were deleted.',
        }, originalMsg);
        logger.info(`❌ Clear operation cancelled by ${chatId}`);
    } catch (error) {
        logger.error(`Error cancelling clear: ${error.message}`);
    }
}

export async function handlePause(sock, chatId, { botState, botSettings, courseAPI, originalMsg }) {
    try {
        if (botState.isPaused) {
            await safeSendMessage(sock, chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\nℹ️ *ALREADY PAUSED* ℹ️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'Course posting is already paused.\nUse `/resumecourses` to continue.',
            }, originalMsg);
            return;
        }

        botState.isPaused = true;

        let snapshotIds = [];
        if (courseAPI) {
            try {
                const pending = await courseAPI.fetchNewCourses();
                snapshotIds = pending.map((c) => String(c.id)).filter(Boolean);
            } catch (err) {
                logger.warn(`Could not snapshot courses on pause: ${err.message}`);
            }
        }
        botState.coursePauseSnapshotIds = snapshotIds;

        if (botSettings) {
            await botSettings.setCoursesPaused(true);
            if (snapshotIds.length) {
                await botSettings.setCoursesPauseSnapshot(snapshotIds);
            }
        }

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '⏸️ *COURSES PAUSED* ⏸️\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += '🛑 Automatic *course* posting has been paused globally.\n\n';
        r += '📰 *Tech news* will continue in news-enabled groups.\n';
        r += '🎓 Per-group: `/coursesoff` still applies when you resume.\n';
        r += '💬 Commands still work normally.\n\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '💡 Use `/resumecourses` to resume — backlog won\'t flood all groups';

        await safeSendMessage(sock, chatId, { text: r }, originalMsg);
        logger.info(`⏸️ Course posting paused by ${chatId} (snapshot ${snapshotIds.length} ids)`);
    } catch (error) {
        logger.error(`Error pausing bot: ${error.message}`);
    }
}

export async function handleResume(sock, chatId, { botState, botSettings, originalMsg }) {
    try {
        if (!botState.isPaused) {
            await safeSendMessage(sock, chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\nℹ️ *ALREADY RUNNING* ℹ️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'Course posting is already active.\nUse `/pause` to stop courses only.',
            }, originalMsg);
            return;
        }

        botState.isPaused = false;
        botState.skipCourseBacklogOnce = true;

        if (botSettings) {
            await botSettings.setCoursesPaused(false);
            if (!botState.coursePauseSnapshotIds?.length) {
                botState.coursePauseSnapshotIds = await botSettings.getCoursesPauseSnapshot();
            }
        }

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '▶️ *COURSES RESUMED* ▶️\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += '✅ Automatic *course* posting is active again.\n\n';
        r += '🎓 Posts only to groups with courses ON (`/courson`).\n';
        r += '📰 Tech news continues on its normal schedule.\n';
        r += '⏭️ Courses queued during pause will *not* flood on resume.\n\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '💡 Use `/coursesoff` in a group to stop courses there only';

        await safeSendMessage(sock, chatId, { text: r }, originalMsg);
        logger.info(`▶️ Course posting resumed by ${chatId} (backlog skip enabled)`);
    } catch (error) {
        logger.error(`Error resuming bot: ${error.message}`);
    }
}

export async function handleStatus(sock, chatId, { database, botState, originalMsg }) {
    try {
        const stats = await database.getPostedStats();
        const lastCheck = botState.lastCheckTime
            ? new Date(botState.lastCheckTime).toLocaleString()
            : 'Never';
        const courseStatus = botState.isPaused ? '⏸️ PAUSED' : '▶️ RUNNING';
        const newsStatus = '📰 ON SCHEDULE';

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '🤖 *BOT STATUS* 🤖\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += `📚 *Courses:* ${courseStatus}\n`;
        r += `📰 *Tech news:* ${newsStatus}\n`;
        r += `⏰ *Last course check:* ${lastCheck}\n`;
        r += `📊 *Total posted:* ${stats.total} courses\n`;
        r += `📅 *Today:* ${stats.today} courses\n\n`;
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += botState.isPaused
            ? '💡 Use `/resumecourses` to resume course posting'
            : '💡 Use `/pause` to pause courses only';
        r += '\n_⏰ Auto-deletes in 5 hours_';

        await sendAndDelete(sock, chatId, { text: r }, originalMsg);
        logger.info(`📊 Status sent to ${chatId}`);
    } catch (error) {
        logger.error(`Error sending status: ${error.message}`);
    }
}

export async function handleFacts(sock, chatId, { originalMsg }) {
    try {
        const { data } = await axios.get('https://uselessfacts.jsph.pl/random.json?language=en', {
            timeout: 15000,
        });
        const fact = data?.text?.trim() || 'No fact returned.';

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '🎭 *✨ Random fact ✨* 🎭\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += `📌 ${fact}\n\n`;
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '_Did you know? Drop another `/facts` for more!_ 🧠✨\n';
        r += '_⏰ Auto-deletes in 5 hours_';

        await sendAndDelete(sock, chatId, { text: r }, originalMsg);
        logger.info(`🎭 Fact sent to ${chatId}`);
    } catch (error) {
        logger.error(`Error fetching fact: ${error.message}`);
        await safeSendMessage(
            sock,
            chatId,
            {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n😅 *Oops!* Could not fetch a fact right now.\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nTry again in a moment.',
            },
            originalMsg,
        );
    }
}

export async function handleHelp(sock, chatId, senderJid, { groupManager, isOwnerFromJid, originalMsg }) {
    try {
        const isGroup = chatId?.endsWith('@g.us');
        const inDirectMessage = isDirectMessage(chatId);
        const [isStaff, isPrivileged, canManageAdmins] = await Promise.all([
            groupManager.isStaffAsync(sock, chatId, senderJid),
            groupManager.isPrivilegedAsync(sock, chatId, senderJid),
            groupManager.canManageBotAdminsAsync(senderJid),
        ]);
        const canSetWelcome = isPrivileged || canManageAdmins;
        const isOwner = await isOwnerFromJid(sock, chatId, senderJid);

        let features = {};
        let movieOnly = false;
        if (isGroup) {
            const [coursesActive, movieEnabled, trendingEnabled] = await Promise.all([
                groupManager.isGroupActive(chatId),
                groupManager.isMovieEnabled(chatId),
                groupManager.isWeeklyTrendingEnabled(chatId),
            ]);
            features = {
                courses: coursesActive,
                movie: movieEnabled,
                trending: trendingEnabled,
            };
            movieOnly = movieEnabled && !coursesActive;
        }

        let response = formatHelpText({
            isStaff,
            isPrivileged,
            canManageAdmins,
            canSetWelcome,
            isOwner,
            movieOnly,
            isDirectMessage: inDirectMessage,
            features,
        });
        response += '\n\n_⏰ Auto-deletes in 5 hours_';
        await sendAndDelete(sock, chatId, { text: response }, originalMsg);
        logger.info(`📖 Help sent to ${chatId}`);
    } catch (error) {
        logger.error(`Error sending help: ${error.message}`);
    }
}
