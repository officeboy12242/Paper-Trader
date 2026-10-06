/**
 * Strategy registry.
 *
 * Strategies are DISCOVERED from WA-BOT's own list of trade-alert sources
 * (`DISCOVERY_SOURCES` in src/utils/discoverySource.js). Nothing here fixes the
 * count: add a source upstream and it becomes another paper trader.
 *
 * SOURCE_NOTES only carries documentation and scheduling defaults for sources
 * that exist today; an unknown future source still registers, with generic text.
 */

import {
    DISCOVERY_SOURCES,
    discoverySourceLabel,
    normalizeDiscoverySource,
} from '../../vendor/wa-bot/src/utils/discoverySource.js';
import { GOLD_STRATEGIES, ETH_STRATEGIES } from './gold.js';
import { strategyOverrides } from '../config.js';

const SOURCE_NOTES = {
    heatmap: {
        files: 'src/services/HeatmapBreakoutScanService.js · TradeDiscoveryEngine.runHeatmapBreakout',
        description:
            'NSE sector heatmap bias, stocks moving at least 2% with their sector, then a 15-minute opening-range breakout confirmed by a solid candle beyond the 8 EMA. Entry at the breakout / follow-through extreme, stop at the bar extreme or EMA, target 1.5R.',
        fixedForDay: false,
        needsAi: false,
    },
    heatmap2: {
        files: 'src/services/HeatmapV2ScanService.js · TradeDiscoveryEngine.runHeatmapV2',
        description:
            'Live intraday sector momentum with NIFTY 200-DMA regime, VWAP side, relative strength vs NIFTY, turnover floor, fresh opening-range break with mandatory follow-through before 12:00, ATR-bounded stop (0.6-2.0 ATR), target 1.0R, score at least 60.',
        fixedForDay: false,
        needsAi: false,
    },
    preopen: {
        files: 'src/services/PreOpenScanService.js · TradeDiscoveryEngine.runPreOpen',
        description:
            'NSE pre-open auction (09:00-09:08): IEP gap vs the F&O board median with order-book imbalance agreeing, auction turnover floor. Entry at IEP, stop 0.75 daily ATR (bounded), target 1R. Unvalidated upstream.',
        fixedForDay: true,
        needsAi: false,
    },
    turnover: {
        files: 'src/services/TurnoverBandScanService.js · TradeDiscoveryEngine.runTurnoverBand',
        description:
            'F&O names ranked 11-30 by previous-session turnover (at least Rs 20 cr), direction from daily EMA 8/21 stacking. Entry at last close, stop 0.75 daily ATR (bounded), target 1R. Thin evidence upstream.',
        fixedForDay: true,
        needsAi: false,
    },
    nse: {
        files: 'src/services/NseMarketDataService.js (fetchNiftyTopGainersLosers) · TradeDiscoveryEngine.runNseGainersLosers',
        description:
            'NIFTY 50 top 5 gainers and top 5 losers. The source gives no levels; trade side comes from the original AI CE/PE analysis, levels from the platform risk overlay.',
        fixedForDay: false,
        needsAi: true,
    },
    legacy: {
        files: 'src/services/MarketScanService.js · SmartMoneyScanService.js · CatalystRadarService.js · TradeDiscoveryEngine.runLegacy',
        description:
            'Hot sectors, momentum relative strength, bulk/block deals and top movers, with the original hidden-gem pick. The source gives no levels; trade side comes from the original AI CE/PE analysis.',
        fixedForDay: false,
        needsAi: true,
    },
};

/**
 * @returns {{ key: string, index: number, code: string, name: string, source: string, sourceFiles: string, description: string, enabled: boolean, fixedForDay: boolean, needsAiHint: boolean, rescanMinutes: number|null, scanTimes: string[]|null }[]}
 */
