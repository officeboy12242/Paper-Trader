/**
 * Log Manager Service
 * Handles automatic log cleanup and sending
 */

import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';

class LogManager {
    constructor(logFilePath, adminNumber, checkInterval = 14400000 , deleteAfter = 14400000) { // Check every 10s, delete after 30s
        this.logFilePath = logFilePath;
        this.adminNumber = adminNumber; // WhatsApp number to send logs to
        this.checkInterval = checkInterval;
        this.deleteAfter = deleteAfter; // Time before deleting logs
        this.intervalId = null;
        this.sock = null;
        this.logStartTime = Date.now(); // Track when logging started
    }

    setSocket(sock) {
        this.sock = sock;
    }

    setAdminNumber(number) {
        this.adminNumber = number;
    }

    start() {
        logger.info(`📋 Log Manager started - checking every ${this.checkInterval/1000}s, deleting after ${this.deleteAfter/1000}s, reports go to ${this.adminNumber}`);
        
        // Send a one-time ping so the owner can verify delivery works now,
        // instead of discovering a broken channel 4 hours later.
        this.sendStartupPing();
        
        // Check immediately on start
        this.checkAndCleanLogs();
        
        // Then check periodically
        this.intervalId = setInterval(() => {
            this.checkAndCleanLogs();
        }, this.checkInterval);
    }

    async sendStartupPing() {
        try {
            if (!this.sock || !this.adminNumber) return;
            const adminJid = `${this.adminNumber}@s.whatsapp.net`;
            await this.sock.sendMessage(adminJid, {
                text: '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📋 *BOT ONLINE* — log reporting armed\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nBot log reports will be sent to this number every 4 hours.\nIf you are seeing this, the log channel works ✅'
            });
            logger.info(`✅ Startup ping sent to ${this.adminNumber}`);
        } catch (error) {
            logger.error(`⚠️ Could not send startup ping to ${this.adminNumber}: ${error.message}`);
        }
    }

    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
            logger.info('📋 Log Manager stopped');
        }
    }

    async checkAndCleanLogs() {
        try {
            // Check if log file exists
            if (!fs.existsSync(this.logFilePath)) {
                logger.info('📋 No log file found to clean');
                return;
            }

            // Check time since log manager started (not file modification time)
            const timeSinceStart = Date.now() - this.logStartTime;

            logger.info(`📋 Time since bot started: ${Math.floor(timeSinceStart / 1000)} seconds`);

            // If bot has been running for more than deleteAfter time
            if (timeSinceStart > this.deleteAfter) {
                logger.info(`🗑️ Bot running for over ${this.deleteAfter/1000}s, sending logs and resetting...`);
                
                // Send log file to admin; only delete + reset when it actually
                // went out, otherwise keep the file and retry next check.
                const sent = await this.sendLogToAdmin();
                if (!sent) {
                    logger.warn('⚠️ Log report was NOT sent — keeping log file and retrying next check');
                    return;
                }
                
                // Delete the log file
                fs.unlinkSync(this.logFilePath);
                logger.info('✅ Log file deleted successfully');
                
                // Reset the timer
                this.logStartTime = Date.now();
            } else {
                logger.info(`⏳ ${Math.floor((this.deleteAfter - timeSinceStart) / 1000)} seconds until log cleanup`);
            }
        } catch (error) {
            logger.error(`Error in log cleanup: ${error.message}`);
        }
    }

    async sendLogToAdmin() {
        try {
            if (!this.sock) {
                logger.warn('⚠️ WhatsApp socket not available, cannot send logs');
                return false;
            }
            if (!this.adminNumber) {
                logger.warn('⚠️ No log destination number configured');
                return false;
            }

            const stats = fs.statSync(this.logFilePath);
            const fileSizeKB = (stats.size / 1024).toFixed(2);

            let message = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            message += '📋 *BOT LOG REPORT* 📋\n';
            message += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
            message += `📅 *Date:* ${new Date().toLocaleString()}\n`;
            message += `💾 *File Size:* ${fileSizeKB} KB\n\n`;
            message += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            message += '📎 Log file attached below';

            const adminJid = `${this.adminNumber}@s.whatsapp.net`;
            await this.sock.sendMessage(adminJid, { text: message });

            const fileBuffer = fs.readFileSync(this.logFilePath);
            await this.sock.sendMessage(adminJid, {
                document: fileBuffer,
                fileName: `bot-log-${Date.now()}.log`,
                mimetype: 'text/plain',
                caption: '📋 Bot Log File'
            });

            logger.info(`✅ Log file sent to ${this.adminNumber}`);
            return true;
        } catch (error) {
            logger.error(`Error sending log to admin (${this.adminNumber}): ${error.message}`);
            return false;
        }
    }
}

export default LogManager;
