package backups

import (
	"context"
	"github.com/ionnet/gsm/agent/internal/protocol"
	"os"
	"path/filepath"
	"testing"
)

func TestMatcher(t *testing.T) {
	m := NewMatcher([]string{"*.log", "cache/", "world/region/**", "logs/latest.log", "**/tmp"})
	cases := []struct {
		rel   string
		isDir bool
		want  bool
	}{
		{"server.log", false, true},
		{"logs/2024.log", false, true},
		{"cache", true, true},
		{"cache/x.bin", false, true},
		{"cache", false, false},
		{"world/region/r.0.0.mca", false, true},
		{"world/level.dat", false, false},
		{"logs/latest.log", false, true},
		{"a/b/tmp", true, true},
		{"a/b/tmp/file", false, true},
		{"server.jar", false, false},
	}
	for _, c := range cases {
		if got := m.Match(c.rel, c.isDir); got != c.want {
			t.Errorf("%q (dir=%v): got %v want %v", c.rel, c.isDir, got, c.want)
		}
	}
	if NewMatcher(nil).Match("anything", false) {
		t.Fatal("empty matcher must match nothing")
	}
}

func TestCreateRestoreRoundTrip(t *testing.T) {
	data := t.TempDir()
	os.MkdirAll(filepath.Join(data, "world", "region"), 0o755)
	os.MkdirAll(filepath.Join(data, "cache"), 0o755)
	os.WriteFile(filepath.Join(data, "server.jar"), []byte("jar"), 0o644)
	os.WriteFile(filepath.Join(data, "world", "region", "r.mca"), []byte("region"), 0o644)
	os.WriteFile(filepath.Join(data, "cache", "x"), []byte("skip"), 0o644)
	os.WriteFile(filepath.Join(data, "debug.log"), []byte("skip"), 0o644)
	dest := ArchivePath(t.TempDir(), "uuid", "id")
	var reports int
	res, err := Create(context.Background(), data, dest, []string{"cache/", "*.log"}, func(protocol.BackupProgress) { reports++ })
	if err != nil || res.Files != 2 || res.Size == 0 || len(res.SHA256) != 64 || reports == 0 {
		t.Fatalf("create: %+v %v reports=%d", res, err, reports)
	}
	restored := t.TempDir()
	os.WriteFile(filepath.Join(restored, "stale"), []byte("x"), 0o644)
	rr, err := Restore(context.Background(), dest, restored, true, os.Getuid(), os.Getgid(), false, nil)
	if err != nil || rr.Files != 2 {
		t.Fatalf("restore: %+v %v", rr, err)
	}
	if _, err := os.Stat(filepath.Join(restored, "stale")); err == nil {
		t.Fatal("wipe should have removed stale files")
	}
	if b, _ := os.ReadFile(filepath.Join(restored, "world", "region", "r.mca")); string(b) != "region" {
		t.Fatalf("restored content %q", b)
	}
	if _, err := os.Stat(filepath.Join(restored, "cache")); err == nil {
		t.Fatal("ignored dir should not be restored")
	}
	list, err := List(filepath.Dir(filepath.Dir(dest)), "uuid")
	if err != nil || len(list) != 1 || list[0].BackupID != "id" {
		t.Fatalf("list: %+v %v", list, err)
	}
	if err := Delete(filepath.Dir(filepath.Dir(dest)), "uuid", "id"); err != nil {
		t.Fatal(err)
	}
	if err := Delete(filepath.Dir(filepath.Dir(dest)), "uuid", "id"); err != nil {
		t.Fatal("deleting twice must be fine")
	}
}
