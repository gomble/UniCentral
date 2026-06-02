package updater

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"
)

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
		// Windows: can't replace running binary directly
		// Rename current to .old, rename .new to current, then restart service
		oldPath := currentPath + ".old"
		os.Remove(oldPath)
		err = os.Rename(currentPath, oldPath)
		if err != nil {
			os.Remove(tmpPath)
			return fmt.Errorf("cannot rename current binary: %w", err)
		}
		err = os.Rename(tmpPath, currentPath)
		if err != nil {
			os.Rename(oldPath, currentPath)
			return fmt.Errorf("cannot place new binary: %w", err)
		}
		// Schedule service restart
		go func() {
			time.Sleep(2 * time.Second)
			exec.Command("powershell", "-Command", "Restart-Service UniCentralAgent").Run()
		}()
	} else {
		// Linux: replace binary and restart
		err = os.Rename(tmpPath, currentPath)
		if err != nil {
			os.Remove(tmpPath)
			return fmt.Errorf("cannot replace binary: %w", err)
		}
		go func() {
			time.Sleep(2 * time.Second)
			exec.Command("systemctl", "restart", "unicentral-agent").Run()
		}()
	}

	return nil
}
