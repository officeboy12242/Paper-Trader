// Export an ML-ready JSONL dataset: every closed gold/NSE trade joined with
// the feature window (last ~90 1m bars at decision time) captured in its
// signal metadata, plus the outcome label.
//   npm run ml:export              -> data/ml_dataset.jsonl
//   npm run ml:export labels.jsonl -> custom output path
import '../src/config.js';
import { loadConfig } from '../src/config.js';
import { Database } from '../src/db/database.js';
import fs from 'node:fs';
import path from 'node:path';

const cfg = loadConfig();
const db = new Database(cfg.DATABASE_PATH);
const out = process.argv[2] || path.join(cfg.DATABASE_PATH, '..', 'ml_dataset.jsonl');

const parse = (v) => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };
const dirSign = (d) => (d === 'LONG' ? 1 : -1);

const rows = [];
for (const t of db.closedTrades()) {
    const meta = parse(t.signal_metadata);
    if (!meta) continue;
    const risk = Math.abs(t.entry_price - t.initial_stop);
    const rMultiple = risk > 0 ? ((t.exit_price - t.entry_price) * dirSign(t.direction)) / risk : null;
    rows.push({
        ts: t.entry_time,
        strategy: meta.strategyCode,
        source: meta.source,
        symbol: t.symbol,
        direction: t.direction,
        setup: meta.setup,
        confluence: meta.confluence,
        ai: meta.ai,
        filterCondition: t.filter_condition,
        entry: t.entry_price,
        stop: t.initial_stop,
        target: t.target_price,
        quantity: t.quantity,
        featureBars: meta.featureBars,
        outcome: {
            netPnl: t.net_pnl,
            grossPnl: t.gross_pnl,
            fees: t.fees,
            exitReason: t.exit_reason,
            holdingSeconds: t.holding_seconds,
            rMultiple: rMultiple != null ? Math.round(rMultiple * 100) / 100 : null,
            win: t.net_pnl > 0,
        },
    });
}

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
console.log(`Wrote ${rows.length} sample(s) with feature windows to ${out}`);
console.log(`Coverage: ${new Set(rows.map((r) => r.strategy)).size} strategies, ${rows.filter((r) => r.featureBars).length} with bar windows`);
process.exit(0);
