package shell

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

var (
	activeShellMu   sync.Mutex
	activeShellStop chan struct{}
)

type resizeMsg struct {
	Type string `json:"type"`
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
}

func StartRelay(serverURL, machineID, machineSecret, sessionID string) {
	if sessionID == "" {
		return
	}

	activeShellMu.Lock()
	if activeShellStop != nil {
		close(activeShellStop)
	}
	stop := make(chan struct{})
	activeShellStop = stop
	activeShellMu.Unlock()

	wsURL := strings.Replace(serverURL, "https://", "wss://", 1)
	wsURL = strings.Replace(wsURL, "http://", "ws://", 1)

	ts := strconv.FormatInt(time.Now().Unix(), 10)
	sig := computeHmac(machineID, ts, machineSecret)

	params := url.Values{}
	params.Set("session_id", sessionID)
	params.Set("machine_id", machineID)
	params.Set("ts", ts)
	params.Set("sig", sig)

	wsConn, _, err := websocket.DefaultDialer.Dial(wsURL+"/ws/shell-agent?"+params.Encode(), nil)
	if err != nil {
		return
	}
	defer wsConn.Close()

	shell := getShellPath()
	cmd := exec.Command(shell)
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")

	ptmx, err := startPty(cmd)
	if err != nil {
		return
	}
	defer ptmx.Close()
	defer cmd.Process.Kill()

	done := make(chan struct{}, 2)

	// PTY -> WebSocket
	go func() {
		defer func() { done <- struct{}{} }()
		buf := make([]byte, 4096)
		for {
			n, err := ptmx.Read(buf)
			if err != nil {
				return
			}
			if err := wsConn.WriteMessage(websocket.BinaryMessage, buf[:n]); err != nil {
				return
			}
		}
	}()

	// WebSocket -> PTY
	go func() {
		defer func() { done <- struct{}{} }()
		for {
			msgType, data, err := wsConn.ReadMessage()
			if err != nil {
				return
			}
			if msgType == websocket.TextMessage {
				var rm resizeMsg
				if json.Unmarshal(data, &rm) == nil && rm.Type == "resize" {
					resizePty(ptmx, rm.Cols, rm.Rows)
					continue
				}
			}
			if _, err := ptmx.Write(data); err != nil {
				return
			}
		}
	}()

	select {
	case <-done:
	case <-stop:
		ptmx.Close()
		wsConn.Close()
	}
}

func getShellPath() string {
	if runtime.GOOS == "windows" {
		if ps, err := exec.LookPath("powershell.exe"); err == nil {
			return ps
		}
		return "cmd.exe"
	}
	if sh := os.Getenv("SHELL"); sh != "" {
		return sh
	}
	if _, err := os.Stat("/bin/bash"); err == nil {
		return "/bin/bash"
	}
	return "/bin/sh"
}

func computeHmac(machineID, timestamp, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(machineID + ":" + timestamp))
	return hex.EncodeToString(mac.Sum(nil))
}
