package netprobe

import (
	"context"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/ionnet/gsm/agent/internal/protocol"
)

const token = "0123456789abcdef0123"

func freeTCP(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func freeUDP(t *testing.T) int {
	t.Helper()
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	return pc.LocalAddr().(*net.UDPAddr).Port
}

func TestTokensArriveOverTCPAndUDP(t *testing.T) {
	tcpPort, udpPort := freeTCP(t), freeUDP(t)
	p := protocol.ProbeParams{
		BindAddress: "127.0.0.1",
		Token:       token,
		TimeoutMs:   5000,
		Listeners:   []protocol.ProbeListener{{Port: tcpPort, Protocol: "tcp"}, {Port: udpPort, Protocol: "udp"}},
	}
	replies := make(chan string, 1)
	start := time.Now()
	res := Run(context.Background(), p, func(s protocol.ProbeState) {
		for _, l := range s.Listeners {
			if !l.Bound || l.Received {
				t.Errorf("ready state: %+v", l)
			}
		}
		go func() {
			c, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", tcpPort))
			if err != nil {
				replies <- err.Error()
				return
			}
			defer c.Close()
			fmt.Fprintf(c, "%s%s\n", protocol.ProbePrefix, token)
			buf := make([]byte, 64)
			n, _ := c.Read(buf)
			replies <- string(buf[:n])
		}()
		go func() {
			u, err := net.Dial("udp", fmt.Sprintf("127.0.0.1:%d", udpPort))
			if err == nil {
				fmt.Fprintf(u, "%s%s", protocol.ProbePrefix, token)
				u.Close()
			}
		}()
	})
	for _, l := range res.Listeners {
		if !l.Received {
			t.Errorf("token did not arrive: %+v", l)
		}
	}
	if d := time.Since(start); d > 3*time.Second {
		t.Errorf("Run should return as soon as every token arrived, took %s", d)
	}
	if r := <-replies; !strings.HasPrefix(r, Reply) {
		t.Errorf("tcp reply = %q", r)
	}
}

func TestBusyPortAndWrongToken(t *testing.T) {
	busy, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer busy.Close()
	busyPort := busy.Addr().(*net.TCPAddr).Port
	quiet := freeTCP(t)
	p := protocol.ProbeParams{
		BindAddress: "127.0.0.1",
		Token:       token,
		TimeoutMs:   1000,
		Listeners:   []protocol.ProbeListener{{Port: busyPort, Protocol: "tcp"}, {Port: quiet, Protocol: "tcp"}, {Port: quiet, Protocol: "sctp"}},
	}
	res := Run(context.Background(), p, func(protocol.ProbeState) {
		go func() {
			if c, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", quiet)); err == nil {
				fmt.Fprintf(c, "%snot-the-token\n", protocol.ProbePrefix)
				c.Close()
			}
		}()
	})
	if l := res.Listeners[0]; l.Bound || l.Error == nil || l.Received {
		t.Errorf("busy port: %+v", l)
	}
	if l := res.Listeners[1]; !l.Bound || l.Received {
		t.Errorf("wrong token must not count: %+v", l)
	}
	if l := res.Listeners[2]; l.Bound || l.Error == nil {
		t.Errorf("unknown protocol: %+v", l)
	}
	// The listeners are closed again afterwards.
	if l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", quiet)); err != nil {
		t.Errorf("port still taken after Run: %v", err)
	} else {
		l.Close()
	}
}
