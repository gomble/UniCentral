package updater

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"
)

type VersionInfo struct {
	Version     string `json:"version"`
	DownloadURL string `json:"download_url"`
}

var updateFailCount int

func CheckAndUpdate(serverURL, currentVersion string) {
	if updateFailCount >= 3 {
		return
	}
	url := fmt.Sprintf("%s/api/agent/version?os=%s&arch=%s", serverURL, runtime.GOOS, runtime.GOARCH)
	resp, err := http.Get(url)
	if err != nil {
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return
	}

	var info VersionInfo
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		return
	}

	if info.Version == "" || info.Version == currentVersion {
		return
	}

	log.Printf("New agent version available: %s (current: %s), updating...", info.Version, currentVersion)

	downloadURL := info.DownloadURL
	if downloadURL == "" {
		arch := runtime.GOARCH
		downloadURL = fmt.Sprintf("%s/api/agent/download/%s/%s", serverURL, runtime.GOOS, arch)
	}

	if err := Update(downloadURL); err != nil {
		updateFailCount++
		log.Printf("Auto-update failed (%d/3): %v", updateFailCount, err)
	}
}

func Update(downloadURL string) error {
	currentPath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("cannot determine executable path: %w", err)
	}
	currentPath, _ = filepath.EvalSymlinks(currentPath)

	tmpPath := currentPath + ".new"

	resp, err := http.Get(downloadURL)
	if err != nil {
		return fmt.Errorf("download failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return fmt.Errorf("download returned status %d", resp.StatusCode)
	}

	out, err := os.Create(tmpPath)
	if err != nil {
		return fmt.Errorf("cannot create temp file: %w", err)
	}

	_, err = io.Copy(out, resp.Body)
	out.Close()
	if err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("download write failed: %w", err)
	}

	if runtime.GOOS != "windows" {
		os.Chmod(tmpPath, 0755)
	}

	if runtime.GOOS == "windows" {
		// Windows: can't rename a running binary. Use a helper script that
		// stops the service, swaps the file, and restarts it.
		script := fmt.Sprintf(`
Start-Sleep -Seconds 2
Stop-Service UniCentralAgent -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Remove-Item '%s.old' -Force -ErrorAction SilentlyContinue
Move-Item -Force '%s' '%s.old' -ErrorAction SilentlyContinue
Move-Item -Force '%s' '%s'
Start-Service UniCentralAgent
Remove-Item '%s' -Force -ErrorAction SilentlyContinue
`, currentPath, currentPath, currentPath, tmpPath, currentPath, filepath.Join(os.TempDir(), "unicentral-update.ps1"))

		scriptPath := filepath.Join(os.TempDir(), "unicentral-update.ps1")
		if err := os.WriteFile(scriptPath, []byte(script), 0644); err != nil {
			os.Remove(tmpPath)
			return fmt.Errorf("cannot write update script: %w", err)
		}

		cmd := exec.Command("powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath)
		cmd.Start()
		go func() {
			time.Sleep(1 * time.Second)
			os.Exit(0)
		}()
	} else {
		// Linux: replace binary, then exit — systemd Restart=always starts the new version
		err = os.Rename(tmpPath, currentPath)
		if err != nil {
			os.Remove(tmpPath)
			return fmt.Errorf("cannot replace binary: %w", err)
		}
		go func() {
			time.Sleep(2 * time.Second)
			log.Printf("Agent updated, restarting via service manager...")
			os.Exit(0)
		}()
	}

	return nil
}
