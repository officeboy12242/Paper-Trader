// Dry run: runs the ORIGINAL discovery for every source (or one) and prints
// candidates and setups. Places no orders and writes nothing.
//   npm run scan            all sources
//   npm run scan heatmap2   one source
import '../src/config.js';
import { discoverStrategies } from '../src/strategies/registry.js';
import { SourceStrategy } from '../src/strategies/sourceStrategy.js';
import { loadConfig } from '../src/config.js';

const cfg = loadConfig();
const only = process.argv[2];
for (const def of discoverStrategies().filter((d) => !only || d.key === only)) {
    const t0 = Date.now();
    try {
        const { candidates } = await new SourceStrategy({ def, cfg }).discover();
        console.log(`\n${def.code} ${def.key}  (${Date.now() - t0} ms, ${candidates.length} candidates)`);
        for (const c of candidates) {
            const s = c.setup;
            console.log(`  ${c.symbol.padEnd(12)} ${s ? `${s.direction.padEnd(5)} entry ${s.entry}  stop ${s.stop}  T1 ${s.target ?? '-'}  score ${s.score ?? '-'}` : 'no setup levels'}  confluence ${c.meta?.confluence ?? '-'}`);
        }
    } catch (err) {
        console.log(`\n${def.code} ${def.key}  FAILED: ${err.message}`);
    }
}
process.exit(0);
