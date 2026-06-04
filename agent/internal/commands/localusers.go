package commands

import (
	"fmt"
	"os/exec"
	"runtime"
	"strings"
)

func execLocalListUsers(_ map[string]interface{}) Result {
	if runtime.GOOS == "windows" {
		script := psUTF8Prefix + `
try {
    $groupMap = @{}
    Get-LocalGroup | ForEach-Object {
        $gn = $_.Name
        try {
            Get-LocalGroupMember -Group $gn -ErrorAction SilentlyContinue | ForEach-Object {
                $un = ($_.Name -replace '^.*\\', '')
                if (-not $groupMap[$un]) { $groupMap[$un] = [System.Collections.Generic.List[string]]::new() }
                $groupMap[$un].Add($gn)
            }
        } catch {}
    }
    $arr = @(Get-LocalUser | ForEach-Object {
        $grps = if ($groupMap[$_.Name]) { @($groupMap[$_.Name]) } else { @() }
        [PSCustomObject]@{
            name                   = $_.Name
            full_name              = [string]$_.FullName
            description            = [string]$_.Description
            enabled                = [bool]$_.Enabled
            password_never_expires = [bool]$_.PasswordNeverExpires
            groups                 = $grps
        }
    })
    if ($arr.Count -eq 1) { @($arr) | ConvertTo-Json -Depth 4 -Compress }
    else { $arr | ConvertTo-Json -Depth 4 -Compress }
} catch { Write-Error $_.Exception.Message; exit 1 }`
		out, err := exec.Command("powershell", "-NoProfile", "-NonInteractive",
			"-ExecutionPolicy", "Bypass", "-Command", script).CombinedOutput()
		if err != nil {
			return Result{Status: "failed", Output: strings.TrimSpace(string(out)) + "\n" + err.Error()}
		}
		return Result{Status: "completed", Output: strings.TrimSpace(string(out))}
	}
	script := `python3 -c "
import subprocess,json
users=[]
for line in open('/etc/passwd'):
    p=line.strip().split(':')
    if len(p)<7: continue
    try: uid=int(p[2])
    except: continue
    if uid<1000 and p[0]!='root': continue
    g=subprocess.run(['id','-nG',p[0]],capture_output=True,text=True).stdout.strip().split()
    users.append({'name':p[0],'full_name':(p[4].split(',')[0] if p[4] else ''),'uid':uid,'home':p[5],'shell':p[6],'enabled':True,'groups':g})
print(json.dumps(users))
" 2>/dev/null`
	out, err := exec.Command("bash", "-c", script).CombinedOutput()
	if err != nil {
		return Result{Status: "failed", Output: strings.TrimSpace(string(out)) + "\n" + err.Error()}
	}
	return Result{Status: "completed", Output: strings.TrimSpace(string(out))}
}

func execLocalListGroups(_ map[string]interface{}) Result {
	if runtime.GOOS == "windows" {
		script := psUTF8Prefix + `
try {
    $arr = @(Get-LocalGroup | ForEach-Object {
        [PSCustomObject]@{ name = $_.Name; description = [string]$_.Description }
    })
    if ($arr.Count -eq 1) { @($arr) | ConvertTo-Json -Compress }
    else { $arr | ConvertTo-Json -Compress }
} catch { Write-Error $_.Exception.Message; exit 1 }`
		out, err := exec.Command("powershell", "-NoProfile", "-NonInteractive",
			"-ExecutionPolicy", "Bypass", "-Command", script).CombinedOutput()
		if err != nil {
			return Result{Status: "failed", Output: strings.TrimSpace(string(out)) + "\n" + err.Error()}
		}
		return Result{Status: "completed", Output: strings.TrimSpace(string(out))}
	}
	script := `python3 -c "
import json
groups=[]
for line in open('/etc/group'):
    p=line.strip().split(':')
    if len(p)<4: continue
    try: gid=int(p[2])
    except: continue
    if gid>=1000 or p[0] in ['sudo','wheel','adm','docker','staff']:
        groups.append({'name':p[0],'gid':gid,'description':''})
print(json.dumps(groups))
" 2>/dev/null`
	out, err := exec.Command("bash", "-c", script).CombinedOutput()
	if err != nil {
		return Result{Status: "failed", Output: strings.TrimSpace(string(out)) + "\n" + err.Error()}
	}
	return Result{Status: "completed", Output: strings.TrimSpace(string(out))}
}

