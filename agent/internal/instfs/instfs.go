// Package instfs is the file manager for one instance's data directory. Every path is relative to
// the instance root and confined to it: no `..`, no absolute paths, and symlinks that resolve
// outside the root are refused.
package instfs

import (
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
	"unicode/utf8"

	"github.com/ionnet/gsm/agent/internal/protocol"
)

// FS operates inside Root. Files it creates are chowned to UID:GID when Chown is set.
type FS struct {
	Root  string
	UID   int
	GID   int
	Chown bool
}

// InvalidError is a caller mistake (bad path, missing file, exists already); the RPC layer maps it
// to invalid_params.
type InvalidError struct {
	Msg  string
	Data map[string]any
}

func (e *InvalidError) Error() string { return e.Msg }

func invalid(format string, args ...any) error {
	return &InvalidError{Msg: fmt.Sprintf(format, args...)}
}

// Clean normalises a relative path: "", "." and "/" all mean the root. `..` segments are refused.
func Clean(rel string) (string, error) {
	if strings.ContainsRune(rel, 0) {
		return "", invalid("path contains NUL")
	}
	if strings.HasPrefix(rel, "/") {
		return "", invalid("path must be relative to the instance")
	}
	for _, seg := range strings.Split(rel, "/") {
		if seg == ".." {
			return "", invalid("path may not contain ..")
		}
	}
	c := path.Clean("/" + rel)
	return strings.TrimPrefix(c, "/"), nil
}

// Resolve turns a relative path into an absolute one under Root and checks it stays there even
// through symlinks. The file itself need not exist; its deepest existing ancestor is resolved.
func (f *FS) Resolve(rel string) (abs string, clean string, err error) {
	clean, err = Clean(rel)
	if err != nil {
		return "", "", err
	}
	root, err := filepath.EvalSymlinks(f.Root)
	if err != nil {
		return "", "", fmt.Errorf("instance root: %w", err)
	}
	abs = filepath.Join(root, filepath.FromSlash(clean))
	// Resolve the deepest existing ancestor and make sure it is still inside the root.
	probe := abs
	var rest []string
	for {
		resolved, err := filepath.EvalSymlinks(probe)
		if err == nil {
			if !within(root, resolved) {
				return "", "", invalid("path resolves outside the instance")
			}
			final := resolved
			for i := len(rest) - 1; i >= 0; i-- {
				final = filepath.Join(final, rest[i])
			}
			if !within(root, final) {
				return "", "", invalid("path resolves outside the instance")
			}
			return abs, clean, nil
		}
		if !errors.Is(err, fs.ErrNotExist) {
			return "", "", err
		}
		parent, base := filepath.Dir(probe), filepath.Base(probe)
		if parent == probe {
			return "", "", invalid("path resolves outside the instance")
		}
		rest = append(rest, base)
		probe = parent
	}
}

func within(root, p string) bool {
	return p == root || strings.HasPrefix(p, root+string(filepath.Separator))
}

func (f *FS) chown(p string) {
	if f.Chown {
		_ = os.Lchown(p, f.UID, f.GID)
	}
}

func entryOf(dir string, info fs.FileInfo) protocol.FileEntry {
	e := protocol.FileEntry{
		Name:  info.Name(),
		Size:  info.Size(),
		Mode:  int(info.Mode().Perm()),
		Mtime: info.ModTime().UTC(),
	}
	switch {
	case info.Mode()&fs.ModeSymlink != 0:
		e.Type = "symlink"
		if st, err := os.Stat(filepath.Join(dir, info.Name())); err == nil {
			t := kindOf(st.Mode())
			e.TargetType = &t
		}
	case info.IsDir():
		e.Type = "dir"
	case info.Mode().IsRegular():
		e.Type = "file"
	default:
		e.Type = "other"
	}
	return e
}

func kindOf(m fs.FileMode) string {
	switch {
	case m.IsDir():
		return "dir"
	case m.IsRegular():
		return "file"
	case m&fs.ModeSymlink != 0:
		return "symlink"
	default:
		return "other"
	}
}

