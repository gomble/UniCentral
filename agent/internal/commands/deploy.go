package commands

import (
	"fmt"
	"os/exec"
	"runtime"
	"strings"
)

func execDeployNeighbor(params map[string]interface{}) Result {
	targetIP, _ := params["target_ip"].(string)
	username, _ := params["username"].(string)
	password, _ := params["password"].(string)
	targetOS, _ := params["target_os"].(string)
	serverURL, _ := params["server_url"].(string)
	enrollmentKey, _ := params["enrollment_key"].(string)
	category, _ := params["category"].(string)

	if targetIP == "" || username == "" || serverURL == "" || enrollmentKey == "" {
		return Result{Status: "failed", Output: "missing required parameters (target_ip, username, server_url, enrollment_key)"}
	}
	if category == "" {
		category = "client"
	}
	if targetOS == "" {
		targetOS = "windows"
	}

	if targetOS == "windows" {
		return deployWindows(targetIP, username, password, serverURL, enrollmentKey, category)
	}
	return deployLinux(targetIP, username, password, serverURL, enrollmentKey, category)
}

func deployWindows(ip, user, pass, serverURL, key, category string) Result {
	// Use PowerShell remoting via WinRM
	script := fmt.Sprintf(`$ErrorActionPreference = "Stop"
$Server = "%s"
$Key = "%s"
$Category = "%s"
$InstallDir = "C:\Program Files\UniCentral"
$ConfigDir = "C:\ProgramData\UniCentral"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
Invoke-WebRequest -Uri "$Server/api/agent/download/windows/amd64" -OutFile "$InstallDir\unicentral-agent.exe" -UseBasicParsing
@{server=$Server;enrollment_key=$Key;category=$Category} | ConvertTo-Json | Set-Content "$ConfigDir\config.json"
& "$InstallDir\unicentral-agent.exe" --install --config "$ConfigDir\config.json"
Start-Service UniCentralAgent
Write-Output "OK"`, serverURL, key, category)

	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		// From Windows to Windows - use Invoke-Command
		psCmd := fmt.Sprintf(`$pass = ConvertTo-SecureString '%s' -AsPlainText -Force; $cred = New-Object System.Management.Automation.PSCredential('%s', $pass); Invoke-Command -ComputerName '%s' -Credential $cred -ScriptBlock { %s }`,
			escapePS(pass), user, ip, script)
		cmd = exec.Command("powershell", "-Command", psCmd)
	} else {
		// From Linux to Windows - use winrs or powershell over SSH (less common)
		return Result{Status: "failed", Output: "cross-OS deployment (Linux->Windows) not yet supported, use a Windows relay agent"}
	}

	out, err := cmd.CombinedOutput()
	if err != nil {
		return Result{Status: "failed", Output: string(out) + "\n" + err.Error()}
	}
	if strings.Contains(string(out), "OK") {
		return Result{Status: "completed", Output: fmt.Sprintf("Agent deployed to %s", ip)}
	}
	return Result{Status: "failed", Output: string(out)}
}

func deployLinux(ip, user, pass, serverURL, key, category string) Result {
	script := fmt.Sprintf(`curl -sL '%s/api/agent/install-script/linux?key=%s&category=%s' | bash`, serverURL, key, category)

	var cmd *exec.Cmd
	if pass != "" {
		// Use sshpass for password auth
		cmd = exec.Command("sshpass", "-p", pass, "ssh", "-o", "StrictHostKeyChecking=no", fmt.Sprintf("%s@%s", user, ip), script)
	} else {
		// Key-based auth
		cmd = exec.Command("ssh", "-o", "StrictHostKeyChecking=no", fmt.Sprintf("%s@%s", user, ip), script)
	}

	out, err := cmd.CombinedOutput()
	if err != nil {
		return Result{Status: "failed", Output: string(out) + "\n" + err.Error()}
	}
	return Result{Status: "completed", Output: fmt.Sprintf("Agent deployed to %s\n%s", ip, string(out))}
}

func escapePS(s string) string {
	s = strings.ReplaceAll(s, "'", "''")
	return s
}
