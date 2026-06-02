package collectors

import (
	"net"
	"runtime"
	"time"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/host"
	"github.com/shirou/gopsutil/v3/mem"
)

func GetIPAddresses() []string {
	var ips []string
	ifaces, err := net.Interfaces()
	if err != nil {
		return ips
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := iface.Addrs()
		for _, addr := range addrs {
			if ipnet, ok := addr.(*net.IPNet); ok && ipnet.IP.To4() != nil {
				ips = append(ips, ipnet.IP.String())
			}
		}
	}
	return ips
}

func GetOSVersion() string {
	info, err := host.Info()
	if err != nil {
		return runtime.GOOS
	}
	return info.Platform + " " + info.PlatformVersion
}

func GetBasicMetrics() (cpuPercent float64, memPercent float64, uptimeSeconds uint64) {
	cpuPcts, err := cpu.Percent(time.Second, false)
	if err == nil && len(cpuPcts) > 0 {
		cpuPercent = cpuPcts[0]
	}

	memInfo, err := mem.VirtualMemory()
	if err == nil {
		memPercent = memInfo.UsedPercent
	}

	info, err := host.Info()
	if err == nil {
		uptimeSeconds = info.Uptime
	}

	return
}
