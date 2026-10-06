/**
 * Sticker Controller
 * Handles sticker creation, conversion, and metadata management
 */

import { downloadMediaMessage, downloadContentFromMessage, normalizeMessageContent } from 'baileys';
import { getTextFromWAMessage, buildQuotedTargetMessage } from '../utils/waMessage.js';
import { downloadStickerBuffer, createDownloadContext } from '../utils/stickerDownload.js';
import { extractStickerFromMessage } from '../utils/stickerExtract.js';
import fs from 'fs';
import { writeFile } from 'fs/promises';
import { logger } from '../utils/logger.js';
import crypto from 'crypto';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

// Get directory path for bundled assets
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BUNDLED_FONT_PATH = path.resolve(__dirname, '../../fonts/Roboto-Bold.ttf');

/** Lazy ffmpeg — avoid loading fluent-ffmpeg/ffmpeg-static at boot. */
let _ffmpeg = null;
let _ffmpegReady = null;
async function getFfmpeg() {
    if (_ffmpeg) return _ffmpeg;
    if (!_ffmpegReady) {
        _ffmpegReady = (async () => {
            const ffmpeg = (await import('fluent-ffmpeg')).default;
            let ffmpegPath = process.env.FFMPEG_PATH;
            if (!ffmpegPath) {
                try {
                    const { default: ffmpegStatic } = await import('ffmpeg-static');
                    ffmpegPath =
                        ffmpegStatic && fs.existsSync(ffmpegStatic) ? ffmpegStatic : 'ffmpeg';
                } catch {
                    ffmpegPath = 'ffmpeg';
                }
            }
            ffmpeg.setFfmpegPath(ffmpegPath);
            logger.info(`🎬 Sticker functionality using FFmpeg: ${ffmpegPath}`);
            _ffmpeg = ffmpeg;
            return ffmpeg;
        })();
    }
    return _ffmpegReady;
}

async function getStickerExif() {
    const WSF = (await import('wa-sticker-formatter')).default;
    return WSF.Exif;
}

class StickerController {
    constructor(config = {}) {
        this.defaultPack = config.STICKER_PACK_NAME || '';
        this.defaultAuthor = config.STICKER_PACK_AUTHOR || '';
        this.tempDir = path.join(os.tmpdir(), 'whatsapp-bot-stickers');
        this._ffmpegQueue = [];
        this._ffmpegActive = 0;
        this._ffmpegMax = 2;
        this._connectionProvider = null;
        this._ensureTempDir();
    }

    /** @param {{ getSock: () => import('baileys').WASocket, getIsReady: () => boolean }} provider */
    setConnectionProvider(provider) {
        this._connectionProvider = provider;
    }

    async _activeSock(fallbackSock, maxWaitMs = 20000) {
        const deadline = Date.now() + maxWaitMs;
        while (Date.now() < deadline) {
            const sock = this._connectionProvider?.getSock?.() ?? fallbackSock;
            const ready = this._connectionProvider?.getIsReady?.() ?? Boolean(sock?.user);
            if (sock?.user && ready) {
                return sock;
            }
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
        return this._connectionProvider?.getSock?.() ?? fallbackSock;
    }

    _ensureTempDir() {
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
    }

    _generateTempFileName(ext = '') {
        const randomId = crypto.randomBytes(8).toString('hex');
        return path.join(this.tempDir, `${randomId}${ext}`);
    }

    _safeUnlink(filePath) {
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        } catch (err) {
            logger.warn(`Failed to delete temp file ${filePath}: ${err.message}`);
        }
    }

    _runFfmpeg(command) {
        return new Promise((resolve, reject) => {
            command.on('end', resolve).on('error', reject);
        });
    }

    _enqueueFfmpeg(task) {
        return new Promise((resolve, reject) => {
            this._ffmpegQueue.push({ task, resolve, reject });
            this._pumpFfmpegQueue();
        });
    }

    _pumpFfmpegQueue() {
        while (this._ffmpegActive < this._ffmpegMax && this._ffmpegQueue.length > 0) {
            const job = this._ffmpegQueue.shift();
            this._ffmpegActive++;
            Promise.resolve()
                .then(job.task)
                .then(job.resolve, job.reject)
                .finally(() => {
                    this._ffmpegActive--;
                    this._pumpFfmpegQueue();
                });
        }
    }

