#!/bin/bash
set -e

ENROLLMENT_KEY=""
SERVER=""
CATEGORY="client"

while [[ $# -gt 0 ]]; do
    case $1 in
        --key|--enrollment-key) ENROLLMENT_KEY="$2"; shift 2 ;;
        --server) SERVER="$2"; shift 2 ;;
        --category) CATEGORY="$2"; shift 2 ;;
        --token) ENROLLMENT_KEY="$2"; shift 2 ;;
        *) ENROLLMENT_KEY="$1"; shift ;;
    esac
done

if [ -z "$ENROLLMENT_KEY" ]; then
    read -p "Enter enrollment key: " ENROLLMENT_KEY
fi
if [ -z "$SERVER" ]; then
    read -p "Enter server URL (e.g. https://unicentral.example.com): " SERVER
fi

echo "=== UniCentral Agent Installer ==="
echo "Server:   $SERVER"
echo "Category: $CATEGORY"
echo ""

# Detect architecture
ARCH=$(uname -m)
case $ARCH in
    x86_64) ARCH="amd64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

echo "[1/4] Detected architecture: $ARCH"

# Download agent
echo "[2/4] Downloading agent..."
curl -sL "$SERVER/api/agent/download/linux/$ARCH" -o /usr/local/bin/unicentral-agent
chmod +x /usr/local/bin/unicentral-agent

# Create config
echo "[3/4] Writing configuration..."
mkdir -p /etc/unicentral
cat > /etc/unicentral/config.json <<EOF
{
  "server": "$SERVER",
  "enrollment_key": "$ENROLLMENT_KEY",
  "category": "$CATEGORY"
}
EOF
chmod 600 /etc/unicentral/config.json

# Create systemd service
echo "[4/4] Installing service..."
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
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable unicentral-agent
systemctl start unicentral-agent

echo ""
echo "UniCentral Agent installed and running!"
echo "Binary:  /usr/local/bin/unicentral-agent"
echo "Config:  /etc/unicentral/config.json"
echo "Service: unicentral-agent"
echo ""
echo "The agent will auto-register with the central server."
echo "Check status: systemctl status unicentral-agent"
echo "View logs:    journalctl -u unicentral-agent -f"
