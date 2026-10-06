/**
 * ScalpAlertService — Auto-trigger scalp alerts
 *
 * Scans every 3 minutes during market hours (9:15–15:30 IST). When a setup hits
 * its confidence gate (SCALP_MIN_CONF, default 70) it alerts the groups that
 * asked for that index.
 *
 * Per-group index selection: a group stores `scalp_indices` (e.g. ['SENSEX'] or
 * ['NIFTY','SENSEX']). Each index's card is built ONCE per scan and then fanned
 * out to whichever groups want it, so adding SENSEX does not double the number
 * of option-chain fetches for groups that only follow NIFTY.
 *
 * Cooldown logic: tracks setup fingerprint (index + strike + entry price).
 * - Same setup (same index/strike/entry): 10 min cooldown
 * - Different setup (new strike or entry): alerts immediately
 * The index is part of the fingerprint because NIFTY and SENSEX can produce the
 * same strike-and-entry pair and they are not the same trade.
 */

import { logger } from '../utils/logger.js';
import ScalpService from './ScalpService.js';
import { resolveScalpIndex } from '../data/scalpIndexConfig.js';
import { isIndianEquityTradingDay } from '../utils/indianMarketCalendar.js';
import { scalpOutcomeTracker } from './ScalpOutcomeTracker.js';
import { nseMarketDataService } from './NseMarketDataService.js';
import { fetchBseOptionChain } from './BseOptionChainService.js';

const SCAN_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes
const COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes per unique setup
// Level heads-up watcher. The 3-minute scan is the setup delivery; this faster
// pass exists so a group hears "spot is touching the wall" within ~30s of the
// touch instead of up to 3 minutes later.
const LEVEL_WATCH_INTERVAL_MS = 30 * 1000;
const LEVEL_PING_COOLDOWN_MS = 10 * 60 * 1000; // per index+zone
const MARKET_OPEN_HOUR = 9;
const MARKET_OPEN_MIN = 15;
const MARKET_CLOSE_HOUR = 15;
const MARKET_CLOSE_MIN = 30;
/** CAS: cash freezes 15:15, closing price prints by ~15:35. */
const CAS_FREEZE_START_MIN = 15 * 60 + 15;
const CAS_FREEZE_END_MIN = 15 * 60 + 35;

class ScalpAlertService {
    constructor() {
        this.scalpSvc = new ScalpService();
        this._timer = null;
        this._watchTimer = null;
        this._lastAlerts = {}; // { fingerprint: { timestamp, strike, entry } }
        // Level watcher state: the OI-wall levels are refreshed by each 3-min
        // scan (they move slowly), and the fast pass only polls spot against
        // them. `_levelZone` is the zone seen on the last tick, so a ping fires
        // on a mid-range -> level transition, not on every tick spent hovering.
        this._levels = {}; // { NIFTY: { support, resistance, nearZone, ts } }
        this._levelZone = {}; // { NIFTY: 'mid' | 'support' | ... }
        this._levelPings = {}; // { 'NIFTY:support': timestamp }
        this._sock = null;
        this._getGroups = null;
        this._sendMessage = null;
        this._enabled = false;
    }

