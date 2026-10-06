/**
 * The single definition of what a trade-alert discovery source is.
 *
 * This logic used to be copy-pasted into five files (the controller, the
 * discovery engine, the command handler, GroupManager and config). Adding a
 * source meant editing all five, and missing one produced a source that could
 * be set but never resolved — or resolved but never persisted.
 */

export const DISCOVERY_SOURCES = ['heatmap', 'heatmap2', 'preopen', 'turnover', 'nse', 'legacy'];

export const DEFAULT_DISCOVERY_SOURCE = 'heatmap';

/**
 * Aliases per source. `heatmap2` is checked before `heatmap` so the more
 * specific name wins — otherwise a prefix match would swallow it.
 */
const ALIASES = [
    ['heatmap2', ['heatmap2', 'heatmapv2', 'hm2', 'v2', 'breakout2', 'pro', 'new']],
    ['heatmap', ['heatmap', 'breakout', 'ema', 'or', 'v1']],
    ['preopen', ['preopen', 'pre-open', 'pre', 'auction', 'iep', '915', '9:15']],
    ['turnover', ['turnover', 'band', 'active', 'mostactive', 'most-active', 'value']],
    ['nse', ['nse', 'nse_gl', 'gl', 'gainers']],
    ['legacy', ['legacy', 'old', 'enhanced']],
];

/**
 * @param {*} v
 * @returns {'heatmap'|'heatmap2'|'nse'|'legacy'} always a valid source
 */
export function normalizeDiscoverySource(v) {
    const s = String(v || '').trim().toLowerCase();
    for (const [canonical, names] of ALIASES) {
        if (names.includes(s)) return canonical;
    }
    return 'legacy';
}

/**
 * Same matching, but returns null for input that names no source — for command
 * parsing, where "unrecognised" must not silently become `legacy`.
 * @returns {string|null}
 */
export function parseDiscoverySource(v) {
    const s = String(v || '').trim().toLowerCase();
    for (const [canonical, names] of ALIASES) {
        if (names.includes(s)) return canonical;
    }
    return null;
}

/** Human label for status messages. */
export function discoverySourceLabel(source) {
    switch (normalizeDiscoverySource(source)) {
        case 'heatmap2':
            return 'Heatmap v2 (live intraday · VWAP · RS · ATR)';
        case 'heatmap':
            return 'NSE Heatmap + 15m OR / 8 EMA';
        case 'preopen':
            return 'Pre-open auction (IEP · order imbalance) · 09:15 · UNVALIDATED';
        case 'turnover':
            return 'Turnover band (ranks 11-30 · EMA 8/21) · thin evidence';
        case 'nse':
            return 'NSE NIFTY50 top 5G+5L';
        default:
            return 'Legacy (sectors · movers · smart money)';
    }
}

/** True for sources whose symbol list is authoritative (no AI overlay). */
export function isPrescriptiveSource(source) {
    const s = normalizeDiscoverySource(source);
    return s === 'nse' || s === 'heatmap' || s === 'heatmap2' || s === 'preopen' || s === 'turnover';
}
