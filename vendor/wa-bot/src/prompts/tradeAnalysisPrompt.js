/**
 * System prompt for NSE/BSE F&O trade analysis (NVIDIA DeepSeek).
 * Always outputs BOTH CE (Call) and PE (Put) scenario analysis.
 */

import { formatNowLabelIST } from '../utils/dateIST.js';
import { formatAlertMetaFooter, formatAlertTimings } from '../utils/tradeScanFormatter.js';

export const TRADE_ANALYSIS_SYSTEM_PROMPT = `You are an expert options trader for the Indian stock market (NSE/BSE) specializing in FUTURES & OPTIONS.

Analyze the symbol and provide BOTH sides — CALL (CE) and PUT (PE) — every time. Users need full scenario analysis, not just one leg.

Analyze ALL of the following before deciding:

1. PRICE ACTION — intraday + daily trend; breakouts; support/resistance; volume
2. OPTIONS DATA — use LIVE NSE OPTION CHAIN when provided (PCR, CE/PE OI, COI, IV, top strikes). Do NOT invent OI numbers.
3. VOLATILITY — IV level, spike/crush vs historical
4. MARKET SENTIMENT — NIFTY/BANKNIFTY bias
5. NEWS & FUNDAMENTALS — earnings, results, sector/macro (use LIVE NEWS when provided)
6. RISK — minimum 1:2 risk-reward; liquidity

OUTPUT FORMAT (use exactly these section headers, plain text for WhatsApp):

Stock: <NAME>
Spot Price: <PRICE>

Market Bias: Bullish / Bearish / Sideways

━━━ CALL (CE) SETUP ━━━
Verdict: ✅ BUY CE / ⚠️ WEAK / ❌ AVOID
Confidence: <0–100>%
Strike: <strike + weekly/monthly expiry>
Entry: <approx premium in ₹>
Target 1: <first premium target — conservative>
Target 2: <second premium target — moderate>
Target 3: <third premium target — extended>
Stop Loss: <strict SL premium in ₹>
Why:
• <bullet>
• <bullet>

━━━ PUT (PE) SETUP ━━━
Verdict: ✅ BUY PE / ⚠️ WEAK / ❌ AVOID
Confidence: <0–100>%
Strike: <strike + expiry>
Entry: <approx premium in ₹>
Target 1: <first premium target>
Target 2: <second premium target>
Target 3: <third premium target>
Stop Loss: <strict SL premium in ₹>
Why:
• <bullet>
• <bullet>

Primary Pick: ✅ BUY CE / ✅ BUY PE / ❌ NO TRADE
Primary Confidence: <0–100>%

RULES:
• ALWAYS fill both CE and PE sections — even if one side is AVOID
• CE section must cite Call OI/PCR/IV evidence; PE section must cite Put OI/PCR/IV evidence
• When AI RESEARCH BRIEF is provided, use it but verify against live chain data
• Primary Pick = best side only if confidence ≥70%; else NO TRADE
• Only mark ✅ BUY CE or ✅ BUY PE when that side's confidence ≥70%
• Use WEAK for 50–69%, AVOID for <50% or poor setup
• Entry / Targets / SL MUST be option *premiums* (₹), NEVER the stock spot price
• When LIVE NSE OPTION CHAIN is provided, Strike MUST be the ATM strike + that expiry, and Entry MUST use the ATM CE/PE LTP from the chain (do not invent premiums)
• Target 1/2/3 = premium levels (₹); bot adds lot P&L — space T1 < T2 < T3 for CE buys, reverse for PE buys
• Keep bullets short
• Do not mention AI or models
• Spot Price MUST match MANDATORY line exactly when provided
• If no live spot price → Primary Pick: NO TRADE; still give cautious CE/PE notes with AVOID`;

