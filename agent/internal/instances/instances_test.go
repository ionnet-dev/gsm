package instances

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ionnet/gsm/agent/internal/protocol"
)

func TestReadLinesSplitsAndCaps(t *testing.T) {
	long := strings.Repeat("x", MaxLineBytes+10)
	var got []string
	readLines(strings.NewReader("a\r\nb\n"+long+"\nlast"), func(s string) { got = append(got, s) })
	if len(got) != 5 || got[0] != "a" || got[1] != "b" || len(got[2]) != MaxLineBytes || got[3] != "xxxxxxxxxx" || got[4] != "last" {
		t.Fatalf("got %d lines: %q", len(got), truncate(got))
	}
}

func truncate(ss []string) []string {
	out := make([]string, len(ss))
	for i, s := range ss {
		if len(s) > 20 {
			s = s[:20] + "…"
		}
		out[i] = s
	}
	return out
}

func TestBatcherFlushesOnCountAndTime(t *testing.T) {
	var mu sync.Mutex
	var batches [][]protocol.ConsoleLine
	b := newBatcher(func(l []protocol.ConsoleLine) {
		mu.Lock()
		batches = append(batches, l)
		mu.Unlock()
	})
	for i := 0; i < batchLines; i++ {
		b.Add(protocol.ConsoleLine{At: 1, Text: "x"})
	}
	mu.Lock()
	if len(batches) != 1 || len(batches[0]) != batchLines {
		t.Fatalf("expected one full batch, got %d", len(batches))
	}
	mu.Unlock()
	b.Add(protocol.ConsoleLine{At: 2, Text: "y"})
	time.Sleep(3 * batchEvery)
	mu.Lock()
	defer mu.Unlock()
	if len(batches) != 2 || batches[1][0].Text != "y" {
		t.Fatalf("expected a timed flush, got %d batches", len(batches))
	}
}