// List lists a directory, directories first, at most FileListMax entries.
func (f *FS) List(rel string) (*protocol.FileListResult, error) {
	abs, clean, err := f.Resolve(rel)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(abs)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, invalid("no such directory: %s", clean)
		}
		return nil, err
	}
	out := &protocol.FileListResult{Path: clean, Entries: []protocol.FileEntry{}}
	for _, de := range entries {
		if len(out.Entries) >= protocol.FileListMax {
			out.Truncated = true
			break
		}
		info, err := de.Info()
		if err != nil {
			continue
		}
		out.Entries = append(out.Entries, entryOf(abs, info))
	}
	sort.SliceStable(out.Entries, func(i, j int) bool {
		a, b := out.Entries[i], out.Entries[j]
		if (a.Type == "dir") != (b.Type == "dir") {
			return a.Type == "dir"
		}
		return strings.ToLower(a.Name) < strings.ToLower(b.Name)
	})
	return out, nil
}

// Stat describes one path without following a final symlink.
func (f *FS) Stat(rel string) (*protocol.FileStatResult, error) {
	abs, clean, err := f.Resolve(rel)
	if err != nil {
		return nil, err
	}
	info, err := os.Lstat(abs)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, invalid("no such file: %s", clean)
		}
		return nil, err
	}
	return &protocol.FileStatResult{Path: clean, Entry: entryOf(filepath.Dir(abs), info)}, nil
}

// Read returns a text file's contents (up to maxBytes) with its SHA-256.
func (f *FS) Read(rel string, maxBytes int64) (*protocol.FileReadResult, error) {
	abs, clean, err := f.Resolve(rel)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(abs)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, invalid("no such file: %s", clean)
		}
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, invalid("not a regular file: %s", clean)
	}
	res := &protocol.FileReadResult{Path: clean, Size: info.Size(), Mtime: info.ModTime().UTC(), Mode: int(info.Mode().Perm())}
	if info.Size() > maxBytes {
		res.TooLarge = true
		return res, nil
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return nil, err
	}
	res.SHA256 = sha256Hex(data)
	head := data
	if len(head) > 8192 {
		head = head[:8192]
	}
	if strings.ContainsRune(string(head), 0) || !utf8.Valid(data) {
		res.Binary = true
		return res, nil
	}
	s := string(data)
	res.Content = &s
	return res, nil
}

