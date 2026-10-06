/**
 * System prompt for AI-powered option chain deep analysis (DeepSeek V4 Flash).
 *
 * Goes beyond the deterministic rules in IndexAnalysisService — the LLM
 * interprets complex patterns: IV skew, unusual OI clusters, PCR anomalies,
 * strike-wise volume spikes, and synthesizes them into a coherent strategy.
 */

export const CHAIN_AI_SYSTEM_PROMPT = `You are an expert Indian F&O market microstructure analyst specializing in NSE/BSE option chains.

Your job: read the live chain, do all the microstructure analysis INTERNALLY, and hand back ONE strong, actionable trade setup — or explicitly NO TRADE if nothing meets the bar. Never dump the analysis sections into the output.

ANALYZE INTERNALLY (do NOT print these — they are your reasoning, not the reply):
1. PCR — is it diverging from the usual regime? What does the CE/PE OI split say about positioning?
2. IV SKEW — put-skewed (fear) vs call-skewed (greed)? OTM aggressive vs ATM? Any IV crush/spike?
3. OI WALLS — the REAL support/resistance strikes, distance from spot, walls building vs unwinding.
4. UNUSUAL ACTIVITY — disproportionate volume vs OI, large COI at specific strikes, CE vs PE volume imbalance.
5. MAX PAIN DRIFT — where max pain sits vs spot, whether the tape is being pulled toward it.
6. MARKET REGIME — range / breakout-pending / trending, directional bias, expiry dynamics.

Then synthesize ONE trade setup from that reasoning.

BAR FOR FIRING A TRADE (all must hold — otherwise output NO TRADE):
• At least TWO independent signals align in the same direction (e.g. OI walls + IV skew, or PCR divergence + max pain drift + unusual OI).
• R:R must be at least 1.5:1 with a realistic target — anchor T1 to real OI walls, max pain, or intraday levels, not wishful thinking.
• Entry premium must be within 5–10% of current LTP so a limit order fills.
• Stop loss 20–40% below entry — tight enough to matter, loose enough to survive noise.
• Chain data must be usable (liquid strikes, non-stale IV). If data is thin, say NO TRADE.

OUTPUT — ONLY this card, nothing before or after, no analysis sections:

━━━━━━━━━━━━━━━━━━━━━━━━━━━
🧠 *CHAIN AI — TRADE SETUP*
━━━━━━━━━━━━━━━━━━━━━━━━━━━

📊 *<SYMBOL>* · Spot: ₹<spot> · Expiry: <date>

📌 *<BUY CE / BUY PE / STRADDLE / SPREAD / NO TRADE>*
Option: <strike> <CE/PE> @ ₹<current LTP>
Conviction: <HIGH / MEDIUM / LOW>

┌─ *ENTRY PLAN* ─
│ Entry: ₹<entry premium>
│ Target 1: ₹<t1> (+<x%>) — exit 50%
│ Target 2: ₹<t2> (+<x%>) — exit rest
│ Stop Loss: ₹<sl> (-<x%>) — strict
│ R:R: <x>:1
└─────────────────────────

┌─ *SIZING (per lot)* ─
│ Lot size: <n> qty
│ Max risk / lot: ₹<(entry - sl) × lot>
│ Expected profit / lot at T1: ₹<(t1 - entry) × lot>
└─────────────────────────

┌─ *WHY THIS TRADE* ─
│ <2–4 concise lines citing the STRONGEST signals from your internal analysis: OI wall proximity, IV skew direction, PCR divergence, max pain drift. Use numbers from the chain — strikes, OI values, IV %, PCR — not adjectives.>
└─────────────────────────

━━━━━━━━━━━━━━━━━━━━━━━━━━━

IF NO TRADE — replace ENTRY PLAN and SIZING entirely with a single block:

┌─ *WHY NO TRADE* ─
│ <1–2 lines: which of the bar conditions failed. Be specific — "R:R only 1.2 to nearest wall", "PCR neutral + IV flat, no directional lean", "call wall broken but max pain 200pts away", etc.>
└─────────────────────────

RULES:
• OUTPUT ONLY THE CARD ABOVE. Never print PCR/IV/OI/Max Pain/Regime sections — those are your internal reasoning.
• Use ACTUAL premium prices, strikes and OI values from the chain — never invent numbers.
• Numbers in "Why this trade" must reference real values from the data.
• Prefer NO TRADE over a weak setup — a bad trade costs more than a missed one.
• Use ₹ for all prices. Plain text only, no markdown headings.
• No AI/model references, no research-report tone.
• Lot sizes: NIFTY 25 · BANKNIFTY 15 · FINNIFTY 40 · MIDCPNIFTY 75. For equities, use the strike's lot if known, else say "lot size TBD".`;

/**
 * Build user prompt with option chain snapshot + market data.
 * @param {object} snapshot - from NseOptionChainService
 * @param {object} [quote] - from IndianStockQuoteService
 * @param {object} [chainMeta] - max pain, walls, etc. from IndexAnalysisService
 * @returns {string}
 */
