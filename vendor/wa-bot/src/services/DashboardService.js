/**
 * Aggregates Mongo + live telemetry for the mission-control dashboard.
 */

import { getTodayDateStrIST } from '../utils/dateIST.js';
import { botTelemetry } from '../utils/botTelemetry.js';
import { messageQueue } from '../utils/messageQueue.js';
import { logger } from '../utils/logger.js';

async function loadMovieConcurrency() {
    try {
        const mod = await import('../controllers/MovieController.js');
        return mod.getMovieSearchConcurrency();
    } catch {
        return { active: 0, max: 6, waiting: 0 };
    }
}

function startOfTodayLocal() {
    const now = new Date();
    // Approximate IST day boundary for posted_at Date fields
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(now.getTime() + istOffsetMs);
    const y = istNow.getUTCFullYear();
    const m = istNow.getUTCMonth();
    const d = istNow.getUTCDate();
    return new Date(Date.UTC(y, m, d) - istOffsetMs);
}

function hoursAgo(n) {
    return new Date(Date.now() - n * 3600_000);
}

function daysAgo(n) {
    return new Date(Date.now() - n * 24 * 3600_000);
}

export default class DashboardService {
    /**
     * @param {object} deps
     * @param {import('mongodb').Db} deps.mongoDb
     * @param {import('../models/GroupManager.js').default} deps.groupManager
     * @param {object} [deps.adminPanel]
     * @param {object} [deps.botState]
     */
    constructor(deps = {}) {
        this.mongoDb = deps.mongoDb || null;
        this.groupManager = deps.groupManager || null;
        this.adminPanel = deps.adminPanel || null;
        this.botState = deps.botState || {};
        this.jobQueue = deps.jobQueue || null;
        /** @type {{ snap: object, expires: number }|null} */
        this._snapCache = null;
        this.snapTtlMs = 5_000;
    }

    invalidateSnapshotCache() {
        this._snapCache = null;
    }

    /** Aggregate once, reuse for ~5s across dashboard clients. */
    async getCachedSnapshot(ttlMs = this.snapTtlMs) {
        const now = Date.now();
        if (this._snapCache && this._snapCache.expires > now) {
            return this._snapCache.snap;
        }
        const snap = await this.getSnapshot();
        this._snapCache = { snap, expires: now + Math.max(1_000, Number(ttlMs) || 5_000) };
        return snap;
    }

    col(name) {
        return this.mongoDb?.collection(name) || null;
    }

    async _countSince(collection, dateField, since, extra = {}) {
        if (!collection) return 0;
        try {
            return collection.countDocuments({ ...extra, [dateField]: { $gte: since } });
        } catch {
            return 0;
        }
    }

    async _hourlyBuckets(collection, dateField, hours = 24, match = {}) {
        if (!collection) return Array.from({ length: hours }, () => 0);
        const since = hoursAgo(hours);
        try {
            const rows = await collection
                .aggregate([
                    { $match: { ...match, [dateField]: { $gte: since } } },
                    {
                        $group: {
                            _id: {
                                $dateToString: {
                                    format: '%Y-%m-%dT%H',
                                    date: `$${dateField}`,
                                    timezone: 'Asia/Kolkata',
                                },
                            },
                            n: { $sum: 1 },
                        },
                    },
                ])
                .toArray();
            const map = new Map(rows.map((r) => [r._id, r.n]));
            const out = [];
            const labels = [];
            for (let i = hours - 1; i >= 0; i--) {
                const t = new Date(Date.now() - i * 3600_000);
                const key = t.toLocaleString('sv-SE', {
                    timeZone: 'Asia/Kolkata',
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    hour12: false,
                }).replace(' ', 'T').slice(0, 13);
                labels.push(key.slice(11) + ':00');
                out.push(map.get(key) || 0);
            }
            return { labels, values: out };
        } catch (err) {
            logger.debug(`Dashboard hourly buckets failed: ${err.message}`);
            return {
                labels: Array.from({ length: hours }, (_, i) => `${i}`),
                values: Array.from({ length: hours }, () => 0),
            };
        }
    }

