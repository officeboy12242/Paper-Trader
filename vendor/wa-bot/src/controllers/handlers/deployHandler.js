/**
 * Owner-only /deploy command — triggers a redeploy on Render or Koyeb.
 * Status message is persisted and edited after the new instance starts.
 */

import { logger } from '../../utils/logger.js';
import { config } from '../../config/config.js';
import { resolveNotificationJid } from '../../utils/permissions.js';
import {
    deployNotificationService,
    serializeMessageKey,
    buildFailedText,
} from '../../services/DeployNotificationService.js';

const RENDER_API = 'https://api.render.com/v1';
// Koyeb's public REST API is at /v1 (NOT /api/v1 — that path returns the dashboard HTML).
const KOYEB_API = 'https://app.koyeb.com/v1';
const POLL_INTERVAL_MS = 5000;
const MAX_POLL_MS = 30 * 60 * 1000;

// ── Platform detection ──────────────────────────────────────────────
// Koyeb wins when its creds are present: stale Render creds used to shadow
// Koyeb and made /deploy target a Render service that no longer exists.
function detectPlatform() {
    if (config.KOYEB_API_KEY && config.KOYEB_SERVICE_ID) return 'koyeb';
    if (config.RENDER_API_KEY && config.RENDER_SERVICE_ID) return 'render';
    return null;
}

function platformLabel(platform) {
    return platform === 'koyeb' ? 'Koyeb' : 'Render';
}

