package instances

import (
	"archive/tar"
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ionnet/gsm/agent/internal/protocol"
)

func TestMergeSourceCfg(t *testing.T) {
	in := "// server config\n" +
		"hostname \"Old\" // shown in the browser\n" +
		"sv_password \"\"\n" +
		"HOSTNAME \"again\"\n" +
		"sv_lan 1; sv_region 3\n" +
		"exec banned_user.cfg\n"
	out := string(MergeSourceCfg([]byte(in), map[string]string{
		"hostname":  `My "quoted" server`,
		"sv_region": "255",
		"log":       "on",
	}))
	want := "// server config\n" +
		"hostname \"My quoted server\" // shown in the browser\n" +
		"sv_password \"\"\n" +
		"HOSTNAME \"My quoted server\"\n" +
		"sv_lan 1; sv_region 3\n" +
		"exec banned_user.cfg\n" +
		"log \"on\"\n" +
		"sv_region \"255\"\n"
	if out != want {
		t.Fatalf("got:\n%s\nwant:\n%s", out, want)
	}
	if got := string(MergeSourceCfg(nil, map[string]string{"hostname": "x\ny"})); got != "hostname \"xy\"\n" {
		t.Fatalf("new file: %q", got)
	}
}

func TestContainerPathOK(t *testing.T) {
	for _, p := range []string{"/opt/game/data", "/home/steam/gmodserver/garrysmod/maps"} {
		if !containerPathOK(p) {
			t.Errorf("%s refused", p)
		}
	}
	for _, p := range []string{"", "/", "rel", "/etc", "/usr", "/data", "/data/x", "/gsm/x", "/proc/1", "/a/../b", "/a/", "/a:b"} {
		if containerPathOK(p) {
			t.Errorf("%s allowed", p)
		}
	}
}

func TestExtractTreeCopiesFilesOnly(t *testing.T) {
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	add := func(h *tar.Header, body string) {
		h.Size = int64(len(body))
		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		_, _ = tw.Write([]byte(body))
	}
	add(&tar.Header{Name: "maps/", Typeflag: tar.TypeDir, Mode: 0o755}, "")
	add(&tar.Header{Name: "maps/gm_construct.bsp", Typeflag: tar.TypeReg, Mode: 0o644}, "bsp")
	add(&tar.Header{Name: "maps/graphs/gm_construct.ain", Typeflag: tar.TypeReg, Mode: 0o644}, "ain")
	add(&tar.Header{Name: "maps/passwd", Typeflag: tar.TypeSymlink, Linkname: "/etc/passwd"}, "")
	add(&tar.Header{Name: "maps/../escape", Typeflag: tar.TypeReg, Mode: 0o644}, "no")
	add(&tar.Header{Name: "other/file", Typeflag: tar.TypeReg, Mode: 0o644}, "no")
	_ = tw.Close()

	dir := t.TempDir()
	n, err := extractTree(&buf, "maps", dir, 0, 0, false)
	if err != nil || n != 2 {
		t.Fatalf("extractTree = %d, %v", n, err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "graphs", "gm_construct.ain")); string(b) != "ain" {
		t.Fatalf("nested file: %q", b)
	}
	for _, p := range []string{"passwd", "../escape", "escape", "file"} {
		if _, err := os.Lstat(filepath.Join(dir, p)); err == nil {
			t.Errorf("%s was extracted", p)
		}
	}
}

