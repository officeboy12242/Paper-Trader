/**
 * Dashboard HTTP server (node:http, no framework).
 *
 * Read-only JSON API plus one write: enable/disable a strategy. API keys are
 * never serialised; /api/config returns `publicConfig()` only.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const CSV_COLUMNS = [
    ['id', 'Trade #'], ['strategy_code', 'Strategy code'], ['strategy_name', 'Strategy'], ['strategy_key', 'Source key'], ['strategy_source', 'Original source'],
    ['session_date', 'Session'], ['symbol', 'Symbol'], ['direction', 'Direction'], ['lots', 'Lots'], ['lot_size', 'Lot size'], ['quantity', 'Quantity'],
    ['entry_price', 'Entry'], ['entry_time', 'Entry time'], ['source_entry', 'Source entry'], ['target_price', 'Target'], ['source_target', 'Source target'],
    ['stop_loss_price', 'Final stop'], ['initial_stop', 'Initial stop'], ['hard_stop', '5% hard stop'], ['source_stop', 'Source stop'],
    ['trailing_active', 'Trailing activated'], ['exit_price', 'Exit'], ['exit_time', 'Exit time'], ['exit_reason', 'Exit reason'],
    ['gross_pnl', 'Gross P&L'], ['fees', 'Fees'], ['net_pnl', 'Net P&L'], ['holding_seconds', 'Holding (s)'], ['status', 'Status'], ['filter_condition', 'Filter / condition'],
];

const isoOrBlank = (ms) => (ms ? new Date(ms).toISOString() : '');

export function tradesToCsv(rows) {
    const esc = (v) => {
        const s = v == null ? '' : String(v);
        return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [CSV_COLUMNS.map(([, h]) => esc(h)).join(',')];
    for (const r of rows) {
        lines.push(CSV_COLUMNS.map(([k]) => esc(k.endsWith('_time') ? isoOrBlank(r[k]) : r[k])).join(','));
    }
    return `${lines.join('\r\n')}\r\n`;
}

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
    const data = type.startsWith('application/json') ? JSON.stringify(body, (k, v) => (v === Infinity ? 'Infinity' : v)) : body;
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
    res.end(data);
}

function filtersFrom(q) {
    const f = {};
    for (const k of ['strategyId', 'symbol', 'direction', 'result', 'from', 'to', 'exitReason', 'minPnl', 'maxPnl', 'status', 'limit', 'offset']) {
        const v = q.get(k);
        if (v !== null && v !== '') f[k] = v;
    }
    if (f.direction === 'BUY') f.direction = 'LONG';
    if (f.direction === 'SELL') f.direction = 'SHORT';
    return f;
}

/**
 * @param {import('../engine/engine.js').Engine} engine
 * @param {{ host?: string, port?: number }} opts
 */
