package instfs

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/ionnet/gsm/agent/internal/protocol"
)

// MaxExtractBytes bounds what one extract may write.
const MaxExtractBytes = 20 << 30

// Extract unpacks a .zip, .tar, .tar.gz or .tgz under dest. Entries escaping dest are refused.
func (f *FS) Extract(ctx context.Context, rel, dest string) (int, error) {
	src, cleanSrc, err := f.Resolve(rel)
	if err != nil {
		return 0, err
	}
	dstAbs, _, err := f.Resolve(dest)
	if err != nil {
		return 0, err
	}
	if err := f.mkdirAllOwned(dstAbs); err != nil {
		return 0, err
	}
	name := strings.ToLower(cleanSrc)
	switch {
	case strings.HasSuffix(name, ".zip"):
		return f.extractZip(ctx, src, dstAbs)
	case strings.HasSuffix(name, ".tar.gz"), strings.HasSuffix(name, ".tgz"):
		return f.extractTar(ctx, src, dstAbs, true)
	case strings.HasSuffix(name, ".tar"):
		return f.extractTar(ctx, src, dstAbs, false)
	}
	return 0, invalid("not an archive the agent can unpack: %s", cleanSrc)
}

// target returns the absolute path for an archive entry, refusing escapes.
func (f *FS) target(dst, entry string) (string, error) {
	entry = strings.TrimPrefix(entry, "./")
	if strings.HasPrefix(entry, "/") || strings.Contains(entry, "\\") {
		return "", invalid("archive entry has an unsafe name: %s", entry)
	}
	for _, seg := range strings.Split(entry, "/") {
		if seg == ".." {
			return "", invalid("archive entry escapes the destination: %s", entry)
		}
	}
	p := filepath.Join(dst, filepath.FromSlash(path.Clean("/"+entry)))
	if !within(dst, p) {
		return "", invalid("archive entry escapes the destination: %s", entry)
	}
	return p, nil
}

func (f *FS) extractZip(ctx context.Context, src, dst string) (int, error) {
	zr, err := zip.OpenReader(src)
	if err != nil {
		return 0, invalid("cannot open zip: %v", err)
	}
	defer zr.Close()
	var total int64
	n := 0
	for _, zf := range zr.File {
		if err := ctx.Err(); err != nil {
			return n, err
		}
		p, err := f.target(dst, zf.Name)
		if err != nil {
			return n, err
		}
		mode := zf.Mode()
		if zf.FileInfo().IsDir() || strings.HasSuffix(zf.Name, "/") {
			if err := f.mkdirAllOwned(p); err != nil {
				return n, err
			}
			continue
		}
		if mode&fs.ModeSymlink != 0 {
			continue // symlinks from archives are not restored
		}
		rc, err := zf.Open()
		if err != nil {
			return n, err
		}
		written, err := f.writeEntry(p, rc, mode.Perm(), MaxExtractBytes-total)
		rc.Close()
		if err != nil {
			return n, err
		}
		total += written
		n++
	}
	return n, nil
}

func (f *FS) extractTar(ctx context.Context, src, dst string, gz bool) (int, error) {
	file, err := os.Open(src)
	if err != nil {
		return 0, err
	}
	defer file.Close()
	var r io.Reader = file
	if gz {
		g, err := gzip.NewReader(file)
		if err != nil {
			return 0, invalid("cannot open gzip: %v", err)
		}
		defer g.Close()
		r = g
	}
	tr := tar.NewReader(r)
	var total int64
	n := 0
	for {
		if err := ctx.Err(); err != nil {
			return n, err
		}
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return n, nil
		}
		if err != nil {
			return n, invalid("cannot read tar: %v", err)
		}
		p, err := f.target(dst, hdr.Name)
		if err != nil {
			return n, err
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := f.mkdirAllOwned(p); err != nil {
				return n, err
			}
		case tar.TypeReg:
			written, err := f.writeEntry(p, tr, fs.FileMode(hdr.Mode).Perm(), MaxExtractBytes-total)
			if err != nil {
				return n, err
			}
			total += written
			n++
		default:
			// symlinks, devices and the like are not restored
		}
	}
}