    async _downloadStickerBuffer(sock, primaryMessage, stickerPayload = null) {
        const activeSock = await this._activeSock(sock);
        const ctx = createDownloadContext(activeSock);
        let lastError = null;

        const payload = stickerPayload || (primaryMessage && extractStickerFromMessage(primaryMessage.message));

        if (payload) {
            try {
                const stream = await downloadContentFromMessage(payload, 'sticker', ctx);
                const chunks = [];
                for await (const chunk of stream) {
                    chunks.push(chunk);
                }
                const buffer = Buffer.concat(chunks);
                if (buffer.length) {
                    return buffer;
                }
            } catch (err) {
                lastError = err;
            }
        }

        if (primaryMessage) {
            try {
                return await downloadStickerBuffer(activeSock, primaryMessage);
            } catch (err) {
                lastError = err;
            }

            try {
                const buffer = await downloadMediaMessage(primaryMessage, 'buffer', {}, ctx);
                if (buffer?.length) {
                    return buffer;
                }
            } catch (err) {
                lastError = err;
            }
        }

        throw lastError || new Error('Failed to download sticker');
    }

    _parseStickerShape(args) {
        const circleMode = args.some((a) => ['circle', 'round', 'circular', 'c'].includes(String(a).toLowerCase()));
        const cropMode = !circleMode && args.includes('crop');
        if (circleMode) return 'circle';
        if (cropMode) return 'crop';
        return 'default';
    }

    _isAnimatedWebp(buffer) {
        return Buffer.isBuffer(buffer) && buffer.includes(Buffer.from('ANIM'));
    }

    async _renderCircleStickerSharp(inputBuffer, outputPath) {
        const { default: sharp } = await import('sharp');
        const mask = Buffer.from('<svg width="512" height="512"><circle cx="256" cy="256" r="252" fill="white"/></svg>');
        const out = await sharp(inputBuffer, { animated: true })
            .resize(512, 512, { fit: 'cover' })
            .composite([{ input: mask, blend: 'dest-in' }])
            .webp({ quality: 90 })
            .toBuffer();
        await writeFile(outputPath, out);
    }

    async _renderCircleSticker(mediaPath, outputPath, { animated = false, inputBuffer = null } = {}) {
        if (animated && /\.webp$/i.test(mediaPath)) {
            await this._renderCircleStickerSharp(inputBuffer || fs.readFileSync(mediaPath), outputPath);
            return;
        }

        const circleFilter = [
            "crop=w='min(iw,ih)':h='min(iw,ih)'",
            'scale=512:512',
            'format=rgba',
            "geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte(hypot(X-(W/2),Y-(H/2)),W/2-2),255,0)'",
            'fps=15',
        ].join(',');

        const ffmpeg = await getFfmpeg();
        const command = ffmpeg(mediaPath);
        if (/\.gif$/i.test(mediaPath)) {
            command.inputOptions(['-ignore_loop', '0']);
        }

        await this._enqueueFfmpeg(() => this._runFfmpeg(
            command
                .addOutputOptions([
                    '-vcodec', 'libwebp',
                    '-vf', circleFilter,
                    '-loop', '0',
                    '-ss', '00:00:00.0',
                    '-t', '00:00:09.0',
                    '-preset', 'default',
                    '-an',
                    '-fps_mode', 'passthrough',
                    '-threads', '0',
                ])
                .toFormat('webp')
                .save(outputPath)
        ));
    }

    async _renderStandardSticker(mediaPath, outputPath, shape) {
        const outputOptions = shape === 'crop'
            ? [
                '-vcodec', 'libwebp',
                '-vf', "crop=w='min(min(iw,ih),500)':h='min(min(iw,ih),500)',scale=500:500,setsar=1,fps=15",
                '-loop', '0',
                '-ss', '00:00:00.0',
                '-t', '00:00:09.0',
                '-preset', 'default',
                '-an',
                '-vsync', '0',
                '-s', '512:512',
            ]
            : [
                '-vcodec', 'libwebp',
                '-vf', "scale='min(220,iw)':min'(220,ih)':force_original_aspect_ratio=decrease,fps=15, pad=220:220:-1:-1:color=white@0.0, split [a][b]; [a] palettegen=reserve_transparent=on:transparency_color=ffffff [p]; [b][p] paletteuse",
            ];

        const ffmpeg = await getFfmpeg();
        await this._enqueueFfmpeg(() => this._runFfmpeg(
            ffmpeg(mediaPath).addOutputOptions(outputOptions).toFormat('webp').save(outputPath)
        ));
    }

