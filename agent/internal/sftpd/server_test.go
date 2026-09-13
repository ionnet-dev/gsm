package sftpd

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"

	"github.com/ionnet/gsm/agent/internal/protocol"
)

const (
	testUUID = "aaaaaaaa-0000-4000-8000-000000000001"
	testUser = "alice.aaaaaaaa"
)

type env struct {
	srv     *Server
	base    string
	instDir string
	outside string
	key     ssh.Signer
	events  chan protocol.SFTPSessionEvent
}

func newEnv(t *testing.T) *env {
	t.Helper()
	base := t.TempDir()
	e := &env{
		base:    base,
		instDir: filepath.Join(base, "instances", testUUID),
		outside: filepath.Join(base, "outside.txt"),
		events:  make(chan protocol.SFTPSessionEvent, 64),
	}
	if err := os.MkdirAll(e.instDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(e.outside, []byte("secret-outside"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	e.key, _ = ssh.NewSignerFromKey(priv)
	authorized := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(e.key.PublicKey())))
	srv, err := New(Options{
		Auth: func(_ context.Context, p protocol.SFTPAuthParams) (protocol.SFTPAuthResult, error) {
			if p.Username != testUser || p.RemoteAddress != "127.0.0.1" {
				return protocol.SFTPAuthResult{}, nil
			}
			ok := (p.Method == "password" && p.Password == "secret") ||
				(p.Method == "publickey" && p.PublicKey == authorized)
			if !ok {
				return protocol.SFTPAuthResult{}, nil
			}
			return protocol.SFTPAuthResult{Allowed: true, UserID: 7, UUID: testUUID, Credential: p.Method + ":1"}, nil
		},
		Emit: func(event string, data any) {
			if event == "sftp.session" {
				e.events <- data.(protocol.SFTPSessionEvent)
			}
		},
		InstanceDir: func(uuid string) string { return filepath.Join(base, "instances", uuid) },
		StateDir:    filepath.Join(base, "state"),
	})
	if err != nil {
		t.Fatal(err)
	}
	zero := 0
	if st := srv.Configure(&zero, "127.0.0.1"); !st.Listening || st.Error != nil {
		t.Fatalf("not listening: %+v", st)
	}
	t.Cleanup(srv.Close)
	e.srv = srv
	return e
}

func (e *env) dial(t *testing.T, user string, auth ssh.AuthMethod) (*ssh.Client, error) {
	t.Helper()
	return ssh.Dial("tcp", e.srv.Addr().String(), &ssh.ClientConfig{
		User: user,
		Auth: []ssh.AuthMethod{auth},
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			if ssh.FingerprintSHA256(key) != e.srv.HostKey() {
				return errors.New("host key mismatch")
			}
			return nil
		},
		Timeout: 5 * time.Second,
	})
}

func (e *env) connect(t *testing.T) (*ssh.Client, *sftp.Client) {
	t.Helper()
	sc, err := e.dial(t, testUser, ssh.Password("secret"))
	if err != nil {
		t.Fatal(err)
	}
	c, err := sftp.NewClient(sc)
	if err != nil {
		sc.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close(); sc.Close() })
	return sc, c
}

func (e *env) waitEvent(t *testing.T, state string) protocol.SFTPSessionEvent {
	t.Helper()
	timeout := time.After(5 * time.Second)
	for {
		select {
		case ev := <-e.events:
			if ev.State == state {
				return ev
			}
		case <-timeout:
			t.Fatalf("no %s event", state)
		}
	}
}

func writeFile(t *testing.T, c *sftp.Client, name, content string) {
	t.Helper()
	f, err := c.Create(name)
	if err != nil {
		t.Fatalf("create %s: %v", name, err)
	}
	if _, err := f.Write([]byte(content)); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
}

func readFile(c *sftp.Client, name string) (string, error) {
	f, err := c.Open(name)
	if err != nil {
		return "", err
	}
	defer f.Close()
	b, err := io.ReadAll(f)
	return string(b), err
}

