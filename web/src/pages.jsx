import React, { useEffect, useState } from 'react';
import { fnum, inr, price, pct, tone, IST } from './utils.js';
import { AreaChart, DayBars } from './charts.jsx';

const useApi = (path, ms = 5000) => {
  const [data, setData] = useState(null);
  useEffect(() => {
    let on = true;
    const pull = () => fetch(path).then((r) => (r.ok ? r.json() : Promise.reject(r.status))).then((j) => on && setData(j)).catch(() => {});
    pull();
    const t = setInterval(pull, ms);
    return () => { on = false; clearInterval(t); };
  }, [path, ms]);
  return data;
};

const Panel = ({ title, children, right }) => (
  <section className="panel">
    <header><h3>{title}</h3>{right}</header>
    {children}
  </section>
);

const Metric = ({ label, value, t }) => (
  <div className="stat"><div className={`v ${t || ''}`}>{value ?? '—'}</div><div className="l">{label}</div></div>
);

// ── Strategy detail ──────────────────────────────────────────────────────────
export function StrategyDetail({ id }) {
  const d = useApi(`/api/strategies/${id}`);
  if (!d) return <div className="empty">Loading…</div>;
  const gold = String(d.key).startsWith('gold_');
  const eth = String(d.key).startsWith('eth_');
  const m = d.metrics;
  const toggle = async () => { await fetch(`/api/strategies/${id}/${d.enabled ? 'disable' : 'enable'}`, { method: 'POST' }); location.reload(); };
  return (
    <>
      <div className="crumb"><a href="#/">← Terminal</a> / {d.code}</div>
      <div className="detail-head">
        <h1>{gold ? '🪙 ' : eth ? '⚡ ' : ''}{d.code} · {d.name}</h1>
        <button className={d.enabled ? 'btn danger' : 'btn'} onClick={toggle}>{d.enabled ? 'Disable trader' : 'Enable trader'}</button>
      </div>
      <p className="muted">{d.description}</p>
      <div className="stats">
        <Metric label="Status" value={d.status} t={d.status === 'RUNNING' ? 'pos' : d.status === 'ERROR' ? 'neg' : ''} />
        <Metric label="Schedule" value={d.schedule?.slots?.[0] ?? '—'} />
        <Metric label="AI gate" value={d.aiAvailable ? 'ON' : 'OFF'} />
        <Metric label="Today P&L" value={inr(d.today?.netPnl)} t={tone(d.today?.netPnl)} />
      </div>
      <div className="stats">
        <Metric label="Net P&L" value={inr(m?.netPnl)} t={tone(m?.netPnl)} />
        <Metric label="Total trades" value={m?.totalTrades ?? 0} />
        <Metric label="Win rate" value={m?.winRate != null ? pct(m.winRate) : '—'} />
        <Metric label="Loss rate" value={m?.winRate != null ? pct(1 - m.winRate) : '—'} />
        <Metric label="Avg profit" value={inr(m?.avgWin)} t="pos" />
        <Metric label="Avg loss" value={inr(m?.avgLoss != null ? -Math.abs(m.avgLoss) : null)} t="neg" />
        <Metric label="Profit factor" value={m?.profitFactor != null ? (m.profitFactor === 'Infinity' ? '∞' : Number(m.profitFactor).toFixed(2)) : '—'} />
        <Metric label="Max drawdown" value={m ? `${inr(-m.maxDrawdown)} (${pct(m.maxDrawdownPct / 100)})` : '—'} t={m?.maxDrawdown ? 'neg' : ''} />
        <Metric label="Avg holding" value={m?.avgHoldingSeconds != null ? `${Math.round(m.avgHoldingSeconds / 60)}m` : '—'} />
        <Metric label="Fees paid" value={m ? inr(-m.fees) : '—'} />
        <Metric label="This week" value={inr(d.periods?.weekly?.netPnl)} t={tone(d.periods?.weekly?.netPnl)} />
        <Metric label="This month" value={inr(d.periods?.monthly?.netPnl)} t={tone(d.periods?.monthly?.netPnl)} />
      </div>
      <Panel title="Equity curve"><AreaChart points={(d.equity || []).map((e) => ({ v: e.equity }))} color={eth ? '#627eea' : gold ? '#f0b41e' : '#2aa4e0'} /></Panel>
      <div className="two">
        <Panel title="Daily net P&L"><DayBars rows={d.dailyPnl} /></Panel>
        <Panel title="Monthly net P&L">
          <table><tbody>{(d.monthlyPnl || []).map((r) => (
            <tr key={r.key}><td>{r.key}</td><td className={`r ${tone(r.netPnl)}`}>{inr(r.netPnl)}</td></tr>
          ))}</tbody></table>
        </Panel>
      </div>
      <Panel title={`Current positions (${d.positions?.length || 0}) · Pending orders (${d.pendingOrders?.length || 0})`}>
        <table>
          <thead><tr><th>Symbol</th><th>Side</th><th className="r">Entry</th><th className="r">Current</th><th className="r">Target</th><th className="r">Stop</th><th className="r">Trailing</th><th className="r">Unrealized</th></tr></thead>
          <tbody>
            {(d.positions || []).map((p) => (
              <tr key={p.id}><td>{p.symbol}</td><td className={p.direction === 'LONG' ? 'pos' : 'neg'}>{p.direction}</td><td className="r">{price(p.entry_price)}</td><td className="r">{price(p.current_price)}</td><td className="r">{price(p.target_price)}</td><td className="r">{price(p.stop_loss_price)}</td><td className="r">{p.trailing_active ? price(p.trailing_stop) : 'armed @ target'}</td><td className={`r ${tone(p.unrealized_pnl)}`}>{inr(p.unrealized_pnl)}</td></tr>
            ))}
            {!d.positions?.length && <tr><td colSpan="8" className="muted">Flat</td></tr>}
          </tbody>
        </table>
      </Panel>
      <Panel title="Recent trades">
        <table>
          <thead><tr><th>Closed</th><th>Symbol</th><th>Side</th><th className="r">Entry</th><th className="r">Exit</th><th className="r">P&L</th><th>Reason</th></tr></thead>
          <tbody>
            {(d.recentTrades || []).map((t) => (
              <tr key={t.id}><td>{IST(t.exit_time)}</td><td>{t.symbol}</td><td className={t.direction === 'LONG' ? 'pos' : 'neg'}>{t.direction}</td><td className="r">{price(t.entry_price)}</td><td className="r">{price(t.exit_price)}</td><td className={`r ${tone(t.net_pnl)}`}>{inr(t.net_pnl)}</td><td>{t.exit_reason}</td></tr>
            ))}
            {!d.recentTrades?.length && <tr><td colSpan="7" className="muted">No closed trades yet</td></tr>}
          </tbody>
        </table>
      </Panel>
      <Panel title="Recent signals">
        <table>
          <thead><tr><th>Time</th><th>Type</th><th>Symbol</th><th>Side</th><th>Status</th><th>Reason</th></tr></thead>
          <tbody>
            {(d.recentSignals || []).map((s) => (
              <tr key={s.id}><td>{IST(s.timestamp)}</td><td>{s.signal_type}</td><td>{s.symbol}</td><td>{s.direction || '—'}</td><td>{s.status}</td><td className="muted">{s.reject_reason || ''}</td></tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <Panel title="Events"><div className="events">{(d.events || []).map((e) => <div key={e.id}><span className="t">{IST(e.ts)}</span><b>{e.type}</b> {e.message || ''}</div>)}</div></Panel>
    </>
  );
}

// ── Live monitor ─────────────────────────────────────────────────────────────
export function LiveMonitor() {
  const positions = useApi('/api/positions');
  const traders = useApi('/api/strategies') || [];
  const nameOf = (id) => traders.find((t) => t.id === id)?.code ?? id;
  const pendRows = (positions?.pendingOrders || []).map((o) => ({ ...o, kind: 'PENDING' }));
  const tradeRows = (positions?.positions || []).map((t) => ({ ...t, kind: t.trailing_active ? 'TRAILING' : t.unrealized_pnl >= 0 ? 'PROFIT' : 'LOSS' }));
  return (
    <>
      <h1>Live Monitor</h1>
      <Panel title={`Open trades (${tradeRows.length}) · Pending orders (${pendRows.length})`}>
        <table>
          <thead><tr><th>Status</th><th>Strategy</th><th>Symbol</th><th>Side</th><th className="r">Entry</th><th className="r">Current</th><th className="r">Target</th><th className="r">Stop</th><th className="r">Trailing</th><th className="r">U-PnL</th><th className="r">ROI</th><th>Age</th></tr></thead>
          <tbody>
            {tradeRows.map((t) => (
              <tr key={t.id}><td><span className={`tag tag-${t.kind === 'TRAILING' ? 'paper' : t.kind === 'PROFIT' ? 'paper' : 'off'}`}>{t.kind}</span></td><td>{nameOf(t.strategy_id)}</td><td>{t.symbol}</td><td className={t.direction === 'LONG' ? 'pos' : 'neg'}>{t.direction}</td><td className="r">{price(t.entry_price)}</td><td className="r">{price(t.current_price)}</td><td className="r">{price(t.target_price)}</td><td className="r">{price(t.stop_loss_price)}</td><td className="r">{t.trailing_active ? price(t.trailing_stop) : '—'}</td><td className={`r ${tone(t.unrealized_pnl)}`}>{inr(t.unrealized_pnl)}</td><td className={`r ${tone(t.roi_pct)}`}>{t.roi_pct != null ? `${t.roi_pct > 0 ? '+' : ''}${t.roi_pct}%` : '—'}</td><td>{Math.round((t.duration_seconds || 0) / 60)}m</td></tr>
            ))}
            {pendRows.map((o) => (
              <tr key={`o${o.id}`} className="pend"><td><span className="tag tag-paper">PENDING</span></td><td>{nameOf(o.strategy_id)}</td><td>{o.symbol}</td><td className={o.direction === 'LONG' ? 'pos' : 'neg'}>{o.direction}</td><td className="r">{price(o.trigger_price)} stop</td><td className="r">—</td><td className="r">—</td><td className="r">—</td><td className="r">—</td><td>working</td></tr>
            ))}
            {!tradeRows.length && !pendRows.length && <tr><td colSpan="11" className="muted">Flat book — nothing live right now.</td></tr>}
          </tbody>
        </table>
      </Panel>
    </>
  );
}

// ── Trade history ────────────────────────────────────────────────────────────
export function TradeHistory() {
  const traders = useApi('/api/strategies') || [];
  const [f, setF] = useState({ strategyId: '', symbol: '', direction: '', result: '', exitReason: '', from: '', to: '', minPnl: '', maxPnl: '' });
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v !== '' && v != null)).toString();
  const data = useApi(`/api/trades?${qs}&limit=200`, 8000);
  const rows = data?.rows || [];
  return (
    <>
      <h1>Trade History</h1>
      <Panel title="Filters" right={<a className="btn small" href={`/api/trades.csv?${qs}`}>Export CSV</a>}>
        <div className="filters">
          <select value={f.strategyId} onChange={(e) => setF({ ...f, strategyId: e.target.value })}><option value="">All strategies</option>{traders.map((t) => <option key={t.id} value={t.id}>{t.code} · {t.key}</option>)}</select>
          <input placeholder="Symbol" value={f.symbol} onChange={(e) => setF({ ...f, symbol: e.target.value })} />
          <select value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })}><option value="">BUY/SELL</option><option value="BUY">BUY</option><option value="SELL">SELL</option></select>
          <select value={f.result} onChange={(e) => setF({ ...f, result: e.target.value })}><option value="">Win/Loss</option><option value="WIN">Win</option><option value="LOSS">Loss</option></select>
          <select value={f.exitReason} onChange={(e) => setF({ ...f, exitReason: e.target.value })}><option value="">Exit reason</option><option>TARGET</option><option>TRAILING_STOP</option><option>STOP_LOSS</option><option>EOD_SQUARE_OFF</option></select>
          <input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
          <input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
          <input placeholder="Min P&L" value={f.minPnl} onChange={(e) => setF({ ...f, minPnl: e.target.value })} />
          <input placeholder="Max P&L" value={f.maxPnl} onChange={(e) => setF({ ...f, maxPnl: e.target.value })} />
        </div>
      </Panel>
      <Panel title={`${rows.length} trades${data?.total != null ? ` of ${data.total}` : ''}`}>
        <table>
          <thead><tr><th>Closed</th><th>Strategy</th><th>Symbol</th><th>Side</th><th className="r">Entry</th><th className="r">Exit</th><th className="r">Qty</th><th className="r">Gross</th><th className="r">Fees</th><th className="r">Net</th><th>Reason</th></tr></thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id}><td>{IST(t.exit_time)}</td><td>{t.strategy_code ?? t.strategy_id}</td><td>{t.symbol}</td><td className={t.direction === 'LONG' ? 'pos' : 'neg'}>{t.direction}</td><td className="r">{price(t.entry_price)}</td><td className="r">{price(t.exit_price)}</td><td className="r">{fnum(t.quantity)}</td><td className={`r ${tone(t.gross_pnl)}`}>{inr(t.gross_pnl)}</td><td className="r">{inr(-t.fees)}</td><td className={`r ${tone(t.net_pnl)}`}>{inr(t.net_pnl)}</td><td>{t.exit_reason}</td></tr>
            ))}
            {!rows.length && <tr><td colSpan="11" className="muted">No trades match</td></tr>}
          </tbody>
        </table>
      </Panel>
    </>
  );
}

