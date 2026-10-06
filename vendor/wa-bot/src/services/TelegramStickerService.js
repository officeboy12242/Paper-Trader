/**
 * Telegram Sticker Service
 * Fetches sticker packs from Telegram via Bot API and converts to WhatsApp format.
 *
 * Every sticker type ends up as a single output format — a WhatsApp sticker
 * (`{ sticker: buffer }`), because that is the only thing WhatsApp renders as
 * a sticker:
 *
 * - Static WebP → resize + compress → static WebP sticker
 * - Animated TGS (gzipped Lottie JSON) → real Lottie frames via
 *   @lottiefiles/dotlottie-web (ThorVG WASM) on @napi-rs/canvas →
 *   animated WebP (VP8X/ANIM/ANMF, alpha preserved)
 * - Video stickers (WEBM/VP9, MP4) → animated WebP
 *
 * Animated output goes through ffmpeg's `libwebp_anim` encoder with
 * `yuva420p`, which keeps the alpha channel. Encoding to MP4/`yuv420p`
 * flattens alpha onto black and WhatsApp shows it as a video attachment
 * rather than a sticker, so that path is deliberately not used.
 *
 * Supports abort via AbortController (user sends /tgstop).
 *
 * Requires TELEGRAM_BOT_TOKEN env var.
 */

import { logger } from '../utils/logger.js';
import { config } from '../config/config.js';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import zlib from 'zlib';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { createRequire } from 'module';
import { createCanvas } from '@napi-rs/canvas';
import { DotLottie } from '@lottiefiles/dotlottie-web';

const execFileAsync = promisify(execFile);

const TG_API = 'https://api.telegram.org';
const STICKER_WEBP_MAX = 100 * 1024; // 100 KB — WhatsApp static sticker limit
const ANIM_WEBP_MAX = 500 * 1024;    // 500 KB — WhatsApp animated sticker limit
// The pack/author EXIF chunk is appended after encoding (~210 bytes in
// practice). Reserve headroom so injecting it can't push a sticker that just
// squeaked under the limit back over it.
const EXIF_OVERHEAD = 1024;
const ANIM_BUDGET = ANIM_WEBP_MAX - EXIF_OVERHEAD;
const STATIC_BUDGET = STICKER_WEBP_MAX - EXIF_OVERHEAD;
const DOWNLOAD_CONCURRENCY = 3;
// Conversion is CPU-bound (Lottie raster + ffmpeg). Leave a core for the rest
// of the bot, and stay serial on single/dual-core hosts like small PaaS dynos.
// Override with STICKER_CONVERT_CONCURRENCY when the host has cores to spare.
const CONVERT_CONCURRENCY = (() => {
    const override = Number.parseInt(process.env.STICKER_CONVERT_CONCURRENCY || '', 10);
    if (Number.isFinite(override) && override > 0) return Math.min(16, override);
    return Math.max(1, Math.min(4, (os.cpus()?.length || 1) - 1));
})();
const STICKER_SIZE = 512;            // WhatsApp stickers are 512×512
const MAX_ANIM_SECONDS = 6;          // Cap animation length

/**
 * Encoder ladder for animated WebP, tried in order until the output fits
 * ANIM_BUDGET. Real TGS packs vary wildly in complexity, so a fixed quality
 * either blows the size limit or wastes it.
 *
 * The first rung is deliberately modest. Measured over a spread of real packs,
 * starting at 24fps/q75 fit only 4/7 stickers in a single encode and cost
 * ~2.3s; 15fps/q65 fits 5/7 at ~1.4s — and 15fps is what the bot's own
 * stickers already use (see StickerController). Starting high just bought a
 * second encode for most stickers.
 */
const ANIM_LADDER = [
    { fps: 15, quality: 65, size: 512 },
    { fps: 12, quality: 60, size: 512 },
    { fps: 12, quality: 55, size: 448 },
    { fps: 10, quality: 50, size: 384 },
    { fps: 8, quality: 45, size: 320 },
];

/** Most packs that may be importing at once, across all chats. */
export const MAX_CONCURRENT_IMPORTS = 4;

/**
 * Counting semaphore gating sticker conversion.
 *
 * This is module-level on purpose: CONVERT_CONCURRENCY has to be a *global*
 * ceiling, not a per-import one. Otherwise four simultaneous pack imports
 * would run 4 × CONVERT_CONCURRENCY encoders at once and thrash a small host
 * into ffmpeg timeouts — exactly the "fails when running several packs" case.
 */
