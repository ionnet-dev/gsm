package sftpd

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/pkg/sftp"
)

// handler serves one SFTP channel over an os.Root, so no path leaves the instance directory:
// `..` and symlinks are resolved inside the root and refused when they would escape it.
type handler struct {
	root     *os.Root
	stats    *counters
	uid, gid int
	chown    bool
}

var errPermission = sftp.ErrSSHFxPermissionDenied

// relPath turns a request path (absolute in the virtual root "/") into a name inside the root.
func relPath(p string) string {
	c := strings.TrimPrefix(path.Clean("/"+p), "/")
	if c == "" {
		return "."
	}
	return c
}

func (h *handler) Fileread(r *sftp.Request) (io.ReaderAt, error) {
	f, err := h.openRegular(relPath(r.Filepath), os.O_RDONLY, false)
	if err != nil {
		return nil, err
	}
	h.stats.downloads.Add(1)
	return &countedFile{File: f, stats: h.stats}, nil
}

func (h *handler) Filewrite(r *sftp.Request) (io.WriterAt, error) {
	return h.openWrite(r, false)
}

// OpenFile serves opens for reading and writing at once.
func (h *handler) OpenFile(r *sftp.Request) (sftp.WriterAtReaderAt, error) {
	return h.openWrite(r, true)
}

func (h *handler) openWrite(r *sftp.Request, read bool) (*countedFile, error) {
	name := relPath(r.Filepath)
	if name == "." {
		return nil, errPermission
	}
	pf := r.Pflags()
	flags := os.O_WRONLY
	if read {
		flags = os.O_RDWR
	}
	if pf.Creat {
		flags |= os.O_CREATE
	}
	if pf.Trunc {
		flags |= os.O_TRUNC
	}
	if pf.Excl {
		flags |= os.O_EXCL
	}
	// O_APPEND is never passed on: WriteAt refuses such files, and SFTP writes carry offsets.
	_, statErr := h.root.Lstat(name)
	created := errors.Is(statErr, fs.ErrNotExist)
	f, err := h.openRegular(name, flags, created)
	if err != nil {
		return nil, err
	}
	if created && h.chown {
		_ = h.root.Lchown(name, h.uid, h.gid)
	}
	h.stats.uploads.Add(1)
	return &countedFile{File: f, stats: h.stats}, nil
}

// openRegular opens name without ever blocking on a FIFO and refuses anything but a regular file.
func (h *handler) openRegular(name string, flags int, creating bool) (*os.File, error) {
	if !creating {
		if fi, err := h.root.Stat(name); err == nil && !fi.Mode().IsRegular() {
			return nil, errPermission
		}
	}
	f, err := h.root.OpenFile(name, flags|syscall.O_NONBLOCK, 0o644)
	if err != nil {
		return nil, err
	}
	if fi, err := f.Stat(); err != nil || !fi.Mode().IsRegular() {
		_ = f.Close()
		return nil, errPermission
	}
	return f, nil
}

func (h *handler) Filecmd(r *sftp.Request) error {
	name := relPath(r.Filepath)
	switch r.Method {
	case "Setstat":
		return h.setstat(name, r)
	case "Rename":
		target := relPath(r.Target)
		if name == "." || target == "." {
			return errPermission
		}
		if _, err := h.root.Lstat(target); err == nil {
			return fmt.Errorf("%s: %w", r.Target, fs.ErrExist)
		}
		if err := h.root.Rename(name, target); err != nil {
			return err
		}
		h.stats.renamed.Add(1)
		return nil
	case "Mkdir":
		if err := h.root.Mkdir(name, 0o755); err != nil {
			return err
		}
		if h.chown {
			_ = h.root.Lchown(name, h.uid, h.gid)
		}
		h.stats.mkdirs.Add(1)
		return nil
	case "Rmdir", "Remove":
		if name == "." {
			return errPermission
		}
		fi, err := h.root.Lstat(name)
		if err != nil {
			return err
		}
		if fi.IsDir() != (r.Method == "Rmdir") {
			if fi.IsDir() {
				return fmt.Errorf("%s is a directory", r.Filepath)
			}
			return fmt.Errorf("%s is not a directory", r.Filepath)
		}
		if err := h.root.Remove(name); err != nil {
			return err
		}
		h.stats.removed.Add(1)
		return nil
	case "Symlink", "Link":
		// Links could point the game (or a later tool) at something unexpected; none are made.
		return errPermission
	}
	return sftp.ErrSSHFxOpUnsupported
}

