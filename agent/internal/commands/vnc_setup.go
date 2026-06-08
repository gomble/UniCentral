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

function ReverseBits([byte[]]$arr) {
    $out = New-Object byte[] $arr.Length
    for ($j = 0; $j -lt $arr.Length; $j++) {
        $b = $arr[$j]; $r = [byte]0
        for ($i = 0; $i -lt 8; $i++) { $r = [byte](($r -shl 1) -bor ($b -band 1)); $b = [byte]($b -shr 1) }
        $out[$j] = $r
    }
    return ,$out
}

function DesEcb([byte[]]$data, [byte[]]$key) {
    $des = [System.Security.Cryptography.DES]::Create()
    $des.Mode = [System.Security.Cryptography.CipherMode]::ECB
    $des.Padding = [System.Security.Cryptography.PaddingMode]::None
    $des.Key = $key
    $enc = $des.CreateEncryptor()
    $out = $enc.TransformFinalBlock($data, 0, $data.Length)
    $des.Dispose()
    return ,$out
}

# TightVNC stores the password as DES(password, fixedKey) using the well-known
# VNC fixed key. .NET DES reads bits MSB-first while VNC's d3des reads them
# LSB-first, so we pre-reverse the bits of the fixed key (0x17,0x52,... ->
# 0xE8,0x4A,...) and encrypt the 8-byte (null-padded) password as-is.
function EncodeVNCPass($p) {
    $pw = New-Object byte[] 8
    $src = [System.Text.Encoding]::ASCII.GetBytes($p)
    [Array]::Copy($src, 0, $pw, 0, [Math]::Min(8, $src.Length))
    $key = [byte[]](0xE8,0x4A,0xD6,0x60,0xC4,0x72,0x1A,0xE0)
    return ,(DesEcb $pw $key)
}

# Replicate the VNC challenge-response to verify the stored password actually
# authenticates over loopback. The DES key is the password with each byte's
# bits reversed (same d3des convention).
function Test-VncAuth($port, $pass) {
    try {
        $tc = New-Object System.Net.Sockets.TcpClient
        $tc.Connect('127.0.0.1', $port)
        $tc.ReceiveTimeout = 5000; $tc.SendTimeout = 5000
        $ns = $tc.GetStream()
        $ver = New-Object byte[] 12
        $n = $ns.Read($ver, 0, 12)
        if ($n -lt 12) { $tc.Close(); return "no version ($n bytes)" }
        $ns.Write($ver, 0, 12)
        $cnt = New-Object byte[] 1
        if ($ns.Read($cnt, 0, 1) -lt 1) { $tc.Close(); return "no sectype count" }
        if ($cnt[0] -eq 0) { $tc.Close(); return "server sent 0 sectypes (rejected)" }
        $types = New-Object byte[] $cnt[0]
        $ns.Read($types, 0, $cnt[0]) | Out-Null
        $ns.Write([byte[]](2), 0, 1)
        $ch = New-Object byte[] 16; $r = 0
        while ($r -lt 16) { $k = $ns.Read($ch, $r, 16 - $r); if ($k -le 0) { break }; $r += $k }
        if ($r -lt 16) { $tc.Close(); return "no challenge ($r bytes)" }
        $pw = New-Object byte[] 8
        $src = [System.Text.Encoding]::ASCII.GetBytes($pass)
        [Array]::Copy($src, 0, $pw, 0, [Math]::Min(8, $src.Length))
        $key = ReverseBits $pw
        $resp = DesEcb $ch $key
        $ns.Write($resp, 0, 16)
        $sr = New-Object byte[] 4; $r = 0
        while ($r -lt 4) { $k = $ns.Read($sr, $r, 4 - $r); if ($k -le 0) { break }; $r += $k }
        $tc.Close()
        if ($r -lt 4) { return "no SecurityResult ($r bytes)" }
        if (($sr[0] -bor $sr[1] -bor $sr[2] -bor $sr[3]) -eq 0) { return "AUTH OK" }
        return ("AUTH FAILED (result=" + ($sr -join ',') + ")")
    } catch { return ("probe error: " + $_.Exception.Message) }
}

$reg = 'HKLM:\SOFTWARE\TightVNC\Server'
$conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($conn) { Log "VNC already listening on port $port - updating credentials and restarting..." }

$exe = 'C:\Program Files\TightVNC\tvnserver.exe'
if (-not (Test-Path $exe) -and (Test-Path 'C:\Program Files (x86)\TightVNC\tvnserver.exe')) {
    $exe = 'C:\Program Files (x86)\TightVNC\tvnserver.exe'
}

