package instances

import (
	"bufio"
	"context"
	"errors"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ionnet/gsm/agent/internal/protocol"
)

type collected struct {
	mu    sync.Mutex
	lines []string
}

func (c *collected) add(s string) {
	c.mu.Lock()
	c.lines = append(c.lines, s)
	c.mu.Unlock()
}

func (c *collected) has(s string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, l := range c.lines {
		if l == s {
			return true
		}
	}
	return false
}

func (c *collected) all() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.lines...)
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func listen(t *testing.T) net.Listener {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	return ln
}

func startTestTransport(t *testing.T, spec protocol.ConsoleTransport, addr string) (*transport, *collected, *collected) {
	t.Helper()
	answers, notes := &collected{}, &collected{}
	tr := newTransport(spec, func(context.Context) (string, error) { return addr, nil }, answers.add, notes.add)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		tr.run(ctx)
		close(done)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	return tr, answers, notes
}

// A console shaped like 7 Days to Die's: a prompt without a line break, a sign-in answer, the
// live log (which the template ignores) and command answers.
func TestTelnetTransport(t *testing.T) {
	ln := listen(t)
	got := make(chan string, 4)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		r := bufio.NewReader(c)
		c.Write([]byte{telnetIAC, 251, 1}) // IAC WILL ECHO, which a client may ignore
		c.Write([]byte("Please enter password:"))
		pw, _ := r.ReadString('\n')
		got <- strings.TrimRight(pw, "\r\n")
		c.Write([]byte("Logon successful.\r\n\r\n2024-07-01T10:00:00 12.345 INF Time: 1.00m FPS: 60\r\n"))
		cmd, _ := r.ReadString('\n')
		got <- strings.TrimRight(cmd, "\r\n")
		c.Write([]byte("0. id=171, Alloc, pltfmid=Steam_76561198000000001\r\nTotal of 1 in the game\r\n"))
		time.Sleep(time.Second)
	}()
	ignore := `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2} `
	tr, answers, notes := startTestTransport(t, protocol.ConsoleTransport{Kind: "telnet", Password: "s3cret", Ignore: &ignore}, ln.Addr().String())

	if pw := <-got; pw != "s3cret" {
		t.Fatalf("password sent = %q", pw)
	}
	eventually(t, "the connection", func() bool { return tr.Send("lp") == nil })
	if cmd := <-got; cmd != "lp" {
		t.Fatalf("command sent = %q", cmd)
	}
	eventually(t, "the answer", func() bool { return answers.has("Total of 1 in the game") })
	if !answers.has("Logon successful.") || !answers.has("0. id=171, Alloc, pltfmid=Steam_76561198000000001") {
		t.Fatalf("answers = %q", answers.all())
	}
	for _, l := range answers.all() {
		if strings.Contains(l, "INF Time") || strings.TrimSpace(l) == "" {
			t.Fatalf("ignored or empty line shown: %q", l)
		}
	}
	if !notes.has("[GSM] console connected (telnet)") {
		t.Fatalf("notes = %q", notes.all())
	}
}

func TestTelnetRefusedPassword(t *testing.T) {
	ln := listen(t)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		c.Write([]byte("Please enter password:"))
		bufio.NewReader(c).ReadString('\n')
		c.Write([]byte("Password incorrect, please enter password:\r\n"))
		time.Sleep(time.Second)
	}()
	tr := newTransport(protocol.ConsoleTransport{Kind: "telnet", Password: "nope"},
		func(context.Context) (string, error) { return ln.Addr().String(), nil }, func(string) {}, func(string) {})
	_, err := tr.session(context.Background())
	if !errors.Is(err, errTransportRefused) {
		t.Fatalf("err = %v, want refused", err)
	}
}

func TestSendBeforeConnected(t *testing.T) {
	tr := newTransport(protocol.ConsoleTransport{Kind: "telnet"}, nil, func(string) {}, func(string) {})
	if err := tr.Send("lp"); !errors.Is(err, errTransportDown) {
		t.Fatalf("err = %v", err)
	}
}

func TestRCONTransport(t *testing.T) {
	ln := listen(t)
	got := make(chan string, 2)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		id, typ, body, err := readRCONPacket(c)
		if err != nil || typ != rconAuth {
			return
		}
		got <- body
		c.Write(rconPacket(id, rconResponse, ""))
		c.Write(rconPacket(id, rconAuthResponse, ""))
		id, typ, body, err = readRCONPacket(c)
		if err != nil || typ != rconExec {
			return
		}
		got <- body
		c.Write(rconPacket(id, rconResponse, "There are 0 of a max of 20 players online:\n"))
		time.Sleep(time.Second)
	}()
	tr, answers, _ := startTestTransport(t, protocol.ConsoleTransport{Kind: "rcon", Password: "pw"}, ln.Addr().String())
	if pw := <-got; pw != "pw" {
		t.Fatalf("password = %q", pw)
	}
	eventually(t, "the connection", func() bool { return tr.Send("list") == nil })
	if cmd := <-got; cmd != "list" {
		t.Fatalf("command = %q", cmd)
	}
	eventually(t, "the answer", func() bool { return answers.has("There are 0 of a max of 20 players online:") })
}

func TestRCONRefusedPassword(t *testing.T) {
	ln := listen(t)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		if _, _, _, err := readRCONPacket(c); err != nil {
			return
		}
		c.Write(rconPacket(-1, rconAuthResponse, ""))
		time.Sleep(time.Second)
	}()
	tr := newTransport(protocol.ConsoleTransport{Kind: "rcon", Password: "bad"},
		func(context.Context) (string, error) { return ln.Addr().String(), nil }, func(string) {}, func(string) {})
	if _, err := tr.session(context.Background()); !errors.Is(err, errTransportRefused) {
		t.Fatalf("err = %v, want refused", err)
	}
}

func TestTelnetReaderDropsNegotiation(t *testing.T) {
	raw := []byte{'a', telnetIAC, 253, 3, 'b', telnetIAC, telnetSB, 24, 1, telnetIAC, telnetSE, 'c', telnetIAC, telnetIAC, '\r', '\n'}
	r := &telnetReader{r: bufio.NewReader(strings.NewReader(string(raw)))}
	line, err := r.readLine()
	if err != nil {
		t.Fatal(err)
	}
	if line != "abc\xff" {
		t.Fatalf("line = %q", line)
	}
}
