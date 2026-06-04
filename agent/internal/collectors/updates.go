package collectors

import (
	"os/exec"
	"runtime"
	"strings"
)

type UpdateStatus struct {
	Available      int      `json:"available"`
	Pending        []string `json:"pending"`
	LastCheck      string   `json:"last_check"`
	RebootRequired bool     `json:"reboot_required"`
}

func GetUpdateStatus() UpdateStatus {
	if runtime.GOOS == "windows" {
		return getWindowsUpdates()
	}
	return getLinuxUpdates()
}

func getWindowsUpdates() UpdateStatus {
	status := UpdateStatus{}

	out, err := exec.Command("powershell", "-Command", `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Session = New-Object -ComObject Microsoft.Update.Session
$Searcher = $Session.CreateUpdateSearcher()
try {
    $Results = $Searcher.Search("IsInstalled=0 AND Type='Software'")
    $Results.Updates | ForEach-Object { $_.Title }
} catch {}
`).Output()
	if err == nil {
		lines := strings.Split(strings.TrimSpace(string(out)), "\n")
		for _, line := range lines {
			line = strings.TrimSpace(line)
			if line != "" {
				status.Pending = append(status.Pending, line)
			}
		}
		status.Available = len(status.Pending)
	}

	// Check reboot required
	rebootOut, err := exec.Command("powershell", "-Command",
		"Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired'").Output()
	if err == nil && strings.Contains(strings.ToLower(string(rebootOut)), "true") {
		status.RebootRequired = true
	}

	return status
}

func getLinuxUpdates() UpdateStatus {
	status := UpdateStatus{}

	// Try apt
	out, err := exec.Command("apt", "list", "--upgradable").Output()
	if err == nil {
		lines := strings.Split(string(out), "\n")
		for _, line := range lines {
			if strings.Contains(line, "upgradable") || strings.Contains(line, "/") {
				parts := strings.Split(line, "/")
				if len(parts) > 0 && parts[0] != "Listing..." {
					status.Pending = append(status.Pending, parts[0])
				}
			}
		}
		status.Available = len(status.Pending)

		// Check reboot required
		if _, err := exec.Command("test", "-f", "/var/run/reboot-required").Output(); err == nil {
			status.RebootRequired = true
		}
		return status
	}

	// Try dnf
	out, err = exec.Command("dnf", "check-update", "--quiet").Output()
	if err == nil || len(out) > 0 {
		lines := strings.Split(strings.TrimSpace(string(out)), "\n")
		for _, line := range lines {
			fields := strings.Fields(line)
			if len(fields) >= 1 && fields[0] != "" {
				status.Pending = append(status.Pending, fields[0])
			}
		}
		status.Available = len(status.Pending)
	}

	return status
}
