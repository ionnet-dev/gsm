package logging

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
)

// RotatingFile is a log file that starts over (keeping one .1 copy) once it reaches maxBytes, for
// platforms without a journal to hand output to (the Windows service).
type RotatingFile struct {
	mu       sync.Mutex
	path     string
	maxBytes int64
	f        *os.File
	size     int64
}

// OpenRotatingFile opens (or creates) path for appending.
func OpenRotatingFile(path string, maxBytes int64) (*RotatingFile, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, err
	}
	st, _ := f.Stat()
	r := &RotatingFile{path: path, maxBytes: maxBytes, f: f}
	if st != nil {
		r.size = st.Size()
	}
	return r, nil
}

func (r *RotatingFile) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.size+int64(len(p)) > r.maxBytes {
		r.f.Close()
		_ = os.Remove(r.path + ".1")
		_ = os.Rename(r.path, r.path+".1")
		f, err := os.OpenFile(r.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
		if err != nil {
			return 0, err
		}
		r.f, r.size = f, 0
	}
	n, err := r.f.Write(p)
	r.size += int64(n)
	return n, err
}

func (r *RotatingFile) Close() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.f.Close()
}

// SetupTo installs the default logger writing timestamped key=value lines to w.
func SetupTo(level string, w io.Writer) *slog.Logger {
	h := slog.NewTextHandler(w, &slog.HandlerOptions{Level: parseLevel(level)})
	l := slog.New(h)
	slog.SetDefault(l)
	return l
}
