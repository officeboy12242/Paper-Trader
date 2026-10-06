/**
 * Group Manager Model
 * Handles active groups and admin management
 */

import { jidNormalizedUser } from 'baileys';
import { logger } from '../utils/logger.js';
import { extractPhoneNumber, normalizePhoneNumber, getBotAccountPhone } from '../utils/permissions.js';
import { normalizeDiscoverySource, DISCOVERY_SOURCES } from '../utils/discoverySource.js';

function participantToPhone(participant) {
    if (!participant) {
        return '';
    }
    const fromPn = extractPhoneNumber(participant.phoneNumber || participant.pn || '');
    if (/^\d{10,15}$/.test(fromPn)) {
        return fromPn;
    }
    const fromId = extractPhoneNumber(participant.id || '');
    if (/^\d{10,15}$/.test(fromId)) {
        return fromId;
    }
    return fromId || fromPn;
}

/** Group metadata is expensive for 700+ member groups — cache aggressively. */
const GROUP_META_TTL_MS = 15 * 60_000;
const ADMIN_STATUS_TTL_MS = 10 * 60_000;
const BOT_ROLE_TTL_MS = 3 * 60_000;

function buildAdminIndex(participants) {
    /** @type {Map<string, boolean>} */
    const index = new Map();
    /** @type {Map<string, string>} */
    const phoneByKey = new Map();
    for (const p of participants || []) {
        const isAdmin = p.admin === 'admin' || p.admin === 'superadmin';
        const phone = normalizePhoneNumber(participantToPhone(p));
        const keys = [
            p.id,
            p.lid,
            p.pn,
            p.phoneNumber,
            phone,
            String(p.id || '').split('@')[0],
            String(p.lid || '').split('@')[0],
        ].filter(Boolean);
        for (const key of keys) {
            const k = String(key);
            index.set(k, isAdmin);
            if (phone) phoneByKey.set(k, phone);
        }
    }
    return { adminIndex: index, phoneByKey };
}

class GroupManager {
    constructor(mongoDb) {
        this.mongoDb = mongoDb;
        this.groups = null;
        this.admins = null;
        this.ownerNumbers = [];
        this.moderatorNumbers = [];
        /** @type {Map<string, { data: object, at: number, adminIndex: Map<string, boolean> }>} */
        this.groupMetaCache = new Map();
        /** @type {Map<string, Promise<object>>} */
        this.groupMetaInflight = new Map();
        /** @type {Map<string, { isAdmin: boolean, at: number }>} */
        this.senderAdminCache = new Map();
        /** @type {Map<string, { value: boolean, at: number }>} */
        this.botAdminCache = new Map();
        /** @type {Map<string, { value: boolean, at: number }>} */
        this.dynamicModCache = new Map();
    }

    async init() {
        this.groups = this.mongoDb.collection('active_groups');
        this.admins = this.mongoDb.collection('admins');
        await Promise.all([
            this.groups.createIndex(
                { group_id: 1 },
                { unique: true, name: 'active_group_id' }
            ),
            this.admins.createIndex(
                { phone_number: 1 },
                { unique: true, name: 'admin_phone_number' }
            ),
        ]);
        logger.info('Mongo group manager store ready');
    }

    // ─── Admin Management ─────────────────────────────────────────────────────

    setOwnerNumbers(ownerNumbers) {
        this.ownerNumbers = ownerNumbers || [];
    }

    setModeratorNumbers(moderatorNumbers) {
        this.moderatorNumbers = moderatorNumbers || [];
    }

    isOwner(phoneNumber) {
        const normalized = normalizePhoneNumber(phoneNumber);
        return this.ownerNumbers.some(
            (owner) => normalizePhoneNumber(owner) === normalized
        );
    }

    isModerator(phoneNumber) {
        const normalized = normalizePhoneNumber(phoneNumber);
        return this.moderatorNumbers.some(
            (mod) => normalizePhoneNumber(mod) === normalized
        );
    }

    async isModeratorAsync(phoneNumber) {
        if (this.isModerator(phoneNumber)) return true;
        return this.isDynamicModerator(phoneNumber);
    }

    async findBotAdminRecord(phoneNumber) {
        const normalized = normalizePhoneNumber(phoneNumber);
        if (!normalized || !this.admins) {
            return null;
        }

        const exact = await this.admins.findOne({ phone_number: normalized });
        if (exact) {
            return exact;
        }

        const suffix = new RegExp(`${normalized}$`);
        return this.admins.findOne({ phone_number: { $regex: suffix } });
    }

    async isBotAdmin(phoneNumber) {
        const normalized = normalizePhoneNumber(phoneNumber);
        if (!normalized) return false;
        const cached = this.botAdminCache.get(normalized);
        if (cached && Date.now() - cached.at < BOT_ROLE_TTL_MS) {
            return cached.value;
        }
        const value = Boolean(await this.findBotAdminRecord(normalized));
        this._setBoundedCache(this.botAdminCache, normalized, { value, at: Date.now() }, 500);
        return value;
    }

    _setBoundedCache(map, key, value, maxSize) {
        if (map.size >= maxSize) {
            const oldest = map.keys().next().value;
            if (oldest !== undefined) map.delete(oldest);
        }
        map.set(key, value);
    }

    /** Drop cached WA group metadata (call on participant join/leave/promote). */
    invalidateGroupMeta(groupId) {
        if (!groupId) return;
        const id = jidNormalizedUser(String(groupId).replace(/:\d+(?=@)/, '')) || groupId;
        this.groupMetaCache.delete(id);
        this.groupMetaCache.delete(groupId);
        this.groupMetaInflight.delete(id);
        this.groupMetaInflight.delete(groupId);
        for (const key of [...this.senderAdminCache.keys()]) {
            if (key.startsWith(`${id}:`) || key.startsWith(`${groupId}:`)) {
                this.senderAdminCache.delete(key);
            }
        }
    }

    invalidateBotRoleCaches(phoneNumber = '') {
        if (!phoneNumber) {
            this.botAdminCache.clear();
            this.dynamicModCache.clear();
            return;
        }
        const phone = normalizePhoneNumber(phoneNumber);
        this.botAdminCache.delete(phone);
        this.dynamicModCache.delete(phone);
    }

    /** Owners, moderators (env + dynamic), or DB bot admins — can add/remove other bot admins */
    async canManageBotAdmins(senderJid) {
        const phoneNumber = normalizePhoneNumber(extractPhoneNumber(senderJid));
        if (!phoneNumber) {
            return false;
        }
        if (this.isOwner(phoneNumber) || this.isModerator(phoneNumber)) {
            return true;
        }
        if (await this.isDynamicModerator(phoneNumber)) {
            return true;
        }
        return this.isBotAdmin(phoneNumber);
    }

    async canManageBotAdminsAsync(senderJid) {
        return this.canManageBotAdmins(senderJid);
    }

    async getGroupMetadataCached(sock, groupId) {
        const id = jidNormalizedUser(String(groupId || '').replace(/:\d+(?=@)/, '')) || groupId;
        const cached = this.groupMetaCache.get(id) || this.groupMetaCache.get(groupId);
        if (cached && Date.now() - cached.at < GROUP_META_TTL_MS) {
            return cached.data;
        }

        // Deduplicate concurrent metadata fetches (big groups: one WA call, many waiters)
        const inflightKey = id || groupId;
        const existing = this.groupMetaInflight.get(inflightKey);
        if (existing) {
            return existing;
        }

        const fetchPromise = (async () => {
            const data = await sock.groupMetadata(groupId);
            const { adminIndex, phoneByKey } = buildAdminIndex(data.participants || []);
            const entry = { data, at: Date.now(), adminIndex, phoneByKey };
            if (this.groupMetaCache.size > 100) {
                const oldest = this.groupMetaCache.keys().next().value;
                if (oldest !== undefined) this.groupMetaCache.delete(oldest);
            }
            this.groupMetaCache.set(id, entry);
            if (groupId !== id) this.groupMetaCache.set(groupId, entry);
            return data;
        })();

        this.groupMetaInflight.set(inflightKey, fetchPromise);
        try {
            return await fetchPromise;
        } finally {
            this.groupMetaInflight.delete(inflightKey);
        }
    }

