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
	if runtime.GOOS != "windows" {
		return Result{Status: "failed", Output: "cross-OS deployment (Linux->Windows) not supported, use a Windows relay agent"}
	}

	jsonConfig := fmt.Sprintf(`{"server":"%s","enrollment_key":"%s","category":"%s"}`,
		strings.ReplaceAll(serverURL, `"`, `\"`),
		strings.ReplaceAll(key, `"`, `\"`),
		strings.ReplaceAll(category, `"`, `\"`))

	remoteScript := fmt.Sprintf(`
$ErrorActionPreference = "Stop"
$Server = "%s"
$InstallDir = "C:\Program Files\UniCentral"
$ConfigDir  = "C:\ProgramData\UniCentral"

$svc = Get-Service UniCentralAgent -ErrorAction SilentlyContinue
if ($svc) {
    Stop-Service UniCentralAgent -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    if (Test-Path "$InstallDir\unicentral-agent.exe") {
        & "$InstallDir\unicentral-agent.exe" --uninstall 2>$null
        Start-Sleep -Seconds 1
    }
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path $ConfigDir  | Out-Null

Invoke-WebRequest -Uri "$Server/api/agent/download/windows/amd64" -OutFile "$InstallDir\unicentral-agent.exe" -UseBasicParsing

$json = '%s'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText("$ConfigDir\config.json", $json, $utf8NoBom)

& "$InstallDir\unicentral-agent.exe" --install --config "$ConfigDir\config.json"
Start-Sleep -Seconds 1
Start-Service UniCentralAgent
Write-Output "DEPLOYED_OK"
`, serverURL, escapePS(jsonConfig))

	psCmd := fmt.Sprintf(
		`$pass = ConvertTo-SecureString '%s' -AsPlainText -Force; `+
			`$cred = New-Object System.Management.Automation.PSCredential('%s', $pass); `+
			`Invoke-Command -ComputerName '%s' -Credential $cred -ScriptBlock { %s }`,
		escapePS(pass), escapePS(user), ip, remoteScript)

	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", psCmd)
	out, err := cmd.CombinedOutput()
	output := strings.TrimSpace(string(out))

	if err != nil {
		hint := ""
		if strings.Contains(output, "WinRM") || strings.Contains(output, "WSMan") || strings.Contains(err.Error(), "exit") {
			hint = "\n\nHINWEIS: WinRM muss auf dem Zielrechner aktiv sein.\nAls Admin auf dem Ziel ausfuehren: Enable-PSRemoting -Force"
		}
		return Result{Status: "failed", Output: output + "\n" + err.Error() + hint}
	}
	if strings.Contains(output, "DEPLOYED_OK") {
		return Result{Status: "completed", Output: fmt.Sprintf("Agent erfolgreich deployt auf %s", ip)}
	}
	return Result{Status: "failed", Output: output}
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