// PosixRename replaces the target if it exists.
func (h *handler) PosixRename(r *sftp.Request) error {
	name, target := relPath(r.Filepath), relPath(r.Target)
	if name == "." || target == "." {
		return errPermission
	}
	if err := h.root.Rename(name, target); err != nil {
		return err
	}
	h.stats.renamed.Add(1)
	return nil
}

// setstat applies size, permissions and times; owners never change (instance files always belong
// to the container user).
func (h *handler) setstat(name string, r *sftp.Request) error {
	af := r.AttrFlags()
	a := r.Attributes()
	if a == nil {
		return nil
	}
	if af.Size {
		f, err := h.openRegular(name, os.O_WRONLY, false)
		if err != nil {
			return err
		}
		err = f.Truncate(int64(a.Size))
		_ = f.Close()
		if err != nil {
			return err
		}
	}
	if af.Permissions {
		if err := h.root.Chmod(name, fs.FileMode(a.Mode&0o777)); err != nil {
			return err
		}
	}
	if af.Acmodtime {
		if err := h.root.Chtimes(name, time.Unix(int64(a.Atime), 0), time.Unix(int64(a.Mtime), 0)); err != nil {
			return err
		}
	}
	return nil
}

func (h *handler) Filelist(r *sftp.Request) (sftp.ListerAt, error) {
	name := relPath(r.Filepath)
	switch r.Method {
	case "List":
		d, err := h.root.OpenFile(name, os.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NONBLOCK, 0)
		if err != nil {
			return nil, err
		}
		defer d.Close()
		entries, err := d.Readdir(-1)
		if err != nil {
			return nil, err
		}
		sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
		return listerAt(entries), nil
	case "Stat":
		fi, err := h.root.Stat(name)
		if err != nil {
			return nil, err
		}
		return listerAt{fi}, nil
	case "Readlink":
		target, err := h.root.Readlink(name)
		if err != nil {
			return nil, err
		}
		return listerAt{linkTarget(target)}, nil
	}
	return nil, sftp.ErrSSHFxOpUnsupported
}

// Lstat does not follow a final symlink.
func (h *handler) Lstat(r *sftp.Request) (sftp.ListerAt, error) {
	fi, err := h.root.Lstat(relPath(r.Filepath))
	if err != nil {
		return nil, err
	}
	return listerAt{fi}, nil
}

type listerAt []os.FileInfo

func (l listerAt) ListAt(ls []os.FileInfo, offset int64) (int, error) {
	if offset >= int64(len(l)) {
		return 0, io.EOF
	}
	n := copy(ls, l[offset:])
	if n < len(ls) {
		return n, io.EOF
	}
	return n, nil
}

// linkTarget carries a symlink's target as the name pkg/sftp answers Readlink with.
type linkTarget string

func (l linkTarget) Name() string     { return string(l) }
func (linkTarget) Size() int64        { return 0 }
func (linkTarget) Mode() fs.FileMode  { return fs.ModeSymlink | 0o777 }
func (linkTarget) ModTime() time.Time { return time.Time{} }
func (linkTarget) IsDir() bool        { return false }
func (linkTarget) Sys() any           { return nil }

// countedFile counts the bytes a session moves.
type countedFile struct {
	*os.File
	stats *counters
}

func (f *countedFile) ReadAt(p []byte, off int64) (int, error) {
	n, err := f.File.ReadAt(p, off)
	f.stats.bytesOut.Add(int64(n))
	return n, err
}

func (f *countedFile) WriteAt(p []byte, off int64) (int, error) {
	n, err := f.File.WriteAt(p, off)
	f.stats.bytesIn.Add(int64(n))
	return n, err
}