func TestVolumesMustBeRealFolders(t *testing.T) {
	root := t.TempDir()
	m := &Manager{dirs: Dirs{Instances: root}}
	uuid := "6f1c2a1e-9b7d-4c1a-8a0e-3d2b1c0f9e8d"
	spec := &protocol.InstanceSpec{UUID: uuid, Volumes: []protocol.VolumeSpec{{Name: "data", Path: "/opt/game/data"}}}
	if err := os.MkdirAll(m.DataDir(uuid), 0o755); err != nil {
		t.Fatal(err)
	}
	var said []string
	binds, err := m.mountBinds(context.Background(), spec, func(s string) { said = append(said, s) })
	if err != nil {
		t.Fatal(err)
	}
	real, _ := filepath.EvalSymlinks(m.VolumeDir(uuid, "data"))
	if len(binds) != 2 || binds[1] != real+":/opt/game/data" || len(said) != 1 {
		t.Fatalf("binds %v, said %v", binds, said)
	}

	// The instance's files are the game's to change: a link where a volume should be is refused.
	if err := os.RemoveAll(m.VolumeDir(uuid, "data")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/etc", m.VolumeDir(uuid, "data")); err != nil {
		t.Fatal(err)
	}
	if _, err := m.mountBinds(context.Background(), spec, func(string) {}); err == nil || !strings.Contains(err.Error(), "must be a folder") {
		t.Fatalf("symlinked volume: %v", err)
	}
	if err := os.RemoveAll(filepath.Join(m.DataDir(uuid), volumesDir)); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	if err := os.MkdirAll(filepath.Join(outside, "data"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(m.DataDir(uuid), volumesDir)); err != nil {
		t.Fatal(err)
	}
	if _, err := m.mountBinds(context.Background(), spec, func(string) {}); err == nil {
		t.Fatal("symlinked volumes folder was accepted")
	}
}

func TestHostMountsStayUnderAllowedRoots(t *testing.T) {
	allowed := t.TempDir()
	outside := t.TempDir()
	if err := os.MkdirAll(filepath.Join(allowed, "gamemodes"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(allowed, "sneaky")); err != nil {
		t.Fatal(err)
	}
	m := &Manager{}
	if _, err := m.allowedHostPath(filepath.Join(allowed, "gamemodes")); err == nil {
		t.Fatal("mounted with no roots configured")
	}
	m.HostMountRoots = []string{allowed}
	got, err := m.allowedHostPath(filepath.Join(allowed, "gamemodes"))
	want, _ := filepath.EvalSymlinks(filepath.Join(allowed, "gamemodes"))
	if err != nil || got != want {
		t.Fatalf("allowed path: %q, %v", got, err)
	}
	for _, p := range []string{outside, filepath.Join(allowed, "sneaky"), filepath.Join(allowed, "missing"), "relative/path", allowed + "/../x"} {
		if _, err := m.allowedHostPath(p); err == nil {
			t.Errorf("%s allowed", p)
		}
	}

	root := t.TempDir()
	m.dirs = Dirs{Instances: root}
	uuid := "6f1c2a1e-9b7d-4c1a-8a0e-3d2b1c0f9e8d"
	_ = os.MkdirAll(m.DataDir(uuid), 0o755)
	spec := &protocol.InstanceSpec{UUID: uuid, Mounts: []protocol.HostMountSpec{
		{HostPath: filepath.Join(allowed, "gamemodes"), ContainerPath: "/opt/game/gamemodes", ReadOnly: true},
	}}
	binds, err := m.mountBinds(context.Background(), spec, func(string) {})
	if err != nil || len(binds) != 2 || binds[1] != want+":/opt/game/gamemodes:ro" {
		t.Fatalf("binds %v, %v", binds, err)
	}
}

func TestTwoMountsOnOnePathAreRefused(t *testing.T) {
	allowed := t.TempDir()
	m := &Manager{dirs: Dirs{Instances: t.TempDir()}, HostMountRoots: []string{allowed}}
	uuid := "6f1c2a1e-9b7d-4c1a-8a0e-3d2b1c0f9e8d"
	_ = os.MkdirAll(m.DataDir(uuid), 0o755)
	spec := &protocol.InstanceSpec{
		UUID:    uuid,
		Volumes: []protocol.VolumeSpec{{Name: "data", Path: "/opt/game/data"}},
		Mounts:  []protocol.HostMountSpec{{HostPath: allowed, ContainerPath: "/opt/game/data"}},
	}
	if _, err := m.mountBinds(context.Background(), spec, func(string) {}); err == nil || !strings.Contains(err.Error(), "two mounts") {
		t.Fatalf("a mount on a volume's path: %v", err)
	}
}

func TestFIFOTransportWritesEachCommand(t *testing.T) {
	var got []string
	tr := newTransport(protocol.ConsoleTransport{Kind: "fifo", Path: "/home/steam/console.in"}, nil, func(string) {}, func(string) {})
	tr.write = func(cmd string) error {
		got = append(got, cmd)
		return nil
	}
	if err := tr.Send("status\r\n"); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		tr.run(ctx)
		close(done)
	}()
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("run did not end with its context")
	}
	if len(got) != 1 || got[0] != "status" {
		t.Fatalf("got %q", got)
	}
}