    /**
     * Start the scanner.
     */
    start({ sock, getGroups, sendMessage, mongoDb = null }) {
        if (this._timer) return;
        this._sock = sock;
        this._getGroups = getGroups;
        this._sendMessage = sendMessage;
        this._enabled = true;
        scalpOutcomeTracker.attach(mongoDb);

        logger.info('⚡ ScalpAlertService started — scanning every 3 min during market hours');

        this._timer = setInterval(() => {
            void this._scan();
        }, SCAN_INTERVAL_MS);

        // Run first scan after 10 seconds
        setTimeout(() => void this._scan(), 10_000);

        // Level heads-up pass — only meaningful once a scan has stored levels,
        // so the first watch ticks are no-ops until `_scanIndex` populates them.
        logger.info('🔔 ScalpAlertService level watch — spot polled every 30s against OI walls');
        this._watchTimer = setInterval(() => {
            void this._watchLevels();
        }, LEVEL_WATCH_INTERVAL_MS);
    }

    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
        if (this._watchTimer) {
            clearInterval(this._watchTimer);
            this._watchTimer = null;
        }
        this._enabled = false;
        logger.info('⚡ ScalpAlertService stopped');
    }

    /** Indices a group wants, normalised. Pre-SENSEX groups default to NIFTY. */
    static indicesFor(group) {
        const raw = Array.isArray(group?.scalp_indices) && group.scalp_indices.length
            ? group.scalp_indices
            : ['NIFTY'];
        return raw.map((k) => String(k).trim().toUpperCase()).filter(Boolean);
    }

    async _scan() {
        if (!this._enabled) return;
        if (!this._isMarketOpen()) return;

        let scalpGroups;
        try {
            const groups = this._getGroups ? await this._getGroups() : [];
            scalpGroups = groups.filter((g) => g.scalp_enabled);
        } catch (err) {
            logger.error('ScalpAlert group lookup failed:', err.message);
            return;
        }
        if (!scalpGroups.length) return;

        // Build each index's card once, however many groups follow it.
        const wanted = new Set();
        for (const g of scalpGroups) {
            for (const k of ScalpAlertService.indicesFor(g)) wanted.add(k);
        }

        for (const indexKey of wanted) {
            try {
                await this._scanIndex(indexKey, scalpGroups);
            } catch (err) {
                // One index failing must not stop the others.
                logger.error(`ScalpAlert ${indexKey} scan error:`, err.message);
            }
        }
    }

    async _scanIndex(indexKey, scalpGroups) {
        const cfg = resolveScalpIndex(indexKey);
        if (!cfg) {
            logger.warn(`ScalpAlert: unknown index ${indexKey}`);
            return;
        }

        const ctx = await this.scalpSvc.buildScalpCardWithContext(cfg.key);
        const card = ctx?.card;
        const snapshot = ctx?.snapshot;

        // Refresh the level watcher's walls from this live card — support /
        // resistance are the OI walls the primary setups trigger on, and
        // nearZone is the band within which they consider a level "hit". Must
        // happen before the early returns below (a NO CLEAR SETUP card still
        // has perfectly good walls to watch).
        if (Number.isFinite(ctx?.support) && Number.isFinite(ctx?.resistance)) {
            this._levels[cfg.key] = {
                support: ctx.support,
                resistance: ctx.resistance,
                nearZone: Number.isFinite(ctx?.nearZone) ? ctx.nearZone : (ctx.resistance - ctx.support) * 0.1,
                ts: Date.now(),
            };
        }

        // Grade anything already open BEFORE the early returns below. A quiet
        // scan with no new setup is exactly when an open scalp is most likely to
        // be hitting its target, and returning early would leave it ungraded
        // until the next setup happened to appear.
        if (snapshot) {
            try {
                await scalpOutcomeTracker.resolveAgainst(cfg.key, snapshot);
            } catch (err) {
                logger.warn(`Scalp outcome resolve failed for ${cfg.key}: ${err.message}`);
            }
        }

        if (!card) return;
        // "not live" is the BSE settlement-price refusal: SENSEX returns
        // settlement figures outside live hours and alerting on those would
        // quote untradeable premiums as entries.
        if (
            card.includes('NO CLEAR SETUP')
            || card.includes('Could not fetch')
            || card.includes('is not live')
        ) return;

        // Any setup that cleared its gate in ScalpService (PRIMARY or SECONDARY).
        // The tick is the card's own marker for "passed the gate", so the
        // threshold lives in one place and cannot drift between the two files.
        if (!card.includes('✅')) return;

        const setups = this._extractSetups(card, cfg.key);
        if (!setups.length) return;

        const now = Date.now();
        const freshSetups = setups.filter((s) => {
            const last = this._lastAlerts[s.fingerprint];
            if (!last) return true;
            return (now - last.timestamp) >= COOLDOWN_MS;
        });
        if (!freshSetups.length) return;

        const targets = scalpGroups.filter((g) =>
            ScalpAlertService.indicesFor(g).includes(cfg.key)
        );
        if (!targets.length) return;

        const alertMsg = this._buildAlertMsg(card, freshSetups, cfg);

        let sent = 0;
        for (const group of targets) {
            try {
                await this._sendMessage(group.group_id, { text: alertMsg });
                sent++;
                logger.info(`⚡ ${cfg.key} scalp alert sent to ${group.group_name || group.group_id}`);
            } catch (err) {
                logger.error(`Failed to send ${cfg.key} scalp alert to ${group.group_id}:`, err.message);
            }
        }

        // Only start the cooldown if the alert actually reached someone —
        // otherwise a transient send failure silences the setup for 10 minutes.
        if (!sent) return;
        for (const s of freshSetups) {
            this._lastAlerts[s.fingerprint] = { timestamp: now, strike: s.strike, entry: s.entry };
            // Journal what we just told people to trade, so it can be graded.
            try {
                await scalpOutcomeTracker.record(s, cfg, {
                    expiry: snapshot?.expiry ?? null,
                    spot: snapshot?.spot ?? null,
                    confidence: s.confidence ?? null,
                    groupId: targets[0]?.group_id ?? null,
                });
            } catch (err) {
                // Journalling must never cost an alert.
                logger.warn(`Scalp outcome record failed: ${err.message}`);
            }
        }
    }

    // ── Level heads-up watcher ────────────────────────────────────────────
    //
    // Polls spot every 30s against the OI-wall levels last stored by a scan.
    // A mid-range -> level transition fires a short heads-up so the group hears
    // the touch within ~30s; the full setup alert (with premium, SL, target)
    // still arrives from the 3-minute scan once the setup clears its gate.
    async _watchLevels() {
        if (!this._enabled) return;
        if (!this._isMarketOpen()) return;
        if (!Object.keys(this._levels).length) return;

        let scalpGroups;
        try {
            const groups = this._getGroups ? await this._getGroups() : [];
            scalpGroups = groups.filter((g) => g.scalp_enabled);
        } catch (err) {
            logger.error('ScalpAlert level watch: group lookup failed:', err.message);
            return;
        }
        if (!scalpGroups.length) return;

        // Only watch levels for indices some enabled group actually follows.
        const wanted = new Set();
        for (const g of scalpGroups) {
            for (const k of ScalpAlertService.indicesFor(g)) wanted.add(k);
        }

        for (const indexKey of wanted) {
            const levels = this._levels[indexKey];
            if (!levels) continue;
            try {
                const spot = await this._fetchIndexSpot(indexKey);
                if (!Number.isFinite(spot)) continue;
                await this._checkLevels(indexKey, spot, levels, scalpGroups);
            } catch (err) {
                logger.debug(`ScalpAlert level watch ${indexKey}: ${err.message}`);
            }
        }
    }

    /** Light spot poll — one cheap call per index, never the whole chain render. */
    async _fetchIndexSpot(indexKey) {
        const cfg = resolveScalpIndex(indexKey);
        if (!cfg) return null;
        if (cfg.exchange === 'BSE') {
            // BSE's chain service caches internally for 60s, so this is at most
            // one live chain call per minute and reuses its egress ladder +
            // rate limiting. Settlement prices (outside live hours) return null.
            const snap = await fetchBseOptionChain(cfg.key);
            return snap?.isLive === false ? null : Number(snap?.spot);
        }
        // NSE: allIndices is the single light feed the heatmap scanner already
        // polls for live index prints.
        const rows = await nseMarketDataService.fetchAllIndicesRows();
        const nifty = rows.find((r) => /NIFTY 50/i.test(r.name));
        return nifty ? Number(nifty.last) : null;
    }

    /** Which side of the ladder is spot on? Zones are disjoint for range > 2*nearZone. */
    _zoneFor(spot, { support, resistance, nearZone }) {
        if (spot > resistance) return 'breakout';
        if (spot >= resistance - nearZone) return 'resistance';
        if (spot < support) return 'breakdown';
        if (spot <= support + nearZone) return 'support';
        return 'mid';
    }

    async _checkLevels(indexKey, spot, levels, scalpGroups) {
        const zone = this._zoneFor(spot, levels);
        const prev = this._levelZone[indexKey] || 'mid';
        this._levelZone[indexKey] = zone;

        // Only a fresh entry from mid-range (or a fresh break past a level)
        // pings. Hovering inside a zone must not re-ping every 30s.
        if (zone === 'mid' || zone === prev) return;

        const cooldownKey = `${indexKey}:${zone}`;
        const lastPing = this._levelPings[cooldownKey];
        const now = Date.now();
        if (lastPing && now - lastPing < LEVEL_PING_COOLDOWN_MS) return;

        const targets = scalpGroups.filter((g) =>
            ScalpAlertService.indicesFor(g).includes(indexKey)
        );
        if (!targets.length) return;

        const msg = this._levelMsg(indexKey, spot, zone, levels);
        if (!msg) return;
        let sent = 0;
        for (const group of targets) {
            try {
                await this._sendMessage(group.group_id, { text: msg });
                sent++;
                logger.info(`🔔 ${indexKey} level heads-up (${zone}) sent to ${group.group_name || group.group_id}`);
            } catch (err) {
                logger.error(`Failed to send ${indexKey} level heads-up to ${group.group_id}:`, err.message);
            }
        }
        // Cooldown only counts when the ping actually reached someone.
        if (sent) this._levelPings[cooldownKey] = now;
    }

    _levelMsg(indexKey, spot, zone, levels) {
        const now = new Date();
        const timeStr = new Intl.DateTimeFormat('en-IN', {
            timeZone: 'Asia/Kolkata',
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
        }).format(now);
        const fmt = (n) => Number(n).toLocaleString('en-IN');
        const cfg = resolveScalpIndex(indexKey);
        const label = cfg?.label || indexKey;
        const spotLine = `${label} spot ${fmt(Math.round(spot))}`;
        const watch = 'Full setup alert follows when it clears — /scalp to see now.';
        switch (zone) {
            case 'support':
                return [
                    `🟢 *${label} TOUCHING SUPPORT* — ${timeStr} IST`,
                    '',
                    `${spotLine} · support ${fmt(levels.support)} (PE wall)`,
                    'BUY CE zone — the bounce setup may fire.',
                    watch,
                ].join('\n');
            case 'resistance':
                return [
                    `🔴 *${label} TOUCHING RESISTANCE* — ${timeStr} IST`,
                    '',
                    `${spotLine} · resistance ${fmt(levels.resistance)} (CE wall)`,
                    'BUY PE zone — the fade setup may fire.',
                    watch,
                ].join('\n');
            case 'breakdown':
                return [
                    `🩹 *${label} BROKE BELOW SUPPORT ${fmt(levels.support)}* — ${timeStr} IST`,
                    '',
                    `${spotLine} — BREAKDOWN PE zone.`,
                    watch,
                ].join('\n');
            case 'breakout':
                return [
                    `🚀 *${label} BROKE ABOVE RESISTANCE ${fmt(levels.resistance)}* — ${timeStr} IST`,
                    '',
                    `${spotLine} — BREAKOUT CE zone.`,
                    watch,
                ].join('\n');
            default:
                return '';
        }
    }

    _isMarketOpen() {
        const now = new Date();

        // Weekday alone is not a trading day. The shared NSE calendar is what
        // TradeAlertController already gates on; this only checked Sat/Sun, so
        // it scanned and could alert straight through every market holiday.
        if (!isIndianEquityTradingDay(now.getTime())) return false;

        const parts = new Intl.DateTimeFormat('en-IN', {
            timeZone: 'Asia/Kolkata',
            hour: 'numeric',
            minute: '2-digit',
            hour12: false,
            hourCycle: 'h23',
        }).formatToParts(now);

        let hour = Number(parts.find((p) => p.type === 'hour')?.value || 0);
        if (hour === 24) hour = 0;
        const minute = Number(parts.find((p) => p.type === 'minute')?.value || 0);

        const timeMinutes = hour * 60 + minute;
        const openMinutes = MARKET_OPEN_HOUR * 60 + MARKET_OPEN_MIN;
        const closeMinutes = MARKET_CLOSE_HOUR * 60 + MARKET_CLOSE_MIN;

        if (timeMinutes < openMinutes || timeMinutes > closeMinutes) return false;

        // ── Closing Auction Session guard (live since 3 Aug 2026) ────────────
        // F&O stocks stop continuous trading at 15:15 and the index freezes
        // while the auction runs: measured over 24 post-CAS sessions, the 15:15
        // bar was flat in 92% of them and the 15:20 bar in 100% (avg range 0.00).
        // Every setup built in that window prices off a dead spot while options
        // keep trading to 15:40 — and the auction print then moves the index a
        // mean of 48 pts (vs 5.2 pts pre-CAS), so an 8-pt stop cannot be honoured.
        if (timeMinutes >= CAS_FREEZE_START_MIN && timeMinutes <= CAS_FREEZE_END_MIN) return false;

        return true;
    }

    /**
     * Extract setup details from card text.
     * Fingerprint = type:strike:entry — if any changes, it's a "new" setup.
     */
    _extractSetups(card, indexKey = 'NIFTY') {
        const setups = [];

        // Extract directional setups (BUY CE / BUY PE)
        if (card.includes('BUY CE')) {
            const strikeMatch = card.match(/Buy CE ([\d,]+)/);
            const entryMatch = card.match(/Entry: ₹([\d.]+)/);
            const strike = strikeMatch ? strikeMatch[1] : '?';
            const entry = entryMatch ? entryMatch[1] : '0';
            setups.push({
                type: 'BUY CE',
                emoji: '🟢',
                strike,
                entry,
                fingerprint: `${indexKey}:BUY CE:${strike}:${entry}`,
            });
        }

        if (card.includes('BUY PE')) {
            const strikeMatch = card.match(/Buy PE ([\d,]+)/);
            const entryMatch = card.match(/Entry: ₹([\d.]+)/);
            const strike = strikeMatch ? strikeMatch[1] : '?';
            const entry = entryMatch ? entryMatch[1] : '0';
            setups.push({
                type: 'BUY PE',
                emoji: '🔴',
                strike,
                entry,
                fingerprint: `${indexKey}:BUY PE:${strike}:${entry}`,
            });
        }

        // Extract breakout setups (BREAKOUT CE / BREAKDOWN PE) — the momentum
        // setup that fires when spot breaks past an OI wall. The card renders it
        // as a secondary setup with the broken level in the trigger line.
        if (card.includes('BREAKOUT CE')) {
            // Anchored after the type line: the card prints primary setups
            // before secondary ones, so an unanchored /Entry:/ match could
            // grab a BUY CE entry printed earlier in the card.
            const levelMatch = card.match(/Spot broke above resistance ([\d,]+)/);
            const entryMatch = card.match(/BREAKOUT CE[\s\S]*?Entry: ₹([\d.]+)/);
            const level = levelMatch ? levelMatch[1] : '?';
            const entry = entryMatch ? entryMatch[1] : '0';
            setups.push({
                type: 'BREAKOUT CE',
                emoji: '🚀',
                strike: level,
                entry,
                fingerprint: `${indexKey}:BREAKOUT CE:${level}:${entry}`,
            });
        }

        if (card.includes('BREAKDOWN PE')) {
            const levelMatch = card.match(/Spot broke below support ([\d,]+)/);
            const entryMatch = card.match(/BREAKDOWN PE[\s\S]*?Entry: ₹([\d.]+)/);
            const level = levelMatch ? levelMatch[1] : '?';
            const entry = entryMatch ? entryMatch[1] : '0';
            setups.push({
                type: 'BREAKDOWN PE',
                emoji: '🩹',
                strike: level,
                entry,
                fingerprint: `${indexKey}:BREAKDOWN PE:${level}:${entry}`,
            });
        }

        // Extract theta setups (SHORT STRADDLE / SHORT STRANGLE)
        if (card.includes('SHORT STRADDLE')) {
            const entryMatch = card.match(/SELL[\s\S]*?Premium: ₹([\d.]+)/);
            const entry = entryMatch ? entryMatch[1] : '?';
            setups.push({
                type: 'SHORT STRADDLE',
                emoji: '⚡',
                strike: 'ATM',
                entry,
                fingerprint: `${indexKey}:SHORT STRADDLE:${entry}`,
            });
        }

        if (card.includes('SHORT STRANGLE')) {
            const entryMatch = card.match(/SHORT STRANGLE[\s\S]*?Premium: ₹([\d.]+)/);
            const entry = entryMatch ? entryMatch[1] : '?';
            setups.push({
                type: 'SHORT STRANGLE',
                emoji: '🪁',
                strike: 'OTM wings',
                entry,
                fingerprint: `${indexKey}:SHORT STRANGLE:${entry}`,
            });
        }

        return setups;
    }

    _buildAlertMsg(card, setups, cfg = null) {
        const setupLabels = setups.map((s) => `${s.emoji} ${s.type} ${s.strike} @ ₹${s.entry}`).join(' & ');
        const now = new Date();
        const timeStr = new Intl.DateTimeFormat('en-IN', {
            timeZone: 'Asia/Kolkata',
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
        }).format(now);

        const isDirectional = setups.some((s) => s.type.startsWith('BUY')
            || s.type.startsWith('BREAKOUT') || s.type.startsWith('BREAKDOWN'));
        const isTheta = setups.some((s) => s.type.startsWith('SHORT'));
        let trigger = '';
        if (isDirectional) trigger = 'Directional setup triggered!';
        if (isTheta) trigger = 'Theta decay setup triggered!';
        if (isDirectional && isTheta) trigger = 'Multiple setups triggered!';

        return [
            `⚡ *SCALP ALERT${cfg ? ' · ' + cfg.label : ''}* — ${timeStr} IST`,
            '',
            `${setupLabels}`,
            trigger,
            '',
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
            '',
            card,
        ].join('\n');
    }
}

export default new ScalpAlertService();
