package collectors

type TelemetryData struct {
	CPUPercent    float64       `json:"cpu_percent"`
	MemoryPercent float64       `json:"memory_percent"`
	UptimeSeconds uint64        `json:"uptime_seconds"`
	Disks         []DiskInfo    `json:"disks"`
	Services      []ServiceInfo `json:"services"`
	Shares        []ShareInfo   `json:"shares"`
}

func CollectAll() TelemetryData {
	cpu, mem, uptime := GetBasicMetrics()

	return TelemetryData{
		CPUPercent:    cpu,
		MemoryPercent: mem,
		UptimeSeconds: uptime,
		Disks:         GetDisks(),
		Services:      GetServices(),
		Shares:        GetShares(),
	}
}