export function buildChainAiUserPrompt(snapshot, quote, chainMeta) {
    const lines = [
        'Analyze this live NSE option chain and provide deep microstructure insights.',
        '',
    ];

    if (snapshot) {
        lines.push('=== OPTION CHAIN SNAPSHOT ===');
        lines.push(`Symbol: ${snapshot.symbol} (${snapshot.type})`);
        lines.push(`Expiry: ${snapshot.expiry}`);
        lines.push(`Spot/Underlying: ${snapshot.spot}`);
        lines.push(`PCR: ${snapshot.pcr?.toFixed(3)}`);
        lines.push(`Total CE OI: ${snapshot.totalCeOi?.toLocaleString('en-IN')}`);
        lines.push(`Total PE OI: ${snapshot.totalPeOi?.toLocaleString('en-IN')}`);
        lines.push('');

        if (snapshot.atmStrike) {
            lines.push(`ATM Strike: ${snapshot.atmStrike}`);
            if (snapshot.atmCe) {
                lines.push(`ATM CE: LTP ₹${snapshot.atmCe.ltp}, OI ${snapshot.atmCe.oi}, IV ${snapshot.atmCe.iv}%, COI ${snapshot.atmCe.changeOi}`);
            }
            if (snapshot.atmPe) {
                lines.push(`ATM PE: LTP ₹${snapshot.atmPe.ltp}, OI ${snapshot.atmPe.oi}, IV ${snapshot.atmPe.iv}%, COI ${snapshot.atmPe.changeOi}`);
            }
            lines.push('');
        }

        if (snapshot.topCe?.length) {
            lines.push('Top CE OI strikes:');
            for (const r of snapshot.topCe.slice(0, 7)) {
                lines.push(`  CE ${r.strike}: OI ${r.oi?.toLocaleString('en-IN')}, COI ${r.changeOi}, IV ${r.iv}%, LTP ₹${r.ltp}`);
            }
            lines.push('');
        }

        if (snapshot.topPe?.length) {
            lines.push('Top PE OI strikes:');
            for (const r of snapshot.topPe.slice(0, 7)) {
                lines.push(`  PE ${r.strike}: OI ${r.oi?.toLocaleString('en-IN')}, COI ${r.changeOi}, IV ${r.iv}%, LTP ₹${r.ltp}`);
            }
            lines.push('');
        }

        if (snapshot.strikes?.length && snapshot.atmStrike) {
            const atmIdx = snapshot.strikes.findIndex((s) => s.strike === snapshot.atmStrike);
            if (atmIdx >= 0) {
                const start = Math.max(0, atmIdx - 5);
                const end = Math.min(snapshot.strikes.length, atmIdx + 6);
                const nearby = snapshot.strikes.slice(start, end);
                lines.push('Strike-wise data (±5 from ATM):');
                for (const s of nearby) {
                    const ce = s.ce ? `CE: IV=${s.ce.iv}% OI=${s.ce.oi} LTP=₹${s.ce.ltp}` : 'CE: –';
                    const pe = s.pe ? `PE: IV=${s.pe.iv}% OI=${s.pe.oi} LTP=₹${s.pe.ltp}` : 'PE: –';
                    const marker = s.strike === snapshot.atmStrike ? ' ← ATM' : '';
                    lines.push(`  ${s.strike}:${marker}`);
                    lines.push(`    ${ce}`);
                    lines.push(`    ${pe}`);
                }
                lines.push('');
            }
        }
    }

    if (quote) {
        lines.push('=== MARKET DATA ===');
        lines.push(`Price: ₹${quote.price} (${quote.changePct >= 0 ? '+' : ''}${quote.changePct}%)`);
        lines.push(`Day range: ₹${quote.low} – ₹${quote.high}`);
        lines.push(`Volume: ${quote.volume?.toLocaleString('en-IN')}`);
        lines.push('');
    }

    if (chainMeta) {
        lines.push('=== CHAIN METADATA ===');
        if (chainMeta.maxPain != null) lines.push(`Max Pain: ${chainMeta.maxPain}`);
        if (chainMeta.walls?.resistance) {
            lines.push(`Call wall: ${chainMeta.walls.resistance.strike} (OI: ${chainMeta.walls.resistance.oi?.toLocaleString('en-IN')})`);
        }
        if (chainMeta.walls?.support) {
            lines.push(`Put wall: ${chainMeta.walls.support.strike} (OI: ${chainMeta.walls.support.oi?.toLocaleString('en-IN')})`);
        }
        if (chainMeta.pcrLabel) lines.push(`PCR interpretation: ${chainMeta.pcrLabel}`);
        lines.push('');
    }

    const LOT_SIZES = { NIFTY: 25, BANKNIFTY: 15, FINNIFTY: 40, MIDCPNIFTY: 75 };
    const lotSize = LOT_SIZES[snapshot?.symbol?.toUpperCase()] || null;
    if (lotSize) lines.push(`Lot size for ${snapshot.symbol}: ${lotSize} qty per lot`);
    lines.push('');
    lines.push('CRITICAL:');
    lines.push('- Do PCR / IV skew / OI walls / unusual activity / max pain / regime analysis INTERNALLY — do NOT print those sections.');
    lines.push('- Output ONLY the TRADE SETUP card in the exact format specified. Nothing before, nothing after.');
    lines.push('- If no setup meets the bar (>=2 aligned signals, R:R >=1.5, entry within 5-10% of LTP, usable liquidity), output NO TRADE with a specific reason. Do not force a trade.');
    lines.push('- Use actual premium prices, strikes and OI values from the chain data above — never invent numbers.');
    return lines.join('\n');
}

/**
 * Format the LLM response for WhatsApp delivery.
 * @param {string} text - raw LLM output
 * @returns {string}
 */
export function formatChainAiAnalysis(text) {
    if (!text) return '⚠️ No analysis generated';
    return text.trim();
}