// ── Ranking ──────────────────────────────────────────────────────────────────
export function Ranking() {
  const [period, setPeriod] = useState('all');
  const rk = useApi(`/api/ranking?period=${period}`);
  return (
    <>
      <h1>Strategy Ranking</h1>
      <Panel title="By" right={<div className="seg">{['daily', 'weekly', 'monthly', 'all'].map((p) => <button key={p} className={period === p ? 'on' : ''} onClick={() => setPeriod(p)}>{p}</button>)}</div>}>
        <table>
          <thead><tr><th>#</th><th>Strategy</th><th className="r">Score</th><th className="r">Trades</th><th className="r">Win%</th><th className="r">PF</th><th className="r">Max DD</th><th className="r">Net</th><th>Components</th></tr></thead>
          <tbody>
            {(rk?.rows || []).map((r) => (
              <tr key={r.strategy.id}><td>{r.rank}</td><td><a href={`#/strategy/${r.strategy.id}`}>{r.strategy.code} · {r.strategy.key}</a></td><td className="r">{r.score.toFixed(1)}{r.provisional ? ' *' : ''}</td><td className="r">{r.metrics.totalTrades}</td><td className="r">{pct(r.metrics.winRate)}</td><td className="r">{r.metrics.profitFactor === 'Infinity' ? '∞' : Number(r.metrics.profitFactor).toFixed(2)}</td><td className="r">{pct(r.metrics.maxDrawdownPct / 100)}</td><td className={`r ${tone(r.metrics.netPnl)}`}>{inr(r.metrics.netPnl)}</td><td className="muted">{Object.values(r.components || {}).map((v) => Number(v).toFixed(2)).join(' / ')}</td></tr>
            ))}
          </tbody>
        </table>
        <div className="muted small">Composite score combines net P&L (35%), profit factor (25%), win rate (15%), drawdown (15%) and trade count (10%).</div>
      </Panel>
    </>
  );
}

