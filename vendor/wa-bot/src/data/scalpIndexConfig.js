/**
 * Per-index parameters for /scalp.
 *
 * /scalp was written for NIFTY and every threshold in it was a NIFTY number
 * written as a bare literal. SENSEX trades near 76,000 against NIFTY's ~24,000
 * and its lot is 20 against NIFTY's 75, so almost none of those literals carry
 * across. Two of them break the trade outright:
 *
 *  1. FEES. The card quotes "~3.4 pts" of round-trip cost. That is 3.4 points on
 *     a 75 lot, i.e. roughly Rs.255. Spread over a SENSEX lot of 20 the SAME
 *     rupee cost is ~12.75 POINTS. Reusing NIFTY's 8-point target on SENSEX
 *     would mean fees alone exceed the target — a guaranteed loss before the
 *     market moves at all. Targets here are therefore scaled by lot ratio so the
 *     rupee economics match rather than the point numbers.
 *
 *  2. LEVEL DISTANCES. "within 100 points of the wall" is ~0.41% of NIFTY but
 *     only ~0.13% of SENSEX. Left unscaled, every range/proximity filter silently
 *     tightens by ~3x on SENSEX and setups simply stop appearing.
 *
 * Point values below are derived, not guessed: NIFTY's net win/loss in RUPEES is
 * held constant and converted back to points at each index's own lot size.
 *   NIFTY  net win 4.6 x 75 = Rs.345   net loss 8.4 x 75 = Rs.630
 *   SENSEX Rs.345 / 20 = 17.25 net -> 30 gross target
 *          Rs.630 / 20 = 31.5  net -> 19 gross stop
 * Both land at a ~1.6:1 reward:risk, which is the ratio NIFTY already ran.
 *
 * The 3.4 figure is inherited from the existing card; scaling by lot preserves
 * whatever it meant in rupees rather than re-deriving it.
 */

import { F_AND_O_INDICES } from './indexUniverse.js';

/**
 * @typedef {object} ScalpIndexConfig
 * @property {string} key            canonical index key
 * @property {string} label          display name
 * @property {'NSE'|'BSE'} exchange  which chain service serves it
 * @property {number} lot            contract lot size
 * @property {number} strikeStep     spacing between listed strikes
 * @property {number} targetPts      premium target, points
 * @property {number} stopPts        premium stop, points
 * @property {number} feePts         round-trip cost, points at this lot size
 * @property {number} nearWindow     strike universe half-width around spot
 * @property {number} zoneSpan       distance at which the wall-proximity score saturates
 * @property {number} minRange       below this the range is degenerate
 * @property {number} tightRange     low-vol / theta threshold
 * @property {number} wideRange      trending threshold
 * @property {number} vpTick         volume-profile bin size
 * @property {number} premiumMin     cheapest premium worth scalping
 * @property {number} premiumMax     dearest premium worth scalping
 * @property {number} premiumSweet   premium this index scalps best at
 * @property {number} reachMove      index move that comfortably delivers the target
 * @property {number} maxMove        beyond this the target is not scalp-reachable
 * @property {string} yahoo          index ticker for intraday bars
 * @property {string} volumeProxy    ETF whose volume stands in for the index
 */

/** NIFTY is the reference; every other index scales off it. */
const NIFTY_NET_WIN_RS = 4.6 * 75;
const NIFTY_NET_LOSS_RS = 8.4 * 75;
const NIFTY_FEE_RS = 3.4 * 75;

