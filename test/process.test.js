// Boots the real entry point as a child process (strategies disabled so the
// test stays offline), checks the dashboard answers, then asks for a graceful
// shutdown over IPC, which is how pm2 / the service wrapper stop it on Windows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT_DIR } from '../src/config.js';

test('process boots, serves the dashboard, and shuts down cleanly on request', { timeout: 60_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-proc-'));
    const env = {
        ...process.env,
        DATABASE_URL: `sqlite:${path.join(dir, 'p.db')}`,
        LOG_DIR: path.join(dir, 'logs'),
        DASHBOARD_PORT: '0',
        LOT_SIZE_SOURCE: 'repo',
        ...Object.fromEntries(['HEATMAP', 'HEATMAP2', 'PREOPEN', 'TURNOVER', 'NSE', 'LEGACY'].map((k) => [`STRATEGY_${k}_ENABLED`, 'false'])),
    };
    delete env.NODE_TEST_CONTEXT; // otherwise the child talks the test-runner protocol on stdout
    const child = fork(path.join(ROOT_DIR, 'src', 'index.js'), [], { cwd: dir, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));

    try {
    const url = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`no dashboard line:\n${out}`)), 30_000);
        const check = () => {
            const m = out.match(/DASHBOARD (http:\/\/\S+)/);
            if (m && /ENGINE START/.test(out)) { clearTimeout(t); resolve(m[1]); } else setTimeout(check, 100);
        };
        check();
    });
    assert.match(out, /PAPER TRADING MODE {2}\| {2}LIVE TRADING DISABLED/);
    const health = await (await fetch(`${url}/api/health`)).json();
    assert.equal(health.running, true);
    assert.equal(health.liveTrading, false);

    const code = await new Promise((resolve) => {
        child.on('exit', (c) => resolve(c));
        child.send('shutdown');
    });
    assert.equal(code, 0, out);
    assert.match(out, /SHUTDOWN clean exit/);
    const logs = fs.readdirSync(path.join(dir, 'logs'));
    assert.ok(logs.some((f) => /^papertrader-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)), 'structured JSONL log written');
    } finally {
        if (child.exitCode === null) child.kill();
    }
});