    /**
     * Warm meta cache from groupFetchAllParticipating() — avoids N× groupMetadata in big groups.
     * @param {Record<string, object>} participating
     */
    warmMetaFromParticipating(participating) {
        if (!participating || typeof participating !== 'object') return 0;
        const now = Date.now();
        let n = 0;
        for (const [groupId, data] of Object.entries(participating)) {
            if (!groupId?.endsWith?.('@g.us') || !data) continue;
            const id = jidNormalizedUser(String(groupId).replace(/:\d+(?=@)/, '')) || groupId;
            const { adminIndex, phoneByKey } = buildAdminIndex(data.participants || []);
            const entry = { data, at: now, adminIndex, phoneByKey };
            this.groupMetaCache.set(id, entry);
            if (groupId !== id) this.groupMetaCache.set(groupId, entry);
            n += 1;
        }
        return n;
    }

    /** O(1) phone lookup from cached participant index. */
    async resolveParticipantPhoneCached(sock, groupId, jid) {
        if (!groupId?.endsWith('@g.us') || !jid) return '';
        const direct = normalizePhoneNumber(extractPhoneNumber(jid));
        if (direct) return direct;
        try {
            await this.getGroupMetadataCached(sock, groupId);
            const id = jidNormalizedUser(String(groupId).replace(/:\d+(?=@)/, '')) || groupId;
            const entry = this.groupMetaCache.get(id) || this.groupMetaCache.get(groupId);
            const keys = [
                jid,
                jidNormalizedUser(String(jid).replace(/:\d+(?=@)/, '')) || '',
                String(jid).split('@')[0],
            ].filter(Boolean);
            for (const key of keys) {
                const phone = entry?.phoneByKey?.get(key);
                if (phone) return phone;
            }
        } catch {
            // ignore
        }
        return '';
    }

    _lookupAdminIndex(adminIndex, senderJid, phoneNumber) {
        if (!adminIndex) return null;
        const keys = [
            senderJid,
            phoneNumber,
            normalizePhoneNumber(phoneNumber),
            extractPhoneNumber(senderJid),
            String(senderJid || '').split('@')[0],
        ].filter(Boolean);
        for (const key of keys) {
            if (adminIndex.has(key)) {
                return adminIndex.get(key);
            }
        }
        return null;
    }

    /**
     * Member counts for all groups the bot participates in (one WA fetch).
     * @param {import('baileys').WASocket} sock
     * @returns {Promise<Map<string, number>>}
     */
    async getParticipatingGroupMemberCounts(sock) {
        /** @type {Map<string, number>} */
        const counts = new Map();
        if (!sock?.groupFetchAllParticipating) {
            return counts;
        }
        try {
            const participating = await sock.groupFetchAllParticipating();
            for (const [groupId, meta] of Object.entries(participating)) {
                const size = meta.participants?.length ?? meta.size;
                if (typeof size === 'number' && size >= 0) {
                    counts.set(groupId, size);
                }
            }
        } catch (error) {
            logger.error(`Failed to fetch group member counts: ${error.message}`);
        }
        return counts;
    }

    formatMemberCount(memberCounts, groupId) {
        const count = memberCounts.get(groupId);
        return typeof count === 'number' ? String(count) : '—';
    }

    /** Fast group subject (uses metadata cache). */
    async getGroupSubject(sock, groupId) {
        try {
            const meta = await this.getGroupMetadataCached(sock, groupId);
            return meta?.subject || 'Unknown Group';
        } catch {
            return 'Unknown Group';
        }
    }

    async isGroupAdmin(sock, groupId, phoneNumber) {
        try {
            const normalized = normalizePhoneNumber(phoneNumber);
            const cacheKey = `${groupId}:phone:${normalized}`;
            const cached = this.senderAdminCache.get(cacheKey);
            if (cached && Date.now() - cached.at < ADMIN_STATUS_TTL_MS) {
                return cached.isAdmin;
            }

            await this.getGroupMetadataCached(sock, groupId);
            const entry = this.groupMetaCache.get(groupId)
                || this.groupMetaCache.get(jidNormalizedUser(String(groupId).replace(/:\d+(?=@)/, '')) || groupId);
            const indexed = this._lookupAdminIndex(entry?.adminIndex, '', normalized);
            if (indexed !== null) {
                this._setBoundedCache(this.senderAdminCache, cacheKey, { isAdmin: indexed, at: Date.now() }, 2000);
                return indexed;
            }

            // Fallback scan (rare)
            const groupMetadata = entry?.data;
            const participant = (groupMetadata?.participants || []).find((p) => {
                const participantPhone = normalizePhoneNumber(participantToPhone(p));
                return (
                    participantPhone === normalized ||
                    p.id?.includes(normalized) ||
                    p.id?.includes(phoneNumber)
                );
            });
            const isAdmin = Boolean(
                participant &&
                    (participant.admin === 'admin' || participant.admin === 'superadmin')
            );
            this._setBoundedCache(this.senderAdminCache, cacheKey, { isAdmin, at: Date.now() }, 2000);
            return isAdmin;
        } catch {
            return false;
        }
    }

    /** WhatsApp group admin/superadmin in a specific group (supports LID senders). */
    async isSenderGroupAdmin(sock, groupId, senderJid) {
        if (!groupId?.endsWith('@g.us') || !senderJid) {
            return false;
        }
        try {
            const senderPhone = normalizePhoneNumber(extractPhoneNumber(senderJid));
            const cacheKey = `${groupId}:${senderJid}:${senderPhone}`;
            const cached = this.senderAdminCache.get(cacheKey);
            if (cached && Date.now() - cached.at < ADMIN_STATUS_TTL_MS) {
                return cached.isAdmin;
            }

            await this.getGroupMetadataCached(sock, groupId);
            const id = jidNormalizedUser(String(groupId).replace(/:\d+(?=@)/, '')) || groupId;
            const entry = this.groupMetaCache.get(id) || this.groupMetaCache.get(groupId);
            const indexed = this._lookupAdminIndex(entry?.adminIndex, senderJid, senderPhone);
            if (indexed !== null) {
                this._setBoundedCache(this.senderAdminCache, cacheKey, { isAdmin: indexed, at: Date.now() }, 2000);
                return indexed;
            }

            for (const p of entry?.data?.participants || []) {
                const matchesJid =
                    p.id === senderJid ||
                    p.lid === senderJid ||
                    p.pn === senderJid ||
                    p.phoneNumber === senderJid;
                const pPhone = normalizePhoneNumber(participantToPhone(p));
                const matchesPhone = senderPhone && pPhone && pPhone === senderPhone;
                if (matchesJid || matchesPhone) {
                    const isAdmin = p.admin === 'admin' || p.admin === 'superadmin';
                    this._setBoundedCache(this.senderAdminCache, cacheKey, { isAdmin, at: Date.now() }, 2000);
                    return isAdmin;
                }
            }
        } catch {
            return false;
        }
        return false;
    }