// ── Event log ────────────────────────────────────────────────────────────────
export function EventLog() {
  const traders = useApi('/api/strategies') || [];
  const [sid, setSid] = useState('');
  const events = useApi(`/api/events?limit=200${sid ? `&strategyId=${sid}` : ''}`, 8000) || [];
  return (
    <>
      <h1>Event Log</h1>
      <Panel title="Filter" right={<select value={sid} onChange={(e) => setSid(e.target.value)}><option value="">All strategies</option>{traders.map((t) => <option key={t.id} value={t.id}>{t.code} · {t.key}</option>)}</select>}>
        <div className="events tall">
          {events.map((e) => (
            <div key={e.id}><span className="t">{IST(e.ts)}</span><b>{e.type}</b> {e.message || ''}{e.price != null ? ` @ ${price(e.price)}` : ''}</div>
          ))}
          {!events.length && <div className="muted">No events</div>}
        </div>
      </Panel>
    </>
  );
}

// ── Risk & config ────────────────────────────────────────────────────────────
export function RiskConfig() {
  const c = useApi('/api/config');
  if (!c) return <div className="empty">Loading…</div>;
  const groups = [
    ['Safety', [['Paper trading', c.paperTrading ? 'ON' : 'OFF'], ['Live trading', c.liveTrading ? 'ON' : 'OFF']]],
    ['Risk overlay (NSE traders)', [['Lot size', c.lotSize], ['Min target', `${c.minTarget} ${c.minTargetUnit}`], ['Stop loss cap', `${c.stopLossPercent}%`], ['Trailing', c.trailing?.enabled ? `ON · ${c.trailing.distance}${c.trailing.unit === 'percent' ? '%' : ''} · lock ${c.trailing.lockPctOfTarget}%` : 'OFF']]],
    ['NSE options (ATM CE/PE)', [['Trade options', c.nseTradeOptions ? 'yes' : 'no'], ['Premium stop', `${c.nseOptionRisk?.stopPct}%`], ['Premium min target', `${c.nseOptionRisk?.minTargetPct}%`], ['Premium trail', `${c.nseOptionRisk?.trailPct}%`]]],
    ['Session (IST)', [['Open', c.session?.open], ['Entry cutoff', c.session?.entryCutoff], ['EOD square-off', c.session?.eodSquareOff]]],
    ['Execution', [['Slippage', `${c.slippageBps} bps`], ['Capital / strategy', `$${fnum(c.capitalPerStrategy)}`], ['Max trades / strategy / day', c.maxTradesPerStrategyPerDay], ['Allow duplicates', c.allowDuplicatePositions ? 'yes' : 'no']]],
    ['Gold 24h trader', [['Symbol', c.gold?.symbol], ['Margin', `₹${fnum(c.gold?.marginInr)}`], ['Leverage', `${c.gold?.leverage}×`], ['Stop ceiling', `$${c.gold?.stopRisk}`], ['Min reward:risk', `${c.gold?.minRR}×`], ['Round the clock', c.gold?.roundTheClock ? 'yes' : 'no']]],
    ['ETH 24h trader', [['Symbol', c.eth?.symbol], ['Margin', `₹${fnum(c.eth?.marginInr)}`], ['Leverage', `${c.eth?.leverage}×`], ['Stop ceiling', `$${c.eth?.stopRisk}`], ['Min reward:risk', `${c.eth?.minRR}×`], ['Round the clock', c.eth?.roundTheClock ? 'yes' : 'no']]],
    ['Per-trade SL / TP (gold + ETH)', [['Stop', 'setup invalidation, capped at ATR × ' + (c.riskPlan?.atrStopMult ?? '—')], ['Target', 'nearest structural level paying ≥ ' + (c.riskPlan?.minRR ?? '—') + '×, capped at ' + (c.riskPlan?.maxRR ?? '—') + '×'], ['Skip rule', 'setups that cannot pay are not taken'], ['Max loss / trade', `₹${fnum(c.riskPlan?.maxRiskInr)}`], ['Profit lock', `₹${fnum(c.riskPlan?.profitBookInr)}`]]],
    ['AI gate', [['Mode', c.aiGateMode], ['Configured', c.aiConfigured ? 'yes' : 'no']]],
    ['Ranking', [['Weights (pnl/pf/wr/dd/n)', c.ranking ? Object.values(c.ranking.weights).join(' / ') : '—'], ['Full sample', c.ranking?.fullSampleTrades]]],
    ['Feeds & loops', [['Scan interval', `${c.scanIntervalMinutes} min`], ['Price poll', `${c.pricePollSeconds} s`]]],
  ];
  return (
    <>
      <h1>Risk &amp; Config</h1>
      {groups.map(([title, rows]) => (
        <Panel key={title} title={title}>
          <table className="def"><tbody>{rows.map(([k, v]) => <tr key={k}><td>{k}</td><td className="r">{String(v)}</td></tr>)}</tbody></table>
        </Panel>
      ))}
      <div className="callout">Trailing arms when the target trades; the stop then locks the full target profit and follows the best price. It never loosens. All fills are simulated — no broker is connected.</div>
    </>
  );
}
