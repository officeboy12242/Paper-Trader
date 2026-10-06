/**
 * Instagram download handler
 */

import { fileTypeFromBuffer, fileTypeFromFile } from 'file-type';
import { snapsave } from 'snapsave-media-downloader';
import { logger } from '../../utils/logger.js';
import { downloadMediaToFile, createMediaTempFile } from '../../utils/downloadMediaToFile.js';
import { createReadStream, promises as fsp } from 'fs';
import { extractInstagramUrl, isSupportedInstagramUrl } from '../../utils/instagramUrl.js';
import { extractTwitterUrl, isSupportedTwitterUrl } from '../../utils/twitterUrl.js';
import { fetchTwitterMedia } from '../../utils/twitterMedia.js';
import { safeSendMessage } from '../../utils/waMessage.js';

// Media caps: WhatsApp plays videos as media up to ~64 MB; anything bigger is
// sent as a document (WhatsApp allows up to 2 GB). MEDIA_MAX_BYTES is the
// download cap — tune it down on small-RAM Render instances.
const MAX_MEDIA_BYTES = parseInt(process.env.MEDIA_MAX_BYTES || String(300 * 1024 * 1024), 10) || (300 * 1024 * 1024);
const MEDIA_AS_VIDEO_BYTES = 60 * 1024 * 1024;

// The snapsave upstream can hang for minutes under load — never let the
// "⏳ Fetching…" status sit forever; bail with a friendly error instead.
const SNAPSAVE_TIMEOUT_MS = 30_000;

/**
 * Resolvers return `[{ url, type, gif? }]`. A resolver that throws — or returns
 * nothing usable — hands over to the next one in the chain.
 */
async function snapsaveResolver(url) {
    const result = await Promise.race([
        snapsave(url, { retry: 2, retryDelay: 800 }),
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Upstream media service timed out')), SNAPSAVE_TIMEOUT_MS),
        ),
    ]);
    if (!result?.success) {
        throw new Error(result?.message || 'Unknown error.');
    }
    return result.data?.media || [];
}
snapsaveResolver.resolverName = 'snapsave';

async function twitterApiResolver(url) {
    return fetchTwitterMedia(url);
}
twitterApiResolver.resolverName = 'fxtwitter';

async function resolveMediaList(url, resolvers, logLabel) {
    let lastMessage = '';
    for (const resolver of resolvers) {
        const name = resolver.resolverName || 'resolver';
        try {
            const media = [];
            const seen = new Set();
            for (const m of await resolver(url)) {
                // snapsave emits blank-url placeholders for GIF tweets — drop them
                // so the chain falls through instead of reporting "no media".
                if (!m?.url || seen.has(m.url)) continue;
                seen.add(m.url);
                media.push(m);
            }
            if (media.length) {
                return { media, message: '' };
            }
            lastMessage = lastMessage || 'No media URLs in the response.';
            logger.warn(`${logLabel}: ${name} returned no usable media for ${url}`);
        } catch (err) {
            lastMessage = err.message || 'Unknown error.';
            logger.warn(`${logLabel}: ${name} failed — ${lastMessage}`);
        }
    }
    return { media: [], message: lastMessage || 'Unknown error.' };
}

function formatInstaDownloadStatus(mediaList) {
    const images = mediaList.filter((m) => m.type === 'image').length;
    const videos = mediaList.filter((m) => m.type === 'video').length;
    const total = mediaList.length;

    if (images && videos) return `⏳ Downloading *${images}* image(s) and *${videos}* video(s)…\n_Please wait._`;
    if (videos) return `⏳ Downloading *${videos}* video(s)…\n_Please wait._`;
    if (images) return `⏳ Downloading *${images}* image(s)…\n_Please wait._`;
    return `⏳ Downloading *${total}* item(s)…\n_Please wait._`;
}

function formatInstaSuccessText(sentCount, total, failedCount) {
    if (failedCount > 0) {
        return (
            `✅ Downloaded *${sentCount}/${total}* item(s) successfully.\n` +
            `_${failedCount} item(s) could not be downloaded._`
        );
    }
    const label = sentCount === 1 ? 'item' : 'items';
    return `✅ Downloaded and sent *${sentCount}* ${label} successfully.`;
}

async function safeDeleteChatMessage(sock, chatId, waMessage) {
    const key = waMessage?.key;
    if (!key) return;
    try {
        await sock.sendMessage(chatId, { delete: key });
    } catch (err) {
        logger.warn(`Could not delete status message: ${err.message}`);
    }
}