func (f *FS) writeEntry(p string, r io.Reader, mode fs.FileMode, budget int64) (int64, error) {
	if budget <= 0 {
		return 0, invalid("archive exceeds the extraction limit")
	}
	if err := f.mkdirAllOwned(filepath.Dir(p)); err != nil {
		return 0, err
	}
	if mode&0o600 != 0o600 {
		mode |= 0o600
	}
	out, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return 0, err
	}
	written, err := io.Copy(out, io.LimitReader(r, budget+1))
	out.Close()
	if err != nil {
		return written, err
	}
	if written > budget {
		os.Remove(p)
		return written, invalid("archive exceeds the extraction limit")
	}
	f.chown(p)
	return written, nil
}

// Compress packs paths into dest (.tar.gz/.tgz or .zip by extension).
func (f *FS) Compress(ctx context.Context, paths []string, dest string) (*protocol.FileTransferResult, error) {
	dstAbs, cleanDst, err := f.Resolve(dest)
	if err != nil {
		return nil, err
	}
	if _, err := os.Lstat(dstAbs); err == nil {
		return nil, invalid("already exists: %s", cleanDst)
	}
	lower := strings.ToLower(cleanDst)
	isZip := strings.HasSuffix(lower, ".zip")
	if !isZip && !strings.HasSuffix(lower, ".tar.gz") && !strings.HasSuffix(lower, ".tgz") {
		return nil, invalid("destination must end in .zip, .tar.gz or .tgz")
	}
	if err := f.mkdirAllOwned(filepath.Dir(dstAbs)); err != nil {
		return nil, err
	}
	tmp, err := os.CreateTemp(filepath.Dir(dstAbs), ".gsm-compress-*")
	if err != nil {
		return nil, err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	hw := &hashingWriter{w: tmp, h: newSHA()}
	if isZip {
		err = f.writeZip(ctx, hw, paths, dstAbs)
	} else {
		err = f.writeTarGz(ctx, hw, paths, dstAbs)
	}
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return nil, err
	}
	_ = os.Chmod(tmpName, 0o644)
	f.chown(tmpName)
	if err := os.Rename(tmpName, dstAbs); err != nil {
		return nil, err
	}
	return &protocol.FileTransferResult{Path: cleanDst, Size: hw.n, SHA256: hw.sum()}, nil
}

// archiveEntries walks paths (files or directories) and hands each regular file or directory to fn
// with its name inside the archive: relative to the common parent of the first path.
func (f *FS) archiveEntries(ctx context.Context, paths []string, skip string, fn func(name, abs string, info fs.FileInfo) error) error {
	seen := map[string]bool{}
	for _, p := range paths {
		abs, clean, err := f.Resolve(p)
		if err != nil {
			return err
		}
		base := path.Base(clean)
		if clean == "" {
			base = "."
		}
		info, err := os.Lstat(abs)
		if err != nil {
			return invalid("no such file: %s", clean)
		}
		if !info.IsDir() {
			if info.Mode().IsRegular() && !seen[abs] && abs != skip {
				seen[abs] = true
				if err := fn(base, abs, info); err != nil {
					return err
				}
			}
			continue
		}
		err = filepath.WalkDir(abs, func(cur string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if err := ctx.Err(); err != nil {
				return err
			}
			if cur == skip || seen[cur] {
				return nil
			}
			rel, _ := filepath.Rel(abs, cur)
			name := base
			if rel != "." {
				name = path.Join(base, filepath.ToSlash(rel))
			}
			if base == "." {
				name = strings.TrimPrefix(name, "./")
			}
			info, err := d.Info()
			if err != nil {
				return nil
			}
			if !d.IsDir() && !info.Mode().IsRegular() {
				return nil
			}
			seen[cur] = true
			return fn(name, cur, info)
		})
		if err != nil {
			return err
		}
	}
	return nil
}

func (f *FS) writeTarGz(ctx context.Context, w io.Writer, paths []string, skip string) error {
	gz := gzip.NewWriter(w)
	tw := tar.NewWriter(gz)
	err := f.archiveEntries(ctx, paths, skip, func(name, abs string, info fs.FileInfo) error {
		if name == "." || name == "" {
			return nil
		}
		hdr, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return err
		}
		hdr.Name = name
		if info.IsDir() {
			hdr.Name += "/"
		}
		hdr.Uid, hdr.Gid, hdr.Uname, hdr.Gname = 0, 0, "", ""
		if err := tw.WriteHeader(hdr); err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		file, err := os.Open(abs)
		if err != nil {
			return err
		}
		defer file.Close()
		_, err = io.CopyN(tw, file, info.Size())
		return err
	})
	if err != nil {
		return err
	}
	if err := tw.Close(); err != nil {
		return err
	}
	return gz.Close()
}

