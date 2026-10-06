/**
 * Swing-trading universe — NIFTY 200 style large/mid-cap NSE constituents.
 *
 * Why a static list: NSE's `equity-stockIndices?index=...` endpoint now returns
 * 404, so constituents cannot be pulled live. This is a snapshot — refresh it
 * after NSE's semi-annual rebalance (March / September). Symbols that no longer
 * trade simply drop out of the scan when Yahoo returns no candles, so a stale
 * entry degrades coverage rather than breaking the scan.
 *
 * Universe choice matters: staying in liquid large/mid caps keeps slippage and
 * impact cost low, which is what makes a swing edge survive transaction costs.
 * Override entirely with SWING_UNIVERSE=SYM1,SYM2,...
 */

/**
 * Sector buckets. Momentum ranking concentrates hard — when one sector runs,
 * the top of the leaderboard fills with it. Capping picks per sector is what
 * turns 5 correlated positions back into 5 independent bets.
 */
export const NSE_SWING_SECTORS = {
    FINANCIALS: [
        'HDFCBANK', 'ICICIBANK', 'SBIN', 'KOTAKBANK', 'AXISBANK', 'INDUSINDBK',
        'BAJFINANCE', 'BAJAJFINSV', 'SBILIFE', 'HDFCLIFE', 'ICICIPRULI',
        'ICICIGI', 'SBICARD', 'CHOLAFIN', 'SHRIRAMFIN', 'MUTHOOTFIN',
        'LICHSGFIN', 'PFC', 'RECLTD', 'IRFC', 'BANKBARODA', 'PNB',
        'CANBK', 'UNIONBANK', 'INDIANB', 'IDFCFIRSTB', 'FEDERALBNK',
        'AUBANK', 'BANDHANBNK', 'HDFCAMC', 'ANGELONE', 'BSE', 'MCX',
        'CDSL', 'POLICYBZR', 'PAYTM', 'JIOFIN', 'LICI', 'GICRE',
        'MANAPPURAM', 'M&MFIN', 'BAJAJHLDNG',
    ],
    IT: [
        'TCS', 'INFY', 'HCLTECH', 'WIPRO', 'TECHM', 'MPHASIS',
        'PERSISTENT', 'COFORGE', 'LTTS', 'OFSS', 'TATAELXSI', 'KPITTECH',
        'CYIENT', 'BSOFT',
    ],
    ENERGY: [
        'RELIANCE', 'ONGC', 'IOC', 'BPCL', 'HINDPETRO', 'GAIL', 'PETRONET',
        'IGL', 'MGL', 'OIL', 'NTPC', 'POWERGRID', 'TATAPOWER',
        'ADANIPOWER', 'ADANIGREEN', 'ADANIENSOL', 'JSWENERGY', 'NHPC',
        'SJVN', 'TORNTPOWER', 'CESC', 'SUZLON', 'INOXWIND',
    ],
    AUTO: [
        'MARUTI', 'M&M', 'TMCV', 'TMPV', 'BAJAJ-AUTO', 'HEROMOTOCO',
        'EICHERMOT', 'TVSMOTOR', 'ASHOKLEY', 'BHARATFORG', 'MOTHERSON',
        'BOSCHLTD', 'BALKRISIND', 'MRF', 'APOLLOTYRE', 'CEATLTD',
        'EXIDEIND', 'SONACOMS', 'ENDURANCE', 'UNOMINDA',
    ],
    PHARMA: [
        'SUNPHARMA', 'DRREDDY', 'CIPLA', 'DIVISLAB', 'TORNTPHARM',
        'ZYDUSLIFE', 'LUPIN', 'AUROPHARMA', 'ALKEM', 'MANKIND',
        'GLENMARK', 'IPCALAB', 'ABBOTINDIA', 'BIOCON', 'LAURUSLABS',
        'GRANULES', 'AJANTPHARM', 'APOLLOHOSP', 'MAXHEALTH', 'FORTIS',
        'LALPATHLAB', 'METROPOLIS', 'SYNGENE',
    ],
    FMCG: [
        'HINDUNILVR', 'ITC', 'NESTLEIND', 'BRITANNIA', 'DABUR',
        'GODREJCP', 'MARICO', 'COLPAL', 'TATACONSUM', 'UBL', 'RADICO',
        'VBL', 'PGHH', 'EMAMILTD', 'JUBLFOOD', 'DEVYANI', 'BIKAJI',
        'HATSUN', 'PATANJALI',
    ],
    METALS: [
        'TATASTEEL', 'JSWSTEEL', 'HINDALCO', 'VEDL', 'JINDALSTEL',
        'SAIL', 'NMDC', 'COALINDIA', 'HINDZINC', 'NATIONALUM',
        'APLAPOLLO', 'JSL', 'WELCORP', 'ULTRACEMCO', 'SHREECEM',
        'AMBUJACEM', 'ACC', 'DALBHARAT', 'JKCEMENT', 'RAMCOCEM',
    ],
    CAPGOODS: [
        'LT', 'SIEMENS', 'ABB', 'CUMMINSIND', 'THERMAX', 'BEL', 'HAL',
        'BDL', 'MAZDOCK', 'COCHINSHIP', 'GRSE', 'BHEL', 'IRCTC',
        'IRCON', 'RVNL', 'NBCC', 'NCC', 'KEC', 'GMRAIRPORT',
        'CONCOR', 'ADANIPORTS', 'CARBORUNIV', 'AIAENG', 'POLYCAB',
        'HAVELLS', 'CROMPTON', 'VOLTAS', 'BLUESTARCO', 'DIXON', 'AMBER',
        'KAYNES', 'SYRMA', 'HONAUT', '3MINDIA', 'SUPREMEIND', 'ASTRAL',
        'FINCABLES',
    ],
    CHEMICALS: [
        'PIDILITIND', 'ASIANPAINT', 'BERGEPAINT', 'KANSAINER', 'SRF',
        'PIIND', 'UPL', 'AARTIIND', 'DEEPAKNTR', 'ATUL', 'NAVINFLUOR',
        'FLUOROCHEM', 'TATACHEM', 'COROMANDEL', 'CHAMBLFERT', 'GNFC',
        'LINDEINDIA', 'SOLARINDS', 'GRASIM',
    ],
    TELECOM_MEDIA: [
        'BHARTIARTL', 'IDEA', 'INDUSTOWER', 'TATACOMM', 'SUNTV',
        'PVRINOX', 'NAUKRI', 'ETERNAL', 'NYKAA', 'DELHIVERY', 'SWIGGY',
    ],
    CONSUMER_REALTY: [
        'DMART', 'TRENT', 'ABFRL', 'PAGEIND', 'BATAINDIA', 'RELAXO',
        'TITAN', 'KALYANKJIL', 'DLF', 'GODREJPROP', 'OBEROIRLTY',
        'PRESTIGE', 'PHOENIXLTD', 'BRIGADE', 'LODHA', 'INDHOTEL',
        'CHALET', 'INDIGO', 'ADANIENT',
    ],
};

/** symbol → sector lookup. */
export const SYMBOL_SECTOR = Object.freeze(
    Object.fromEntries(
        Object.entries(NSE_SWING_SECTORS).flatMap(([sector, syms]) =>
            syms.map((s) => [s, sector])
        )
    )
);

export function sectorOf(symbol) {
    return SYMBOL_SECTOR[String(symbol || '').toUpperCase()] || 'OTHER';
}

/** Flat universe, derived from the sector map so the two can never drift apart. */
export const NSE_SWING_UNIVERSE = Object.values(NSE_SWING_SECTORS).flat();

/** Deduped, uppercased universe. */
export function getSwingUniverse(override = '') {
    const raw = String(override || '').trim();
    const list = raw
        ? raw.split(/[,\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean)
        : NSE_SWING_UNIVERSE;
    return [...new Set(list.map((s) => s.toUpperCase()))];
}
