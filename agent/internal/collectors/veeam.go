package collectors

import (
	"context"
	"encoding/json"
	"os"
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
	JobID        string `json:"job_id"`
	SessionID    string `json:"session_id"`
	JobName      string `json:"job_name"`
	Result       string `json:"result"`
	State        string `json:"state"`
	Start        string `json:"start"`
	End          string `json:"end"`
	TasksJSON    string `json:"tasks_json"`
	WarningsJSON string `json:"warnings_json"`
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

// veeamShell returns the best available PowerShell executable for Veeam.
// Veeam v12+ requires PowerShell 7 (pwsh.exe) because its module is compiled
// against PS 7.4. Fall back to powershell.exe only when pwsh is not installed.
func veeamShell() string {
	if path, err := exec.LookPath("pwsh"); err == nil {
		return path
	}
	for _, p := range []string{
		`C:\Program Files\PowerShell\7\pwsh.exe`,
		`C:\Program Files\PowerShell\7-preview\pwsh.exe`,
	} {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return "powershell"
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

	out, err := exec.CommandContext(ctx, veeamShell(), "-NoProfile", "-NonInteractive",
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
$WarningPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Fast detection: the Veeam Backup service only exists on a B&R server.
$svc = Get-Service -Name 'VeeamBackupSvc' -ErrorAction SilentlyContinue
if (-not $svc) { Write-Output '{"installed":false}'; exit 0 }

# Load the Veeam PowerShell module — try multiple strategies since the agent
# may run as SYSTEM without the Veeam path in PSModulePath.
$loaded = $false
# 1. Standard PSModulePath (works for interactive sessions)
try { Import-Module Veeam.Backup.PowerShell -ErrorAction Stop; $loaded = $true } catch {}
# 2. Explicit module directory — v11/v12 console install (Import-Module needs the
#    folder containing the .psd1 manifest, not the .dll file directly)
if (-not $loaded) {
    $candidates = @(
        'C:\Program Files\Veeam\Backup and Replication\Console\Veeam.Backup.PowerShell',
        'C:\Program Files\Veeam\Backup and Replication\Backup\Veeam.Backup.PowerShell'
    )
    foreach ($p in $candidates) {
        if (-not $loaded -and (Test-Path $p)) {
            try { Import-Module $p -ErrorAction Stop -WarningAction SilentlyContinue; $loaded = $true } catch {}
        }
    }
}
# 3. Scan Program Files for the module directory
if (-not $loaded) {
    $found = Get-ChildItem 'C:\Program Files\Veeam' -Recurse -Filter 'Veeam.Backup.PowerShell.psd1' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { try { Import-Module $found.DirectoryName -ErrorAction Stop -WarningAction SilentlyContinue; $loaded = $true } catch {} }
}
# 4. Legacy PSSnapin (v9/v10)
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

# Helper: collect attention records (warnings/errors) from a session's log.
function GetWarnings($session) {
    $out = New-Object System.Collections.ArrayList
    try {
        $recs = @($session.Logger.GetLog().GetAttentionRecords())
        foreach ($r in $recs) {
            [void]$out.Add([PSCustomObject]@{
                status = [string]$r.Status
                title  = [string]$r.Title
                time   = IsoOrNull $r.UpdateTime
            })
        }
    } catch {}
    if ($out.Count -eq 0) { return '[]' }
    $j = ($out | ConvertTo-Json -Depth 3 -Compress)
    if ($out.Count -eq 1) { $j = '[' + $j + ']' }
    return $j
}

# Helper: collect task sessions (per-VM results) for a backup session object.
function GetTasks($session) {
    $out = New-Object System.Collections.ArrayList
    $sessReason = ''
    try { $sessReason = [string]$session.Info.Reason } catch {}
    try {
        $tasks = @($session.GetTaskSessions())
        foreach ($t in $tasks) {
            $status = [string]$t.Status
            if (-not $status) { $status = [string]$t.Result }
            $reason = ''
            try { $reason = [string]$t.Info.Reason } catch {}
            if (-not $reason) {
                try {
                    $warnLogs = @($t.Logger.GetLog().Updts | Where-Object { $_.Status -ne 'Normal' })
                    if ($warnLogs.Count -gt 0) { $reason = [string]$warnLogs[-1].Title }
                } catch {}
            }
            if (-not $reason -and $status -ne 'Success' -and $sessReason) { $reason = $sessReason }
            [void]$out.Add([PSCustomObject]@{
                name   = [string]$t.Name
                result = $status
                reason = $reason
            })
        }
    } catch {}
    if ($out.Count -eq 0) { return '[]' }
    $j = ($out | ConvertTo-Json -Depth 3 -Compress)
    if ($out.Count -eq 1) { $j = '[' + $j + ']' }
    return $j
}

# --- All sessions once, grouped by job ID (normalized to lower-case GUID string) ---
$sessByJob = @{}
try {
    $allSessions = @(Get-VBRBackupSession -ErrorAction SilentlyContinue)
    foreach ($s in $allSessions) {
        $jid = ([string]$s.JobId).ToLower().Trim()
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
        $jid = ([string]$j.Id).ToLower().Trim()
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

        # Session history: standard lookup covers Backup/BackupSync/Replica job types.
        # VmbApiPolicyTempJob (Proxmox VE plugin) and EpAgentBackup sessions live in
        # separate DB tables not exposed by Get-VBRBackupSession; fall back to the
        # last-session job methods which are the only PS API that reaches them.
        $jobSessions = if ($sessByJob.ContainsKey($jid)) { @($sessByJob[$jid]) } else { @() }
        if ($jobSessions.Count -eq 0) {
            try {
                $ls = $j.FindLastSession()
                if ($ls) { $jobSessions = @($ls) }
                $lc = $j.FindLastCompletedSession()
                if ($lc -and [string]$lc.Id -ne [string]$ls.Id) { $jobSessions += $lc }
            } catch {}
        }
        $hist = @($jobSessions | Sort-Object CreationTime -Descending | Select-Object -First 10)
        foreach ($s in $hist) {
            $tasksJson = GetTasks $s
            if ($tasksJson -eq '[]' -and [string]$j.JobType -eq 'VmbApiPolicyTempJob') {
                $proxObjs = New-Object System.Collections.ArrayList
                try {
                    $jObjs = @($j.GetObjectsInJob())
                    foreach ($obj in $jObjs) {
                        [void]$proxObjs.Add([PSCustomObject]@{
                            name   = [string]$obj.Name
                            result = [string]$s.Result
                            reason = ''
                        })
                    }
                } catch {}
                if ($proxObjs.Count -gt 0) {
                    $tasksJson = ($proxObjs | ConvertTo-Json -Depth 2 -Compress)
                    if ($proxObjs.Count -eq 1) { $tasksJson = '[' + $tasksJson + ']' }
                }
            }
            if ($tasksJson -eq '[]' -and [string]$j.JobType -eq 'EpAgentBackup') {
                $tObj = [PSCustomObject]@{ name = [string]$j.Name; result = [string]$s.Result; reason = '' }
                $tasksJson = '[' + ($tObj | ConvertTo-Json -Depth 2 -Compress) + ']'
            }
            $sessReason = ''
            try { $sessReason = [string]$s.Info.Reason } catch {}
            $warningsJson = GetWarnings $s
            [void]$sessOut.Add([PSCustomObject]@{
                job_id        = $jid
                session_id    = [string]$s.Id
                job_name      = [string]$j.Name
                result        = [string]$s.Result
                state         = [string]$s.State
                start         = IsoOrNull $s.CreationTime
                end           = IsoOrNull $s.EndTime
                tasks_json    = $tasksJson
                reason        = $sessReason
                warnings_json = $warningsJson
            })
        }
    }
} catch {}

# --- Computer/Agent backup jobs (Veeam Agent managed jobs, v11+) ---
try {
    $agentJobs = @(Get-VBRComputerBackupJob -ErrorAction SilentlyContinue)
    foreach ($j in $agentJobs) {
        $jid = ([string]$j.Id).ToLower().Trim()
        $lastResult = ''; $lastState = ''; $lastRun = ''
        $agentSessList = @()
        try {
            $agentSessList = @(Get-VBRComputerBackupJobSession -Name $j.Name -ErrorAction SilentlyContinue | Sort-Object CreationTime -Descending)
            if ($agentSessList.Count -gt 0) {
                $last = $agentSessList[0]
                $lastResult = [string]$last.Result
                $lastState  = [string]$last.State
                $lastRun    = IsoOrNull $last.CreationTime
            }
        } catch {}
        $nextRun = ''
        try { $nextRun = IsoOrNull $j.GetScheduleOptions().NextRun } catch {}
        $target = ''; $repoId = ''
        try { $tr = $j.GetTargetRepository(); if ($tr) { $target = [string]$tr.Name; $repoId = [string]$tr.Id } } catch {}
        $sched = $true
        try { $sched = [bool]$j.IsScheduleEnabled } catch {}

        [void]$jobOut.Add([PSCustomObject]@{
            id               = $jid
            name             = [string]$j.Name
            type             = 'AgentBackup'
            is_copy          = $false
            last_result      = $lastResult
            last_state       = $lastState
            last_run         = $lastRun
            next_run         = $nextRun
            schedule_enabled = $sched
            target_repo      = $target
            repo_id          = $repoId
            description      = [string]$j.Description
        })

        $agentHostName = [string]$j.Name
        $bo = [string]$j.BackupObject
        if ($bo) {
            try { $agentHostName = [System.Net.Dns]::GetHostEntry($bo).HostName.Split('.')[0] } catch {}
            if (-not $agentHostName) { $agentHostName = $bo }
        }

        $hist = @($agentSessList | Select-Object -First 10)
        foreach ($s in $hist) {
            $tasksJson = GetTasks $s
            if ($tasksJson -eq '[]') {
                $tObj = [PSCustomObject]@{ name = $agentHostName; result = [string]$s.Result; reason = '' }
                $tasksJson = '[' + ($tObj | ConvertTo-Json -Depth 2 -Compress) + ']'
            }
            $sessReason = ''
            try { $sessReason = [string]$s.Info.Reason } catch {}
            $warningsJson = GetWarnings $s
            [void]$sessOut.Add([PSCustomObject]@{
                job_id        = $jid
                session_id    = [string]$s.Id
                job_name      = [string]$j.Name
                result        = [string]$s.Result
                state         = [string]$s.State
                start         = IsoOrNull $s.CreationTime
                end           = IsoOrNull $s.EndTime
                tasks_json    = $tasksJson
                reason        = $sessReason
                warnings_json = $warningsJson
            })
        }
    }
} catch {}

$out = '{"installed":true,"collected":true,"version":' + ([string]$version | ConvertTo-Json -Compress) +
    ',"jobs":' + (JsonArray $jobOut) +
    ',"sessions":' + (JsonArray $sessOut) +
    ',"repositories":' + (JsonArray $repoOut) + '}'
Write-Output $out
`
