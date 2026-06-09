package collectors

import (
	"fmt"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
)

type FirewallProfile struct {
	Name    string `json:"name"`
	Enabled bool   `json:"enabled"`
}

type ListeningPort struct {
	Port     int    `json:"port"`
	Protocol string `json:"protocol"`
	Address  string `json:"address"`
	Process  string `json:"process"`
}

type FirewallStatus struct {
	Enabled  bool              `json:"enabled"`
	Profiles []FirewallProfile `json:"profiles"`
	Rules    []FirewallRule    `json:"rules"`
	Ports    []ListeningPort   `json:"ports"`
}

type FirewallRule struct {
	Name      string `json:"name"`
	Direction string `json:"direction"`
	Action    string `json:"action"`
	Protocol  string `json:"protocol"`
	Port      string `json:"port"`
	Enabled   bool   `json:"enabled"`
}

func GetFirewallStatus() FirewallStatus {
	if runtime.GOOS == "windows" {
		return getWindowsFirewall()
	}
	return getLinuxFirewall()
}

func getWindowsFirewall() FirewallStatus {
	status := FirewallStatus{Enabled: false}

	out, err := exec.Command("netsh", "advfirewall", "show", "allprofiles", "state").Output()
	if err != nil {
		return status
	}

	outputStr := string(out)
	profiles := []struct {
		name    string
		keyword string
	}{
		{"Domain", "domain"},
		{"Private", "private"},
		{"Public", "public"},
	}

	activeCount := 0
	lines := strings.Split(outputStr, "\n")
	currentProfile := ""
	for _, line := range lines {
		lower := strings.ToLower(strings.TrimSpace(line))
		for _, p := range profiles {
			if strings.Contains(lower, p.keyword+" profile") || strings.Contains(lower, p.keyword+"-profil") {
				currentProfile = p.name
			}
		}
		if strings.Contains(lower, "state") || strings.Contains(lower, "status") || strings.Contains(lower, "zustand") {
			enabled := strings.Contains(lower, "on") || strings.Contains(lower, "ein")
			if currentProfile != "" {
				status.Profiles = append(status.Profiles, FirewallProfile{
					Name:    currentProfile,
					Enabled: enabled,
				})
				if enabled {
					activeCount++
				}
				currentProfile = ""
			}
		}
	}
	status.Enabled = activeCount > 0

	if len(status.Profiles) == 0 {
		if strings.Contains(strings.ToLower(outputStr), "on") || strings.Contains(strings.ToLower(outputStr), "ein") {
			status.Enabled = true
		}
	}

	rulesOut, err := exec.Command("powershell", "-NoProfile", "-Command",
		`[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; `+
			`Get-NetFirewallRule -Enabled True -Direction Inbound -Action Allow | ForEach-Object { `+
			`$port = ($_ | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue); `+
			`[PSCustomObject]@{Name=$_.DisplayName;Dir=$_.Direction;Act=$_.Action;Proto=$port.Protocol;Port=$port.LocalPort} `+
			`} | Select-Object -First 150 | ConvertTo-Csv -NoTypeInformation`).Output()
	if err == nil {
		rLines := strings.Split(strings.TrimSpace(string(rulesOut)), "\n")
		for i, line := range rLines {
			if i == 0 {
				continue
			}
			parts := parseCSVLine(line)
			if len(parts) < 5 {
				continue
			}
			name := strings.Trim(parts[0], "\"")
			proto := strings.Trim(parts[3], "\"")
			port := strings.Trim(parts[4], "\"")
			if port == "Any" || port == "" {
				port = "*"
			}

			direction := "inbound"
			if strings.Contains(strings.ToLower(strings.Trim(parts[1], "\"")), "outbound") {
				direction = "outbound"
			}
			action := "allow"
			if strings.Contains(strings.ToLower(strings.Trim(parts[2], "\"")), "block") {
				action = "block"
			}

			status.Rules = append(status.Rules, FirewallRule{
				Name:      name,
				Direction: direction,
				Action:    action,
				Protocol:  proto,
				Port:      port,
				Enabled:   true,
			})
		}
	}

	portsOut, err := exec.Command("powershell", "-NoProfile", "-Command",
		`[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; `+
			`Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | `+
			`Select-Object LocalAddress,LocalPort,OwningProcess | `+
			`Sort-Object LocalPort -Unique | ConvertTo-Csv -NoTypeInformation`).Output()
	if err == nil {
		pLines := strings.Split(strings.TrimSpace(string(portsOut)), "\n")
		seen := make(map[int]bool)
		for i, line := range pLines {
			if i == 0 {
				continue
			}
			parts := parseCSVLine(line)
			if len(parts) < 3 {
				continue
			}
			addr := strings.Trim(parts[0], "\"")
			portStr := strings.Trim(parts[1], "\"")
			pidStr := strings.Trim(parts[2], "\"")
			port, _ := strconv.Atoi(portStr)
			if port == 0 || seen[port] {
				continue
			}
			seen[port] = true

			procName := ""
			pid, _ := strconv.Atoi(pidStr)
			if pid > 0 {
				pOut, pErr := exec.Command("powershell", "-NoProfile", "-Command",
					fmt.Sprintf("(Get-Process -Id %d -ErrorAction SilentlyContinue).Name", pid)).Output()
				if pErr == nil {
					procName = strings.TrimSpace(string(pOut))
				}
			}

			status.Ports = append(status.Ports, ListeningPort{
				Port:     port,
				Protocol: "TCP",
				Address:  addr,
				Process:  procName,
			})
		}
	}

	return status
}