func TestConsoleLogTail(t *testing.T) {
	path := filepath.Join(t.TempDir(), "console.log")
	l, err := openConsoleLog(path)
	if err != nil {
		t.Fatal(err)
	}
	var lines []protocol.ConsoleLine
	for i := 0; i < 50; i++ {
		lines = append(lines, protocol.ConsoleLine{At: int64(i), Text: "line " + strings.Repeat("a", i)})
	}
	l.Write(lines)
	l.Close()
	got, err := TailFile(path, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 10 || got[0].At != 40 || got[9].At != 49 || got[9].Text != "line "+strings.Repeat("a", 49) {
		t.Fatalf("got %+v", got)
	}
	got, _ = TailFile(path, 1000)
	if len(got) != 50 || got[0].At != 0 {
		t.Fatalf("got %d lines", len(got))
	}
}

func TestRing(t *testing.T) {
	r := newRing(3)
	for i := 0; i < 5; i++ {
		r.Add(protocol.ConsoleLine{At: int64(i)})
	}
	got := r.Last(10)
	if len(got) != 3 || got[0].At != 2 || got[2].At != 4 {
		t.Fatalf("got %+v", got)
	}
}

func TestMergeProperties(t *testing.T) {
	in := "# Minecraft server properties\nserver-port=25565\nmotd=hello\n\nlevel-name=world\n"
	out := string(MergeProperties([]byte(in), map[string]string{"server-port": "30000", "query.port": "30000"}))
	want := "# Minecraft server properties\nserver-port=30000\nmotd=hello\n\nlevel-name=world\nquery.port=30000\n"
	if out != want {
		t.Fatalf("got %q", out)
	}
	if got := string(MergeProperties(nil, map[string]string{"eula": "true"})); got != "eula=true\n" {
		t.Fatalf("got %q", got)
	}
}

func TestMergeJSON(t *testing.T) {
	out, err := MergeJSON([]byte(`{"a": {"b": 1}, "keep": "x"}`), map[string]string{"a.c": "2", "d": "text", "e": "true"})
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(out, &m); err != nil {
		t.Fatal(err)
	}
	a := m["a"].(map[string]any)
	if a["b"].(float64) != 1 || a["c"].(float64) != 2 || m["d"] != "text" || m["e"] != true || m["keep"] != "x" {
		t.Fatalf("got %s", out)
	}
}

func TestMergeINI(t *testing.T) {
	in := "; comment\nname=old\n[server]\nport=1\nother=2\n"
	out := string(MergeINI([]byte(in), map[string]string{"name": "new", "server.port": "9", "net.bind": "0.0.0.0"}))
	want := "; comment\nname=new\n[server]\nport=9\nother=2\n[net]\nbind=0.0.0.0\n"
	if out != want {
		t.Fatalf("got %q", out)
	}
}

func TestMergeXMLProperties(t *testing.T) {
	in := `<?xml version="1.0"?>
<ServerSettings>
	<property name="ServerName"		value="My Game Host"/>		<!-- the name -->
	<!-- <property name="SaveGameFolder" value="absolute path" /> -->
	<property name="ServerPort" value="26900" />
</ServerSettings>
`
	out := string(MergeXMLProperties([]byte(in), map[string]string{
		"ServerName":     `Tom & "Jerry"`,
		"ServerPort":     "30000",
		"SaveGameFolder": "/data/saves",
	}))
	want := `<?xml version="1.0"?>
<ServerSettings>
	<property name="ServerName"		value="Tom &amp; &quot;Jerry&quot;"/>		<!-- the name -->
	<!-- <property name="SaveGameFolder" value="absolute path" /> -->
	<property name="ServerPort" value="30000" />
	<property name="SaveGameFolder" value="/data/saves"/>
</ServerSettings>
`
	if out != want {
		t.Fatalf("got %s", out)
	}
	fresh := string(MergeXMLProperties(nil, map[string]string{"A": "1"}))
	if fresh != "<?xml version=\"1.0\"?>\n<ServerSettings>\n\t<property name=\"A\" value=\"1\"/>\n</ServerSettings>\n" {
		t.Fatalf("fresh file: %q", fresh)
	}
	oneLine := string(MergeXMLProperties([]byte(`<S><property name="A"/></S>`), map[string]string{"A": "1", "B": "2"}))
	if oneLine != "<S><property name=\"A\" value=\"1\"/>\n\t<property name=\"B\" value=\"2\"/>\n</S>" {
		t.Fatalf("one line: %q", oneLine)
	}
}

func TestMergeYAML(t *testing.T) {
	in := "# top comment\nserver:\n  port: 1 # keep me\n  name: x\nlist:\n  - a\n"
	out, err := MergeYAML([]byte(in), map[string]string{"server.port": "9", "server.new": "yes", "top": "v"})
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	for _, want := range []string{"# top comment", "port: 9 # keep me", "name: x", "new: yes", "top: v", "- a"} {
		if !strings.Contains(s, want) {
			t.Fatalf("missing %q in %q", want, s)
		}
	}
}

func TestApplyConfigFileRefusesEscape(t *testing.T) {
	root := t.TempDir()
	err := ApplyConfigFile(root, protocol.ConfigFileSpec{Path: "../x", Format: "properties", Values: map[string]string{"a": "b"}}, os.Getuid(), os.Getgid())
	if err == nil {
		t.Fatal("expected an error")
	}
	if err := ApplyConfigFile(root, protocol.ConfigFileSpec{Path: "cfg/server.properties", Format: "properties", Values: map[string]string{"a": "b"}}, os.Getuid(), os.Getgid()); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "cfg/server.properties")); string(b) != "a=b\n" {
		t.Fatalf("got %q", b)
	}
}

func TestCrashBudget(t *testing.T) {
	now := time.Now()
	var hist []time.Time
	var ok bool
	var attempt int
	for i := 1; i <= 3; i++ {
		ok, attempt, hist = crashRestartAllowed(hist, now.Add(time.Duration(i)*time.Second))
		if !ok || attempt != i {
			t.Fatalf("attempt %d: ok=%v attempt=%d", i, ok, attempt)
		}
	}
	ok, attempt, hist = crashRestartAllowed(hist, now.Add(4*time.Second))
	if ok || attempt != 4 {
		t.Fatalf("4th crash should be refused: ok=%v attempt=%d", ok, attempt)
	}
	ok, attempt, _ = crashRestartAllowed(hist, now.Add(crashWindow+5*time.Second))
	if !ok || attempt != 1 {
		t.Fatalf("old crashes should age out: ok=%v attempt=%d", ok, attempt)
	}
}
