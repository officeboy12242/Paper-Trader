/**
 * Admin handlers: addadmin, removeadmin, admins, increaselimit, checklimit
 */

import { logger } from '../../utils/logger.js';
import { extractPhoneNumber } from '../../utils/permissions.js';
import { resolveTargetPhone, getQuotedParticipantJid } from '../../utils/waMessage.js';

export async function handleAddAdmin(sock, chatId, senderJid, args, waMessage, { groupManager }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        const phoneNumber = await resolveTargetPhone(sock, chatId, args, waMessage, senderJid);

        if (!phoneNumber) {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n❌ *INVALID FORMAT* ❌\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    '*Usage:*\n• `/addadmin 919876543210`\n• Reply to a message: `/addadmin`\n• Tag someone: `/addadmin @user`',
            });
            return;
        }

        const result = await groupManager.addAdmin(phoneNumber);
        if (!result.ok) {
            const messages = {
                owner: 'That user is an owner (.env) and cannot be added as a bot admin.',
                moderator: 'That user is a moderator (.env) and cannot be added as a bot admin.',
                invalid: 'Could not read a valid phone number for that user.',
            };
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\nℹ️ *NOT ADDED* ℹ️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    (messages[result.reason] || 'Could not add that user as bot admin.'),
            });
            return;
        }

        if (result.reason === 'already') {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\nℹ️ *ALREADY BOT ADMIN* ℹ️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    `📱 *Phone:* ${result.phone_number}\n\nThis user is already a bot admin.`,
            });
            return;
        }

        await sock.sendMessage(chatId, {
            text:
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n✅ *ADMIN ADDED* ✅\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                `📱 *Phone:* ${result.phone_number}\n\nThis user can now manage bot admins, groups, and settings.`,
        });
        logger.info(`➕ Admin added: ${result.phone_number} by ${senderPhone}`);
    } catch (error) {
        logger.error(`Error adding admin: ${error.message}`);
    }
}

export async function handleRemoveAdmin(sock, chatId, senderJid, args, waMessage, { groupManager }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        const phoneNumber = await resolveTargetPhone(sock, chatId, args, waMessage, senderJid);

        if (!phoneNumber) {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n❌ *INVALID FORMAT* ❌\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    '*Usage:*\n• `/removeadmin 919876543210`\n• Reply to a message: `/removeadmin`\n• Tag someone: `/removeadmin @user`',
            });
            return;
        }

        const result = await groupManager.removeAdmin(phoneNumber);

        if (result.ok) {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n✅ *ADMIN REMOVED* ✅\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    `📱 *Phone:* ${result.phone_number}\n\nThis user is no longer a bot admin.\nUse \`/addadmin\` to make them admin again.`,
            });
            logger.info(`➖ Admin removed: ${result.phone_number} by ${senderPhone}`);
            return;
        }

        const removeMessages = {
            owner: 'Owners (.env) cannot be removed as bot admins.',
            moderator: 'Moderators (.env) cannot be removed as bot admins.',
            not_found: 'That user is not a bot admin.',
            invalid: 'Could not read a valid phone number for that user.',
        };
        await sock.sendMessage(chatId, {
            text:
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━\nℹ️ *NOT REMOVED* ℹ️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                (removeMessages[result.reason] || 'Could not remove that bot admin.'),
        });
    } catch (error) {
        logger.error(`Error removing admin: ${error.message}`);
    }
}

