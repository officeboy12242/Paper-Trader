/**
 * NSE F&O market lot sizes (1 lot qty). Update when NSE revises.
 * Index + liquid stock map; unknown symbols fall back to DEFAULT_LOT.
 */

export const DEFAULT_LOT = 100;

/** @type {Record<string, number>} */
export const NSE_LOT_SIZES = {
    NIFTY: 75,
    NIFTY50: 75,
    BANKNIFTY: 30,
    FINNIFTY: 65,
    MIDCPNIFTY: 120,
    NIFTYNXT50: 50,
    RELIANCE: 500,
    TCS: 175,
    HDFCBANK: 550,
    INFY: 300,
    ICICIBANK: 700,
    HINDUNILVR: 300,
    ITC: 1600,
    SBIN: 750,
    BHARTIARTL: 475,
    KOTAKBANK: 400,
    LT: 175,
    AXISBANK: 625,
    ASIANPAINT: 200,
    MARUTI: 100,
    TITAN: 175,
    SUNPHARMA: 350,
    BAJFINANCE: 125,
    WIPRO: 400,
    HCLTECH: 350,
    ULTRACEMCO: 100,
    ONGC: 1925,
    NTPC: 1500,
    POWERGRID: 1900,
    TATAMOTORS: 625,
    TMPV: 625,
    TMCV: 800,
    'M&M': 350,
    M_M: 350,
    ADANIENT: 250,
    ADANIPORTS: 400,
    COALINDIA: 2100,
    TATASTEEL: 550,
    JSWSTEEL: 675,
    HINDALCO: 1400,
    INDUSINDBK: 500,
    BPCL: 1800,
    GRASIM: 250,
    DIVISLAB: 100,
    CIPLA: 650,
    DRREDDY: 625,
    EICHERMOT: 175,
    HEROMOTOCO: 150,
    BAJAJFINSV: 500,
    SBILIFE: 375,
    HDFCLIFE: 1100,
    TECHM: 600,
    APOLLOHOSP: 125,
    BRITANNIA: 125,
    NESTLEIND: 200,
    TRENT: 100,
    BEL: 2850,
    DLF: 825,
    VEDL: 1150,
    IRFC: 5425,
    RVNL: 1375,
    POLYCAB: 125,
    HAL: 150,
    PNB: 8000,
    BANKBARODA: 2925,
    JIOFIN: 2350,
};

/**
 * @param {string} rawSymbol
 * @returns {number}
 */
export function getNseLotSize(rawSymbol) {
    const sym = String(rawSymbol || '')
        .trim()
        .toUpperCase()
        .replace(/\.NS$/, '')
        .replace(/\s+/g, '');
    if (!sym) {
        return DEFAULT_LOT;
    }
    if (NSE_LOT_SIZES[sym] != null) {
        return NSE_LOT_SIZES[sym];
    }
    const alt = sym.replace(/&/g, '_');
    if (NSE_LOT_SIZES[alt] != null) {
        return NSE_LOT_SIZES[alt];
    }
    return DEFAULT_LOT;
}