async function classifyMediaBuffer(buffer) {
    const type = await fileTypeFromBuffer(buffer);
    if (!type) return { kind: 'other', mime: 'application/octet-stream', ext: 'bin' };
    const mime = type.mime;
    const kind = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'other';
    return { kind, mime, ext: type.ext };
}

async function sendLargeMediaAsDocument(sock, chatId, filePath, waMessage, fileNameBase) {
    let detected = null;
    try {
        detected = await fileTypeFromFile(filePath);
    } catch {
        detected = null;
    }
    const mime = detected?.mime || 'video/mp4';
    const ext = detected?.ext || 'mp4';
    return safeSendMessage(
        sock,
        chatId,
        {
            document: {
                stream: createReadStream(filePath),
                mimetype: mime,
                fileName: `${fileNameBase}.${ext}`,
                caption: '📹 Large media (sent as document — WhatsApp media cap is ~64 MB)',
            },
        },
        waMessage,
        { sendTimeoutMs: 600000 },
    );
}

async function sendDownloadedMedia(sock, chatId, buffer, waMessage, index, fileNamePrefix = 'instagram', isGif = false) {
    const detected = await classifyMediaBuffer(buffer);
    if (detected.kind === 'video') {
        // X serves GIFs as mp4 — gifPlayback makes WhatsApp loop them silently.
        await safeSendMessage(
            sock,
            chatId,
            { video: buffer, mimetype: detected.mime, ...(isGif ? { gifPlayback: true } : {}) },
            waMessage,
        );
        return true;
    }
    if (detected.kind === 'image') {
        await safeSendMessage(sock, chatId, { image: buffer, mimetype: detected.mime }, waMessage);
        return true;
    }
    await safeSendMessage(
        sock,
        chatId,
        { document: buffer, mimetype: detected.mime, fileName: `${fileNamePrefix}_${index + 1}.${detected.ext || 'bin'}` },
        waMessage,
    );
    return true;
}

async function handleMediaDownload(sock, chatId, args, quotedMessage, opts) {
    const {
        requireCommandArgs = true,
        usage,
        unsupported,
        statusText,
        extractUrl,
        isSupported,
        fileNamePrefix,
        logLabel,
        resolvers = [snapsaveResolver],
    } = opts;

    if (requireCommandArgs && !args.length) {
        await safeSendMessage(sock, chatId, { text: usage }, quotedMessage);
        return;
    }

    let url = extractUrl(args.join(' ').trim()) || (args[0] || '').trim();
    if (!isSupported(url)) {
        await safeSendMessage(sock, chatId, { text: unsupported }, quotedMessage);
        return;
    }

    let statusMsg = null;
    try {
        statusMsg = await safeSendMessage(sock, chatId, { text: statusText }, quotedMessage);

        const { media: mediaList, message: resolveMessage } = await resolveMediaList(url, resolvers, logLabel);

        if (!mediaList.length) {
            await safeDeleteChatMessage(sock, chatId, statusMsg);
            statusMsg = null;
            await safeSendMessage(
                sock,
                chatId,
                { text: `Could not fetch media. ${resolveMessage}` },
                quotedMessage,
            );
            return;
        }

        await safeDeleteChatMessage(sock, chatId, statusMsg);
        statusMsg = await safeSendMessage(sock, chatId, { text: formatInstaDownloadStatus(mediaList) }, quotedMessage);

        const total = mediaList.length;
        let sentCount = 0;
        let failedCount = 0;
        for (let i = 0; i < total; i++) {
            const tmpPath = createMediaTempFile('twdl_');
            try {
                await downloadMediaToFile(mediaList[i].url, tmpPath, { maxBytes: MAX_MEDIA_BYTES });
                const size = (await fsp.stat(tmpPath)).size;
                if (size <= MEDIA_AS_VIDEO_BYTES) {
                    const buffer = await fsp.readFile(tmpPath);
                    await sendDownloadedMedia(sock, chatId, buffer, null, i, fileNamePrefix, mediaList[i].gif === true);
                } else {
                    await sendLargeMediaAsDocument(sock, chatId, tmpPath, quotedMessage, `${fileNamePrefix}_${i + 1}`);
                }
                sentCount++;
            } catch (err) {
                failedCount++;
                logger.warn(`${logLabel} item ${i + 1}/${total} failed: ${err.message}`);
            } finally {
                await fsp.rm(tmpPath, { force: true }).catch(() => {});
            }
            await new Promise((r) => setTimeout(r, 1000));
        }

        await safeDeleteChatMessage(sock, chatId, statusMsg);
        statusMsg = null;

        if (!sentCount) {
            await safeSendMessage(
                sock,
                chatId,
                { text: 'Found media links but could not download any item. Try again later.' },
                quotedMessage,
            );
            return;
        }

        await safeSendMessage(
            sock,
            chatId,
            { text: formatInstaSuccessText(sentCount, total, failedCount) },
            quotedMessage,
        );
        logger.info(`${logLabel}: sent ${sentCount}/${total} item(s) for ${chatId}`);
    } catch (err) {
        logger.error(`${logLabel} command error: ${err.message}`);
        await safeSendMessage(
            sock,
            chatId,
            { text: 'Something went wrong (private post, bad link, or upstream error). Try another URL.' },
            quotedMessage,
        );
    } finally {
        if (statusMsg?.key) {
            await safeDeleteChatMessage(sock, chatId, statusMsg);
        }
    }
}