export class Semaphore {
    constructor(max) {
        this.max = Math.max(1, max);
        this.active = 0;
        this.waiters = [];
    }

    async run(fn) {
        if (this.active >= this.max) {
            await new Promise((resolve) => this.waiters.push(resolve));
        } else {
            this.active++;
        }
        try {
            return await fn();
        } finally {
            const next = this.waiters.shift();
            if (next) next();      // hand the slot straight to the next waiter
            else this.active--;
        }
    }
}

const conversionGate = new Semaphore(CONVERT_CONCURRENCY);

/* ─── Active imports (for /tgstop) ─── */
export const activeImports = new Map(); // chatId → AbortController

export function abortImport(chatId) {
    const ctrl = activeImports.get(chatId);
    if (ctrl) {
        ctrl.abort();
        activeImports.delete(chatId);
        return true;
    }
    return false;
}

export function isImportActive(chatId) {
    return activeImports.has(chatId);
}

class TelegramStickerService {
    constructor() {
        this.tempDir = path.join(os.tmpdir(), 'whatsapp-bot-tg-stickers');
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
    }

    get token() {
        return config.TELEGRAM_BOT_TOKEN;
    }

    get isConfigured() {
        return Boolean(this.token);
    }

    /** Parse pack name from URL or raw input. */
    parsePackInput(input) {
        if (!input || typeof input !== 'string') return null;
        const trimmed = input.trim();

        let m = trimmed.match(/t\.me\/addstickers\/([A-Za-z0-9_-]+)$/i);
        if (m) return m[1];

        m = trimmed.match(/tg:\/\/addstickers\?set=([A-Za-z0-9_-]+)/i);
        if (m) return m[1];

        if (/^[A-Za-z0-9_-]{1,64}$/.test(trimmed)) return trimmed;
        return null;
    }

    /** Fetch sticker set metadata from Telegram Bot API. */
    async getStickerSet(packName) {
        if (!this.isConfigured) {
            throw new Error('Telegram Bot token not configured. Set TELEGRAM_BOT_TOKEN in .env');
        }

        const url = `${TG_API}/bot${this.token}/getStickerSet?name=${encodeURIComponent(packName)}`;
        const res = await axios.get(url, { timeout: 15000 });

        if (!res.data?.ok) {
            throw new Error(`Telegram API: ${res.data?.description || 'Unknown error'}`);
        }
        return res.data.result;
    }

    /**
     * Resolve an ffmpeg binary. Prefers FFMPEG_PATH, then the bundled
     * ffmpeg-static (which ships libwebp_anim), then whatever is on PATH.
     * Matches how StickerController resolves it.
     */
    get ffmpegPath() {
        if (this._ffmpegPath) return this._ffmpegPath;
        let resolved = process.env.FFMPEG_PATH;
        if (!resolved) {
            try {
                const req = createRequire(import.meta.url);
                const staticPath = req('ffmpeg-static');
                resolved = staticPath && fs.existsSync(staticPath) ? staticPath : 'ffmpeg';
            } catch {
                resolved = 'ffmpeg';
            }
        }
        this._ffmpegPath = resolved;
        return resolved;
    }

    /**
     * Run ffmpeg without blocking the event loop.
     *
     * execFileSync would stall every other conversion (and the rest of the
     * bot) for the duration of the encode, which made CONVERT_CONCURRENCY
     * meaningless — the parallel tasks just queued behind each other.
     */
    _runFfmpeg(args, timeout = 120000) {
        return execFileAsync(this.ffmpegPath, ['-hide_banner', '-loglevel', 'error', ...args], {
            timeout,
            maxBuffer: 1 << 24,
            windowsHide: true,
        });
    }

    /** Get the download URL and remote file path for a sticker by file_id. */
    async getFile(fileId) {
        const url = `${TG_API}/bot${this.token}/getFile?file_id=${encodeURIComponent(fileId)}`;
        const res = await axios.get(url, { timeout: 10000 });

        if (!res.data?.ok) {
            throw new Error(`getFile failed: ${res.data?.description || 'unknown'}`);
        }

        const filePath = res.data.result.file_path;
        return {
            filePath,
            url: `https://api.telegram.org/file/bot${this.token}/${filePath}`,
        };
    }

