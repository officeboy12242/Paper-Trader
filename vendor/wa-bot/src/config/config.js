/**
 * Configuration
 * Centralized configuration management
 */

import dotenv from 'dotenv';
import { normalizeDiscoverySource, DEFAULT_DISCOVERY_SOURCE } from '../utils/discoverySource.js';
import { resolvePublicBaseUrl } from '../utils/publicBaseUrl.js';

dotenv.config();

function parsePhoneList(value) {
    if (!value) {
        return [];
    }
    return value
        .split(',')
        .map((n) => n.trim().replace(/^\+/, '').replace(/\s/g, ''))
        .filter(Boolean);
}

export const config = {
    WHATSAPP_CHAT_ID: process.env.WHATSAPP_CHAT_ID || '',
    CHECK_INTERVAL: parseInt(process.env.CHECK_INTERVAL) || 180, // seconds
    NEWS_POST_TIMES: (process.env.NEWS_POST_TIMES || '10:00,22:00')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    NEWS_TIMEZONE: process.env.NEWS_TIMEZONE || 'Asia/Kolkata',
    NEWS_SCRAPE_INTERVAL: parseInt(process.env.NEWS_SCRAPE_INTERVAL) || 1800, // seconds — queue only, no post
    NEWS_MIN_ARTICLES: parseInt(process.env.NEWS_MIN_ARTICLES) || 10,
    MONGODB_URI: process.env.MONGODB_URI || '',
    MONGODB_DB_NAME: process.env.MONGODB_DB_NAME || 'telegramUdemy',
    OWNER_NUMBERS: parsePhoneList(process.env.OWNER_NUMBERS),
    MODERATOR_NUMBERS: parsePhoneList(process.env.MODERATOR_NUMBERS),
    STICKER_TARGET_GROUPS: process.env.STICKER_TARGET_GROUPS
        ? process.env.STICKER_TARGET_GROUPS.split(',').map((g) => g.trim()).filter(Boolean)
        : [],
    STICKER_SOURCE_CHANNELS: process.env.STICKER_SOURCE_CHANNELS
        ? process.env.STICKER_SOURCE_CHANNELS.split(',').map((c) => c.trim()).filter(Boolean)
        : [],
    STICKER_PACK_NAME: process.env.STICKER_PACK_NAME?.trim() || '',
    STICKER_PACK_AUTHOR: process.env.STICKER_PACK_AUTHOR?.trim() || '',
    /** Parallel sticker download/send workers (1–8, default 3). */
    STICKER_FORWARD_CONCURRENCY: Math.max(1, Math.min(8, parseInt(process.env.STICKER_FORWARD_CONCURRENCY, 10) || 3)),
    STICKER_INTER_SEND_DELAY_MS: Math.max(50, parseInt(process.env.STICKER_INTER_SEND_DELAY_MS, 10) || 150),
    /** Channel newsletter sticker backfill poller (set false to save CPU). */
    CHANNEL_STICKER_POLLER_ENABLED: process.env.CHANNEL_STICKER_POLLER_ENABLED !== 'false',
    /** Ping movie APIs on an interval (set false to save outbound bandwidth). */
    MOVIE_API_KEEPALIVE_ENABLED: process.env.MOVIE_API_KEEPALIVE_ENABLED !== 'false',
    /** Public URL of this bot — self-ping keeps free-tier hosts (Koyeb/Render) from scale-to-zero. */
    SELF_PING_URL: process.env.SELF_PING_URL?.trim() || '',
    /** How often to self-ping (ms, default 4 min — well under the 1h free-tier idle timer). */
    SELF_PING_INTERVAL_MS: Math.max(60_000, parseInt(process.env.SELF_PING_INTERVAL_MS, 10) || 4 * 60_000),
    /** Free-tier /movie searches per user per day (default 3). */
    MOVIE_DAILY_LIMIT: Math.max(1, parseInt(process.env.MOVIE_DAILY_LIMIT, 10) || 3),
    /** Global concurrent /movie searches (1–6). */
    MOVIE_SEARCH_MAX: Math.max(1, Math.min(6, parseInt(process.env.MOVIE_SEARCH_MAX, 10) || 4)),
    /** Redis URL enables BullMQ job driver (Phase 3). */
    REDIS_URL: process.env.REDIS_URL?.trim() || '',
    /** In-process job worker concurrency. */
    JOB_WORKER_CONCURRENCY: Math.max(1, Math.min(4, parseInt(process.env.JOB_WORKER_CONCURRENCY, 10) || 2)),
    TMDB_API_KEY: process.env.TMDB_API_KEY?.trim() || '',
    /** HDHub4u movie search API (free-udemy-courses-bot). */
    MOVIES_API_URL: process.env.MOVIES_API_URL?.trim() || 'https://free-udemy-courses-bot2.onrender.com/api/movies',
    /** Movie search — HDHub API timeout (ms). */
    MOVIE_HD_TIMEOUT_MS: Math.max(12_000, parseInt(process.env.MOVIE_HD_TIMEOUT_MS, 10) || 28_000),
    MOVIE_HD_BYPASS_ENABLED: process.env.MOVIE_HD_BYPASS_ENABLED !== 'false',
    MOVIE_HD_BYPASS_BUDGET_MS: Math.max(4_000, parseInt(process.env.MOVIE_HD_BYPASS_BUDGET_MS, 10) || 12_000),
    MOVIE_HD_BYPASS_MAX_LINKS: Math.max(1, parseInt(process.env.MOVIE_HD_BYPASS_MAX_LINKS, 10) || 10),
    MOVIE_BYPASS_MAX_CONCURRENT: Math.max(1, parseInt(process.env.MOVIE_BYPASS_MAX_CONCURRENT, 10) || 6),
    MOVIE_BYPASS_MAX_LINKS: Math.max(1, parseInt(process.env.MOVIE_BYPASS_MAX_LINKS, 10) || 5),
    /** Movie search — Drive/AtoZ timeout (ms). */
    MOVIE_SECONDARY_TIMEOUT_MS: Math.max(4_000, parseInt(process.env.MOVIE_SECONDARY_TIMEOUT_MS, 10) || 8_000),
    /** Movie search — max ms to shorten links before sending results. */
    MOVIE_SHORTEN_BUDGET_MS: Math.max(5_000, parseInt(process.env.MOVIE_SHORTEN_BUDGET_MS, 10) || 15_000),
    /** In-memory HDHub query dedupe (ms). */
    MOVIE_SEARCH_CACHE_TTL_MS: Math.max(60_000, parseInt(process.env.MOVIE_SEARCH_CACHE_TTL_MS, 10) || 5 * 60_000),
    /** MongoDB vault — skip APIs when a fresh cached search exists. */
    MOVIE_CACHE_ENABLED: process.env.MOVIE_CACHE_ENABLED !== 'false',
    /** Vault considered fresh — serve without calling APIs (default 24h). */
    MOVIE_CACHE_FRESH_MS: Math.max(60_000, parseInt(process.env.MOVIE_CACHE_FRESH_MS, 10) || 24 * 60 * 60 * 1000),
    /** Vault stale grace — serve instantly if APIs fail (default 7d). */
    MOVIE_CACHE_STALE_MS: Math.max(3600_000, parseInt(process.env.MOVIE_CACHE_STALE_MS, 10) || 7 * 24 * 60 * 60 * 1000),
    /** Hard auto-expiry: Mongo TTL deletes cache entries this long after last refresh (default 2 days). */
    MOVIE_CACHE_TTL_MS: Math.max(3600_000, parseInt(process.env.MOVIE_CACHE_TTL_MS, 10) || 2 * 24 * 60 * 60 * 1000),
    /** Background refresh vault after this age (default 6h) while still serving cached links. */
    MOVIE_CACHE_REVALIDATE_MS: Math.max(60_000, parseInt(process.env.MOVIE_CACHE_REVALIDATE_MS, 10) || 6 * 60 * 60 * 1000),
    /** Nightly pre-warm top searches into vault (default 3:30 AM IST). */
    MOVIE_CACHE_PREWARM_ENABLED: process.env.MOVIE_CACHE_PREWARM_ENABLED !== 'false',
    MOVIE_CACHE_PREWARM_HOUR: Math.min(23, Math.max(0, parseInt(process.env.MOVIE_CACHE_PREWARM_HOUR, 10) || 3)),
    MOVIE_CACHE_PREWARM_MINUTE: Math.min(59, Math.max(0, parseInt(process.env.MOVIE_CACHE_PREWARM_MINUTE, 10) || 30)),
    MOVIE_CACHE_PREWARM_TOP: Math.max(5, parseInt(process.env.MOVIE_CACHE_PREWARM_TOP, 10) || 20),
    /** Daily group chat recap (/summaryon groups). */
    GROUP_SUMMARY_ENABLED: process.env.GROUP_SUMMARY_ENABLED !== 'false',
    /** When recap is sent — default 00:00 = midnight IST (end of calendar day). */
    GROUP_SUMMARY_TIME: (process.env.GROUP_SUMMARY_TIME || '00:00').trim(),
    GROUP_SUMMARY_TIMEZONE: process.env.GROUP_SUMMARY_TIMEZONE || 'Asia/Kolkata',
    /** Produce a chat-based narrative recap (who said what / themes / decisions) instead of only listing events. */
    /**
     * Recap personality: 'rotate' (default) cycles awards / sports / documentary /
     * tabloid deterministically per group per day, or pin one by key.
     */
    GROUP_SUMMARY_STYLE: (process.env.GROUP_SUMMARY_STYLE || 'rotate').trim().toLowerCase(),
    GROUP_SUMMARY_NARRATIVE: process.env.GROUP_SUMMARY_NARRATIVE !== 'false',
    /** Min member messages that day before a full recap; below this = short quiet note or skip. */
    GROUP_SUMMARY_MIN_MESSAGES: parseInt(process.env.GROUP_SUMMARY_MIN_MESSAGES, 10) || 3,
    GROUP_SUMMARY_MAX_MESSAGES: parseInt(process.env.GROUP_SUMMARY_MAX_MESSAGES, 10) || 400,
    /** Describe image contents with Gemini when logging for /summary (needs GEMINI_API_KEY). */
    GROUP_SUMMARY_IMAGE_VISION: process.env.GROUP_SUMMARY_IMAGE_VISION !== 'false',
    /** Cap vision calls per group per day so free-tier Gemini quota isn't burned on meme spam. */
    GROUP_SUMMARY_IMAGE_VISION_MAX_PER_DAY:
        parseInt(process.env.GROUP_SUMMARY_IMAGE_VISION_MAX_PER_DAY, 10) || 40,
    /** Daily auto open/close chat — /autochat on groups open at 09:00, lock at 23:55. */
    AUTOCHAT_ENABLED: process.env.AUTOCHAT_ENABLED !== 'false',
    /** When the group chat is unlocked (members can message) each IST day. */
    AUTOCHAT_OPEN_TIME: (process.env.AUTOCHAT_OPEN_TIME || '09:00').trim(),
    /** When the group chat is locked (admins only) each IST day. */
    AUTOCHAT_CLOSE_TIME: (process.env.AUTOCHAT_CLOSE_TIME || '23:55').trim(),
    AUTOCHAT_TIMEZONE: process.env.AUTOCHAT_TIMEZONE || 'Asia/Kolkata',
    /** On boot, still open/close groups whose scheduled transition was missed. */
    AUTOCHAT_CATCHUP_ENABLED: process.env.AUTOCHAT_CATCHUP_ENABLED !== 'false',
    /** Ceiling for the LLM-generated open/close message (fallback template after this). */
    AUTOCHAT_LLM_TIMEOUT_MS: parseInt(process.env.AUTOCHAT_LLM_TIMEOUT_MS, 10) || 25_000,
    NVIDIA_API_KEY: process.env.NVIDIA_API_KEY?.trim() || '',
    /** Group summary / recap model */
    NVIDIA_MODEL: process.env.NVIDIA_MODEL?.trim() || 'nvidia/nemotron-3-super-120b-a12b',
    /** Trade discovery, research, CE/PE analysis — Gemini (not GLM) */
    GEMINI_TRADE_MODEL: process.env.GEMINI_TRADE_MODEL?.trim() || 'gemini-2.5-flash',
    GEMINI_TRADE_MODELS: process.env.GEMINI_TRADE_MODELS?.trim() || 'gemini-2.5-flash,gemini-flash-latest,gemini-flash-lite-latest,gemini-2.5-pro',
    /** Groq fallback for trade alerts (/tradenow when Gemini rate-limited) */
    GROQ_API_KEY: process.env.GROQ_API_KEY?.trim() || '',
    GROQ_TRADE_MODEL: process.env.GROQ_TRADE_MODEL?.trim() || 'openai/gpt-oss-120b',
    GROQ_TRADE_MODELS: process.env.GROQ_TRADE_MODELS?.trim() || 'openai/gpt-oss-120b,qwen/qwen3.8-27b',
    /** Provider order: orcarouter (free DeepSeek V4 Flash) → gemini → groq → nvidia → openrouter */
    TRADE_LLM_PROVIDERS: (process.env.TRADE_LLM_PROVIDERS || 'orcarouter,gemini,groq,nvidia,openrouter').trim(),
    /** After a provider 429, skip it for this many ms (daily scan keeps using fallbacks). */
    TRADE_LLM_COOLDOWN_MS: (() => {
        const n = parseInt(process.env.TRADE_LLM_COOLDOWN_MS, 10);
        if (!Number.isFinite(n) || n <= 0) return 90_000;
        return Math.min(5 * 60_000, Math.max(15_000, n));
    })(),
    /** Per-provider requests/minute budget: "gemini:8,groq:25,nvidia:35,openrouter:15". */
    TRADE_LLM_RPM: (process.env.TRADE_LLM_RPM || '').trim(),
    /** Max simultaneous LLM calls across all trade providers. */
    TRADE_LLM_MAX_CONCURRENT: Math.max(1, parseInt(process.env.TRADE_LLM_MAX_CONCURRENT, 10) || 3),
    /** Max simultaneous LLM calls against a single provider. */
    TRADE_LLM_MAX_PER_PROVIDER: Math.max(
        1,
        parseInt(process.env.TRADE_LLM_MAX_PER_PROVIDER, 10) || 2
    ),
    /** How long a burst request may queue for provider capacity before firing anyway. */
    TRADE_LLM_QUEUE_WAIT_MS: Math.min(
        120_000,
        Math.max(0, parseInt(process.env.TRADE_LLM_QUEUE_WAIT_MS, 10) || 45_000)
    ),
    /** Extra keys per provider (comma separated) — multiplies free-tier headroom. */
    GEMINI_API_KEYS: process.env.GEMINI_API_KEYS?.trim() || '',
    GROQ_API_KEYS: process.env.GROQ_API_KEYS?.trim() || '',
    NVIDIA_API_KEYS: process.env.NVIDIA_API_KEYS?.trim() || '',
    OPENROUTER_API_KEYS: process.env.OPENROUTER_API_KEYS?.trim() || '',
    /** Reuse an identical /tradenow result for this long instead of re-running the pipeline. */
    TRADENOW_CACHE_TTL_MS: Math.min(
        15 * 60_000,
        Math.max(0, parseInt(process.env.TRADENOW_CACHE_TTL_MS, 10) || 120_000)
    ),

    /* ── Swing momentum scan (/swing) ───────────────────────────────────────
     * Deterministic ranking + breakout timing + regime gate. No LLM involved. */
    /** Override the scan universe entirely: SWING_UNIVERSE=RELIANCE,TCS,... */
    SWING_UNIVERSE: process.env.SWING_UNIVERSE?.trim() || '',
    SWING_SCAN_CONCURRENCY: Math.max(
        1,
        Math.min(10, parseInt(process.env.SWING_SCAN_CONCURRENCY, 10) || 6)
    ),
    /** Risk-free rate used to compute excess return in the momentum ratio. */
    SWING_RISK_FREE_RATE: Number(process.env.SWING_RISK_FREE_RATE) || 0.065,
    /** Entry must be within this % of the 52-week high. */
    SWING_MAX_PCT_FROM_HIGH: Number(process.env.SWING_MAX_PCT_FROM_HIGH) || 5,
    /** Breakout day volume must exceed this multiple of the 20-day average. */
    SWING_MIN_VOLUME_RATIO: Number(process.env.SWING_MIN_VOLUME_RATIO) || 1.5,
    /** Liquidity floor in ₹ crore of average daily turnover — keeps slippage sane. */
    SWING_MIN_TURNOVER_CR: Number(process.env.SWING_MIN_TURNOVER_CR) || 5,
    SWING_MAX_PICKS: Math.max(1, parseInt(process.env.SWING_MAX_PICKS, 10) || 5),
    /** Stop distance in ATR(14) multiples. Research supports 1.5–2.0. */
    SWING_ATR_STOP_MULT: Number(process.env.SWING_ATR_STOP_MULT) || 2,
    /** Capital and per-trade risk used for position sizing in the message. */
    SWING_CAPITAL: Number(process.env.SWING_CAPITAL) || 100_000,
    SWING_RISK_PCT: Number(process.env.SWING_RISK_PCT) || 0.5,

    /* ── Expiry-day index options (/expiry) ─────────────────────────────────
     * NIFTY settles every Tuesday; BANKNIFTY/FINNIFTY/MIDCPNIFTY on the last
     * Tuesday only (SEBI limited each exchange to one weekly index in Nov 2024). */
    EXPIRY_ALERT_ENABLED: process.env.EXPIRY_ALERT_ENABLED !== 'false',
    EXPIRY_MORNING_TIME: (process.env.EXPIRY_MORNING_TIME || '09:35').trim(),
    EXPIRY_AFTERNOON_TIME: (process.env.EXPIRY_AFTERNOON_TIME || '13:15').trim(),
    EXPIRY_RISK_FREE_RATE: Number(process.env.EXPIRY_RISK_FREE_RATE) || 0.065,
    /** Hero-zero strike selection band, by absolute delta. */
    EXPIRY_HERO_DELTA_MIN: Number(process.env.EXPIRY_HERO_DELTA_MIN) || 0.02,
    EXPIRY_HERO_DELTA_MAX: Number(process.env.EXPIRY_HERO_DELTA_MAX) || 0.12,
    EXPIRY_HERO_MAX_PREMIUM: Number(process.env.EXPIRY_HERO_MAX_PREMIUM) || 25,
    /** Directional ATM trade: premium stop and R-multiple targets. */
    EXPIRY_ATM_STOP_PCT: Number(process.env.EXPIRY_ATM_STOP_PCT) || 20,
    EXPIRY_ATM_T1_PCT: Number(process.env.EXPIRY_ATM_T1_PCT) || 50,
    EXPIRY_ATM_T2_PCT: Number(process.env.EXPIRY_ATM_T2_PCT) || 100,
    /** Break must extend this fraction beyond the opening range to count. */
    EXPIRY_MIN_RANGE_EXPANSION: Number(process.env.EXPIRY_MIN_RANGE_EXPANSION) || 0.3,
    /** Lot sizes change at SEBI revisions: "NIFTY:75,BANKNIFTY:30". */
    EXPIRY_LOT_SIZES: (process.env.EXPIRY_LOT_SIZES || '').trim(),
    /** @deprecated Trade alerts use Gemini; kept for group summaries only */
    NVIDIA_TRADE_MODEL: process.env.NVIDIA_TRADE_MODEL?.trim() || 'nvidia/nemotron-3-super-120b-a12b',
    /** Google Gemini API key — used by trade router, assist, and other LLM services */
    GEMINI_API_KEY: process.env.GEMINI_API_KEY?.trim() || '',
    /** Owner DM assistant — replies as ASSIST_OWNER_NAME in personal chats when /assist on */
    ASSIST_OWNER_NAME: process.env.ASSIST_OWNER_NAME?.trim() || 'Jacky',
    /** Short bio the AI shares when people ask about the owner (optional override) */
    ASSIST_OWNER_ABOUT: process.env.ASSIST_OWNER_ABOUT?.trim() || '',
    ASSIST_GEMINI_MODEL: process.env.ASSIST_GEMINI_MODEL?.trim() || 'gemini-2.5-flash',
    ASSIST_GEMINI_MODELS: process.env.ASSIST_GEMINI_MODELS?.trim() || 'gemini-2.5-flash,gemini-flash-latest,gemini-flash-lite-latest,gemini-2.5-pro',
    /** Assist fallback — Groq / NVIDIA (same keys as trade) */
    ASSIST_GROQ_MODEL: process.env.ASSIST_GROQ_MODEL?.trim() || 'openai/gpt-oss-120b',
    ASSIST_GROQ_MODELS: process.env.ASSIST_GROQ_MODELS?.trim() || 'openai/gpt-oss-120b,qwen/qwen3.8-27b',
    /**
     * How long an assist provider is skipped after a QUOTA error (not a burst 429).
     * A daily quota does not recover in seconds, and re-walking a dead provider's
     * model list cost ~90s per call before this existed.
     */
    ASSIST_LLM_COOLDOWN_MS: (() => {
        const n = parseInt(process.env.ASSIST_LLM_COOLDOWN_MS, 10);
        if (!Number.isFinite(n) || n <= 0) return 15 * 60_000;
        return Math.min(60 * 60_000, Math.max(60_000, n));
    })(),
    ASSIST_NVIDIA_MODEL: process.env.ASSIST_NVIDIA_MODEL?.trim() || '',
    ASSIST_NVIDIA_MODELS: process.env.ASSIST_NVIDIA_MODELS?.trim() || '',
    /** Provider order for /assist DMs: gemini,groq,nvidia */
    ASSIST_LLM_PROVIDERS: (process.env.ASSIST_LLM_PROVIDERS || process.env.TRADE_LLM_PROVIDERS || 'gemini,groq,nvidia,openrouter').trim(),
    ASSIST_MAX_HISTORY: Math.max(4, parseInt(process.env.ASSIST_MAX_HISTORY, 10) || 12),
    ASSIST_REPLY_COOLDOWN_MS: Math.max(1500, parseInt(process.env.ASSIST_REPLY_COOLDOWN_MS, 10) || 3500),
    ASSIST_TIMEOUT_MS: Math.min(60_000, Math.max(15_000, parseInt(process.env.ASSIST_TIMEOUT_MS, 10) || 45_000)),
    NVIDIA_API_BASE_URL: process.env.NVIDIA_API_BASE_URL?.trim() || 'https://integrate.api.nvidia.com/v1/chat/completions',
    /** Capped at 120s — avoid huge env values (e.g. 900000) that hang recaps. */
    NVIDIA_TIMEOUT_MS: (() => {
        const n = parseInt(process.env.NVIDIA_TIMEOUT_MS, 10);
        if (!Number.isFinite(n) || n <= 0) return 60_000;
        return Math.min(120_000, Math.max(20_000, n));
    })(),
    /** Max chat lines sent to the LLM per recap (rest are sampled). */
    GROUP_SUMMARY_LLM_MAX_MESSAGES: parseInt(process.env.GROUP_SUMMARY_LLM_MAX_MESSAGES, 10) || 100,
    /** Use map-reduce summarization when a day exceeds this many logged messages. */
    GROUP_SUMMARY_CHUNK_THRESHOLD: parseInt(process.env.GROUP_SUMMARY_CHUNK_THRESHOLD, 10) || 150,
    /** Messages per chunk when map-reduce is used. */
    GROUP_SUMMARY_CHUNK_SIZE: parseInt(process.env.GROUP_SUMMARY_CHUNK_SIZE, 10) || 50,
    /** LLM timeout for group recap (defaults to max(90s, NVIDIA_TIMEOUT_MS)). */
    GROUP_SUMMARY_LLM_TIMEOUT_MS: (() => {
        const n = parseInt(process.env.GROUP_SUMMARY_LLM_TIMEOUT_MS, 10);
        if (!Number.isFinite(n) || n <= 0) return 0;
        return Math.min(120_000, Math.max(30_000, n));
    })(),
    /** Daily F&O trade alerts (/tradelert on groups). */
    TRADE_ALERT_ENABLED: process.env.TRADE_ALERT_ENABLED !== 'false',
    /** Pre-market scan time IST — default 09:20 so posts land ~09:22 after fast scan. */
    TRADE_ALERT_TIME: (process.env.TRADE_ALERT_TIME || '09:20').trim(),
    TRADE_ALERT_TIMEZONE: process.env.TRADE_ALERT_TIMEZONE || 'Asia/Kolkata',
    /**
     * Optional extra clock for heatmap2 groups. EMPTY BY DEFAULT — every source
     * shares TRADE_ALERT_TIME, because a breakout entry decays fast and a later
     * post means filling well above the level.
     *
     * The trade-off, stated plainly: at 09:20 only the forming 09:15 bar exists,
     * so v2 posts its watchlist (live movers, sector-aligned, beating NIFTY) but
     * no entry/stop/target — a confirmed break needs the opening range closed
     * plus a following bar. Set this to e.g. `09:50,11:15` to ALSO get a later
     * post carrying real levels; v1 / legacy / nse always stay on the main slot.
     */
    TRADE_ALERT_HEATMAP2_TIMES: (process.env.TRADE_ALERT_HEATMAP2_TIMES || '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => /^\d{1,2}:\d{2}$/.test(s)),
    /**
     * Clock for `preopen` groups. EMPTY BY DEFAULT.
     *
     * The NSE pre-open auction runs 09:00–09:08, so 09:15 is the earliest post
     * that carries same-day information and the latest that still beats the open.
     * Only set this once a group is actually switched to the `preopen` source —
     * setting it also moves those groups OFF the 09:20 slot so they post once.
     *
     * Note the pre-open ranking is not backtested (NSE publishes no history for
     * that endpoint), so treat its output as a watchlist with risk levels until
     * TradeOutcomeResolver has graded enough of it.
     */
    TRADE_ALERT_PREOPEN_TIME: (process.env.TRADE_ALERT_PREOPEN_TIME || '').trim(),
    /**
     * Turnover band for the `turnover` source, 1-indexed inclusive.
     *
     * Defaults to ranks 11–30 on purpose: measured intraday on 5m bars with real
     * traded prices, ranks 1–10 were NEGATIVE (-0.035R) while 11–20 (+0.038R),
     * 21–30 (+0.141R) and 31–50 (+0.089R) were positive. The top of the list
     * spends its move overnight, so it is already priced in by 09:20.
     *
     * n was 38–100 per band over 21 sessions, which is far too thin to size a
     * decision on — see TurnoverBandScanService for the full caveat.
     */
    TURNOVER_BAND_FROM: Math.max(1, parseInt(process.env.TURNOVER_BAND_FROM, 10) || 11),
    TURNOVER_BAND_TO: Math.max(2, parseInt(process.env.TURNOVER_BAND_TO, 10) || 30),
    /**
     * Clock for `turnover` groups. EMPTY BY DEFAULT — they share TRADE_ALERT_TIME
     * (09:20) until this is set.
     *
     * This source reads only the PREVIOUS session's daily candles, so it has
     * nothing to gain by waiting for the opening range and can post as early as
     * you like — 09:15 puts it in front of the open. Setting it also moves those
     * groups OFF the shared slot so they post once.
     */
    TRADE_ALERT_TURNOVER_TIME: (process.env.TRADE_ALERT_TURNOVER_TIME || '').trim(),
    /**
     * Optional morning volatility scan — runs AFTER the market opens (09:15).
     *
     * The pre-market scan at TRADE_ALERT_TIME (09:20) uses stale data because
     * the market hasn't opened yet. This second clock fires at 09:35 by default
     * — 20 minutes after open — when the opening range has closed and real
     * intraday moves are visible. It re-runs discovery with fresh data, so
     * stocks that only became movers after the open appear here.
     *
     * Groups already posted at 09:20 skip duplicate symbols (dedup by trade_alert_sent).
     * Empty by default: set to a time like 09:35 to enable.
     */
    TRADE_ALERT_MORNING_VOLATILITY_TIME: (process.env.TRADE_ALERT_MORNING_VOLATILITY_TIME || '09:35').trim(),
    /**
     * /index position sizing. The measured index-fade edge is at 1:1, so target
     * and risk are the same size — one lot at a 1R move lands inside this band for
     * all four indices (NIFTY Rs608, BANKNIFTY Rs874, FINNIFTY Rs912, MIDCPNIFTY
     * Rs853). Raising the band sizes UP, which raises the loss by the same amount.
     */
    INDEX_TRADE_CAPITAL: Math.max(1000, parseInt(process.env.INDEX_TRADE_CAPITAL, 10) || 30_000),
    INDEX_TRADE_MIN_PROFIT: Math.max(100, parseInt(process.env.INDEX_TRADE_MIN_PROFIT, 10) || 600),
    INDEX_TRADE_MAX_PROFIT: Math.max(200, parseInt(process.env.INDEX_TRADE_MAX_PROFIT, 10) || 1_200),
    /**
     * /index tgbot2 strategy engines (Confluence · ORB · PCR Reversal · MACD-MTF
     * · Mean Reversion). These run almost all trading day so the card almost never
     * dead-ends with NO ENTRY — the measured fade rule is only 10:00-12:30. Their
     * win rates are tgbot2's own backtests, printed on the card as unverified.
     */
    INDEX_STRATEGY_MIN_LAYERS: Math.max(2, Math.min(4, parseInt(process.env.INDEX_STRATEGY_MIN_LAYERS, 10) || 3)),
    INDEX_STRATEGY_ORB_BREAK_PCT: Math.max(
        0.02,
        Math.min(0.5, parseFloat(process.env.INDEX_STRATEGY_ORB_BREAK_PCT) || 0.08)
    ),
    INDEX_STRATEGY_MIN_ADX: Math.max(10, Math.min(30, parseInt(process.env.INDEX_STRATEGY_MIN_ADX, 10) || 16)),
    /** IST minute-of-day after which the strategy engines stop taking entries. */
    INDEX_STRATEGY_LAST_ENTRY_MIN: Math.max(
        9 * 60,
        Math.min(15 * 60 + 30, parseInt(process.env.INDEX_STRATEGY_LAST_ENTRY_MIN, 10) || 15 * 60)
    ),
    /* ── SVMKR live scanner (/svmkr) ─────────────────────────────────────────
     * The one continuously-running market scanner: UT Bot trailing-stop cross
     * confirmed by HMA and regression slope, evaluated on every closed 5m bar
     * during the session.
     *
     * Delivery is opted into PER GROUP with `/svmkr on`. This flag is only a
     * kill switch: set it to "false" to stop the loop everywhere regardless of
     * group settings. Left unset, the loop runs but stays idle — with no group
     * opted in a tick costs one indexed count query and no market API calls.
     *
     * Trades are uncapped per day on purpose; SVMKR_COOLDOWN_MS is the only
     * brake, and it is per index+side. Dropping it below ~5 min on a choppy day
     * will produce a card every other bar.
     */
    SVMKR_ENABLED: process.env.SVMKR_ENABLED === 'false' ? false : true,
    SVMKR_INDICES: (process.env.SVMKR_INDICES || 'NIFTY')
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    SVMKR_COOLDOWN_MS: Math.max(
        60_000,
        Math.min(2 * 3600_000, parseInt(process.env.SVMKR_COOLDOWN_MS, 10) || 15 * 60_000)
    ),
    /** UT Bot inputs — defaults are the public script's (ATR 10, sensitivity 1). */
    SVMKR_ATR_PERIOD: Math.max(2, Math.min(50, parseInt(process.env.SVMKR_ATR_PERIOD, 10) || 10)),
    SVMKR_SENSITIVITY: Math.max(
        0.5,
        Math.min(5, parseFloat(process.env.SVMKR_SENSITIVITY) || 1)
    ),
    SVMKR_HEIKIN_ASHI: process.env.SVMKR_HEIKIN_ASHI === 'true',
    SVMKR_HMA_PERIOD: Math.max(5, Math.min(200, parseInt(process.env.SVMKR_HMA_PERIOD, 10) || 21)),
    SVMKR_LRS_PERIOD: Math.max(5, Math.min(200, parseInt(process.env.SVMKR_LRS_PERIOD, 10) || 20)),
    /** IST minute-of-day after which no new SVMKR entry is taken. */
    SVMKR_LAST_ENTRY_MIN: Math.max(
        9 * 60 + 30,
        Math.min(15 * 60 + 15, parseInt(process.env.SVMKR_LAST_ENTRY_MIN, 10) || 15 * 60)
    ),

    /** Parallel symbol analyses during daily scan (1–3). */
    TRADE_ALERT_SCAN_CONCURRENCY: Math.max(
        1,
        Math.min(3, parseInt(process.env.TRADE_ALERT_SCAN_CONCURRENCY, 10) || 2)
    ),
    /** Optional second LLM research step on daily path (off by default — too slow / rate-limit prone). */
    TRADE_DAILY_RESEARCH: process.env.TRADE_DAILY_RESEARCH === 'true',
    /** Default watchlist when group has no /tradelert stocks set. */
    TRADE_ALERT_STOCKS: (process.env.TRADE_ALERT_STOCKS || 'NIFTY,BANKNIFTY,RELIANCE,TCS')
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    /** auto = AI picks stocks from live news/movers; manual = fixed watchlist */
    TRADE_ALERT_MODE: (process.env.TRADE_ALERT_MODE || 'auto').trim().toLowerCase() === 'manual' ? 'manual' : 'auto',

    /* ── Continuous /tradenow auto-trigger ──────────────────────────────────
     * Re-runs the /tradenow analysis through the session and posts when the
     * model's self-reported confidence clears the threshold. OFF by default:
     * it spends an LLM call per index per scan, and the gate is the model's
     * own number rather than any measured win rate.
     */
    TRADENOW_AUTO_ENABLED: process.env.TRADENOW_AUTO_ENABLED === 'true',
    TRADENOW_AUTO_INDICES: (process.env.TRADENOW_AUTO_INDICES || 'NIFTY')
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    TRADENOW_AUTO_MIN_CONF: Number.parseInt(process.env.TRADENOW_AUTO_MIN_CONF || '65', 10),
    TRADENOW_AUTO_INTERVAL_MS:
        Number.parseInt(process.env.TRADENOW_AUTO_INTERVAL_MIN || '5', 10) * 60_000,
    TRADENOW_AUTO_COOLDOWN_MS:
        Number.parseInt(process.env.TRADENOW_AUTO_COOLDOWN_MIN || '30', 10) * 60_000,
    TRADENOW_AUTO_MAX_PER_DAY: Number.parseInt(process.env.TRADENOW_AUTO_MAX_PER_DAY || '6', 10),
    /** Ceiling on analysis calls per day — the free LLM tiers are shared. */
    TRADENOW_AUTO_MAX_SCANS_PER_DAY:
        Number.parseInt(process.env.TRADENOW_AUTO_MAX_SCANS_PER_DAY || '60', 10),
    /** Daily alerts: only post BUY CALL/PUT when confidence ≥ 70% */
    TRADE_ALERT_ONLY_BUY_SIGNALS: process.env.TRADE_ALERT_ONLY_BUY_SIGNALS !== 'false',
    /** Max actionable alerts per group per day */
    TRADE_ALERT_MAX_SENDS: Math.max(1, parseInt(process.env.TRADE_ALERT_MAX_SENDS, 10) || 5),
    /** How many symbols AI discovery picks to scan */
    TRADE_ALERT_DISCOVERY_COUNT: Math.max(8, Math.min(15, parseInt(process.env.TRADE_ALERT_DISCOVERY_COUNT, 10) || 10)),
    /**
     * Discovery source for auto mode:
     * - heatmap  = v1: NSE heatmap ±2% + 15m OR breakout + 8 EMA
     * - heatmap2 = v2: live intraday % + VWAP + relative strength + ATR stops
     * - nse      = NIFTY 50 top gainers + losers
     * - legacy   = sectors/movers/smart-money merge
     * Overridable per group via `/tradelert source heatmap|heatmap2|nse|legacy`
     */
    TRADE_ALERT_DISCOVERY_SOURCE: normalizeDiscoverySource(
        process.env.TRADE_ALERT_DISCOVERY_SOURCE || DEFAULT_DISCOVERY_SOURCE
    ),
    /** Top N gainers + top N losers when discovery source is nse (default 5+5). */
    TRADE_ALERT_NSE_GL_EACH: Math.max(1, Math.min(10, parseInt(process.env.TRADE_ALERT_NSE_GL_EACH, 10) || 5)),
    /** Heatmap path: max symbols to analyze after OR/EMA scan. */
    TRADE_ALERT_HEATMAP_MAX: Math.max(4, Math.min(12, parseInt(process.env.TRADE_ALERT_HEATMAP_MAX, 10) || 8)),
    /** Heatmap path: minimum |% change| by scan time (PDF: ±2%). */
    TRADE_ALERT_HEATMAP_MIN_MOVE_PCT: Math.max(
        1,
        Math.min(5, parseFloat(process.env.TRADE_ALERT_HEATMAP_MIN_MOVE_PCT) || 2)
    ),

    /* ── Heatmap v2 ─────────────────────────────────────────────────────────
     * v2 measures the live intraday move rather than the pre-open gap, so a
     * lower floor here selects more than v1's ±2% did against stale data.
     */
    /** v2: minimum live |% change| for a candidate (default 1.5%). */
    HEATMAP_V2_MIN_MOVE_PCT: Math.max(
        0.5,
        Math.min(5, parseFloat(process.env.HEATMAP_V2_MIN_MOVE_PCT) || 1.5)
    ),
    /** v2: minimum setup score 0–100 (quality dimensions only). */
    HEATMAP_V2_MIN_SCORE: Math.max(0, Math.min(100, parseInt(process.env.HEATMAP_V2_MIN_SCORE, 10) || 60)),
    /** v2: cap picks per sector so N picks aren't one sector N times. */
    HEATMAP_V2_MAX_PER_SECTOR: Math.max(1, Math.min(8, parseInt(process.env.HEATMAP_V2_MAX_PER_SECTOR, 10) || 3)),
    /** v2: parallel candle fetches. */
    HEATMAP_V2_CONCURRENCY: Math.max(1, Math.min(12, parseInt(process.env.HEATMAP_V2_CONCURRENCY, 10) || 6)),

    /* ── Outcome resolution ─────────────────────────────────────────────── */
    /** Grade posted alerts against what price actually did. */
    TRADE_OUTCOME_RESOLVER_ENABLED: process.env.TRADE_OUTCOME_RESOLVER_ENABLED !== 'false',
    /** IST time to run the resolver — after the close so sessions are complete. */
    TRADE_OUTCOME_RESOLVE_TIME: (process.env.TRADE_OUTCOME_RESOLVE_TIME || '16:15').trim(),
    /** Strict confluence floor (0–100) for high-quality daily posts */
    TRADE_ALERT_MIN_CONFLUENCE: Math.max(25, Math.min(80, parseInt(process.env.TRADE_ALERT_MIN_CONFLUENCE, 10) || 40)),
    /** If no strict posts, still send daily AI≥70% picks with softer confluence */
    TRADE_ALERT_DAILY_SOFT_FALLBACK: process.env.TRADE_ALERT_DAILY_SOFT_FALLBACK !== 'false',
    /** Soft confluence floor used only when filling empty daily alert days */
    TRADE_ALERT_DAILY_SOFT_MIN_CONFLUENCE: Math.max(
        0,
        Math.min(50, parseInt(process.env.TRADE_ALERT_DAILY_SOFT_MIN_CONFLUENCE, 10) || 25)
    ),
    /** Step-1 AI research brief before CE/PE trade analysis */
    TRADE_TWO_STEP_RESEARCH: process.env.TRADE_TWO_STEP_RESEARCH !== 'false',
    /** Skip daily trade alerts on NSE holidays and weekends (IST) */
    TRADE_ALERT_SKIP_NON_TRADING_DAYS: process.env.TRADE_ALERT_SKIP_NON_TRADING_DAYS !== 'false',
    TRADE_ALERT_SKIP_WEEKENDS: process.env.TRADE_ALERT_SKIP_WEEKENDS !== 'false',
    /** Extra closed dates YYYY-MM-DD, comma-separated */
    TRADE_ALERT_EXTRA_HOLIDAYS: (process.env.TRADE_ALERT_EXTRA_HOLIDAYS || '').trim(),
    /** Force run on specific dates (e.g. budget Sunday) YYYY-MM-DD, comma-separated */
    TRADE_ALERT_FORCE_TRADING_DAYS: (process.env.TRADE_ALERT_FORCE_TRADING_DAYS || '').trim(),
    /** OrcaRouter — free DeepSeek V4 Flash for /chainai option-chain AI reads. */
    ORCAROUTER_API_KEY: process.env.ORCAROUTER_API_KEY?.trim() || '',
    /** Group-summary OrcaRouter model — DeepSeek V4 Flash Free is the only
     *  free DeepSeek slug OrcaRouter currently hosts (pro-free was retired).
     *  128K ctx is plenty for a day-of-group-chat single-shot summary. */
    SUMMARY_ORCAROUTER_MODEL: (process.env.SUMMARY_ORCAROUTER_MODEL || 'deepseek/deepseek-v4-flash-free').trim(),
    /** IPO auto-alerts: close day (last to apply) and listing day */
    IPO_ALERT_CLOSE_TIME: (process.env.IPO_ALERT_CLOSE_TIME || '08:30').trim(),
    IPO_ALERT_LISTING_TIME: (process.env.IPO_ALERT_LISTING_TIME || '09:45').trim(),
    IPO_ALERT_TIMEZONE: process.env.IPO_ALERT_TIMEZONE || 'Asia/Kolkata',
    /** SVMKR verdict model ladder (comma-separated, first that responds wins). */
    SVMKR_LLM_MODELS: (process.env.SVMKR_LLM_MODELS || 'deepseek/deepseek-v4-flash-free').trim(),
    /** Per-model timeout. Pro is a reasoning model — typical latency 12-25s. */
    SVMKR_LLM_TIMEOUT_MS: parseInt(process.env.SVMKR_LLM_TIMEOUT_MS || '30000', 10) || 30_000,

    /** OpenRouter — LLM fallback when Gemini/Groq/NVIDIA fail (summary, trade, assist). */
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY?.trim() || '',
    OPENROUTER_MODEL: process.env.OPENROUTER_MODEL?.trim() || 'minimax/minimax-m3:free',
    OPENROUTER_FALLBACK_MODELS: (process.env.OPENROUTER_FALLBACK_MODELS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    OPENROUTER_MODELS: (process.env.OPENROUTER_MODELS || '').trim(),
    /** Preferred OpenRouter models for group day recap (comma-separated). Coder models are skipped. */
    OPENROUTER_SUMMARY_MODELS: (process.env.OPENROUTER_SUMMARY_MODELS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    OPENROUTER_TIMEOUT_MS: (() => {
        const n = parseInt(process.env.OPENROUTER_TIMEOUT_MS, 10);
        if (!Number.isFinite(n) || n <= 0) return 90_000;
        return Math.min(120_000, Math.max(30_000, n));
    })(),
    /** Multi-target trade plan on CE/PE sections (1 lot, ₹ P&L) */
    TRADE_PLAN_ENABLED: process.env.TRADE_PLAN_ENABLED !== 'false',
    /** Partial booking % at T1,T2,T3 e.g. 50,30,20 */
    TRADE_PLAN_PARTIALS: (process.env.TRADE_PLAN_PARTIALS || '50,30,20')
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0),
    /** NVIDIA timeout for trade analysis step (max 180s) */
    TRADE_ANALYSIS_TIMEOUT_MS: (() => {
        const n = parseInt(process.env.TRADE_ANALYSIS_TIMEOUT_MS, 10);
        if (!Number.isFinite(n) || n <= 0) return 150_000;
        return Math.min(180_000, Math.max(60_000, n));
    })(),
    /** Step-1 research brief timeout (ms) */
    TRADE_RESEARCH_TIMEOUT_MS: (() => {
        const n = parseInt(process.env.TRADE_RESEARCH_TIMEOUT_MS, 10);
        if (!Number.isFinite(n) || n <= 0) return 55_000;
        return Math.min(90_000, Math.max(30_000, n));
    })(),
    BOT_LOG_NUMBER: process.env.BOT_LOG_NUMBER?.trim() || '',
    GITHUB_TRENDING_ENABLED: process.env.GITHUB_TRENDING_ENABLED !== 'false',
    GITHUB_TRENDING_TIMES: (process.env.GITHUB_TRENDING_TIMES || '09:00,11:30,14:00,16:30,19:00')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    GITHUB_TRENDING_TIMEZONE: process.env.GITHUB_TRENDING_TIMEZONE || 'Asia/Kolkata',
    GITHUB_TRENDING_COUNT: parseInt(process.env.GITHUB_TRENDING_COUNT, 10) || 5,
    /**
     * Saturdays: post college/resume projects (LLM topic mix) instead of
     * trending/popular/hidden-gem; awesome lists are skipped that day.
     */
    GITHUB_COLLEGE_SATURDAY: process.env.GITHUB_COLLEGE_SATURDAY !== 'false',
    /** Awesome lists — offset from GitHub times so posts don't collide */
    AWESOME_LISTS_ENABLED: process.env.AWESOME_LISTS_ENABLED !== 'false',
    AWESOME_LISTS_TIMES: (process.env.AWESOME_LISTS_TIMES || '10:15,12:45,15:15,17:45,20:30')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    AWESOME_LISTS_TIMEZONE: process.env.AWESOME_LISTS_TIMEZONE || 'Asia/Kolkata',
    AWESOME_LISTS_COUNT: parseInt(process.env.AWESOME_LISTS_COUNT, 10) || 5,
    /**
     * AI updates — opt-in per group via /aiupdateson. One item per slot,
     * rotating tools/apps, India-specific AI news, and model releases.
     * Times offset from GitHub (:00/:30) and Awesome (:15/:45) so a group with
     * all three enabled doesn't get three posts at once.
     */
    AI_UPDATES_ENABLED: process.env.AI_UPDATES_ENABLED !== 'false',
    AI_UPDATES_TIMES: (process.env.AI_UPDATES_TIMES || '09:20,11:50,14:20,16:50,19:20')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    AI_UPDATES_TIMEZONE: process.env.AI_UPDATES_TIMEZONE || 'Asia/Kolkata',
    /** Interview Q of the Day — MCQ polls 3×/day IST; answer after 30m; Sat leaderboard */
    INTERVIEW_Q_ENABLED: process.env.INTERVIEW_Q_ENABLED !== 'false',
    INTERVIEW_Q_TIMES: (process.env.INTERVIEW_Q_TIMES || '11:00,15:00,19:00')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    INTERVIEW_Q_TIMEZONE: process.env.INTERVIEW_Q_TIMEZONE || 'Asia/Kolkata',
    /** How long after a slot time we still catch up (default 90m). Past that, skip — no dump at 6pm. */
    INTERVIEW_Q_CATCHUP_GRACE_MS: (() => {
        const n = parseInt(process.env.INTERVIEW_Q_CATCHUP_GRACE_MS, 10);
        if (!Number.isFinite(n) || n <= 0) return 90 * 60 * 1000;
        return Math.min(6 * 60 * 60 * 1000, Math.max(15 * 60 * 1000, n));
    })(),
    INTERVIEW_Q_ANSWER_DELAY_MS: (() => {
        const n = parseInt(process.env.INTERVIEW_Q_ANSWER_DELAY_MS, 10);
        if (Number.isFinite(n) && n >= 60_000) return n;
        return 30 * 60 * 1000;
    })(),
    /** Saturday weekly recap (default 22:00 IST). Set empty to disable. */
    INTERVIEW_Q_SUMMARY_TIME: (process.env.INTERVIEW_Q_SUMMARY_TIME || '22:00').trim(),
    /** How many past questions to keep out of the rotation (fingerprint window). */
    INTERVIEW_Q_DEDUP_LOOKBACK: Math.max(
        50,
        parseInt(process.env.INTERVIEW_Q_DEDUP_LOOKBACK, 10) || 200
    ),
    /** /roast — AI resume roast (PDF/DOCX/TXT) on the multi-provider LLM router. */
    ROAST_ENABLED: process.env.ROAST_ENABLED !== 'false',
    /** Per-phone roasts per IST day (owner bypasses). */
    ROAST_DAILY_LIMIT: Math.max(1, parseInt(process.env.ROAST_DAILY_LIMIT, 10) || 2),
    /** /birthday — daily LLM birthday wish + tag, once per day after this IST time. */
    BIRTHDAY_ENABLED: process.env.BIRTHDAY_ENABLED !== 'false',
    BIRTHDAY_TIME: (process.env.BIRTHDAY_TIME || '09:07').trim(),
    /** Skip the Interview Q poll slots on Sundays (weekly recap still runs Sat night). Default true. */
    INTERVIEW_Q_SKIP_SUNDAY: process.env.INTERVIEW_Q_SKIP_SUNDAY !== 'false',
    /** Public base for movie /d/:code links — auto from Render/Koyeb; PUBLIC_URL optional. */
    PUBLIC_URL: resolvePublicBaseUrl(),

    RENDER_API_KEY: process.env.RENDER_API_KEY?.trim() || '',
    RENDER_SERVICE_ID: process.env.RENDER_SERVICE_ID?.trim() || '',
    KOYEB_API_KEY: process.env.KOYEB_API_KEY?.trim() || '',
    KOYEB_SERVICE_ID: process.env.KOYEB_SERVICE_ID?.trim() || '',

    /** Telegram Bot API token — required for /tgstickers command. */
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN?.trim() || '',

    /** Optional bootstrap for drive sources: JSON array of { url, renderServiceId?, renderApiKey? } */
    DRIVE_SOURCES: (() => {
        try {
            const raw = process.env.DRIVE_SOURCES_JSON?.trim();
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    })(),
};
