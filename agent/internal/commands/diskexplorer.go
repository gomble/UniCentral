package commands

import (
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
)

type DiskEntry struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	Size  int64  `json:"size"`
	IsDir bool   `json:"is_dir"`
	Err   string `json:"error,omitempty"`
}

type DiskScanResult struct {
	Path    string      `json:"path"`
	Entries []DiskEntry `json:"entries"`
}

// Paths that are virtual/pseudo filesystems and should not be size-summed.
var skipDirsLinux = map[string]bool{
	"/proc": true, "/sys": true, "/dev": true,
	"/run": true, "/snap": true,
}

func execScanDisk(params map[string]interface{}) Result {
	scanPath, _ := params["path"].(string)
	if scanPath == "" {
		if runtime.GOOS == "windows" {
			scanPath = `C:\`
		} else {
			scanPath = "/"
		}
	}
	scanPath = filepath.Clean(scanPath)

	info, err := os.Stat(scanPath)
	if err != nil {
		return Result{Status: "failed", Output: "Pfad nicht erreichbar: " + err.Error()}
	}
	if !info.IsDir() {
		return Result{Status: "failed", Output: "Pfad ist kein Verzeichnis"}
	}

	dirEntries, err := os.ReadDir(scanPath)
	if err != nil {
		return Result{Status: "failed", Output: "Verzeichnis nicht lesbar: " + err.Error()}
	}

	var entries []DiskEntry
	for _, de := range dirEntries {
		fullPath := filepath.Join(scanPath, de.Name())

		if runtime.GOOS != "windows" && skipDirsLinux[fullPath] {
			continue
		}

		entry := DiskEntry{
			Name:  de.Name(),
			Path:  fullPath,
			IsDir: de.IsDir(),
		}

		if de.IsDir() {
			entry.Size = computeDirSize(fullPath)
		} else {
			fi, ferr := de.Info()
			if ferr == nil {
				entry.Size = fi.Size()
			}
		}

		entries = append(entries, entry)
	}

	// Sort by size descending (largest first).
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].Size > entries[j].Size
	})

	result := DiskScanResult{Path: scanPath, Entries: entries}
	data, err := json.Marshal(result)
	if err != nil {
		return Result{Status: "failed", Output: err.Error()}
	}
	return Result{Status: "completed", Output: string(data)}
}

func computeDirSize(dirPath string) int64 {
	var total int64
	filepath.WalkDir(dirPath, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		fi, ferr := d.Info()
		if ferr == nil {
			total += fi.Size()
		}
		return nil
	})
	return total
}
