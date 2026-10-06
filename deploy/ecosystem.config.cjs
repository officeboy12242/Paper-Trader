// pm2 process file (Windows, Linux, macOS).
//   npm i -g pm2
//   pm2 start deploy/ecosystem.config.cjs
//   pm2 save && pm2 startup        (Linux: boot persistence)
//   pm2 stop papertrader           (graceful: sends a 'shutdown' message)
const path = require('node:path');

module.exports = {
    apps: [
        {
            name: 'papertrader',
            cwd: path.resolve(__dirname, '..'),
            script: 'src/index.js',
            instances: 1, // one engine per database; never run two against the same file
            exec_mode: 'fork',
            autorestart: true,
            restart_delay: 5000,
            exp_backoff_restart_delay: 2000,
            max_memory_restart: '600M',
            kill_timeout: 30000,
            shutdown_with_message: true, // Windows has no SIGTERM; index.js listens for 'shutdown'
            out_file: 'logs/pm2-out.log',
            error_file: 'logs/pm2-err.log',
            time: true,
            env: { NODE_ENV: 'production' },
        },
    ],
};