if (-not (Test-Path $exe)) {
    Log "Downloading TightVNC installer..."
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
    $msi = Join-Path $env:TEMP 'unicentral-tightvnc.msi'
    $urls = @(
        'https://www.tightvnc.com/download/2.8.84/tightvnc-2.8.84-gpl-setup-64bit.msi',
        'https://www.tightvnc.com/download/2.8.81/tightvnc-2.8.81-gpl-setup-64bit.msi',
        'https://www.tightvnc.com/download/2.8.27/tightvnc-2.8.27-gpl-setup-64bit.msi'
    )
    $dl = $false
    foreach ($u in $urls) {
        try {
            (New-Object Net.WebClient).DownloadFile($u, $msi)
            if ((Test-Path $msi) -and ((Get-Item $msi).Length -gt 500000)) { $dl = $true; Log "Downloaded $u"; break }
        } catch { Log ("Download failed: " + $u) }
    }
    if (-not $dl) { Log "ERROR: Could not download TightVNC installer"; exit 1 }

    Log "Installing TightVNC silently..."
    $msiArgs = '/i "{0}" /quiet /norestart ADDLOCAL="Server" SERVER_REGISTER_AS_SERVICE=1 SERVER_ADD_FIREWALL_EXCEPTION=1 SET_USEVNCAUTHENTICATION=1 VALUE_OF_USEVNCAUTHENTICATION=1 SET_PASSWORD=1 VALUE_OF_PASSWORD="{1}" SET_USECONTROLAUTHENTICATION=1 VALUE_OF_USECONTROLAUTHENTICATION=0 SET_ACCEPTHTTPCONNECTIONS=1 VALUE_OF_ACCEPTHTTPCONNECTIONS=0' -f $msi, $pass
    $proc = Start-Process 'msiexec.exe' -ArgumentList $msiArgs -Wait -PassThru
    Log ("msiexec exit code: " + $proc.ExitCode)
    Start-Sleep -Seconds 3
    $exe = 'C:\Program Files\TightVNC\tvnserver.exe'
    if (-not (Test-Path $exe) -and (Test-Path 'C:\Program Files (x86)\TightVNC\tvnserver.exe')) {
        $exe = 'C:\Program Files (x86)\TightVNC\tvnserver.exe'
    }
    if (-not (Test-Path $exe)) { Log "ERROR: TightVNC not found after install"; exit 1 }
    Remove-Item $msi -Force -ErrorAction SilentlyContinue
}

Log "Configuring TightVNC..."
$reg = 'HKLM:\SOFTWARE\TightVNC\Server'
if (-not (Test-Path $reg)) { New-Item -Path $reg -Force | Out-Null }
$encoded = EncodeVNCPass $pass
Set-ItemProperty -Path $reg -Name 'Password'               -Value $encoded -Type Binary
Set-ItemProperty -Path $reg -Name 'UseVncAuthentication'   -Value 1 -Type DWord
Set-ItemProperty -Path $reg -Name 'RfbPort'                -Value $port -Type DWord
Set-ItemProperty -Path $reg -Name 'AllowLoopback'          -Value 1 -Type DWord
Set-ItemProperty -Path $reg -Name 'LoopbackOnly'           -Value 0 -Type DWord
Set-ItemProperty -Path $reg -Name 'VideoRecognitionInterval' -Value 3000 -Type DWord
# Disable IP blacklisting so repeated relay reconnects from 127.0.0.1 are never
# locked out (failed auth attempts during setup would otherwise block loopback).
Set-ItemProperty -Path $reg -Name 'BlacklistThreshold'     -Value 1000000 -Type DWord
Set-ItemProperty -Path $reg -Name 'BlacklistTimeout'       -Value 0 -Type DWord
# Never query the (often headless) console user to accept incoming connections.
Set-ItemProperty -Path $reg -Name 'QueryAcceptOnTimeout'   -Value 1 -Type DWord
Set-ItemProperty -Path $reg -Name 'QueryTimeout'           -Value 1 -Type DWord

$svc = Get-Service -Name 'tvnserver' -ErrorAction SilentlyContinue
if (-not $svc) {
    Log "Registering TightVNC service..."
    & "$exe" -install -silent 2>&1 | Out-Null
    Start-Sleep -Seconds 2
    $svc = Get-Service -Name 'tvnserver' -ErrorAction SilentlyContinue
}
if ($svc) {
    if ($svc.Status -eq 'Running') {
        Log "Restarting TightVNC service..."
        Restart-Service tvnserver -Force
    } else {
        Start-Service tvnserver
    }
} else {
    Log "Starting tvnserver as application..."
    Start-Process "$exe" -ArgumentList '-start' -WindowStyle Hidden
}

Start-Sleep -Seconds 4
$conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($conn) { Log "VNC ready on port $port" } else { Log "VNC service starting..." }

# Verify the stored password actually authenticates over loopback. This runs
# the full RFB VNC-auth handshake and reports AUTH OK / AUTH FAILED so password
# encoding problems surface here instead of as a silent browser disconnect.
$probe = Test-VncAuth $port $pass
Log ("Auth probe: " + $probe)
`, port, password)

	ctx, cancel := context.WithTimeout(context.Background(), 240*time.Second)
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