export function buildTradeUserPrompt({
    symbol,
    displayName,
    quoteContext,
    quote,
    newsContext,
    optionsNewsContext,
    optionChainContext,
    researchBrief,
    marketBrief,
    mode = 'live',
}) {
    const lines = [
        `Analyze this Indian market symbol for F&O options.`,
        `Provide BOTH CALL (CE) and PUT (PE) scenario analysis.`,
        `Symbol: ${symbol}`,
        `Name: ${displayName || symbol}`,
        `Mode: ${mode === 'daily' ? 'Pre-market daily alert' : 'On-demand analysis'}`,
        `Date context: Indian market (IST), use latest NSE expiries.`,
        '',
    ];

    if (quoteContext) {
        lines.push('=== LIVE PRICE DATA (Yahoo Finance) ===');
        lines.push(quoteContext);
        lines.push('');
    } else {
        lines.push('=== LIVE PRICE DATA ===');
        lines.push('Unavailable — Primary Pick must be NO TRADE. Do NOT guess spot price.');
        lines.push('');
    }

    if (quote?.price != null) {
        const currency = quote.currency || 'INR';
        const pct =
            quote.changePct != null
                ? `, ${quote.changePct >= 0 ? '+' : ''}${quote.changePct}% today`
                : '';
        lines.push('=== MANDATORY OUTPUT (Spot Price) ===');
        lines.push(`Copy this EXACTLY into Spot Price line:`);
        lines.push(`Spot Price: ${quote.price} ${currency}${pct} (live market data)`);
        lines.push('');
    } else {
        lines.push('=== MANDATORY OUTPUT ===');
        lines.push('No live price — Primary Pick: ❌ NO TRADE only.');
        lines.push('');
    }

    if (optionChainContext) {
        lines.push('=== LIVE NSE OPTION CHAIN (CE + PE) ===');
        const chain =
            optionChainContext.length > 3500
                ? `${optionChainContext.slice(0, 3500)}\n[...chain trimmed...]`
                : optionChainContext;
        lines.push(chain);
        lines.push(
            'MANDATORY: CE Entry = ATM CE LTP from chain; PE Entry = ATM PE LTP from chain. Strike = ATM strike + expiry. Never use spot price as Entry.'
        );
        lines.push('');
    } else {
        lines.push('=== LIVE NSE OPTION CHAIN ===');
        lines.push('Unavailable — use price + news only; note missing OI in Why bullets.');
        lines.push('');
    }

    if (newsContext) {
        lines.push('=== LIVE NEWS (Google News RSS) ===');
        lines.push(newsContext);
        lines.push('');
    }

    if (optionsNewsContext) {
        lines.push('=== OPTIONS / F&O NEWS ===');
        lines.push(optionsNewsContext);
        lines.push('');
    }

    if (researchBrief) {
        lines.push('=== AI RESEARCH BRIEF (Step 1 — CE + PE) ===');
        const brief =
            researchBrief.length > 2200
                ? `${researchBrief.slice(0, 2200)}\n[...research trimmed...]`
                : researchBrief;
        lines.push(brief);
        lines.push('');
    }

    if (marketBrief) {
        lines.push('=== BROADER MARKET CONTEXT ===');
        lines.push(marketBrief);
        lines.push('');
    }

    lines.push('Respond using the required OUTPUT FORMAT with BOTH CE and PE sections.');
    return lines.join('\n');
}

export function wrapTradeAlertMessage(symbol, body, { isDaily = false, isHiddenGem = false, meta = null } = {}) {
    let text = '';
    text += '┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n';
    if (isHiddenGem && isDaily) {
        text += '┃  💎 *HIDDEN GEM ALERT* 💎  ┃\n';
    } else {
        text += isDaily ? '┃  📈 *DAILY TRADE ALERT* 📈  ┃\n' : '┃  📊 *TRADE ANALYSIS* 📊  ┃\n';
    }
    text += '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n';
    if (isDaily) {
        const tag = isHiddenGem ? '💎 Hidden gem scan' : 'Morning scan';
        text += `🕐 _${tag} · ${symbol} · ${formatNowLabelIST()}_\n`;
        if (meta) {
            const footer = formatAlertMetaFooter(meta);
            if (footer) text += footer.replace(/^\n/, '');
            text += '\n';
        } else {
            text += '\n';
        }
    }
    text += body.trim();
    text += '\n\n─────────────────────────────\n';
    // Scan and pricing clocks belong here, above the disclaimer; the send clock is
    // appended later by withSentStamp, since it is not known until the send.
    const timings = formatAlertTimings(meta?.timings || {});
    if (timings) {
        text += `${timings.replace(/^\n/, '')}\n`;
    }
    text += '⚠️ _Not financial advice. For education only. Trade at your own risk._';
    return text;
}
