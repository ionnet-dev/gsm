// Package backups makes and restores gzipped tars of an instance's data directory.
package backups

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/ionnet/gsm/agent/internal/protocol"
)

// progressEvery bounds how often progress is reported.
const progressEvery = time.Second

// InvalidError is a caller mistake; the RPC layer maps it to invalid_params.
type InvalidError struct{ Msg string }

func (e *InvalidError) Error() string { return e.Msg }

// ArchivePath is where a backup lives: <backupsDir>/<uuid>/<backupId>.tar.gz.
func ArchivePath(backupsDir, uuid, backupID string) string {
	return filepath.Join(backupsDir, uuid, backupID+".tar.gz")
}

// Matcher decides which relative paths a backup leaves out.
type Matcher struct{ patterns []string }

// NewMatcher compiles gitignore-style globs: `*` within a segment, `**` across segments, a
// trailing `/` for directories, and a pattern without `/` matching at any depth.
func NewMatcher(patterns []string) *Matcher {
	m := &Matcher{}
	for _, p := range patterns {
		p = strings.TrimSpace(p)
		if p == "" || strings.HasPrefix(p, "#") {
			continue
		}
		m.patterns = append(m.patterns, strings.TrimPrefix(p, "/"))
	}
	return m
}

// Match reports whether rel (slash-separated, relative to the data dir) or one of its parents
// matches a pattern.
func (m *Matcher) Match(rel string, isDir bool) bool {
	if m == nil || len(m.patterns) == 0 {
		return false
	}
	rel = strings.Trim(rel, "/")
	segs := strings.Split(rel, "/")
	for _, p := range m.patterns {
		dirOnly := strings.HasSuffix(p, "/")
		p = strings.TrimSuffix(p, "/")
		// The path itself and each ancestor directory.
		for i := len(segs); i >= 1; i-- {
			candidate := strings.Join(segs[:i], "/")
			candIsDir := isDir || i < len(segs)
			if dirOnly && !candIsDir {
				continue
			}
			if matchGlob(p, candidate) {
				return true
			}
		}
	}
	return false
}

// matchGlob matches pattern against rel with `**` support. A pattern without a slash matches the
// path's base name at any depth.
func matchGlob(pattern, rel string) bool {
	if !strings.Contains(pattern, "/") {
		ok, _ := path.Match(pattern, path.Base(rel))
		return ok
	}
	return matchSegs(strings.Split(pattern, "/"), strings.Split(rel, "/"))
}

func matchSegs(p, s []string) bool {
	for len(p) > 0 {
		if p[0] == "**" {
			if len(p) == 1 {
				return true
			}
			for i := 0; i <= len(s); i++ {
				if matchSegs(p[1:], s[i:]) {
					return true
				}
			}
			return false
		}
		if len(s) == 0 {
			return false
		}
		if ok, _ := path.Match(p[0], s[0]); !ok {
			return false
		}
		p, s = p[1:], s[1:]
	}
	return len(s) == 0
}

// Create archives dataDir into dest (written to dest+".tmp" and renamed), leaving out matches.
func Create(ctx context.Context, dataDir, dest string, ignore []string, progress func(protocol.BackupProgress)) (*protocol.BackupCreateResult, error) {
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return nil, err
	}
	tmp := dest + ".tmp"
	out, err := os.Create(tmp)
	if err != nil {
		return nil, err
	}
	defer os.Remove(tmp)
	h := sha256.New()
	cw := &countWriter{w: io.MultiWriter(out, h)}
	gz := gzip.NewWriter(cw)
	tw := tar.NewWriter(gz)
	m := NewMatcher(ignore)
	files := 0
	var lastReport time.Time
	report := func(force bool) {
		if progress == nil {
			return
		}
		if force || time.Since(lastReport) >= progressEvery {
			lastReport = time.Now()
			progress(protocol.BackupProgress{Bytes: cw.n, Files: files})
		}
	}
	root := filepath.Clean(dataDir)
	err = filepath.WalkDir(root, func(cur string, d fs.DirEntry, err error) error {
		if err != nil {
			if cur == root {
				return err
			}
			return nil
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if cur == root {
			return nil
		}
		rel, _ := filepath.Rel(root, cur)
		rel = filepath.ToSlash(rel)
		if m.Match(rel, d.IsDir()) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		if !d.IsDir() && !info.Mode().IsRegular() {
			return nil
		}
		hdr, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return nil
		}
		hdr.Name = rel
		if d.IsDir() {
			hdr.Name += "/"
		}
		hdr.Uid, hdr.Gid, hdr.Uname, hdr.Gname = 0, 0, "", ""
		if err := tw.WriteHeader(hdr); err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		f, err := os.Open(cur)
		if err != nil {
			return nil
		}
		defer f.Close()
		if _, err := io.CopyN(tw, f, info.Size()); err != nil {
			if errors.Is(err, io.EOF) {
				return fmt.Errorf("%s shrank while being archived", rel)
			}
			return err
		}
		files++
		report(false)
		return nil
	})
	if err == nil {
		err = tw.Close()
	}
	if err == nil {
		err = gz.Close()
	}
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return nil, err
	}
	if err := os.Rename(tmp, dest); err != nil {
		return nil, err
	}
	report(true)
	return &protocol.BackupCreateResult{Size: cw.n, SHA256: hex.EncodeToString(h.Sum(nil)), Files: files}, nil
}

