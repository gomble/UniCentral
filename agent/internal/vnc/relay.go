package vnc

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

// StartRelay bridges a local VNC server on vncPort to the UniCentral server
// via WebSocket. It opens the server WS channel first (keeping the browser
// connection alive), then waits up to 90 s for the local VNC port to become
// available (in case setup_vnc is still running), and finally bridges both
// sides until either closes.
func StartRelay(serverURL, machineID, machineSecret, sessionID string, vncPort int) {
	if sessionID == "" {
		return
	}

	wsURL := strings.Replace(serverURL, "https://", "wss://", 1)
	wsURL = strings.Replace(wsURL, "http://", "ws://", 1)

	ts := strconv.FormatInt(time.Now().Unix(), 10)
	sig := computeHmac(machineID, ts, machineSecret)

	params := url.Values{}
	params.Set("session_id", sessionID)
	params.Set("machine_id", machineID)
	params.Set("ts", ts)
	params.Set("sig", sig)

	// Connect to the server bridge first so the 15-second browser-side timeout
	// is satisfied immediately; TCP retry can then take up to 90 s.
	wsConn, _, err := websocket.DefaultDialer.Dial(wsURL+"/ws/vnc-agent?"+params.Encode(), nil)
	if err != nil {
		return
	}
	defer wsConn.Close()

	// Retry TCP connection to the local VNC server for up to 90 s so that
	// setup_vnc has time to install and start the VNC service.
	addr := fmt.Sprintf("localhost:%d", vncPort)
	var tcpConn net.Conn
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		var dialErr error
		tcpConn, dialErr = net.DialTimeout("tcp", addr, 3*time.Second)
		if dialErr == nil {
			break
		}
		time.Sleep(3 * time.Second)
	}
	if tcpConn == nil {
		return
	}
	defer tcpConn.Close()

	done := make(chan struct{}, 2)

	// TCP → WebSocket
	go func() {
		defer func() { done <- struct{}{} }()
		buf := make([]byte, 32*1024)
		for {
			n, err := tcpConn.Read(buf)
			if err != nil {
				return
			}
			if err := wsConn.WriteMessage(websocket.BinaryMessage, buf[:n]); err != nil {
				return
			}
		}
	}()

	// WebSocket → TCP
	go func() {
		defer func() { done <- struct{}{} }()
		for {
			_, data, err := wsConn.ReadMessage()
			if err != nil {
				return
			}
			if _, err := tcpConn.Write(data); err != nil {
				return
			}
		}
	}()

	<-done
}

func computeHmac(machineID, timestamp, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(machineID + ":" + timestamp))
	return hex.EncodeToString(mac.Sum(nil))
}
