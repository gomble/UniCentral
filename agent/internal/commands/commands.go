package commands

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/unicentral/agent/internal/updater"
)

type Result struct {
	Status string `json:"status"`
	Output string `json:"output"`
}

// ProgressFunc receives the accumulated output of a long-running command so the
// server/dashboard can show live progress while the command is still executing.
type ProgressFunc func(output string)

func Execute(cmdType string, params map[string]interface{}, onProgress ProgressFunc) Result {
	switch cmdType {
	case "restart":
		return execRestart()
	case "shutdown":
		return execShutdown()
	case "install_software":
		pkg, _ := params["package_name"].(string)
		method, _ := params["method"].(string)
		return execInstallSoftware(pkg, method)
	case "enable_firewall":
		return execFirewall(true)
	case "disable_firewall":
		return execFirewall(false)
	case "add_firewall_rule":
		return execAddFirewallRule(params)
	case "trigger_updates":
		return runUpdates(false, onProgress)
	case "trigger_updates_reboot":
		return runUpdates(true, onProgress)
	case "install_defender_updates":
		return runDefenderUpdates(onProgress)
	case "schedule_updates":
		return execScheduleUpdates(params)
	case "deploy_neighbor":
		return execDeployNeighbor(params)
	case "update_agent":
		return execUpdateAgent(params)
	case "scan_network":
		return execScanNetwork(params)
	case "ad_list_users":
		return execADListUsers(params)
	case "ad_list_groups":
		return execADListGroups(params)
	case "ad_create_user":
		return execADCreateUser(params)
	case "ad_update_user":
		return execADUpdateUser(params)
	case "ad_delete_user":
		return execADDeleteUser(params)
	case "ad_list_ous":
		return execADListOUs(params)
	case "ad_move_user":
		return execADMoveUser(params)
	case "local_list_users":
		return execLocalListUsers(params)
	case "local_list_groups":
		return execLocalListGroups(params)
	case "local_create_user":
		return execLocalCreateUser(params)
	case "local_update_user":
		return execLocalUpdateUser(params)
	case "local_delete_user":
		return execLocalDeleteUser(params)
	case "scan_disk":
		return execScanDisk(params)
	case "enable_defender":
		return execDefender(true)
	case "disable_defender":
		return execDefender(false)
	case "setup_vnc":
		return execSetupVNC(params)
	default:
		return Result{Status: "failed", Output: fmt.Sprintf("unknown command: %s", cmdType)}
	}
}

func execRestart() Result {
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.Command("shutdown", "/r", "/t", "5")
	} else {
		cmd = exec.Command("shutdown", "-r", "+0")
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return Result{Status: "failed", Output: err.Error()}
	}
	return Result{Status: "completed", Output: string(out)}
}

func execShutdown() Result {
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.Command("shutdown", "/s", "/t", "5")
	} else {
		cmd = exec.Command("shutdown", "-h", "now")
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return Result{Status: "failed", Output: err.Error()}
	}
	return Result{Status: "completed", Output: string(out)}
}

func execInstallSoftware(pkg, method string) Result {
	if pkg == "" {
		return Result{Status: "failed", Output: "no package specified"}
	}

	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		switch method {
		case "choco":
			cmd = exec.Command("choco", "install", pkg, "-y")
		default:
			cmd = exec.Command("winget", "install", "--id", pkg, "--accept-package-agreements", "--accept-source-agreements")
		}
	} else {
		if _, err := exec.LookPath("apt-get"); err == nil {
			cmd = exec.Command("apt-get", "install", "-y", pkg)
		} else {
			cmd = exec.Command("dnf", "install", "-y", pkg)
		}
	}

	out, err := cmd.CombinedOutput()
	if err != nil {
		return Result{Status: "failed", Output: string(out) + "\n" + err.Error()}
	}
	return Result{Status: "completed", Output: string(out)}
}

func execFirewall(enable bool) Result {
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		state := "on"
		if !enable {
			state = "off"
		}
		cmd = exec.Command("netsh", "advfirewall", "set", "allprofiles", "state", state)
	} else {
		if enable {
			cmd = exec.Command("ufw", "enable")
		} else {
			cmd = exec.Command("ufw", "disable")
		}
	}

	out, err := cmd.CombinedOutput()
	if err != nil {
		return Result{Status: "failed", Output: string(out) + "\n" + err.Error()}
	}
	return Result{Status: "completed", Output: string(out)}
}