// Write replaces (or with create, adds) a text file atomically; refused when expectSHA no longer matches.
func (f *FS) Write(rel, content string, expectSHA *string, create bool) (*protocol.FileWriteResult, error) {
	abs, clean, err := f.Resolve(rel)
	if err != nil {
		return nil, err
	}
	info, err := os.Lstat(abs)
	switch {
	case err == nil:
		if create {
			return nil, invalid("already exists: %s", clean)
		}
		if !info.Mode().IsRegular() {
			return nil, invalid("not a regular file: %s", clean)
		}
		if expectSHA != nil {
			cur, err := os.ReadFile(abs)
			if err != nil {
				return nil, err
			}
			if sha256Hex(cur) != *expectSHA {
				return nil, &InvalidError{Msg: "the file changed on disk since it was opened", Data: map[string]any{"conflict": true}}
			}
		}
	case errors.Is(err, fs.ErrNotExist):
		if !create {
			return nil, invalid("no such file: %s", clean)
		}
	default:
		return nil, err
	}
	mode := fs.FileMode(0o644)
	if info != nil {
		mode = info.Mode().Perm()
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return nil, err
	}
	tmp, err := os.CreateTemp(filepath.Dir(abs), ".gsm-write-*")
	if err != nil {
		return nil, err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := tmp.WriteString(content); err != nil {
		tmp.Close()
		return nil, err
	}
	if err := tmp.Close(); err != nil {
		return nil, err
	}
	_ = os.Chmod(tmpName, mode)
	f.chown(tmpName)
	if err := os.Rename(tmpName, abs); err != nil {
		return nil, err
	}
	st, err := os.Stat(abs)
	if err != nil {
		return nil, err
	}
	return &protocol.FileWriteResult{Path: clean, Size: st.Size(), SHA256: sha256Hex([]byte(content)), Mtime: st.ModTime().UTC()}, nil
}

// Mkdir creates a directory and its parents.
func (f *FS) Mkdir(rel string) (string, error) {
	abs, clean, err := f.Resolve(rel)
	if err != nil {
		return "", err
	}
	if clean == "" {
		return "", invalid("the root already exists")
	}
	if err := f.mkdirAllOwned(abs); err != nil {
		return "", err
	}
	return clean, nil
}

// mkdirAllOwned is MkdirAll that chowns every directory it creates.
func (f *FS) mkdirAllOwned(abs string) error {
	if _, err := os.Stat(abs); err == nil {
		return nil
	}
	if parent := filepath.Dir(abs); parent != abs {
		if err := f.mkdirAllOwned(parent); err != nil {
			return err
		}
	}
	if err := os.Mkdir(abs, 0o755); err != nil && !errors.Is(err, fs.ErrExist) {
		return err
	}
	f.chown(abs)
	return nil
}

// Rename moves a file or directory; refused when the destination exists.
func (f *FS) Rename(from, to string) (string, error) {
	src, cleanFrom, err := f.Resolve(from)
	if err != nil {
		return "", err
	}
	dst, cleanTo, err := f.Resolve(to)
	if err != nil {
		return "", err
	}
	if cleanFrom == "" || cleanTo == "" {
		return "", invalid("cannot rename the root")
	}
	if _, err := os.Lstat(src); err != nil {
		return "", invalid("no such file: %s", cleanFrom)
	}
	if _, err := os.Lstat(dst); err == nil {
		return "", invalid("already exists: %s", cleanTo)
	}
	if err := f.mkdirAllOwned(filepath.Dir(dst)); err != nil {
		return "", err
	}
	if err := os.Rename(src, dst); err != nil {
		return "", err
	}
	return cleanTo, nil
}

// Delete removes files and directories (recursively); the root itself is refused.
func (f *FS) Delete(paths []string) (int, error) {
	n := 0
	for _, p := range paths {
		abs, clean, err := f.Resolve(p)
		if err != nil {
			return n, err
		}
		if clean == "" {
			return n, invalid("cannot delete the instance root")
		}
		if _, err := os.Lstat(abs); err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				continue
			}
			return n, err
		}
		if err := os.RemoveAll(abs); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}

// Chmod sets permission bits; symlinks are skipped.
func (f *FS) Chmod(paths []string, mode int, recursive bool) (int, error) {
	n := 0
	apply := func(p string, info fs.FileInfo) {
		if info.Mode()&fs.ModeSymlink != 0 {
			return
		}
		if os.Chmod(p, fs.FileMode(mode)) == nil {
			n++
		}
	}
	for _, p := range paths {
		abs, clean, err := f.Resolve(p)
		if err != nil {
			return n, err
		}
		info, err := os.Lstat(abs)
		if err != nil {
			return n, invalid("no such file: %s", clean)
		}
		apply(abs, info)
		if recursive && info.IsDir() {
			_ = filepath.WalkDir(abs, func(p string, d fs.DirEntry, err error) error {
				if err != nil || p == abs {
					return nil
				}
				if i, err := d.Info(); err == nil {
					apply(p, i)
				}
				return nil
			})
		}
	}
	return n, nil
}

func sha256Hex(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// hashingWriter counts and hashes bytes as they pass.
type hashingWriter struct {
	w io.Writer
	h io.Writer
	n int64
}

func (hw *hashingWriter) Write(p []byte) (int, error) {
	n, err := hw.w.Write(p)
	hw.h.Write(p[:n])
	hw.n += int64(n)
	return n, err
}