    async getContentStats() {
        const todayStart = startOfTodayLocal();
        const todayStr = getTodayDateStrIST();
        const courses = this.col('posted_courses');
        const news = this.col('posted_news');
        const github = this.col('posted_github_repos');
        const movies = this.col('movie_search_log');
        const trade = this.col('trade_alert_sent');

        const [
            coursesToday,
            coursesWeek,
            newsToday,
            githubToday,
            movieSearchesToday,
            tradeToday,
            recentCourses,
            recentNews,
            topMovies,
            coursesHourly,
            newsHourly,
            movieHourly,
        ] = await Promise.all([
            this._countSince(courses, 'posted_at', todayStart),
            this._countSince(courses, 'posted_at', daysAgo(7)),
            this._countSince(news, 'posted_at', todayStart),
            this._countSince(github, 'posted_at', todayStart),
            movies ? movies.countDocuments({ date: todayStr }) : 0,
            this._countSince(trade, 'sent_at', todayStart),
            courses
                ? courses.find({ posted_at: { $gte: todayStart } }).sort({ posted_at: -1 }).limit(12).toArray()
                : [],
            news
                ? news.find({ posted_at: { $gte: todayStart } }).sort({ posted_at: -1 }).limit(12).toArray()
                : [],
            movies
                ? movies
                      .aggregate([
                          { $match: { date: todayStr } },
                          { $group: { _id: '$query_lower', query: { $first: '$query' }, count: { $sum: 1 } } },
                          { $sort: { count: -1 } },
                          { $limit: 8 },
                      ])
                      .toArray()
                : [],
            this._hourlyBuckets(courses, 'posted_at', 24),
            this._hourlyBuckets(news, 'posted_at', 24),
            movies
                ? this._hourlyBuckets(movies, 'created_at', 24)
                : { labels: [], values: [] },
        ]);

        // Unique course titles today (posts are per-group)
        let uniqueCoursesToday = 0;
        if (courses) {
            try {
                const u = await courses.distinct('course_id', { posted_at: { $gte: todayStart } });
                uniqueCoursesToday = u.length;
            } catch {
                uniqueCoursesToday = 0;
            }
        }

        return {
            coursesToday,
            uniqueCoursesToday,
            coursesWeek,
            newsToday,
            githubToday,
            movieSearchesToday,
            tradeToday,
            recentCourses: recentCourses.map((c) => ({
                name: c.name || c.course_id,
                group: c.group_id,
                at: c.posted_at,
            })),
            recentNews: recentNews.map((n) => ({
                title: n.title || 'News',
                group: n.group_id,
                at: n.posted_at,
            })),
            topMovies: topMovies.map((m) => ({ query: m.query, count: m.count })),
            charts: {
                coursesHourly,
                newsHourly,
                movieHourly,
            },
        };
    }

