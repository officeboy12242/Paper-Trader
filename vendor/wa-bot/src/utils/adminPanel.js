/**
 * Admin Panel Server
 * Web-based admin panel for QR code authentication and session management
 */

import http from 'http';
import os from 'os';
import crypto from 'crypto';
import zlib from 'zlib';
import { URL } from 'url';
import { logger } from './logger.js';
import { botTelemetry } from './botTelemetry.js';
import { getCyberDashboardHtml } from '../dashboard/cyberGirlyDashboard.js';
import DashboardService from '../services/DashboardService.js';
import { learnPublicBaseFromRequest } from './publicBaseUrl.js';

/**
 * Get comprehensive system metrics
 */
function getSystemMetrics() {
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    
    // Calculate CPU usage (average across all cores)
    let totalIdle = 0;
    let totalTick = 0;
    for (const cpu of cpus) {
        for (const type in cpu.times) {
            totalTick += cpu.times[type];
        }
        totalIdle += cpu.times.idle;
    }
    const cpuUsagePercent = ((1 - totalIdle / totalTick) * 100).toFixed(1);
    
    // Process memory
    const processMemory = process.memoryUsage();
    
    // Uptime formatting
    const uptimeSecs = process.uptime();
    const days = Math.floor(uptimeSecs / 86400);
    const hours = Math.floor((uptimeSecs % 86400) / 3600);
    const mins = Math.floor((uptimeSecs % 3600) / 60);
    const secs = Math.floor(uptimeSecs % 60);
    const uptimeFormatted = days > 0 
        ? `${days}d ${hours}h ${mins}m ${secs}s`
        : hours > 0 
        ? `${hours}h ${mins}m ${secs}s`
        : `${mins}m ${secs}s`;

    return {
        // OS Information
        os: {
            platform: os.platform(),
            type: os.type(),
            release: os.release(),
            arch: os.arch(),
            hostname: os.hostname(),
        },
        
        // CPU Information
        cpu: {
            model: cpus[0]?.model || 'Unknown',
            cores: cpus.length,
            speed_mhz: cpus[0]?.speed || 0,
            usage_percent: parseFloat(cpuUsagePercent),
        },
        
        // System Memory
        memory: {
            total_mb: Math.round(totalMem / 1024 / 1024),
            used_mb: Math.round(usedMem / 1024 / 1024),
            free_mb: Math.round(freeMem / 1024 / 1024),
            usage_percent: parseFloat(((usedMem / totalMem) * 100).toFixed(1)),
        },
        
        // Process Memory
        process_memory: {
            rss_mb: Math.round(processMemory.rss / 1024 / 1024),
            heap_total_mb: Math.round(processMemory.heapTotal / 1024 / 1024),
            heap_used_mb: Math.round(processMemory.heapUsed / 1024 / 1024),
            external_mb: Math.round(processMemory.external / 1024 / 1024),
        },
        
        // Uptime
        uptime: {
            seconds: Math.floor(uptimeSecs),
            formatted: uptimeFormatted,
        },
        
        // Load Average (Unix only, returns [0,0,0] on Windows)
        load_average: os.loadavg().map(l => parseFloat(l.toFixed(2))),
        
        // Node.js Info
        node: {
            version: process.version,
            pid: process.pid,
        },
        
        // Network Interfaces (first non-internal IPv4)
        network: Object.entries(os.networkInterfaces())
            .flatMap(([name, interfaces]) => 
                (interfaces || [])
                    .filter(i => i.family === 'IPv4' && !i.internal)
                    .map(i => ({ interface: name, address: i.address }))
            ).slice(0, 2),
    };
}

class AdminPanel {
    constructor(port = 3000) {
        this.port = port;
        this.server = null;
        this.qrCode = null;
        this.qrCodeText = null;
        this.connectionStatus = 'disconnected';
        this.connectedPhone = null;
        this.authDatabase = null;
        this.whatsappService = null;
        this.shortLinkService = null;
        this.adminToken = process.env.ADMIN_TOKEN || 'sassy123';
        this.lastActivity = new Date();
        this.dashboardService = null;
        /** @type {Set<import('http').ServerResponse>} */
        this._sseClients = new Set();
        this._sseUnsub = null;
        this._sseDirty = false;
        this._sseTickTimer = null;
        /** @type {{ etag: string, body: Buffer }|null} */
        this._dashHtmlCache = null;
    }