func (f *FS) writeZip(ctx context.Context, w io.Writer, paths []string, skip string) error {
	zw := zip.NewWriter(w)
	err := f.archiveEntries(ctx, paths, skip, func(name, abs string, info fs.FileInfo) error {
		if name == "." || name == "" {
			return nil
		}
		hdr, err := zip.FileInfoHeader(info)
		if err != nil {
			return err
		}
		hdr.Name = name
		hdr.Method = zip.Deflate
		if info.IsDir() {
			hdr.Name += "/"
			_, err := zw.CreateHeader(hdr)
			return err
		}
		out, err := zw.CreateHeader(hdr)
		if err != nil {
			return err
		}
		file, err := os.Open(abs)
		if err != nil {
			return err
		}
		defer file.Close()
		_, err = io.CopyN(out, file, info.Size())
		return err
	})
	if err != nil {
		return err
	}
	return zw.Close()
}

// Receive writes size bytes from body into rel (beside it, then renamed in) after confirm accepts
// the SHA-256 of what was written.
func (f *FS) Receive(ctx context.Context, rel string, size int64, overwrite bool, body io.Reader, confirm func(sha string) error) (*protocol.FileTransferResult, error) {
	abs, clean, err := f.Resolve(rel)
	if err != nil {
		return nil, err
	}
	if clean == "" {
		return nil, invalid("destination must be a file path")
	}
	if info, err := os.Lstat(abs); err == nil {
		if info.IsDir() {
			return nil, invalid("destination is a directory: %s", clean)
		}
		if !overwrite {
			return nil, invalid("already exists: %s", clean)
		}
	}
	if err := f.mkdirAllOwned(filepath.Dir(abs)); err != nil {
		return nil, err
	}
	tmp, err := os.CreateTemp(filepath.Dir(abs), ".gsm-upload-*")
	if err != nil {
		return nil, err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	hw := &hashingWriter{w: tmp, h: newSHA()}
	_, err = io.Copy(hw, readerWithContext(ctx, body))
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return nil, err
	}
	if hw.n != size {
		return nil, fmt.Errorf("received %d of %d bytes", hw.n, size)
	}
	sha := hw.sum()
	if confirm != nil {
		if err := confirm(sha); err != nil {
			return nil, err
		}
	}
	_ = os.Chmod(tmpName, 0o644)
	f.chown(tmpName)
	if err := os.Rename(tmpName, abs); err != nil {
		return nil, err
	}
	return &protocol.FileTransferResult{Path: clean, Size: size, SHA256: sha}, nil
}

// Send writes one regular file, or a tar.gz of paths, to w.
func (f *FS) Send(ctx context.Context, paths []string, archive bool, w io.Writer) (*protocol.FileTransferResult, error) {
	hw := &hashingWriter{w: w, h: newSHA()}
	if archive {
		if err := f.writeTarGz(ctx, hw, paths, ""); err != nil {
			return nil, err
		}
		_, clean, _ := f.Resolve(paths[0])
		return &protocol.FileTransferResult{Path: clean, Size: hw.n, SHA256: hw.sum()}, nil
	}
	abs, clean, err := f.Resolve(paths[0])
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return nil, invalid("no such file: %s", clean)
	}
	if !info.Mode().IsRegular() {
		return nil, invalid("not a regular file: %s", clean)
	}
	file, err := os.Open(abs)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	if _, err := io.Copy(hw, readerWithContext(ctx, file)); err != nil {
		return nil, err
	}
	return &protocol.FileTransferResult{Path: clean, Size: hw.n, SHA256: hw.sum()}, nil
}

// FileSize returns the size of a regular file for Content-Length.
func (f *FS) FileSize(rel string) (int64, error) {
	abs, clean, err := f.Resolve(rel)
	if err != nil {
		return 0, err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return 0, invalid("no such file: %s", clean)
	}
	if !info.Mode().IsRegular() {
		return 0, invalid("not a regular file: %s", clean)
	}
	return info.Size(), nil
}

type ctxReader struct {
	ctx context.Context
	r   io.Reader
}

func (c ctxReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.Read(p)
}

func readerWithContext(ctx context.Context, r io.Reader) io.Reader { return ctxReader{ctx, r} }
