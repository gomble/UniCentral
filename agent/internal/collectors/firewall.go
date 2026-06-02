package collectors

import (
	"os/exec"
	"runtime"
	"strings"
)

type FirewallStatus struct {
	Enabled bool           `json:"enabled"`
	Rules   []FirewallRule `json:"rules"`
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
	if strings.Contains(strings.ToLower(string(out)), "on") {
		status.Enabled = true
	}

	rulesOut, err := exec.Command("powershell", "-Command",
		"Get-NetFirewallRule | Where-Object {$_.Enabled -eq 'True'} | Select-Object -First 100 DisplayName, Direction, Action, Enabled | ConvertTo-Csv -NoTypeInformation").Output()
	if err != nil {
		return status
	}

	lines := strings.Split(strings.TrimSpace(string(rulesOut)), "\n")
	for i, line := range lines {
		if i == 0 {
			continue
		}
		parts := parseCSVLine(line)
		if len(parts) < 4 {
			continue
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
			Name:      strings.Trim(parts[0], "\""),
			Direction: direction,
			Action:    action,
			Enabled:   true,
		})
	}

	return status
}

func getLinuxFirewall() FirewallStatus {
	status := FirewallStatus{Enabled: false}

	// Check ufw
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
		return status
	}

	// Fallback: iptables
	out, err = exec.Command("iptables", "-L", "-n", "--line-numbers").Output()
	if err == nil && len(out) > 0 {
		status.Enabled = true
	}

	return status
}
