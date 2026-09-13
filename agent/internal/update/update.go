// Package update replaces the running agent binary with a verified download.
package update

import (
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Apply downloads serverURL+path, verifies its SHA-256, and atomically replaces the current
// executable. It does not restart; the caller exits and the service manager (systemd's
// Restart=always, or the Windows service's recovery action) brings up the new binary.
func Apply(serverURL, path, wantSHA string, insecure bool) error {
	self, err := os.Executable()
	if err != nil {
		return fmt.Errorf("locate executable: %w", err)
	}
	self, _ = filepath.EvalSymlinks(self)

	client := &http.Client{Timeout: 5 * time.Minute}
	if insecure {
		client.Transport = &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}
	}
	url := strings.TrimRight(serverURL, "/") + "/" + strings.TrimLeft(path, "/")
	resp, err := client.Get(url)
	if err != nil {
		return fmt.Errorf("download: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("download: server returned %d", resp.StatusCode)
	}

	tmp, err := os.CreateTemp(filepath.Dir(self), ".gsm-agent-*.tmp")
	if err != nil {
		return fmt.Errorf("temp file: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)

	h := sha256.New()
	if _, err := io.Copy(io.MultiWriter(tmp, h), resp.Body); err != nil {
		tmp.Close()
		return fmt.Errorf("write: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	got := hex.EncodeToString(h.Sum(nil))
	if !strings.EqualFold(got, wantSHA) {
		return fmt.Errorf("checksum mismatch: got %s want %s", got, wantSHA)
	}
	if err := os.Chmod(tmpName, 0o755); err != nil {
		return err
	}
	if err := replaceExecutable(tmpName, self); err != nil {
		return fmt.Errorf("replace binary: %w", err)
	}
	return nil
}