    /**
     * Find a group participant by JID and/or phone (Baileys 7 phone + LID).
     * @param {import('baileys').WASocket} sock
     * @param {string} groupId
     * @param {string} [jid]
     * @param {string} [phone]
     */
    async findParticipant(sock, groupId, jid = '', phone = '') {
        if (!groupId?.endsWith('@g.us')) {
            return null;
        }
        try {
            const groupMetadata = await this.getGroupMetadataCached(sock, groupId);
            const normalizedPhone = normalizePhoneNumber(phone || extractPhoneNumber(jid));
            const normalizedJid = jid ? jidNormalizedUser(jid.replace(/:\d+(?=@)/, '')) || jid : '';

            for (const p of groupMetadata.participants || []) {
                const pPhone = normalizePhoneNumber(participantToPhone(p));
                const pId = jidNormalizedUser(String(p.id || '').replace(/:\d+(?=@)/, ''));
                const pLid = p.lid ? jidNormalizedUser(String(p.lid).replace(/:\d+(?=@)/, '')) : '';

                const matchJid =
                    (normalizedJid &&
                        (p.id === jid ||
                            p.lid === jid ||
                            p.pn === jid ||
                            p.phoneNumber === jid ||
                            pId === normalizedJid ||
                            pLid === normalizedJid)) ||
                    false;
                const matchPhone = normalizedPhone && pPhone && pPhone === normalizedPhone;

                if (matchJid || matchPhone) {
                    return p;
                }
            }
        } catch (err) {
            logger.debug(`findParticipant failed for ${groupId}: ${err.message}`);
        }
        return null;
    }

    /** Whether the connected bot account is admin/superadmin in this group. */
    async isBotGroupAdmin(sock, groupId) {
        if (!groupId?.endsWith('@g.us') || !sock?.user?.id) {
            return false;
        }

        try {
            const groupMetadata = await this.getGroupMetadataCached(sock, groupId);
            const botPhone = getBotAccountPhone(sock);
            const botRaw = String(sock.user.id).replace(/:\d+(?=@)/, '');
            const botJid = jidNormalizedUser(botRaw) || botRaw;

            const jidCandidates = new Set([botJid, botRaw].filter(Boolean));
            if (botPhone) {
                jidCandidates.add(`${botPhone}@s.whatsapp.net`);
            }
            const botLid = sock.authState?.creds?.me?.lid || sock.user?.lid;
            if (botLid) {
                jidCandidates.add(jidNormalizedUser(String(botLid).replace(/:\d+(?=@)/, '')));
            }

            for (const p of groupMetadata.participants || []) {
                const pPhone = normalizePhoneNumber(participantToPhone(p));
                const pId = jidNormalizedUser(String(p.id || '').replace(/:\d+(?=@)/, ''));
                const pLid = p.lid ? jidNormalizedUser(String(p.lid).replace(/:\d+(?=@)/, '')) : '';

                const matchJid =
                    jidCandidates.has(p.id) ||
                    jidCandidates.has(p.lid) ||
                    jidCandidates.has(p.pn) ||
                    jidCandidates.has(p.phoneNumber) ||
                    jidCandidates.has(pId) ||
                    (pLid && jidCandidates.has(pLid));

                const matchPhone = botPhone && pPhone && pPhone === botPhone;

                if ((matchJid || matchPhone) && (p.admin === 'admin' || p.admin === 'superadmin')) {
                    return true;
                }
            }
        } catch (err) {
            logger.debug(`isBotGroupAdmin failed for ${groupId}: ${err.message}`);
        }

        return false;
    }

    async isBotGroupAdminAsync(sock, groupId) {
        return this.isBotGroupAdmin(sock, groupId);
    }

    async isSenderGroupAdminAsync(sock, groupId, senderJid) {
        return this.isSenderGroupAdmin(sock, groupId, senderJid);
    }

    /** Owners, moderators (env + dynamic), or DB bot admins — can manually post /news */
    async canManualPostNews(senderJid) {
        const phoneNumber = extractPhoneNumber(senderJid);
        if (!phoneNumber) {
            return false;
        }
        if (this.isOwner(phoneNumber) || this.isModerator(phoneNumber)) {
            return true;
        }
        if (await this.isDynamicModerator(phoneNumber)) {
            return true;
        }
        return this.isBotAdmin(phoneNumber);
    }

    /**
     * Live WhatsApp group admins across all participating groups.
     * @param {import('baileys').WASocket} sock
     */
    async fetchAllWhatsAppGroupAdmins(sock) {
        const byPhone = new Map();
        if (!sock?.groupFetchAllParticipating) {
            return [];
        }
        try {
            const participating = await sock.groupFetchAllParticipating();
            for (const meta of Object.values(participating)) {
                for (const participant of meta.participants || []) {
                    if (participant.admin !== 'admin' && participant.admin !== 'superadmin') {
                        continue;
                    }
                    const phone = participantToPhone(participant);
                    if (!phone) {
                        continue;
                    }
                    const key = phone.replace(/\D/g, '');
                    if (!byPhone.has(key)) {
                        byPhone.set(key, {
                            phone_number: key,
                            role: participant.admin === 'superadmin' ? 'Super admin' : 'Group admin',
                            groups: [],
                        });
                    }
                    byPhone.get(key).groups.push(meta.subject || meta.id);
                }
            }
        } catch (error) {
            logger.error(`Failed to fetch WhatsApp group admins: ${error.message}`);
        }
        return [...byPhone.values()];
    }

    /**
     * Full admin commands: owners, DB admins, and WhatsApp group admins
     * in the group where the command was run (auto-detected live).
     */
    async isPrivileged(sock, chatId, phoneNumber) {
        if (this.isOwner(phoneNumber)) {
            return true;
        }
        if (await this.isBotAdmin(phoneNumber)) {
            return true;
        }
        if (chatId && typeof chatId === 'string' && chatId.endsWith('@g.us')) {
            return this.isGroupAdmin(sock, chatId, phoneNumber);
        }
        return false;
    }

    /** Group staff: owners, moderators (env + dynamic), DB admins, or WhatsApp group admin */
    async isStaff(sock, chatId, phoneNumber) {
        if (this.isOwner(phoneNumber)) {
            return true;
        }
        if (this.isModerator(phoneNumber)) {
            return true;
        }
        if (await this.isDynamicModerator(phoneNumber)) {
            return true;
        }
        if (await this.isBotAdmin(phoneNumber)) {
            return true;
        }
        if (!chatId || typeof chatId !== 'string') {
            return false;
        }
        if (chatId.endsWith('@g.us')) {
            return this.isGroupAdmin(sock, chatId, phoneNumber);
        }
        return false;
    }

    /** @deprecated Use isPrivileged or isStaff */
    async isAdmin(sock, chatId, phoneNumber) {
        return this.isPrivileged(sock, chatId, phoneNumber);
    }

    async isPrivilegedAsync(sock, chatId, senderJid) {
        const phoneNumber = normalizePhoneNumber(extractPhoneNumber(senderJid));
        if (phoneNumber && (await this.isPrivileged(sock, chatId, phoneNumber))) {
            return true;
        }
        // LID / missing phone: resolve via cached participant index, then WA admin check
        if (chatId?.endsWith('@g.us') && senderJid) {
            if (!phoneNumber) {
                const resolved = await this.resolveParticipantPhoneCached(sock, chatId, senderJid);
                if (resolved && (await this.isPrivileged(sock, chatId, resolved))) {
                    return true;
                }
            }
            return this.isSenderGroupAdmin(sock, chatId, senderJid);
        }
        return false;
    }