/** @type {Record<string, ScalpIndexConfig>} */
export const SCALP_INDICES = {
    NIFTY: {
        key: 'NIFTY',
        label: 'NIFTY 50',
        exchange: 'NSE',
        lot: 75,
        strikeStep: 50,
        targetPts: 8,
        stopPts: 5,
        feePts: 3.4,
        // Short-premium legs book in rupees too, so they scale by lot as well.
        straddleTargetPts: 8,
        straddleStopPts: 6,
        strangleFloorPts: 5,
        nearWindow: 600,
        // Distance over which "how far from the wall" saturates. 200 was a bare
        // literal and is ~0.8% of NIFTY; the SENSEX equivalent has to scale or
        // distScore pins at its ceiling on every setup.
        zoneSpan: 200,
        minRange: 50,
        tightRange: 100,
        wideRange: 250,
        vpTick: 5,
        // Strike-selection premium band, and the premium this index scalps best at.
        // Widened: the old 90 ceiling excluded the ATM strike outright (ATM read
        // Rs.128.90 at 4.6 days), forcing every pick into delta 0.21-0.33 where an
        // 8-point target needs a 24-39 point index move.
        premiumMin: 25,
        premiumMax: 200,
        premiumSweet: 110,
        // Index move an 8-point target may demand. reachMove is comfortably
        // inside a 2-5 min hold (5m NIFTY bars ranged ~15-25 pts); beyond
        // maxMove it is not a scalp any more.
        // ~1.3x the median 5m bar (measured 15.5 pts), so a one-bar move reads as
        // reachable rather than "stretched". Set equal to the median, the warning
        // fired on nearly every alert and stopped carrying information.
        reachMove: 20,
        maxMove: 40,
        yahoo: '^NSEI',
        // 371 of 376 bars carried volume when measured — the best proxy available.
        volumeProxy: 'NIFTYBEES.NS',
    },
    SENSEX: {
        key: 'SENSEX',
        label: 'SENSEX',
        exchange: 'BSE',
        lot: 20,
        strikeStep: 100,
        // Derived from NIFTY's rupee economics at a lot of 20 — see file header.
        targetPts: 30,
        stopPts: 19,
        // 8 and 6 on a lot of 20 collect Rs.160 / Rs.120 against ~Rs.256 of
        // round-trip cost -- the straddle would lose money on every win. Scaled
        // by the same 75/20 lot ratio as the directional targets.
        straddleTargetPts: 30,
        straddleStopPts: 23,
        strangleFloorPts: 19,
        feePts: Math.round((NIFTY_FEE_RS / 20) * 10) / 10, // 12.75 -> 12.8
        // SENSEX ~= 3.15x NIFTY, so distance thresholds scale by ~3.
        nearWindow: 1800,
        // SENSEX wall distances run 400-2000 pts; at 200 this saturated always.
        zoneSpan: 630,
        minRange: 150,
        tightRange: 300,
        wideRange: 750,
        vpTick: 20,
        // Taken from the sibling tgbot2 project, which runs SENSEX live at
        // prem_min 100 / prem_max 400 (step 100, lot 20). Scaling NIFTY's 30-90
        // band by index level alone gave 95-285, and that cap is too tight:
        // measured on the 10-Sep chain, ATM sat at CE 650 / PE 322, so a 285
        // ceiling would reject the whole usable ladder and SENSEX would produce
        // no setups at all — the same silent-empty-filter failure as the
        // strangle wings.
        premiumMin: 100,
        premiumMax: 700,
        premiumSweet: 350,
        // ~3.15x NIFTY, matching the index-level ratio.
        reachMove: 63,
        maxMove: 126,
        yahoo: '^BSESN',
        // ^BSESN reports zero volume like every index. HDFCSENSEX had the widest
        // coverage of the SENSEX ETFs probed (283 bars vs SENSEXETF's 237);
        // SETFSENSEX/SENSEXBEES/ICICISENSX all 404 on Yahoo.
        volumeProxy: 'HDFCSENSEX.NS',
    },
};

export const SCALP_INDEX_KEYS = Object.keys(SCALP_INDICES);

/** Net points after cost, for the card's own rules block. */
export function netPoints(cfg) {
    return {
        win: Math.round((cfg.targetPts - cfg.feePts) * 10) / 10,
        loss: Math.round((cfg.stopPts + cfg.feePts) * 10) / 10,
    };
}

/**
 * Canonical scalp config for whatever the user typed, or null.
 * Accepts the same aliases as the rest of the bot (nf, sx, bsesn, ...).
 */
export function resolveScalpIndex(raw) {
    const s = String(raw || '').trim().toUpperCase();
    if (!s) return null;
    if (SCALP_INDICES[s]) return SCALP_INDICES[s];

    // Reuse the shared alias table so /scalp accepts what /tradenow accepts.
    for (const [key, spec] of Object.entries(F_AND_O_INDICES)) {
        if (!SCALP_INDICES[key]) continue;
        if (s === key || s === spec.nse?.toUpperCase() || s === spec.label?.toUpperCase()) {
            return SCALP_INDICES[key];
        }
    }
    const ALIASES = { NF: 'NIFTY', NIFTY50: 'NIFTY', 'NIFTY 50': 'NIFTY', SX: 'SENSEX', BSESN: 'SENSEX' };
    const mapped = ALIASES[s];
    return mapped ? SCALP_INDICES[mapped] : null;
}

/**
 * Parse an index list from command arguments.
 * "nifty sensex", "nifty,sensex", "both", "all" -> ['NIFTY','SENSEX'].
 * Returns { keys, unknown } so the caller can tell the user what it ignored
 * rather than silently enabling something they did not ask for.
 */
export function parseScalpIndexArgs(args) {
    const tokens = String(args || '')
        .split(/[\s,]+/)
        .map((t) => t.trim())
        .filter(Boolean);

    const keys = [];
    const unknown = [];
    for (const t of tokens) {
        const up = t.toUpperCase();
        // "alert" is noise from `/scalp alert nifty` — the user's own phrasing.
        if (up === 'ALERT' || up === 'ALERTS' || up === 'ON') continue;
        if (up === 'BOTH' || up === 'ALL') {
            for (const k of SCALP_INDEX_KEYS) if (!keys.includes(k)) keys.push(k);
            continue;
        }
        const cfg = resolveScalpIndex(t);
        if (!cfg) unknown.push(t);
        else if (!keys.includes(cfg.key)) keys.push(cfg.key);
    }
    return { keys, unknown };
}