    async _sendStickerFromPath(sock, chatId, stickerPath, packName, authorName, noMetadata, quotedMsg) {
        const activeSock = await this._activeSock(sock);
        let stickerBuffer = fs.readFileSync(stickerPath);

        if (!noMetadata) {
            try {
                const StickerExif = await getStickerExif();
                const exif = new StickerExif({ pack: packName, author: authorName });
                stickerBuffer = await exif.add(stickerBuffer);
            } catch (metaErr) {
                logger.warn(`Sticker metadata injection failed: ${metaErr?.message || metaErr}`);
            }
        }

        const rawBuffer = fs.readFileSync(stickerPath);
        try {
            await activeSock.sendMessage(chatId, { sticker: stickerBuffer }, { quoted: quotedMsg });
        } catch (wsError) {
            logger.warn(`Sticker send with quote failed: ${wsError?.message || wsError}`);
            await activeSock.sendMessage(chatId, { sticker: rawBuffer });
        }
    }

    /**
     * Create sticker from image or video
     */
    async handleSticker(sock, chatId, waMessage, args, textContent) {
        void sock.sendMessage(chatId, {
            text: '🎨 _Creating sticker... you can use other commands meanwhile._',
        }, { quoted: waMessage }).catch(() => {});

        try {
            const targetMessage = buildQuotedTargetMessage(waMessage) || {
                ...waMessage,
                message: waMessage.message.extendedTextMessage?.contextInfo?.quotedMessage
                    ? waMessage.message.extendedTextMessage.contextInfo.quotedMessage
                    : waMessage.message,
            };

            const normalized = normalizeMessageContent(targetMessage.message) || targetMessage.message;
            const messageType = Object.keys(normalized)[0];
            const isImage = messageType === 'imageMessage';
            const isVideo = messageType === 'videoMessage';

            if (!isImage && !isVideo) {
                await sock.sendMessage(chatId, {
                    text: '❌ Please reply to an image or video (max 10 seconds).'
                });
                return;
            }

            // Check video duration
            if (isVideo && normalized.videoMessage?.seconds > 10) {
                await sock.sendMessage(chatId, {
                    text: '❌ Video must be less than 10 seconds.'
                });
                return;
            }

            // Parse arguments
            let packName = this.defaultPack;
            let authorName = this.defaultAuthor;
            const shape = this._parseStickerShape(args);
            const noMetadata = args.includes('nometadata');

            if (!noMetadata) {
                const argsText = textContent.replace(/^\/\w+\s*/, ''); // Remove command
                if (argsText.includes('pack')) {
                    const packMatch = argsText.match(/pack\s+([^author]+)/i);
                    if (packMatch) packName = packMatch[1].trim();
                }
                if (argsText.includes('author')) {
                    const authorMatch = argsText.match(/author\s+([^pack]+)/i);
                    if (authorMatch) authorName = authorMatch[1].trim();
                }
            }

            // Download media
            const mediaPath = this._generateTempFileName(isImage ? '.png' : '.mp4');
            
            try {
                const activeSock = await this._activeSock(sock);
                const buffer = await downloadMediaMessage(
                    targetMessage,
                    'buffer',
                    {},
                    createDownloadContext(activeSock)
                );
                if (!buffer || buffer.length === 0) {
                    await sock.sendMessage(chatId, {
                        text: '❌ Failed to download media. Please try again.'
                    });
                    return;
                }

                await writeFile(mediaPath, buffer);

                if (!fs.existsSync(mediaPath)) {
                    await sock.sendMessage(chatId, {
                        text: '❌ Failed to save media file. Please try again.'
                    });
                    return;
                }

                // Create sticker
                await this._buildSticker(sock, chatId, mediaPath, packName, authorName, shape, noMetadata, waMessage, isVideo);
            } catch (error) {
                logger.error('Media download error:', error);
                await sock.sendMessage(chatId, {
                    text: '❌ Failed to process media. Please try again.'
                });
            }
        } catch (error) {
            logger.error('Sticker handler error:', error);
            await sock.sendMessage(chatId, {
                text: '⚠️ Failed to create sticker.'
            });
        }
    }

    async _buildSticker(sock, chatId, mediaPath, packName, authorName, shape, noMetadata, quotedMsg, isAnimated = false) {
        const stickerPath = this._generateTempFileName('.webp');

        try {
            if (!fs.existsSync(mediaPath)) {
                throw new Error('Input media file not found');
            }

            if (shape === 'circle') {
                await this._renderCircleSticker(mediaPath, stickerPath, { animated: isAnimated });
            } else {
                await this._renderStandardSticker(mediaPath, stickerPath, shape);
            }

            if (!fs.existsSync(stickerPath)) {
                throw new Error('Output sticker file not created');
            }

            await this._sendStickerFromPath(sock, chatId, stickerPath, packName, authorName, noMetadata, quotedMsg);
        } catch (err) {
            logger.error('buildSticker error:', err);
            await sock.sendMessage(chatId, {
                text: '❌ Failed to create sticker.',
            });
        } finally {
            this._safeUnlink(mediaPath);
            this._safeUnlink(stickerPath);
        }
    }