export function discoverStrategies(cfg = null) {
    const sources = DISCOVERY_SOURCES.map((key, i) => {
        const known = normalizeDiscoverySource(key) === key;
        const notes = SOURCE_NOTES[key] || {
            files: 'src/services/TradeDiscoveryEngine.js',
            description: `WA-BOT discovery source "${key}".`,
            fixedForDay: false,
            needsAi: false,
        };
        const ov = strategyOverrides(key);
        return {
            key,
            index: i + 1,
            code: `Strategy-${String(i + 1).padStart(2, '0')}`,
            name: known ? discoverySourceLabel(key) : key,
            source: `WA-BOT /tradelert source "${key}" (officeboy12242/WA-BOT)`,
            sourceFiles: notes.files,
            description: notes.description,
            enabled: ov.enabled,
            fixedForDay: notes.fixedForDay,
            needsAiHint: notes.needsAi,
            rescanMinutes: ov.rescanMinutes,
            scanTimes: ov.scanTimes,
        };
    });
    const cryptoDefs = (list, idxBase) => list.map((g, i) => {
        const ov = strategyOverrides(g.key);
        return {
            key: g.key,
            index: idxBase + i,
            code: `Strategy-${String(idxBase + i).padStart(2, '0')}`,
            name: g.name,
            source: `${g.key.startsWith('eth') ? 'ETH 24h (ETHUSD spot)' : 'Gold 24h (XAUUSD spot)'} — internal PaperTrader strategies`,
            sourceFiles: g.sourceFiles,
            description: g.description,
            enabled: ov.enabled,
            fixedForDay: false,
            needsAiHint: false,
            rescanMinutes: ov.rescanMinutes ?? (g.key.startsWith('eth') ? cfg?.ETH_SCAN_INTERVAL_MINUTES : cfg?.GOLD_SCAN_INTERVAL_MINUTES) ?? null,
            scanTimes: ov.scanTimes,
            roundTheClock: true,
            run: g.run,
            symbol: g.symbol,
            prefix: g.prefix,
        };
    });
    const gold = cryptoDefs(GOLD_STRATEGIES, DISCOVERY_SOURCES.length + 1);
    const eth = cryptoDefs(ETH_STRATEGIES, DISCOVERY_SOURCES.length + 1 + GOLD_STRATEGIES.length);
    return [...sources, ...gold, ...eth];
}

const parseTimes = (s) => String(s || '').split(',').map((t) => t.trim()).filter((t) => /^\d{1,2}:\d{2}$/.test(t));

/**
 * Daily clock for one strategy, mirroring WA-BOT's tradeAlertScheduler:
 * every source posts at TRADE_ALERT_TIME unless it has its own clock;
 * heatmap2 also runs at the morning-volatility time and HEATMAP2 times.
 * On top of that, sources whose inputs change intraday are rescanned every
 * SCAN_INTERVAL_MINUTES until ENTRY_CUTOFF (continuous monitoring).
 */
export function scheduleFor(def, cfg) {
    if (def.roundTheClock) {
        return { clock: [], rescanMinutes: def.rescanMinutes ?? cfg.GOLD_SCAN_INTERVAL_MINUTES };
    }
    if (def.scanTimes?.length) return { clock: def.scanTimes, rescanMinutes: def.rescanMinutes ?? 0 };
    let clock = [cfg.TRADE_ALERT_TIME];
    if (def.key === 'preopen' && parseTimes(cfg.TRADE_ALERT_PREOPEN_TIME).length) clock = parseTimes(cfg.TRADE_ALERT_PREOPEN_TIME);
    if (def.key === 'turnover' && parseTimes(cfg.TRADE_ALERT_TURNOVER_TIME).length) clock = parseTimes(cfg.TRADE_ALERT_TURNOVER_TIME);
    if (def.key === 'heatmap2') {
        clock = [...clock, ...parseTimes(cfg.TRADE_ALERT_MORNING_VOLATILITY_TIME), ...parseTimes(cfg.TRADE_ALERT_HEATMAP2_TIMES)];
    }
    const rescanMinutes = def.rescanMinutes ?? (def.fixedForDay ? 0 : cfg.SCAN_INTERVAL_MINUTES);
    return { clock: [...new Set(clock)].sort(), rescanMinutes };
}
