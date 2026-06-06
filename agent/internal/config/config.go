package config

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"sync"
)

type Config struct {
	Server        string `json:"server"`
	Token         string `json:"token"`
	EnrollmentKey string `json:"enrollment_key"`
	MachineID     string `json:"machine_id"`
	MachineSecret string `json:"machine_secret"`
	AgentVersion  string `json:"agent_version"`
	Category      string `json:"category"`
}

var (
	cfg  *Config
	once sync.Once
	path string
)

func Get() *Config {
	once.Do(func() {
		cfg = &Config{}
	})
	return cfg
}

func LoadFromFile(p string) {
	path = p
	data, err := os.ReadFile(p)
	if err != nil {
		return
	}
	data = bytes.TrimPrefix(data, []byte{0xEF, 0xBB, 0xBF})
	json.Unmarshal(data, Get())
}

func LoadDefault() {
	if runtime.GOOS == "windows" {
		path = filepath.Join(os.Getenv("ProgramData"), "UniCentral", "config.json")
	} else {
		path = "/etc/unicentral/config.json"
	}
	LoadFromFile(path)
}

func Save() error {
	if path == "" {
		LoadDefault()
	}
	dir := filepath.Dir(path)
	os.MkdirAll(dir, 0755)

	data, err := json.MarshalIndent(Get(), "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0600)
}

func SetMachineID(id string) {
	Get().MachineID = id
	Get().Token = ""
	Save()
}

func ClearIdentity() {
	Get().MachineID = ""
	Get().MachineSecret = ""
	Save()
}

func SetMachineSecret(secret string) {
	Get().MachineSecret = secret
	Save()
}
