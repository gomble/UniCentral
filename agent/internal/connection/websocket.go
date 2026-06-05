package connection

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/unicentral/agent/internal/collectors"
	"github.com/unicentral/agent/internal/commands"
	"github.com/unicentral/agent/internal/config"
	"github.com/unicentral/agent/internal/updater"
)

type Message struct {
	Type      string      `json:"type"`
	ID        string      `json:"id"`
	Timestamp int64       `json:"timestamp"`
	Payload   interface{} `json:"payload"`
}

type CommandPayload struct {
	CommandID  int64                  `json:"command_id"`
	Type       string                 `json:"type"`
	Parameters map[string]interface{} `json:"parameters"`
}

type Client struct {
	cfg       *config.Config
	conn      *websocket.Conn
	done      chan struct{}
	heartbeat *time.Ticker
	telemetry *time.Ticker
	writeMu   sync.Mutex
}

func New(cfg *config.Config) *Client {
	return &Client{
		cfg:  cfg,
		done: make(chan struct{}),
	}
}

func (c *Client) Run() {
	for {
		select {
		case <-c.done:
			return
		default:
			err := c.connect()
			if err != nil {
				log.Printf("Connection failed: %v, retrying...", err)
			}
			c.backoff()
		}
	}
}

func (c *Client) Close() {
	close(c.done)
	if c.conn != nil {
		c.conn.Close()
	}
}

func (c *Client) connect() error {
	serverURL := c.cfg.Server
	if serverURL == "" {
		return fmt.Errorf("no server URL configured")
	}

	serverURL = strings.Replace(serverURL, "https://", "wss://", 1)
	serverURL = strings.Replace(serverURL, "http://", "ws://", 1)

	params := url.Values{}
	if c.cfg.MachineID != "" && c.cfg.MachineSecret != "" {
		// Reconnect with HMAC signature
		ts := strconv.FormatInt(time.Now().Unix(), 10)
		sig := computeHmac(c.cfg.MachineID, ts, c.cfg.MachineSecret)
		params.Set("machine_id", c.cfg.MachineID)
		params.Set("ts", ts)
		params.Set("sig", sig)
	} else if c.cfg.MachineID != "" {
		// Legacy reconnect without HMAC
		params.Set("machine_id", c.cfg.MachineID)
	} else if c.cfg.EnrollmentKey != "" {
		params.Set("enrollment_key", c.cfg.EnrollmentKey)
	} else if c.cfg.Token != "" {
		params.Set("token", c.cfg.Token)
	}

	wsURL := fmt.Sprintf("%s/ws/agent?%s", serverURL, params.Encode())

	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		return err
	}
	c.conn = conn
	log.Println("Connected to server")

	if c.cfg.MachineID == "" {
		c.register()
	}

	c.heartbeat = time.NewTicker(30 * time.Second)
	c.telemetry = time.NewTicker(5 * time.Minute)
	updateCheck := time.NewTicker(5 * time.Minute)

	// Initial telemetry after short delay, and immediate update check
	go func() {
		time.Sleep(5 * time.Second)
		c.sendTelemetry()
	}()
	go func() {
		time.Sleep(10 * time.Second)
		updater.CheckAndUpdate(c.cfg.Server, c.cfg.AgentVersion)
	}()

	// Read messages in separate goroutine
	readErr := make(chan error, 1)
	go func() {
		for {
			_, message, err := conn.ReadMessage()
			if err != nil {
				readErr <- err
				return
			}
			c.handleMessage(message)
		}
	}()

	for {
		select {
		case <-c.done:
			c.heartbeat.Stop()
			c.telemetry.Stop()
			updateCheck.Stop()
			return nil
		case err := <-readErr:
			c.heartbeat.Stop()
			c.telemetry.Stop()
			updateCheck.Stop()
			return err
		case <-c.heartbeat.C:
			c.sendHeartbeat()
		case <-c.telemetry.C:
			c.sendTelemetry()
		case <-updateCheck.C:
			go updater.CheckAndUpdate(c.cfg.Server, c.cfg.AgentVersion)
		}
	}
}

