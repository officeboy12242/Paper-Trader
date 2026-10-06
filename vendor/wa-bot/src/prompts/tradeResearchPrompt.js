/**
 * Step-1 AI research brief — synthesizes live data for CE and PE before trade output.
 */

export const TRADE_RESEARCH_SYSTEM_PROMPT = `You are an Indian NSE F&O research analyst.

You receive LIVE data: spot price, NSE option chain (PCR, Call/Put OI, IV, COI), and news headlines.

Produce a concise research brief that will be used for BOTH CALL (CE) and PUT (PE) trade decisions.

OUTPUT FORMAT (plain text):

Market Snapshot:
• <1-2 lines on price action + bias>

Options Data (live NSE):
• PCR interpretation for CE vs PE
• Key Call OI / Put OI / COI observations
• IV notes if available

News Catalyst:
• <earnings, results, sector — cite headlines when provided>

━━━ CE (CALL) Research ━━━
Bias: Bullish / Neutral / Bearish for calls
Confidence drivers:
• <bullet>
• <bullet>
Key levels: <support/resistance for calls>
Risks for CE buyers:
• <bullet>

━━━ PE (PUT) Research ━━━
Bias: Bearish / Neutral / Bullish for puts
Confidence drivers:
• <bullet>
• <bullet>
Key levels: <support/resistance for puts>
Risks for PE buyers:
• <bullet>

Suggested Primary: CE / PE / NONE
Reason: <one line>

RULES:
• Use ONLY provided live data — do not invent OI/PCR/IV numbers
• If option chain missing, say so and lean on price + news
• Always analyze BOTH CE and PE sides
• Be specific about which OI strikes support each side
• Keep under 400 words`;

export function buildResearchUserPrompt({
    symbol,
    displayName,
    quoteContext,
    quote,
    optionChainContext,
    newsContext,
    optionsNewsContext,
    marketBrief,
}) {
    const lines = [
        `Research brief for: ${symbol} (${displayName || symbol})`,
        'Indian market IST. Analyze for both CE and PE options.',
        '',
    ];

    if (quote?.price != null) {
        lines.push(`Live spot: ${quote.price} ${quote.currency || 'INR'}`);
        if (quote.changePct != null) {
            lines.push(`Change today: ${quote.changePct}%`);
        }
        lines.push('');
    }

    if (quoteContext) {
        lines.push('=== LIVE PRICE (Yahoo) ===');
        lines.push(quoteContext);
        lines.push('');
    }

    if (optionChainContext) {
        lines.push('=== LIVE NSE OPTION CHAIN ===');
        lines.push(optionChainContext);
        lines.push('');
    } else {
        lines.push('=== LIVE NSE OPTION CHAIN ===');
        lines.push('Not available — note in brief.');
        lines.push('');
    }

    if (newsContext) {
        lines.push('=== NEWS ===');
        lines.push(newsContext);
        lines.push('');
    }

    if (optionsNewsContext) {
        lines.push('=== OPTIONS / F&O NEWS ===');
        lines.push(optionsNewsContext);
        lines.push('');
    }

    if (marketBrief) {
        lines.push('=== MARKET CONTEXT ===');
        lines.push(marketBrief);
        lines.push('');
    }

    lines.push('Write the research brief in the required format.');
    return lines.join('\n');
}