// Restore unpacks archive over dataDir (emptied first with wipe); entries escaping it are refused.
// Extracted files are chowned to uid:gid when chown is set.
func Restore(ctx context.Context, archive, dataDir string, wipe bool, uid, gid int, chown bool, progress func(protocol.BackupProgress)) (*protocol.BackupRestoreResult, error) {
	f, err := os.Open(archive)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, &InvalidError{"the backup archive is not on the node"}
		}
		return nil, err
	}
	defer f.Close()
	root := filepath.Clean(dataDir)
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, err
	}
	if wipe {
		entries, err := os.ReadDir(root)
		if err != nil {
			return nil, err
		}
		for _, e := range entries {
			if err := os.RemoveAll(filepath.Join(root, e.Name())); err != nil {
				return nil, err
			}
		}
	}
	gz, err := gzip.NewReader(f)
	if err != nil {
		return nil, &InvalidError{"the backup is not a gzip archive"}
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	files := 0
	var bytes int64
	var lastReport time.Time
	report := func(force bool) {
		if progress != nil && (force || time.Since(lastReport) >= progressEvery) {
			lastReport = time.Now()
			progress(protocol.BackupProgress{Bytes: bytes, Files: files})
		}
	}
	own := func(p string) {
		if chown {
			_ = os.Lchown(p, uid, gid)
		}
	}
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, err
		}
		name := strings.TrimPrefix(hdr.Name, "./")
		if strings.HasPrefix(name, "/") {
			return nil, &InvalidError{"archive entry has an absolute path: " + hdr.Name}
		}
		for _, seg := range strings.Split(name, "/") {
			if seg == ".." {
				return nil, &InvalidError{"archive entry escapes the data directory: " + hdr.Name}
			}
		}
		p := filepath.Join(root, filepath.FromSlash(path.Clean("/"+name)))
		if p != root && !strings.HasPrefix(p, root+string(filepath.Separator)) {
			return nil, &InvalidError{"archive entry escapes the data directory: " + hdr.Name}
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(p, 0o755); err != nil {
				return nil, err
			}
			own(p)
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
				return nil, err
			}
			own(filepath.Dir(p))
			mode := fs.FileMode(hdr.Mode).Perm() | 0o600
			out, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
			if err != nil {
				return nil, err
			}
			n, err := io.Copy(out, tr)
			out.Close()
			if err != nil {
				return nil, err
			}
			own(p)
			bytes += n
			files++
			report(false)
		}
	}
	report(true)
	return &protocol.BackupRestoreResult{Files: files}, nil
}

// List reports the archives on disk for one instance.
func List(backupsDir, uuid string) ([]protocol.BackupListEntry, error) {
	entries, err := os.ReadDir(filepath.Join(backupsDir, uuid))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return []protocol.BackupListEntry{}, nil
		}
		return nil, err
	}
	out := []protocol.BackupListEntry{}
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".tar.gz") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		out = append(out, protocol.BackupListEntry{
			BackupID: strings.TrimSuffix(e.Name(), ".tar.gz"),
			Size:     info.Size(),
			Mtime:    info.ModTime().UTC(),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Mtime.After(out[j].Mtime) })
	return out, nil
}

// Delete removes one archive; a missing one is not an error.
func Delete(backupsDir, uuid, backupID string) error {
	err := os.Remove(ArchivePath(backupsDir, uuid, backupID))
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

type countWriter struct {
	w io.Writer
	n int64
}

func (c *countWriter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	c.n += int64(n)
	return n, err
}
