package collectors

import (
	"os/exec"
	"runtime"
	"strings"
)

type ShareInfo struct {
	Name        string `json:"name"`
	Path        string `json:"path"`
	Description string `json:"description"`
}

func GetShares() []ShareInfo {
	if runtime.GOOS == "windows" {
		return getWindowsShares()
	}
	return getLinuxShares()
}

func getWindowsShares() []ShareInfo {
	var shares []ShareInfo

	out, err := exec.Command("powershell", "-Command",
		"Get-SmbShare | Select-Object Name, Path, Description | ConvertTo-Csv -NoTypeInformation").Output()
	if err != nil {
		return shares
	}

	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	for i, line := range lines {
		if i == 0 {
			continue
		}
		parts := parseCSVLine(line)
		if len(parts) < 3 {
			continue
		}
		shares = append(shares, ShareInfo{
			Name:        strings.Trim(parts[0], "\""),
			Path:        strings.Trim(parts[1], "\""),
			Description: strings.Trim(parts[2], "\""),
		})
	}

	return shares
}

func getLinuxShares() []ShareInfo {
	var shares []ShareInfo

	out, err := exec.Command("smbstatus", "--shares", "--no-resolve").Output()
	if err != nil {
		return shares
	}

	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 && fields[0] != "Service" && !strings.HasPrefix(line, "-") {
			shares = append(shares, ShareInfo{
				Name: fields[0],
				Path: fields[1],
			})
		}
	}

	return shares
}