    /**
     * Steal sticker (change metadata)
     */
    async handleSteal(sock, chatId, waMessage, args, textContent) {
        void sock.sendMessage(chatId, {
            text: '🎨 _Processing sticker... you can use other commands meanwhile._',
        }, { quoted: waMessage }).catch(() => {});

        try {
            const targetMessage = buildQuotedTargetMessage(waMessage);
            if (!targetMessage) {
                await sock.sendMessage(chatId, {
                    text: '❌ Please reply to a sticker.',
                });
                return;
            }

            const stickerPayload = extractStickerFromMessage(targetMessage.message);
            if (!stickerPayload) {
                await sock.sendMessage(chatId, {
                    text: '❌ Please reply to a sticker.',
                });
                return;
            }

            let packName = this.defaultPack;
            let authorName = this.defaultAuthor;
            const shape = this._parseStickerShape(args);
            const noMetadata = textContent.includes('stealn');

            if (!noMetadata) {
                const argsText = textContent.replace(/^\/\w+\s*/, '');
                if (argsText.includes('pack')) {
                    const packMatch = argsText.match(/pack\s+([^author]+)/i);
                    if (packMatch) packName = packMatch[1].trim();
                }
                if (argsText.includes('author')) {
                    const authorMatch = argsText.match(/author\s+([^pack]+)/i);
                    if (authorMatch) authorName = authorMatch[1].trim();
                }
            }

            let buffer;
            try {
                buffer = await this._downloadStickerBuffer(sock, targetMessage, stickerPayload);
            } catch (downloadErr) {
                logger.error(`Steal download failed: ${downloadErr.message}`);
                await sock.sendMessage(chatId, {
                    text: '❌ Failed to download sticker.',
                });
                return;
            }
            
            if (!buffer || buffer.length === 0) {
                await sock.sendMessage(chatId, {
                    text: '❌ Failed to download sticker.',
                });
                return;
            }

            const isAnimated = Boolean(stickerPayload.isAnimated) || this._isAnimatedWebp(buffer);
            
            if (shape === 'circle' && isAnimated) {
                await sock.sendMessage(chatId, {
                    text: '⚠️ Circle mode only works on static stickers.\n\n💡 _Tip:_ Reply to an image or video with `/stk c` to create your own circle sticker!',
                });
                return;
            }

            logger.info(`Steal: shape=${shape} animated=${isAnimated} bytes=${buffer.length} args=${args.join(' ') || '(none)'}`);

            const stickerPath = this._generateTempFileName('.webp');
            await writeFile(stickerPath, buffer);

            try {
                if (shape === 'circle') {
                    const circlePath = this._generateTempFileName('.webp');
                    try {
                        try {
                            await this._renderCircleSticker(stickerPath, circlePath, {
                                animated: isAnimated,
                                inputBuffer: buffer,
                            });
                            await this._sendStickerFromPath(sock, chatId, circlePath, packName, authorName, noMetadata || isAnimated, waMessage);
                            logger.info(`✓ Sticker converted to circle`);
                        } catch (circleErr) {
                            logger.warn({ err: circleErr }, 'Circle render failed, sending original sticker');
                            await this._sendStickerFromPath(sock, chatId, stickerPath, packName, authorName, noMetadata || isAnimated, waMessage);
                            logger.info('✓ Sticker sent (circle fallback to original)');
                        }
                    } finally {
                        this._safeUnlink(circlePath);
                    }
                } else {
                    await this._sendStickerFromPath(
                        sock,
                        chatId,
                        stickerPath,
                        packName,
                        authorName,
                        noMetadata || isAnimated,
                        waMessage
                    );
                    logger.info('✓ Sticker metadata updated successfully');
                }
            } catch (error) {
                logger.error({ err: error }, 'Error in steal handler');
                await sock.sendMessage(chatId, {
                    text: shape === 'circle'
                        ? '❌ Failed to convert sticker to circle.'
                        : '❌ Failed to modify sticker metadata.',
                });
            } finally {
                this._safeUnlink(stickerPath);
            }
        } catch (error) {
            logger.error('Steal handler error:', error);
            await sock.sendMessage(chatId, {
                text: '⚠️ Failed to steal sticker.'
            });
        }
    }

