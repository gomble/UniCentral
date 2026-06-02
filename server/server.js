const express = require('express');
const session = require('express-session');
const compression = require('compression');
const http = require('http');
const path = require('path');
const { config } = require('./config');
const { isSetupComplete } = require('./auth');
const { initAgentWebSocket } = require('./ws/agent-handler');

const app = express();
const server = http.createServer(app);

app.set('trust proxy', true);
app.use(compression());
app.use(express.json());

const sessionMiddleware = session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production' && !!config.baseUrl,
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000
    }
});
app.use(sessionMiddleware);

app.use((req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/ws/') || req.path.startsWith('/auth')) return next();
    if (req.path === '/login.html' || req.path === '/setup.html') return next();
    if (req.path.startsWith('/css/') || req.path.startsWith('/js/')) return next();

    if (!isSetupComplete() && req.path !== '/setup.html') {
        return res.redirect('/setup.html');
    }

    if (!req.session || !req.session.authenticated) {
        if (req.path !== '/login.html') return res.redirect('/login.html');
    }

    next();
});

app.use(express.static(path.join(__dirname, 'public')));

// API Routes
app.use('/auth', require('./routes/auth'));
app.use('/api/machines', require('./routes/machines'));
app.use('/api/commands', require('./routes/commands'));
app.use('/api/monitoring', require('./routes/monitoring'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/veeam', require('./routes/veeam'));
app.use('/api/settings', require('./routes/settings'));

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

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null

Invoke-WebRequest -Uri "$Server/api/agent/download/windows/amd64" -OutFile "$InstallDir\\unicentral-agent.exe" -UseBasicParsing

@{server=$Server;enrollment_key=$Key;category=$Category} | ConvertTo-Json | Set-Content "$ConfigDir\\config.json"

& "$InstallDir\\unicentral-agent.exe" --install --config "$ConfigDir\\config.json"
Start-Service UniCentralAgent

Write-Host "UniCentral Agent installed and running!" -ForegroundColor Green
`;
}

function generateLinuxScript(req) {
    const baseUrl = getBaseUrl(req);
    const key = req.query.key || '';
    const category = req.query.category || 'client';
    return `#!/bin/bash
set -e
SERVER="${baseUrl}"
KEY="${key}"
CATEGORY="${category}"
if [ -z "$KEY" ]; then read -p "Enter enrollment key: " KEY; fi

echo "Installing UniCentral Agent..."

ARCH=$(uname -m)
case $ARCH in
    x86_64) ARCH="amd64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

curl -sL "$SERVER/api/agent/download/linux/$ARCH" -o /usr/local/bin/unicentral-agent
chmod +x /usr/local/bin/unicentral-agent

mkdir -p /etc/unicentral
cat > /etc/unicentral/config.json <<EOF
{"server": "$SERVER", "enrollment_key": "$KEY", "category": "$CATEGORY"}
EOF
chmod 600 /etc/unicentral/config.json

# Create systemd service
cat > /etc/systemd/system/unicentral-agent.service <<EOF
[Unit]
Description=UniCentral Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/unicentral-agent --config /etc/unicentral/config.json
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable unicentral-agent
systemctl start unicentral-agent

echo "UniCentral Agent installed and running!"
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

// Start server
server.listen(config.port, () => {
    console.log(`[UniCentral] Server running on port ${config.port}`);
    if (!isSetupComplete()) {
        console.log('[UniCentral] First-run setup required - visit the web interface');
    }
});
