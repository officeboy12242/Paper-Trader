/**
 * Backtest controller — runs NIFTY backtest and sends results via WhatsApp.
 *
 * Commands:
 *   /backtest        — run full backtest (60 days)
 *   /backtest 30     — run with last 30 days
 */

import { logger } from '../utils/logger.js';
import NiftyBacktestService from '../services/NiftyBacktestService.js';

class BacktestController {
    constructor(config = {}) {
        this.config = config;
        this.service = new NiftyBacktestService(config);
    }

    async handleCommand(chatId, text, sock) {
        const match = text.match(/^\/backtest(?:\s+(\d+))?$/i);
        if (!match) return false;

        const days = Math.min(60, Math.max(5, Number(match[1]) || 60));

        // Send "running" message
        await sock.sendMessage(chatId, {
            text: `🧪 *Running NIFTY Backtest…*\n\n📅 Fetching ${days} days of 5m data from Yahoo\n🧮 Simulating Fade VWAP + Keltner + Supertrend\n💰 Capital: ₹30,000 · Lot: 75\n\n⏳ This takes 10-30 seconds...`,
        });

        try {
            // Fetch historical candles
            const candles = await this.service.fetchHistoricalCandles(`${days}d`);
            logger.info(`Backtest: fetched ${candles.length} candles`);

            // Run backtest
            const stats = this.service.runBacktest(candles);

            // Format and send results
            const card = this.service.formatResults(stats);
            await sock.sendMessage(chatId, { text: card });

            // Send top 5 trades as bonus
            if (stats.trades.length > 0) {
                const top5 = [...stats.trades]
                    .sort((a, b) => b.pnl - a.pnl)
                    .slice(0, 5);

                const tradeLines = [
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                    '🏆 *TOP 5 TRADES*',
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                    '',
                ];

                for (const t of top5) {
                    const emoji = t.pnl > 0 ? '🟢' : '🔴';
                    const stratLabel = { fade_vwap: 'Fade', keltner: 'KC', supertrend: 'ST' };
                    tradeLines.push(
                        `${emoji} ${t.date} · ${stratLabel[t.strategy] || t.strategy} · ${t.side}`,
                        `   Entry: ${t.entry?.toFixed(0)} → Exit: ${t.exit?.toFixed(0)} · ${t.exitReason}`,
                        `   P&L: ${t.pnl >= 0 ? '+' : ''}₹${t.pnl}`,
                        '',
                    );
                }

                await sock.sendMessage(chatId, { text: tradeLines.join('\n') });
            }

        } catch (err) {
            logger.error(`Backtest failed: ${err.message}`);
            await sock.sendMessage(chatId, {
                text: `❌ *Backtest Failed*\n\n${err.message}\n\n💡 Make sure market data is available (Yahoo may be down or rate-limited).`,
            });
        }

        return true;
    }
}

export default BacktestController;
