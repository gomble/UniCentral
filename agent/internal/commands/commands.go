package commands

import (
	"fmt"
	"os/exec"
	"runtime"

	"github.com/unicentral/agent/internal/updater"
)

type Result struct {
	Status string `json:"status"`
	Output string `json:"output"`
}

func Execute(cmdType string, params map[string]interface{}) Result {
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
		return execTriggerUpdates()
	case "trigger_updates_reboot":
		return execTriggerUpdatesReboot()
	case "schedule_updates":
		return execScheduleUpdates(params)
	case "deploy_neighbor":
		return execDeployNeighbor(params)
	case "update_agent":
		return execUpdateAgent(params)
	case "scan_network":
		return execScanNetwork(params)
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
		return Result{Status: "failed", Output: "no download_url provided"}
	}

	err := updater.Update(downloadURL)
	if err != nil {
		return Result{Status: "failed", Output: err.Error()}
	}
	return Result{Status: "completed", Output: "Agent update initiated, restarting..."}
}

func execTriggerUpdates() Result {
	return execTriggerUpdatesReboot()
}

func execTriggerUpdatesReboot() Result {
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		script := `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ProgressPreference = 'SilentlyContinue'
Write-Output "Creating Windows Update session..."
$session = New-Object -ComObject Microsoft.Update.Session
$searcher = $session.CreateUpdateSearcher()

Write-Output "Searching for updates..."
$result = $searcher.Search("IsInstalled=0 AND Type='Software'")
$updates = $result.Updates

if ($updates.Count -eq 0) {
    Write-Output "No updates available."
    exit 0
}

Write-Output "$($updates.Count) update(s) found:"
foreach ($u in $updates) { Write-Output "  - $($u.Title)" }

Write-Output ""
Write-Output "Downloading..."
$downloader = $session.CreateUpdateDownloader()
$downloader.Updates = $updates
$downloader.Download() | Out-Null

Write-Output "Installing..."
$installer = $session.CreateUpdateInstaller()
$installer.Updates = $updates
$installResult = $installer.Install()

Write-Output ""
Write-Output "Result: $($installResult.ResultCode)"
for ($i = 0; $i -lt $updates.Count; $i++) {
    $r = $installResult.GetUpdateResult($i)
    Write-Output "  [$($r.ResultCode)] $($updates.Item($i).Title)"
}

if ($installResult.RebootRequired) {
    Write-Output ""
    Write-Output "Reboot required - restarting in 60 seconds..."
    shutdown /r /t 60 /c "UniCentral: Neustart nach Windows Update"
} else {
    Write-Output ""
    Write-Output "No reboot required."
}
`
		cmd = exec.Command("powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script)
	} else {
		if _, err := exec.LookPath("apt-get"); err == nil {
			cmd = exec.Command("bash", "-c", "apt-get update && apt-get upgrade -y && [ -f /var/run/reboot-required ] && shutdown -r +1 'UniCentral: Reboot after updates' || echo 'No reboot required'")
		} else {
			cmd = exec.Command("bash", "-c", "dnf upgrade -y && needs-restarting -r || shutdown -r +1 'UniCentral: Reboot after updates'")
		}
	}

	out, err := cmd.CombinedOutput()
	if err != nil {
		return Result{Status: "failed", Output: string(out) + "\n" + err.Error()}
	}
	return Result{Status: "completed", Output: string(out)}
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