func execDefender(enable bool) Result {
	if runtime.GOOS != "windows" {
		return Result{Status: "failed", Output: "Windows Defender is only available on Windows"}
	}
	action := "Set-MpPreference -DisableRealtimeMonitoring $false"
	if !enable {
		action = "Set-MpPreference -DisableRealtimeMonitoring $true"
	}
	cmd := exec.Command("powershell", "-NoProfile", "-Command", action)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return Result{Status: "failed", Output: string(out) + "\n" + err.Error()}
	}
	label := "aktiviert"
	if !enable {
		label = "deaktiviert"
	}
	return Result{Status: "completed", Output: fmt.Sprintf("Windows Defender Echtzeitschutz %s.\n%s", label, string(out))}
}

func execAddFirewallRule(params map[string]interface{}) Result {
	name, _ := params["rule_name"].(string)
	direction, _ := params["direction"].(string)
	action, _ := params["action"].(string)
	protocol, _ := params["protocol"].(string)
	port, _ := params["port"].(string)

	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		dir := "in"
		if direction == "outbound" {
			dir = "out"
		}
		cmd = exec.Command("netsh", "advfirewall", "firewall", "add", "rule",
			fmt.Sprintf("name=%s", name),
			fmt.Sprintf("dir=%s", dir),
			fmt.Sprintf("action=%s", action),
			fmt.Sprintf("protocol=%s", protocol),
			fmt.Sprintf("localport=%s", port))
	} else {
		if action == "allow" {
			cmd = exec.Command("ufw", "allow", fmt.Sprintf("%s/%s", port, protocol))
		} else {
			cmd = exec.Command("ufw", "deny", fmt.Sprintf("%s/%s", port, protocol))
		}
	}

	out, err := cmd.CombinedOutput()
	if err != nil {
		return Result{Status: "failed", Output: string(out) + "\n" + err.Error()}
	}
	return Result{Status: "completed", Output: string(out)}
}

func execUpdateAgent(params map[string]interface{}) Result {
	downloadURL, _ := params["download_url"].(string)
	if downloadURL == "" {
		serverURL, _ := params["server_url"].(string)
		if serverURL != "" {
			downloadURL = fmt.Sprintf("%s/api/agent/download/%s/%s", serverURL, runtime.GOOS, runtime.GOARCH)
		}
	}
	if downloadURL == "" {
		return Result{Status: "failed", Output: "no download URL provided"}
	}

	err := updater.Update(downloadURL)
	if err != nil {
		return Result{Status: "failed", Output: err.Error()}
	}
	return Result{Status: "completed", Output: "Agent update initiated, restarting..."}
}

// updateTimeout caps how long a single update run may take. Large cumulative
// Windows updates can legitimately need a long time to download and install.
const updateTimeout = 90 * time.Minute

// updateLogPath returns a persistent on-disk log file for update runs so the
// full history is available on the machine itself, not only in the dashboard.
func updateLogPath() string {
	var dir string
	if runtime.GOOS == "windows" {
		base := os.Getenv("ProgramData")
		if base == "" {
			base = `C:\ProgramData`
		}
		dir = filepath.Join(base, "UniCentral", "logs")
	} else {
		dir = "/var/log/unicentral"
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		// Fall back to the temp dir if the preferred location is not writable.
		dir = os.TempDir()
	}
	return filepath.Join(dir, "windows-update.log")
}

// runStreaming runs a command, merging stdout and stderr and reading the output
// line by line. Each line is appended to the returned buffer, written to logPath
// (if set), and passed to onLine for live progress reporting. The full
// accumulated output is returned once the command exits.
func runStreaming(ctx context.Context, logPath, name string, args []string, onLine func(string)) (string, error) {
	var logF *os.File
	if logPath != "" {
		if f, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644); err == nil {
			logF = f
			defer logF.Close()
			fmt.Fprintf(logF, "\n===== %s | %s %s =====\n", time.Now().Format("2006-01-02 15:04:05"), name, strings.Join(args, " "))
		}
	}

	cmd := exec.CommandContext(ctx, name, args...)
	pr, pw, err := os.Pipe()
	if err != nil {
		return "", err
	}
	cmd.Stdout = pw
	cmd.Stderr = pw

	if err := cmd.Start(); err != nil {
		pw.Close()
		pr.Close()
		return "", err
	}
	// Close the parent's copy of the write end so the reader sees EOF when the
	// child process exits.
	pw.Close()

	var buf strings.Builder
	done := make(chan struct{})
	go func() {
		scanner := bufio.NewScanner(pr)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for scanner.Scan() {
			line := scanner.Text()
			buf.WriteString(line)
			buf.WriteByte('\n')
			if logF != nil {
				logF.WriteString(line + "\n")
			}
			if onLine != nil {
				onLine(line)
			}
		}
		close(done)
	}()

	err = cmd.Wait()
	<-done
	pr.Close()
	return buf.String(), err
}