    /** Download a sticker file to a temp path. */
    async downloadSticker(sticker, index) {
        const fileId = sticker.file_id;
        const isAnimated = sticker.is_animated || false;
        const isVideo = sticker.is_video || false;
        const emoji = sticker.emoji || '❓';

        const { filePath, url: fileUrl } = await this.getFile(fileId);
        const res = await axios.get(fileUrl, {
            responseType: 'arraybuffer',
            timeout: 30000,
        });

        // Trust the extension Telegram reports — video stickers are WEBM/VP9,
        // not MP4, and ffmpeg needs the right container hint.
        const remoteExt = (path.extname(filePath || '') || '').toLowerCase();
        const format = isAnimated ? 'tgs' : isVideo ? 'video' : 'webp';
        const ext = remoteExt || (format === 'tgs' ? '.tgs' : format === 'video' ? '.webm' : '.webp');

        const buffer = Buffer.from(res.data);
        const tempPath = path.join(this.tempDir, `${crypto.randomBytes(8).toString('hex')}${ext}`);
        fs.writeFileSync(tempPath, buffer);

        return { tempPath, buffer, size: buffer.length, isAnimated, isVideo, emoji, format, ext, index };
    }

    /* ──────────────────────────────────────────────
     *  Lottie renderer — @lottiefiles/dotlottie-web (ThorVG WASM)
     *  running on @napi-rs/canvas. Replaces a hand-rolled SVG-based
     *  Lottie renderer that failed on the majority of real TGS packs
     *  (mattes, masks, expressions, precomps, gradient strokes, etc).
     * ────────────────────────────────────────────── */

    /** Decode a .tgs (gzipped Lottie) or a bare Lottie JSON buffer. */
    _readLottie(tgsBuffer) {
        const json = (tgsBuffer[0] === 0x1f && tgsBuffer[1] === 0x8b)
            ? zlib.gunzipSync(tgsBuffer).toString('utf-8')
            : tgsBuffer.toString('utf-8');
        return { json, lottie: JSON.parse(json) };
    }

