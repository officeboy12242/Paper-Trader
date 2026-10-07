const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('data/papertrader.db');
const rows = db.prepare(`SELECT id, strategy_id, symbol, direction, entry_price, exit_price, exit_reason, gross_pnl, fees, net_pnl, entry_time, exit_time, signal_metadata
  FROM trades WHERE status='CLOSED' ORDER BY exit_time DESC LIMIT 12`).all();
for (const r of rows) {
  let meta = {};
  try { meta = JSON.parse(r.signal_metadata || 'null') || {}; } catch {}
  console.log({
    id: r.id, s: r.strategy_id, sym: r.symbol, dir: r.direction,
    entry: r.entry_price, exit: r.exit_price, reason: r.exit_reason,
    gross: r.gross_pnl, fees: r.fees, net: r.net_pnl,
    setup: meta.setup ? { entry: meta.setup.entry, stop: meta.setup.stop, target: meta.setup.target, score: meta.setup.score, checks: Object.keys(meta.setup.checks||{}).length ? meta.setup.checks : undefined } : null,
    system1: meta.system1 ? meta.system1.take + '/' + meta.system1.direction + '@' + meta.system1.conviction : null,
  });
}
