/**
 * Mongo storage for Interview Q of the Day (poll + delayed answer).
 */

import { ObjectId } from 'mongodb';
import { logger } from '../utils/logger.js';

const STATUSES = ['scheduled', 'question_posted', 'answer_posted', 'failed'];

class InterviewQuestionStore {
    constructor(mongoDb) {
        this.mongoDb = mongoDb;
        this.col = null;
    }

    async init() {
        this.col = this.mongoDb.collection('interview_questions');
        // /tagme–/notag opt-ins: one doc per (group, member phone).
        this.tagCol = this.mongoDb.collection('interview_q_tag_prefs');
        await Promise.all([
            this.col.createIndex({ jid: 1, slot_key: 1 }, { unique: true, name: 'iq_jid_slot' }),
            this.col.createIndex({ status: 1, answer_due_at: 1 }, { name: 'iq_pending_answers' }),
            this.col.createIndex({ created_at: 1 }, { name: 'iq_created_at' }),
            this.col.createIndex({ question_fp: 1, created_at: -1 }, { name: 'iq_question_fp' }),
            this.col.createIndex({ poll_message_id: 1 }, { name: 'iq_poll_message_id' }),
            this.tagCol.createIndex({ group_id: 1, phone: 1 }, { unique: true, name: 'iq_tag_group_phone' }),
        ]);
        logger.info('Mongo interview question store ready');
    }

    // ── /tagme / /notag opt-ins ───────────────────────────────────────────

    /** @returns {Promise<object|null>} full pref row, or null if never set */
    async getTagPref(group_id, phone) {
        if (!group_id || !phone || !this.tagCol) return null;
        const phoneKey = String(phone).replace(/\D/g, '') || String(phone);
        return this.tagCol.findOne(
            { group_id, phone: phoneKey },
            { projection: { tagged: 1, name: 1, phone: 1, updated_at: 1, jid: 1 } }
        );
    }

    /** @returns {Promise<boolean>} true when opted-in, false when not stored */
    async isTaggedIn(group_id, phone) {
        if (!group_id || !phone || !this.tagCol) return false;
        const phoneKey = String(phone).replace(/\D/g, '') || String(phone);
        const row = await this.tagCol.findOne(
            { group_id, phone: phoneKey },
            { projection: { tagged: 1 } }
        );
        return row?.tagged === true;
    }

    async setTagged(group_id, phone, tagged, meta = {}) {
        if (!group_id || !phone || !this.tagCol) return;
        const now = new Date();
        const phoneKey = String(phone).replace(/\D/g, '') || String(phone);
        await this.tagCol.updateOne(
            { group_id, phone: phoneKey },
            {
                $set: {
                    tagged: tagged === true,
                    name: String(meta.name || '').slice(0, 64),
                    jid: String(meta.jid || '').slice(0, 80),
                    updated_at: now,
                },
                $setOnInsert: { group_id, phone: phoneKey, created_at: now },
            },
            { upsert: true }
        );
    }

    /** Opted-in members for a group, newest opt-in first. */
    async getTaggedMembers(group_id) {
        if (!group_id || !this.tagCol) return [];
        return this.tagCol
            .find({ group_id, tagged: true })
            .sort({ updated_at: -1 })
            .toArray();
    }

    /**
     * @param {object} doc
     */
    async insertQuestion(doc) {
        const now = new Date();
        const row = {
            ...doc,
            _id: doc._id || new ObjectId(),
            status: doc.status || 'scheduled',
            created_at: now,
            updated_at: now,
        };
        await this.col.insertOne(row);
        return row;
    }

    async findById(id) {
        if (!id) return null;
        try {
            const _id = typeof id === 'string' ? new ObjectId(id) : id;
            return this.col.findOne({ _id });
        } catch {
            return null;
        }
    }

    async deleteById(id) {
        if (!id) return;
        try {
            const _id = typeof id === 'string' ? new ObjectId(id) : id;
            await this.col.deleteOne({ _id });
        } catch {
            /* ignore */
        }
    }

    async findBySlot(jid, slotKey) {
        return this.col.findOne({ jid, slot_key: slotKey });
    }

    async findLatestPendingAnswer(jid) {
        return this.col.findOne(
            { jid, status: 'question_posted' },
            { sort: { question_posted_at: -1 } }
        );
    }

    async findPendingAnswersDue(beforeMs = Date.now() + 24 * 60 * 60 * 1000) {
        return this.col
            .find({
                status: 'question_posted',
                answer_due_at: { $lte: new Date(beforeMs) },
            })
            .sort({ answer_due_at: 1 })
            .toArray();
    }

