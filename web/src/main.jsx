import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { fnum,  inr, price, pct, tone, IST, timeIST } from './utils.js';
import { AreaChart, DayBars } from './charts.jsx';
import { StrategyDetail, LiveMonitor, TradeHistory, Ranking, EventLog, RiskConfig } from './pages.jsx';

// ── utils ────────────────────────────────────────────────────────────────────
function useApi(path, ms = 5000) {
  const [data, setData] = useState(null);
  useEffect(() => {
    let on = true;
    const pull = () => fetch(path).then((r) => (r.ok ? r.json() : Promise.reject(r.status))).then((j) => on && setData(j)).catch(() => {});
    pull();
    const t = setInterval(pull, ms);
    return () => { on = false; clearInterval(t); };
  }, [path, ms]);
  return data;
}
function useTick(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

// ── layout parts ─────────────────────────────────────────────────────────────
const NAV = [
  ['#/', 'Dashboard'],
  ['#/monitor', 'Live Monitor'],
  ['#/history', 'Trade History'],
  ['#/ranking', 'Ranking'],
  ['#/logs', 'Event Log'],
  ['#/config', 'Risk & Config'],
];

function TopBar({ overview, health, route }) {
  const now = useTick();
  const ph = overview?.session;
  return (
    <>
      <header className="topbar">
        <div className="brand">PAPER<em>TRADER</em></div>
        <div className="badges">
          <span className="tag tag-paper">● PAPER MODE</span>
          <span className="tag tag-off">LIVE OFF</span>
        </div>
        <div className="spacer" />
        <div className={`phase ${ph?.phase === 'OPEN' ? 'on' : ''}`}>{ph ? (ph.tradingDay ? ph.phase.replaceAll('_', ' ') : 'CLOSED') : '…'}</div>
        <div className="clock">{timeIST(now)} IST</div>
        <div className={`dot ${(health?.status || 'FAIL').toLowerCase()}`} title={health ? `feed ${health.marketData.state} · db ${health.database.ok ? 'ok' : 'down'}` : ''} />
      </header>
      <nav className="tabs">
        {NAV.map(([href, label]) => (
          <a key={href} href={href} className={route === href.slice(1) ? 'on' : ''}>{label}</a>
        ))}
      </nav>
    </>
  );
}

function CryptoHero({ title, quotePath, barsPath, color }) {
  const quote = useApi(quotePath);
  const bars = useApi(barsPath, 15000);
  const change = bars?.length > 1 ? bars[bars.length - 1].close - bars[0].close : null;
  const pctChg = bars?.length > 1 ? change / bars[0].close : null;
  return (
    <section className="hero" style={{ '--c': color }}>
      <div className="hero-left">
        <div className="sym">{title} <span className="feed">SPOT · Delta India · 1m</span></div>
        <div className="big" style={{ color }}>{`$${price(quote?.price)}`}</div>
        <div className={`chg ${tone(change)}`}>{change != null ? `${change >= 0 ? '+' : ''}${change.toFixed(2)} (${(pctChg * 100).toFixed(2)}%)` : '—'} <span className="muted">day</span></div>
        <div className="chips">
          <span className="chip">Margin ₹{quote ? fnum(quote.marginInr) : '—'}</span>
          <span className="chip">Leverage {quote?.leverage ?? '—'}×</span>
          <span className="chip" title="Hard ceiling on stop distance — each trade's actual stop is set from its own setup">SL ≤ ${quote?.stopRisk ?? '—'}</span>
          <span className="chip" title="Target must pay at least this many times the risk, else the setup is skipped">R:R ≥ {quote?.minRR ?? '—'}×</span>
          <span className={`chip ${quote?.stale ? 'stale' : 'live'}`}>{quote?.stale ? 'STALE' : '● LIVE'}</span>
        </div>
      </div>
      <div className="hero-right">
        <AreaChart points={(bars || []).map((b) => ({ v: b.close, ts: b.ts }))} color={color} />
        <div className="axis"><span>{bars?.length ? IST(bars[0].ts) : ''}</span><span>last {(bars?.length || 0)} bars · ${price(bars?.[bars.length - 1]?.close)}</span></div>
      </div>
    </section>
  );
}

function Stat({ label, value, t }) {
  return <div className="stat"><div className={`v ${t || ''}`}>{value}</div><div className="l">{label}</div></div>;
}

function StrategyCard({ t }) {
  const now = useTick();
  const gold = String(t.key).startsWith('gold_');
  const eth = String(t.key).startsWith('eth_');
  const pos = t.positions?.[t.positions.length - 1];
  const cd = t.nextScanAt ? Math.max(0, t.nextScanAt - now) : null;
  const cdText = cd == null ? (t.statusDetail || '') : cd <= 0 ? 'scanning…' : `next scan ${Math.floor(cd / 60000)}m ${String(Math.floor((cd % 60000) / 1000)).padStart(2, '0')}s`;
  return (
    <article className={`scard ${gold ? 'gold' : ''} ${eth ? 'eth' : ''}`}>
      <header>
        <span className="nm">{gold ? '🪙 ' : eth ? '⚡ ' : ''}{t.name}</span>
        <span className={`st st-${t.status}`}>{t.status}</span>
      </header>
      <div className="cd">{cdText}</div>
      <div className="mini">
        <div><b className={tone(t.metrics?.netPnl)}>{inr(t.metrics?.netPnl)}</b><i>all-time</i></div>
        <div><b className={tone(t.today?.netPnl)}>{inr(t.today?.netPnl)}</b><i>today</i></div>
        <div><b>{t.metrics?.totalTrades ?? 0}</b><i>trades</i></div>
        <div><b>{t.metrics?.winRate != null ? pct(t.metrics.winRate) : '—'}</b><i>winrate</i></div>
      </div>
      <div className="posline">
        {pos ? (
          <>
            <span className={pos.direction === 'LONG' ? 'pos' : 'neg'}>{pos.direction === 'LONG' ? '▲' : '▼'} {pos.symbol}</span>
            <span className={tone(pos.unrealized_pnl)}> {gold || eth ? inr(pos.unrealized_pnl) : inr(pos.unrealized_pnl)}{pos.roi_pct != null ? ` (${pos.roi_pct > 0 ? '+' : ''}${pos.roi_pct}%)` : ''}</span>
            <span className="muted"> · SL {price(pos.stop_loss_price)} · TP {price(pos.target_price)}{pos.trailing_active ? ' · 🔄' : ''}</span>
          </>
        ) : <span className="muted">FLAT</span>}
      </div>
      <a href={`#/strategy/${t.id}`}>detail →</a>
    </article>
  );
}

const Panel = ({ title, children, right }) => (
  <section className="panel">
    <header><h3>{title}</h3>{right}</header>
    {children}
  </section>
);

function FloatingPrices() {
  const gold = useApi('/api/gold/quote');
  const eth = useApi('/api/eth/quote');
  const [pos, setPos] = useState({ x: 16, y: 120 });
  const [min, setMin] = useState(false);
  const drag = React.useRef(null);

  const onDown = (e) => {
    drag.current = { ox: e.clientX - pos.x, oy: e.clientY - pos.y };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e) => {
    if (!drag.current) return;
    setPos({ x: e.clientX - drag.current.ox, y: e.clientY - drag.current.oy });
  };
  const onUp = () => { drag.current = null; };

  if (min) {
    return (
      <div className="float-dot" style={{ left: pos.x, top: pos.y }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onClick={() => setMin(false)} title="Show live prices">
        🪙
      </div>
    );
  }
  return (
    <div className="float-px" style={{ left: pos.x, top: pos.y }}>
      <div className="fp-head" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
        <span>● LIVE PRICES</span>
        <button onPointerDown={(e) => e.stopPropagation()} onClick={() => setMin(true)} title="Minimize">–</button>
      </div>
      <div className="fp-row"><span className="fp-sym">🪙 XAUUSD</span><b>${price(gold?.price)}</b></div>
      <div className="fp-row"><span className="fp-sym">⚡ ETHUSD</span><b>${price(eth?.price)}</b></div>
    </div>
  );
}

function Dashboard() {
  const overview = useApi('/api/overview');
  const traders = useApi('/api/strategies') || [];
  const positions = useApi('/api/positions');
  const rk = useApi('/api/ranking?period=all');
  const events = useApi('/api/events?limit=25');
  const a = overview?.all;
  const goldTs = traders.filter((t) => String(t.key).startsWith('gold_'));
  const ethTs = traders.filter((t) => String(t.key).startsWith('eth_'));
  const nseTs = traders.filter((t) => !String(t.key).startsWith('gold_') && !String(t.key).startsWith('eth_'));
  return (
    <>
        <CryptoHero title="XAUTUSD" quotePath="/api/gold/quote" barsPath="/api/gold/bars" color="#f0b41e" />
        <CryptoHero title="ETHUSD" quotePath="/api/eth/quote" barsPath="/api/eth/bars" color="#627eea" />
        <div className="stats">
          <Stat label="Total P&L" value={inr(a?.netPnl)} t={tone(a?.netPnl)} />
          <Stat label="Today" value={inr(overview?.today?.netPnl)} t={tone(overview?.today?.netPnl)} />
          <Stat label="Unrealized" value={inr(overview?.unrealizedPnl)} t={tone(overview?.unrealizedPnl)} />
          <Stat label="Trades" value={a?.totalTrades ?? '—'} />
          <Stat label="Win rate" value={a?.winRate != null ? pct(a.winRate) : '—'} />
          <Stat label="Profit factor" value={a?.profitFactor != null ? (a.profitFactor === 'Infinity' ? '∞' : Number(a.profitFactor).toFixed(2)) : '—'} />
          <Stat label="Max DD" value={a ? inr(-a.maxDrawdown) : '—'} t={a?.maxDrawdown ? 'neg' : ''} />
          <Stat label="Open" value={`${overview?.activePositions ?? 0} · ${overview?.pendingOrders ?? 0} pend`} />
        </div>
        <div className="panels" style={{ marginTop: 12 }}>
          <Panel title="Indian NSE — live trades P&L">
            <table>
              <thead><tr><th>Scope</th><th className="r">Trades</th><th className="r">Win rate</th><th className="r">Net P&L</th><th className="r">Fees</th><th className="r">Max DD</th></tr></thead>
              <tbody>
                {[
                  ['Today', overview?.byVenue?.nse?.today],
                  ['This week', overview?.byVenue?.nse?.weekly],
                  ['This month', overview?.byVenue?.nse?.monthly],
                  ['All-time', overview?.byVenue?.nse?.all],
                ].map(([label, m]) => (
                  <tr key={label}>
                    <td>{label}</td>
                    <td className="r">{m?.totalTrades ?? '—'}</td>
                    <td className="r">{m?.winRate != null ? pct(m.winRate) : '—'}</td>
                    <td className={`r ${tone(m?.netPnl)}`}>{m?.netPnl != null ? inr(m.netPnl) : '—'}</td>
                    <td className="r">{m?.fees != null ? inr(m.fees) : '—'}</td>
                    <td className={`r ${m?.maxDrawdown ? 'neg' : ''}`}>{m ? inr(-m.maxDrawdown) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
          <Panel title="Gold · ETH (24h) — live trades P&L">
            <table>
              <thead><tr><th>Scope</th><th className="r">Trades</th><th className="r">Win rate</th><th className="r">Net P&L</th><th className="r">Fees</th><th className="r">Max DD</th></tr></thead>
              <tbody>
                {[
                  ['Today', ['gold', 'eth'].map((v) => overview?.byVenue?.[v]?.today)],
                  ['This week', ['gold', 'eth'].map((v) => overview?.byVenue?.[v]?.weekly)],
                  ['This month', ['gold', 'eth'].map((v) => overview?.byVenue?.[v]?.monthly)],
                  ['All-time', ['gold', 'eth'].map((v) => overview?.byVenue?.[v]?.all)],
                ].map(([label, ms]) => {
                  const totals = (ms || []).filter(Boolean);
                  const trades = totals.reduce((s, m) => s + (m.totalTrades || 0), 0);
                  const net = totals.reduce((s, m) => s + (m.netPnl || 0), 0);
                  const fees = totals.reduce((s, m) => s + (m.fees || 0), 0);
                  const wins = totals.reduce((s, m) => s + Math.round((m.winRate || 0) * (m.totalTrades || 0)) / 100, 0);
                  const dd = totals.reduce((s, m) => Math.max(s, m.maxDrawdown || 0), 0);
                  return (
                    <tr key={label}>
                      <td>{label}</td>
                      <td className="r">{totals.length ? trades : '—'}</td>
                      <td className="r">{totals.length && trades ? pct((wins / trades) * 100) : '—'}</td>
                      <td className={`r ${tone(net)}`}>{totals.length ? inr(net) : '—'}</td>
                      <td className="r">{totals.length ? inr(fees) : '—'}</td>
                      <td className={`r ${dd ? 'neg' : ''}`}>{totals.length ? inr(-dd) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Panel>
        </div>
        <div className="cols">
          <div className="col">
            <Panel title="Gold · 24h strategies"><div className="cards gold">{goldTs.map((t) => <StrategyCard key={t.id} t={t} />)}</div></Panel>
            <Panel title="ETH · 24h strategies"><div className="cards eth" style={{ borderColor: '#627eea33' }}>{ethTs.map((t) => <StrategyCard key={t.id} t={t} />)}</div></Panel>
            <Panel title="NSE paper strategies"><div className="cards">{nseTs.map((t) => <StrategyCard key={t.id} t={t} />)}</div></Panel>
          </div>
          <div className="col">
            <Panel title="Positions & working orders">
              <table>
                <thead><tr><th>Strategy</th><th>Symbol</th><th>Side</th><th className="r">Entry</th><th className="r">Mark</th><th className="r">SL</th><th className="r">TP</th><th className="r">U-PnL</th><th>Age</th><th></th></tr></thead>
                <tbody>
                  {(positions?.positions || []).map((p) => (
                    <tr key={p.id}>
                      <td>{p.strategy_code ?? p.strategyId}</td><td>{p.symbol}</td>
                      <td className={p.direction === 'LONG' ? 'pos' : 'neg'}>{p.direction}</td>
                      <td className="r">{price(p.entry_price)}</td><td className="r">{price(p.current_price)}</td>
                      <td className="r">{price(p.stop_loss_price)}{p.trailing_active ? ' 🔄' : ''}</td><td className="r">{price(p.target_price)}</td>
                      <td className={`r ${tone(p.unrealized_pnl)}`}>{inr(p.unrealized_pnl)}{p.roi_pct != null ? ` ≈${p.roi_pct}%` : ''}</td>
                      <td>{Math.round((p.duration_seconds || 0) / 60)}m</td>
                      <td className="r"><button className="btn danger" onClick={async () => { await fetch(`/api/positions/${p.id}/exit`, { method: 'POST' }); location.reload(); }}>Exit</button></td>
                    </tr>
                  ))}
                  {(positions?.pendingOrders || []).map((o) => (
                    <tr key={`o${o.id}`} className="pend">
                      <td>{o.strategy_code ?? o.strategyId}</td><td>{o.symbol}</td>
                      <td className={o.direction === 'LONG' ? 'pos' : 'neg'}>{o.direction}</td>
                      <td className="r">{price(o.trigger_price)} (stop)</td><td className="r">—</td><td className="r">—</td><td className="r">—</td><td className="r">—</td><td>working</td><td></td>
                    </tr>
                  ))}
                  {!positions?.positions?.length && !positions?.pendingOrders?.length && <tr><td colSpan="10" className="muted">Flat book — no open positions or working orders.</td></tr>}
                </tbody>
              </table>
            </Panel>
            <div className="two">
              <Panel title="Equity curve"><AreaChart points={(overview?.equity || []).map((e) => ({ v: e.equity }))} color="#2aa4e0" /></Panel>
              <Panel title="Daily net P&L"><DayBars rows={overview?.dailyPnl} /></Panel>
            </div>
            <div className="two">
              <Panel title="Strategy ranking">
                <table>
                  <thead><tr><th>#</th><th>Strategy</th><th className="r">Score</th><th className="r">Trades</th><th className="r">Win%</th><th className="r">Net</th></tr></thead>
                  <tbody>
                    {(rk?.rows || []).slice(0, 9).map((r) => (
                      <tr key={r.strategy.id}><td>{r.rank}</td><td>{r.strategy.code} · {r.strategy.key}</td><td className="r">{r.score.toFixed(1)}{r.provisional ? ' *' : ''}</td><td className="r">{r.metrics.totalTrades}</td><td className="r">{pct(r.metrics.winRate)}</td><td className={`r ${tone(r.metrics.netPnl)}`}>{inr(r.metrics.netPnl)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </Panel>
              <Panel title="Event log">
                <div className="events">
                  {(events || []).map((e) => (
                    <div key={e.id}><span className="t">{IST(e.ts)}</span><b>{e.type}</b> {e.message || ''}</div>
                  ))}
                  {!events?.length && <div className="muted">No events yet</div>}
                </div>
              </Panel>
            </div>
          </div>
        </div>
        <footer>Simulated only · No broker · Gold feed: XAUTUSD spot (Delta Exchange India)</footer>
    </>
  );
}

function route() {
  const h = (location.hash || '#/').replace(/^#/, '');
  return h || '/';
}

export default function App() {
  const [r, setR] = useState(route());
  useEffect(() => {
    const on = () => setR(route());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const overview = useApi('/api/overview');
  const health = useApi('/api/health');
  const strategyMatch = r.match(/^\/strategy\/(\d+)$/);
  const active = r === '/' ? '/' : r.startsWith('/monitor') ? '/monitor' : r.startsWith('/history') ? '/history' : r.startsWith('/ranking') ? '/ranking' : r.startsWith('/logs') ? '/logs' : r.startsWith('/config') ? '/config' : '';
  return (
    <>
      <TopBar overview={overview} health={health} route={active} />
      <FloatingPrices />
      <main>
        {r === '/' && <Dashboard />}
        {r.startsWith('/monitor') && <LiveMonitor />}
        {r.startsWith('/history') && <TradeHistory />}
        {r.startsWith('/ranking') && <Ranking />}
        {r.startsWith('/logs') && <EventLog />}
        {r.startsWith('/config') && <RiskConfig />}
        {strategyMatch && <StrategyDetail id={strategyMatch[1]} />}
      </main>
    </>
  );
}

createRoot(document.getElementById('root')).render(<App />);