export function createServer(engine, { host = '127.0.0.1', port = 8080 } = {}) {
    const routes = {
        '/api/health': () => engine.health(),
        '/api/config': () => engine.publicConfig(),
        '/api/overview': () => engine.overview(),
        '/api/strategies': () => engine.traderViews(),
        '/api/positions': () => ({
            positions: engine.positions.openPositionsView(),
            pendingOrders: engine.db.pendingOrders().map((o) => {
                const t = engine.traders.find((x) => x.id === o.strategy_id);
                return { ...o, strategy_code: t?.code ?? null, strategy_name: t?.def?.name ?? null, strategyId: o.strategy_id, key: t?.def?.key ?? '' };
            }),
        }),
        '/api/events': (q) => engine.db.listEvents({ limit: Math.min(1000, Number(q.get('limit')) || 200), strategyId: q.get('strategyId') ? Number(q.get('strategyId')) : null }),
        '/api/signals': (q) => engine.db.listSignals({ strategyId: q.get('strategyId') ? Number(q.get('strategyId')) : null, sessionDate: q.get('date') || null, limit: Math.min(2000, Number(q.get('limit')) || 200) }),
        '/api/ranking': (q) => engine.ranking(q.get('period') || 'all'),
        '/api/trades': (q) => engine.db.searchTrades(filtersFrom(q)),
        '/api/gold/quote': () => engine.goldQuote(),
        '/api/eth/quote': () => engine.ethQuote(),
        '/api/gold/bars': async () => {
            try {
                const bars = await engine.marketData.getBars('XAUUSD', { continuous: true, range: '1d' });
                return bars.slice(-180);
            } catch {
                return [];
            }
        },
        '/api/eth/bars': async () => {
            try {
                const bars = await engine.marketData.getBars('ETHUSD', { continuous: true, range: '1d' });
                return bars.slice(-180);
            } catch {
                return [];
            }
        },
    };

    const server = http.createServer((req, res) => {
        try {
            const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
            const p = url.pathname;

            if (req.method === 'POST') {
                // Same-origin only: the toggle must not be triggerable from another site.
                const origin = req.headers.origin;
                if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'cross-origin request refused' });
                const m = p.match(/^\/api\/strategies\/(\d+)\/(enable|disable)$/);
                if (!m) {
                    const ex = p.match(/^\/api\/positions\/(\d+)\/exit$/);
                    if (ex) {
                        try {
                            const r = engine.positions.exitNow(Number(ex[1]));
                            return r.ok ? send(res, 200, r) : send(res, r.reason === 'trade not open' ? 404 : 400, r);
                        } catch (err) {
                            engine.logger.error('WEB', 'ERROR', String(err?.stack || err));
                            return send(res, 500, { error: 'internal error' });
                        }
                    }
                    if (p === '/api/positions/exit-all') {
                        try {
                            const r = engine.positions.exitAll();
                            return send(res, 200, r);
                        } catch (err) {
                            engine.logger.error('WEB', 'ERROR', String(err?.stack || err));
                            return send(res, 500, { error: 'internal error' });
                        }
                    }
                    if (p === '/api/admin/clearbook') {
                        let raw = '';
                        req.on('data', (chunk) => { raw += chunk; });
                        req.on('end', () => {
                            let password = '';
                            try { password = JSON.parse(raw || '{}').password || ''; } catch {}
                            const expected = engine.cfg?.CLEAR_DB_PASSWORD || '';
                            if (!expected) return send(res, 403, { error: 'CLEAR_DB_PASSWORD is not set — wipe disabled' });
                            if (String(password) !== expected) return send(res, 401, { error: 'wrong password' });
                            try {
                                const r = engine.clearBook();
                                return send(res, 200, { ok: true, ...r });
                            } catch (err) {
                                engine.logger.error('WEB', 'ERROR', String(err?.stack || err));
                                return send(res, 500, { error: 'internal error' });
                            }
                        });
                        return;
                    }
                    return send(res, 404, { error: 'not found' });
                }
                const s = engine.setEnabled(Number(m[1]), m[2] === 'enable');
                return s ? send(res, 200, s) : send(res, 404, { error: 'unknown strategy' });
            }
            if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });

            if (routes[p]) {
                const out = routes[p](url.searchParams);
                if (out && typeof out.then === 'function') {
                    out.then((o) => send(res, 200, o)).catch((err) => { engine.logger.error('WEB', 'ERROR', String(err?.stack || err)); send(res, 500, { error: 'internal error' }); });
                    return;
                }
                return send(res, 200, out);
            }
            const detail = p.match(/^\/api\/strategies\/(\d+)$/);
            if (detail) {
                const d = engine.strategyDetail(Number(detail[1]));
                return d ? send(res, 200, d) : send(res, 404, { error: 'unknown strategy' });
            }
            if (p === '/api/trades.csv') {
                const { rows } = engine.db.searchTrades({ ...filtersFrom(url.searchParams), limit: 5000 });
                return send(res, 200, tradesToCsv(rows), 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="paper-trades-${new Date().toISOString().slice(0, 10)}.csv"` });
            }
            if (p.startsWith('/api/')) return send(res, 404, { error: 'not found' });

            // Static files (single-page app, hash routing).
            const rel = p === '/' ? 'app/index.html' : p.replace(/^\/+/, '');
            const file = path.normalize(path.join(PUBLIC_DIR, rel));
            if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'forbidden', 'text/plain');
            fs.readFile(file, (err, buf) => {
                if (err) return send(res, 404, 'not found', 'text/plain');
                // Never cache the UI shell: the browser must always pick up the latest build.
                res.setHeader('Cache-Control', 'no-store');
                send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream');
            });
        } catch (err) {
            engine.logger.error('WEB', 'ERROR', String(err?.stack || err));
            send(res, 500, { error: 'internal error' });
        }
    });

    return {
        server,
        listen: () =>
            new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(port, host, () => {
                    const addr = server.address();
                    resolve(`http://${addr.address}:${addr.port}`);
                });
            }),
        // Browser tabs hold keep-alive sockets; without dropping them close() never returns.
        close: () =>
            new Promise((resolve) => {
                server.close(() => resolve());
                server.closeIdleConnections?.();
                setTimeout(() => server.closeAllConnections?.(), 2000).unref();
            }),
    };
}