    async isStaffAsync(sock, chatId, senderJid) {
        const phoneNumber = normalizePhoneNumber(extractPhoneNumber(senderJid));
        if (phoneNumber && (await this.isStaff(sock, chatId, phoneNumber))) {
            return true;
        }
        if (chatId?.endsWith('@g.us') && senderJid) {
            if (!phoneNumber) {
                const resolved = await this.resolveParticipantPhoneCached(sock, chatId, senderJid);
                if (resolved && (await this.isStaff(sock, chatId, resolved))) {
                    return true;
                }
            }
            return this.isSenderGroupAdmin(sock, chatId, senderJid);
        }
        return false;
    }

    async isAdminAsync(sock, chatId, senderJid) {
        return this.isPrivilegedAsync(sock, chatId, senderJid);
    }

    getAllOwners() {
        return this.ownerNumbers.map(phone => ({ phone_number: phone }));
    }

    async addAdmin(phoneNumber) {
        const phone = normalizePhoneNumber(phoneNumber);
        if (!phone || phone.length < 10) {
            return { ok: false, reason: 'invalid' };
        }
        if (this.isOwner(phone)) {
            return { ok: false, reason: 'owner' };
        }
        if (this.isModerator(phone)) {
            return { ok: false, reason: 'moderator' };
        }

        const existing = await this.findBotAdminRecord(phone);
        if (existing) {
            return {
                ok: true,
                reason: 'already',
                phone_number: normalizePhoneNumber(existing.phone_number) || phone,
            };
        }

        await this.admins.insertOne({
            phone_number: phone,
            added_at: new Date(),
        });
        this.invalidateBotRoleCaches(phone);
        return { ok: true, reason: 'added', phone_number: phone };
    }

    async removeAdmin(phoneNumber) {
        const phone = normalizePhoneNumber(phoneNumber);
        if (!phone) {
            return { ok: false, reason: 'invalid' };
        }
        if (this.isOwner(phone)) {
            return { ok: false, reason: 'owner' };
        }
        if (this.isModerator(phone)) {
            return { ok: false, reason: 'moderator' };
        }

        const existing = await this.findBotAdminRecord(phone);
        if (!existing) {
            return { ok: false, reason: 'not_found' };
        }

        const storedPhone = existing.phone_number;
        const result = await this.admins.deleteOne({ phone_number: storedPhone });
        if (result.deletedCount > 0) {
            this.invalidateBotRoleCaches(phone);
            this.invalidateBotRoleCaches(storedPhone);
            return {
                ok: true,
                reason: 'removed',
                phone_number: normalizePhoneNumber(storedPhone) || phone,
            };
        }
        return { ok: false, reason: 'not_found' };
    }

    getAllModerators() {
        return this.moderatorNumbers.map((phone) => ({
            phone_number: phone,
            role: 'Moderator',
        }));
    }

    async getAllAdmins() {
        const [admins, dynamicMods] = await Promise.all([
            this.admins.find({}, { projection: { _id: 0 } }).sort({ added_at: 1 }).toArray(),
            this.getAllDynamicModerators(),
        ]);
        const ownerRows = this.ownerNumbers.map((phone) => ({
            phone_number: phone,
            role: 'Owner',
            added_at: 'Owner',
        }));
        const moderatorRows = this.moderatorNumbers.map((phone) => ({
            phone_number: phone,
            role: 'Moderator',
            added_at: 'Moderator (.env)',
        }));
        const dynamicModRows = dynamicMods.map((mod) => ({
            phone_number: mod.phone_number,
            role: 'Moderator',
            added_at: mod.added_at,
        }));
        const seen = new Set([
            ...ownerRows.map((row) => row.phone_number),
            ...moderatorRows.map((row) => row.phone_number),
            ...dynamicModRows.map((row) => row.phone_number),
        ]);
        const botAdminRows = admins
            .filter((admin) => !seen.has(admin.phone_number))
            .map((admin) => ({ ...admin, role: 'Bot admin' }));
        return ownerRows.concat(moderatorRows, dynamicModRows, botAdminRows);
    }

    // ─── Group Management ─────────────────────────────────────────────────────

    async activateGroup(groupId, groupName, activatedBy) {
        await this.groups.updateOne(
            { group_id: groupId },
            {
                $set: {
                    group_name: groupName,
                    activated_by: activatedBy,
                    activated_at: new Date(),
                    is_active: true,
                    courses_enabled: true,
                    news_enabled: true,
                    github_trending: true,
                    awesome_lists: true,
                },
                $setOnInsert: {
                    group_id: groupId,
                    insta_auto: false,
                },
            },
            { upsert: true }
        );
        logger.info(`✅ Group activated: ${groupName} (${groupId}) by ${activatedBy}`);
    }

    async setInstaAuto(groupId, groupName, enabled, activatedBy) {
        await this.groups.updateOne(
            { group_id: groupId },
            {
                $set: {
                    group_name: groupName,
                    insta_auto: enabled,
                    insta_auto_by: activatedBy,
                    insta_auto_at: new Date(),
                },
                $setOnInsert: {
                    group_id: groupId,
                    is_active: false,
                },
            },
            { upsert: true }
        );
        logger.info(
            `${enabled ? '📸 Insta auto ON' : '📸 Insta auto OFF'}: ${groupName} (${groupId}) by ${activatedBy}`
        );
    }

    async setBypassAuto(groupId, groupName, enabled, activatedBy) {
        await this.groups.updateOne(
            { group_id: groupId },
            {
                $set: {
                    group_name: groupName,
                    bypass_auto: enabled,
                    bypass_auto_by: activatedBy,
                    bypass_auto_at: new Date(),
                },
                $setOnInsert: {
                    group_id: groupId,
                    is_active: false,
                },
            },
            { upsert: true }
        );
        logger.info(
            `${enabled ? '🔗 Bypass auto ON' : '🔗 Bypass auto OFF'}: ${groupName} (${groupId}) by ${activatedBy}`
        );
    }

    async isBypassAutoEnabled(groupId) {
        const row = await this.groups.findOne(
            { group_id: groupId },
            { projection: { bypass_auto: 1 } }
        );
        return row?.bypass_auto === true;
    }

    async isInstaAutoEnabled(groupId) {
        const row = await this.groups.findOne(
            { group_id: groupId },
            { projection: { insta_auto: 1 } }
        );
        return row?.insta_auto === true;
    }

    async getInstaAutoGroups() {
        return this.groups
            .find({ insta_auto: true }, { projection: { _id: 0 } })
            .sort({ insta_auto_at: -1 })
            .toArray();
    }

    // ─── Sticker auto-forward to groups ───────────────────────────────────────

    async setStickerAuto(groupId, groupName, enabled, setBy) {
        await this.groups.updateOne(
            { group_id: groupId },
            {
                $set: {
                    group_name: groupName,
                    sticker_auto: enabled,
                    sticker_auto_by: setBy,
                    sticker_auto_at: new Date(),
                },
                $setOnInsert: {
                    group_id: groupId,
                    is_active: false,
                    insta_auto: false,
                },
            },
            { upsert: true }
        );
        logger.info(
            `${enabled ? '🎨 Sticker auto ON' : '🎨 Sticker auto OFF'}: ${groupName} (${groupId}) by ${setBy}`
        );
    }

    async isStickerAutoEnabled(groupId) {
        const row = await this.groups.findOne(
            { group_id: groupId },
            { projection: { sticker_auto: 1 } }
        );
        return row?.sticker_auto === true;
    }

    async getStickerAutoGroups() {
        return this.groups
            .find({ sticker_auto: true }, { projection: { _id: 0 } })
            .sort({ sticker_auto_at: -1 })
            .toArray();
    }

