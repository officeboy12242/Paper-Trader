/**
 * WhatsApp Service
 * Handles WhatsApp connection and event management
 */

import makeWASocket, {
    DisconnectReason,
    fetchLatestBaileysVersion,
} from 'baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { logger } from '../utils/logger.js';
import { useDatabaseAuthState } from '../utils/databaseAuthState.js';
import { extractInstagramUrl } from '../utils/instagramUrl.js';
import {
    getMessageSenderJid,
    getTextForUrlScan,
    getTextFromWAMessage,
    safeSendMessage,
    resolveConversationChatId,
    setGroupMetaProvider,
    setGroupPhoneResolver,
} from '../utils/waMessage.js';
import { rememberLidPnFromMessageKey } from '../utils/lid.js';
import { resolveChannelSourceEntries } from '../utils/channelResolve.js';
import { extractStickerFromMessage, isNewsletterChat } from '../utils/stickerExtract.js';
import { isStickerForwardReady } from '../utils/stickerDownload.js';
import { groupMessageTracker } from '../utils/groupMessageTracker.js';
import { groupParticipantSnapshot } from '../utils/groupParticipantSnapshot.js';
import { restorePendingDeletes } from '../utils/autoDelete.js';
import { config } from '../config/config.js';
import { resolveNotificationJid, extractPhoneNumber, isBotSelfChat, getBotSelfSenderJid, isDirectMessage } from '../utils/permissions.js';
import {
    formatOwnerAboutReply,
    isBotDirectedOwnerQuestion,
    looksLikeOwnerAboutQuestion,
    messageMentionsBot,
} from '../utils/ownerProfile.js';
import os from 'os';


/** Non-group chats where auto Instagram download is allowed (includes @lid privacy chats). */
function shouldAutoDetectInstaLink(chatId) {
    if (!chatId || typeof chatId !== 'string') {
        return false;
    }
    if (chatId.endsWith('@g.us')) {
        return false;
    }
    if (chatId === 'status@broadcast' || chatId.endsWith('@broadcast')) {
        return false;
    }
    if (chatId.includes('newsletter')) {
        return false;
    }
    return true;
}

class WhatsAppService {
    constructor(
        commandController,
        stickerForwarder = null,
        authDatabase,
        groupManager = null,
        stickerSourceChannelEntries = [],
        channelStickerPoller = null,
        userManager = null,
        adminPanel = null,
        groupChatLogService = null,
        assistService = null
    ) {
        this.sock = null;
        this.isReady = false;
        this.commandController = commandController;
        this.stickerForwarder = stickerForwarder;
        this.authDatabase = authDatabase;
        this.groupManager = groupManager;
        // Fast path for big groups: all metadata lookups share one cache
        if (groupManager?.getGroupMetadataCached) {
            setGroupMetaProvider((sock, chatId) => groupManager.getGroupMetadataCached(sock, chatId));
        }
        if (groupManager?.resolveParticipantPhoneCached) {
            setGroupPhoneResolver((sock, chatId, jid) =>
                groupManager.resolveParticipantPhoneCached(sock, chatId, jid)
            );
        }
        this.stickerSourceChannelEntries = stickerSourceChannelEntries;
        this.channelStickerPoller = channelStickerPoller;
        this.userManager = userManager;
        this.adminPanel = adminPanel;
        this.groupChatLogService = groupChatLogService;
        this.assistService = assistService;
        this.interviewQuestionService = null;
        
        // Message deduplication to prevent double processing
        this._processedMessages = new Set();
        this._messageCleanupInterval = null;
        
        // Startup notification flag - only send once per session
        this._startupNotificationSent = false;

        // Prevent reconnect loops during shutdown / deploy handoff
        this._shuttingDown = false;
        this._reconnectTimeout = null;

        /** @type {Map<string, import('baileys').proto.IMessage>} */
        this._messageCache = new Map();
        this._messageCacheMax = 180;
        
        // Give admin panel access to auth database for clearing
        if (this.adminPanel && this.authDatabase) {
            this.adminPanel.setAuthDatabase(this.authDatabase);
        }
    }
    
    /**
     * Check if message was already processed (prevents duplicate execution)
     */
    _isMessageProcessed(messageId) {
        if (!messageId) return false;
        if (this._processedMessages.has(messageId)) {
            return true;
        }
        this._processedMessages.add(messageId);
        return false;
    }
    
