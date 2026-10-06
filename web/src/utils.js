export const fnum = (v, d = 0) => (v == null || !Number.isFinite(v) ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
export const money = (v) => (v == null || !Number.isFinite(v) ? '—' : `${v < 0 ? '-' : '+'}$${fnum(Math.abs(v))}`);
export const inr = (v) => (v == null || !Number.isFinite(v) ? '—' : `${v < 0 ? '-' : ''}₹${fnum(Math.abs(v))}`);
export const price = (v) => (v == null || !Number.isFinite(v) ? '—' : fnum(v, 2));
export const pct = (v) => (v == null || !Number.isFinite(v) ? '—' : `${(Number(v) * 100).toFixed(1)}%`);
export const tone = (v) => (v == null ? '' : v > 0 ? 'pos' : v < 0 ? 'neg' : '');
export const IST = (ms) => (ms ? new Date(ms + 5.5 * 3600e3).toISOString().replace('T', ' ').slice(0, 16) : '—');
export const timeIST = (ms = Date.now()) => new Date(ms + 5.5 * 3600e3).toISOString().slice(11, 19);
