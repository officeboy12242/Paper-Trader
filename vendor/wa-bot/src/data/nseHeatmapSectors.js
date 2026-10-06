/**
 * NSE sector index → tradeable constituents, for the v2 heatmap scan.
 *
 * v1 used `nseSectorStocks.js`, which held 54 names across 14 sectors — Realty
 * had exactly one. With a pool that small the "pick the movers in the hottest
 * sectors" idea has almost nothing to pick from, so the scan fell through to a
 * hardcoded backup list on most days.
 *
 * Names here are drawn from the same 248-symbol liquid universe the swing
 * scanner uses, so both strategies trade the same quality of book. The lists
 * are deliberately per-index rather than per-broad-bucket: "PSU Bank is hot"
 * must not surface HDFCBANK.
 *
 * Index keys match the `index` field of NSE's `allIndices` response exactly —
 * that endpoint works reliably, unlike `equity-stockIndices`, which returns an
 * empty body and is why constituents have to be static at all.
 */

import { NSE_SWING_UNIVERSE } from './nseSwingUniverse.js';

export const HEATMAP_SECTORS = [
    {
        key: 'NIFTY IT',
        label: 'IT',
        symbols: [
            'TCS', 'INFY', 'HCLTECH', 'WIPRO', 'TECHM', 'MPHASIS',
            'PERSISTENT', 'COFORGE', 'LTTS', 'OFSS', 'TATAELXSI', 'KPITTECH',
            'CYIENT', 'BSOFT',
        ],
    },
    {
        key: 'NIFTY BANK',
        label: 'Bank',
        symbols: [
            'HDFCBANK', 'ICICIBANK', 'SBIN', 'KOTAKBANK', 'AXISBANK',
            'INDUSINDBK', 'BANKBARODA', 'PNB', 'CANBK', 'UNIONBANK',
            'INDIANB', 'IDFCFIRSTB', 'FEDERALBNK', 'AUBANK', 'BANDHANBNK',
        ],
    },
    {
        key: 'NIFTY PSU BANK',
        label: 'PSU Bank',
        symbols: ['SBIN', 'PNB', 'BANKBARODA', 'CANBK', 'UNIONBANK', 'INDIANB'],
    },
    {
        key: 'NIFTY FINANCIAL SERVICES',
        label: 'Fin Services',
        symbols: [
            'BAJFINANCE', 'BAJAJFINSV', 'SBILIFE', 'HDFCLIFE', 'ICICIPRULI',
            'ICICIGI', 'SBICARD', 'CHOLAFIN', 'SHRIRAMFIN', 'MUTHOOTFIN',
            'LICHSGFIN', 'HDFCAMC', 'ANGELONE', 'BSE', 'MCX', 'CDSL',
            'POLICYBZR', 'PAYTM', 'JIOFIN', 'LICI', 'MANAPPURAM', 'M&MFIN',
        ],
    },
    {
        key: 'NIFTY AUTO',
        label: 'Auto',
        symbols: [
            'MARUTI', 'M&M', 'TMCV', 'TMPV', 'BAJAJ-AUTO', 'HEROMOTOCO',
            'EICHERMOT', 'TVSMOTOR', 'ASHOKLEY', 'BHARATFORG', 'MOTHERSON',
            'BOSCHLTD', 'BALKRISIND', 'MRF', 'APOLLOTYRE', 'EXIDEIND',
            'SONACOMS', 'UNOMINDA',
        ],
    },
    {
        key: 'NIFTY PHARMA',
        label: 'Pharma',
        symbols: [
            'SUNPHARMA', 'DRREDDY', 'CIPLA', 'DIVISLAB', 'TORNTPHARM',
            'ZYDUSLIFE', 'LUPIN', 'AUROPHARMA', 'ALKEM', 'MANKIND',
            'GLENMARK', 'IPCALAB', 'ABBOTINDIA', 'BIOCON', 'LAURUSLABS',
            'GRANULES', 'AJANTPHARM', 'SYNGENE',
        ],
    },
    {
        key: 'NIFTY METAL',
        label: 'Metal',
        symbols: [
            'TATASTEEL', 'JSWSTEEL', 'HINDALCO', 'VEDL', 'JINDALSTEL',
            'SAIL', 'NMDC', 'COALINDIA', 'HINDZINC', 'NATIONALUM',
            'APLAPOLLO', 'JSL', 'WELCORP',
        ],
    },
    {
        key: 'NIFTY ENERGY',
        label: 'Energy',
        symbols: [
            'RELIANCE', 'ONGC', 'NTPC', 'POWERGRID', 'TATAPOWER',
            'ADANIPOWER', 'ADANIGREEN', 'ADANIENSOL', 'JSWENERGY', 'NHPC',
            'SJVN', 'TORNTPOWER', 'CESC', 'SUZLON', 'INOXWIND',
        ],
    },
    {
        key: 'NIFTY OIL & GAS',
        label: 'Oil & Gas',
        symbols: [
            'RELIANCE', 'ONGC', 'IOC', 'BPCL', 'HINDPETRO', 'GAIL',
            'PETRONET', 'IGL', 'MGL', 'OIL',
        ],
    },
    {
        key: 'NIFTY FMCG',
        label: 'FMCG',
        symbols: [
            'HINDUNILVR', 'ITC', 'NESTLEIND', 'BRITANNIA', 'DABUR',
            'GODREJCP', 'MARICO', 'COLPAL', 'TATACONSUM', 'UBL', 'RADICO',
            'VBL', 'PGHH', 'EMAMILTD', 'JUBLFOOD', 'PATANJALI',
        ],
    },
    {
        key: 'NIFTY REALTY',
        label: 'Realty',
        symbols: [
            'DLF', 'GODREJPROP', 'OBEROIRLTY', 'PRESTIGE', 'PHOENIXLTD',
            'BRIGADE', 'LODHA',
        ],
    },
    {
        key: 'NIFTY INDIA DEFENCE',
        label: 'Defence',
        symbols: ['BEL', 'HAL', 'BDL', 'MAZDOCK', 'COCHINSHIP', 'GRSE', 'BHEL'],
    },
    {
        key: 'NIFTY CONSUMER DURABLES',
        label: 'Cons Durables',
        symbols: [
            'HAVELLS', 'CROMPTON', 'VOLTAS', 'BLUESTARCO', 'DIXON', 'AMBER',
            'TITAN', 'KALYANKJIL', 'POLYCAB', 'BATAINDIA', 'RELAXO',
        ],
    },
    {
        key: 'NIFTY CHEMICALS',
        label: 'Chemicals',
        symbols: [
            'PIDILITIND', 'SRF', 'PIIND', 'UPL', 'AARTIIND', 'DEEPAKNTR',
            'ATUL', 'NAVINFLUOR', 'FLUOROCHEM', 'TATACHEM', 'COROMANDEL',
            'CHAMBLFERT', 'GNFC', 'LINDEINDIA', 'SOLARINDS',
        ],
    },
    {
        key: 'NIFTY INFRASTRUCTURE',
        label: 'Infra',
        symbols: [
            'LT', 'SIEMENS', 'ABB', 'CUMMINSIND', 'THERMAX', 'IRCTC',
            'IRCON', 'RVNL', 'NBCC', 'NCC', 'KEC', 'GMRAIRPORT', 'CONCOR',
            'ADANIPORTS',
        ],
    },
    {
        key: 'NIFTY MEDIA',
        label: 'Media/Telecom',
        symbols: [
            'BHARTIARTL', 'IDEA', 'INDUSTOWER', 'TATACOMM', 'SUNTV',
            'PVRINOX', 'NAUKRI', 'ETERNAL', 'NYKAA', 'DELHIVERY',
        ],
    },
    {
        key: 'NIFTY CEMENT',
        label: 'Cement',
        symbols: [
            'ULTRACEMCO', 'SHREECEM', 'AMBUJACEM', 'ACC', 'DALBHARAT',
            'JKCEMENT', 'RAMCOCEM', 'GRASIM',
        ],
    },
    {
        key: 'NIFTY HEALTHCARE INDEX',
        label: 'Healthcare',
        symbols: [
            'APOLLOHOSP', 'MAXHEALTH', 'FORTIS', 'LALPATHLAB', 'METROPOLIS',
            'SYNGENE', 'SUNPHARMA', 'CIPLA', 'DRREDDY', 'DIVISLAB',
        ],
    },
    {
        key: 'NIFTY INDIA CONSUMPTION',
        label: 'Consumption',
        symbols: [
            'DMART', 'TRENT', 'ABFRL', 'PAGEIND', 'INDHOTEL', 'CHALET',
            'INDIGO', 'DEVYANI', 'BIKAJI', 'HATSUN', 'SWIGGY',
            'TITAN', 'ASIANPAINT', 'BERGEPAINT', 'KANSAINER',
        ],
    },
];

/**
 * Guard against typos: every symbol must exist in the swing universe, which is
 * the list that has actually been price-checked against Yahoo. A name that
 * drifts out of the universe would otherwise fail silently at fetch time.
 */
export const UNKNOWN_HEATMAP_SYMBOLS = (() => {
    const known = new Set(NSE_SWING_UNIVERSE);
    const bad = new Set();
    for (const sec of HEATMAP_SECTORS) {
        for (const s of sec.symbols) if (!known.has(s)) bad.add(`${sec.label}:${s}`);
    }
    return [...bad];
})();

/** Every symbol reachable through the sector map, deduped. */
export const HEATMAP_UNIVERSE = [...new Set(HEATMAP_SECTORS.flatMap((s) => s.symbols))];

/** Sector definition for an NSE index name, or null. */
export function heatmapSectorByKey(key) {
    const want = String(key || '').trim().toUpperCase();
    return HEATMAP_SECTORS.find((s) => s.key === want) || null;
}
