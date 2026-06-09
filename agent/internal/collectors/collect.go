package collectors

type TelemetryData struct {
	CPUPercent         float64        `json:"cpu_percent"`
	MemoryPercent      float64        `json:"memory_percent"`
	UptimeSeconds      uint64         `json:"uptime_seconds"`
	Disks              []DiskInfo     `json:"disks"`
	Services           []ServiceInfo  `json:"services"`
	Shares             []ShareInfo    `json:"shares"`
	Firewall           FirewallStatus `json:"firewall"`
	Updates            UpdateStatus   `json:"updates"`
	Defender           DefenderStatus `json:"defender"`
	IsDomainController bool           `json:"is_domain_controller"`
	DomainName         string         `json:"domain_name"`
	HardwareID         string         `json:"hardware_id"`
	Veeam              *VeeamData     `json:"veeam,omitempty"`
}

func CollectAll() TelemetryData {
	cpu, mem, uptime := GetBasicMetrics()
	dcInfo := GetDomainControllerInfo()

	return TelemetryData{
		CPUPercent:         cpu,
		MemoryPercent:      mem,
		UptimeSeconds:      uptime,
		Disks:              GetDisks(),
		Services:           GetServices(),
		Shares:             GetShares(),
		Firewall:           GetFirewallStatus(),
		Updates:            GetUpdateStatus(),
		Defender:           GetDefenderStatus(),
		IsDomainController: dcInfo.IsDomainController,
		DomainName:         dcInfo.DomainName,
		HardwareID:         GetHardwareID(),
		Veeam:              GetVeeamData(),
	}
}
