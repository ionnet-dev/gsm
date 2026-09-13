package instfs

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newFS(t *testing.T) *FS {
	t.Helper()
	root := t.TempDir()
	return &FS{Root: root, UID: os.Getuid(), GID: os.Getgid()}
}

func TestResolveRefusesEscapes(t *testing.T) {
	f := newFS(t)
	for _, bad := range []string{"../x", "a/../../x", "/etc/passwd", "a\x00b"} {
		if _, _, err := f.Resolve(bad); err == nil {
			t.Fatalf("%q should be refused", bad)
		}
	}
	for _, ok := range []string{"", ".", "a/b", "./a", "a//b/"} {
		if _, _, err := f.Resolve(ok); err != nil {
			t.Fatalf("%q should be accepted: %v", ok, err)
		}
	}
	// A symlink pointing outside the root is refused, inside is fine.
	outside := t.TempDir()
	os.WriteFile(filepath.Join(outside, "secret"), []byte("x"), 0o644)
	os.Symlink(outside, filepath.Join(f.Root, "out"))
	os.Mkdir(filepath.Join(f.Root, "in"), 0o755)
	os.Symlink(filepath.Join(f.Root, "in"), filepath.Join(f.Root, "link"))
	if _, _, err := f.Resolve("out/secret"); err == nil {
		t.Fatal("symlink escape should be refused")
	}
	if _, _, err := f.Resolve("out/new/file"); err == nil {
		t.Fatal("symlink escape under a missing path should be refused")
	}
	if _, _, err := f.Resolve("link/file"); err != nil {
		t.Fatalf("inside symlink should be fine: %v", err)
	}
	if _, err := f.Read("out/secret", 1024); err == nil {
		t.Fatal("read through an escaping symlink must fail")
	}
}

func TestWriteReadListDelete(t *testing.T) {
	f := newFS(t)
	if _, err := f.Write("cfg/a.txt", "hello", nil, false); err == nil {
		t.Fatal("writing a missing file without create must fail")
	}
	w, err := f.Write("cfg/a.txt", "hello", nil, true)
	if err != nil {
		t.Fatal(err)
	}
	r, err := f.Read("cfg/a.txt", 1024)
	if err != nil || r.Content == nil || *r.Content != "hello" || r.SHA256 != w.SHA256 {
		t.Fatalf("read: %+v %v", r, err)
	}
	stale := "0000000000000000000000000000000000000000000000000000000000000000"
	_, err = f.Write("cfg/a.txt", "changed", &stale, false)
	var ie *InvalidError
	if err == nil || !errorsAs(err, &ie) || ie.Data["conflict"] != true {
		t.Fatalf("expected a conflict, got %v", err)
	}
	if _, err := f.Write("cfg/a.txt", "changed", &w.SHA256, false); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(f.Root, "cfg", "bin"), []byte("a\x00b"), 0o644)
	if r, _ := f.Read("cfg/bin", 1024); !r.Binary || r.Content != nil {
		t.Fatalf("binary detection: %+v", r)
	}
	if r, _ := f.Read("cfg/a.txt", 2); !r.TooLarge {
		t.Fatalf("too large: %+v", r)
	}
	l, err := f.List("cfg")
	if err != nil || len(l.Entries) != 2 || l.Path != "cfg" {
		t.Fatalf("list: %+v %v", l, err)
	}
	if _, err := f.Delete([]string{""}); err == nil {
		t.Fatal("deleting the root must fail")
	}
	if n, err := f.Delete([]string{"cfg/a.txt", "missing"}); err != nil || n != 1 {
		t.Fatalf("delete: %d %v", n, err)
	}
	if _, err := f.Rename("cfg/bin", "cfg2/bin"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Rename("cfg2/bin", "cfg2/bin"); err == nil {
		t.Fatal("rename onto an existing file must fail")
	}
}

func errorsAs(err error, target **InvalidError) bool {
	ie, ok := err.(*InvalidError)
	if ok {
		*target = ie
	}
	return ok
}

func TestExtractRefusesEscapes(t *testing.T) {
	f := newFS(t)
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, _ := zw.Create("../evil.txt")
	w.Write([]byte("x"))
	zw.Close()
	os.WriteFile(filepath.Join(f.Root, "bad.zip"), buf.Bytes(), 0o644)
	if _, err := f.Extract(context.Background(), "bad.zip", "dest"); err == nil {
		t.Fatal("zip escape must be refused")
	}

	buf.Reset()
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	tw.WriteHeader(&tar.Header{Name: "ok/../../evil", Mode: 0o644, Size: 1, Typeflag: tar.TypeReg})
	tw.Write([]byte("x"))
	tw.Close()
	gz.Close()
	os.WriteFile(filepath.Join(f.Root, "bad.tgz"), buf.Bytes(), 0o644)
	if _, err := f.Extract(context.Background(), "bad.tgz", ""); err == nil {
		t.Fatal("tar escape must be refused")
	}
}

func TestCompressAndExtractRoundTrip(t *testing.T) {
	f := newFS(t)
	f.Mkdir("world/region")
	f.Write("world/level.dat", "level", nil, true)
	f.Write("world/region/r.0.0.mca", strings.Repeat("r", 1000), nil, true)
	f.Write("server.properties", "a=b", nil, true)
	res, err := f.Compress(context.Background(), []string{"world", "server.properties"}, "pack.tar.gz")
	if err != nil || res.Size == 0 || len(res.SHA256) != 64 {
		t.Fatalf("compress: %+v %v", res, err)
	}
	n, err := f.Extract(context.Background(), "pack.tar.gz", "restored")
	if err != nil || n != 3 {
		t.Fatalf("extract: %d %v", n, err)
	}
	r, err := f.Read("restored/world/region/r.0.0.mca", 1<<20)
	if err != nil || r.Size != 1000 {
		t.Fatalf("round trip: %+v %v", r, err)
	}
	zres, err := f.Compress(context.Background(), []string{"world"}, "pack.zip")
	if err != nil || zres.Size == 0 {
		t.Fatalf("zip: %v", err)
	}
	if n, err := f.Extract(context.Background(), "pack.zip", "z"); err != nil || n != 2 {
		t.Fatalf("unzip: %d %v", n, err)
	}
	if _, err := f.Stat("z/world/level.dat"); err != nil {
		t.Fatal(err)
	}
}

func TestReceiveAndSend(t *testing.T) {
	f := newFS(t)
	data := []byte("upload me")
	res, err := f.Receive(context.Background(), "up/file.bin", int64(len(data)), false, bytes.NewReader(data), func(sha string) error {
		if len(sha) != 64 {
			t.Fatalf("bad sha %q", sha)
		}
		return nil
	})
	if err != nil || res.Size != int64(len(data)) {
		t.Fatalf("receive: %+v %v", res, err)
	}
	if _, err := f.Receive(context.Background(), "up/file.bin", 1, false, bytes.NewReader([]byte("x")), nil); err == nil {
		t.Fatal("overwrite without the flag must fail")
	}
	var out bytes.Buffer
	sent, err := f.Send(context.Background(), []string{"up/file.bin"}, false, &out)
	if err != nil || out.String() != "upload me" || sent.SHA256 != res.SHA256 {
		t.Fatalf("send: %+v %v", sent, err)
	}
	out.Reset()
	if _, err := f.Send(context.Background(), []string{"up"}, true, &out); err != nil || out.Len() == 0 {
		t.Fatalf("archive send: %v", err)
	}
}
