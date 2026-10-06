/**
 * AI resolves renamed / demerged NSE tickers → current NSE + Yahoo symbols.
 */

export const SYMBOL_RESOLVE_SYSTEM_PROMPT = `You resolve Indian NSE stock ticker symbols for live market data APIs (Yahoo Finance + NSE option chain).

Users may type OLD tickers after renames, demergers, mergers, or spin-offs.

KNOWN RECENT EXAMPLES (use your knowledge + user input):
• TATAMOTORS / old Tata Motors → passenger: NSE TMPV, Yahoo TMPV.NS | commercial: NSE TMCV, Yahoo TMCV.NS
• Always prefer the F&O-listed entity users mean when they type a legacy name

Given a symbol that FAILED on Yahoo Finance, return the correct CURRENT mappings that work TODAY.

OUTPUT — valid JSON only:
{
  "nse_symbol": "CURRENT_NSE_TICKER",
  "yahoo_symbols": ["TICKER.NS", "ALT.NS"],
  "notes": "one line why (optional)"
}

RULES:
• nse_symbol = NSE F&O ticker on nseindia.com (no .NS suffix)
• yahoo_symbols = Yahoo Finance symbols to try, most likely first (.NS for NSE)
• Do NOT return delisted or pre-demerger tickers if a newer one exists (e.g. avoid broken TATAMOTORS.NS)
• For indices: NIFTY / BANKNIFTY — nse matches index name; yahoo uses ^NSEI / ^NSEBANK
• If a retry says previous yahoo_symbols failed, return different working tickers
• If truly unknown, set nse_symbol to null and yahoo_symbols to []`;

export function buildSymbolResolveUserPrompt(userSymbol, { optionChainFailed = false, attemptedNse = null, failedYahoo = [] } = {}) {
    const lines = [
        `User symbol: ${userSymbol}`,
        'Yahoo Finance live quote lookup failed for the default NSE ticker.',
    ];
    if (failedYahoo.length) {
        lines.push(`These Yahoo symbols were tried and FAILED: ${failedYahoo.join(', ')}`);
        lines.push('Return different current NSE + Yahoo mappings that work today.');
    }
    if (optionChainFailed && attemptedNse) {
        lines.push(`NSE option chain also failed for nse_symbol: ${attemptedNse}`);
        lines.push('Return corrected nse_symbol and yahoo_symbols.');
    }
    lines.push('Respond with JSON only.');
    return lines.join('\n');
}
