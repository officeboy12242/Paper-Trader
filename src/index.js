/**
 * PaperTrader entry point. PAPER TRADING ONLY, LIVE TRADING DISABLED.
 *
 * Import order matters: config.js must load before any vendored WA-BOT module
 * because it normalises LOG_LEVEL for the vendor's pino logger.
 */

import { loadConfig, ensureDirs } from './config.js';
import { Logger } from './logger.js';
import { Database } from './db/database.js';
import { openMongoDatabase } from './db/mongoDatabase.js';
import { Engine } from './engine/engine.js';
import { createServer } from './web/server.js';

const cfg = loadConfig();
ensureDirs(cfg);
const logger = new Logger({ level: cfg.LOG_LEVEL, dir: cfg.LOG_DIR });

logger.info('SYSTEM', 'BOOT', '==============================================');
logger.info('SYSTEM', 'BOOT', 'PAPER TRADING MODE  |  LIVE TRADING DISABLED');
logger.info('SYSTEM', 'BOOT', `lot size ${cfg.LOT_SIZE} · min target ${cfg.MIN_TARGET} ${cfg.MIN_TARGET_UNIT} · max stop ${cfg.STOP_LOSS_PERCENT}% · trailing ${cfg.TRAILING_ENABLED ? 'ENABLED' : 'DISABLED'}`);
logger.info('SYSTEM', 'BOOT', '==============================================');
logger.info('SYSTEM', 'BOOT', `DB backend: ${cfg.DB_BACKEND}${cfg.DB_BACKEND === 'mongo' ? ` @ ${cfg.MONGODB_URI ? cfg.MONGODB_DB : ''}` : ` (${cfg.DATABASE_PATH})`}`);

let db;
if (cfg.DB_BACKEND === 'mongo') {
    db = await openMongoDatabase({ uri: cfg.MONGODB_URI, dbName: cfg.MONGODB_DB, logger });
} else {
    db = new Database(cfg.DATABASE_PATH);
}
const engine = new Engine({ cfg, db, logger });
await engine.prepare();
engine.init();
const web = createServer(engine, { host: cfg.DASHBOARD_HOST, port: cfg.DASHBOARD_PORT });

let shuttingDown = false;
async function shutdown(signal, code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('SYSTEM', 'SHUTDOWN', `received ${signal}`);
    const force = setTimeout(() => process.exit(code || 1), 30_000);
    force.unref();
    try {
        await engine.stop();
        await web.close();
        db.close();
        logger.info('SYSTEM', 'SHUTDOWN', 'clean exit');
    } catch (err) {
        logger.error('SYSTEM', 'SHUTDOWN', String(err?.stack || err));
    } finally {
        logger.close();
        process.exit(code);
    }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGBREAK', () => shutdown('SIGBREAK')); // Windows console close
// Windows has no SIGTERM between processes; pm2 (shutdown_with_message) and the
// service wrapper ask for a clean stop over IPC instead.
process.on('message', (msg) => {
    if (msg === 'shutdown' || msg?.type === 'shutdown') shutdown('IPC shutdown');
});
process.on('unhandledRejection', (err) => logger.error('SYSTEM', 'UNHANDLED REJECTION', String(err?.stack || err)));
process.on('uncaughtException', (err) => {
    logger.error('SYSTEM', 'UNCAUGHT EXCEPTION', String(err?.stack || err));
    // State is in SQLite; exit non-zero so the process manager restarts us cleanly.
    shutdown('uncaughtException', 1);
});

try {
    const url = await web.listen();
    logger.info('SYSTEM', 'DASHBOARD', url);
    await engine.start();
} catch (err) {
    logger.error('SYSTEM', 'STARTUP FAILED', String(err?.stack || err));
    await shutdown('startup failure', 1);
}
