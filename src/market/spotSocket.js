/**
 * Real-time spot ticker over Delta India's public WebSocket.
 *
 * Channel `ticker` on wss://public-socket.india.delta.exchange publishes a
 * mark_price update every ~5 seconds per symbol. We keep the latest quote in
 * memory and expose it to the engine so unrealized P&L and the dashboard
 * price panels update in real time instead of waiting for the 30s bar poll.
 *
 * Auto-reconnects with backoff; a ping heartbeat keeps the socket alive.
 */

const DEFAULT_URL = 'wss://public-socket.india.delta.exchange';
const SYMBOLS = ['XAUTUSD', 'ETHUSD'];

export class SpotSocket {
    constructor({ url = DEFAULT_URL, symbols = SYMBOLS, logger = null, now = Date.now } = {}) {
        this.url = url;
        this.symbols = symbols;
        this.logger = logger;
        this.now = now;
        this.ws = null;
        this.quotes = new Map();
        this.attempt = 0;
        this.closed = false;
        this.timer = null;
    }

    start() {
        if (this.closed) return;
        try {
            this.ws = new WebSocket(this.url);
        } catch (err) {
            this.logger?.warn('SPOT', 'SOCKET', `connect failed: ${err.message}`);
            this._scheduleReconnect();
            return;
        }
        this.ws.onopen = () => {
            this.attempt = 0;
            this.logger?.info('SPOT', 'CONNECTED', `live ticker socket for ${this.symbols.join(', ')}`);
            this.ws.send(JSON.stringify({ type: 'subscribe', payload: { channels: [{ name: 'ticker', symbols: this.symbols }] } }));
            this._heartbeat();
        };
        this.ws.onmessage = (e) => {
            let msg;
            try { msg = JSON.parse(e.data); } catch { return; }
            if (msg?.type === 'ticker' && Array.isArray(msg.d)) {
                for (const t of msg.d) {
                    const price = Number(t.m);
                    if (t.s && Number.isFinite(price) && price > 0) {
                        this.quotes.set(t.s, { price, ts: this.now() });
                    }
                }
            }
        };
        this.ws.onerror = () => this.logger?.warn('SPOT', 'ERROR', 'ticker socket error');
        this.ws.onclose = () => {
            if (this.closed) return;
            this.logger?.warn('SPOT', 'DISCONNECTED', 'ticker socket closed, reconnecting');
            this._scheduleReconnect();
        };
    }

    _heartbeat() {
        clearInterval(this.timer);
        this.timer = setInterval(() => {
            if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ type: 'ping' }));
        }, 25_000);
        this.timer.unref?.();
    }

    _scheduleReconnect() {
        if (this.closed) return;
        const delay = Math.min(30_000, 5_000 * 2 ** this.attempt++);
        setTimeout(() => this.start(), delay).unref?.();
    }

    /** Latest socket quote for a symbol, or null. */
    quote(symbol) {
        return this.quotes.get(symbol) || null;
    }

    close() {
        this.closed = true;
        clearInterval(this.timer);
        this.ws?.close();
    }
}