func getLinuxFirewall() FirewallStatus {
	status := FirewallStatus{Enabled: false}

	out, err := exec.Command("ufw", "status").Output()
	if err == nil {
		outputStr := string(out)
		if strings.Contains(outputStr, "active") {
			status.Enabled = true
		}

		for _, line := range strings.Split(outputStr, "\n") {
			line = strings.TrimSpace(line)
			if line == "" || strings.HasPrefix(line, "Status") || strings.HasPrefix(line, "To") || strings.HasPrefix(line, "--") {
				continue
			}
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				action := "allow"
				for _, f := range fields {
					if strings.ToLower(f) == "deny" || strings.ToLower(f) == "reject" {
						action = "block"
						break
					}
				}
				status.Rules = append(status.Rules, FirewallRule{
					Name:      fields[0],
					Direction: "inbound",
					Action:    action,
					Port:      fields[0],
					Enabled:   true,
				})
			}
		}
	} else {
		out, err = exec.Command("iptables", "-L", "-n", "--line-numbers").Output()
		if err == nil && len(out) > 0 {
			status.Enabled = true
		}
	}

	portsOut, err := exec.Command("ss", "-tlnp").Output()
	if err == nil {
		for _, line := range strings.Split(string(portsOut), "\n") {
			fields := strings.Fields(line)
			if len(fields) < 5 || fields[0] != "LISTEN" {
				continue
			}
			local := fields[3]
			idx := strings.LastIndex(local, ":")
			if idx < 0 {
				continue
			}
			portStr := local[idx+1:]
			port, _ := strconv.Atoi(portStr)
			if port == 0 {
				continue
			}
			addr := local[:idx]
			procField := ""
			if len(fields) >= 6 {
				procField = fields[5]
			}
			procName := ""
			if strings.Contains(procField, "\"") {
				start := strings.Index(procField, "\"")
				end := strings.Index(procField[start+1:], "\"")
				if end > 0 {
					procName = procField[start+1 : start+1+end]
				}
			}
			status.Ports = append(status.Ports, ListeningPort{
				Port:     port,
				Protocol: "TCP",
				Address:  addr,
				Process:  procName,
			})
		}
	}

	return status
}
