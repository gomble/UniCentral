package collectors

import (
	"context"
	"encoding/json"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

type VeeamJob struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	Type            string `json:"type"`
	IsCopy          bool   `json:"is_copy"`
	LastResult      string `json:"last_result"`
	LastState       string `json:"last_state"`
	LastRun         string `json:"last_run"`
	NextRun         string `json:"next_run"`
	ScheduleEnabled bool   `json:"schedule_enabled"`
	TargetRepo      string `json:"target_repo"`
	RepoID          string `json:"repo_id"`
	Description     string `json:"description"`
}

type VeeamSession struct {
	JobID     string `json:"job_id"`
	SessionID string `json:"session_id"`
	JobName   string `json:"job_name"`
	Result    string `json:"result"`
	State     string `json:"state"`
	Start     string `json:"start"`
	End       string `json:"end"`
}

type VeeamRepository struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Type     string `json:"type"`
	Path     string `json:"path"`
	Capacity int64  `json:"capacity"`
	Free     int64  `json:"free"`
	Used     int64  `json:"used"`
}

type VeeamData struct {
	Installed    bool              `json:"installed"`
	Collected    bool              `json:"collected"`
	Version      string            `json:"version"`
	Jobs         []VeeamJob        `json:"jobs"`
	Sessions     []VeeamSession    `json:"sessions"`
	Repositories []VeeamRepository `json:"repositories"`
}

// GetVeeamData detects a local Veeam Backup & Replication installation and, if
// present, gathers jobs (incl. backup copy jobs), their recent session history
// and backup repository usage via the Veeam PowerShell module. Returns nil on
// non-Windows hosts or when Veeam is not installed, so telemetry stays small on
// ordinary machines.
func GetVeeamData() *VeeamData {
	if runtime.GOOS != "windows" {
		return nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	out, err := exec.CommandContext(ctx, "powershell", "-NoProfile", "-NonInteractive",
		"-ExecutionPolicy", "Bypass", "-Command", veeamScript).Output()
	if err != nil && len(out) == 0 {
		return nil
	}

	text := strings.TrimSpace(string(out))
	if text == "" {
		return nil
	}

	var data VeeamData
	if err := json.Unmarshal([]byte(text), &data); err != nil {
		return nil
	}
	if !data.Installed {
		return nil
	}
	return &data
}

const veeamScript = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Fast detection: the Veeam Backup service only exists on a B&R server.
$svc = Get-Service -Name 'VeeamBackupSvc' -ErrorAction SilentlyContinue
if (-not $svc) { Write-Output '{"installed":false}'; exit 0 }

# Load the Veeam PowerShell module (v11/v12), falling back to the legacy snapin.
$loaded = $false
try { Import-Module Veeam.Backup.PowerShell -ErrorAction Stop; $loaded = $true } catch {}
if (-not $loaded) { try { Add-PSSnapin VeeamPSSnapIn -ErrorAction Stop; $loaded = $true } catch {} }
if (-not $loaded) {
    Write-Output '{"installed":true,"collected":false,"version":"","jobs":[],"sessions":[],"repositories":[]}'
    exit 0
}

function IsoOrNull($d) {
    # Naive UTC string (no offset) to match the server's timestamp convention;
    # the dashboard treats stored timestamps as UTC.
    if ($d -and $d -ne [DateTime]::MinValue) { return (Get-Date $d).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss') }
    return ''
}
function JsonArray($items) {
    $a = @($items)
    if ($a.Count -eq 0) { return '[]' }
    $j = ($a | ConvertTo-Json -Depth 6 -Compress)
    if ($a.Count -eq 1) { $j = '[' + $j + ']' }
    return $j
}

$version = ''
try { $version = (Get-Module Veeam.Backup.PowerShell).Version.ToString() } catch {}

# --- Repositories (standard + scale-out extents) ---
$repoOut = New-Object System.Collections.ArrayList
try {
    $repos = @(Get-VBRBackupRepository -ErrorAction SilentlyContinue)
    try { $repos += @(Get-VBRBackupRepository -ScaleOut -ErrorAction SilentlyContinue) } catch {}
    foreach ($r in $repos) {
        $cap = 0; $free = 0
        try { $c = $r.GetContainer(); $cap = [int64]$c.CachedTotalSpace.InBytes; $free = [int64]$c.CachedFreeSpace.InBytes } catch {}
        [void]$repoOut.Add([PSCustomObject]@{
            id       = [string]$r.Id
            name     = [string]$r.Name
            type     = [string]$r.Type
            path     = [string]$r.FriendlyPath
            capacity = $cap
            free     = $free
            used     = ($cap - $free)
        })
    }
} catch {}

# --- All sessions once, grouped by job, to avoid repeated expensive queries ---
$sessByJob = @{}
try {
    $allSessions = @(Get-VBRBackupSession -ErrorAction SilentlyContinue)
    foreach ($s in $allSessions) {
        $jid = [string]$s.JobId
        if (-not $sessByJob.ContainsKey($jid)) { $sessByJob[$jid] = New-Object System.Collections.ArrayList }
        [void]$sessByJob[$jid].Add($s)
    }
} catch {}

# --- Jobs (backup, backup copy = BackupSync, replica, ...) ---
$jobOut = New-Object System.Collections.ArrayList
$sessOut = New-Object System.Collections.ArrayList
try {
    $jobs = @(Get-VBRJob -ErrorAction SilentlyContinue)
    foreach ($j in $jobs) {
        $jid = [string]$j.Id
        $lastResult = ''; $lastState = ''; $lastRun = ''
        try {
            $last = $j.FindLastSession()
            if ($last) { $lastResult = [string]$last.Result; $lastState = [string]$last.State; $lastRun = IsoOrNull $last.CreationTime }
        } catch {}
        $nextRun = ''
        try { $nextRun = IsoOrNull $j.GetScheduleOptions().NextRun } catch {}
        $target = ''; $repoId = ''
        try { $tr = $j.GetTargetRepository(); if ($tr) { $target = [string]$tr.Name; $repoId = [string]$tr.Id } } catch {}
        $isCopy = ([string]$j.JobType -eq 'BackupSync')
        $sched = $true
        try { $sched = [bool]$j.IsScheduleEnabled } catch {}

        [void]$jobOut.Add([PSCustomObject]@{
            id               = $jid
            name             = [string]$j.Name
            type             = [string]$j.JobType
            is_copy          = $isCopy
            last_result      = $lastResult
            last_state       = $lastState
            last_run         = $lastRun
            next_run         = $nextRun
            schedule_enabled = $sched
            target_repo      = $target
            repo_id          = $repoId
            description      = [string]$j.Description
        })

        if ($sessByJob.ContainsKey($jid)) {
            $hist = @($sessByJob[$jid] | Sort-Object CreationTime -Descending | Select-Object -First 10)
            foreach ($s in $hist) {
                [void]$sessOut.Add([PSCustomObject]@{
                    job_id     = $jid
                    session_id = [string]$s.Id
                    job_name   = [string]$j.Name
                    result     = [string]$s.Result
                    state      = [string]$s.State
                    start      = IsoOrNull $s.CreationTime
                    end        = IsoOrNull $s.EndTime
                })
            }
        }
    }
} catch {}

$out = '{"installed":true,"collected":true,"version":' + ([string]$version | ConvertTo-Json -Compress) +
    ',"jobs":' + (JsonArray $jobOut) +
    ',"sessions":' + (JsonArray $sessOut) +
    ',"repositories":' + (JsonArray $repoOut) + '}'
Write-Output $out
`
