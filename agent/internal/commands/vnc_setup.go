package commands

import (
	"context"
	"fmt"
	"runtime"
	"strings"
	"time"
)

func execSetupVNC(params map[string]interface{}) Result {
	password, _ := params["password"].(string)
	if password == "" {
		password = "unicentral"
	}
	vncPort := 5900
	if p, ok := params["port"].(float64); ok {
		vncPort = int(p)
	}
	// Strip single quotes to prevent injection into the PowerShell/bash scripts.
	password = strings.ReplaceAll(password, "'", "")

	if runtime.GOOS == "windows" {
		return execSetupVNCWindows(password, vncPort)
	}
	return execSetupVNCLinux(password, vncPort)
}

func execSetupVNCWindows(password string, port int) Result {
	script := fmt.Sprintf(`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$port = %d
$pass = '%s'

function Log($m) { Write-Output ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) }

function EncodeVNCPass($p) {
    $bytes = [System.Text.Encoding]::ASCII.GetBytes($p.PadRight(8,'x').Substring(0,8))
    $enc = $bytes | ForEach-Object {
        $b = $_; $r = [byte]0
        for ($i = 0; $i -lt 8; $i++) { $r = [byte](($r -shl 1) -bor ($b -band 1)); $b = [byte]($b -shr 1) }
        $r
    }
    return [byte[]]$enc
}

$conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($conn) { Log "VNC already listening on port $port"; exit 0 }

$exe = 'C:\Program Files\TightVNC\tvnserver.exe'
if (-not (Test-Path $exe)) {
    Log "Installing TightVNC..."
    $ok = $false
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        winget install --id TightVNC.TightVNC --silent --accept-package-agreements --accept-source-agreements 2>&1 | Out-Null
        if (Test-Path $exe) { $ok = $true; Log "Installed via winget" }
    }
    if (-not $ok -and (Get-Command choco -ErrorAction SilentlyContinue)) {
        choco install tightvnc -y --no-progress 2>&1 | Out-Null
        if (Test-Path $exe) { $ok = $true; Log "Installed via choco" }
    }
    if (-not $ok) {
        Log "ERROR: TightVNC installation failed. Install manually from https://tightvnc.com"
        exit 1
    }
}

Log "Configuring TightVNC..."
$reg = 'HKLM:\SOFTWARE\TightVNC\Server'
if (-not (Test-Path $reg)) { New-Item -Path $reg -Force | Out-Null }
$encoded = EncodeVNCPass $pass
Set-ItemProperty -Path $reg -Name 'Password'               -Value $encoded -Type Binary
Set-ItemProperty -Path $reg -Name 'UseVncAuthentication'   -Value 1 -Type DWord
Set-ItemProperty -Path $reg -Name 'RfbPort'                -Value $port -Type DWord
Set-ItemProperty -Path $reg -Name 'AllowLoopback'          -Value 1 -Type DWord
Set-ItemProperty -Path $reg -Name 'VideoRecognitionInterval' -Value 3000 -Type DWord

$svc = Get-Service -Name 'tvnserver' -ErrorAction SilentlyContinue
if ($svc) {
    if ($svc.Status -eq 'Running') {
        Log "Restarting TightVNC service..."
        Restart-Service tvnserver -Force
    } else {
        Start-Service tvnserver
    }
} else {
    Log "Registering TightVNC service..."
    & "$exe" -install -silent 2>&1 | Out-Null
    Start-Sleep -Seconds 2
    Start-Service tvnserver -ErrorAction SilentlyContinue
}

Start-Sleep -Seconds 3
$conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($conn) { Log "VNC ready on port $port" } else { Log "VNC service starting..." }
`, port, password)

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	out, err := runStreaming(ctx, "", "powershell",
		[]string{"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script},
		nil)
	if err != nil && ctx.Err() != nil {
		return Result{Status: "failed", Output: out + "\nTimeout"}
	}
	return Result{Status: "completed", Output: out}
}

func execSetupVNCLinux(password string, port int) Result {
	script := fmt.Sprintf(`#!/bin/bash
set -uo pipefail
PORT=%d
PASS='%s'
log() { echo "[$(date '+%%H:%%M:%%S')] $1"; }

if ss -tlnp 2>/dev/null | grep -q ":${PORT} "; then
    log "VNC already listening on port $PORT"; exit 0
fi

if ! command -v x11vnc &>/dev/null; then
    log "Installing x11vnc..."
    if command -v apt-get &>/dev/null; then
        DEBIAN_FRONTEND=noninteractive apt-get install -y x11vnc xvfb 2>&1
    elif command -v dnf &>/dev/null; then
        dnf install -y x11vnc xorg-x11-server-Xvfb 2>&1
    elif command -v yum &>/dev/null; then
        yum install -y x11vnc xorg-x11-server-Xvfb 2>&1
    else
        log "ERROR: Cannot install x11vnc"; exit 1
    fi
fi

mkdir -p /root/.vnc
x11vnc -storepasswd "$PASS" /root/.vnc/passwd 2>/dev/null

XDISP=":0"
if ! DISPLAY=:0 xdpyinfo &>/dev/null 2>&1; then
    log "No display, starting Xvfb on :10..."
    Xvfb :10 -screen 0 1280x800x24 &
    sleep 1
    XDISP=":10"
fi

log "Starting x11vnc on display $XDISP port $PORT..."
nohup x11vnc -display "$XDISP" -rfbauth /root/.vnc/passwd -rfbport $PORT -forever -shared &>/tmp/x11vnc.log &
sleep 2

if ss -tlnp 2>/dev/null | grep -q ":$PORT "; then
    log "VNC ready on port $PORT"
else
    log "VNC service starting (check /tmp/x11vnc.log if issues persist)"
fi
`, port, password)

	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()
	out, err := runStreaming(ctx, "", "bash", []string{"-c", script}, nil)
	if err != nil && ctx.Err() != nil {
		return Result{Status: "failed", Output: out + "\nTimeout"}
	}
	return Result{Status: "completed", Output: out}
}