    /** Recent non-failed questions for LLM avoid-list + fingerprint checks. */
    async findRecentQuestions(limit = 80) {
        const n = Math.min(300, Math.max(10, Number(limit) || 80));
        return this.col
            .find(
                { status: { $in: ['question_posted', 'answer_posted', 'scheduled'] } },
                {
                    projection: {
                        question: 1,
                        question_fp: 1,
                        topic: 1,
                        type: 1,
                        difficulty: 1,
                        created_at: 1,
                    },
                }
            )
            .sort({ created_at: -1 })
            .limit(n)
            .toArray();
    }

    async fingerprintExists(fp) {
        if (!fp) return false;
        const row = await this.col.findOne(
            {
                question_fp: fp,
                status: { $in: ['question_posted', 'answer_posted', 'scheduled'] },
            },
            { projection: { _id: 1 } }
        );
        return Boolean(row);
    }

    /**
     * Questions posted for a jid since `since` (inclusive), for weekly recap.
     */
    async findPostedSince(jid, since) {
        if (!jid || !since) return [];
        return this.col
            .find({
                jid,
                status: { $in: ['question_posted', 'answer_posted'] },
                question_posted_at: { $gte: since },
            })
            .sort({ question_posted_at: 1 })
            .toArray();
    }

    async findByPollMessageId(pollMessageId) {
        if (!pollMessageId) return null;
        return this.col.findOne({ poll_message_id: String(pollMessageId) });
    }

    /**
     * Upsert one voter's choice on a live poll (overwrite if they change vote).
     * @param {import('mongodb').ObjectId|string} id
     * @param {{ voter_jid: string, voter_phone?: string, voter_name?: string, option: string, voted_at?: Date }} vote
     */
    async upsertVote(id, vote) {
        if (!id || !vote?.voter_jid || !vote?.option) return { ok: false };
        const _id = typeof id === 'string' ? new ObjectId(id) : id;
        const payload = {
            voter_jid: String(vote.voter_jid).slice(0, 80),
            voter_phone: String(vote.voter_phone || '').slice(0, 20),
            voter_name: String(vote.voter_name || 'Member').slice(0, 64),
            option: String(vote.option).toUpperCase().slice(0, 1),
            voted_at: vote.voted_at || new Date(),
        };

        const updated = await this.col.updateOne(
            { _id, 'votes.voter_jid': payload.voter_jid },
            {
                $set: {
                    'votes.$.voter_phone': payload.voter_phone,
                    'votes.$.voter_name': payload.voter_name,
                    'votes.$.option': payload.option,
                    'votes.$.voted_at': payload.voted_at,
                    updated_at: new Date(),
                },
            }
        );
        if (updated.matchedCount) return { ok: true, updated: true };

        await this.col.updateOne(
            { _id },
            {
                $push: { votes: payload },
                $set: { updated_at: new Date() },
            }
        );
        return { ok: true, updated: false };
    }

    async markQuestionPosted(id, {
        pollMessageId,
        pollMessageKey,
        questionPostedAt,
        answerDueAt,
        pollEncKeyB64,
        pollOptionNames,
        pollCreatorJid,
    }) {
        await this.col.updateOne(
            { _id: id },
            {
                $set: {
                    status: 'question_posted',
                    poll_message_id: pollMessageId || '',
                    poll_message_key: pollMessageKey || null,
                    poll_enc_key: pollEncKeyB64 || '',
                    poll_option_names: Array.isArray(pollOptionNames) ? pollOptionNames : [],
                    poll_creator_jid: pollCreatorJid || '',
                    votes: [],
                    question_posted_at: questionPostedAt || new Date(),
                    answer_due_at: answerDueAt,
                    updated_at: new Date(),
                },
            }
        );
    }

    async markAnswerPosted(id) {
        await this.col.updateOne(
            { _id: id },
            {
                $set: {
                    status: 'answer_posted',
                    answer_posted_at: new Date(),
                    updated_at: new Date(),
                },
            }
        );
    }

    async markFailed(id, errorMessage) {
        await this.col.updateOne(
            { _id: id },
            {
                $set: {
                    status: 'failed',
                    error: String(errorMessage || '').slice(0, 500),
                    updated_at: new Date(),
                },
            }
        );
    }

    async cleanupOld(days = 30) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);
        const result = await this.col.deleteMany({
            created_at: { $lt: cutoff },
            status: { $in: ['answer_posted', 'failed'] },
        });
        return result.deletedCount || 0;
    }
}

export { STATUSES };
export default InterviewQuestionStore;