    async getGroupIntelligence() {
        const todayStr = getTodayDateStrIST();
        const todayStart = startOfTodayLocal();
        const chatLog = this.col('group_chat_log');
        const movies = this.col('movie_search_log');
        const courses = this.col('posted_courses');
        const news = this.col('posted_news');

        /** @type {Map<string, { id: string, chat: number, movie: number, course: number, news: number, name?: string }>} */
        const map = new Map();

        const bump = (id, field, n = 1) => {
            if (!id) return;
            if (!map.has(id)) map.set(id, { id, chat: 0, movie: 0, course: 0, news: 0 });
            map.get(id)[field] += n;
        };

        try {
            if (chatLog) {
                const rows = await chatLog
                    .aggregate([
                        { $match: { date: todayStr } },
                        { $group: { _id: '$group_id', n: { $sum: 1 } } },
                    ])
                    .toArray();
                for (const r of rows) bump(r._id, 'chat', r.n);
            }
            if (movies) {
                const rows = await movies
                    .aggregate([
                        { $match: { date: todayStr } },
                        { $group: { _id: '$chat_id', n: { $sum: 1 } } },
                    ])
                    .toArray();
                for (const r of rows) bump(r._id, 'movie', r.n);
            }
            if (courses) {
                const rows = await courses
                    .aggregate([
                        { $match: { posted_at: { $gte: todayStart } } },
                        { $group: { _id: '$group_id', n: { $sum: 1 } } },
                    ])
                    .toArray();
                for (const r of rows) bump(r._id, 'course', r.n);
            }
            if (news) {
                const rows = await news
                    .aggregate([
                        { $match: { posted_at: { $gte: todayStart } } },
                        { $group: { _id: '$group_id', n: { $sum: 1 } } },
                    ])
                    .toArray();
                for (const r of rows) bump(r._id, 'news', r.n);
            }
        } catch (err) {
            logger.warn(`Dashboard group intel failed: ${err.message}`);
        }

        // Attach names + feature flags from group manager
        let groupRows = [];
        try {
            groupRows = this.groupManager?.groups
                ? await this.groupManager.groups.find({}, { projection: {
                    group_id: 1,
                    group_name: 1,
                    movie_enabled: 1,
                    summary_enabled: 1,
                    courses_enabled: 1,
                    news_enabled: 1,
                    github_trending: 1,
                    is_active: 1,
                } }).toArray()
                : [];
        } catch {
            groupRows = [];
        }
        const metaById = new Map(groupRows.map((g) => [g.group_id, g]));

        const ranked = [...map.values()]
            .map((g) => {
                const meta = metaById.get(g.id) || {};
                const score = g.chat * 1 + g.movie * 8 + g.course * 5 + g.news * 4;
                const reasons = [];
                if (g.chat >= 40) reasons.push('dense chat');
                else if (g.chat >= 10) reasons.push('active chat');
                if (g.movie >= 5) reasons.push('movie search spike');
                else if (g.movie >= 1) reasons.push('movie searches');
                if (g.course >= 1) reasons.push('course drops');
                if (g.news >= 1) reasons.push('news posts');
                if (meta.summary_enabled) reasons.push('recap on');
                if (meta.movie_enabled) reasons.push('movie on');
                if (!reasons.length) reasons.push('light activity');
                return {
                    groupId: g.id,
                    name: meta.group_name || g.id,
                    score,
                    chat: g.chat,
                    movie: g.movie,
                    course: g.course,
                    news: g.news,
                    reasons,
                    flags: {
                        movie: Boolean(meta.movie_enabled),
                        summary: Boolean(meta.summary_enabled),
                        courses: meta.courses_enabled !== false && meta.is_active,
                        news: meta.news_enabled !== false && meta.is_active,
                        github: meta.github_trending !== false && meta.is_active,
                    },
                };
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, 15);

        const featureCounts = {
            courses: groupRows.filter((g) => g.is_active && g.courses_enabled !== false).length,
            news: groupRows.filter((g) => g.is_active && g.news_enabled !== false).length,
            movie: groupRows.filter((g) => g.movie_enabled).length,
            summary: groupRows.filter((g) => g.summary_enabled).length,
            github: groupRows.filter((g) => g.is_active && g.github_trending !== false).length,
            total: groupRows.length,
        };

        return { ranked, featureCounts };
    }

    async getAnalytics() {
        const courses = this.col('posted_courses');
        const movies = this.col('movie_search_log');
        const news = this.col('posted_news');
        const since = daysAgo(14);

        const dayBuckets = async (collection, field, isDateStr = false) => {
            if (!collection) return { labels: [], values: [] };
            try {
                if (isDateStr) {
                    const rows = await collection
                        .aggregate([
                            { $match: { created_at: { $gte: since } } },
                            { $group: { _id: '$date', n: { $sum: 1 } } },
                            { $sort: { _id: 1 } },
                        ])
                        .toArray();
                    return {
                        labels: rows.map((r) => r._id),
                        values: rows.map((r) => r.n),
                    };
                }
                const rows = await collection
                    .aggregate([
                        { $match: { [field]: { $gte: since } } },
                        {
                            $group: {
                                _id: {
                                    $dateToString: {
                                        format: '%Y-%m-%d',
                                        date: `$${field}`,
                                        timezone: 'Asia/Kolkata',
                                    },
                                },
                                n: { $sum: 1 },
                            },
                        },
                        { $sort: { _id: 1 } },
                    ])
                    .toArray();
                return {
                    labels: rows.map((r) => r._id),
                    values: rows.map((r) => r.n),
                };
            } catch {
                return { labels: [], values: [] };
            }
        };

        const [coursesDaily, newsDaily, moviesDaily] = await Promise.all([
            dayBuckets(courses, 'posted_at'),
            dayBuckets(news, 'posted_at'),
            dayBuckets(movies, 'created_at', true),
        ]);

        return { coursesDaily, newsDaily, moviesDaily };
    }

    /** Movie vault (Mongo cache) + freshness for the workload card. */
    async getMovieCacheStats() {
        const col = this.col('movie_search_cache');
        const empty = { entries: 0, hits: 0, fresh: 0, top: [] };
        if (!col) return empty;
        try {
            const freshSince = new Date(Date.now() - 24 * 60 * 60 * 1000);
            const [entries, hitAgg, fresh, top] = await Promise.all([
                col.countDocuments(),
                col.aggregate([{ $group: { _id: null, hits: { $sum: { $ifNull: ['$hit_count', 0] } } } }]).toArray(),
                col.countDocuments({ last_fetched_at: { $gte: freshSince } }),
                col
                    .find({}, { projection: { query_key: 1, hit_count: 1, last_fetched_at: 1 } })
                    .sort({ hit_count: -1 })
                    .limit(5)
                    .toArray(),
            ]);
            return {
                entries,
                hits: Number(hitAgg[0]?.hits || 0),
                fresh,
                top: top.map((row) => ({
                    query: row.query_key || 'unknown',
                    hits: Number(row.hit_count || 0),
                    at: row.last_fetched_at || null,
                })),
            };
        } catch (err) {
            logger.debug(`Dashboard movie cache stats failed: ${err.message}`);
            return empty;
        }
    }

    /** Latest durable scheduler records, read from the same Mongo store used to prevent reruns. */
    async getSchedulerStatus() {
        const settings = this.col('bot_settings');
        const kinds = ['news', 'morning', 'trade', 'awesome', 'summary'];
        if (!settings) return kinds.map((kind) => ({ kind, status: 'unavailable', at: null }));

        try {
            const rows = await settings.find({ key: { $in: kinds.map((kind) => `scheduler_slots_${kind}`) } }).toArray();
            const byKey = new Map(rows.map((row) => [row.key, row.value]));
            return kinds.map((kind) => {
                const slots = byKey.get(`scheduler_slots_${kind}`);
                const entries = slots && typeof slots === 'object' && !Array.isArray(slots)
                    ? Object.entries(slots)
                    : [];
                const latest = entries
                    .map(([slot, at]) => ({ slot, at: typeof at === 'string' ? at : null }))
                    .filter((entry) => entry.at)
                    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
                return latest
                    ? { kind, status: 'completed', slot: latest.slot, at: latest.at }
                    : { kind, status: 'not_run', at: null };
            });
        } catch (err) {
            logger.debug(`Dashboard scheduler status failed: ${err.message}`);
            return kinds.map((kind) => ({ kind, status: 'unavailable', at: null }));
        }
    }

    async getSnapshot() {
        const live = botTelemetry.liveStats();
        const queue = typeof messageQueue.stats === 'function' ? messageQueue.stats() : { chats: 0, pending: 0 };
        const movieConcurrency = await loadMovieConcurrency();

        const [content, groups, analytics, schedules, movieCache, jobs] = await Promise.all([
            this.getContentStats(),
            this.getGroupIntelligence(),
            this.getAnalytics(),
            this.getSchedulerStatus(),
            this.getMovieCacheStats(),
            this.getJobQueueStats(),
        ]);

        return {
            at: new Date().toISOString(),
            connection: {
                status: this.adminPanel?.connectionStatus || 'unknown',
                phone: this.adminPanel?.connectedPhone || null,
            },
            botState: {
                coursesPaused: Boolean(this.botState?.isPaused),
                lastCheckTime: this.botState?.lastCheckTime || null,
                lastNewsCheckTime: this.botState?.lastNewsCheckTime || null,
            },
            queue,
            jobs,
            movieConcurrency,
            movieCache,
            live,
            content,
            groups,
            analytics,
            schedules,
        };
    }

    async getJobQueueStats() {
        const empty = { pending: 0, running: 0, failed: 0, driver: 'none' };
        if (!this.jobQueue || typeof this.jobQueue.stats !== 'function') return empty;
        try {
            return await this.jobQueue.stats();
        } catch (err) {
            logger.debug(`Dashboard job stats failed: ${err.message}`);
            return empty;
        }
    }
}
