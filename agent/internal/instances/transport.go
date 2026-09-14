package instances

import (
	"bufio"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/ionnet/gsm/agent/internal/protocol"
)

// A console transport carries commands to a game that does not read its stdin (7 Days to Die's
// telnet console, Source RCON) and turns what the game answers into console lines. The port is
// dialled on the container's own address over the Docker network, so it is never published on
// the node.

const (
	transportDialTimeout = 3 * time.Second
	transportRetry       = 2 * time.Second
	// After a refused password, retrying every two seconds would only trip the game's lockout.
	transportRefusedRetry = time.Minute
	transportAuthTimeout  = 10 * time.Second
	transportWriteTimeout = 5 * time.Second
	transportMaxLine      = 16 * 1024
	rconMaxPacket         = 1 << 20

	rconResponse     = 0 // SERVERDATA_RESPONSE_VALUE
	rconExec         = 2 // SERVERDATA_EXECCOMMAND
	rconAuthResponse = 2 // SERVERDATA_AUTH_RESPONSE
	rconAuth         = 3 // SERVERDATA_AUTH
)

var (
	errTransportDown    = errors.New("the game's console is not reachable yet; try again once the server has started")
	errTransportRefused = errors.New("the game refused the console password")
	// Answers that mean the password was wrong, from the telnet consoles we know.
	telnetRefused = regexp.MustCompile(`(?i)password incorrect|wrong password|authentication failed|access denied`)
)

type transport struct {
	spec    protocol.ConsoleTransport
	ignore  *regexp.Regexp
	address func(ctx context.Context) (string, error)
	emit    func(text string) // an answer from the game
	note    func(text string) // a [GSM] line about the connection
	// write hands a command to the game directly (fifo): there is no session to keep then, and
	// the answers arrive on stdout.
	write func(cmd string) error

	mu     sync.Mutex
	conn   net.Conn
	nextID int32
}

func newTransport(spec protocol.ConsoleTransport, address func(context.Context) (string, error), emit, note func(string)) *transport {
	t := &transport{spec: spec, address: address, emit: emit, note: note, nextID: 1}
	if spec.Ignore != nil && *spec.Ignore != "" {
		if re, err := regexp.Compile(*spec.Ignore); err == nil {
			t.ignore = re
		}
	}
	return t
}

