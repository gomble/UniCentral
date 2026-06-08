const logBuffer = require('./services/log-buffer');
logBuffer.intercept();

const express = require('express');
const session = require('express-session');
const compression = require('compression');
const http = require('http');
const path = require('path');
const { config } = require('./config');
const { isSetupComplete } = require('./auth');
const { initAgentWebSocket, getConnectedAgents, sendCommandToAgent } = require('./ws/agent-handler');
const SQLiteStore = require('./session-store');

const app = express();
const server = http.createServer(app);

app.set('trust proxy', true);
app.use(compression());
app.use(express.json());

const sessionMiddleware = session({
    store: new SQLiteStore(),
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: false,
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000
    }
});
app.use(sessionMiddleware);

// Serve the noVNC package at its root so that relative imports inside core/
// (e.g. "../vendor/pako/...") resolve correctly.
app.use('/novnc', express.static(path.join(__dirname, '..', 'node_modules', '@novnc', 'novnc')));

app.use((req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/ws/') || req.path.startsWith('/auth')) return next();
    if (req.path === '/login.html' || req.path === '/setup.html') return next();
    if (req.path.startsWith('/css/') || req.path.startsWith('/js/') || req.path.startsWith('/novnc/')) return next();

    if (!isSetupComplete() && req.path !== '/setup.html') {
        return res.redirect('/setup.html');
    }

    if (!req.session || !req.session.authenticated) {
        if (req.path !== '/login.html') return res.redirect('/login.html');
    }

    next();
});

app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) res.setHeader('Content-Type', 'text/html; charset=utf-8');
        else if (filePath.endsWith('.js')) res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        else if (filePath.endsWith('.css')) res.setHeader('Content-Type', 'text/css; charset=utf-8');
    }
}));

// API Routes
app.use('/auth', require('./routes/auth'));
app.use('/api/machines', require('./routes/machines'));
app.use('/api/commands', require('./routes/commands'));
app.use('/api/monitoring', require('./routes/monitoring'));
app.use('/api/deploy', require('./routes/deployment'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/veeam', require('./routes/veeam'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/vnc', require('./routes/vnc-prep'));
app.use('/api/updates', require('./routes/updates'));
app.use('/api/ad', require('./routes/active-directory'));

// Live log stream (SSE)
app.get('/api/logs/stream', (req, res) => {
    if (!req.session || !req.session.authenticated) return res.status(401).end();
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    for (const e of logBuffer.entries.slice(-300)) {
        res.write(`data: ${JSON.stringify(e)}\n\n`);
    }
    const unsub = logBuffer.subscribe(e => res.write(`data: ${JSON.stringify(e)}\n\n`));
    req.on('close', unsub);
});

app.get('/api/logs', (req, res) => {
    if (!req.session || !req.session.authenticated) return res.status(401).end();
    res.json(logBuffer.entries.slice(-300));
});

// Agent version check (used by auto-update)
app.get('/api/agent/version', (req, res) => {
    const pkg = require(path.join(__dirname, '..', 'package.json'));
    const os = req.query.os;
    const arch = req.query.arch;
    const resp = { version: pkg.version };
    if (os && arch) {
        resp.download_url = `${getBaseUrl(req)}/api/agent/download/${os}/${arch}`;
    }
    res.json(resp);
});

// Agent binary download
app.get('/api/agent/download/:os/:arch', (req, res) => {
    const { os, arch } = req.params;
    let filename;
    if (os === 'windows') {
        filename = `unicentral-agent-windows-${arch}.exe`;
    } else if (os === 'linux') {
        filename = `unicentral-agent-linux-${arch}`;
    } else {
        return res.status(400).json({ error: 'Unsupported OS' });
    }

    const filePath = path.join(__dirname, '..', 'releases', filename);
    const fs = require('fs');
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Agent binary not found. Build may still be in progress.' });
    }
    res.download(filePath, filename);
});

// Agent install script
app.get('/api/agent/install-script/:os', (req, res) => {
    const os = req.params.os;
    if (os === 'windows') {
        res.type('text/plain').send(generateWindowsScript(req));
    } else if (os === 'linux') {
        res.type('text/plain').send(generateLinuxScript(req));
    } else {
        res.status(400).json({ error: 'Unsupported OS. Use "windows" or "linux".' });
    }
});

function getBaseUrl(req) {
    if (config.baseUrl) return config.baseUrl;
    return `${req.protocol}://${req.get('host')}`;
}