func TestRoundTripAndStats(t *testing.T) {
	e := newEnv(t)
	sc, c := e.connect(t)
	opened := e.waitEvent(t, "opened")
	if opened.UserID != 7 || opened.UUID != testUUID || opened.Method != "password" || opened.Stats != nil {
		t.Fatalf("opened event %+v", opened)
	}

	writeFile(t, c, "hello.txt", "hi there")
	if b, _ := os.ReadFile(filepath.Join(e.instDir, "hello.txt")); string(b) != "hi there" {
		t.Fatalf("on disk: %q", b)
	}
	if got, err := readFile(c, "hello.txt"); err != nil || got != "hi there" {
		t.Fatalf("read back %q %v", got, err)
	}
	if err := c.Mkdir("d"); err != nil {
		t.Fatal(err)
	}
	if err := c.Rename("hello.txt", "d/hello.txt"); err != nil {
		t.Fatal(err)
	}
	writeFile(t, c, "d/other.txt", "other")
	if err := c.Rename("d/other.txt", "d/hello.txt"); err == nil {
		t.Fatal("rename onto an existing file should fail")
	}
	if err := c.PosixRename("d/other.txt", "d/hello.txt"); err != nil {
		t.Fatal(err)
	}
	if got, _ := readFile(c, "d/hello.txt"); got != "other" {
		t.Fatalf("posix rename did not replace: %q", got)
	}
	entries, err := c.ReadDir("d")
	if err != nil || len(entries) != 1 || entries[0].Name() != "hello.txt" {
		t.Fatalf("list: %v %v", entries, err)
	}
	if err := c.Chmod("d/hello.txt", 0o600); err != nil {
		t.Fatal(err)
	}
	if fi, _ := os.Stat(filepath.Join(e.instDir, "d", "hello.txt")); fi.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", fi.Mode())
	}
	if err := c.Truncate("d/hello.txt", 2); err != nil {
		t.Fatal(err)
	}
	if fi, err := c.Stat("d/hello.txt"); err != nil || fi.Size() != 2 {
		t.Fatalf("truncate: %v %v", fi, err)
	}
	if err := c.RemoveDirectory("d"); err == nil {
		t.Fatal("removing a non-empty directory should fail")
	}
	if err := c.Remove("d/hello.txt"); err != nil {
		t.Fatal(err)
	}
	if err := c.RemoveDirectory("d"); err != nil {
		t.Fatal(err)
	}
	if err := c.Remove("/"); err == nil {
		t.Fatal("the root cannot be removed")
	}

	c.Close()
	sc.Close()
	closed := e.waitEvent(t, "closed")
	st := closed.Stats
	if st == nil || st.Uploads != 2 || st.Downloads < 2 || st.Renamed != 2 || st.Mkdirs != 1 || st.Removed != 2 ||
		st.BytesIn != int64(len("hi there")+len("other")) || st.BytesOut < int64(len("hi there")) {
		t.Fatalf("stats %+v", st)
	}
	if len(e.srv.Sessions(nil)) != 0 {
		t.Fatal("session still listed after close")
	}
}