    /**
     * Load a Lottie onto a canvas and report its timing.
     *
     * Returns the drawing context too, because the fast path reads raw pixels
     * straight out of it rather than encoding intermediate PNGs.
     */
    async _openLottie(tgsBuffer, size) {
        const { json, lottie } = this._readLottie(tgsBuffer);
        const srcFps = lottie.fr || 60;

        // Square canvas at sticker resolution — Lottie scales to fit the
        // canvas, and TGS is square by spec.
        const canvas = createCanvas(size, size);
        const dot = new DotLottie({ canvas, data: json, autoplay: false, loop: false });

        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('dotlottie load timeout')), 15_000);
            dot.addEventListener('load', () => { clearTimeout(timer); resolve(); });
            dot.addEventListener('loadError', (e) => {
                clearTimeout(timer);
                reject(new Error(`lottie load error: ${e?.error?.message || 'unknown'}`));
            });
        });

        const totalFrames = dot.totalFrames || (lottie.op - lottie.ip) || srcFps;
        const durationSec = Math.min(MAX_ANIM_SECONDS, Math.max(0.2, totalFrames / srcFps));

        return { canvas, ctx: canvas.getContext('2d'), dot, totalFrames, srcFps, durationSec };
    }

    /** How many output frames to sample for a given duration and fps. */
    _frameCount(durationSec, fps) {
        return Math.max(2, Math.min(120, Math.round(durationSec * fps)));
    }

    /**
     * Render a TGS into PNG frame buffers.
     *
     * Only used by the static-frame path and the node-webpmux fallback — the
     * main encoder streams raw pixels instead, because PNG-encoding every
     * frame and round-tripping it through disk costs more than the WebP
     * encode itself (~11ms/frame, ~2.5x the total pipeline time).
     */
    async _renderLottieFrames(tgsBuffer, { fps = 20, size = STICKER_SIZE } = {}) {
        const { canvas, dot, totalFrames, durationSec } = await this._openLottie(tgsBuffer, size);
        const frameCount = this._frameCount(durationSec, fps);

        // Sampling spans the whole animation even when durationSec clamps, so an
        // over-long source plays slightly fast rather than being cut off — a
        // truncated loop looks broken every time a sticker repeats. Telegram caps
        // TGS at 3s anyway, so the clamp rarely bites.
        const frames = [];
        for (let i = 0; i < frameCount; i++) {
            // Fractional frames are fine — ThorVG interpolates.
            dot.setFrame((i / frameCount) * totalFrames);
            frames.push(await canvas.encode('png'));
        }
        dot.destroy();

        if (!frames.length) throw new Error('lottie produced no frames');
        return { frames, size, fps, durationSec, totalFrames };
    }

    /** Write rendered PNG frames to a scratch dir for ffmpeg to consume. */
    _writeFrameDir(frames) {
        const frameDir = path.join(this.tempDir, `frames_${crypto.randomBytes(6).toString('hex')}`);
        fs.mkdirSync(frameDir, { recursive: true });
        for (let i = 0; i < frames.length; i++) {
            fs.writeFileSync(path.join(frameDir, `f_${String(i + 1).padStart(4, '0')}.png`), frames[i]);
        }
        return frameDir;
    }

    _rmFrameDir(frameDir) {
        try {
            for (const f of fs.readdirSync(frameDir)) fs.unlinkSync(path.join(frameDir, f));
            fs.rmdirSync(frameDir);
        } catch {}
    }

    /**
     * Rasterise a Lottie straight into ffmpeg's stdin as raw RGBA and get back
     * an animated WebP. This is the hot path.
     *
     * Why raw pixels instead of PNG frames on disk: PNG-encoding each frame
     * costs ~11ms and the disk round-trip another ~3ms, together roughly 1.5x
     * the WebP encode itself. Streaming removes both and lets ffmpeg encode
     * frame N while frame N+1 rasterises — measured ~2.5x faster end to end at
     * byte-identical output size.
     *
     * Pixels come from getImageData(), NOT canvas.data(): the latter hands back
     * premultiplied alpha, which ffmpeg reads as straight RGBA and turns into
     * colour-fringed, ~18% larger output.
     *
     * Memory stays at one frame (~1MB at 512²) rather than the ~75MB a full
     * raw frame set would need — this runs on a 450MB heap.
     */
    async _streamEncodeAnimatedWebp(tgsBuffer, { fps, quality, size }) {
        const { ctx, dot, totalFrames, durationSec } = await this._openLottie(tgsBuffer, size);
        const frameCount = this._frameCount(durationSec, fps);
        const outputPath = path.join(this.tempDir, `anim_${crypto.randomBytes(6).toString('hex')}.webp`);

        let child = null;
        try {
            child = spawn(this.ffmpegPath, [
                '-hide_banner', '-loglevel', 'error', '-y',
                '-f', 'rawvideo', '-pix_fmt', 'rgba',
                '-s', `${size}x${size}`,
                '-framerate', String(fps),
                '-i', 'pipe:0',
                '-vcodec', 'libwebp_anim',
                '-lossless', '0',
                '-q:v', String(quality),
                // compression_level 5 more than doubles encode time for ~5%
                // smaller output; 3 matches PNG-path size at a fraction of the cost.
                '-compression_level', '3',
                '-loop', '0',
                '-pix_fmt', 'yuva420p',
                '-an', '-vsync', '0',
                outputPath,
            ], { windowsHide: true });

            let stderr = '';
            child.stderr.on('data', (d) => { if (stderr.length < 4096) stderr += d.toString(); });

            const exited = new Promise((resolve, reject) => {
                child.on('error', reject);           // ENOENT etc — ffmpeg unusable
                child.on('close', (code) => code === 0
                    ? resolve()
                    : reject(new Error(`ffmpeg exited ${code}${stderr ? `: ${stderr.trim().slice(0, 200)}` : ''}`)));
            });

            // A broken pipe (ffmpeg died early) must surface as the exit error,
            // not an unhandled 'error' event on stdin.
            child.stdin.on('error', () => {});

            const pump = (async () => {
                for (let i = 0; i < frameCount; i++) {
                    if (child.exitCode !== null || child.killed) break;
                    dot.setFrame((i / frameCount) * totalFrames);
                    const raw = Buffer.from(ctx.getImageData(0, 0, size, size).data.buffer);
                    if (!child.stdin.write(raw)) {
                        await new Promise((r) => child.stdin.once('drain', r));
                    } else if ((i & 7) === 7) {
                        // Rasterising is synchronous; yield periodically so a
                        // long pack import doesn't starve the rest of the bot.
                        await new Promise((r) => setImmediate(r));
                    }
                }
                child.stdin.end();
            })();

            await Promise.all([pump, exited]);
            return fs.readFileSync(outputPath);
        } finally {
            try { dot.destroy(); } catch {}
            if (child && child.exitCode === null) { try { child.kill('SIGKILL'); } catch {} }
            this._cleanup(outputPath);
        }
    }

    /** Pure-JS animated WebP assembly, for hosts whose ffmpeg lacks libwebp. */
    async _framesToAnimatedWebpMux(frames, { fps, quality, size }) {
        const sharp = (await import('sharp')).default;
        // node-webpmux is CommonJS — the named export is only reachable
        // through `.default` under ESM.
        const mod = await import('node-webpmux');
        const WebpImage = (mod.default ?? mod).Image;
        if (typeof WebpImage?.initLib !== 'function') {
            throw new Error('node-webpmux Image unavailable');
        }
        await WebpImage.initLib();

        const delay = Math.round(1000 / fps);
        const webpFrames = [];
        for (const png of frames) {
            webpFrames.push(
                await sharp(png)
                    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                    .webp({ quality, alphaQuality: 100 })
                    .toBuffer()
            );
        }

        const img = new WebpImage();
        await img.load(webpFrames[0]);
        if (!img.hasAnim) await img.convertToAnim();

        return await img.save(null, {
            frames: await Promise.all(
                webpFrames.map((buffer) => WebpImage.generateFrame({ buffer, delay }))
            ),
            width: size,
            height: size,
            loops: 0,
            bgColor: [0, 0, 0, 0],
        });
    }

    /** True if the buffer is an animated WebP (has an ANIM chunk). */
    _hasAnimChunk(buffer) {
        return Buffer.isBuffer(buffer) && buffer.includes(Buffer.from('ANIM'));
    }

    /**
     * Walk the quality ladder until the animated WebP fits WhatsApp's limit.
     *
     * Each rung re-rasterises through the streaming encoder. That sounds
     * wasteful, but rasterising is only ~1.5ms/frame — far cheaper than
     * keeping PNG frames around to re-encode from, which is what the previous
     * version did. Rungs are skipped predictively too, so an over-budget
     * sticker jumps to a rung that can actually fit instead of inching down.
     */
    async tgsToAnimatedWebp(tgsBuffer) {
        // Rough bits-per-output cost of a rung, used only to rank them.
        const weight = (r) => r.fps * r.size * r.size * (r.quality + 25);
        const topWeight = weight(ANIM_LADDER[0]);

        let best = null;
        let ffmpegUsable = false;
        let attempts = 0;

        for (let i = 0; i < ANIM_LADDER.length; i++) {
            const rung = ANIM_LADDER[i];
            try {
                attempts++;
                const out = await this._streamEncodeAnimatedWebp(tgsBuffer, rung);
                if (!out?.length || !this._hasAnimChunk(out)) {
                    throw new Error('encoder produced no ANIM chunk');
                }
                ffmpegUsable = true;
                if (!best || out.length < best.length) best = out;

                if (out.length <= ANIM_BUDGET) {
                    logger.info(
                        `TGS → animated WebP: ${out.length}b, ${rung.fps}fps, q${rung.quality}, `
                        + `${rung.size}px (${attempts} encode${attempts > 1 ? 's' : ''})`
                    );
                    return out;
                }

                // Skip ahead to the first rung light enough to plausibly fit.
                const needed = (ANIM_BUDGET / out.length) * (weight(rung) / topWeight);
                while (i + 1 < ANIM_LADDER.length && weight(ANIM_LADDER[i + 1]) / topWeight > needed) {
                    i++;
                }
                logger.info(`TGS → ${out.length}b at ${rung.fps}fps/q${rung.quality} — over limit, stepping down`);
            } catch (err) {
                logger.warn(`TGS ladder rung ${rung.fps}fps/q${rung.quality} failed: ${err.message}`);
            }
        }

        // Everything overshot the limit — send the smallest we managed rather
        // than dropping to a static frame; WhatsApp usually still accepts it.
        if (best) {
            logger.warn(`TGS → animated WebP stayed over limit (${best.length}b), sending smallest attempt`);
            return best;
        }

        if (!ffmpegUsable) {
            logger.warn('libwebp_anim unavailable, falling back to node-webpmux');
            const { frames } = await this._renderLottieFrames(tgsBuffer, { fps: 15, size: STICKER_SIZE });
            return await this._framesToAnimatedWebpMux(frames, { fps: 15, quality: 60, size: STICKER_SIZE });
        }
        throw new Error('all animated WebP encodings failed');
    }

    /**
     * Convert a Telegram video sticker (WEBM/VP9, sometimes MP4) into an
     * animated WebP so WhatsApp renders it as a sticker instead of a video.
     */
    async videoToAnimatedWebp(buffer, ext = '.webm') {
        const inputPath = path.join(this.tempDir, `vin_${crypto.randomBytes(6).toString('hex')}${ext}`);
        fs.writeFileSync(inputPath, buffer);
        let best = null;

        // Same predictive descent as the TGS ladder — decoding the source video
        // again for each rung is the expensive part, so don't inch down.
        const weight = (r) => r.fps * r.size * r.size * (r.quality + 25);
        const topWeight = weight(ANIM_LADDER[0]);

        try {
            for (let i = 0; i < ANIM_LADDER.length; i++) {
                const rung = ANIM_LADDER[i];
                const outputPath = path.join(this.tempDir, `vout_${crypto.randomBytes(6).toString('hex')}.webp`);
                try {
                    await this._runFfmpeg([
                        '-y',
                        '-i', inputPath,
                        '-vcodec', 'libwebp_anim',
                        '-lossless', '0',
                        '-q:v', String(rung.quality),
                        '-compression_level', '3',
                        '-loop', '0',
                        '-pix_fmt', 'yuva420p',
                        '-vf',
                        `fps=${rung.fps},scale=${rung.size}:${rung.size}:force_original_aspect_ratio=decrease:flags=lanczos,`
                        + `pad=${rung.size}:${rung.size}:(ow-iw)/2:(oh-ih)/2:color=#00000000`,
                        '-an', '-vsync', '0',
                        '-t', String(MAX_ANIM_SECONDS),
                        outputPath,
                    ]);
                    const out = fs.readFileSync(outputPath);
                    if (!out.length || !this._hasAnimChunk(out)) throw new Error('no ANIM chunk');
                    if (!best || out.length < best.length) best = out;
                    if (out.length <= ANIM_BUDGET) {
                        logger.info(`video → animated WebP: ${out.length}b at ${rung.fps}fps/q${rung.quality}`);
                        return out;
                    }
                    const needed = (ANIM_BUDGET / out.length) * (weight(rung) / topWeight);
                    while (i + 1 < ANIM_LADDER.length && weight(ANIM_LADDER[i + 1]) / topWeight > needed) {
                        i++;
                    }
                } catch (err) {
                    logger.warn(`video rung ${rung.fps}fps/q${rung.quality} failed: ${err.message}`);
                } finally {
                    this._cleanup(outputPath);
                }
            }
        } finally {
            this._cleanup(inputPath);
        }

        if (best) return best;
        throw new Error('video → animated WebP failed');
    }

    /** First-frame PNG for the static fallback path. */
    async tgsToStaticFrame(tgsBuffer) {
        const { frames } = await this._renderLottieFrames(tgsBuffer, { fps: 1, size: STICKER_SIZE });
        return frames[0];
    }

    /* ──────────────────────────────────────────────
     *  Sticker conversion pipeline
     * ────────────────────────────────────────────── */

    isStaticWebp(buffer) {
        if (!buffer || buffer.length < 12) return false;
        return buffer.slice(0, 4).toString() === 'RIFF' && buffer.slice(8, 12).toString() === 'WEBP';
    }

    /**
     * Convert a sticker buffer to a WhatsApp sticker.
     * Returns { buffer, type: 'sticker', isAnimated }.
     *
     * Everything becomes a WebP sticker — animated where the source was
     * animated. Nothing is emitted as a video message, because WhatsApp
     * renders those as attachments rather than stickers.
     */
    async convertToWhatsAppSticker(buffer, emoji, format) {
        const sharp = (await import('sharp')).default;

        // Telegram video sticker (WEBM/VP9, occasionally MP4) → animated WebP
        if (format === 'video' || format === 'mp4' || format === 'webm') {
            try {
                const animWebp = await this.videoToAnimatedWebp(buffer, format === 'mp4' ? '.mp4' : '.webm');
                return { buffer: animWebp, type: 'sticker', isAnimated: true };
            } catch (err) {
                logger.warn(`video → animated WebP failed: ${err.message}, falling back to first frame`);
                const still = await this._videoFirstFrameWebp(buffer, format === 'mp4' ? '.mp4' : '.webm');
                return { buffer: still, type: 'sticker', isAnimated: false };
            }
        }

        // Animated TGS → animated WebP, static first frame only as last resort
        if (format === 'tgs') {
            try {
                const animWebp = await this.tgsToAnimatedWebp(buffer);
                return { buffer: animWebp, type: 'sticker', isAnimated: true };
            } catch (err) {
                logger.warn(`TGS → animated WebP failed: ${err.message}`);
            }

            try {
                logger.info('TGS → static frame fallback');
                const pngBuffer = await this.tgsToStaticFrame(buffer);
                const fallback = await sharp(pngBuffer)
                    .resize(STICKER_SIZE, STICKER_SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                    .webp({ quality: 80, alphaQuality: 100 })
                    .toBuffer();
                return { buffer: fallback, type: 'sticker', isAnimated: false };
            } catch (e2) {
                throw new Error(`Animated sticker conversion failed: ${e2.message}`);
            }
        }

        // Static WebP — pass through when it already fits, else recompress.
        // An animated source WebP must keep its frames, so decode it animated.
        const sourceIsAnimated = this._hasAnimChunk(buffer);

        if (!sourceIsAnimated && buffer.length <= STATIC_BUDGET && this.isStaticWebp(buffer)) {
            return { buffer, type: 'sticker', isAnimated: false };
        }

        const limit = sourceIsAnimated ? ANIM_BUDGET : STATIC_BUDGET;
        for (const quality of [80, 60, 45]) {
            const out = await sharp(buffer, { animated: sourceIsAnimated })
                .resize(STICKER_SIZE, STICKER_SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                .webp({ quality, alphaQuality: quality >= 60 ? 100 : 80 })
                .toBuffer();
            if (out.length <= limit || quality === 45) {
                return { buffer: out, type: 'sticker', isAnimated: sourceIsAnimated };
            }
        }
    }

    /** Single frame of a video sticker as a static WebP, for the failure path. */
    async _videoFirstFrameWebp(buffer, ext) {
        const inputPath = path.join(this.tempDir, `vf_${crypto.randomBytes(6).toString('hex')}${ext}`);
        const outputPath = path.join(this.tempDir, `vf_${crypto.randomBytes(6).toString('hex')}.webp`);
        fs.writeFileSync(inputPath, buffer);
        try {
            await this._runFfmpeg([
                '-y', '-i', inputPath,
                '-frames:v', '1',
                '-vcodec', 'libwebp', '-lossless', '0', '-q:v', '80',
                '-pix_fmt', 'yuva420p',
                '-vf',
                `scale=${STICKER_SIZE}:${STICKER_SIZE}:force_original_aspect_ratio=decrease:flags=lanczos,`
                + `pad=${STICKER_SIZE}:${STICKER_SIZE}:(ow-iw)/2:(oh-ih)/2:color=#00000000`,
                '-an',
                outputPath,
            ], 20000);
            return fs.readFileSync(outputPath);
        } finally {
            this._cleanup(inputPath);
            this._cleanup(outputPath);
        }
    }

    /**
     * Fetch and convert an entire sticker pack.
     * @param {string} packName
     * @param {Function} onProgress - (convertedCount, failedCount, phase)
     * @param {AbortSignal} [signal] - AbortSignal to cancel
     * @param {{ skipIndices?: Set<number> }} [opts] - pack indices already
     *        delivered by an earlier run; skipped before download so a resumed
     *        import doesn't re-fetch or re-render work that is already done.
     * @returns {{ pack, stickers, errors, skipped }}
     */
    async fetchAndConvertPack(packName, onProgress, signal, { skipIndices } = {}) {
        const report = (converted, failed, phase) => {
            try { onProgress?.(converted, failed, phase); } catch {}
        };

        const pack = await this.getStickerSet(packName);
        const totalStickers = pack.stickers?.length || 0;

        if (!totalStickers) {
            return { pack, stickers: [], errors: ['Empty sticker pack'], skipped: 0 };
        }

        // Carry the original pack index so resume checkpoints stay meaningful
        // even though the work list is now sparse.
        const skip = skipIndices instanceof Set ? skipIndices : new Set();
        const toProcess = pack.stickers
            .map((sticker, index) => ({ sticker, index }))
            .filter(({ index }) => !skip.has(index));
        const skipped = totalStickers - toProcess.length;

        if (skipped) {
            logger.info(`TG pack ${packName}: resuming, skipping ${skipped}/${totalStickers} already delivered`);
        }

        const results = [];
        const errors = [];
        let convertedCount = 0;
        let failedCount = 0;

        for (let i = 0; i < toProcess.length; i += DOWNLOAD_CONCURRENCY) {
            // Check abort before each batch
            if (signal?.aborted) {
                errors.push('Import cancelled by user');
                break;
            }

            const batch = toProcess.slice(i, i + DOWNLOAD_CONCURRENCY);

            const downloads = await Promise.allSettled(
                batch.map(({ sticker, index }) => this.downloadSticker(sticker, index))
            );

            // Convert through the shared gate. Rendering and encoding are
            // CPU-bound, so this is near-linear on a multi-core host, while the
            // module-level semaphore keeps the total across *all* concurrent
            // pack imports at CONVERT_CONCURRENCY rather than multiplying it.
            await Promise.all(downloads.map(async (result, j) => {
                if (signal?.aborted) return;

                if (result.status === 'rejected') {
                    failedCount++;
                    errors.push(`Sticker ${batch[j].index + 1}: ${result.reason?.message || 'download failed'}`);
                    report(convertedCount, failedCount, 'convert');
                    return;
                }

                const dl = result.value;
                try {
                    const { buffer: converted, type, isAnimated } = await conversionGate.run(
                        () => this.convertToWhatsAppSticker(dl.buffer, dl.emoji, dl.format)
                    );
                    if (signal?.aborted) return;

                    const waBuffer = await this.applyStickerMetadata(converted);
                    results.push({
                        buffer: waBuffer,
                        emoji: dl.emoji,
                        index: dl.index,
                        type,
                        isAnimated: isAnimated || false,
                    });
                    convertedCount++;
                    report(convertedCount, failedCount, 'convert');
                } catch (err) {
                    failedCount++;
                    errors.push(`Sticker ${dl.index + 1} (${dl.emoji}): ${err.message}`);
                    report(convertedCount, failedCount, 'convert');
                } finally {
                    this._cleanup(dl.tempPath);
                }
            }));

            if (signal?.aborted) {
                errors.push('Import cancelled by user');
                break;
            }
        }

        // Parallel conversion finishes out of order — restore pack order.
        results.sort((a, b) => a.index - b.index);

        report(convertedCount, failedCount, 'done');
        return { pack, stickers: results, errors, skipped };
    }

    /**
     * Stamp the bot's default pack/author EXIF onto a sticker, so imported
     * Telegram stickers carry the same attribution as ones the bot makes
     * itself (STICKER_PACK_NAME / STICKER_PACK_AUTHOR).
     *
     * Verified not to disturb the ANIM/ANMF chunks or the alpha channel of an
     * animated WebP — it only appends an EXIF chunk (~210 bytes). Best-effort:
     * a sticker without metadata still beats no sticker.
     */
    async applyStickerMetadata(buffer) {
        const pack = config.STICKER_PACK_NAME || '';
        const author = config.STICKER_PACK_AUTHOR || '';
        if (!pack && !author) return buffer;

        try {
            const WSF = (await import('wa-sticker-formatter')).default;
            const exif = new WSF.Exif({ pack, author });
            const stamped = await exif.add(buffer);
            return stamped?.length ? stamped : buffer;
        } catch (err) {
            logger.warn(`Sticker metadata injection failed: ${err?.message || err}`);
            return buffer;
        }
    }

    _cleanup(filePath) {
        try { fs.unlinkSync(filePath); } catch {}
    }

    /**
     * Sweep abandoned scratch files (e.g. after a crash mid-import).
     *
     * Age-gated deliberately: the temp dir is shared by every concurrent
     * import, so deleting indiscriminately would pull files out from under a
     * pack that is still converting.
     */
    cleanup(maxAgeMs = 30 * 60 * 1000) {
        const cutoff = Date.now() - maxAgeMs;
        let removed = 0;
        try {
            for (const entry of fs.readdirSync(this.tempDir, { withFileTypes: true })) {
                const full = path.join(this.tempDir, entry.name);
                try {
                    if (fs.statSync(full).mtimeMs > cutoff) continue;
                    if (entry.isDirectory()) fs.rmSync(full, { recursive: true, force: true });
                    else fs.unlinkSync(full);
                    removed++;
                } catch {}
            }
        } catch {}
        return removed;
    }
}

export const telegramStickerService = new TelegramStickerService();
export default TelegramStickerService;
