/**
 * Structured logger.
 *
 * Console:  [10:32:14] Strategy-01 SIGNAL BUY RELIANCE @ 1218.90
 * File:     logs/papertrader-YYYY-MM-DD.jsonl, one JSON object per line
 *
 * Times are IST because every market this platform trades is NSE.
 */

import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

const timeFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
});
const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' });

export function istClock(ms = Date.now()) {
    return timeFmt.format(new Date(ms));
}

export class Logger {
    constructor({ level = 'INFO', dir = null, console: toConsole = true, onEvent = null } = {}) {
        this.min = LEVELS[String(level).toUpperCase()] ?? LEVELS.INFO;
        this.dir = dir;
        this.toConsole = toConsole;
        this.onEvent = onEvent;
        this._stream = null;
        this._streamDate = null;
    }

    _file() {
        if (!this.dir) return null;
        const day = dateFmt.format(new Date());
        if (this._streamDate !== day) {
            this._stream?.end();
            fs.mkdirSync(this.dir, { recursive: true });
            this._stream = fs.createWriteStream(path.join(this.dir, `papertrader-${day}.jsonl`), { flags: 'a' });
            this._streamDate = day;
        }
        return this._stream;
    }

    /**
     * @param {'DEBUG'|'INFO'|'WARN'|'ERROR'} level
     * @param {string} actor  e.g. "Strategy-01", "ENGINE", "MARKET"
     * @param {string} event  e.g. "SIGNAL", "PAPER ENTRY", "EXIT TARGET"
     * @param {string} [message]
     * @param {object} [data]
     */
    log(level, actor, event, message = '', data = undefined) {
        if ((LEVELS[level] ?? 0) < this.min) return;
        const ts = Date.now();
        const line = `[${istClock(ts)}] ${actor} ${event}${message ? ` ${message}` : ''}`;
        if (this.toConsole) {
            const out = level === 'ERROR' || level === 'WARN' ? process.stderr : process.stdout;
            out.write(`${line}\n`);
        }
        const rec = { ts: new Date(ts).toISOString(), level, actor, event, message };
        if (data !== undefined) rec.data = data;
        try {
            this._file()?.write(`${JSON.stringify(rec)}\n`);
        } catch {
            /* a full disk must not take trading down */
        }
        try {
            this.onEvent?.(rec);
        } catch {
            /* listener errors are not logging errors */
        }
    }

    debug(actor, event, message, data) { this.log('DEBUG', actor, event, message, data); }
    info(actor, event, message, data) { this.log('INFO', actor, event, message, data); }
    warn(actor, event, message, data) { this.log('WARN', actor, event, message, data); }
    error(actor, event, message, data) { this.log('ERROR', actor, event, message, data); }

    close() {
        this._stream?.end();
        this._stream = null;
    }
}

/** Silent logger for tests. */
export const nullLogger = new Logger({ level: 'ERROR', console: false });
