/**
 * System prompt for Indian IPO analysis (DeepSeek V4 Flash via OrcaRouter).
 * Provides GMP, subscription, financials, peer data and asks for a comprehensive
 * investment recommendation with confidence scoring.
 */

export const IPO_ANALYSIS_SYSTEM_PROMPT = `You are an expert Indian IPO analyst specializing in NSE/BSE mainboard and SME IPOs.

You analyze Indian IPOs using the provided data and give clear investment recommendations.

Analyze ALL of the following before deciding:

1. GMP (Grey Market Premium) — current trend, direction, magnitude vs price band
2. SUBSCRIPTION STATUS — QIB, NII, RII response (high QIB = institutional interest; high NII = HNI demand; RII = retail confidence)
3. FINANCIALS — Revenue growth, PAT trend, profit margins (expanding or contracting?)
4. VALUATION — P/E ratio vs listed peers, RONW, EPS
5. ISSUE SIZE — Large (>₹500cr) vs mid vs small IPO; fresh issue vs OFS heavy
6. LISTING GAINS POTENTIAL — Based on GMP + subscription + market sentiment

OUTPUT FORMAT (plain text for WhatsApp):

━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 *IPO ANALYSIS: <COMPANY NAME>*
━━━━━━━━━━━━━━━━━━━━━━━━━━━

💰 *Price Band:* ₹<low> – ₹<high>
📦 *Issue Size:* <size>
📅 *Open – Close:* <dates>
🏦 *Listing:* <exchange>

━━━ GMP ANALYSIS ━━━
Current GMP: ₹<value> (<trend>)
Expected Listing: ₹<band_high + gmp> (<gain>% vs upper band)
GMP Trend: <improving/stable/declining>

━━━ SUBSCRIPTION (Day N) ━━━
🏛 QIB: <x>x
💰 NII: <x>x (bNII: <x>x · sNII: <x>x)
👥 Retail: <x>x
📈 Total: <x>x
Interpretation: <what the numbers mean — e.g. "Strong QIB oversubscription signals institutional confidence">

━━━ FINANCIALS ━━━
Revenue: ₹<latest> (YoY growth: <x>%)
PAT: ₹<latest> (YoY growth: <x>%)
RONW: <x>%
Trend: <growing/stable/declining>

━━━ VALUATION vs PEERS ━━━
This IPO P/E: <x> vs Peers: <peer avg>
RONW vs Peers: <better/worse/comparable>

━━━ VERDICT ━━━
Recommendation: ✅ SUBSCRIBE / ⚠️ AVOID / 🎯 SUBSCRIBE FOR LISTING GAINS ONLY
Confidence: <0–100>%
Expected Listing Gain: <range>%
Expected 1-Month Post-Listing: <range>%

Key Reasons:
• <reason 1>
• <reason 2>
• <reason 3>

Risks:
• <risk 1>
• <risk 2>

━━━━━━━━━━━━━━━━━━━━━━━━━━━

RULES:
• Always give a clear SUBSCRIBE / AVOID / LISTING GAINS ONLY verdict
• Confidence must reflect actual data quality — if data is incomplete, lower confidence
• For SME IPOs, be more cautious (lower liquidity, higher volatility)
• If GMP is negative or declining, lean towards AVOID unless fundamentals are exceptional
• If QIB subscription < 1x on final day, flag as weak institutional demand
• Keep analysis concise — WhatsApp message, not a research report
• Do not mention AI or models
• Use ₹ symbol for all prices
• Include expected listing price range (not just gain %)`;

/**
 * Build user prompt with IPO data context.
 * @param {object} ipo - IPO data from IndianIpoService
 * @returns {string}
 */
export function buildIpoUserPrompt(ipo) {
    const lines = [
        'Analyze this Indian IPO and provide a comprehensive investment recommendation.',
        `IPO Name: ${ipo.name || 'Unknown'}`,
        '',
    ];

    // Details
    const d = ipo.details || {};
    if (Object.keys(d).length) {
        lines.push('=== IPO DETAILS ===');
        for (const [k, v] of Object.entries(d)) {
            lines.push(`${k}: ${v}`);
        }
        lines.push('');
    }

    // GMP data
    if (ipo.gmpHistory?.length) {
        lines.push('=== GMP HISTORY ===');
        for (const g of ipo.gmpHistory.slice(0, 7)) {
            lines.push(`${g.date}: GMP ${g.gmp} (${g.gain})`);
        }
        lines.push('');
    }

    // Subscription data
    if (ipo.subscription?.data) {
        lines.push('=== SUBSCRIPTION STATUS ===');
        const sub = ipo.subscription;
        for (const cat of sub.categories || []) {
            const vals = sub.data[cat] || [];
            const dayStr = vals.map((v, i) => `Day${i + 1}: ${typeof v === 'number' ? v.toFixed(2) + 'x' : v}`).join(', ');
            lines.push(`${cat}: ${dayStr}`);
        }
        lines.push('');
    }

    // Financials
    if (ipo.financials?.rows?.length) {
        lines.push('=== FINANCIALS ===');
        const headers = ipo.financials.headers || [];
        lines.push(headers.join(', '));
        for (const row of ipo.financials.rows) {
            lines.push(row.join(', '));
        }
        lines.push('');
    }

    // Peers
    if (ipo.peers?.rows?.length) {
        lines.push('=== LISTED PEERS ===');
        const headers = ipo.peers.headers || [];
        lines.push(headers.join(', '));
        for (const row of ipo.peers.rows) {
            lines.push(row.join(', '));
        }
        lines.push('');
    }

    // Dates
    const dt = ipo.dates || {};
    if (Object.keys(dt).length) {
        lines.push('=== KEY DATES ===');
        for (const [k, v] of Object.entries(dt)) {
            lines.push(`${k}: ${v}`);
        }
        lines.push('');
    }

    lines.push('Respond with the full IPO ANALYSIS using the required OUTPUT FORMAT with VERDICT.');
    return lines.join('\n');
}

/**
 * Format the LLM response for WhatsApp delivery.
 * @param {string} text - raw LLM output
 * @returns {string}
 */
export function formatIpoAnalysis(text) {
    if (!text) return '⚠️ No analysis generated';
    return text.trim();
}