function generateWindowsScript(req) {
    const baseUrl = getBaseUrl(req);
    const key = req.query.key || '';
    const category = req.query.category || 'client';
    return `$ErrorActionPreference = "Stop"
$Server = "${baseUrl}"
$Key = "${key}"
$Category = "${category}"
if (-not $Key) { $Key = Read-Host "Enter enrollment key" }
$InstallDir = "C:\\Program Files\\UniCentral"
$ConfigDir = "C:\\ProgramData\\UniCentral"

Write-Host "Installing UniCentral Agent..." -ForegroundColor Cyan

# Stop and remove any existing installation first
$svc = Get-Service -Name UniCentralAgent -ErrorAction SilentlyContinue
if ($svc) {
    Write-Host "Stopping existing service..." -ForegroundColor Yellow
    Stop-Service -Name UniCentralAgent -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    if (Test-Path "$InstallDir\\unicentral-agent.exe") {
        & "$InstallDir\\unicentral-agent.exe" --uninstall 2>$null
        Start-Sleep -Seconds 1
    }
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null

Write-Host "Downloading agent binary..." -ForegroundColor Cyan
Invoke-WebRequest -Uri "$Server/api/agent/download/windows/amd64" -OutFile "$InstallDir\\unicentral-agent.exe" -UseBasicParsing

$json = '{"server":"' + $Server + '","enrollment_key":"' + $Key + '","category":"' + $Category + '"}'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText("$ConfigDir\\config.json", $json, $utf8NoBom)

Write-Host "Registering and starting service..." -ForegroundColor Cyan
& "$InstallDir\\unicentral-agent.exe" --install --config "$ConfigDir\\config.json"
Start-Sleep -Seconds 1
Start-Service UniCentralAgent
Start-Sleep -Seconds 3

$svc = Get-Service -Name UniCentralAgent -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq 'Running') {
    Write-Host "UniCentral Agent installed and running!" -ForegroundColor Green
} else {
    Write-Host "WARNING: Service may not be running. Status: $($svc.Status)" -ForegroundColor Red
    Write-Host "Check Event Viewer > Windows Logs > Application for errors." -ForegroundColor Yellow
}
`;
}

function generateLinuxScript(req) {
    const baseUrl = getBaseUrl(req);
    const key = req.query.key || '';
    const category = req.query.category || 'client';
    return `#!/bin/bash
set -euo pipefail
SERVER="${baseUrl}"
KEY="${key}"
CATEGORY="${category}"
if [ -z "$KEY" ]; then read -p "Enter enrollment key: " KEY; fi

echo "[1/5] Detecting architecture..."
ARCH=$(uname -m)
case $ARCH in
    x86_64) ARCH="amd64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac
echo "       Architecture: $ARCH"

echo "[2/5] Stopping existing service (if any)..."
systemctl stop unicentral-agent 2>/dev/null || true
sleep 1

echo "[3/5] Downloading agent binary..."
if ! curl -fsSL "$SERVER/api/agent/download/linux/$ARCH" -o /usr/local/bin/unicentral-agent; then
    echo "ERROR: Download failed. Check server URL and network connectivity."
    exit 1
fi
chmod +x /usr/local/bin/unicentral-agent
echo "       Binary installed."

echo "[4/5] Writing configuration..."
mkdir -p /etc/unicentral

EXISTING_ID=""
EXISTING_SECRET=""
if [ -f /etc/unicentral/config.json ]; then
    EXISTING_ID=$(grep -o '"machine_id"[[:space:]]*:[[:space:]]*"[^"]*"' /etc/unicentral/config.json 2>/dev/null | sed 's/.*"\\([^"]*\\)"$/\\1/' || true)
    EXISTING_SECRET=$(grep -o '"machine_secret"[[:space:]]*:[[:space:]]*"[^"]*"' /etc/unicentral/config.json 2>/dev/null | sed 's/.*"\\([^"]*\\)"$/\\1/' || true)
fi

if [ -n "$EXISTING_ID" ]; then
    echo "       Preserving existing machine identity (\${EXISTING_ID:0:8}...)."
    printf '{"server":"%s","machine_id":"%s","machine_secret":"%s","enrollment_key":"%s","category":"%s"}' \
        "$SERVER" "$EXISTING_ID" "$EXISTING_SECRET" "$KEY" "$CATEGORY" > /etc/unicentral/config.json
else
    printf '{"server":"%s","enrollment_key":"%s","category":"%s"}' \
        "$SERVER" "$KEY" "$CATEGORY" > /etc/unicentral/config.json
fi
chmod 600 /etc/unicentral/config.json

cat > /etc/systemd/system/unicentral-agent.service <<'SVCEOF'
[Unit]
Description=UniCentral Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/unicentral-agent --config /etc/unicentral/config.json
Restart=always
RestartSec=5
StartLimitIntervalSec=0
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SVCEOF

echo "[5/5] Starting service..."
systemctl daemon-reload
systemctl enable unicentral-agent
systemctl start unicentral-agent
sleep 2

if systemctl is-active --quiet unicentral-agent; then
    echo ""
    echo "UniCentral Agent installed and running!"
    echo "Logs: journalctl -u unicentral-agent -f"
else
    echo ""
    echo "ERROR: Service failed to start. Last log lines:"
    journalctl -u unicentral-agent -n 20 --no-pager || true
    exit 1
fi
`;
}

// Initialize WebSocket for agent connections
initAgentWebSocket(server, sessionMiddleware);

// Start notification engine
const notificationEngine = require('./services/notification-engine');
notificationEngine.start();

// Start Veeam poller
const veeamPoller = require('./services/veeam-poller');
veeamPoller.start();

// Start update scheduler
const updateScheduler = require('./services/update-scheduler');
updateScheduler.start(sendCommandToAgent);

// Start server
server.listen(config.port, () => {
    console.log(`[UniCentral] Server running on port ${config.port}`);
    if (!isSetupComplete()) {
        console.log('[UniCentral] First-run setup required - visit the web interface');
    }
});