export async function handleInsta(sock, chatId, args, quotedMessage, options = {}) {
    await handleMediaDownload(sock, chatId, args, quotedMessage, {
        ...options,
        usage:
            'Usage: `/insta <instagram-url>` (alias `/i`)\n' +
            'Example: `/insta https://www.instagram.com/p/xxxxx/`\n\n' +
            'In a private chat you can also paste an Instagram link without a command.',
        unsupported: 'Only Instagram post/reel/TV/share links from instagram.com are supported.',
        statusText: '⏳ Fetching Instagram media…\n_This may take a few seconds._',
        extractUrl: extractInstagramUrl,
        isSupported: isSupportedInstagramUrl,
        fileNamePrefix: 'instagram',
        logLabel: 'Insta',
    });
}

export async function handleTwitter(sock, chatId, args, quotedMessage, options = {}) {
    await handleMediaDownload(sock, chatId, args, quotedMessage, {
        ...options,
        usage:
            'Usage: `/tw <twitter-url>` (alias `/twitter`)\n' +
            'Example: `/tw https://x.com/user/status/123456789`',
        unsupported: 'Only Twitter/X post links from twitter.com / x.com (with a status ID) are supported.',
        statusText: '⏳ Fetching Twitter/X media…\n_This may take a few seconds._',
        extractUrl: extractTwitterUrl,
        isSupported: isSupportedTwitterUrl,
        fileNamePrefix: 'twitter',
        logLabel: 'Twitter',
        // fxtwitter first: it resolves GIFs and /i/status/ links that snapsave
        // returns blank entries for. snapsave stays as the fallback.
        resolvers: [twitterApiResolver, snapsaveResolver],
    });
}

export async function handleNews(sock, chatId, senderJid, { newsController, groupManager }) {
    try {
        if (!newsController) {
            await sock.sendMessage(chatId, { text: 'Tech news is not configured on this bot.' });
            return;
        }

        const articles = await newsController.fetchFreshArticles();
        if (!articles.length) {
            await sock.sendMessage(chatId, { text: '📭 No fresh tech news right now. Try again later.' });
            return;
        }

        const sent = await newsController.previewNews(sock, chatId, articles);
        logger.info(`News preview (${sent} msg) sent to ${chatId}`);

        const canPost = await groupManager.canManualPostNews(senderJid);
        if (!canPost) return;

        const { posted, groups } = await newsController.postNews(sock, articles);
        if (groups === 0) {
            await sock.sendMessage(chatId, {
                text: 'ℹ️ Preview only — no groups with tech news enabled. Use `/activate` and `/newson` in a group first.',
            });
            return;
        }

        await sock.sendMessage(chatId, {
            text:
                posted > 0
                    ? `✅ Posted *${sent}* tech news message(s) to *${posted}* group(s) with news enabled.`
                    : 'ℹ️ News was already posted to all news-enabled groups.',
        });
    } catch (error) {
        logger.error(`Error handling news command: ${error.message}`);
        await sock.sendMessage(chatId, { text: 'Could not fetch tech news right now. Try again later.' });
    }
}

const GITHUB_POST_CONFIRM_MS = 2 * 60 * 1000;

export function createGithubPostSessionStore() {
    return new Map();
}

function githubSessionKey(chatId, senderJid) {
    return `${chatId}:${senderJid}`;
}