// runUpdates installs pending OS updates, streaming progress to onProgress.
func runUpdates(reboot bool, onProgress ProgressFunc) Result {
	logPath := updateLogPath()

	// Throttle progress notifications so a verbose run doesn't flood the
	// WebSocket; at most one update every ~1.5s, plus a final flush.
	var mu sync.Mutex
	var acc strings.Builder
	var lastSend time.Time
	emit := func(force bool) {
		if onProgress == nil {
			return
		}
		mu.Lock()
		now := time.Now()
		if !force && now.Sub(lastSend) < 1500*time.Millisecond {
			mu.Unlock()
			return
		}
		lastSend = now
		out := acc.String()
		mu.Unlock()
		onProgress(out)
	}
	onLine := func(line string) {
		mu.Lock()
		acc.WriteString(line)
		acc.WriteByte('\n')
		mu.Unlock()
		emit(false)
	}

	ctx, cancel := context.WithTimeout(context.Background(), updateTimeout)
	defer cancel()

	var name string
	var args []string
	if runtime.GOOS == "windows" {
		name = "powershell"
		args = []string{"-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", windowsUpdateScript(reboot)}
	} else {
		name = "bash"
		args = []string{"-c", linuxUpdateScript(reboot)}
	}

	out, err := runStreaming(ctx, logPath, name, args, onLine)
	emit(true) // flush the final accumulated output before the terminal result

	if ctx.Err() == context.DeadlineExceeded {
		return Result{Status: "failed", Output: out + fmt.Sprintf("\n[Timeout nach %s - Vorgang abgebrochen]", updateTimeout)}
	}
	if err != nil {
		return Result{Status: "failed", Output: out + "\n" + err.Error()}
	}
	return Result{Status: "completed", Output: out}
}

