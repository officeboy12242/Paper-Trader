/**
 * The single definition of a tradable F&O index.
 *
 * This existed twice and the two copies disagreed. ExpiryTradeService had the
 * correct Yahoo tickers; IndianStockQuoteService only knew NIFTY and BANKNIFTY,
 * so everything else fell through to `${SYMBOL}.NS` — a ticker that does not
 * exist. The failure was not an error either: `/tradenow MIDCPNIFTY` resolved to
 * MIDCPNIFTY.NS and HUNG past 280 seconds while the provider chain retried.
 *
 * Two easy and completely silent mistakes are pinned here:
 *   - MIDCPNIFTY is Nifty Midcap SELECT (~15k), NOT Midcap 100 (~63k).
 *   - FINNIFTY is NIFTY_FIN_SERVICE.NS, not FINNIFTY.NS.
 * Every ticker below was verified against the option chain's own
 * `underlyingValue`, which is the only check that catches a wrong-index error.
 *
 * Lot sizes move at SEBI revisions. Expiry cadence also differs per index
 * (NIFTY weekly, others monthly since the Nov-2024 revision), so never assume a
 * shared expiry — read it from the option chain.
 */

/** @typedef {{ yahoo: string, lot: number, label: string, nse: string }} IndexSpec */

/** @type {Record<string, IndexSpec>} */
export const F_AND_O_INDICES = {
    NIFTY: { yahoo: '^NSEI', lot: 75, label: 'NIFTY 50', nse: 'NIFTY' },
    BANKNIFTY: { yahoo: '^NSEBANK', lot: 30, label: 'BANK NIFTY', nse: 'BANKNIFTY' },
    FINNIFTY: { yahoo: 'NIFTY_FIN_SERVICE.NS', lot: 65, label: 'FIN NIFTY', nse: 'FINNIFTY' },
    MIDCPNIFTY: { yahoo: 'NIFTY_MID_SELECT.NS', lot: 120, label: 'MIDCAP SELECT', nse: 'MIDCPNIFTY' },
    // BSE index. Its chain comes from BseOptionChainService (BSE's own API),
    // not the NSE chain, so `exchange` is what routes the lookup.
    SENSEX: { yahoo: '^BSESN', lot: 20, label: 'SENSEX', nse: 'SENSEX', exchange: 'BSE', bseScripCd: 1 },
};

/** Aliases people actually type. */
const ALIASES = {
    NIFTY50: 'NIFTY',
    NIFTY_50: 'NIFTY',
    NF: 'NIFTY',
    BNF: 'BANKNIFTY',
    BANK: 'BANKNIFTY',
    'BANK-NIFTY': 'BANKNIFTY',
    NIFTYBANK: 'BANKNIFTY',
    FIN: 'FINNIFTY',
    FINNIFTY50: 'FINNIFTY',
    MIDCAP: 'MIDCPNIFTY',
    MIDCPNIFTY50: 'MIDCPNIFTY',
    MIDCAPNIFTY: 'MIDCPNIFTY',
    BSESN: 'SENSEX',
    SENSEX50: 'SENSEX',
    SX: 'SENSEX',
};

export const INDEX_KEYS = Object.keys(F_AND_O_INDICES);

/**
 * Canonical index key for whatever the user typed, or null if it is not an index.
 * @param {*} raw
 * @returns {string|null}
 */
export function resolveIndexKey(raw) {
    const s = String(raw || '')
        .trim()
        .toUpperCase()
        .replace(/\.NS$|\.BO$/i, '')
        .replace(/\s+/g, '');
    if (!s) return null;
    if (F_AND_O_INDICES[s]) return s;
    const alias = ALIASES[s];
    return alias && F_AND_O_INDICES[alias] ? alias : null;
}

/** @returns {IndexSpec|null} */
export function getIndexSpec(raw) {
    const key = resolveIndexKey(raw);
    return key ? F_AND_O_INDICES[key] : null;
}

export function isIndexSymbol(raw) {
    return resolveIndexKey(raw) !== null;
}

/**
 * Indices NSE lists an option chain for but we do NOT support as a quote —
 * naming them explicitly lets callers fail fast instead of stalling on a
 * nonexistent Yahoo ticker.
 */
export const UNSUPPORTED_INDEX_HINTS = {
    NIFTYIT: 'NIFTY IT has no verified underlying feed here',
    NIFTYNXT50: 'NIFTY NEXT 50 has no verified underlying feed here',
    BANKEX: 'BANKEX is a BSE index — the NSE option chain does not cover it',
};

/** @returns {string|null} reason this index-looking symbol is unsupported */
export function unsupportedIndexReason(raw) {
    const s = String(raw || '').trim().toUpperCase().replace(/\.NS$|\.BO$/i, '').replace(/\s+/g, '');
    return UNSUPPORTED_INDEX_HINTS[s] || null;
}