export async function handleAdmins(sock, chatId, senderJid, { groupManager }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);

        const [admins, waGroupAdmins] = await Promise.all([
            groupManager.getAllAdmins(),
            groupManager.fetchAllWhatsAppGroupAdmins(sock),
        ]);

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '👥 *BOT STAFF* 👥\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += `📊 *Total:* ${admins.length}\n\n`;

        if (!admins.length) {
            r += '📭 No staff configured yet.\n\n';
        } else {
            admins.forEach((admin, index) => {
                const role = admin.role || 'Bot admin';
                const addedDate =
                    admin.added_at === 'Owner' || admin.added_at === 'Moderator (.env)'
                        ? admin.added_at
                        : new Date(admin.added_at).toLocaleDateString();
                r += `${index + 1}. ${admin.phone_number}\n`;
                r += `   🏷️ ${role}\n`;
                r += `   📅 ${addedDate}\n\n`;
            });
        }

        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += `📱 *WHATSAPP GROUP ADMINS* (${waGroupAdmins.length})\n`;
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

        if (!waGroupAdmins.length) {
            r += '📭 No group admins found (or bot not in groups).\n\n';
        } else {
            waGroupAdmins.slice(0, 40).forEach((admin, index) => {
                const groupList = admin.groups.slice(0, 3).join(', ');
                const more = admin.groups.length > 3 ? ` +${admin.groups.length - 3} more` : '';
                r += `${index + 1}. ${admin.phone_number}\n`;
                r += `   🏷️ ${admin.role}\n`;
                r += `   👥 ${groupList}${more}\n\n`;
            });
            if (waGroupAdmins.length > 40) {
                r += `_…and ${waGroupAdmins.length - 40} more._\n\n`;
            }
        }

        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '💡 Owners/moderators: `.env` · Bot admins: `/addadmin` `/removeadmin`';

        await sock.sendMessage(chatId, { text: r });
        logger.info(`👥 Staff list sent to ${senderPhone}`);
    } catch (error) {
        logger.error(`Error sending admin list: ${error.message}`);
    }
}

export async function handleIncreaseLimit(sock, chatId, senderJid, args, waMessage, { movieController, userManager }) {
    try {
        if (!movieController) {
            await sock.sendMessage(chatId, { text: '⚠️ Movie controller not available.' });
            return;
        }

        const amount = parseInt(args[0], 10);
        if (!amount || amount < 1 || amount > 100) {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                    '❌ *INVALID FORMAT* ❌\n' +
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    '*Usage:*\n' +
                    '• Reply: `/increaselimit 5`\n' +
                    '• With days: `/increaselimit 5 3d`\n' +
                    '• Tag: `/increaselimit 5 @user`\n' +
                    '• Phone: `/increaselimit 5 919876543210`\n\n' +
                    '💡 _Amount: 1-100 | Days: 1-30 (default: 1)_',
            });
            return;
        }

        // Parse days parameter (e.g., "3d", "7d")
        let days = 1;
        let remainingArgs = args.slice(1);
        
        if (remainingArgs.length > 0) {
            const dayMatch = remainingArgs[0].match(/^(\d+)d$/i);
            if (dayMatch) {
                days = Math.max(1, Math.min(30, parseInt(dayMatch[1], 10)));
                remainingArgs = remainingArgs.slice(1);
            }
        }

        const targetPhone = await resolveTargetPhone(sock, chatId, remainingArgs, waMessage, senderJid);

        if (!targetPhone) {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                    '❌ *USER NOT FOUND* ❌\n' +
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'Reply to a message or provide @mention/phone number.',
            });
            return;
        }

        // Get target user's name from stored user data
        let targetName = targetPhone;
        
        if (userManager) {
            try {
                // Get the quoted JID to look up user by their actual JID
                const quotedJid = getQuotedParticipantJid(waMessage);
                
                // Try multiple possible JIDs (LID and standard formats)
                const possibleJids = [];
                if (quotedJid) {
                    possibleJids.push(quotedJid);
                }
                // Also try constructing JIDs from phone number
                possibleJids.push(`${targetPhone}@s.whatsapp.net`);
                possibleJids.push(`${targetPhone}@lid`);
                
                // Try to find stored username for any of these JIDs
                const storedName = await userManager.resolveUserName(possibleJids);
                if (storedName) {
                    targetName = storedName;
                    logger.info(`✓ Retrieved stored name for ${targetPhone}: ${storedName}`);
                }
            } catch (err) {
                logger.warn(`Failed to get stored user name: ${err.message}`);
            }
        }

        const result = await movieController.adjustSearchCount(targetPhone, amount, days);
        const senderPhone = extractPhoneNumber(senderJid);

        const duration = days === 1 ? '_Resets at midnight IST_' : `_Valid for ${days} day(s)_`;

        await sock.sendMessage(chatId, {
            text:
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                '✅ *LIMIT INCREASED* ✅\n' +
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                `👤 *User:* ${targetName}\n` +
                `📱 ${targetPhone}\n` +
                `➕ *Added:* ${amount} search(es)\n` +
                `📅 *Duration:* ${days} day(s)\n\n` +
                `📊 *Before:* ${result.previousRemaining}/5 remaining\n` +
                `📊 *After:* ${result.newRemaining}/5 remaining\n\n` +
                duration,
        }, { quoted: waMessage || undefined });

        logger.info(`🎬 Limit increased: ${targetPhone} +${amount} for ${days}d by ${senderPhone}`);
    } catch (error) {
        logger.error(`Error increasing limit: ${error.message}`);
        await sock.sendMessage(chatId, { text: '⚠️ Failed to increase limit. Try again.' });
    }
}

