export const fnum = (v, d = 0) => (v == null || !Number.isFinite(v) ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
export const money = (v) => (v == null || !Number.isFinite(v) ? '—' : `${v < 0 ? '-' : '+'}$${fnum(Math.abs(v))}`);
export const inr = (v) => (v == null || !Number.isFinite(v) ? '—' : `${v < 0 ? '-' : ''}₹${fnum(Math.abs(v))}`);
export const price = (v) => (v == null || !Number.isFinite(v) ? '—' : fnum(v, 2));
export const pct = (v) => (v == null || !Number.isFinite(v) ? '—' : `${(Number(v) * 100).toFixed(1)}%`);
export const tone = (v) => (v == null ? '' : v > 0 ? 'pos' : v < 0 ? 'neg' : '');
export const IST = (ms) => (ms ? new Date(ms + 5.5 * 3600e3).toISOString().replace('T', ' ').slice(0, 16) : '—');
export const timeIST = (ms = Date.now()) => new Date(ms + 5.5 * 3600e3).toISOString().slice(11, 19);

/** Friendly icon + short label for a strategy, instead of "Strategy-0X". */
export const stratIcon = (nameOrKey) => {
  const s = String(nameOrKey || '').toLowerCase();
  if (/gold|xau/.test(s)) return '🪙';
  if (/eth/.test(s)) return '⚡';
  if (/nse|nifty|heat|broker/.test(s)) return '🏛️';
  if (/pre.?open/.test(s)) return '🌅';
  if (/turnover/.test(s)) return '🔁';
  return '🧩';
};
export const stratLabel = (defOrRow) => {
  const name = defOrRow?.name ?? defOrRow?.strategy_name ?? defOrRow?.strategyName ?? null;
  const key = defOrRow?.key ?? defOrRow?.strategy_key ?? '';
  return `${stratIcon(name || key)} ${name || defOrRow?.strategy_code || defOrRow?.code || '—'}`;
};