// runDefenderUpdates installs Windows Defender "Security Intelligence" updates
// (virus/spyware definition updates). These never require a reboot, so they can
// be applied immediately without scheduling. Uses Update-MpSignature, which
// respects the machine's configured update source order (WSUS, Microsoft Update,
// MMPC) and is far lighter than a full Windows Update run.
func runDefenderUpdates(onProgress ProgressFunc) Result {
	if runtime.GOOS != "windows" {
		return Result{Status: "failed", Output: "Security Intelligence-Updates sind nur unter Windows verfuegbar"}
	}

	var mu sync.Mutex
	var acc strings.Builder
	onLine := func(line string) {
		mu.Lock()
		acc.WriteString(line)
		acc.WriteByte('\n')
		out := acc.String()
		mu.Unlock()
		if onProgress != nil {
			onProgress(out)
		}
	}

	script := `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ProgressPreference = 'SilentlyContinue'
function Log($m) { Write-Output ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) }
try {
    $before = (Get-MpComputerStatus -ErrorAction Stop).AntivirusSignatureVersion
    Log ("Aktuelle Signaturversion: " + $before)
    Log "Aktualisiere Security Intelligence (Defender-Definitionen)..."
    Update-MpSignature -ErrorAction Stop
    $after = (Get-MpComputerStatus -ErrorAction Stop).AntivirusSignatureVersion
    Log ("Neue Signaturversion: " + $after)
    if ($before -eq $after) { Log "Bereits aktuell." } else { Log "Security Intelligence aktualisiert." }
} catch {
    Log ("FEHLER: " + $_.Exception.Message)
    exit 1
}`

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()

	out, err := runStreaming(ctx, updateLogPath(), "powershell",
		[]string{"-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script}, onLine)
	if onProgress != nil {
		onProgress(out)
	}

	if ctx.Err() == context.DeadlineExceeded {
		return Result{Status: "failed", Output: out + "\n[Timeout - Vorgang abgebrochen]"}
	}
	if err != nil {
		return Result{Status: "failed", Output: out + "\n" + err.Error()}
	}
	return Result{Status: "completed", Output: out}
}

// windowsUpdateScript builds a PowerShell script that installs pending Windows
// updates via the PSWindowsUpdate module (installing it on first use). This is
// far more reliable from a service context than the raw WUA COM Install() call,
// and emits line-by-line progress that the agent streams to the dashboard.
func windowsUpdateScript(reboot bool) string {
	rebootFlag := "-IgnoreReboot"
	if reboot {
		rebootFlag = "-AutoReboot"
	}
	return `$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ProgressPreference = 'SilentlyContinue'
function Log($m) { Write-Output ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) }

Log "Pruefe PSWindowsUpdate-Modul..."
if (-not (Get-Module -ListAvailable -Name PSWindowsUpdate)) {
    Log "Modul nicht vorhanden - installiere PSWindowsUpdate (einmalig)..."
    try { Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -Scope AllUsers -ErrorAction Stop | Out-Null }
    catch { Log ("Hinweis NuGet-Provider: " + $_.Exception.Message) }
    try { Set-PSRepository -Name PSGallery -InstallationPolicy Trusted -ErrorAction SilentlyContinue } catch {}
    try { Install-Module PSWindowsUpdate -Force -Confirm:$false -Scope AllUsers -ErrorAction Stop }
    catch { Log ("FEHLER: PSWindowsUpdate konnte nicht installiert werden: " + $_.Exception.Message); exit 1 }
}
try { Import-Module PSWindowsUpdate -ErrorAction Stop } catch { Log ("FEHLER beim Laden des Moduls: " + $_.Exception.Message); exit 1 }

Log "Suche nach verfuegbaren Updates..."
$updates = @(Get-WindowsUpdate -ErrorAction SilentlyContinue)
if ($updates.Count -eq 0) {
    Log "Keine Updates verfuegbar."
    exit 0
}
Log ("{0} Update(s) gefunden:" -f $updates.Count)
foreach ($u in $updates) { Log ("  - " + $u.Title) }

Log "Starte Download und Installation..."
Get-WindowsUpdate -Install -AcceptAll ` + rebootFlag + ` -Confirm:$false -Verbose 4>&1 | Out-String -Stream | ForEach-Object { if ($_ -and $_.Trim()) { Log $_ } }
Log "Windows-Update abgeschlossen."
`
}

// linuxUpdateScript builds a shell script that upgrades all packages, optionally
// rebooting afterwards if the distro signals it is required.
func linuxUpdateScript(reboot bool) string {
	var script string
	if _, err := exec.LookPath("apt-get"); err == nil {
		script = "export DEBIAN_FRONTEND=noninteractive; echo 'Aktualisiere Paketlisten...'; apt-get update && echo 'Installiere Upgrades...' && apt-get -y upgrade"
		if reboot {
			script += " && { if [ -f /var/run/reboot-required ]; then echo 'Neustart erforderlich...'; shutdown -r +1 'UniCentral: Reboot after updates'; else echo 'Kein Neustart erforderlich.'; fi; }"
		}
	} else {
		script = "echo 'Installiere Upgrades...'; dnf -y upgrade"
		if reboot {
			script += " && { if needs-restarting -r >/dev/null 2>&1; then echo 'Kein Neustart erforderlich.'; else echo 'Neustart erforderlich...'; shutdown -r +1 'UniCentral: Reboot after updates'; fi; }"
		}
	}
	return script
}

func execScheduleUpdates(params map[string]interface{}) Result {
	scheduleTime, _ := params["time"].(string)
	if scheduleTime == "" {
		return Result{Status: "failed", Output: "no time specified (format: HH:MM)"}
	}

	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		psScript := "$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -NonInteractive -Command Install-Module PSWindowsUpdate -Force -Confirm:$false -Scope AllUsers; Import-Module PSWindowsUpdate; Get-WindowsUpdate -Install -AcceptAll -AutoReboot -Confirm:$false'; " +
			"$trigger = New-ScheduledTaskTrigger -Once -At '" + scheduleTime + "'; " +
			"$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable; " +
			"Register-ScheduledTask -TaskName 'UniCentral-WindowsUpdate' -Action $action -Trigger $trigger -Settings $settings -User 'SYSTEM' -RunLevel Highest -Force"
		cmd = exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", psScript)
	} else {
		// Create a one-time cron via at command
		script := "apt-get update && apt-get upgrade -y && reboot"
		if _, err := exec.LookPath("dnf"); err == nil {
			script = "dnf upgrade -y && reboot"
		}
		cmd = exec.Command("bash", "-c", fmt.Sprintf(`echo '%s' | at %s`, script, scheduleTime))
	}

	out, err := cmd.CombinedOutput()
	if err != nil {
		return Result{Status: "failed", Output: string(out) + "\n" + err.Error()}
	}
	return Result{Status: "completed", Output: fmt.Sprintf("Updates scheduled for %s\n%s", scheduleTime, string(out))}
}
