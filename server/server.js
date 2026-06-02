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

app.use(compression());
app.use(express.json());

const sessionMiddleware = session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000
    }
});
app.use(sessionMiddleware);

app.use((req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/ws/')) return next();
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
app.use('/api/settings', require('./routes/settings'));

// Agent download endpoint
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

function generateWindowsScript(req) {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    return `# UniCentral Agent Installer for Windows
$ErrorActionPreference = "Stop"
$Token = $args[0]
if (-not $Token) { $Token = Read-Host "Enter registration token" }
$InstallDir = "C:\\Program Files\\UniCentral"
$ConfigDir = "C:\\ProgramData\\UniCentral"

Write-Host "Installing UniCentral Agent..." -ForegroundColor Cyan

# Create directories
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null

# Download agent
Invoke-WebRequest -Uri "${baseUrl}/api/agent/download/windows/amd64" -OutFile "$InstallDir\\unicentral-agent.exe" -UseBasicParsing

# Write config
@{server="${baseUrl}";token=$Token} | ConvertTo-Json | Set-Content "$ConfigDir\\config.json"

# Install and start service
& "$InstallDir\\unicentral-agent.exe" --install --config "$ConfigDir\\config.json"
Start-Service UniCentralAgent

Write-Host "UniCentral Agent installed and running!" -ForegroundColor Green
`;
}

function generateLinuxScript(req) {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    return `#!/bin/bash
set -e
TOKEN="\${1:-}"
if [ -z "$TOKEN" ]; then read -p "Enter registration token: " TOKEN; fi

echo "Installing UniCentral Agent..."

# Detect architecture
ARCH=$(uname -m)
case $ARCH in
    x86_64) ARCH="amd64" ;;
    aarch64) ARCH="arm64" ;;
    *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

# Download agent
curl -sL "${baseUrl}/api/agent/download/linux/$ARCH" -o /usr/local/bin/unicentral-agent
chmod +x /usr/local/bin/unicentral-agent

# Create config
mkdir -p /etc/unicentral
cat > /etc/unicentral/config.json <<EOF
{"server": "${baseUrl}", "token": "$TOKEN"}
EOF

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

// Start server
server.listen(config.port, () => {
    console.log(`[UniCentral] Server running on port ${config.port}`);
    if (!isSetupComplete()) {
        console.log('[UniCentral] First-run setup required - visit the web interface');
    }
});
