package instances

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ionnet/gsm/agent/internal/protocol"
)

const (
	// MaxLineBytes caps one console line; longer output is split.
	MaxLineBytes = 16 * 1024
	// batchLines and batchEvery bound how output is grouped into events.
	batchLines = 200
	batchEvery = 100 * time.Millisecond
	// recentLines is how much output is kept in memory per instance.
	recentLines = 2000
	// logMaxBytes and logKeep control console log rotation.
	logMaxBytes = 10 << 20
	logKeep     = 3
)

// readLines splits r into lines (\n-terminated, trailing \r removed, capped at MaxLineBytes) and
// hands each to fn. A final unterminated line is delivered too.
func readLines(r io.Reader, fn func(text string)) {
	emit := func(line []byte) {
		line = bytes.TrimSuffix(line, []byte("\r"))
		for len(line) > MaxLineBytes {
			fn(string(line[:MaxLineBytes]))
			line = line[MaxLineBytes:]
		}
		fn(string(line))
	}
	br := bufio.NewReaderSize(r, 64*1024)
	var pending []byte
	for {
		chunk, err := br.ReadSlice('\n')
		pending = append(pending, chunk...)
		switch {
		case err == nil:
			emit(bytes.TrimSuffix(pending, []byte("\n")))
			pending = pending[:0]
		case err == bufio.ErrBufferFull:
			if len(pending) >= MaxLineBytes {
				emit(pending)
				pending = pending[:0]
			}
		default:
			if len(pending) > 0 {
				emit(pending)
			}
			return
		}
	}
}

// batcher groups console lines and flushes them every batchEvery or batchLines, whichever first.
type batcher struct {
	mu      sync.Mutex
	lines   []protocol.ConsoleLine
	timer   *time.Timer
	flushFn func([]protocol.ConsoleLine)
	closed  bool
}

func newBatcher(flush func([]protocol.ConsoleLine)) *batcher {
	return &batcher{flushFn: flush}
}

func (b *batcher) Add(line protocol.ConsoleLine) {
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return
	}
	b.lines = append(b.lines, line)
	if len(b.lines) >= batchLines {
		lines := b.lines
		b.lines = nil
		if b.timer != nil {
			b.timer.Stop()
			b.timer = nil
		}
		b.mu.Unlock()
		b.flushFn(lines)
		return
	}
	if b.timer == nil {
		b.timer = time.AfterFunc(batchEvery, b.Flush)
	}
	b.mu.Unlock()
}

// Flush sends whatever is pending.
func (b *batcher) Flush() {
	b.mu.Lock()
	lines := b.lines
	b.lines = nil
	if b.timer != nil {
		b.timer.Stop()
		b.timer = nil
	}
	b.mu.Unlock()
	if len(lines) > 0 {
		b.flushFn(lines)
	}
}

// Close flushes and refuses further lines.
func (b *batcher) Close() {
	b.Flush()
	b.mu.Lock()
	b.closed = true
	b.mu.Unlock()
}

// ring keeps the last n console lines in memory.
type ring struct {
	mu    sync.Mutex
	lines []protocol.ConsoleLine
	n     int
}

func newRing(n int) *ring { return &ring{n: n} }

func (r *ring) Add(lines ...protocol.ConsoleLine) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.lines = append(r.lines, lines...)
	if len(r.lines) > r.n {
		r.lines = append([]protocol.ConsoleLine(nil), r.lines[len(r.lines)-r.n:]...)
	}
}

func (r *ring) Last(n int) []protocol.ConsoleLine {
	r.mu.Lock()
	defer r.mu.Unlock()
	if n > len(r.lines) {
		n = len(r.lines)
	}
	return append([]protocol.ConsoleLine(nil), r.lines[len(r.lines)-n:]...)
}

// consoleLog is an append-only line log rotated at logMaxBytes, keeping logKeep old copies.
type consoleLog struct {
	mu   sync.Mutex
	path string
	f    *os.File
	size int64
}

func openConsoleLog(path string) (*consoleLog, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, err
	}
	l := &consoleLog{path: path, f: f}
	if st, err := f.Stat(); err == nil {
		l.size = st.Size()
	}
	return l, nil
}

// formatLine is the on-disk form: "<unix ms> <text>\n".
func formatLine(l protocol.ConsoleLine) string {
	return strconv.FormatInt(l.At, 10) + " " + l.Text + "\n"
}

// parseLine reverses formatLine; lines without a timestamp prefix get At 0.
func parseLine(s string) protocol.ConsoleLine {
	ts, text, ok := strings.Cut(s, " ")
	if ok {
		if at, err := strconv.ParseInt(ts, 10, 64); err == nil {
			return protocol.ConsoleLine{At: at, Text: text}
		}
	}
	return protocol.ConsoleLine{Text: s}
}

func (l *consoleLog) Write(lines []protocol.ConsoleLine) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.f == nil {
		return
	}
	var buf bytes.Buffer
	for _, ln := range lines {
		buf.WriteString(formatLine(ln))
	}
	if l.size+int64(buf.Len()) > logMaxBytes {
		l.rotateLocked()
	}
	n, _ := l.f.Write(buf.Bytes())
	l.size += int64(n)
}

func (l *consoleLog) rotateLocked() {
	l.f.Close()
	_ = os.Remove(fmt.Sprintf("%s.%d", l.path, logKeep))
	for i := logKeep - 1; i >= 1; i-- {
		_ = os.Rename(fmt.Sprintf("%s.%d", l.path, i), fmt.Sprintf("%s.%d", l.path, i+1))
	}
	_ = os.Rename(l.path, l.path+".1")
	f, err := os.OpenFile(l.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		l.f = nil
		return
	}
	l.f, l.size = f, 0
}

func (l *consoleLog) Close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.f != nil {
		l.f.Close()
		l.f = nil
	}
}

// TailFile returns the last n lines of a console log, reading the file backwards in chunks. The
// previous rotation is consulted when the current file holds fewer than n lines.
func TailFile(path string, n int) ([]protocol.ConsoleLine, error) {
	lines, err := tailOne(path, n)
	if err != nil {
		return nil, err
	}
	if len(lines) < n {
		if older, err := tailOne(path+".1", n-len(lines)); err == nil {
			lines = append(older, lines...)
		}
	}
	out := make([]protocol.ConsoleLine, 0, len(lines))
	for _, s := range lines {
		out = append(out, parseLine(s))
	}
	return out, nil
}

func tailOne(path string, n int) ([]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	const chunk = 64 * 1024
	pos := st.Size()
	var buf []byte
	var lines []string
	for pos > 0 && len(lines) <= n {
		size := int64(chunk)
		if pos < size {
			size = pos
		}
		pos -= size
		part := make([]byte, size)
		if _, err := f.ReadAt(part, pos); err != nil && err != io.EOF {
			return nil, err
		}
		buf = append(part, buf...)
		// Count complete lines so far; the leading partial line is finished by the next chunk.
		lines = lines[:0]
		for _, s := range bytes.Split(buf, []byte("\n")) {
			lines = append(lines, string(s))
		}
		if pos > 0 {
			lines = lines[1:] // first piece may be a partial line
		}
	}
	// Drop the empty tail after the final newline.
	if len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return lines, nil
}

func nowMs() int64 { return time.Now().UnixMilli() }