    /**
     * Convert sticker to image
     */
    async handleToImage(sock, chatId, waMessage) {
        void sock.sendMessage(chatId, {
            text: '🎨 _Converting sticker... you can use other commands meanwhile._',
        }, { quoted: waMessage }).catch(() => {});

        try {
            const targetMessage = buildQuotedTargetMessage(waMessage) || {
                ...waMessage,
                message: waMessage.message.extendedTextMessage?.contextInfo?.quotedMessage || waMessage.message,
            };

            const messageType = Object.keys(targetMessage.message)[0];
            if (messageType !== 'stickerMessage') {
                await sock.sendMessage(chatId, {
                    text: '❌ Please reply to a sticker.',
                });
                return;
            }

            let buffer;
            try {
                buffer = await this._downloadStickerBuffer(sock, targetMessage);
            } catch {
                await sock.sendMessage(chatId, {
                    text: '❌ Failed to download sticker.',
                });
                return;
            }
            
            if (!buffer || buffer.length === 0) {
                await sock.sendMessage(chatId, {
                    text: '❌ Failed to download sticker.',
                });
                return;
            }

            const stickerPath = this._generateTempFileName('.webp');
            const imagePath = this._generateTempFileName('.png');

            await writeFile(stickerPath, buffer);

            await this._enqueueFfmpeg(async () => {
                const ffmpeg = await getFfmpeg();
                return new Promise((resolve, reject) => {
                    const ffmpegProcess = ffmpeg(stickerPath)
                        .fromFormat('webp_pipe')
                        .save(imagePath);

                    ffmpegProcess.on('error', reject);
                    ffmpegProcess.on('end', resolve);
                });
            });

            if (!fs.existsSync(imagePath)) {
                throw new Error('Output image file not created');
            }

            const imageBuffer = fs.readFileSync(imagePath);
            await sock.sendMessage(chatId, {
                image: imageBuffer,
                caption: '✨ Sticker converted to image',
                mimetype: 'image/png',
            }, { quoted: waMessage });

            this._safeUnlink(stickerPath);
            this._safeUnlink(imagePath);
        } catch (error) {
            logger.error('ToImage handler error:', error);
            await sock.sendMessage(chatId, {
                text: '⚠️ Failed to convert sticker.',
            });
        }
    }