    /** Enable sticker forwarding for groups listed in STICKER_TARGET_GROUPS env. */
    async ensureStickerTargetsFromEnv(groupIds = []) {
        for (const groupId of groupIds) {
            if (!groupId?.endsWith('@g.us')) continue;
            const existing = await this.isStickerAutoEnabled(groupId);
            if (existing) continue;
            await this.setStickerAuto(groupId, 'Unknown Group', true, 'env');
        }
    }

    async deactivateGroup(groupId) {
        const result = await this.groups.updateOne(
            { group_id: groupId },
            { $set: { is_active: false, courses_enabled: false, news_enabled: false } }
        );
        logger.info(`🛑 Group deactivated: ${groupId}`);
        return result.matchedCount > 0;
    }

    async isGroupActive(groupId) {
        const row = await this.groups.findOne(
            { group_id: groupId },
            { projection: { is_active: 1 } }
        );
        return row ? row.is_active === true : false;
    }

    async getActiveGroups() {
        return this.groups
            .find({ is_active: true }, { projection: { _id: 0 } })
            .sort({ activated_at: -1 })
            .toArray();
    }

    async setCoursesEnabled(groupId, groupName, enabled, setBy) {
        await this.groups.updateOne(
            { group_id: groupId },
            {
                $set: {
                    group_name: groupName,
                    courses_enabled: enabled,
                    courses_set_by: setBy,
                    courses_set_at: new Date(),
                },
                $setOnInsert: { group_id: groupId, is_active: false },
            },
            { upsert: true }
        );
        logger.info(
            `${enabled ? '🎓 Courses ON' : '🎓 Courses OFF'}: ${groupName} (${groupId}) by ${setBy}`
        );
    }

    async isCoursesEnabled(groupId) {
        const row = await this.groups.findOne(
            { group_id: groupId },
            { projection: { courses_enabled: 1, is_active: 1 } }
        );
        if (!row?.is_active) {
            return false;
        }
        return row.courses_enabled !== false;
    }

    async getCourseEnabledGroups() {
        return this.groups
            .find(
                { is_active: true, courses_enabled: { $ne: false } },
                { projection: { _id: 0 } }
            )
            .sort({ activated_at: -1 })
            .toArray();
    }

    async setNewsEnabled(groupId, groupName, enabled, setBy) {
        await this.groups.updateOne(
            { group_id: groupId },
            {
                $set: {
                    group_name: groupName,
                    news_enabled: enabled,
                    news_set_by: setBy,
                    news_set_at: new Date(),
                },
                $setOnInsert: { group_id: groupId, is_active: false },
            },
            { upsert: true }
        );
        logger.info(
            `${enabled ? '📰 Tech news ON' : '📰 Tech news OFF'}: ${groupName} (${groupId}) by ${setBy}`
        );
    }

    async isNewsEnabled(groupId) {
        const row = await this.groups.findOne(
            { group_id: groupId },
            { projection: { news_enabled: 1, is_active: 1 } }
        );
        if (!row?.is_active) {
            return false;
        }
        return row.news_enabled !== false;
    }

    async getNewsEnabledGroups() {
        return this.groups
            .find(
                { is_active: true, news_enabled: { $ne: false } },
                { projection: { _id: 0 } }
            )
            .sort({ activated_at: -1 })
            .toArray();
    }

    async setGithubTrendingEnabled(groupId, groupName, enabled, setBy) {
        await this.groups.updateOne(
            { group_id: groupId },
            {
                $set: {
                    group_name: groupName,
                    github_trending: enabled,
                    github_trending_by: setBy,
                    github_trending_at: new Date(),
                },
                $setOnInsert: { group_id: groupId, is_active: false },
            },
            { upsert: true }
        );
        logger.info(
            `${enabled ? '🐙 GitHub trending ON' : '🐙 GitHub trending OFF'}: ${groupName} (${groupId}) by ${setBy}`
        );
    }

    async isGithubTrendingEnabled(groupId) {
        const row = await this.groups.findOne(
            { group_id: groupId },
            { projection: { github_trending: 1, is_active: 1 } }
        );
        if (!row?.is_active) {
            return false;
        }
        return row.github_trending !== false;
    }

    async getGithubTrendingGroups() {
        return this.groups
            .find(
                { is_active: true, github_trending: { $ne: false } },
                { projection: { _id: 0 } }
            )
            .sort({ activated_at: -1 })
            .toArray();
    }

    async setAwesomeListsEnabled(groupId, groupName, enabled, setBy) {
        await this.groups.updateOne(
            { group_id: groupId },
            {
                $set: {
                    group_name: groupName,
                    awesome_lists: enabled,
                    awesome_lists_by: setBy,
                    awesome_lists_at: new Date(),
                },
                $setOnInsert: { group_id: groupId, is_active: false },
            },
            { upsert: true }
        );
        logger.info(
            `⭐ Awesome lists ${enabled ? 'enabled' : 'disabled'} for ${groupName || groupId} by ${setBy}`
        );
    }

    async isAwesomeListsEnabled(groupId) {
        const row = await this.groups.findOne(
            { group_id: groupId },
            { projection: { awesome_lists: 1, is_active: 1 } }
        );
        if (!row?.is_active) return false;
        return row.awesome_lists !== false;
    }

    async getAwesomeListsGroups() {
        return this.groups
            .find(
                { is_active: true, awesome_lists: { $ne: false } },
                { projection: { _id: 0 } }
            )
            .sort({ activated_at: -1 })
            .toArray();
    }

    /** Interview Q of the Day — opt-in via /interviewqon */
    async setInterviewQEnabled(groupId, groupName, enabled, setBy) {
        await this.groups.updateOne(
            { group_id: groupId },
            {
                $set: {
                    group_name: groupName,
                    interview_q: enabled,
                    interview_q_by: setBy,
                    interview_q_at: new Date(),
                },
                $setOnInsert: { group_id: groupId, is_active: false },
            },
            { upsert: true }
        );
        logger.info(
            `🧠 Interview Q ${enabled ? 'enabled' : 'disabled'} for ${groupName || groupId} by ${setBy}`
        );
    }

    async isInterviewQEnabled(groupId) {
        const row = await this.groups.findOne(
            { group_id: groupId },
            { projection: { interview_q: 1, is_active: 1 } }
        );
        if (!row?.is_active) return false;
        return row.interview_q === true;
    }

    async getInterviewQGroups() {
        return this.groups
            .find(
                { is_active: true, interview_q: true },
                { projection: { _id: 0 } }
            )
            .sort({ activated_at: -1 })
            .toArray();
    }

    /** AI updates — opt-in via /aiupdateson (default off, like Interview Q). */
    async setAiUpdatesEnabled(groupId, groupName, enabled, setBy) {
        await this.groups.updateOne(
            { group_id: groupId },
            {
                $set: {
                    group_name: groupName,
                    ai_updates: enabled,
                    ai_updates_by: setBy,
                    ai_updates_at: new Date(),
                },
                $setOnInsert: { group_id: groupId, is_active: false },
            },
            { upsert: true }
        );
        logger.info(
            `🤖 AI updates ${enabled ? 'enabled' : 'disabled'} for ${groupName || groupId} by ${setBy}`
        );
    }

    async isAiUpdatesEnabled(groupId) {
        const row = await this.groups.findOne(
            { group_id: groupId },
            { projection: { ai_updates: 1, is_active: 1 } }
        );
        if (!row?.is_active) return false;
        return row.ai_updates === true;
    }

    async getAiUpdatesGroups() {
        return this.groups
            .find(
                { is_active: true, ai_updates: true },
                { projection: { _id: 0 } }
            )
            .sort({ activated_at: -1 })
            .toArray();
    }

    async getAllGroups() {
        return this.groups
            .find({}, { projection: { _id: 0 } })
            .sort({ activated_at: -1 })
            .toArray();
    }