func (c *Client) register() {
	hostname, _ := os.Hostname()
	ips := collectors.GetIPAddresses()

	category := c.cfg.Category
	if category == "" {
		category = "client"
	}

	msg := Message{
		Type:      "register",
		Timestamp: time.Now().Unix(),
		Payload: map[string]interface{}{
			"hostname":      hostname,
			"os_type":       runtime.GOOS,
			"os_version":    collectors.GetOSVersion(),
			"agent_version": c.cfg.AgentVersion,
			"ip_addresses":  ips,
			"category":      category,
		},
	}

	c.send(msg)
}

func (c *Client) sendHeartbeat() {
	cpu, mem, uptime := collectors.GetBasicMetrics()
	msg := Message{
		Type:      "heartbeat",
		Timestamp: time.Now().Unix(),
		Payload: map[string]interface{}{
			"cpu_percent":    cpu,
			"memory_percent": mem,
			"uptime_seconds": uptime,
			"agent_version":  c.cfg.AgentVersion,
		},
	}
	c.send(msg)
}

func (c *Client) sendTelemetry() {
	data := collectors.CollectAll()
	msg := Message{
		Type:      "telemetry",
		Timestamp: time.Now().Unix(),
		Payload:   data,
	}
	c.send(msg)
}

func (c *Client) handleMessage(raw []byte) {
	var msg Message
	if err := json.Unmarshal(raw, &msg); err != nil {
		return
	}

	switch msg.Type {
	case "registered":
		payload, _ := json.Marshal(msg.Payload)
		var reg struct {
			MachineID     string `json:"machine_id"`
			MachineSecret string `json:"machine_secret"`
		}
		json.Unmarshal(payload, &reg)
		if reg.MachineID != "" {
			config.SetMachineID(reg.MachineID)
			c.cfg.MachineID = reg.MachineID
			log.Printf("Registered with machine_id: %s", reg.MachineID)
		}
		if reg.MachineSecret != "" {
			config.SetMachineSecret(reg.MachineSecret)
			c.cfg.MachineSecret = reg.MachineSecret
			log.Println("Machine secret stored for HMAC authentication")
		}

	case "error":
		payload, _ := json.Marshal(msg.Payload)
		var errMsg struct {
			Message string `json:"message"`
		}
		json.Unmarshal(payload, &errMsg)
		log.Printf("Server error: %s", errMsg.Message)
		if errMsg.Message == "Invalid signature" {
			log.Println("HMAC mismatch detected, clearing machine secret for re-authentication")
			c.cfg.MachineSecret = ""
			config.SetMachineSecret("")
		}

	case "command":
		payload, _ := json.Marshal(msg.Payload)
		var cmd CommandPayload
		json.Unmarshal(payload, &cmd)
		go c.executeCommand(cmd)
	}
}

func (c *Client) executeCommand(cmd CommandPayload) {
	// Stream intermediate progress so the dashboard shows a running command
	// with live output instead of appearing stuck until completion.
	onProgress := func(output string) {
		c.send(Message{
			Type:      "command_result",
			Timestamp: time.Now().Unix(),
			Payload: map[string]interface{}{
				"command_id": cmd.CommandID,
				"status":     "running",
				"result":     output,
			},
		})
	}

	result := commands.Execute(cmd.Type, cmd.Parameters, onProgress)

	response := Message{
		Type:      "command_result",
		Timestamp: time.Now().Unix(),
		Payload: map[string]interface{}{
			"command_id": cmd.CommandID,
			"status":     result.Status,
			"result":     result.Output,
		},
	}
	c.send(response)
}

func (c *Client) send(msg Message) {
	if c.conn == nil {
		return
	}
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	c.conn.WriteMessage(websocket.TextMessage, data)
}

func (c *Client) backoff() {
	select {
	case <-c.done:
	case <-time.After(5 * time.Second):
	}
}

func computeHmac(machineID, timestamp, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(machineID + ":" + timestamp))
	return hex.EncodeToString(mac.Sum(nil))
}