    /**
     * Generate animated RGB/rainbow text sticker
     */
    async handleRgbSticker(sock, chatId, args, originalMsg = null) {
        let text = args.join(' ').replace(/^["']|["']$/g, '').trim();

        // If no args, try to get text from the replied/quoted message
        if (!text && originalMsg) {
            const quotedMsg = originalMsg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            if (quotedMsg) {
                text = getTextFromWAMessage(quotedMsg).trim();
            }
        }

        if (!text) {
            await sock.sendMessage(chatId, {
                text: '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'
                    + '🌈 *RGB STICKER MAKER*\n'
                    + '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n'
                    + '*Usage:*\n'
                    + '• `/rgb Hello World` — type your text\n'
                    + '• Reply to any message with `/rgb` — uses that message\'s text\n\n'
                    + '*Examples:*\n'
                    + '• `/rgb Sassy Bot 🔥`\n'
                    + '• `/rgb GG EZ`\n\n'
                    + '💡 _Reply to any message with `/rgb` to convert it!_',
            }, { quoted: originalMsg || undefined });
            return;
        }

        const processingMsg = await sock.sendMessage(chatId, {
            text: '🎨 _Generating RGB sticker..._',
        }, { quoted: originalMsg || undefined });

        const frameFiles = [];
        let outputPath = null;
        let concatFile = null;

        try {
            const { createCanvas, GlobalFonts } = await import('@napi-rs/canvas');

            // Register bundled font for cross-platform compatibility
            let fontFamily = 'sans-serif';
            try {
                if (fs.existsSync(BUNDLED_FONT_PATH)) {
                    GlobalFonts.registerFromPath(BUNDLED_FONT_PATH, 'RobotoBold');
                    fontFamily = 'RobotoBold';
                    logger.info('RGB sticker using bundled Roboto font');
                } else {
                    // Fallback to system fonts
                    GlobalFonts.loadSystemFonts();
                    fontFamily = 'Arial, DejaVu Sans, Liberation Sans, sans-serif';
                    logger.warn('Bundled font not found, using system fonts');
                }
            } catch (e) {
                logger.warn(`Font loading failed: ${e.message}, using fallback`);
                fontFamily = 'sans-serif';
            }

            const SIZE = 512;

            const COLORS = [
                '#FF0000', '#FF4500', '#FF8C00', '#FFD700',
                '#00FF00', '#00FFCD', '#00FFFF', '#0080FF',
                '#8B00FF', '#FF00FF', '#FF1493', '#FF6347',
            ];

            // Draw each frame
            for (let i = 0; i < COLORS.length; i++) {
                const canvas = createCanvas(SIZE, SIZE);
                const ctx = canvas.getContext('2d');

                // Transparent background
                ctx.clearRect(0, 0, SIZE, SIZE);

                const color = COLORS[i];

                // Dynamic font size based on text length — no hard cap
                let fontSize = text.length <= 4 ? 130
                    : text.length <= 6 ? 110
                    : text.length <= 10 ? 88
                    : text.length <= 16 ? 70
                    : text.length <= 25 ? 54
                    : text.length <= 40 ? 42
                    : 32;

                // Use registered font
                ctx.font = `${fontSize}px ${fontFamily}`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';

                // No glow — clean solid color fill
                ctx.shadowColor = 'transparent';
                ctx.shadowBlur = 0;
                ctx.fillStyle = color;

                // Word-wrap if needed
                const maxWidth = SIZE - 40;
                const words = text.split(' ');
                const lines = [];
                let cur = '';
                for (const word of words) {
                    const test = cur ? `${cur} ${word}` : word;
                    if (ctx.measureText(test).width > maxWidth && cur) {
                        lines.push(cur);
                        cur = word;
                    } else {
                        cur = test;
                    }
                }
                lines.push(cur);

                const lineH = fontSize * 1.35;
                const startY = SIZE / 2 - ((lines.length - 1) * lineH) / 2;
                for (let j = 0; j < lines.length; j++) {
                    ctx.fillText(lines[j], SIZE / 2, startY + j * lineH);
                }

                const framePath = this._generateTempFileName('_rgb.png');
                fs.writeFileSync(framePath, canvas.toBuffer('image/png'));
                frameFiles.push(framePath);
            }

            // Write ffmpeg concat list (each frame shown for 0.1s → ~10fps)
            concatFile = this._generateTempFileName('.txt');
            const concatContent = frameFiles
                .map(f => `file '${f.replace(/\\/g, '/')}'\nduration 0.10`)
                .join('\n');
            fs.writeFileSync(concatFile, concatContent);

            outputPath = this._generateTempFileName('.webp');

            // Combine frames → animated WebP
            const ffmpeg = await getFfmpeg();
            await new Promise((resolve, reject) => {
                ffmpeg()
                    .input(concatFile)
                    .inputOptions(['-f', 'concat', '-safe', '0'])
                    .outputOptions([
                        '-vcodec', 'libwebp',
                        '-vf', 'scale=512:512',
                        '-loop', '0',
                        '-preset', 'default',
                        '-pix_fmt', 'yuva420p',
                        '-an',
                        '-vsync', '0',
                    ])
                    .output(outputPath)
                    .on('end', resolve)
                    .on('error', reject)
                    .run();
            });

            // Read WebP buffer and inject metadata via Exif
            let buffer = fs.readFileSync(outputPath);
            try {
                const StickerExif = await getStickerExif();
                const exif = new StickerExif({ pack: this.defaultPack, author: this.defaultAuthor });
                buffer = await exif.add(buffer);
            } catch (metaErr) {
                logger.warn(`RGB sticker metadata injection failed: ${metaErr.message}`);
            }
            try { await sock.sendMessage(chatId, { delete: processingMsg.key }); } catch {}
            await sock.sendMessage(chatId, { sticker: buffer }, { quoted: originalMsg || undefined });
            logger.info(`🌈 RGB sticker created for "${text}" in ${chatId}`);

        } catch (err) {
            logger.error('RGB sticker error:', err?.message || err);
            try { await sock.sendMessage(chatId, { delete: processingMsg.key }); } catch {}
            await sock.sendMessage(chatId, {
                text: '❌ Failed to generate RGB sticker. Try again!',
            }, { quoted: originalMsg || undefined });
        } finally {
            frameFiles.forEach(f => this._safeUnlink(f));
            if (outputPath) this._safeUnlink(outputPath);
            if (concatFile) this._safeUnlink(concatFile);
        }
    }
}

export default StickerController;
