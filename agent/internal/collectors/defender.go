package collectors

import (
	"os/exec"
	"runtime"
	"strings"
)

type DefenderStatus struct {
	Installed       bool   `json:"installed"`
	Enabled         bool   `json:"enabled"`
	RealTimeEnabled bool   `json:"real_time_enabled"`
	LastScanTime    string `json:"last_scan_time"`
	LastScanType    string `json:"last_scan_type"`
	EngineVersion   string `json:"engine_version"`
	DefVersion      string `json:"definition_version"`
}

func GetDefenderStatus() DefenderStatus {
	if runtime.GOOS != "windows" {
		return DefenderStatus{}
	}
	return getWindowsDefender()
}

func getWindowsDefender() DefenderStatus {
	status := DefenderStatus{}

	out, err := exec.Command("powershell", "-NoProfile", "-Command",
		`[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; `+
			`try { $s = Get-MpComputerStatus -ErrorAction Stop; `+
			`Write-Output ("INSTALLED=true"); `+
			`Write-Output ("AMServiceEnabled=" + $s.AMServiceEnabled.ToString()); `+
			`Write-Output ("RealTimeProtectionEnabled=" + $s.RealTimeProtectionEnabled.ToString()); `+
			`Write-Output ("AMEngineVersion=" + $s.AMEngineVersion); `+
			`Write-Output ("AntivirusSignatureVersion=" + $s.AntivirusSignatureVersion); `+
			`if ($s.QuickScanEndTime) { Write-Output ("QuickScanEndTime=" + $s.QuickScanEndTime.ToString("yyyy-MM-ddTHH:mm:ss")) }; `+
			`if ($s.FullScanEndTime) { Write-Output ("FullScanEndTime=" + $s.FullScanEndTime.ToString("yyyy-MM-ddTHH:mm:ss")) }; `+
			`} catch { Write-Output "INSTALLED=false" }`).Output()
	if err != nil {
		return status
	}

	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}
		key := parts[0]
		val := parts[1]
		switch key {
		case "INSTALLED":
			status.Installed = val == "true"
		case "AMServiceEnabled":
			status.Enabled = strings.ToLower(val) == "true"
		case "RealTimeProtectionEnabled":
			status.RealTimeEnabled = strings.ToLower(val) == "true"
		case "AMEngineVersion":
			status.EngineVersion = val
		case "AntivirusSignatureVersion":
			status.DefVersion = val
		case "QuickScanEndTime":
			if status.LastScanTime == "" {
				status.LastScanTime = val
				status.LastScanType = "Quick"
			}
		case "FullScanEndTime":
			if val != "" {
				if status.LastScanTime == "" || val > status.LastScanTime {
					status.LastScanTime = val
					status.LastScanType = "Full"
				}
			}
		}
	}

	return status
}
