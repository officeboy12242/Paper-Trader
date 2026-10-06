/**
 * Persist /deploy status messages across Render restarts — edit on new instance startup.
 */

import { logger } from '../utils/logger.js';
import { editMessageText } from '../utils/waMessage.js';
import { config } from '../config/config.js';

const RENDER_API = 'https://api.render.com/v1';
const MAX_PENDING_AGE_MS = 2 * 60 * 60 * 1000;

function serializeMessageKey(key) {
    if (!key?.id) return null;
    return {
        remoteJid: key.remoteJid,
        id: key.id,
        fromMe: key.fromMe !== false,
        participant: key.participant || undefined,
    };
}

function buildStartedText(commitMsg, deployId, platformLabel = 'Render') {
    return (
        `📤 *${platformLabel} deploy started*\n\n` +
        `💬 *Commit:* ${commitMsg}\n` +
        `🆔 *Deploy:* \`${deployId}\`\n` +
        `🔄 *Status:* Building…\n\n` +
        `_Will update when the new instance is live._`
    );
}

function buildCompleteText(commitMsg, deployId) {
    return (
        `✅ *Deploy complete!*\n\n` +
        `💬 *Commit:* ${commitMsg}\n` +
        `🆔 *Deploy:* \`${deployId}\`\n` +
        `🚀 Bot is live with the latest code.`
    );
}

function buildFailedText(commitMsg, deployId, reason) {
    return (
        `❌ *Deploy failed*\n\n` +
        `💬 *Commit:* ${commitMsg}\n` +
        `🆔 *Deploy:* \`${deployId}\`\n` +
        `⚠️ *Reason:* ${reason}`
    );
}

async function renderFetch(path) {
    if (!config.RENDER_API_KEY) return null;
    const res = await fetch(`${RENDER_API}${path}`, {
        headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${config.RENDER_API_KEY}`,
        },
    });
    if (!res.ok) return null;
    return res.json();
}

class DeployNotificationService {
    constructor() {
        this._collection = null;
    }

    init(mongoDb) {
        if (!mongoDb) return;
        this._collection = mongoDb.collection('deploy_pending_notifications');
        void this._collection.createIndex({ deploy_id: 1 }, { unique: true, name: 'deploy_pending_deploy_id' });
        void this._collection.createIndex({ status: 1, started_at: 1 }, { name: 'deploy_pending_status' });
    }

    buildStartedText(commitMsg, deployId, platformLabel) {
        return buildStartedText(commitMsg, deployId, platformLabel);
    }

    /**
     * @param {object} row
     * @param {string} row.deployId
     * @param {string} row.commitMsg
     * @param {string} row.triggeredBy
     * @param {Array<{ chat_id: string, message_key: object, label?: string }>} row.targets
     */
    async savePending({ deployId, commitMsg, triggeredBy, targets }) {
        if (!this._collection || !deployId) return;

        const cleanTargets = (targets || [])
            .filter((t) => t?.chat_id && t?.message_key?.id)
            .map((t) => ({
                chat_id: t.chat_id,
                message_key: t.message_key,
                label: t.label || 'primary',
            }));

        if (!cleanTargets.length) return;

        await this._collection.updateOne(
            { deploy_id: deployId },
            {
                $set: {
                    deploy_id: deployId,
                    commit_msg: commitMsg,
                    triggered_by: triggeredBy,
                    targets: cleanTargets,
                    status: 'pending',
                    started_at: new Date(),
                },
            },
            { upsert: true }
        );

        logger.info(`Deploy notification saved for ${deployId} (${cleanTargets.length} message(s))`);
    }

    async markCompleted(deployId, finalStatus = 'completed') {
        if (!this._collection || !deployId) return;
        await this._collection.updateOne(
            { deploy_id: deployId },
            { $set: { status: finalStatus, completed_at: new Date() } }
        );
    }

    /**
     * Edit all pending deploy messages after the new instance comes online.
     * @param {import('baileys').WASocket} sock
     */
    async completePendingOnStartup(sock) {
        if (!this._collection || !sock) return;

        const cutoff = new Date(Date.now() - MAX_PENDING_AGE_MS);
        const pending = await this._collection
            .find({ status: 'pending', started_at: { $gte: cutoff } })
            .sort({ started_at: -1 })
            .limit(5)
            .toArray();

        if (!pending.length) return;

        logger.info(`Processing ${pending.length} pending deploy notification(s)…`);

        for (const row of pending) {
            let finalText = buildCompleteText(row.commit_msg || 'unknown', row.deploy_id);

            if (config.RENDER_SERVICE_ID) {
                const deploy = await renderFetch(
                    `/services/${config.RENDER_SERVICE_ID}/deploys/${row.deploy_id}`
                );
                const status = deploy?.status;
                if (status === 'build_failed' || status === 'deploy_failed' || status === 'canceled') {
                    finalText = buildFailedText(row.commit_msg || 'unknown', row.deploy_id, status);
                    await this._editAllTargets(sock, row, finalText);
                    await this.markCompleted(row.deploy_id, 'failed');
                    continue;
                }
            }

            // New instance is running — treat as successful deploy completion.
            await this._editAllTargets(sock, row, finalText);
            await this.markCompleted(row.deploy_id, 'completed');
        }
    }

    /**
     * Edit tracked messages from the still-running instance (failures before restart).
     */
    async completePendingNow(sock, deployId, commitMsg, text, finalStatus = 'completed') {
        if (!this._collection) return;

        const row = await this._collection.findOne({ deploy_id: deployId });
        if (row?.targets?.length) {
            await this._editAllTargets(sock, row, text);
        }
        await this.markCompleted(deployId, finalStatus);
    }

    async _editAllTargets(sock, row, text) {
        for (const target of row.targets || []) {
            try {
                await editMessageText(sock, target.chat_id, target.message_key, text);
                logger.info(`Deploy notice updated (${target.label || 'primary'}): ${row.deploy_id}`);
            } catch (err) {
                logger.warn(`Deploy notice edit failed (${target.label}): ${err.message}`);
            }
        }
    }
}

export const deployNotificationService = new DeployNotificationService();
export { serializeMessageKey, buildCompleteText, buildFailedText };
export default DeployNotificationService;