    /**
     * Start cleanup interval to prevent memory leak from stored message IDs
     */
    _startMessageCleanup() {
        if (this._messageCleanupInterval) return;
        
        this._messageCleanupInterval = setInterval(() => {
            if (this._processedMessages.size > 1000) {
                const arr = [...this._processedMessages];
                this._processedMessages = new Set(arr.slice(-500));
                logger.debug(`Message dedup cache trimmed: ${arr.length} → ${this._processedMessages.size}`);
            }
        }, 5 * 60 * 1000);
    }
    
    /**
     * Send startup notification to log number (only once per session)
     */
    async _sendStartupNotification() {
        // Only send once per bot session
        if (this._startupNotificationSent) {
            return;
        }
        
        const notifyJid = resolveNotificationJid(this.sock, [
            config.BOT_LOG_NUMBER,
            ...config.OWNER_NUMBERS,
        ].filter(Boolean));
        if (!notifyJid) {
            logger.warn('Startup notification skipped — no notification target configured.');
            this._startupNotificationSent = false;
            return;
        }

        // Mark as sent immediately to prevent duplicates
        this._startupNotificationSent = true;

        try {
            const phoneNumber = this.sock?.user?.id?.split(':')[0] || 'Unknown';
            const now = new Date();
            const timeIST = now.toLocaleString('en-IN', { 
                timeZone: 'Asia/Kolkata',
                dateStyle: 'medium',
                timeStyle: 'medium'
            });
            
            // Get system info
            const memUsage = process.memoryUsage();
            const memMB = Math.round(memUsage.heapUsed / 1024 / 1024);
            const platform = `${os.platform()} ${os.arch()}`;
            const nodeVersion = process.version;
            
            const text = `╔════════════════════════════╗
║  🤖 *BOT STARTED*  ✅       ║
╚════════════════════════════╝

📱 *Phone:* ${phoneNumber}
🕐 *Time:* ${timeIST}
💻 *Platform:* ${platform}
📦 *Node:* ${nodeVersion}
🧠 *Memory:* ${memMB} MB

━━━━━━━━━━━━━━━━━━━━━━━━
✨ _Bot deployed & ready!_
🚀 _All systems operational_`;

            await this.sock.sendMessage(notifyJid, { text });
            logger.info(`📤 Startup notification sent to ${extractPhoneNumber(notifyJid)}`);
        } catch (err) {
            logger.warn(`Failed to send startup notification: ${err.message}`);
            // Reset flag on failure so it can retry next reconnection
            this._startupNotificationSent = false;
        }
    }

