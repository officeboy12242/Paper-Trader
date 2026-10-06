/**
 * Tracks group participant sets to detect new joins (welcome messages).
 */

import { logger } from './logger.js';
import { extractPhoneNumber, normalizePhoneNumber } from './permissions.js';
import { normalizeParticipantEntry } from './welcomeMessage.js';

function participantKeys(p) {
    const keys = new Set();
    if (!p) return keys;

    for (const raw of [p.id, p.lid, p.pn, p.phoneNumber, p.jid]) {
        const jid = normalizeParticipantEntry(raw);
        if (jid) keys.add(jid);
        const phone = normalizePhoneNumber(extractPhoneNumber(jid || raw || ''));
        if (phone) keys.add(phone);
    }

    return keys;
}

function keysForMemberEntry(entry) {
    const keys = new Set();
    const jid = normalizeParticipantEntry(entry);
    if (jid) keys.add(jid);
    const phone = normalizePhoneNumber(extractPhoneNumber(jid || ''));
    if (phone) keys.add(phone);
    return keys;
}

class GroupParticipantSnapshot {
    constructor() {
        /** @type {Map<string, Set<string>>} */
        this._snapshots = new Map();
    }

    /**
     * @param {import('baileys').WASocket} sock
     * @param {string} groupId
     */
    /**
     * @param {import('baileys').WASocket} sock
     * @param {string} groupId
     * @param {object|null} [meta] optional — skip WA fetch when already held
     */
    async seedGroup(sock, groupId, meta = null) {
        if (!groupId?.endsWith('@g.us')) return;
        try {
            const data = meta || (await sock.groupMetadata(groupId));
            const keys = new Set();
            for (const p of data.participants || []) {
                for (const k of participantKeys(p)) keys.add(k);
            }
            this._snapshots.set(groupId, keys);
            logger.debug(`Participant snapshot seeded: ${groupId} (${keys.size} keys)`);
        } catch (err) {
            logger.debug(`Participant snapshot seed failed for ${groupId}: ${err.message}`);
        }
    }

    /**
     * Seed all groups from one groupFetchAllParticipating() result (no N× refetch).
     * @param {Record<string, object>} participating
     */
    seedFromParticipating(participating) {
        if (!participating || typeof participating !== 'object') return 0;
        let n = 0;
        for (const [groupId, meta] of Object.entries(participating)) {
            if (!groupId?.endsWith?.('@g.us') || !meta) continue;
            const keys = new Set();
            for (const p of meta.participants || []) {
                for (const k of participantKeys(p)) keys.add(k);
            }
            this._snapshots.set(groupId, keys);
            n += 1;
        }
        return n;
    }

    /**
     * @param {import('baileys').WASocket} sock
     */
    async seedAllGroups(sock) {
        if (!sock?.groupFetchAllParticipating) return;
        try {
            const groups = await sock.groupFetchAllParticipating();
            const n = this.seedFromParticipating(groups);
            logger.info(`👋 Participant snapshots seeded for ${n} group(s)`);
        } catch (err) {
            logger.warn(`Failed to seed participant snapshots: ${err.message}`);
        }
    }

    /**
     * Seed snapshot if missing (avoids treating every member as new).
     * @param {import('baileys').WASocket} sock
     * @param {string} groupId
     */
    async ensureSeeded(sock, groupId) {
        if (!groupId?.endsWith('@g.us')) return;
        if (this._snapshots.has(groupId) && this._snapshots.get(groupId).size > 0) {
            return;
        }
        await this.seedGroup(sock, groupId);
    }

    /**
     * @param {string} groupId
     * @returns {Set<string>}
     */
    cloneGroupKeys(groupId) {
        const keys = this._snapshots.get(groupId);
        return keys?.size ? new Set(keys) : new Set();
    }

    /**
     * Diff current group members against a frozen pre-join snapshot.
     * @param {import('baileys').WASocket} sock
     * @param {string} groupId
     * @param {Set<string>} baselineKeys
     * @returns {Promise<object[]>}
     */
    async detectNewSince(sock, groupId, baselineKeys) {
        if (!groupId?.endsWith('@g.us') || !baselineKeys?.size) {
            return [];
        }

        const meta = await sock.groupMetadata(groupId);
        const newOnes = [];
        const current = new Set();

        for (const p of meta.participants || []) {
            const keys = participantKeys(p);
            for (const k of keys) current.add(k);

            if (!keys.size) continue;

            const alreadyKnown = [...keys].some((k) => baselineKeys.has(k));
            if (!alreadyKnown) {
                newOnes.push(p);
            }
        }

        this._snapshots.set(groupId, current);
        return newOnes;
    }

    /**
     * @param {import('baileys').WASocket} sock
     * @param {string} groupId
     * @returns {Promise<object[]>} new participant records
     */
    async detectNewParticipants(sock, groupId) {
        if (!groupId?.endsWith('@g.us')) return [];

        const prev = this._snapshots.get(groupId);
        if (!prev || prev.size === 0) {
            await this.seedGroup(sock, groupId);
            return [];
        }

        return this.detectNewSince(sock, groupId, prev);
    }

    /**
     * Refresh snapshot without detecting joins (e.g. after remove).
     * @param {import('baileys').WASocket} sock
     * @param {string} groupId
     */
    async refresh(sock, groupId) {
        await this.seedGroup(sock, groupId);
    }

    /**
     * @param {object[]} participants
     * @returns {Set<string>}
     */
    buildMemberKeySet(participants) {
        const keys = new Set();
        for (const p of participants || []) {
            for (const k of participantKeys(p)) {
                keys.add(k);
            }
        }
        return keys;
    }

    /**
     * @param {string | object} entry
     * @param {Set<string>} memberKeys
     */
    isKeyInMemberSet(entry, memberKeys) {
        if (!memberKeys?.size) {
            return false;
        }
        for (const k of keysForMemberEntry(entry)) {
            if (memberKeys.has(k)) {
                return true;
            }
        }
        return false;
    }
}

export const groupParticipantSnapshot = new GroupParticipantSnapshot();

/**
 * @param {object[]} participants
 * @returns {object[]}
 */
export function dedupeParticipantRecords(participants) {
    const byKey = new Map();

    for (const p of participants || []) {
        const jid = normalizeParticipantEntry(p);
        if (!jid) {
            continue;
        }
        const phone = normalizePhoneNumber(extractPhoneNumber(jid));
        const key = phone ? `p:${phone}` : `j:${jid}`;
        if (!byKey.has(key)) {
            byKey.set(key, p);
        }
    }

    return [...byKey.values()];
}