export async function handleGithub(sock, chatId, senderJid, { githubTrendingController, groupManager, pendingGithubPosts }) {
    try {
        if (!githubTrendingController) {
            await sock.sendMessage(chatId, { text: 'GitHub repos are not configured on this bot.' });
            return;
        }

        const repos = await githubTrendingController.fetchTrendingRepos();
        if (!repos.length) {
            await sock.sendMessage(chatId, { text: '📭 No GitHub repos found right now. Try again later.' });
            return;
        }

        const previewRepos = await githubTrendingController.filterUnpostedRepos(repos, chatId);
        const toPreview = (previewRepos.length ? previewRepos : repos).slice(0, 5);

        const { sent } = await githubTrendingController.previewAll(sock, chatId, toPreview);
        logger.info(`GitHub preview (${sent} repo(s)) sent to ${chatId}`);

        if (!sent) {
            await sock.sendMessage(chatId, {
                text: 'ℹ️ These repos were already sent here. Try again later for fresh picks.',
            });
            return;
        }

        const canPost = await groupManager.canManualPostNews(senderJid);
        if (!canPost) {
            return;
        }

        const githubGroups = await groupManager.getGithubTrendingGroups();
        if (!githubGroups.length) {
            await sock.sendMessage(chatId, {
                text: 'ℹ️ Preview only — no groups with GitHub enabled. Use `/activate` and `/githubon` first.',
            });
            return;
        }

        const freshRepos = await githubTrendingController.selectFreshRepos(repos);
        if (!freshRepos.length) {
            await sock.sendMessage(chatId, {
                text: 'ℹ️ All fetched repos were already posted to github-enabled groups.',
            });
            return;
        }

        if (pendingGithubPosts) {
            const key = githubSessionKey(chatId, senderJid);
            pendingGithubPosts.set(key, {
                // Store the confirmed fresh set — not the full fetch (preview must not poison this)
                repos: freshRepos,
                expiresAt: Date.now() + GITHUB_POST_CONFIRM_MS,
            });
        }

        await sock.sendMessage(chatId, {
            text:
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'
                + '🐙 *POST THESE REPOS?*\n'
                + '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n'
                + `📢 *${freshRepos.length}* fresh repo(s) ready for *${githubGroups.length}* GitHub-enabled group(s).\n\n`
                + 'Reply *yes* to post · *no* to cancel\n'
                + '⏱️ Expires in 2 minutes',
        });
    } catch (error) {
        logger.error(`Error handling github command: ${error.message}`);
        await sock.sendMessage(chatId, { text: 'Could not fetch GitHub repos right now. Try again later.' });
    }
}

export async function handlePendingGithubConfirmation(sock, chatId, senderJid, text, ctx) {
    const { pendingGithubPosts, githubTrendingController } = ctx;
    if (!pendingGithubPosts || !githubTrendingController) {
        return false;
    }

    const key = githubSessionKey(chatId, senderJid);
    const session = pendingGithubPosts.get(key);
    if (!session) {
        return false;
    }

    if (Date.now() > session.expiresAt) {
        pendingGithubPosts.delete(key);
        await sock.sendMessage(chatId, { text: '⏱️ GitHub post request expired. Run `/github` again.' });
        return true;
    }

    const reply = text.trim().toLowerCase();
    if (['no', 'n', 'cancel'].includes(reply)) {
        pendingGithubPosts.delete(key);
        await sock.sendMessage(chatId, { text: '❌ GitHub post cancelled.' });
        return true;
    }

    if (!['yes', 'y', 'post', 'confirm'].includes(reply)) {
        return false;
    }

    pendingGithubPosts.delete(key);

    try {
        const freshRepos = await githubTrendingController.selectFreshRepos(session.repos);
        if (!freshRepos.length) {
            await sock.sendMessage(chatId, {
                text: 'ℹ️ All repos were already posted. Run `/github` again for fresh picks.',
            });
            return true;
        }

        const { posted, messages } = await githubTrendingController.postAllReposIndividually(sock, freshRepos);
        if (messages > 0) {
            await sock.sendMessage(chatId, {
                text: `✅ Posted *${messages}* GitHub repo(s) across *${posted}* group(s).`,
            });
        } else {
            await sock.sendMessage(chatId, { text: 'ℹ️ Could not post to any GitHub-enabled groups.' });
        }
    } catch (error) {
        logger.error(`GitHub post confirmation failed: ${error.message}`);
        await sock.sendMessage(chatId, { text: '⚠️ Failed to post GitHub repos. Try `/github` again.' });
    }

    return true;
}

const AWESOME_POST_CONFIRM_MS = 2 * 60 * 1000;

export function createAwesomePostSessionStore() {
    return new Map();
}

function awesomeSessionKey(chatId, senderJid) {
    return `${chatId}:${senderJid}`;
}

