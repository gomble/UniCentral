package commands

import (
	"fmt"
	"os/exec"
	"runtime"
	"strings"
)

const psUTF8Prefix = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n$OutputEncoding = [System.Text.Encoding]::UTF8\n"

func runPSAD(script string) (string, error) {
	if runtime.GOOS != "windows" {
		return "", fmt.Errorf("Active Directory-Befehle sind nur unter Windows verfuegbar")
	}
	out, err := exec.Command("powershell", "-NoProfile", "-NonInteractive",
		"-ExecutionPolicy", "Bypass", "-Command", psUTF8Prefix+script).CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

func boolStr(b bool) string {
	if b {
		return "true"
	}
	return "false"
}

func execADListUsers(_ map[string]interface{}) Result {
	script := `
try {
    Import-Module ActiveDirectory -ErrorAction Stop
    $users = Get-ADUser -Filter * -Properties GivenName,Surname,DisplayName,EmailAddress,Department,Title,Company,Description,OfficePhone,MobilePhone,Enabled,PasswordNeverExpires,CannotChangePassword,MemberOf -ErrorAction Stop
    $arr = @($users | ForEach-Object {
        $groups = @($_.MemberOf | ForEach-Object { try { ($_ -split ',')[0].Substring(3) } catch { '' } } | Where-Object { $_ -ne '' })
        [PSCustomObject]@{
            sam_account_name       = $_.SamAccountName
            given_name             = [string]$_.GivenName
            surname                = [string]$_.Surname
            display_name           = [string]$_.DisplayName
            email                  = [string]$_.EmailAddress
            department             = [string]$_.Department
            title                  = [string]$_.Title
            company                = [string]$_.Company
            description            = [string]$_.Description
            office_phone           = [string]$_.OfficePhone
            mobile_phone           = [string]$_.MobilePhone
            enabled                = [bool]$_.Enabled
            password_never_expires = [bool]$_.PasswordNeverExpires
            cannot_change_password = [bool]$_.CannotChangePassword
            groups                 = $groups
            distinguished_name     = $_.DistinguishedName
        }
    })
    if ($arr.Count -eq 1) { @($arr) | ConvertTo-Json -Depth 4 -Compress }
    else { $arr | ConvertTo-Json -Depth 4 -Compress }
} catch {
    Write-Error $_.Exception.Message
    exit 1
}`
	out, err := runPSAD(script)
	if err != nil {
		return Result{Status: "failed", Output: out + "\n" + err.Error()}
	}
	return Result{Status: "completed", Output: out}
}

func execADListGroups(_ map[string]interface{}) Result {
	script := `
try {
    Import-Module ActiveDirectory -ErrorAction Stop
    $groups = Get-ADGroup -Filter * -Properties Description,GroupCategory,GroupScope -ErrorAction Stop
    $arr = @($groups | ForEach-Object {
        [PSCustomObject]@{
            name               = $_.Name
            sam_account_name   = $_.SamAccountName
            description        = [string]$_.Description
            category           = $_.GroupCategory.ToString()
            scope              = $_.GroupScope.ToString()
            distinguished_name = $_.DistinguishedName
        }
    })
    if ($arr.Count -eq 1) { @($arr) | ConvertTo-Json -Depth 3 -Compress }
    else { $arr | ConvertTo-Json -Depth 3 -Compress }
} catch {
    Write-Error $_.Exception.Message
    exit 1
}`
	out, err := runPSAD(script)
	if err != nil {
		return Result{Status: "failed", Output: out + "\n" + err.Error()}
	}
	return Result{Status: "completed", Output: out}
}

func execADCreateUser(params map[string]interface{}) Result {
	sam, _ := params["sam_account_name"].(string)
	givenName, _ := params["given_name"].(string)
	surname, _ := params["surname"].(string)
	password, _ := params["password"].(string)

	if sam == "" || givenName == "" || surname == "" || password == "" {
		return Result{Status: "failed", Output: "sam_account_name, given_name, surname und password sind erforderlich"}
	}

	displayName, _ := params["display_name"].(string)
	if displayName == "" {
		displayName = givenName + " " + surname
	}

	enabled := true
	if v, ok := params["enabled"].(bool); ok {
		enabled = v
	}
	pne, _ := params["password_never_expires"].(bool)
	cpal, _ := params["change_password_at_logon"].(bool)

	script := fmt.Sprintf(`
try {
    Import-Module ActiveDirectory -ErrorAction Stop
    $secPwd = ConvertTo-SecureString '%s' -AsPlainText -Force
    $p = @{
        SamAccountName        = '%s'
        GivenName             = '%s'
        Surname               = '%s'
        DisplayName           = '%s'
        Name                  = '%s'
        AccountPassword       = $secPwd
        Enabled               = $%s
        PasswordNeverExpires  = $%s
        ChangePasswordAtLogon = $%s
    }
`, escapePS(password), escapePS(sam), escapePS(givenName), escapePS(surname),
		escapePS(displayName), escapePS(displayName),
		boolStr(enabled), boolStr(pne), boolStr(cpal))

	for _, pair := range [][2]string{
		{"email", "EmailAddress"},
		{"department", "Department"},
		{"title", "Title"},
		{"company", "Company"},
		{"description", "Description"},
		{"office_phone", "OfficePhone"},
		{"mobile_phone", "MobilePhone"},
		{"upn", "UserPrincipalName"},
		{"ou", "Path"},
	} {
		if val, ok := params[pair[0]].(string); ok && val != "" {
			script += fmt.Sprintf("    $p['%s'] = '%s'\n", pair[1], escapePS(val))
		}
	}

	script += "    New-ADUser @p -ErrorAction Stop\n"

	if groups, ok := params["groups"].([]interface{}); ok {
		for _, g := range groups {
			if gn, ok := g.(string); ok && gn != "" {
				script += fmt.Sprintf("    Add-ADGroupMember -Identity '%s' -Members '%s' -ErrorAction SilentlyContinue\n",
					escapePS(gn), escapePS(sam))
			}
		}
	}

	script += fmt.Sprintf("    Write-Output 'Benutzer erstellt: %s'\n} catch {\n    Write-Error $_.Exception.Message\n    exit 1\n}", sam)

	out, err := runPSAD(script)
	if err != nil {
		return Result{Status: "failed", Output: out + "\n" + err.Error()}
	}
	return Result{Status: "completed", Output: out}
}

func execADUpdateUser(params map[string]interface{}) Result {
	sam, _ := params["sam_account_name"].(string)
	if sam == "" {
		return Result{Status: "failed", Output: "sam_account_name erforderlich"}
	}

	script := fmt.Sprintf("try {\n    Import-Module ActiveDirectory -ErrorAction Stop\n    $p = @{ Identity = '%s' }\n", escapePS(sam))

	for _, pair := range [][2]string{
		{"given_name", "GivenName"},
		{"surname", "Surname"},
		{"display_name", "DisplayName"},
		{"department", "Department"},
		{"title", "Title"},
		{"company", "Company"},
		{"description", "Description"},
		{"email", "EmailAddress"},
		{"office_phone", "OfficePhone"},
		{"mobile_phone", "MobilePhone"},
	} {
		if val, ok := params[pair[0]].(string); ok {
			script += fmt.Sprintf("    $p['%s'] = '%s'\n", pair[1], escapePS(val))
		}
	}

	script += "    Set-ADUser @p -ErrorAction Stop\n"

	if v, ok := params["enabled"].(bool); ok {
		if v {
			script += fmt.Sprintf("    Enable-ADAccount -Identity '%s' -ErrorAction Stop\n", escapePS(sam))
		} else {
			script += fmt.Sprintf("    Disable-ADAccount -Identity '%s' -ErrorAction Stop\n", escapePS(sam))
		}
	}

	if v, ok := params["password_never_expires"].(bool); ok {
		script += fmt.Sprintf("    Set-ADUser -Identity '%s' -PasswordNeverExpires $%s -ErrorAction Stop\n", escapePS(sam), boolStr(v))
	}

	if addGroups, ok := params["add_groups"].([]interface{}); ok {
		for _, g := range addGroups {
			if gn, ok := g.(string); ok && gn != "" {
				script += fmt.Sprintf("    Add-ADGroupMember -Identity '%s' -Members '%s' -ErrorAction SilentlyContinue\n",
					escapePS(gn), escapePS(sam))
			}
		}
	}

	if removeGroups, ok := params["remove_groups"].([]interface{}); ok {
		for _, g := range removeGroups {
			if gn, ok := g.(string); ok && gn != "" {
				script += fmt.Sprintf("    Remove-ADGroupMember -Identity '%s' -Members '%s' -Confirm:$false -ErrorAction SilentlyContinue\n",
					escapePS(gn), escapePS(sam))
			}
		}
	}

	script += fmt.Sprintf("    Write-Output 'Benutzer aktualisiert: %s'\n} catch {\n    Write-Error $_.Exception.Message\n    exit 1\n}", sam)

	out, err := runPSAD(script)
	if err != nil {
		return Result{Status: "failed", Output: out + "\n" + err.Error()}
	}
	return Result{Status: "completed", Output: out}
}

func execADListOUs(_ map[string]interface{}) Result {
	script := `
try {
    Import-Module ActiveDirectory -ErrorAction Stop
    $arr = @(Get-ADOrganizationalUnit -Filter * -Properties Name,Description,DistinguishedName -ErrorAction Stop | ForEach-Object {
        [PSCustomObject]@{
            name               = $_.Name
            description        = [string]$_.Description
            distinguished_name = $_.DistinguishedName
        }
    })
    if ($arr.Count -eq 1) { @($arr) | ConvertTo-Json -Depth 3 -Compress }
    else { $arr | ConvertTo-Json -Depth 3 -Compress }
} catch { Write-Error $_.Exception.Message; exit 1 }`
	out, err := runPSAD(script)
	if err != nil {
		return Result{Status: "failed", Output: out + "\n" + err.Error()}
	}
	return Result{Status: "completed", Output: out}
}

func execADMoveUser(params map[string]interface{}) Result {
	userDN, _ := params["user_dn"].(string)
	targetOU, _ := params["target_ou"].(string)
	if userDN == "" || targetOU == "" {
		return Result{Status: "failed", Output: "user_dn und target_ou erforderlich"}
	}
	script := fmt.Sprintf(`
try {
    Import-Module ActiveDirectory -ErrorAction Stop
    Move-ADObject -Identity '%s' -TargetPath '%s' -Confirm:$false -ErrorAction Stop
    Write-Output 'Benutzer verschoben'
} catch { Write-Error $_.Exception.Message; exit 1 }`, escapePS(userDN), escapePS(targetOU))
	out, err := runPSAD(script)
	if err != nil {
		return Result{Status: "failed", Output: out + "\n" + err.Error()}
	}
	return Result{Status: "completed", Output: out}
}

func execADDeleteUser(params map[string]interface{}) Result {
	sam, _ := params["sam_account_name"].(string)
	if sam == "" {
		return Result{Status: "failed", Output: "sam_account_name erforderlich"}
	}

	script := fmt.Sprintf(`
try {
    Import-Module ActiveDirectory -ErrorAction Stop
    Remove-ADUser -Identity '%s' -Confirm:$false -ErrorAction Stop
    Write-Output 'Benutzer geloescht: %s'
} catch {
    Write-Error $_.Exception.Message
    exit 1
}`, escapePS(sam), sam)

	out, err := runPSAD(script)
	if err != nil {
		return Result{Status: "failed", Output: out + "\n" + err.Error()}
	}
	return Result{Status: "completed", Output: out}
}