    _wantsGzip(req) {
        return String(req.headers['accept-encoding'] || '').includes('gzip');
    }

    /** Send body with optional gzip; sets Content-Length. */
    _sendBody(req, res, status, headers, body) {
        const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
        const outHeaders = { ...headers };
        if (this._wantsGzip(req) && buf.length > 512) {
            const gz = zlib.gzipSync(buf);
            outHeaders['Content-Encoding'] = 'gzip';
            outHeaders.Vary = outHeaders.Vary
                ? `${outHeaders.Vary}, Accept-Encoding`
                : 'Accept-Encoding';
            outHeaders['Content-Length'] = gz.length;
            res.writeHead(status, outHeaders);
            res.end(gz);
            return;
        }
        outHeaders['Content-Length'] = buf.length;
        res.writeHead(status, outHeaders);
        res.end(buf);
    }

    _dashboardHtmlPack() {
        if (this._dashHtmlCache) return this._dashHtmlCache;
        const body = Buffer.from(getCyberDashboardHtml(), 'utf8');
        const etag = `W/"dash-${crypto.createHash('sha1').update(body).digest('hex').slice(0, 16)}"`;
        this._dashHtmlCache = { etag, body };
        return this._dashHtmlCache;
    }

    setDashboardService(service) {
        this.dashboardService = service;
    }

    setDashboardContext({ mongoDb, groupManager, botState, jobQueue } = {}) {
        this.dashboardService = new DashboardService({
            mongoDb,
            groupManager,
            adminPanel: this,
            botState,
            jobQueue: jobQueue || null,
        });
        if (!this._sseUnsub) {
            this._sseUnsub = botTelemetry.subscribe((ev) => this._broadcastSse(ev));
        }
    }

    _broadcastSse(_ev) {
        // Coalesce bursts into one light tick (~2s) instead of shipping every event.
        this._sseDirty = true;
        if (this._sseTickTimer) return;
        this._sseTickTimer = setTimeout(() => {
            this._sseTickTimer = null;
            if (!this._sseDirty) return;
            this._sseDirty = false;
            this.dashboardService?.invalidateSnapshotCache?.();
            const payload = `data: ${JSON.stringify({ type: 'tick', at: new Date().toISOString() })}\n\n`;
            for (const res of this._sseClients) {
                try {
                    res.write(payload);
                } catch {
                    this._sseClients.delete(res);
                }
            }
        }, 2000);
    }

    /** Strip phones / raw JIDs for the public board. */
    _publicEvent(ev = {}) {
        const out = { ...ev };
        delete out.chatId;
        delete out.phone;
        delete out.userId;
        delete out.senderJid;
        if (out.query) out.query = String(out.query).slice(0, 80);
        if (out.title) out.title = String(out.title).slice(0, 120);
        if (out.message) out.message = String(out.message).slice(0, 120);
        return out;
    }

    _sanitizePublicSnapshot(snap) {
        const s = structuredClone ? structuredClone(snap) : JSON.parse(JSON.stringify(snap));
        if (s.connection) {
            s.connection = {
                status: s.connection.status || 'unknown',
                phone: null,
            };
        }
        s.uptime = process.uptime();
        if (s.live?.recent) {
            s.live.recent = s.live.recent.map((ev) => this._publicEvent(ev));
        }
        if (s.content?.recentCourses) {
            s.content.recentCourses = s.content.recentCourses.map((c) => ({
                name: c.name,
                at: c.at,
            }));
        }
        if (s.content?.recentNews) {
            s.content.recentNews = s.content.recentNews.map((n) => ({
                title: n.title,
                at: n.at,
            }));
        }
        if (s.groups?.ranked) {
            s.groups.ranked = s.groups.ranked.map((g) => ({
                name: g.name,
                score: g.score,
                chat: g.chat,
                movie: g.movie,
                course: g.course,
                news: g.news,
                reasons: g.reasons,
                flags: g.flags,
            }));
        }
        return s;
    }

    setAuthDatabase(authDB) {
        this.authDatabase = authDB;
    }

    setWhatsAppService(waService) {
        this.whatsappService = waService;
    }