export async function handleAwesome(sock, chatId, senderJid, { awesomeListsController, groupManager, pendingAwesomePosts }) {
    try {
        if (!awesomeListsController) {
            await sock.sendMessage(chatId, { text: 'Awesome lists are not configured on this bot.' });
            return;
        }

        const lists = await awesomeListsController.fetchPreviewLists();
        if (!lists.length) {
            await sock.sendMessage(chatId, { text: '📭 No awesome lists found right now. Try again later.' });
            return;
        }

        const previewLists = await awesomeListsController.filterUnpostedLists(lists, chatId);
        const toPreview = (previewLists.length ? previewLists : lists).slice(0, 5);

        const { sent } = await awesomeListsController.previewAll(sock, chatId, toPreview);
        logger.info(`Awesome preview (${sent} list(s)) sent to ${chatId}`);

        if (!sent) {
            await sock.sendMessage(chatId, {
                text: 'ℹ️ These lists were already sent here. Try again later for fresh picks.',
            });
            return;
        }

        const canPost = await groupManager.canManualPostNews(senderJid);
        if (!canPost) {
            return;
        }

        const awesomeGroups = await groupManager.getAwesomeListsGroups();
        if (!awesomeGroups.length) {
            await sock.sendMessage(chatId, {
                text: 'ℹ️ Preview only — no groups with awesome lists enabled. Use `/activate` and `/awesomeon` first.',
            });
            return;
        }

        const freshLists = await awesomeListsController.selectFreshLists(lists);
        if (!freshLists.length) {
            await sock.sendMessage(chatId, {
                text: 'ℹ️ All fetched lists were already posted to awesome-enabled groups.',
            });
            return;
        }

        if (pendingAwesomePosts) {
            pendingAwesomePosts.set(awesomeSessionKey(chatId, senderJid), {
                lists,
                expiresAt: Date.now() + AWESOME_POST_CONFIRM_MS,
            });
        }

        await sock.sendMessage(chatId, {
            text:
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'
                + '⭐ *POST THESE AWESOME LISTS?*\n'
                + '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n'
                + `📢 *${freshLists.length}* fresh list(s) ready for *${awesomeGroups.length}* awesome-enabled group(s).\n\n`
                + 'Reply *yes* to post · *no* to cancel\n'
                + '⏱️ Expires in 2 minutes',
        });
    } catch (error) {
        logger.error(`Error handling awesome command: ${error.message}`);
        await sock.sendMessage(chatId, { text: 'Could not fetch awesome lists right now. Try again later.' });
    }
}

export async function handlePendingAwesomeConfirmation(sock, chatId, senderJid, text, ctx) {
    const { pendingAwesomePosts, awesomeListsController } = ctx;
    if (!pendingAwesomePosts || !awesomeListsController) {
        return false;
    }

    const key = awesomeSessionKey(chatId, senderJid);
    const session = pendingAwesomePosts.get(key);
    if (!session) {
        return false;
    }

    if (Date.now() > session.expiresAt) {
        pendingAwesomePosts.delete(key);
        await sock.sendMessage(chatId, { text: '⏱️ Awesome post request expired. Run `/awesome` again.' });
        return true;
    }

    const reply = text.trim().toLowerCase();
    if (['no', 'n', 'cancel'].includes(reply)) {
        pendingAwesomePosts.delete(key);
        await sock.sendMessage(chatId, { text: '❌ Awesome post cancelled.' });
        return true;
    }

    if (!['yes', 'y', 'post', 'confirm'].includes(reply)) {
        return false;
    }

    pendingAwesomePosts.delete(key);

    try {
        const freshLists = await awesomeListsController.selectFreshLists(session.lists);
        if (!freshLists.length) {
            await sock.sendMessage(chatId, {
                text: 'ℹ️ All lists were already posted. Run `/awesome` again for fresh picks.',
            });
            return true;
        }

        const { posted, messages } = await awesomeListsController.postAllListsIndividually(sock, freshLists);
        if (messages > 0) {
            await sock.sendMessage(chatId, {
                text: `✅ Posted *${messages}* awesome list(s) across *${posted}* group(s).`,
            });
        } else {
            await sock.sendMessage(chatId, { text: 'ℹ️ Could not post to any awesome-enabled groups.' });
        }
    } catch (error) {
        logger.error(`Awesome post confirmation failed: ${error.message}`);
        await sock.sendMessage(chatId, { text: '⚠️ Failed to post awesome lists. Try `/awesome` again.' });
    }

    return true;
}
