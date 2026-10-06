// Opt-in: LIVE_TESTS=1 npm test. Runs every ORIGINAL discovery source against
// the real NSE / Yahoo endpoints (network required, best during market hours).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCfg } from './helpers.js';
import { discoverStrategies } from '../src/strategies/registry.js';
import { SourceStrategy } from '../src/strategies/sourceStrategy.js';
import { MarketDataService } from '../src/market/marketData.js';
import { nullLogger } from '../src/logger.js';

const live = process.env.LIVE_TESTS === '1';

for (const def of discoverStrategies()) {
    test(`LIVE ${def.code} ${def.key}: original discovery runs and maps to candidates`, { skip: !live, timeout: 300_000 }, async () => {
        const s = new SourceStrategy({ def, cfg: makeCfg() });
        const { discovery, candidates } = await s.discover();
        assert.ok(Array.isArray(candidates));
        assert.equal(discovery.discoverySource, def.key);
        for (const c of candidates) {
            assert.match(c.symbol, /^[A-Z0-9&_-]+$/);
            if (c.setup) {
                const d = c.setup.direction === 'LONG' ? 1 : -1;
                assert.ok((c.setup.stop - c.setup.entry) * d < 0, `${c.symbol} stop on loss side`);
            }
        }
        console.log(`  ${def.key}: ${candidates.length} candidates, ${candidates.filter((c) => c.setup).length} with setups: ${candidates.map((c) => c.symbol).join(', ')}`);
    });
}

test('LIVE market data: 1-minute bars for RELIANCE', { skip: !live, timeout: 60_000 }, async () => {
    const md = new MarketDataService({ cfg: makeCfg(), logger: nullLogger });
    const bars = await md.getBars('RELIANCE');
    assert.ok(bars.length > 0);
    assert.equal(bars.at(-1).ts % 60_000, 0, 'minute-aligned');
});
