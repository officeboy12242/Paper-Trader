/**
 * Logger Utility
 * Centralized logging configuration
 */

import pino from 'pino';

const logLevel = process.env.LOG_LEVEL || 'info';

/**
 * Render any thrown value as something a human can act on.
 *
 * `${err.message}` is the reflex, but plenty of things reach a catch block
 * without a `message`: Baileys rejects with Boom objects and raw protocol nodes,
 * libraries throw strings, and `Promise.reject({ status })` is common. Those all
 * logged the literal word "undefined", which is worse than no log at all — it
 * says a failure happened and refuses to say what.
 *
 * @param {unknown} err
 * @returns {string}
 */
export function describeError(err) {
    if (err == null) {
        return 'no error object (something rejected with null/undefined)';
    }
    if (typeof err === 'string') {
        return err;
    }
    if (err instanceof Error && err.message) {
        // Boom and friends hide the useful part in extra fields.
        const status = err.output?.statusCode ?? err.status ?? err.statusCode;
        const code = err.code ?? err.data?.reason;
        const extra = [status && `status ${status}`, code && `code ${code}`].filter(Boolean).join(', ');
        return extra ? `${err.message} (${extra})` : err.message;
    }
    if (typeof err === 'object') {
        const parts = [
            err.message,
            err.reason,
            err.error,
            err.output?.payload?.error,
            err.output?.statusCode && `status ${err.output.statusCode}`,
            err.status && `status ${err.status}`,
            err.code && `code ${err.code}`,
            err.attrs?.type && `type ${err.attrs.type}`,
        ]
            .filter((v) => v != null && v !== '')
            .map(String);
        if (parts.length) {
            return parts.join(', ');
        }
        try {
            const json = JSON.stringify(err);
            if (json && json !== '{}') return json.slice(0, 300);
        } catch {
            /* circular — fall through */
        }
        return `${err.constructor?.name || 'object'} with no message`;
    }
    return String(err);
}

export const logger = pino({ 
    level: logLevel,
    transport: {
        targets: [
            {
                target: 'pino-pretty',
                options: {
                    colorize: true,
                    ignore: 'pid,hostname',
                    translateTime: 'yyyy-mm-dd HH:MM:ss'
                },
                level: logLevel
            },
            {
                target: 'pino/file',
                options: { 
                    destination: './bot.log',
                    mkdir: true
                },
                level: logLevel
            }
        ]
    }
});
