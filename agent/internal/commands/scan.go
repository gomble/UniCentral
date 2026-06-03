package commands

import (
	"encoding/json"
	"fmt"
	"net"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"
)

type DiscoveredHost struct {
	IP       string `json:"ip"`
	Hostname string `json:"hostname"`
	OS       string `json:"os_guess"`
	Online   bool   `json:"online"`
}

func execScanNetwork(params map[string]interface{}) Result {
	subnet, _ := params["subnet"].(string)

	if subnet == "" {
		subnet = detectSubnet()
	}
	if subnet == "" {
		return Result{Status: "failed", Output: "cannot detect local subnet"}
	}

	hosts := scanSubnet(subnet)

	data, _ := json.Marshal(hosts)
	return Result{Status: "completed", Output: string(data)}
}

func detectSubnet() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := iface.Addrs()
		for _, addr := range addrs {
			if ipnet, ok := addr.(*net.IPNet); ok && ipnet.IP.To4() != nil {
				ip := ipnet.IP.To4()
				mask := ipnet.Mask
				// Calculate network base
				network := net.IP(make([]byte, 4))
				for i := range ip {
					network[i] = ip[i] & mask[i]
				}
				ones, _ := mask.Size()
				return fmt.Sprintf("%s/%d", network.String(), ones)
			}
		}
	}
	return ""
}

func scanSubnet(cidr string) []DiscoveredHost {
	ip, ipnet, err := net.ParseCIDR(cidr)
	if err != nil {
		return nil
	}

	var ips []net.IP
	for ip := ip.Mask(ipnet.Mask); ipnet.Contains(ip); incrementIP(ip) {
		target := make(net.IP, len(ip))
		copy(target, ip)
		ips = append(ips, target)
	}

	// Skip network and broadcast, limit to /24 max (254 hosts)
	if len(ips) > 256 {
		ips = ips[1:255]
	} else if len(ips) > 2 {
		ips = ips[1 : len(ips)-1]
	}

	var hosts []DiscoveredHost
	var mu sync.Mutex
	var wg sync.WaitGroup

	sem := make(chan struct{}, 50)

	for _, target := range ips {
		wg.Add(1)
		sem <- struct{}{}
		go func(t net.IP) {
			defer wg.Done()
			defer func() { <-sem }()

			addr := t.String()
			if !isReachable(addr) {
				return
			}

			hostname := resolveHostname(addr)
			osGuess := guessOS(addr)

			mu.Lock()
			hosts = append(hosts, DiscoveredHost{
				IP:       addr,
				Hostname: hostname,
				OS:       osGuess,
				Online:   true,
			})
			mu.Unlock()
		}(target)
	}

	wg.Wait()
	return hosts
}

func isReachable(ip string) bool {
	conn, err := net.DialTimeout("tcp", ip+":445", 500*time.Millisecond)
	if err == nil {
		conn.Close()
		return true
	}
	conn, err = net.DialTimeout("tcp", ip+":22", 500*time.Millisecond)
	if err == nil {
		conn.Close()
		return true
	}
	conn, err = net.DialTimeout("tcp", ip+":135", 500*time.Millisecond)
	if err == nil {
		conn.Close()
		return true
	}
	// Fallback: ping
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.Command("ping", "-n", "1", "-w", "500", ip)
	} else {
		cmd = exec.Command("ping", "-c", "1", "-W", "1", ip)
	}
	err = cmd.Run()
	return err == nil
}

func resolveHostname(ip string) string {
	// Try DNS reverse lookup
	names, err := net.LookupAddr(ip)
	if err == nil && len(names) > 0 {
		name := strings.TrimSuffix(names[0], ".")
		return name
	}

	// Windows: try NetBIOS name resolution
	if runtime.GOOS == "windows" {
		out, err := exec.Command("nbtstat", "-A", ip).Output()
		if err == nil {
			for _, line := range strings.Split(string(out), "\n") {
				line = strings.TrimSpace(line)
				if strings.Contains(line, "<00>") && strings.Contains(line, "UNIQUE") {
					parts := strings.Fields(line)
					if len(parts) > 0 {
						return parts[0]
					}
				}
			}
		}
	}

	return ""
}

func guessOS(ip string) string {
	// Port 445 (SMB) = likely Windows, Port 22 (SSH) = likely Linux
	conn, err := net.DialTimeout("tcp", ip+":445", 300*time.Millisecond)
	if err == nil {
		conn.Close()
		return "windows"
	}
	conn, err = net.DialTimeout("tcp", ip+":22", 300*time.Millisecond)
	if err == nil {
		conn.Close()
		return "linux"
	}
	return "unknown"
}

func incrementIP(ip net.IP) {
	for j := len(ip) - 1; j >= 0; j-- {
		ip[j]++
		if ip[j] > 0 {
			break
		}
	}
}
