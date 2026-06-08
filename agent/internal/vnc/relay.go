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

// StartRelay connects to a local VNC server (localhost:vncPort) and bridges
// it to the UniCentral server over WebSocket. The function blocks until
// either side closes the connection.
func StartRelay(serverURL, machineID, machineSecret, sessionID string, vncPort int) {
	if sessionID == "" {
		return
	}

	tcpConn, err := net.DialTimeout("tcp", fmt.Sprintf("localhost:%d", vncPort), 10*time.Second)
	if err != nil {
		return
	}
	defer tcpConn.Close()

	wsURL := strings.Replace(serverURL, "https://", "wss://", 1)
	wsURL = strings.Replace(wsURL, "http://", "ws://", 1)

	ts := strconv.FormatInt(time.Now().Unix(), 10)
	sig := computeHmac(machineID, ts, machineSecret)

	params := url.Values{}
	params.Set("session_id", sessionID)
	params.Set("machine_id", machineID)
	params.Set("ts", ts)
	params.Set("sig", sig)

	wsConn, _, err := websocket.DefaultDialer.Dial(wsURL+"/ws/vnc-agent?"+params.Encode(), nil)
	if err != nil {
		return
	}
	defer wsConn.Close()

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
