package collectors

import (
	"github.com/shirou/gopsutil/v3/disk"
)

type DiskInfo struct {
	DriveLetter  string `json:"drive_letter"`
	MountPoint   string `json:"mount_point"`
	TotalBytes   uint64 `json:"total_bytes"`
	FreeBytes    uint64 `json:"free_bytes"`
	HealthStatus string `json:"health_status"`
}

func GetDisks() []DiskInfo {
	var disks []DiskInfo

	partitions, err := disk.Partitions(false)
	if err != nil {
		return disks
	}

	for _, p := range partitions {
		usage, err := disk.Usage(p.Mountpoint)
		if err != nil {
			continue
		}

		d := DiskInfo{
			MountPoint:   p.Mountpoint,
			TotalBytes:   usage.Total,
			FreeBytes:    usage.Free,
			HealthStatus: "healthy",
		}

		if len(p.Device) >= 2 && p.Device[1] == ':' {
			d.DriveLetter = p.Device[:2]
		}

		if usage.UsedPercent > 95 {
			d.HealthStatus = "critical"
		} else if usage.UsedPercent > 85 {
			d.HealthStatus = "warning"
		}

		disks = append(disks, d)
	}

	return disks
}