func execLocalCreateUser(params map[string]interface{}) Result {
	name, _ := params["name"].(string)
	password, _ := params["password"].(string)
	if name == "" || password == "" {
		return Result{Status: "failed", Output: "name und password erforderlich"}
	}
	fullName, _ := params["full_name"].(string)
	description, _ := params["description"].(string)
	enabled := true
	if v, ok := params["enabled"].(bool); ok {
		enabled = v
	}
	pne, _ := params["password_never_expires"].(bool)

	if runtime.GOOS == "windows" {
		script := fmt.Sprintf(psUTF8Prefix+`
try {
    $pass = ConvertTo-SecureString '%s' -AsPlainText -Force
    New-LocalUser -Name '%s' -Password $pass -FullName '%s' -Description '%s' -AccountNeverExpires -PasswordNeverExpires:$%s -ErrorAction Stop
`,
			escapePS(password), escapePS(name), escapePS(fullName), escapePS(description), boolStr(pne))
		if !enabled {
			script += fmt.Sprintf("    Disable-LocalUser -Name '%s' -ErrorAction Stop\n", escapePS(name))
		}
		if groups, ok := params["groups"].([]interface{}); ok {
			for _, g := range groups {
				if gn, ok := g.(string); ok && gn != "" {
					script += fmt.Sprintf("    Add-LocalGroupMember -Group '%s' -Member '%s' -ErrorAction SilentlyContinue\n", escapePS(gn), escapePS(name))
				}
			}
		}
		script += fmt.Sprintf("    Write-Output 'Benutzer erstellt: %s'\n} catch { Write-Error $_.Exception.Message; exit 1 }", name)
		out, err := exec.Command("powershell", "-NoProfile", "-NonInteractive",
			"-ExecutionPolicy", "Bypass", "-Command", script).CombinedOutput()
		if err != nil {
			return Result{Status: "failed", Output: strings.TrimSpace(string(out)) + "\n" + err.Error()}
		}
		return Result{Status: "completed", Output: strings.TrimSpace(string(out))}
	}
	qs := func(s string) string { return strings.ReplaceAll(s, "'", "'\\''") }
	script := fmt.Sprintf("set -e\nuseradd -m -c '%s' '%s' 2>&1\necho '%s:%s' | chpasswd\n",
		qs(fullName), qs(name), qs(name), qs(password))
	if !enabled {
		script += fmt.Sprintf("usermod -L '%s'\n", qs(name))
	}
	if groups, ok := params["groups"].([]interface{}); ok {
		for _, g := range groups {
			if gn, ok := g.(string); ok && gn != "" {
				script += fmt.Sprintf("usermod -aG '%s' '%s'\n", qs(gn), qs(name))
			}
		}
	}
	script += fmt.Sprintf("echo 'Benutzer erstellt: %s'", name)
	out, err := exec.Command("bash", "-c", script).CombinedOutput()
	if err != nil {
		return Result{Status: "failed", Output: strings.TrimSpace(string(out)) + "\n" + err.Error()}
	}
	return Result{Status: "completed", Output: strings.TrimSpace(string(out))}
}

