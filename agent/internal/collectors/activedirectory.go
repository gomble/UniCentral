package collectors

import (
	"os/exec"
	"runtime"
	"strings"
)

type DomainControllerInfo struct {
	IsDomainController bool   `json:"is_domain_controller"`
	DomainName         string `json:"domain_name"`
}

func GetDomainControllerInfo() DomainControllerInfo {
	if runtime.GOOS != "windows" {
		return DomainControllerInfo{}
	}

	out, err := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command",
		"(Get-WmiObject Win32_ComputerSystem).DomainRole").Output()
	if err != nil {
		return DomainControllerInfo{}
	}

	// DomainRole 4 = BackupDomainController, 5 = PrimaryDomainController
	role := strings.TrimSpace(string(out))
	if role != "4" && role != "5" {
		return DomainControllerInfo{}
	}

	domainOut, _ := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command",
		"(Get-WmiObject Win32_ComputerSystem).Domain").Output()

	return DomainControllerInfo{
		IsDomainController: true,
		DomainName:         strings.TrimSpace(string(domainOut)),
	}
}
