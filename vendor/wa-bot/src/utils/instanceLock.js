/**
 * Ensures only one bot instance is active across deploys/restarts.
 * New deploys claim the lock; older instances detect the change and exit.
 */

import crypto from 'crypto';
import os from 'os';
import { logger } from './logger.js';

export class InstanceLock {
    constructor(mongoDb, onLostLock) {
        this.col = mongoDb.collection('bot_instance_lock');
        this.instanceId = crypto.randomUUID();
        this.onLostLock = onLostLock;
        this._heartbeatInterval = null;
        this._isOwner = false;
    }

    async claim() {
        const existing = await this.col.findOne({ _id: 'singleton' });
        if (existing?.instanceId && existing.instanceId !== this.instanceId) {
            const lastBeat = existing.lastHeartbeat ? new Date(existing.lastHeartbeat).getTime() : 0;
            const ageMs = Date.now() - lastBeat;
            if (ageMs < 15000) {
                logger.info(
                    `🔄 Taking over from previous instance (${existing.instanceId.slice(0, 8)}…) — waiting for handoff`
                );
                await new Promise((resolve) => setTimeout(resolve, 3000));
            }
        }

        const doc = {
            instanceId: this.instanceId,
            pid: process.pid,
            hostname: os.hostname(),
            startedAt: new Date(),
            lastHeartbeat: new Date(),
        };

        await this.col.updateOne(
            { _id: 'singleton' },
            { $set: doc },
            { upsert: true }
        );

        this._isOwner = true;
        logger.info(`🔒 Instance lock claimed (${this.instanceId.slice(0, 8)}… pid ${process.pid})`);

        this._heartbeatInterval = setInterval(() => {
            void this._heartbeat();
        }, 5000);
    }

    async _heartbeat() {
        try {
            const lock = await this.col.findOne({ _id: 'singleton' });
            if (!lock || lock.instanceId !== this.instanceId) {
                logger.warn('⚠️ Another bot instance took over — stopping this one');
                this.stop();
                this.onLostLock?.();
                return;
            }

            await this.col.updateOne(
                { _id: 'singleton' },
                { $set: { lastHeartbeat: new Date(), pid: process.pid } }
            );
        } catch (err) {
            logger.warn(`Instance lock heartbeat failed: ${err.message}`);
        }
    }

    async release() {
        this.stop();
        try {
            const lock = await this.col.findOne({ _id: 'singleton' });
            if (lock?.instanceId === this.instanceId) {
                await this.col.deleteOne({ _id: 'singleton' });
                logger.info('🔓 Instance lock released');
            }
        } catch (err) {
            logger.warn(`Instance lock release failed: ${err.message}`);
        }
    }

    stop() {
        this._isOwner = false;
        if (this._heartbeatInterval) {
            clearInterval(this._heartbeatInterval);
            this._heartbeatInterval = null;
        }
    }
}

export default InstanceLock;