export async function handleCheckLimit(sock, chatId, senderJid, args, waMessage, pushName = '', { movieController, groupManager, userManager }) {
    try {
        if (!movieController) {
            await sock.sendMessage(chatId, { text: '⚠️ Movie controller not available.' });
            return;
        }

        const senderPhone = extractPhoneNumber(senderJid);
        const isAdmin = await groupManager.isPrivilegedAsync(sock, chatId, senderJid);

        // Try to get target user (admins can check others, users check self)
        let targetPhone = senderPhone;
        let targetName = pushName || 'You';
        let checkingSelf = true;
        let targetJid = senderJid;

        // If admin and has args/mentions/reply, check that user
        if (isAdmin && (args.length > 0 || waMessage)) {
            const resolvedPhone = await resolveTargetPhone(sock, chatId, args, waMessage, senderJid);
            if (resolvedPhone && resolvedPhone !== senderPhone) {
                targetPhone = resolvedPhone;
                checkingSelf = false;

                // Get target user's name from stored user data
                if (userManager) {
                    try {
                        // Get the quoted JID to look up user by their actual JID
                        const quotedJid = getQuotedParticipantJid(waMessage);
                        
                        // Try multiple possible JIDs (LID and standard formats)
                        const possibleJids = [];
                        if (quotedJid) {
                            possibleJids.push(quotedJid);
                            targetJid = quotedJid;
                        }
                        // Also try constructing JIDs from phone number
                        possibleJids.push(`${targetPhone}@s.whatsapp.net`);
                        possibleJids.push(`${targetPhone}@lid`);
                        
                        // Try to find stored username for any of these JIDs
                        const storedName = await userManager.resolveUserName(possibleJids);
                        if (storedName) {
                            targetName = storedName;
                            logger.info(`✓ Retrieved stored name for ${targetPhone}: ${storedName}`);
                        } else {
                            targetName = targetPhone;
                        }
                    } catch (err) {
                        logger.warn(`Failed to get stored user name: ${err.message}`);
                        targetName = targetPhone;
                    }
                } else {
                    targetName = targetPhone;
                }
            }
        }

        // Get limit info
        const isUnlimited = await movieController.isUnlimitedUser(targetPhone);
        const used = isUnlimited ? 0 : await movieController.getUserSearchCount(targetPhone);
        const remaining = Math.max(0, 5 - used);

        // Get added limits (future dates with negative counts)
        let addedLimitDetails = [];
        if (!isUnlimited) {
            try {
                const today = new Date().toISOString().split('T')[0];
                const limits = await movieController.searchLimits.find({ user_id: targetPhone }).toArray();
                
                // Get all future dates with bonus searches
                for (let i = 1; i <= 30; i++) {
                    const futureDate = new Date(today + 'T00:00:00+05:30');
                    futureDate.setDate(futureDate.getDate() + i);
                    const futureDateStr = futureDate.toISOString().split('T')[0];
                    
                    const limitEntry = limits.find(l => l.date === futureDateStr);
                    if (limitEntry && limitEntry.count < 0) {
                        const bonus = -limitEntry.count;
                        const daysRemaining = i;
                        addedLimitDetails.push({
                            date: futureDateStr,
                            bonus,
                            daysRemaining
                        });
                    }
                }
            } catch (err) {
                logger.warn(`Failed to get added limits: ${err.message}`);
            }
        }

        let statusIcon = '✅';
        let statusText = 'Active';
        if (!isUnlimited && used >= 5) {
            statusIcon = '⛔';
            statusText = 'Limit Reached';
        } else if (!isUnlimited && remaining <= 2) {
            statusIcon = '⚠️';
            statusText = 'Running Low';
        }

        let text = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        text += `${statusIcon} *MOVIE SEARCH LIMIT* ${statusIcon}\n`;
        text += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

        // Use actual targetJid for mentions (handles LID users correctly)
        const mentionJid = targetJid || `${targetPhone}@s.whatsapp.net`;
        if (!checkingSelf && isAdmin) {
            text += `📍 *${targetName}*\n`;
        } else if (checkingSelf) {
            const selfName = targetName !== 'You' ? `*${targetName}*` : 'you';
            text += `👋 Hey ${selfName}!\n`;
        }

        if (!checkingSelf) {
            text += `👤 *User:* ${targetName}\n`;
            text += `📱 ${targetPhone}\n\n`;
        }

        if (isUnlimited) {
            text += '⭐ *Status:* Unlimited Access\n';
            text += '🎬 *Type:* Premium/Staff\n\n';
            text += '💡 _No daily limits apply_';
        } else {
            text += `📊 *Status:* ${statusText}\n`;
            text += `🔍 *Daily Limit:* 5 searches\n`;
            text += `📋 *Used Today:* ${used}/5\n`;
            text += `✨ *Remaining Today:* ${remaining}/5\n\n`;

            // Show added limits if any — show total bonus/day and how many days are left
            if (addedLimitDetails.length > 0) {
                const bonusPerDay = addedLimitDetails[0].bonus;
                const daysLeft = addedLimitDetails.length;
                text += `🎁 *Bonus Searches:* +${bonusPerDay}/day · ${daysLeft} day(s) remaining\n\n`;
            }

            text += '⏰ _Resets daily at 12:00 AM IST_\n';
            text += '⭐ _Upgrade to Premium for unlimited_';
        }

        text += '\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━';

        // Send with mention and quote user's command message
        await sock.sendMessage(chatId, { text, mentions: [mentionJid] }, { quoted: waMessage || undefined });

        // If admin checked another user, also send DM to that user
        if (!checkingSelf && isAdmin && targetJid !== senderJid) {
            try {
                let dmText = '📊 *Your Movie Search Limit*\n\n';
                if (isUnlimited) {
                    dmText += '⭐ You have unlimited searches!';
                } else {
                    dmText += `🔍 Daily Limit: 5 searches\n`;
                    dmText += `📋 Used Today: ${used}/5\n`;
                    dmText += `✨ Remaining: ${remaining}/5\n\n`;
                    
                    if (addedLimitDetails.length > 0) {
                        const bonusPerDay = addedLimitDetails[0].bonus;
                        const daysLeft = addedLimitDetails.length;
                        dmText += `🎁 Bonus: +${bonusPerDay}/day · ${daysLeft} day(s) remaining\n`;
                    }
                }
                
                await sock.sendMessage(`${targetPhone}@s.whatsapp.net`, { text: dmText });
            } catch (err) {
                logger.warn(`Failed to send DM limit info: ${err.message}`);
            }
        }

        logger.info(`🎬 Limit checked: ${targetPhone} by ${senderPhone}`);
    } catch (error) {
        logger.error(`Error checking limit: ${error.message}`);
        await sock.sendMessage(chatId, { text: '⚠️ Failed to check limit. Try again.' });
    }
}
