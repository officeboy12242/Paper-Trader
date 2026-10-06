/**
 * Course Controller
 * Handles course posting logic
 */

import { logger } from '../utils/logger.js';
import { formatCourseMessage } from '../utils/messageFormatter.js';
import { botTelemetry } from '../utils/botTelemetry.js';

class CourseController {
    constructor(database, courseAPI, config, groupManager, botSettings = null) {
        this.database = database;
        this.courseAPI = courseAPI;
        this.config = config;
        this.groupManager = groupManager;
        this.botSettings = botSettings;
    }

    async postCourseToGroup(sock, course, groupId) {
        const cid = course.id;
        const name = course.name || '';
        const url = course.url || '';
        const image = course.image || '';
        const text = formatCourseMessage(course);

        // Create buttons with links
        const buttons = [
            {
                name: 'cta_url',
                buttonParamsJson: JSON.stringify({
                    display_text: '🎓 ENROLL NOW - FREE!',
                    url: url,
                    merchant_url: url
                })
            },
            {
                name: 'cta_url',
                buttonParamsJson: JSON.stringify({
                    display_text: '📚 Join Free Courses Group',
                    url: 'https://chat.whatsapp.com/YOUR_GROUP_INVITE_LINK',
                    merchant_url: 'https://chat.whatsapp.com/YOUR_GROUP_INVITE_LINK'
                })
            }
        ];

        try {
            if (image) {
                // Send with image and buttons
                await sock.sendMessage(groupId, {
                    image: { url: image },
                    caption: text,
                    footer: '💡 Tap buttons below to take action',
                    buttons: buttons,
                    headerType: 4
                });
            } else {
                // Send text with buttons
                await sock.sendMessage(groupId, {
                    text: text,
                    footer: '💡 Tap buttons below to take action',
                    buttons: buttons,
                    headerType: 1
                });
            }

            logger.info(`✅ Posted to ${groupId}: [${cid}] ${name.substring(0, 50)}`);
            return true;
        } catch (error) {
            logger.error(`❌ Error posting to ${groupId} [${cid}]: ${error.message}`);
            
            // Fallback: send without buttons if button sending fails
            try {
                logger.info(`⚠️ Retrying without buttons for ${groupId}...`);
                if (image) {
                    await sock.sendMessage(groupId, {
                        image: { url: image },
                        caption: text,
                    });
                } else {
                    await sock.sendMessage(groupId, {
                        text: text,
                    });
                }
                logger.info(`✅ Posted (without buttons) to ${groupId}: [${cid}]`);
                return true;
            } catch (fallbackError) {
                logger.error(`❌ Fallback failed for ${groupId} [${cid}]: ${fallbackError.message}`);
                return false;
            }
        }
    }

    async postCourse(sock, course) {
        try {
            if (!sock) {
                logger.error('❌ WhatsApp socket not available');
                return;
            }

            // Groups with courses explicitly enabled (/activate, not /coursesoff)
            const activeGroups = await this.groupManager.getCourseEnabledGroups();

            if (activeGroups.length === 0) {
                logger.warn('⚠️ No course-enabled groups. Use /activate in a group (and avoid /coursesoff).');
                return;
            }

            const cid = course.id;
            const name = course.name || '';
            const url = course.url || '';

            logger.info(`📤 Checking course [${cid}] for ${activeGroups.length} group(s)...`);

            let successCount = 0;
            for (const group of activeGroups) {
                try {
                    // Check if already posted to this specific group
                    if (await this.database.isPosted(cid, group.group_id)) {
                        logger.info(`⏭️  Already posted to ${group.group_name}`);
                        continue;
                    }

                    const success = await this.postCourseToGroup(sock, course, group.group_id);
                    if (success) {
                        // Mark as posted for this specific group
                        await this.database.markPosted(cid, group.group_id, name, url);
                        successCount++;
                        botTelemetry.track('post', {
                            kind: 'course',
                            title: String(name).slice(0, 100),
                            chatId: group.group_id,
                        });
                    }
                    // Small delay between group posts
                    await new Promise(resolve => setTimeout(resolve, 1000));
                } catch (error) {
                    logger.error(`Error posting to group ${group.group_name}: ${error.message}`);
                }
            }

            if (successCount > 0) {
                logger.info(`✅ Course posted to ${successCount} new group(s)`);
            } else {
                logger.info(`ℹ️  Course already posted to all active groups`);
            }
        } catch (error) {
            logger.error(`Error in postCourse: ${error.message}`);
            throw error;
        }
    }

    async checkAndPostCourses(sock, botState) {
        if (!sock) {
            logger.info('⏳ Waiting for WhatsApp connection...');
            return;
        }

        // Check if bot is paused
        if (botState.isPaused) {
            logger.info('⏸️ Courses paused. Skipping course check.');
            return;
        }

        logger.info('─── 🔍 Checking for new courses ───');
        botState.lastCheckTime = Date.now();

        let newCourses = await this.courseAPI.fetchNewCourses();

        if (botState.skipCourseBacklogOnce) {
            const snapshot = botState.coursePauseSnapshotIds?.length
                ? botState.coursePauseSnapshotIds
                : (this.botSettings ? await this.botSettings.getCoursesPauseSnapshot() : []);
            const snapSet = new Set(snapshot.map(String));
            const before = newCourses.length;
            newCourses = newCourses.filter((c) => !snapSet.has(String(c.id)));
            botState.skipCourseBacklogOnce = false;
            botState.coursePauseSnapshotIds = null;
            if (this.botSettings) {
                await this.botSettings.clearCoursesPauseSnapshot();
            }
            logger.info(`▶️ Resume: skipped ${before - newCourses.length} backlog course(s); only new ones will post`);
        }

        if (newCourses.length > 0) {
            logger.info(`📬 ${newCourses.length} new course(s) to post.`);
            for (const course of newCourses) {
                await this.postCourse(sock, course);
                await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second gap
            }
        } else {
            logger.info('💤 No new courses.');
        }

        logger.info(`⏱  Sleeping ${this.config.CHECK_INTERVAL}s until next check.\n`);
    }
}

export default CourseController;