    async getGroupInfo(groupId) {
        return this.groups.findOne(
            { group_id: groupId },
            { projection: { _id: 0 } }
        );
    }

    // ─── Group invite links ───────────────────────────────────────────────────

    /** Save the current group invite code (called when an admin fetches/revokes it). */
    async setGroupInviteCode(groupId, inviteCode, setBy) {
        await this.groups.updateOne(
            { group_id: groupId },
            {
                $set: {
                    invite_code: inviteCode || '',
                    invite_code_by: setBy || '',
                    invite_code_at: new Date(),
                },
                $setOnInsert: { group_id: groupId, is_active: false },
            },
            { upsert: true }
        );
        logger.info(`🔗 Invite code saved for ${groupId} by ${setBy || 'unknown'}`);
    }

    /** Last saved group invite code ('' if never saved). */
    async getGroupInviteCode(groupId) {
        const row = await this.groups.findOne(
            { group_id: groupId },
            { projection: { invite_code: 1 } }
        );
        return row?.invite_code || '';
    }

    async getGroupCount() {
        const [active, total] = await Promise.all([
            this.groups.countDocuments({ is_active: true }),
            this.groups.countDocuments({}),
        ]);
        return { active, total };
    }

    // ─── Movie & trending toggles ──────────────────────────────────────────────

    async setMovieEnabled(groupId, groupName, enabled, setBy) {
        await this.groups.updateOne(
            { group_id: groupId },
            {
                $set: {
                    group_name: groupName,
                    movie_enabled: enabled,
                    movie_set_by: setBy,
                    movie_set_at: new Date(),
                },
                $setOnInsert: { group_id: groupId, is_active: false },
            },
            { upsert: true }
        );
    }

    async isMovieEnabled(groupId) {
        const row = await this.groups.findOne(
            { group_id: groupId },
            { projection: { movie_enabled: 1 } }
        );
        return row?.movie_enabled === true;
    }

    async getMovieEnabledGroups() {
        return this.groups
            .find({ movie_enabled: true }, { projection: { _id: 0 } })
            .toArray();
    }

    async setSummaryEnabled(groupId, groupName, enabled, setBy) {
        const normalizedId = jidNormalizedUser(String(groupId).replace(/:\d+(?=@)/, '')) || groupId;
        await this.groups.updateOne(
            { group_id: normalizedId },
            {
                $set: {
                    group_name: groupName,
                    summary_enabled: enabled,
                    summary_set_by: setBy,
                    summary_set_at: new Date(),
                },
                $setOnInsert: { group_id: normalizedId, is_active: false },
            },
            { upsert: true }
        );
        logger.info(
            `${enabled ? '🗓️ Group recap ON' : '🗓️ Group recap OFF'}: ${groupName} (${normalizedId}) by ${setBy}`
        );
    }

    async isSummaryEnabled(groupId) {
        const normalizedId = jidNormalizedUser(String(groupId).replace(/:\d+(?=@)/, '')) || groupId;
        const row = await this.groups.findOne(
            { group_id: normalizedId },
            { projection: { summary_enabled: 1 } }
        );
        return row?.summary_enabled === true;
    }

    async getSummaryEnabledGroups() {
        return this.groups
            .find({ summary_enabled: true }, { projection: { _id: 0 } })
            .toArray();
    }

    /** Auto open/close chat — /autochat on groups unlock at 09:00 and lock at 23:55. */
    async setAutoChatEnabled(groupId, groupName, enabled, setBy) {
        const normalizedId = jidNormalizedUser(String(groupId).replace(/:\d+(?=@)/, '')) || groupId;
        await this.groups.updateOne(
            { group_id: normalizedId },
            {
                $set: {
                    group_name: groupName,
                    auto_chat: enabled,
                    auto_chat_by: setBy,
                    auto_chat_at: new Date(),
                },
                $setOnInsert: { group_id: normalizedId, is_active: false },
            },
            { upsert: true }
        );
        logger.info(
            `${enabled ? '🔓 Auto chat ON' : '🔒 Auto chat OFF'}: ${groupName} (${normalizedId}) by ${setBy}`
        );
    }

    async isAutoChatEnabled(groupId) {
        const normalizedId = jidNormalizedUser(String(groupId).replace(/:\d+(?=@)/, '')) || groupId;
        const row = await this.groups.findOne(
            { group_id: normalizedId },
            { projection: { auto_chat: 1 } }
        );
        return row?.auto_chat === true;
    }

    async getAutoChatEnabledGroups() {
        return this.groups
            .find({ auto_chat: true }, { projection: { _id: 0 } })
            .toArray();
    }

    async setTradeAlertEnabled(groupId, groupName, enabled, setBy) {
        const normalizedId = jidNormalizedUser(String(groupId).replace(/:\d+(?=@)/, '')) || groupId;
        await this.groups.updateOne(
            { group_id: normalizedId },
            {
                $set: {
                    group_name: groupName,
                    trade_alert_enabled: enabled,
                    trade_alert_set_by: setBy,
                    trade_alert_set_at: new Date(),
                },
                $setOnInsert: { group_id: normalizedId, is_active: false },
            },
            { upsert: true }
        );
        logger.info(
            `${enabled ? '📈 Trade alert ON' : '📈 Trade alert OFF'}: ${groupName} (${normalizedId}) by ${setBy}`
        );
    }

    async isTradeAlertEnabled(groupId) {
        const row = await this.groups.findOne(
            { group_id: groupId },
            { projection: { trade_alert_enabled: 1 } }
        );
        return row?.trade_alert_enabled === true;
    }

    async getTradeAlertGroups() {
        return this.groups
            .find({ trade_alert_enabled: true }, { projection: { _id: 0 } })
            .toArray();
    }

    // ── Scalp (NIFTY micro scalp) ────────────────────────────────────────

    /**
     * @param {string[]} [indices] which indices alert here. Omitted keeps the
     *   group's existing selection, so a plain `/scalpon` does not silently
     *   reset a group that had asked for SENSEX.
     */
    async setScalpEnabled(groupId, groupName, enabled, setBy, indices) {
        const $set = {
            group_name: groupName,
            scalp_enabled: enabled,
            scalp_by: setBy,
            scalp_at: new Date(),
        };
        if (Array.isArray(indices) && indices.length) $set.scalp_indices = indices;

        await this.groups.updateOne(
            { group_id: groupId },
            { $set, $setOnInsert: { group_id: groupId, is_active: false } },
            { upsert: true }
        );
        logger.info(
            `⚡ Scalp ${enabled ? 'enabled' : 'disabled'} for ${groupName || groupId} by ${setBy}`
            + (indices?.length ? ` [${indices.join(', ')}]` : '')
        );
    }

    async isScalpEnabled(groupId) {
        const row = await this.groups.findOne(
            { group_id: groupId },
            { projection: { scalp_enabled: 1, is_active: 1 } }
        );
        if (!row?.is_active) return false;
        return row.scalp_enabled === true;
    }

    /**
     * Indices this group wants scalp alerts for.
     *
     * Groups enabled before SENSEX existed have no `scalp_indices` field. They
     * asked for NIFTY when NIFTY was the only option, so they default to NIFTY —
     * turning SENSEX on for them without being asked would be a surprise.
     */
    async getScalpIndices(groupId) {
        const row = await this.groups.findOne(
            { group_id: groupId },
            { projection: { scalp_indices: 1 } }
        );
        const list = Array.isArray(row?.scalp_indices) ? row.scalp_indices.filter(Boolean) : [];
        return list.length ? list : ['NIFTY'];
    }

