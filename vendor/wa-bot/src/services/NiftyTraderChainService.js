/**
 * Fallback option chain via niftytrader's public web API.
 *
 * Why this exists: NSE blocks and bot-challenges foreign datacenter IPs, and
 * this bot runs on Render (singapore). When every NSE egress is refused the
 * choice is between no chain at all and a second source. This is that source —
 * no API key, no broker account, and it is not behind NSE's WAF, so an IP that
 * NSE refuses can still read it.
 *
 * Measured against NSE on the same minute (NIFTY, 01-Sep expiry):
 *   spot   24285.95 vs 24284.10   (1.85 pts)
 *   ATM CE   ₹151.50 vs  ₹148.65  (₹2.85)
 *   ATM PE    ₹74.60 vs   ₹77.45  (₹2.85)
 *
 * That premium gap is small in absolute terms but it is over half of a ₹5
 * scalp target, so every snapshot from here is tagged `source: 'niftytrader'`
 * and callers are expected to say so. It is a fallback, not an equal.
 *
 * Two of their fields are deliberately ignored:
 *   - `pcr` on each row is not the chain PCR (observed 0 and 25.45 where NSE
 *     said 0.69); PCR is recomputed from total OI here.
 *   - the greeks and `*_iv` are frequently 0, so IV falls back to `*_iv_eod`.
 */

import axios from 'axios';
import { logger } from '../utils/logger.js';

const API = 'https://webapi.niftytrader.in/webapi/option/option-chain-data';
const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
const TIMEOUT_MS = 20_000;
/** Wide enough to cover the OI walls a scalp/analysis card looks for. */
const STRIKES_EACH_SIDE = 40;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Match NSE's "01-Sep-2026" so downstream formatting is identical. */
function toNseExpiry(iso) {
    const d = new Date(String(iso || '').slice(0, 10));
    if (Number.isNaN(d.getTime())) return '';
    return `${String(d.getUTCDate()).padStart(2, '0')}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/** Positive value or null — their sparse rows report 0 for "no data". */
function pos(v) {
    const n = num(v);
    return n && n > 0 ? n : null;
}

function topStrikes(rows, side, n = 5) {
    return rows
        .map((r) => ({
            strike: num(r.strike_price),
            oi: num(side === 'ce' ? r.calls_oi : r.puts_oi) || 0,
            changeOi: num(side === 'ce' ? r.calls_change_oi : r.puts_change_oi) ?? 0,
            pChangeOi: num(side === 'ce' ? r.calls_change_oi_per : r.puts_change_oi_per),
            iv: pos(side === 'ce' ? r.calls_iv : r.puts_iv) ?? pos(side === 'ce' ? r.calls_iv_eod : r.puts_iv_eod),
            ltp: num(side === 'ce' ? r.calls_ltp : r.puts_ltp),
            volume: num(side === 'ce' ? r.calls_volume : r.puts_volume),
        }))
        .filter((x) => x.oi > 0)
        .sort((a, b) => b.oi - a.oi)
        .slice(0, n);
}

class NiftyTraderChainService {
    /**
     * @param {string} symbol e.g. "NIFTY", "BANKNIFTY", "RELIANCE"
     * @returns {Promise<{context: string, snapshot: object}|null>}
     */
    async fetchOptionContext(symbol) {
        const sym = String(symbol || '').trim().toLowerCase();
        if (!sym) return null;

        let rows;
        try {
            const res = await axios.get(API, {
                params: {
                    symbol: sym,
                    exchange: 'nse',
                    expiryDate: '',          // empty = nearest live expiry (auto-rolls past expiry day)
                    atmBelow: STRIKES_EACH_SIDE,
                    atmAbove: STRIKES_EACH_SIDE,
                },
                headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' },
                timeout: TIMEOUT_MS,
            });
            rows = res.data?.resultData?.opDatas;
        } catch (err) {
            logger.warn(`niftytrader chain failed for ${symbol}: ${err.message}`);
            return null;
        }

        if (!Array.isArray(rows) || !rows.length) {
            logger.warn(`niftytrader chain: no rows for ${symbol}`);
            return null;
        }

        const spot = num(rows[0].index_close);
        const expiry = toNseExpiry(rows[0].expiry_date);

        let totalCeOi = 0;
        let totalPeOi = 0;
        for (const r of rows) {
            totalCeOi += num(r.calls_oi) || 0;
            totalPeOi += num(r.puts_oi) || 0;
        }
        // Recomputed, never taken from their `pcr` field — see file header.
        const pcr = totalCeOi ? totalPeOi / totalCeOi : null;

        const strikes = rows
            .map((r) => ({
                strike: num(r.strike_price),
                ce: {
                    ltp: num(r.calls_ltp),
                    oi: num(r.calls_oi),
                    iv: pos(r.calls_iv) ?? pos(r.calls_iv_eod),
                },
                pe: {
                    ltp: num(r.puts_ltp),
                    oi: num(r.puts_oi),
                    iv: pos(r.puts_iv) ?? pos(r.puts_iv_eod),
                },
            }))
            .filter((s) => Number.isFinite(s.strike));

        if (!strikes.length) return null;

        const atmRow = spot == null
            ? null
            : strikes.reduce((b, s) => (Math.abs(s.strike - spot) < Math.abs(b.strike - spot) ? s : b));

        const topCe = topStrikes(rows, 'ce');
        const topPe = topStrikes(rows, 'pe');

        const lines = [
            `Symbol: ${String(symbol).toUpperCase()} (via niftytrader fallback)`,
            `Expiry: ${expiry}`,
        ];
        if (spot != null) lines.push(`Underlying: ${spot}`);
        if (pcr != null) lines.push(`PCR (Put OI / Call OI): ${pcr.toFixed(2)}`);
        lines.push(`Total Call OI: ${totalCeOi} | Total Put OI: ${totalPeOi}`);
        if (atmRow) {
            lines.push(`ATM strike: ${atmRow.strike}`);
            lines.push(`  ATM CE: OI ${atmRow.ce.oi ?? 'n/a'}, IV ${atmRow.ce.iv ?? 'n/a'}%, LTP ₹${atmRow.ce.ltp ?? 'n/a'}`);
            lines.push(`  ATM PE: OI ${atmRow.pe.oi ?? 'n/a'}, IV ${atmRow.pe.iv ?? 'n/a'}%, LTP ₹${atmRow.pe.ltp ?? 'n/a'}`);
        }
        lines.push('[NSE unreachable — chain from niftytrader; premiums may differ by a few rupees]');

        return {
            context: lines.join('\n'),
            snapshot: {
                symbol: String(symbol).toUpperCase(),
                type: 'Indices',
                expiry,
                spot,
                pcr,
                strikes,
                totalCeOi,
                totalPeOi,
                topCe,
                topPe,
                atmStrike: atmRow?.strike ?? null,
                atmCe: atmRow ? { strike: atmRow.strike, ...atmRow.ce, changeOi: null } : null,
                atmPe: atmRow ? { strike: atmRow.strike, ...atmRow.pe, changeOi: null } : null,
                chainTimestamp: rows[0].time || null,
                fetchedAt: new Date().toISOString(),
                /** Consumers must surface this — it is not NSE. */
                source: 'niftytrader',
                stale: false,
                ageSec: 0,
            },
        };
    }
}

export const niftyTraderChainService = new NiftyTraderChainService();
export default NiftyTraderChainService;