    async connect() {
        if (this._shuttingDown) {
            return null;
        }

        if (this._reconnectTimeout) {
            clearTimeout(this._reconnectTimeout);
            this._reconnectTimeout = null;
        }

        if (this.sock) {
            try {
                this.sock.ev.removeAllListeners();
                this.sock.end(undefined);
            } catch {}
            this.sock = null;
        }

        // Use database auth instead of file-based auth
        const { state, saveCreds } = await useDatabaseAuthState(this.authDatabase);
        const { version } = await fetchLatestBaileysVersion();

        const getMessage = async (key) => {
            if (!key?.remoteJid || !key?.id) return undefined;
            return this._messageCache.get(`${key.remoteJid}:${key.id}`);
        };

        this.sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            auth: {
                creds: state.creds,
                keys: state.keys,
            },
            generateHighQualityLinkPreview: false,
            getMessage,
            syncFullHistory: false,
            shouldSyncHistoryMessage: () => true,
            markOnlineOnConnect: true,
            emitOwnEvents: false,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            retryRequestDelayMs: 150,
            maxMsgRetryCount: 3,
            browser: ['Ubuntu', 'Chrome', '20.0.04'],
            fireInitQueries: true,
            patchMessageBeforeSending: (msg) => msg,
            /**
             * Without this, Baileys refetches the FULL participant list from
             * WhatsApp on every group send — see messages-send.js, which falls
             * back to `groupMetadata(jid)` when the cache returns undefined (the
             * library default is `async () => undefined`). In a 900-member group
             * that is a multi-second round-trip added to every single reply.
             * Reuse the cache we already maintain; returning undefined on any
             * failure lets Baileys fall back to its own fetch.
             */
            cachedGroupMetadata: async (jid) => {
                try {
                    if (!jid?.endsWith('@g.us')) return undefined;
                    if (!this.sock || !this.groupManager?.getGroupMetadataCached) return undefined;
                    return await this.groupManager.getGroupMetadataCached(this.sock, jid);
                } catch {
                    return undefined;
                }
            },
        });

        // Expose cache to media downloaders (/roast quoted PDFs, etc.)
        this.sock.__getCachedMessage = (key) => {
            if (!key?.remoteJid || !key?.id) return undefined;
            return this._messageCache.get(`${key.remoteJid}:${key.id}`);
        };

        this._wrapOutgoingMessageTracking();

        this.setupEventHandlers(saveCreds);
        
        return this.sock;
    }

    async disconnect() {
        this._shuttingDown = true;
        this.isReady = false;

        if (this._reconnectTimeout) {
            clearTimeout(this._reconnectTimeout);
            this._reconnectTimeout = null;
        }

        if (this._messageCleanupInterval) {
            clearInterval(this._messageCleanupInterval);
            this._messageCleanupInterval = null;
        }

        if (this.sock) {
            try {
                this.sock.ev.removeAllListeners();
                this.sock.end(undefined);
            } catch (err) {
                logger.warn(`WhatsApp disconnect: ${err.message}`);
            }
            this.sock = null;
        }

        logger.info('📴 WhatsApp connection closed');
    }

    _wrapOutgoingMessageTracking() {
        if (!this.sock?.sendMessage) {
            return;
        }

        const originalSendMessage = this.sock.sendMessage.bind(this.sock);
        this.sock.sendMessage = async (jid, content, options) => {
            const result = await originalSendMessage(jid, content, options);
            try {
                if (result?.key?.id && content && !content.delete) {
                    groupMessageTracker.trackOutgoingSend(jid, result, content);
                }
            } catch (err) {
                logger.debug(`Outgoing message track failed: ${err?.message || err}`);
            }
            return result;
        };
    }

    setupEventHandlers(saveCreds) {
        this.sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                logger.info('📱 Scan this QR code with WhatsApp:');
                qrcode.generate(qr, { small: true });
                
                // Update admin panel with QR code
                if (this.adminPanel) {
                    this.adminPanel.updateQR(qr, qr);
                }
            }

            if (connection === 'close') {
                this.isReady = false;
                
                // Update admin panel
                if (this.adminPanel) {
                    this.adminPanel.setDisconnected();
                }

                if (this._shuttingDown) {
                    logger.info('Connection closed during shutdown — not reconnecting');
                    return;
                }
                
                const statusCode = (lastDisconnect?.error instanceof Boom)
                    ? lastDisconnect.error.output.statusCode
                    : undefined;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                logger.info('Connection closed. Reconnecting: ' + shouldReconnect);

                if (shouldReconnect) {
                    if (this._reconnectTimeout) {
                        clearTimeout(this._reconnectTimeout);
                    }
                    this._reconnectTimeout = setTimeout(async () => {
                        this._reconnectTimeout = null;
                        if (this._shuttingDown) return;
                        try {
                            await this.connect();
                        } catch (error) {
                            logger.error('Reconnection error:', error.message);
                        }
                    }, 3000);
                }
            } else if (connection === 'open') {
                const me = this.sock?.user;
                logger.info(`✅ Connected to WhatsApp! me.id=${me?.id} me.lid=${me?.lid}`);
                this.isReady = true;
                this._startMessageCleanup();
                
                // Update admin panel with connected status
                if (this.adminPanel) {
                    const phoneNumber = this.sock?.user?.id?.split(':')[0] || 'Unknown';
                    this.adminPanel.setConnected(phoneNumber);
                }
                
                // Log available chats to help user find chat ID
                try {
                    const chats = await this.sock.groupFetchAllParticipating();
                    logger.info('\n📋 Available Groups:');
                    Object.values(chats).forEach((chat) => {
                        logger.info(`  - ${chat.subject}: ${chat.id}`);
                    });
                    await this.resolveStickerSourceChannels();

                    // One fetch warms meta cache + welcome snapshots — no N× groupMetadata
                    const warmed = this.groupManager?.warmMetaFromParticipating?.(chats) || 0;
                    const seeded = groupParticipantSnapshot.seedFromParticipating(chats);
                    if (warmed || seeded) {
                        logger.info(
                            `⚡ Big-group cache warm: ${warmed} meta, ${seeded} participant snapshot(s)`
                        );
                    }

                    // Re-arm auto-deletes that were pending across the restart,
                    // and clear any whose time passed while we were down.
                    void restorePendingDeletes().catch((err) =>
                        logger.warn(`Auto-delete restore failed: ${err.message}`)
                    );
                    // Send startup notification
                    await this._sendStartupNotification();
                } catch (err) {
                    logger.error('Error fetching groups:', err.message);
                }
            }
        });

        this.sock.ev.on('creds.update', () => {
            void saveCreds();
        });

        this.sock.ev.on('group-participants.update', (update) => {
            try {
                // Keep admin/meta caches fresh in large groups (promote/demote/join/leave)
                const gid = update?.id || update?.groupId;
                if (gid && this.groupManager?.invalidateGroupMeta) {
                    this.groupManager.invalidateGroupMeta(gid);
                }
                void this.commandController
                    .handleGroupParticipantsUpdate(this.sock, update)
                    .catch((err) => {
                        logger.error('Welcome message error:', err?.message || err);
                    });
            } catch (err) {
                // A synchronous throw here is NOT caught by the .catch() above
                // (it never gets that far) — without this, one malformed
                // update kills the process instead of just this one update.
                logger.error('group-participants.update handler error:', err?.message || err);
            }
        });

        this.sock.ev.on('messages.update', (updates) => {
            if (!this.stickerForwarder) return;

            for (const update of updates) {
                try {
                    const chatId = update.key?.remoteJid;
                    if (!chatId || !update.update?.message) continue;
                    const stickerPayload = extractStickerFromMessage(update.update.message);
                    if (!stickerPayload || !isStickerForwardReady(chatId, stickerPayload)) continue;
                    if (!this.stickerForwarder.shouldForwardFrom(chatId)) continue;

                    void this.stickerForwarder
                        .forwardSticker(
                            this.sock,
                            { key: update.key, message: update.update.message },
                            chatId,
                            { isRetry: true },
                        )
                        .catch(() => {});
                } catch (err) {
                    // One bad item in the batch must not abort the rest of it.
                    logger.error('messages.update item error:', err?.message || err);
                }
            }
        });

        this.sock.ev.on('messages.upsert', ({ messages, type }) => {
            for (const msg of messages) {
                try {
                    this._cacheIncomingMessage(msg);

                    // Interview Q poll votes often arrive as type=append — score them
                    // before the notify-only continue so leaderboard stays live.
                    if (this.interviewQuestionService) {
                        void this.interviewQuestionService
                            .handleIncomingPollVote(msg, this.sock)
                            .catch(() => {});
                    }

                    const chatId = msg.key?.remoteJid;

                    // Join stubs often arrive as type=append with no message body
                    if (chatId?.endsWith('@g.us') && msg.messageStubType != null) {
                        void this.commandController
                            .handleJoinStubMessage(this.sock, msg)
                            .catch((err) => {
                                logger.error('Join stub welcome error:', err?.message || err);
                            });
                    }

                    const stickerPayload = extractStickerFromMessage(msg.message);

                    if (type !== 'notify') {
                        if (
                            stickerPayload
                            && isStickerForwardReady(chatId, stickerPayload)
                            && this.stickerForwarder?.shouldForwardFrom(chatId)
                        ) {
                            void this.stickerForwarder
                                .forwardSticker(this.sock, msg, chatId, { isRetry: true })
                                .catch(() => {});
                        }
                        continue;
                    }

                    void this.processIncomingMessage(msg).catch((err) => {
                        logger.error('Message handling error:', err?.message || err);
                    });
                } catch (err) {
                    // One malformed message in the batch (unexpected shape, a
                    // future WhatsApp protocol field, whatever) must not stop
                    // the rest of the batch from being processed. A `.catch()`
                    // on an async call only covers rejections — it does nothing
                    // for a plain synchronous throw earlier in this same
                    // iteration, which is exactly what this guards.
                    logger.error('messages.upsert item error:', err?.message || err);
                }
            }
        });
    }

    _forwardChannelSticker(msg, chatId) {
        if (!this.stickerForwarder?.shouldForwardFrom(chatId)) return;
        void this.stickerForwarder
            .forwardSticker(this.sock, msg, chatId, { isRetry: true })
            .catch(() => {});
    }

    _cacheIncomingMessage(msg) {
        if (!msg?.message || !msg.key?.remoteJid || !msg.key?.id) return;
        groupMessageTracker.track(msg);
        if (this._messageCache.size >= this._messageCacheMax) {
            const oldest = this._messageCache.keys().next().value;
            if (oldest) this._messageCache.delete(oldest);
        }
        this._messageCache.set(`${msg.key.remoteJid}:${msg.key.id}`, msg.message);
    }

    async resolveStickerSourceChannels() {
        if (!this.stickerForwarder) {
            return;
        }

        const envEntries = this.stickerSourceChannelEntries;
        const dbChannels = this.groupManager ? await this.groupManager.getStickerChannelJids() : [];
        
        const allJids = new Set();
        const nameByJid = new Map();

        const { jids: envJids, resolved } = await resolveChannelSourceEntries(this.sock, envEntries);
        for (const row of resolved) {
            allJids.add(row.jid);
            nameByJid.set(row.jid, row.name);
        }

        for (const jid of dbChannels) {
            allJids.add(jid);
        }

        const jids = [...allJids];
        
        if (!jids.length) {
            logger.info('📢 No sticker channels configured (use /addchannel or .env)');
            if (this.channelStickerPoller && config.CHANNEL_STICKER_POLLER_ENABLED) {
                this.channelStickerPoller.setChannels([]);
                this.channelStickerPoller.start(this.sock);
            }
            return;
        }

        this.stickerForwarder.setSourceChannels(jids, nameByJid);

        for (const jid of jids) {
            if (typeof this.sock.subscribeNewsletterUpdates === 'function') {
                try {
                    await this.sock.subscribeNewsletterUpdates(jid);
                } catch {}
            }
        }
        
        logger.info(`📡 Channel sticker forwarding active (${jids.length} channel(s))`);

        if (this.channelStickerPoller && config.CHANNEL_STICKER_POLLER_ENABLED) {
            this.channelStickerPoller.setChannels(jids);
            this.channelStickerPoller.start(this.sock);
        } else if (!config.CHANNEL_STICKER_POLLER_ENABLED) {
            logger.info('Channel sticker poller disabled (CHANNEL_STICKER_POLLER_ENABLED=false)');
        }
    }

    async processIncomingMessage(msg) {
        const chatId = resolveConversationChatId(msg.key) || msg.key?.remoteJid;
        const messageId = msg.key?.id;
        if (!chatId || !messageId) {
            return;
        }

        // Skip broadcast and status messages
        if (chatId === 'status@broadcast' || chatId.endsWith('@broadcast')) {
            return;
        }

        // System/stub messages — join welcome handled in messages.upsert
        if (msg.messageStubType !== undefined && msg.messageStubType !== null) {
            return;
        }

        if (!msg?.message) {
            return;
        }

        const msgContent = msg.message;
        const messageTextPreview = getTextFromWAMessage(msgContent).trim();
        const textForUrlsPreview = getTextForUrlScan(msgContent).trim();
        const isCommandMessage = messageTextPreview.startsWith('/');

        const isChannel = isNewsletterChat(chatId);
        const stickerPayloadEarly = extractStickerFromMessage(msg.message);

        // Skip old messages — stickers are exempt (history sync / delayed decrypt)
        const messageTimestamp = msg.messageTimestamp;
        if (messageTimestamp && !isChannel && !stickerPayloadEarly) {
            const msgTime = typeof messageTimestamp === 'number' 
                ? messageTimestamp * 1000 
                : Number(messageTimestamp) * 1000;
            const now = Date.now();
            const age = now - msgTime;
            const maxAge = isCommandMessage && shouldAutoDetectInstaLink(chatId) ? 120000 : 60000;
            if (age > maxAge) {
                return;
            }
        }

        // Skip protocol/system messages that cause "Waiting for this message"
        const protocolOnlyTypes = [
            'protocolMessage',
            'senderKeyDistributionMessage', 
            'reactionMessage',
            'pollUpdateMessage',
            'pollCreationMessage',
            'encReactionMessage',
            'editedMessage',
            'keepInChatMessage',
            'ptvMessage',
        ];
        
        // Check if message only contains protocol data (no actual user content)
        const msgKeys = Object.keys(msgContent);
        const contentTypes = [
            'conversation', 'extendedTextMessage', 'imageMessage', 
            'videoMessage', 'audioMessage', 'documentMessage',
            'stickerMessage', 'contactMessage', 'locationMessage',
            'liveLocationMessage', 'templateMessage', 'buttonsMessage',
            'listMessage', 'viewOnceMessage', 'viewOnceMessageV2',
            'viewOnceMessageV2Extension',
            'ephemeralMessage', 'documentWithCaptionMessage',
        ];
        
        const hasActualContent = msgKeys.some(key => contentTypes.includes(key));
        const hasOnlyProtocol = msgKeys.every(key => 
            protocolOnlyTypes.includes(key) || key === 'messageContextInfo'
        );
        const hasExtractableText = Boolean(messageTextPreview || textForUrlsPreview);
        
        // Skip if no actual content and not a sticker — but never drop commands / URLs in wrappers
        if (!hasExtractableText && !hasActualContent && hasOnlyProtocol) {
            return;
        }

        const stickerPayload = stickerPayloadEarly;

        if (stickerPayload && this.stickerForwarder) {
            const allowChannelSticker = isChannel && this.stickerForwarder.shouldForwardFrom(chatId);
            const allowGroupSticker = !msg.key.fromMe && !isChannel;
            const mediaReady = isStickerForwardReady(chatId, stickerPayload);

            if (allowChannelSticker && mediaReady) {
                logger.info(`📡 Channel sticker received: ${chatId} (${messageId})`);
                void this.stickerForwarder
                    .forwardSticker(this.sock, msg, chatId)
                    .catch((err) => {
                        logger.error('Channel sticker forward error:', err?.message || err);
                    });
                return;
            }
            if (allowChannelSticker && !mediaReady) {
                // Do NOT drop it. Channel stickers routinely arrive before mediaKey
                // is attached, and returning here bypassed the whole recovery path:
                // _scheduleRetry is only reachable from inside the queue, so a
                // sticker that never queued was never retried. Groups rarely hit
                // this because their notify payload carries mediaKey, which is why
                // this looked like "channels skip, groups work".
                //
                // Queue it instead — the worker's download sets reuploadRequest to
                // updateMediaMessage, so the missing key can still be fetched, and a
                // genuine failure lands on the bounded retry ladder with a real log.
                logger.info(
                    `📡 Channel sticker queued without media yet: ${chatId} (${messageId}) — will retry`
                );
                void this.stickerForwarder
                    .forwardSticker(this.sock, msg, chatId, { mediaPending: true })
                    .catch((err) => {
                        logger.warn(`Channel sticker (pending media) forward error: ${err?.message || err}`);
                    });
                return;
            } else if (allowGroupSticker && mediaReady) {
                void this.stickerForwarder
                    .forwardSticker(this.sock, msg, chatId)
                    .catch((err) => {
                        logger.error('Sticker forward error:', err?.message || err);
                    });
            }
        }

        if (isChannel) {
            return;
        }

        if (this._isMessageProcessed(messageId)) {
            return;
        }

        const selfChat = msg.key.fromMe && isBotSelfChat(this.sock, chatId);
        // fromMe is normally ignored (bot echoes), but owner typing /vv etc. on the bot
        // phone in a DM must work — especially view-once reveal in private chats.
        if (msg.key.fromMe && !selfChat && !isCommandMessage) {
            return;
        }

        rememberLidPnFromMessageKey(this.sock, msg.key);

        const senderJid =
            selfChat || (msg.key.fromMe && isCommandMessage)
                ? getBotSelfSenderJid(this.sock)
                : getMessageSenderJid(msg.key);
        if (chatId.endsWith('@g.us') && !senderJid) {
            logger.warn('Group message with no sender participant; ignoring');
            return;
        }

        // Store user information (JID -> pushName mapping) for later retrieval
        if (senderJid && msg.pushName && this.userManager) {
            void this.userManager.updateUser(senderJid, msg.pushName).catch(() => {});
        }

        const messageText = messageTextPreview || getTextFromWAMessage(msg.message).trim();
        const textForUrls = textForUrlsPreview || getTextForUrlScan(msg.message).trim();

        if (messageText.startsWith('/')) {
            const alt = msg.key?.remoteJidAlt || 'n/a';
            logger.info(`📩 DM/group command: ${messageText.split(/\s+/)[0]} from ${senderJid} in ${chatId} (remoteJidAlt=${alt})`);
        }

        if (!messageText.startsWith('/')) {
            const handledPending = await this.commandController.tryHandlePendingInput(
                this.sock,
                chatId,
                messageText,
                senderJid,
                msg
            );
            if (handledPending) {
                return;
            }
        }

        if (messageText.startsWith('/')) {
            void this.commandController
                .handleCommand(this.sock, chatId, messageText, senderJid, msg, msg.pushName)
                .catch(async (err) => {
                    logger.error('Command error:', err?.message || err);
                    logger.error('Command error stack:', err?.stack);
                    try {
                        await safeSendMessage(this.sock, chatId, {
                            text: '⚠️ Bot could not process that command. Try again in a moment.',
                        }, msg);
                    } catch {}
                });
            return;
        }

        // "Who is the owner?" — DM always; groups when @bot or clearly aimed at the bot ("ur/your owner")
        if (
            messageText
            && looksLikeOwnerAboutQuestion(messageText)
            && (
                isDirectMessage(chatId)
                || messageMentionsBot(this.sock, msg)
                || isBotDirectedOwnerQuestion(messageText)
            )
        ) {
            const about = formatOwnerAboutReply();
            try {
                await safeSendMessage(this.sock, chatId, {
                    text: about.text,
                    mentions: about.mentions,
                }, msg);
                return;
            } catch (err) {
                logger.warn(`Owner-about reply failed: ${err?.message || err}`);
            }
        }

        // DM assist mode — reply as owner (Jacky) via Gemini; never in groups
        if (
            messageText &&
            !messageText.startsWith('/') &&
            this.assistService &&
            isDirectMessage(chatId) &&
            !isBotSelfChat(this.sock, chatId)
        ) {
            const handledAssist = await this.assistService.maybeReply(
                this.sock,
                chatId,
                messageText,
                senderJid,
                msg
            );
            if (handledAssist) {
                return;
            }
        }

        if (chatId.endsWith('@g.us') && this.groupChatLogService) {
            void this.groupChatLogService
                .maybeLogMessage(msg, senderJid, chatId, this.sock)
                .catch(() => {});
        }

        if (textForUrls.length > 0) {
            const igUrl = extractInstagramUrl(textForUrls);
            if (igUrl && (await this.shouldAutoDownloadInsta(chatId))) {
                void this.commandController
                    .handleInsta(this.sock, chatId, [igUrl], msg, { requireCommandArgs: false })
                    .catch((err) => {
                        logger.error('Insta auto-download error:', err?.message || err);
                    });
            }
        }
        // /bypasson groups: auto-bypass the first HDHub/HubCloud/GDFlix link
        if (textForUrls.length > 0 && this.commandController?.getBypassController) {
            const bc = this.commandController.getBypassController();
            if (bc?.maybeAutoBypass) {
                void bc
                    .maybeAutoBypass(this.sock, chatId, textForUrls, senderJid, msg)
                    .catch((err) => {
                        logger.error('Bypass auto error:', err?.message || err);
                    });
            }
        }
    }

    /** DMs: always auto. Groups: only when `/instaon` was used in that group. */
    async shouldAutoDownloadInsta(chatId) {
        if (shouldAutoDetectInstaLink(chatId)) {
            return true;
        }
        if (chatId?.endsWith('@g.us') && this.groupManager) {
            return this.groupManager.isInstaAutoEnabled(chatId);
        }
        return false;
    }

    setInterviewQuestionService(service) {
        this.interviewQuestionService = service;
    }

    getSock() {
        return this.sock;
    }

    getIsReady() {
        return this.isReady;
    }

    async waitForReady() {
        while (!this.isReady) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}

export default WhatsAppService;
