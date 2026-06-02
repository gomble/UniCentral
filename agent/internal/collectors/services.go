package collectors

import (
	"os/exec"
	"runtime"
	"strings"
)

type ServiceInfo struct {
	Name        string `json:"name"`
	DisplayName string `json:"display_name"`
	Status      string `json:"status"`
	StartType   string `json:"start_type"`
}

func GetServices() []ServiceInfo {
	if runtime.GOOS == "windows" {
		return getWindowsServices()
	}
	return getLinuxServices()
}

func getWindowsServices() []ServiceInfo {
	var services []ServiceInfo

	out, err := exec.Command("powershell", "-Command",
		"Get-Service | Select-Object Name, DisplayName, Status, StartType | ConvertTo-Csv -NoTypeInformation").Output()
	if err != nil {
		return services
	}

	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	for i, line := range lines {
		if i == 0 {
			continue
		}
		parts := parseCSVLine(line)
		if len(parts) < 4 {
			continue
		}
		services = append(services, ServiceInfo{
			Name:        strings.Trim(parts[0], "\""),
			DisplayName: strings.Trim(parts[1], "\""),
			Status:      strings.ToLower(strings.Trim(parts[2], "\"")),
			StartType:   strings.ToLower(strings.Trim(parts[3], "\"")),
		})
	}

	return services
}

func getLinuxServices() []ServiceInfo {
	var services []ServiceInfo

	out, err := exec.Command("systemctl", "list-units", "--type=service", "--all", "--no-pager", "--no-legend").Output()
	if err != nil {
		return services
	}

	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}
		name := strings.TrimSuffix(fields[0], ".service")
		status := "stopped"
		if fields[3] == "running" {
			status = "running"
		} else if fields[2] == "failed" {
			status = "failed"
		}

		services = append(services, ServiceInfo{
			Name:        name,
			DisplayName: name,
			Status:      status,
			StartType:   "auto",
		})
	}

	return services
}

func parseCSVLine(line string) []string {
	var fields []string
	var current strings.Builder
	inQuote := false

	for _, r := range line {
		switch {
		case r == '"':
			inQuote = !inQuote
			current.WriteRune(r)
		case r == ',' && !inQuote:
			fields = append(fields, current.String())
			current.Reset()
		default:
			current.WriteRune(r)
		}
	}
	fields = append(fields, current.String())
	return fields
}