    async getScalpGroups() {
        const rows = await this.groups
            .find({ is_active: true, scalp_enabled: true }, { projection: { _id: 0 } })
            .toArray();
        // Normalise here so every caller sees the same shape and none of them
        // has to remember the pre-SENSEX default.
        return rows.map((r) => ({
            ...r,
            scalp_indices: Array.isArray(r.scalp_indices) && r.scalp_indices.length
                ? r.scalp_indices
                : ['NIFTY'],
        }));
    }

    // ── Telegram Sticker Import ──────────────────────────────────────────

    async setTgStickerEnabled(groupId, groupName, enabled, setBy) {
        await this.groups.updateOne(
            { group_id: groupId },
            {
                $set: {
                    group_name: groupName,
                    tg_sticker_enabled: enabled,
                    tg_sticker_by: setBy,
                    tg_sticker_at: new Date(),
                },
                $setOnInsert: { group_id: groupId, is_active: false },
            },
            { upsert: true }
        );
        logger.info(`🎭 TG Sticker ${enabled ? 'enabled' : 'disabled'} for ${groupName || groupId} by ${setBy}`);
    }

    async isTgStickerEnabled(groupId) {
        const row = await this.groups.findOne(
            { group_id: groupId },
            { projection: { tg_sticker_enabled: 1, is_active: 1 } }
        );
        if (!row?.is_active) return false;
        return row.tg_sticker_enabled === true;
    }

    async getTgStickerGroups() {
        return this.groups
            .find({ is_active: true, tg_sticker_enabled: true }, { projection: { _id: 0 } })
            .toArray();
    }

    /**
     * SVMKR live alerts are opted into per group, separately from the daily trade
     * alert. They are a different product: unlimited intraday CE/PE cards plus
     * follow-up replies, so a group that wants the 09:20 digest does not
     * automatically want a card every time a 5m bar crosses.
     */
    async setSvmkrEnabled(groupId, groupName, enabled, setBy) {
        const normalizedId = jidNormalizedUser(String(groupId).replace(/:\d+(?=@)/, '')) || groupId;
        await this.groups.updateOne(
            { group_id: normalizedId },
            {
                $set: {
                    group_name: groupName,
                    svmkr_enabled: enabled,
                    svmkr_set_by: setBy,
                    svmkr_set_at: new Date(),
                },
                $setOnInsert: { group_id: normalizedId, is_active: false },
            },
            { upsert: true }
        );
        logger.info(
            `${enabled ? '⚡ SVMKR ON' : '⚡ SVMKR OFF'}: ${groupName} (${normalizedId}) by ${setBy}`
        );
    }

    async isSvmkrEnabled(groupId) {
        const normalizedId = jidNormalizedUser(String(groupId).replace(/:\d+(?=@)/, '')) || groupId;
        const row = await this.groups.findOne(
            { group_id: normalizedId },
            { projection: { svmkr_enabled: 1 } }
        );
        return row?.svmkr_enabled === true;
    }

    async getSvmkrGroups() {
        return this.groups
            .find({ svmkr_enabled: true }, { projection: { _id: 0 } })
            .toArray();
    }

    /** Cheap gate for the live loop: is anyone listening at all? */
    async countSvmkrGroups() {
        return this.groups.countDocuments({ svmkr_enabled: true });
    }

    async setTradeAlertSymbols(groupId, groupName, symbols, setBy) {
        const normalizedId = jidNormalizedUser(String(groupId).replace(/:\d+(?=@)/, '')) || groupId;
        const list = Array.isArray(symbols)
            ? symbols.map((s) => String(s).trim().toUpperCase()).filter(Boolean).slice(0, 12)
            : [];
        await this.groups.updateOne(
            { group_id: normalizedId },
            {
                $set: {
                    group_name: groupName,
                    trade_alert_symbols: list,
                    trade_alert_symbols_by: setBy,
                    trade_alert_symbols_at: new Date(),
                },
                $setOnInsert: { group_id: normalizedId, is_active: false },
            },
            { upsert: true }
        );
        logger.info(`📈 Trade watchlist (${list.join(',')}) for ${groupName} (${normalizedId})`);
    }

    async getTradeAlertSymbols(groupId) {
        const row = await this.groups.findOne(
            { group_id: groupId },
            { projection: { trade_alert_symbols: 1 } }
        );
        const list = row?.trade_alert_symbols;
        return Array.isArray(list) ? list.filter(Boolean) : [];
    }

    async setTradeAlertMode(groupId, groupName, mode, setBy) {
        const normalizedId = jidNormalizedUser(String(groupId).replace(/:\d+(?=@)/, '')) || groupId;
        const m = mode === 'manual' ? 'manual' : 'auto';
        await this.groups.updateOne(
            { group_id: normalizedId },
            {
                $set: {
                    group_name: groupName,
                    trade_alert_mode: m,
                    trade_alert_mode_by: setBy,
                    trade_alert_mode_at: new Date(),
                },
                $setOnInsert: { group_id: normalizedId, is_active: false },
            },
            { upsert: true }
        );
        logger.info(`📈 Trade alert mode ${m}: ${groupName} (${normalizedId})`);
    }

    async getTradeAlertMode(groupId) {
        const row = await this.groups.findOne(
            { group_id: groupId },
            { projection: { trade_alert_mode: 1 } }
        );
        const m = row?.trade_alert_mode;
        return m === 'manual' ? 'manual' : m === 'auto' ? 'auto' : null;
    }

    async setTradeAlertDiscoverySource(groupId, groupName, source, setBy) {
        const normalizedId = jidNormalizedUser(String(groupId).replace(/:\d+(?=@)/, '')) || groupId;
        const normalized = normalizeDiscoverySource(source);
        await this.groups.updateOne(
            { group_id: normalizedId },
            {
                $set: {
                    group_name: groupName,
                    trade_alert_discovery_source: normalized,
                    trade_alert_discovery_source_by: setBy,
                    trade_alert_discovery_source_at: new Date(),
                },
                $setOnInsert: { group_id: normalizedId, is_active: false },
            },
            { upsert: true }
        );
        logger.info(`📈 Trade discovery source ${normalized}: ${groupName} (${normalizedId})`);
        return normalized;
    }

    async getTradeAlertDiscoverySource(groupId) {
        const row = await this.groups.findOne(
            { group_id: groupId },
            { projection: { trade_alert_discovery_source: 1 } }
        );
        const s = row?.trade_alert_discovery_source;
        return DISCOVERY_SOURCES.includes(s) ? s : null;
    }

    async setWeeklyTrendingEnabled(groupId, groupName, enabled, setBy) {
        await this.groups.updateOne(
            { group_id: groupId },
            {
                $set: {
                    group_name: groupName,
                    weekly_trending: enabled,
                    weekly_trending_by: setBy,
                    weekly_trending_at: new Date(),
                },
                $setOnInsert: { group_id: groupId, is_active: false },
            },
            { upsert: true }
        );
    }

    async isWeeklyTrendingEnabled(groupId) {
        const row = await this.groups.findOne(
            { group_id: groupId },
            { projection: { weekly_trending: 1 } }
        );
        return row?.weekly_trending === true;
    }

    async getWeeklyTrendingGroups() {
        return this.groups
            .find({ weekly_trending: true }, { projection: { _id: 0 } })
            .toArray();
    }

    // ─── Welcome messages ─────────────────────────────────────────────────────

    async setWelcomeMessage(groupId, groupName, customMessage, setBy) {
        await this.groups.updateOne(
            { group_id: groupId },
            {
                $set: {
                    group_name: groupName,
                    welcome_enabled: true,
                    welcome_message: (customMessage || '').trim(),
                    welcome_set_by: setBy,
                    welcome_set_at: new Date(),
                },
                $setOnInsert: {
                    group_id: groupId,
                    is_active: false,
                    insta_auto: false,
                },
            },
            { upsert: true }
        );
        logger.info(`👋 Welcome message set for ${groupName} (${groupId}) by ${setBy}`);
    }