// run keeps a session open until ctx ends (the container exited), reconnecting as needed. Until
// the game opens its console port, dials fail quietly.
func (t *transport) run(ctx context.Context) {
	if t.write != nil {
		<-ctx.Done()
		return
	}
	for ctx.Err() == nil {
		established, err := t.session(ctx)
		t.setConn(nil)
		if ctx.Err() != nil {
			return
		}
		wait := transportRetry
		switch {
		case errors.Is(err, errTransportRefused):
			t.note("[GSM] " + errTransportRefused.Error() + "; trying again in a minute")
			wait = transportRefusedRetry
		case established:
			t.note("[GSM] console connection lost; reconnecting")
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
	}
}

// Send writes one command.
func (t *transport) Send(cmd string) error {
	cmd = strings.TrimRight(cmd, "\r\n")
	if t.write != nil {
		return t.write(cmd)
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.conn == nil {
		return errTransportDown
	}
	_ = t.conn.SetWriteDeadline(time.Now().Add(transportWriteTimeout))
	var err error
	if t.spec.Kind == "rcon" {
		t.nextID++
		_, err = t.conn.Write(rconPacket(t.nextID, rconExec, cmd))
	} else {
		_, err = io.WriteString(t.conn, cmd+"\r\n")
	}
	if err != nil {
		// The reader notices too and reconnects.
		_ = t.conn.Close()
		t.conn = nil
		return fmt.Errorf("console connection: %w", err)
	}
	return nil
}

func (t *transport) setConn(c net.Conn) {
	t.mu.Lock()
	t.conn = c
	t.mu.Unlock()
}

// show emits one answer line unless it is empty or the template ignores it.
func (t *transport) show(line string) {
	line = strings.TrimRight(line, "\r")
	if strings.TrimSpace(line) == "" || (t.ignore != nil && t.ignore.MatchString(line)) {
		return
	}
	t.emit(line)
}

// session dials, signs in and reads answers until the connection ends. established reports
// whether it got as far as accepting commands.
func (t *transport) session(ctx context.Context) (established bool, err error) {
	addr, err := t.address(ctx)
	if err != nil {
		return false, err
	}
	d := net.Dialer{Timeout: transportDialTimeout}
	conn, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return false, err
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	if t.spec.Kind == "rcon" {
		return t.rconSession(conn)
	}
	return t.telnetSession(conn)
}

func (t *transport) connected(conn net.Conn) {
	t.setConn(conn)
	t.note(fmt.Sprintf("[GSM] console connected (%s)", t.spec.Kind))
}

// ---- telnet ----

func (t *transport) telnetSession(conn net.Conn) (bool, error) {
	r := &telnetReader{r: bufio.NewReader(conn)}
	if t.spec.Password != "" {
		if err := t.telnetSignIn(conn, r); err != nil {
			return false, err
		}
	}
	_ = conn.SetReadDeadline(time.Time{})
	t.connected(conn)
	for {
		line, err := r.readLine()
		if err != nil {
			return true, err
		}
		if telnetRefused.MatchString(line) {
			return true, errTransportRefused
		}
		t.show(line)
	}
}

// telnetSignIn answers the password prompt. Prompts such as "Please enter password:" end without
// a line break, so a pause in the output counts as the end of one; a console that never asks gets
// the password after a while anyway.
func (t *transport) telnetSignIn(conn net.Conn, r *telnetReader) error {
	deadline := time.Now().Add(transportAuthTimeout)
	for {
		_ = conn.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
		line, err := r.readLine()
		prompt := false
		switch {
		case err == nil:
			if telnetRefused.MatchString(line) {
				return errTransportRefused
			}
			prompt = strings.Contains(strings.ToLower(line), "password")
			if !prompt {
				t.show(line)
			}
		case isTimeout(err):
			prompt = strings.Contains(strings.ToLower(r.pending()), "password")
			if prompt {
				r.reset()
			}
		default:
			return err
		}
		if prompt || time.Now().After(deadline) {
			_ = conn.SetWriteDeadline(time.Now().Add(transportWriteTimeout))
			_, err := io.WriteString(conn, t.spec.Password+"\r\n")
			return err
		}
	}
}

func isTimeout(err error) bool {
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}

// telnetReader reads text lines from a telnet stream, dropping option negotiation.
type telnetReader struct {
	r   *bufio.Reader
	cur []byte
}

const (
	telnetIAC = 255
	telnetSB  = 250
	telnetSE  = 240
)

// readLine returns the next line without its line break. What arrived of an unfinished line stays
// in pending() when the read fails (a deadline, say).
func (tr *telnetReader) readLine() (string, error) {
	for {
		b, err := tr.r.ReadByte()
		if err != nil {
			return "", err
		}
		switch b {
		case telnetIAC:
			if err := tr.skipCommand(); err != nil {
				return "", err
			}
		case '\n':
			line := strings.TrimRight(string(tr.cur), "\r")
			tr.reset()
			return line, nil
		case 0:
		default:
			if len(tr.cur) < transportMaxLine {
				tr.cur = append(tr.cur, b)
			}
		}
	}
}

func (tr *telnetReader) pending() string { return string(tr.cur) }
func (tr *telnetReader) reset()          { tr.cur = tr.cur[:0] }

// skipCommand reads past the rest of an IAC sequence; IAC IAC is a literal 255.
func (tr *telnetReader) skipCommand() error {
	cmd, err := tr.r.ReadByte()
	if err != nil {
		return err
	}
	switch {
	case cmd == telnetIAC:
		tr.cur = append(tr.cur, telnetIAC)
	case cmd >= 251: // WILL, WONT, DO, DONT: one option byte follows
		_, err = tr.r.ReadByte()
	case cmd == telnetSB: // subnegotiation, up to IAC SE
		prev := byte(0)
		for {
			b, err := tr.r.ReadByte()
			if err != nil {
				return err
			}
			if prev == telnetIAC && b == telnetSE {
				return nil
			}
			prev = b
		}
	}
	return err
}

// ---- Source RCON ----

func (t *transport) rconSession(conn net.Conn) (bool, error) {
	_ = conn.SetDeadline(time.Now().Add(transportAuthTimeout))
	if _, err := conn.Write(rconPacket(1, rconAuth, t.spec.Password)); err != nil {
		return false, err
	}
	for {
		id, typ, _, err := readRCONPacket(conn)
		if err != nil {
			return false, err
		}
		if typ != rconAuthResponse {
			continue // servers send an empty response value first
		}
		if id == -1 {
			return false, errTransportRefused
		}
		break
	}
	_ = conn.SetDeadline(time.Time{})
	t.connected(conn)
	for {
		_, typ, body, err := readRCONPacket(conn)
		if err != nil {
			return true, err
		}
		if typ == rconResponse {
			for _, line := range strings.Split(body, "\n") {
				t.show(line)
			}
		}
	}
}

// rconPacket frames one packet: size, id, type, body and two NUL bytes, little-endian.
func rconPacket(id, typ int32, body string) []byte {
	b := make([]byte, 14+len(body))
	binary.LittleEndian.PutUint32(b[0:], uint32(10+len(body)))
	binary.LittleEndian.PutUint32(b[4:], uint32(id))
	binary.LittleEndian.PutUint32(b[8:], uint32(typ))
	copy(b[12:], body)
	return b
}

func readRCONPacket(r io.Reader) (id, typ int32, body string, err error) {
	var head [4]byte
	if _, err = io.ReadFull(r, head[:]); err != nil {
		return 0, 0, "", err
	}
	size := int32(binary.LittleEndian.Uint32(head[:]))
	if size < 10 || size > rconMaxPacket {
		return 0, 0, "", fmt.Errorf("rcon: bad packet size %d", size)
	}
	buf := make([]byte, size)
	if _, err = io.ReadFull(r, buf); err != nil {
		return 0, 0, "", err
	}
	id = int32(binary.LittleEndian.Uint32(buf[0:4]))
	typ = int32(binary.LittleEndian.Uint32(buf[4:8]))
	return id, typ, strings.TrimRight(string(buf[8:]), "\x00"), nil
}