func TestConfinement(t *testing.T) {
	e := newEnv(t)
	if err := os.Symlink(e.outside, filepath.Join(e.instDir, "abs-link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../../outside.txt", filepath.Join(e.instDir, "rel-link")); err != nil {
		t.Fatal(err)
	}
	_, c := e.connect(t)

	writeFile(t, c, "../../escape.txt", "x")
	if _, err := os.Stat(filepath.Join(e.instDir, "escape.txt")); err != nil {
		t.Fatalf("../ should stay in the root: %v", err)
	}
	if _, err := os.Stat(filepath.Join(e.base, "escape.txt")); err == nil {
		t.Fatal("wrote outside the root")
	}
	if got, err := readFile(c, "/../../outside.txt"); err == nil {
		t.Fatalf("read outside through ..: %q", got)
	}
	for _, link := range []string{"abs-link", "rel-link"} {
		if got, err := readFile(c, link); err == nil {
			t.Fatalf("read through %s: %q", link, got)
		}
		if _, err := c.Stat(link); err == nil {
			t.Fatalf("stat followed %s out of the root", link)
		}
		if fi, err := c.Lstat(link); err != nil || fi.Mode()&os.ModeSymlink == 0 {
			t.Fatalf("lstat %s: %v %v", link, fi, err)
		}
		if f, err := c.Create(link); err == nil {
			f.Close()
			t.Fatalf("created through %s", link)
		}
	}
	if b, _ := os.ReadFile(e.outside); string(b) != "secret-outside" {
		t.Fatalf("outside file changed: %q", b)
	}
	if err := c.Symlink("escape.txt", "new-link"); err == nil {
		t.Fatal("symlinks must be refused")
	}
	if err := c.Link("escape.txt", "hard-link"); err == nil {
		t.Fatal("hard links must be refused")
	}
	if err := c.Mkdir("../../elsewhere"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(e.instDir, "elsewhere")); err != nil {
		t.Fatal("mkdir with .. should land in the root")
	}
}

func TestAuth(t *testing.T) {
	e := newEnv(t)
	if _, err := e.dial(t, testUser, ssh.Password("wrong")); err == nil {
		t.Fatal("wrong password accepted")
	}
	if _, err := e.dial(t, "bob.aaaaaaaa", ssh.Password("secret")); err == nil {
		t.Fatal("wrong user accepted")
	}
	sc, err := e.dial(t, testUser, ssh.PublicKeys(e.key))
	if err != nil {
		t.Fatalf("key sign-in: %v", err)
	}
	sc.Close()
	if ev := e.waitEvent(t, "opened"); ev.Method != "publickey" {
		t.Fatalf("method %q", ev.Method)
	}
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	other, _ := ssh.NewSignerFromKey(priv)
	if _, err := e.dial(t, testUser, ssh.PublicKeys(other)); err == nil {
		t.Fatal("unknown key accepted")
	}
}

func TestOnlySFTP(t *testing.T) {
	e := newEnv(t)
	sc, _ := e.connect(t)
	s1, err := sc.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	if err := s1.Run("id"); err == nil {
		t.Fatal("exec should be refused")
	}
	s2, err := sc.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	if err := s2.Shell(); err == nil {
		t.Fatal("shell should be refused")
	}
	if c, err := sc.Dial("tcp", "127.0.0.1:1"); err == nil {
		c.Close()
		t.Fatal("port forwarding should be refused")
	}
}

func TestDisconnectAndCloseInstance(t *testing.T) {
	e := newEnv(t)
	sc, c := e.connect(t)
	e.waitEvent(t, "opened")
	list := e.srv.Sessions(nil)
	if len(list) != 1 {
		t.Fatalf("sessions %+v", list)
	}
	s := list[0]
	if s.UserID != 7 || s.UUID != testUUID || s.Method != "password" || s.Credential != "password:1" ||
		s.RemoteAddress != "127.0.0.1" || len(s.ID) != 12 || s.OpenedAt.IsZero() {
		t.Fatalf("session %+v", s)
	}
	if got := e.srv.Sessions([]int{8}); len(got) != 0 {
		t.Fatalf("filter by user: %+v", got)
	}
	if got := e.srv.Sessions([]int{}); len(got) != 0 {
		t.Fatalf("empty filter: %+v", got)
	}
	if n := e.srv.Disconnect([]string{s.ID, "nope"}); n != 1 {
		t.Fatalf("disconnected %d", n)
	}
	e.waitEvent(t, "closed")
	waitClosed(t, sc)
	if _, err := c.Getwd(); err == nil {
		if _, err := c.ReadDir("."); err == nil {
			t.Fatal("client still works after disconnect")
		}
	}

	sc2, _ := e.connect(t)
	e.waitEvent(t, "opened")
	e.srv.CloseInstance(testUUID)
	if len(e.srv.Sessions(nil)) != 0 {
		t.Fatal("CloseInstance returned with sessions open")
	}
	waitClosed(t, sc2)
}

func waitClosed(t *testing.T, sc *ssh.Client) {
	t.Helper()
	done := make(chan struct{})
	go func() { _ = sc.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("connection not closed")
	}
}

func TestHostKeyAndConfigure(t *testing.T) {
	e := newEnv(t)
	again, err := New(Options{StateDir: filepath.Join(e.base, "state")})
	if err != nil {
		t.Fatal(err)
	}
	if again.HostKey() != e.srv.HostKey() || !strings.HasPrefix(e.srv.HostKey(), "SHA256:") {
		t.Fatalf("host key not reused: %s vs %s", again.HostKey(), e.srv.HostKey())
	}
	fi, err := os.Stat(filepath.Join(e.base, "state", hostKeyFile))
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("host key file: %v %v", fi, err)
	}
	if st := e.srv.Configure(nil, ""); st.Listening || st.Port != nil || st.Error != nil {
		t.Fatalf("stop: %+v", st)
	}
	bad := 70000
	if st := e.srv.Configure(&bad, "127.0.0.1"); st.Listening || st.Error == nil || *st.Port != bad {
		t.Fatalf("bad port: %+v", st)
	}
	var nilServer *Server
	if st := nilServer.Configure(nil, ""); st.Error == nil {
		t.Fatal("a nil server should report why SFTP is unavailable")
	}
}