func execLocalUpdateUser(params map[string]interface{}) Result {
	name, _ := params["name"].(string)
	if name == "" {
		return Result{Status: "failed", Output: "name erforderlich"}
	}
	if runtime.GOOS == "windows" {
		script := fmt.Sprintf(psUTF8Prefix+"try {\n    $p = @{ Name = '%s' }\n", escapePS(name))
		if fn, ok := params["full_name"].(string); ok {
			script += fmt.Sprintf("    $p['FullName'] = '%s'\n", escapePS(fn))
		}
		if desc, ok := params["description"].(string); ok {
			script += fmt.Sprintf("    $p['Description'] = '%s'\n", escapePS(desc))
		}
		script += "    Set-LocalUser @p -ErrorAction Stop\n"
		if v, ok := params["enabled"].(bool); ok {
			if v {
				script += fmt.Sprintf("    Enable-LocalUser -Name '%s'\n", escapePS(name))
			} else {
				script += fmt.Sprintf("    Disable-LocalUser -Name '%s'\n", escapePS(name))
			}
		}
		if v, ok := params["password_never_expires"].(bool); ok {
			script += fmt.Sprintf("    Set-LocalUser -Name '%s' -PasswordNeverExpires:$%s\n", escapePS(name), boolStr(v))
		}
		if pw, ok := params["password"].(string); ok && pw != "" {
			script += fmt.Sprintf("    $pass = ConvertTo-SecureString '%s' -AsPlainText -Force; Set-LocalUser -Name '%s' -Password $pass\n", escapePS(pw), escapePS(name))
		}
		if add, ok := params["add_groups"].([]interface{}); ok {
			for _, g := range add {
				if gn, ok := g.(string); ok && gn != "" {
					script += fmt.Sprintf("    Add-LocalGroupMember -Group '%s' -Member '%s' -ErrorAction SilentlyContinue\n", escapePS(gn), escapePS(name))
				}
			}
		}
		if rem, ok := params["remove_groups"].([]interface{}); ok {
			for _, g := range rem {
				if gn, ok := g.(string); ok && gn != "" {
					script += fmt.Sprintf("    Remove-LocalGroupMember -Group '%s' -Member '%s' -ErrorAction SilentlyContinue\n", escapePS(gn), escapePS(name))
				}
			}
		}
		script += fmt.Sprintf("    Write-Output 'Benutzer aktualisiert: %s'\n} catch { Write-Error $_.Exception.Message; exit 1 }", name)
		out, err := exec.Command("powershell", "-NoProfile", "-NonInteractive",
			"-ExecutionPolicy", "Bypass", "-Command", script).CombinedOutput()
		if err != nil {
			return Result{Status: "failed", Output: strings.TrimSpace(string(out)) + "\n" + err.Error()}
		}
		return Result{Status: "completed", Output: strings.TrimSpace(string(out))}
	}
	qs := func(s string) string { return strings.ReplaceAll(s, "'", "'\\''") }
	script := "set -e\n"
	if fn, ok := params["full_name"].(string); ok {
		script += fmt.Sprintf("usermod -c '%s' '%s'\n", qs(fn), qs(name))
	}
	if pw, ok := params["password"].(string); ok && pw != "" {
		script += fmt.Sprintf("echo '%s:%s' | chpasswd\n", qs(name), qs(pw))
	}
	if v, ok := params["enabled"].(bool); ok {
		if v {
			script += fmt.Sprintf("usermod -U '%s'\n", qs(name))
		} else {
			script += fmt.Sprintf("usermod -L '%s'\n", qs(name))
		}
	}
	if add, ok := params["add_groups"].([]interface{}); ok {
		for _, g := range add {
			if gn, ok := g.(string); ok && gn != "" {
				script += fmt.Sprintf("usermod -aG '%s' '%s'\n", qs(gn), qs(name))
			}
		}
	}
	if rem, ok := params["remove_groups"].([]interface{}); ok {
		for _, g := range rem {
			if gn, ok := g.(string); ok && gn != "" {
				script += fmt.Sprintf("gpasswd -d '%s' '%s' 2>/dev/null || true\n", qs(name), qs(gn))
			}
		}
	}
	script += fmt.Sprintf("echo 'Benutzer aktualisiert: %s'", name)
	out, err := exec.Command("bash", "-c", script).CombinedOutput()
	if err != nil {
		return Result{Status: "failed", Output: strings.TrimSpace(string(out)) + "\n" + err.Error()}
	}
	return Result{Status: "completed", Output: strings.TrimSpace(string(out))}
}

func execLocalDeleteUser(params map[string]interface{}) Result {
	name, _ := params["name"].(string)
	if name == "" {
		return Result{Status: "failed", Output: "name erforderlich"}
	}
	if runtime.GOOS == "windows" {
		script := fmt.Sprintf(psUTF8Prefix+`
try {
    Remove-LocalUser -Name '%s' -ErrorAction Stop
    Write-Output 'Benutzer geloescht: %s'
} catch { Write-Error $_.Exception.Message; exit 1 }`, escapePS(name), name)
		out, err := exec.Command("powershell", "-NoProfile", "-NonInteractive",
			"-ExecutionPolicy", "Bypass", "-Command", script).CombinedOutput()
		if err != nil {
			return Result{Status: "failed", Output: strings.TrimSpace(string(out)) + "\n" + err.Error()}
		}
		return Result{Status: "completed", Output: strings.TrimSpace(string(out))}
	}
	qs := strings.ReplaceAll(name, "'", "'\\''")
	out, err := exec.Command("bash", "-c",
		fmt.Sprintf("userdel -r '%s' 2>&1 && echo 'Benutzer geloescht: %s'", qs, name)).CombinedOutput()
	if err != nil {
		return Result{Status: "failed", Output: strings.TrimSpace(string(out)) + "\n" + err.Error()}
	}
	return Result{Status: "completed", Output: strings.TrimSpace(string(out))}
}
