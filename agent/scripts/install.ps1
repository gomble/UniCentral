param(
    [Parameter(Mandatory=$false)]
    [string]$EnrollmentKey,

    [Parameter(Mandatory=$false)]
    [string]$Server,

    [Parameter(Mandatory=$false)]
    [ValidateSet("server", "client")]
    [string]$Category = "client"
)

$ErrorActionPreference = "Stop"

if (-not $EnrollmentKey) {
    $EnrollmentKey = Read-Host "Enter enrollment key"
}
if (-not $Server) {
    $Server = Read-Host "Enter server URL (e.g. https://unicentral.example.com)"
}

$InstallDir = "C:\Program Files\UniCentral"
$ConfigDir = "C:\ProgramData\UniCentral"

Write-Host "=== UniCentral Agent Installer ===" -ForegroundColor Cyan
Write-Host "Server:   $Server"
Write-Host "Category: $Category"
Write-Host ""

# Create directories
Write-Host "[1/4] Creating directories..." -ForegroundColor Yellow
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null

# Download agent binary
Write-Host "[2/4] Downloading agent..." -ForegroundColor Yellow
$downloadUrl = "$Server/api/agent/download/windows/amd64"
try {
    Invoke-WebRequest -Uri $downloadUrl -OutFile "$InstallDir\unicentral-agent.exe" -UseBasicParsing
} catch {
    Write-Host "Failed to download agent: $_" -ForegroundColor Red
    exit 1
}

# Write config
Write-Host "[3/4] Writing configuration..." -ForegroundColor Yellow
$config = @{
    server = $Server
    enrollment_key = $EnrollmentKey
    category = $Category
} | ConvertTo-Json
Set-Content -Path "$ConfigDir\config.json" -Value $config

# Install and start service
Write-Host "[4/4] Installing service..." -ForegroundColor Yellow
& "$InstallDir\unicentral-agent.exe" --install --config "$ConfigDir\config.json"

Start-Service UniCentralAgent

Write-Host ""
Write-Host "UniCentral Agent installed and running!" -ForegroundColor Green
Write-Host "Install dir: $InstallDir"
Write-Host "Config dir:  $ConfigDir"
Write-Host "Service:     UniCentralAgent"
Write-Host ""
Write-Host "The agent will auto-register with the central server."