    setShortLinkService(shortLinkService) {
        this.shortLinkService = shortLinkService;
    }

    updateQR(qr, qrText = null) {
        this.qrCode = qr;
        this.qrCodeText = qrText;
        this.connectionStatus = 'waiting_for_scan';
        this.lastActivity = new Date();
    }

    clearQR() {
        this.qrCode = null;
        this.qrCodeText = null;
    }

    setConnected(phoneNumber) {
        this.connectionStatus = 'connected';
        this.connectedPhone = phoneNumber;
        this.qrCode = null;
        this.qrCodeText = null;
        this.lastActivity = new Date();
    }

    setDisconnected() {
        this.connectionStatus = 'disconnected';
        this.connectedPhone = null;
        this.lastActivity = new Date();
    }

    _verifyToken(req) {
        const url = new URL(req.url, `http://localhost:${this.port}`);
        const token = url.searchParams.get('token');
        return token === this.adminToken;
    }

    _getAdminHTML() {
        const statusColor = this.connectionStatus === 'connected' ? '#4CAF50' 
            : this.connectionStatus === 'waiting_for_scan' ? '#FF9800' : '#f44336';
        
        const statusText = this.connectionStatus === 'connected' 
            ? `✅ Connected (${this.connectedPhone || 'Unknown'})` 
            : this.connectionStatus === 'waiting_for_scan' 
            ? '📱 Waiting for QR Scan...' 
            : '❌ Disconnected';

        const qrSection = this.qrCode 
            ? `<div class="qr-container">
                <h3>📱 Scan QR Code with WhatsApp</h3>
                <div class="qr-code">
                    <img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(this.qrCodeText || '')}" alt="QR Code" />
                </div>
                <p class="hint">WhatsApp → Settings → Linked Devices → Link a Device</p>
               </div>`
            : this.connectionStatus === 'connected'
            ? `<div class="connected-box">
                <h3>✅ Bot is Connected!</h3>
                <p>Phone: ${this.connectedPhone || 'Unknown'}</p>
               </div>`
            : `<div class="disconnected-box">
                <h3>⏳ Waiting for Connection...</h3>
                <p>Restart the bot or clear auth to get a new QR code</p>
               </div>`;

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Sassy Bot Admin Panel</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            min-height: 100vh;
            color: #fff;
            padding: 20px;
        }
        .container {
            max-width: 600px;
            margin: 0 auto;
        }
        .header {
            text-align: center;
            padding: 30px 0;
        }
        .header h1 {
            font-size: 2.5em;
            margin-bottom: 10px;
        }
        .header p { color: #888; }
        .status-card {
            background: rgba(255,255,255,0.1);
            border-radius: 15px;
            padding: 20px;
            margin-bottom: 20px;
            backdrop-filter: blur(10px);
        }
        .status-indicator {
            display: flex;
            align-items: center;
            gap: 10px;
            font-size: 1.2em;
        }
        .status-dot {
            width: 15px;
            height: 15px;
            border-radius: 50%;
            background: ${statusColor};
            animation: ${this.connectionStatus === 'waiting_for_scan' ? 'pulse 1.5s infinite' : 'none'};
        }
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
        .qr-container, .connected-box, .disconnected-box {
            background: rgba(255,255,255,0.05);
            border-radius: 15px;
            padding: 30px;
            text-align: center;
            margin-bottom: 20px;
        }
        .qr-code {
            background: #fff;
            padding: 20px;
            border-radius: 10px;
            display: inline-block;
            margin: 20px 0;
        }
        .qr-code img { display: block; }
        .hint { color: #888; font-size: 0.9em; }
        .connected-box { border: 2px solid #4CAF50; }
        .connected-box h3 { color: #4CAF50; }
        .disconnected-box { border: 2px solid #f44336; }
        .actions {
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
        }
        .btn {
            flex: 1;
            min-width: 120px;
            padding: 15px 25px;
            border: none;
            border-radius: 10px;
            font-size: 1em;
            cursor: pointer;
            transition: transform 0.2s, opacity 0.2s;
        }
        .btn:hover { transform: translateY(-2px); }
        .btn:active { transform: translateY(0); }
        .btn-danger {
            background: linear-gradient(135deg, #f44336, #e91e63);
            color: #fff;
        }
        .btn-primary {
            background: linear-gradient(135deg, #2196F3, #03A9F4);
            color: #fff;
        }
        .btn-success {
            background: linear-gradient(135deg, #4CAF50, #8BC34A);
            color: #fff;
        }
        .info-card {
            background: rgba(255,255,255,0.05);
            border-radius: 10px;
            padding: 15px;
            margin-top: 20px;
            font-size: 0.85em;
            color: #888;
        }
        .info-card p { margin: 5px 0; }
        .loading {
            display: none;
            text-align: center;
            padding: 20px;
        }
        .spinner {
            border: 3px solid rgba(255,255,255,0.1);
            border-top: 3px solid #fff;
            border-radius: 50%;
            width: 30px;
            height: 30px;
            animation: spin 1s linear infinite;
            margin: 0 auto 10px;
        }
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        .alert {
            padding: 15px;
            border-radius: 10px;
            margin-bottom: 20px;
            display: none;
        }
        .alert-success { background: rgba(76, 175, 80, 0.2); border: 1px solid #4CAF50; }
        .alert-error { background: rgba(244, 67, 54, 0.2); border: 1px solid #f44336; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🤖 Sassy Bot</h1>
            <p>Admin Control Panel</p>
            <p style="margin-top:12px"><a href="/dashboard" style="color:#ff7ae5;font-weight:700;text-decoration:none">💫 Open public Mission Control →</a></p>
        </div>

        <div id="alert" class="alert"></div>

        <div class="status-card">
            <div class="status-indicator">
                <div class="status-dot"></div>
                <span>${statusText}</span>
            </div>
        </div>

        ${qrSection}

        <div class="status-card">
            <h3 style="margin-bottom: 15px;">⚙️ Actions</h3>
            <div class="actions">
                <button class="btn btn-primary" onclick="refreshPage()">🔄 Refresh</button>
                <button class="btn btn-danger" onclick="clearAuth()">🗑️ Clear Session</button>
            </div>
        </div>

        <div id="loading" class="loading">
            <div class="spinner"></div>
            <p>Processing...</p>
        </div>

        <div class="status-card">
            <h3 style="margin-bottom: 15px;">📊 System Metrics</h3>
            <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; font-size: 0.9em;">
                <div style="background: rgba(255,255,255,0.05); padding: 12px; border-radius: 8px;">
                    <div style="color: #888; font-size: 0.8em;">CPU Usage</div>
                    <div style="font-size: 1.3em; color: #4CAF50;">${(() => { const m = getSystemMetrics(); return m.cpu.usage_percent; })()}%</div>
                </div>
                <div style="background: rgba(255,255,255,0.05); padding: 12px; border-radius: 8px;">
                    <div style="color: #888; font-size: 0.8em;">Memory Usage</div>
                    <div style="font-size: 1.3em; color: #2196F3;">${(() => { const m = getSystemMetrics(); return m.memory.usage_percent; })()}%</div>
                </div>
                <div style="background: rgba(255,255,255,0.05); padding: 12px; border-radius: 8px;">
                    <div style="color: #888; font-size: 0.8em;">Process Memory</div>
                    <div style="font-size: 1.3em; color: #FF9800;">${(() => { const m = getSystemMetrics(); return m.process_memory.rss_mb; })()} MB</div>
                </div>
                <div style="background: rgba(255,255,255,0.05); padding: 12px; border-radius: 8px;">
                    <div style="color: #888; font-size: 0.8em;">Uptime</div>
                    <div style="font-size: 1.3em; color: #9C27B0;">${(() => { const m = getSystemMetrics(); return m.uptime.formatted; })()}</div>
                </div>
            </div>
        </div>

        <div class="info-card">
            <p>🖥️ Platform: ${os.platform()} (${os.arch()}) | Node ${process.version}</p>
            <p>🕐 Last Activity: ${this.lastActivity.toLocaleString()}</p>
            <p>💡 Tip: Clear session if you see "Bad MAC" errors</p>
            <p>📡 Endpoints: <code>/health</code> <code>/ping</code> <code>/metrics</code></p>
        </div>
    </div>

    <script>
        const token = new URLSearchParams(window.location.search).get('token');
        
        function showAlert(message, type) {
            const alert = document.getElementById('alert');
            alert.textContent = message;
            alert.className = 'alert alert-' + type;
            alert.style.display = 'block';
            setTimeout(() => alert.style.display = 'none', 5000);
        }

        function showLoading(show) {
            document.getElementById('loading').style.display = show ? 'block' : 'none';
        }

        function refreshPage() {
            window.location.reload();
        }

        async function clearAuth() {
            if (!confirm('⚠️ This will disconnect the bot and require a new QR scan. Continue?')) return;
            
            showLoading(true);
            try {
                const res = await fetch('/api/clear-auth?token=' + token, { method: 'POST' });
                const data = await res.json();
                if (data.success) {
                    showAlert('✅ Session cleared! QR code will appear in a few seconds...', 'success');
                    setTimeout(() => window.location.reload(), 3000);
                } else {
                    showAlert('❌ ' + (data.error || 'Failed to clear session'), 'error');
                }
            } catch (e) {
                showAlert('❌ Error: ' + e.message, 'error');
            }
            showLoading(false);
        }

        // Auto-refresh every 10 seconds if waiting for QR scan
        ${this.connectionStatus === 'waiting_for_scan' ? 'setTimeout(() => window.location.reload(), 10000);' : ''}
    </script>
</body>
</html>`;
    }

    start() {
        this.server = http.createServer(async (req, res) => {
            // Remember public Host from Koyeb/Render proxy so movie /d/ links
            // don't need a PUBLIC_URL env var.
            learnPublicBaseFromRequest(req);

            const url = new URL(req.url, `http://localhost:${this.port}`);
            const pathname = url.pathname;

            // Health check (no auth required) - detailed system metrics for Koyeb/Render
            if (pathname === '/health' || pathname === '/') {
                const metrics = getSystemMetrics();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: 'ok',
                    service: 'WhatsApp Course Bot',
                    timestamp: new Date().toISOString(),
                    
                    // Bot Status
                    bot: {
                        connection: this.connectionStatus,
                        phone: this.connectedPhone || null,
                        has_qr: !!this.qrCode,
                    },
                    
                    // System Metrics
                    system: metrics,
                    
                    // Quick Summary
                    summary: {
                        cpu_usage: `${metrics.cpu.usage_percent}%`,
                        memory_usage: `${metrics.memory.usage_percent}%`,
                        process_memory: `${metrics.process_memory.rss_mb} MB`,
                        uptime: metrics.uptime.formatted,
                        platform: `${metrics.os.platform} (${metrics.os.arch})`,
                    }
                }, null, 2));
                return;
            }
            
            // Cool ping endpoint with ASCII art
            if (pathname === '/ping') {
                const metrics = getSystemMetrics();
                const statusEmoji = this.connectionStatus === 'connected' ? '🟢' : '🔴';
                const asciiArt = `
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║     ███████╗ █████╗ ███████╗███████╗██╗   ██╗            ║
║     ██╔════╝██╔══██╗██╔════╝██╔════╝╚██╗ ██╔╝            ║
║     ███████╗███████║███████╗███████╗ ╚████╔╝             ║
║     ╚════██║██╔══██║╚════██║╚════██║  ╚██╔╝              ║
║     ███████║██║  ██║███████║███████║   ██║               ║
║     ╚══════╝╚═╝  ╚═╝╚══════╝╚══════╝   ╚═╝               ║
║                    🤖 BOT                                 ║
╠═══════════════════════════════════════════════════════════╣
║  STATUS    │ ${statusEmoji} ${this.connectionStatus.toUpperCase().padEnd(42)}║
║  PHONE     │ ${(this.connectedPhone || 'Not connected').padEnd(44)}║
║  UPTIME    │ ${metrics.uptime.formatted.padEnd(44)}║
║  CPU       │ ${(metrics.cpu.usage_percent + '%').padEnd(44)}║
║  MEMORY    │ ${(metrics.memory.usage_percent + '% (' + metrics.process_memory.rss_mb + ' MB)').padEnd(44)}║
║  PLATFORM  │ ${(metrics.os.platform + ' ' + metrics.os.arch).padEnd(44)}║
║  NODE      │ ${metrics.node.version.padEnd(44)}║
╠═══════════════════════════════════════════════════════════╣
║  🏓 PONG! Server is alive and kicking!                    ║
║  ⏰ ${new Date().toISOString().padEnd(52)}║
╚═══════════════════════════════════════════════════════════╝
`;
                res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end(asciiArt);
                return;
            }

            // Short link redirect (no auth — public movie download links)
            if (pathname.startsWith('/d/')) {
                // Tolerate mangling from WhatsApp's autolinker / manual retyping:
                //   - %-decoded path (a pasted URL ending in an encoded char can
                //     truncate mid-%-sequence, e.g. "…%2" or a stray %20)
                //   - trailing punctuation, parens, dots, and comma/semicolon
                //     tail-splits that capture apps glue onto the URL
                //   - spaces/CR/LF that leaked into the segment
                // Codes are base64url only, so anything else is noise.
                const rawCode = decodeURIComponent(pathname.slice(3).split('/')[0] || '');
                const code = rawCode.replace(/[^A-Za-z0-9_-]/g, '');
                if (!this.shortLinkService) {
                    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
                    res.end('Short links not ready');
                    return;
                }
                try {
                    const longUrl = await this.shortLinkService.resolve(code);
                    if (!longUrl) {
                        res.writeHead(410, { 'Content-Type': 'text/plain; charset=utf-8' });
                        res.end('⏰ This link has expired (links last 7 hours). Search again with /movie');
                        return;
                    }
                    // 302 Location must be a valid absolute URL — server pages
                    // sometimes embed filenames with raw spaces/unicode. If the
                    // URL can't be normalized, fall back to a meta-refresh page
                    // (browsers tolerate odd characters in an href attribute).
                    let safe = null;
                    try {
                        safe = new URL(String(longUrl).trim().replace(/[\u0000-\u001f\u007f]/g, '')).href;
                    } catch {
                        try { safe = new URL(encodeURI(String(longUrl).trim())).href; } catch { safe = null; }
                    }
                    if (safe) {
                        res.writeHead(302, { Location: safe });
                        res.end();
                    } else {
                        const esc = String(longUrl).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
                        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end(`<meta http-equiv="refresh" content="0; url='${esc}'"><p>Redirecting… <a href="${esc}">click here</a> if nothing happens.</p>`);
                    }
                } catch (err) {
                    logger.error(`Short link redirect error: ${err.message}`);
                    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                    res.end('Redirect failed');
                }
                return;
            }

            // Admin panel
            if (pathname === '/admin') {
                if (!this._verifyToken(req)) {
                    res.writeHead(401, { 'Content-Type': 'text/html' });
                    res.end(`
                        <html><body style="font-family:sans-serif;text-align:center;padding:50px;">
                        <h1>🔒 Access Denied</h1>
                        <p>Add ?token=YOUR_ADMIN_TOKEN to the URL</p>
                        </body></html>
                    `);
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(this._getAdminHTML());
                return;
            }

            // Mission-control dashboard — PUBLIC (no token)
            if (pathname === '/dashboard' || pathname === '/dash') {
                const pack = this._dashboardHtmlPack();
                const inm = String(req.headers['if-none-match'] || '');
                if (inm && inm === pack.etag) {
                    res.writeHead(304, {
                        ETag: pack.etag,
                        'Cache-Control': 'public, max-age=60',
                    });
                    res.end();
                    return;
                }
                this._sendBody(
                    req,
                    res,
                    200,
                    {
                        'Content-Type': 'text/html; charset=utf-8',
                        ETag: pack.etag,
                        'Cache-Control': 'public, max-age=60',
                    },
                    pack.body
                );
                return;
            }

            if (pathname === '/api/dashboard/snapshot') {
                try {
                    if (!this.dashboardService) {
                        res.writeHead(503, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Dashboard not ready' }));
                        return;
                    }
                    const snap = await this.dashboardService.getCachedSnapshot();
                    const publicSnap = this._sanitizePublicSnapshot(snap);
                    const etag = `W/"snap-${publicSnap.at || snap.at}"`;
                    const inm = String(req.headers['if-none-match'] || '');
                    if (inm && inm === etag) {
                        res.writeHead(304, {
                            ETag: etag,
                            'Cache-Control': 'private, no-cache',
                        });
                        res.end();
                        return;
                    }
                    this._sendBody(
                        req,
                        res,
                        200,
                        {
                            'Content-Type': 'application/json; charset=utf-8',
                            ETag: etag,
                            'Cache-Control': 'private, no-cache',
                        },
                        JSON.stringify(publicSnap)
                    );
                } catch (err) {
                    logger.error(`Dashboard snapshot failed: ${err.message}`);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: err.message }));
                }
                return;
            }

            if (pathname === '/api/dashboard/stream') {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive',
                    'Access-Control-Allow-Origin': '*',
                });
                res.write(`data: ${JSON.stringify({ type: 'hello', at: new Date().toISOString() })}\n\n`);
                this._sseClients.add(res);
                const ping = setInterval(() => {
                    try {
                        res.write(`data: ${JSON.stringify({ type: 'ping', at: new Date().toISOString() })}\n\n`);
                    } catch {
                        clearInterval(ping);
                        this._sseClients.delete(res);
                    }
                }, 30000);
                req.on('close', () => {
                    clearInterval(ping);
                    this._sseClients.delete(res);
                });
                return;
            }

            // API: Bypass diagnostics — per-hop fetch status for one link
            // (why did this hubdrive/hubcloud link fail to resolve?)
            if (pathname === '/debug/bypass' && req.method === 'GET') {
                if (!this._verifyToken(req)) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Unauthorized' }));
                    return;
                }
                const target = url.searchParams.get('url');
                if (!target) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'add ?url=<link>' }));
                    return;
                }
                try {
                    const { debugResolve } = await import('../services/HdHubBypassService.js');
                    const report = await debugResolve(target, 9_000);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(report, null, 2));
                } catch (e) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: String(e?.message || e) }));
                }
                return;
            }

            // API: Get detailed metrics (for monitoring dashboards)
            if (pathname === '/api/metrics' || pathname === '/metrics') {
                const metrics = getSystemMetrics();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    timestamp: new Date().toISOString(),
                    bot_status: this.connectionStatus,
                    bot_phone: this.connectedPhone,
                    ...metrics
                }, null, 2));
                return;
            }

            // API: Get status
            if (pathname === '/api/status') {
                if (!this._verifyToken(req)) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Unauthorized' }));
                    return;
                }
                const metrics = getSystemMetrics();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: this.connectionStatus,
                    phone: this.connectedPhone,
                    hasQR: !!this.qrCode,
                    uptime: process.uptime(),
                    system: metrics.summary || {}
                }));
                return;
            }

            // API: Clear auth
            if (pathname === '/api/clear-auth' && req.method === 'POST') {
                if (!this._verifyToken(req)) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Unauthorized' }));
                    return;
                }

                try {
                    if (this.authDatabase) {
                        await this.authDatabase.clearAll();
                        this.setDisconnected();
                        logger.info('🗑️ Auth cleared via admin panel');
                        
                        // Trigger reconnect to get new QR code
                        if (this.whatsappService) {
                            logger.info('🔄 Triggering reconnect for new QR code...');
                            // Close existing socket and reconnect
                            try {
                                if (this.whatsappService.sock) {
                                    this.whatsappService.sock.end();
                                }
                            } catch (e) {
                                // Ignore close errors
                            }
                            // Small delay then reconnect
                            setTimeout(() => {
                                this.whatsappService.connect().catch(err => {
                                    logger.error('Reconnect error:', err.message);
                                });
                            }, 1000);
                        }
                        
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, message: 'Auth cleared. New QR code will appear shortly.' }));
                    } else {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: 'Auth database not available' }));
                    }
                } catch (e) {
                    logger.error('Clear auth error:', e.message);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: e.message }));
                }
                return;
            }

            // 404 for everything else
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
        });

        this.server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                logger.warn(`⚠️ Port ${this.port} already in use — admin panel skipped`);
            } else {
                logger.error(`Admin panel server error: ${err.message}`);
            }
        });

        this.server.listen(this.port, '0.0.0.0', () => {
            logger.info(`🏥 Admin panel listening on 0.0.0.0:${this.port}`);
            logger.info(`🔗 Admin URL: http://localhost:${this.port}/admin?token=${this.adminToken}`);
            logger.info(`💫 Public dashboard: http://localhost:${this.port}/dashboard`);
        });

        return this.server;
    }

    stop() {
        if (this.server) {
            this.server.close();
        }
    }
}

export default AdminPanel;