// ── Render API ──────────────────────────────────────────────────────
async function renderFetch(path, method = 'GET', body = undefined) {
    const res = await fetch(`${RENDER_API}${path}`, {
        method,
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.RENDER_API_KEY}`,
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Render API ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
}

// ── Koyeb API ───────────────────────────────────────────────────────
async function koyebFetch(path, method = 'GET', body = undefined) {
    const res = await fetch(`${KOYEB_API}${path}`, {
        method,
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.KOYEB_API_KEY}`,
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Koyeb API ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
}

// ── Generic helpers ─────────────────────────────────────────────────
async function getLatestCommitMessage() {
    try {
        const res = await fetch('https://api.github.com/repos/officeboy12242/WA-BOT/commits?per_page=1');
        if (!res.ok) return 'unknown';
        const data = await res.json();
        if (!Array.isArray(data) || !data[0]) return 'unknown';
        const msg = data[0].commit?.message?.split('\n')[0] || 'unknown';
        return msg.slice(0, 60);
    } catch {
        return 'unknown';
    }
}

// ── Render polling ──────────────────────────────────────────────────
async function pollRenderStatus(deployId, sock, commitMsg) {
    const startTime = Date.now();

    const poll = async () => {
        try {
            const deploy = await renderFetch(
                `/services/${config.RENDER_SERVICE_ID}/deploys/${deployId}`,
            );

            const status = deploy.status || 'unknown';
            logger.debug(`Render deploy ${deployId} status: ${status}`);

            if (status === 'live') return;

            if (status === 'canceled' || status === 'build_failed' || status === 'deploy_failed') {
                const text = buildFailedText(commitMsg, deployId, status);
                await deployNotificationService.completePendingNow(sock, deployId, commitMsg, text, 'failed');
                return;
            }

            if (Date.now() - startTime > MAX_POLL_MS) {
                const text = buildFailedText(commitMsg, deployId, 'timeout — check Render dashboard');
                await deployNotificationService.completePendingNow(sock, deployId, commitMsg, text, 'failed');
                return;
            }

            setTimeout(poll, POLL_INTERVAL_MS);
        } catch (err) {
            logger.warn(`Render deploy poll failed: ${err.message}`);
            if (Date.now() - startTime < 30000) {
                setTimeout(poll, POLL_INTERVAL_MS);
            }
        }
    };

    poll();
}

// ── Koyeb polling ───────────────────────────────────────────────────
// Koyeb statuses arrive as plain strings ("HEALTHY") in the v1 API — never
// an object with .value. Normalise both shapes to be safe.
function koyebStatus(raw) {
    if (!raw) return 'unknown';
    if (typeof raw === 'string') return raw;
    return raw.value || raw.state || 'unknown';
}

async function pollKoyebStatus(deployId, sock, commitMsg) {
    const startTime = Date.now();
    if (!deployId) return;
    const noDeployId = deployId.startsWith('koyeb-'); // redeploy gave no id — poll the service instead

    const done = async (text, finalStatus) => {
        await deployNotificationService.completePendingNow(sock, deployId, commitMsg, text, finalStatus);
    };

    const poll = async () => {
        try {
            let status;
            if (!noDeployId) {
                // Poll the deployment itself (redeploy response carries its id).
                const dep = await koyebFetch(`/deployments/${deployId}`);
                status = koyebStatus(dep?.deployment?.status);
                logger.debug(`Koyeb deployment ${deployId} status: ${status}`);
            } else {
                const svc = await koyebFetch(`/services/${config.KOYEB_SERVICE_ID}`);
                status = koyebStatus(svc?.service?.status);
                logger.debug(`Koyeb service status: ${status}`);
            }

            // Deployment statuses: STARTING, HEALTHY, ERROR, CANCELED, … (service: HEALTHY)
            if (status === 'HEALTHY' || status === 'RUNNING') {
                await done(buildCompleteText(commitMsg, deployId), 'completed');
                return;
            }

            if (['ERROR', 'CANCELED', 'FAILED', 'SUSPENDED'].includes(status)) {
                await done(buildFailedText(commitMsg, deployId, `deploy ${status.toLowerCase()}`), 'failed');
                return;
            }

            if (Date.now() - startTime > MAX_POLL_MS) {
                await done(buildFailedText(commitMsg, deployId, 'timeout — check Koyeb dashboard'), 'failed');
                return;
            }

            setTimeout(poll, POLL_INTERVAL_MS);
        } catch (err) {
            logger.warn(`Koyeb deploy poll failed: ${err.message}`);
            if (Date.now() - startTime < 30000) {
                setTimeout(poll, POLL_INTERVAL_MS);
            }
        }
    };

    poll();
}

// ── Main handler ────────────────────────────────────────────────────
export async function handleDeploy(sock, chatId, senderJid, originalMsg) {
    const platform = detectPlatform();

    if (!platform) {
        await sock.sendMessage(chatId, {
            text:
                '❌ Deploy not configured.\n\n' +
                'Set one of:\n' +
                '• `RENDER_API_KEY` + `RENDER_SERVICE_ID` (Render)\n' +
                '• `KOYEB_API_KEY` + `KOYEB_SERVICE_ID` (Koyeb)',
        }, { quoted: originalMsg });
        return;
    }

    try {
        const commitMsg = await getLatestCommitMessage();
        const label = platformLabel(platform);
        let deployId;

        if (platform === 'render') {
            deployId = (await renderFetch(
                `/services/${config.RENDER_SERVICE_ID}/deploys`,
                'POST',
                { clearCache: 'do_not_clear' },
            )).id;
        } else {
            // Koyeb — POST to /redeploy triggers a new deploy from the latest commit.
            // The response may carry the new deployment under several field names
            // depending on API version — accept any of them.
            const resp = await koyebFetch(
                `/services/${config.KOYEB_SERVICE_ID}/redeploy`,
                'POST',
            );
            deployId =
                resp?.deploy?.id ||
                resp?.deployment?.id ||
                resp?.service?.latest_deployment_id ||
                resp?.service?.active_deployment_id ||
                `koyeb-${Date.now()}`;
        }

        const startedText = deployNotificationService.buildStartedText(commitMsg, deployId, label);
        const deployMsg = await sock.sendMessage(chatId, { text: startedText }, { quoted: originalMsg });

        const targets = [];
        const primaryKey = serializeMessageKey(deployMsg?.key);
        if (primaryKey) {
            targets.push({ chat_id: chatId, message_key: primaryKey, label: 'request_chat' });
        }

        const logJid = resolveNotificationJid(sock, [
            config.BOT_LOG_NUMBER,
            ...config.OWNER_NUMBERS,
        ].filter(Boolean));

        if (logJid && logJid !== chatId && primaryKey) {
            try {
                const logMsg = await sock.sendMessage(logJid, {
                    text:
                        `${startedText}\n\n` +
                        `📍 _Requested from:_ \`${chatId}\``,
                });
                const logKey = serializeMessageKey(logMsg?.key);
                if (logKey) {
                    targets.push({ chat_id: logJid, message_key: logKey, label: 'bot_log' });
                }
            } catch (err) {
                logger.warn(`Deploy log copy failed: ${err.message}`);
            }
        }

        await deployNotificationService.savePending({
            deployId,
            commitMsg,
            triggeredBy: senderJid,
            targets,
        });

        logger.info(`${label} deploy triggered by ${senderJid}: deploy=${deployId} commit=${commitMsg}`);

        if (platform === 'render') {
            pollRenderStatus(deployId, sock, commitMsg);
        } else {
            pollKoyebStatus(deployId, sock, commitMsg);
        }
    } catch (err) {
        logger.error(`Deploy failed: ${err.message}`);
        await sock.sendMessage(chatId, {
            text: `❌ Deploy failed: ${err.message}`,
        }, { quoted: originalMsg });
    }
}