    async clearWelcomeMessage(groupId) {
        const result = await this.groups.updateOne(
            { group_id: groupId },
            {
                $set: { welcome_enabled: false },
                $unset: {
                    welcome_message: '',
                    welcome_set_by: '',
                    welcome_set_at: '',
                },
            }
        );
        logger.info(`👋 Welcome message cleared for ${groupId}`);
        return result.matchedCount > 0;
    }

    async getWelcomeConfig(groupId) {
        const row = await this.groups.findOne(
            { group_id: groupId },
            {
                projection: {
                    _id: 0,
                    welcome_enabled: 1,
                    welcome_message: 1,
                    welcome_set_by: 1,
                    welcome_set_at: 1,
                    group_name: 1,
                },
            }
        );
        if (!row?.welcome_enabled) {
            return null;
        }
        return row;
    }

    async isWelcomeEnabled(groupId) {
        const row = await this.groups.findOne(
            { group_id: groupId },
            { projection: { welcome_enabled: 1 } }
        );
        return row?.welcome_enabled === true;
    }

    async getWelcomeEnabledGroups() {
        return this.groups
            .find({ welcome_enabled: true }, { projection: { _id: 0 } })
            .sort({ welcome_set_at: -1 })
            .toArray();
    }

    // ─── Premium users ─────────────────────────────────────────────────────────

    async initPremium() {
        this.premiumUsers = this.mongoDb.collection('premium_users');
        await this.premiumUsers.createIndex(
            { phone_number: 1 },
            { unique: true, name: 'premium_phone' }
        );
    }

    async addPremiumUser(phoneNumber, addedBy) {
        const phone = normalizePhoneNumber(phoneNumber);
        if (!phone || phone.length < 10) {
            return { ok: false, reason: 'invalid' };
        }
        const existing = await this.premiumUsers.findOne({ phone_number: phone });
        if (existing) {
            return { ok: false, reason: 'already', phone_number: phone };
        }
        await this.premiumUsers.insertOne({
            phone_number: phone,
            added_by: addedBy,
            added_at: new Date(),
        });
        logger.info(`⭐ Premium user added: ${phone} by ${addedBy}`);
        return { ok: true, reason: 'added', phone_number: phone };
    }

    async removePremiumUser(phoneNumber) {
        const phone = normalizePhoneNumber(phoneNumber);
        if (!phone) {
            return { ok: false, reason: 'invalid' };
        }
        const result = await this.premiumUsers.deleteOne({ phone_number: phone });
        if (result.deletedCount > 0) {
            logger.info(`⭐ Premium user removed: ${phone}`);
            return { ok: true, reason: 'removed', phone_number: phone };
        }
        return { ok: false, reason: 'not_found' };
    }

    async isPremiumUser(phoneNumber) {
        const phone = normalizePhoneNumber(phoneNumber);
        if (!phone) return false;
        return Boolean(await this.premiumUsers?.findOne({ phone_number: phone }));
    }

    async getAllPremiumUsers() {
        if (!this.premiumUsers) return [];
        return this.premiumUsers.find({}, { projection: { _id: 0 } })
            .sort({ added_at: -1 })
            .toArray();
    }

    // ─── Dynamic moderators ──────────────────────────────────────────────────

    async initDynamicModerators() {
        this.dynamicModerators = this.mongoDb.collection('dynamic_moderators');
        await this.dynamicModerators.createIndex(
            { phone_number: 1 },
            { unique: true, name: 'dynamic_mod_phone' }
        );
    }

    async addDynamicModerator(phoneNumber, addedBy) {
        const phone = normalizePhoneNumber(phoneNumber);
        if (!phone || phone.length < 10) {
            return { ok: false, reason: 'invalid' };
        }
        if (this.isOwner(phone)) {
            return { ok: false, reason: 'owner' };
        }
        const existing = await this.dynamicModerators.findOne({ phone_number: phone });
        if (existing) {
            return { ok: false, reason: 'already', phone_number: phone };
        }
        await this.dynamicModerators.insertOne({
            phone_number: phone,
            added_by: addedBy,
            added_at: new Date(),
        });
        this.invalidateBotRoleCaches(phone);
        logger.info(`🛡️ Dynamic moderator added: ${phone} by ${addedBy}`);
        return { ok: true, reason: 'added', phone_number: phone };
    }

    async removeDynamicModerator(phoneNumber) {
        const phone = normalizePhoneNumber(phoneNumber);
        if (!phone) {
            return { ok: false, reason: 'invalid' };
        }
        const result = await this.dynamicModerators.deleteOne({ phone_number: phone });
        if (result.deletedCount > 0) {
            this.invalidateBotRoleCaches(phone);
            logger.info(`🛡️ Dynamic moderator removed: ${phone}`);
            return { ok: true, reason: 'removed', phone_number: phone };
        }
        return { ok: false, reason: 'not_found' };
    }

    async isDynamicModerator(phoneNumber) {
        const phone = normalizePhoneNumber(phoneNumber);
        if (!phone) return false;
        const cached = this.dynamicModCache.get(phone);
        if (cached && Date.now() - cached.at < BOT_ROLE_TTL_MS) {
            return cached.value;
        }
        const value = Boolean(await this.dynamicModerators?.findOne({ phone_number: phone }));
        this._setBoundedCache(this.dynamicModCache, phone, { value, at: Date.now() }, 500);
        return value;
    }

    async getAllDynamicModerators() {
        if (!this.dynamicModerators) return [];
        return this.dynamicModerators.find({}, { projection: { _id: 0 } })
            .sort({ added_at: -1 })
            .toArray();
    }

    // ─── Sticker source channels ─────────────────────────────────────────────

    async initChannels() {
        this.channels = this.mongoDb.collection('sticker_channels');
        await this.channels.createIndex(
            { channel_jid: 1 },
            { unique: true, name: 'channel_jid' }
        );
    }

    async addStickerChannel(channelJid, channelName, addedBy) {
        if (!channelJid?.includes('@newsletter')) {
            return { ok: false, reason: 'Invalid channel JID' };
        }
        try {
            await this.channels.updateOne(
                { channel_jid: channelJid },
                {
                    $set: {
                        channel_name: channelName || channelJid,
                        added_by: addedBy,
                        added_at: new Date(),
                    },
                    $setOnInsert: { channel_jid: channelJid },
                },
                { upsert: true }
            );
            logger.info(`📡 Channel added: ${channelName || channelJid} by ${addedBy}`);
            return { ok: true, jid: channelJid, name: channelName };
        } catch (error) {
            return { ok: false, reason: error.message };
        }
    }

    async removeStickerChannel(channelJid) {
        const result = await this.channels.deleteOne({ channel_jid: channelJid });
        if (result.deletedCount > 0) {
            logger.info(`📡 Channel removed: ${channelJid}`);
            return { ok: true };
        }
        return { ok: false, reason: 'Channel not found' };
    }

    async getStickerChannels() {
        if (!this.channels) return [];
        return this.channels.find({}).toArray();
    }

    async getStickerChannelJids() {
        const channels = await this.getStickerChannels();
        return channels.map(c => c.channel_jid);
    }

    // ─── Utility ──────────────────────────────────────────────────────────────

    close() {
        this.groups = null;
        this.admins = null;
        this.channels = null;
        this.premiumUsers = null;
        this.dynamicModerators = null;
    }
}

export default GroupManager;
