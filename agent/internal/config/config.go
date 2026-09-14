// Package config loads the agent configuration file and stored credentials.
package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// DefaultConfigPath and DefaultCredentialsPath are set per platform (paths_unix.go).
var (
	DefaultConfigPath      = defaultConfigPath()
	DefaultCredentialsPath = defaultCredentialsPath()
	DefaultDataDir         = defaultDataDir()
)

// Config is the on-disk agent configuration (/etc/gsm-agent/config.yaml).
type Config struct {
	// ServerURL is the base URL of the GSM server, e.g. https://gsm.example.com
	ServerURL string `yaml:"server_url"`
	// CredentialsFile holds the per-agent token issued at enrollment.
	CredentialsFile string `yaml:"credentials_file"`
	// DataDir holds instances/, logs/, backups/ and state/.
	DataDir string `yaml:"data_dir"`
	// MetricsInterval controls how often metrics/heartbeats are sent.
	MetricsInterval time.Duration `yaml:"metrics_interval"`
	// LogLevel: debug | info | warn | error
	LogLevel string `yaml:"log_level"`
	// InsecureSkipVerify disables TLS certificate verification. Development only.
	InsecureSkipVerify bool `yaml:"insecure_skip_verify"`
	// HostMounts lists the node directories (with everything under them) that admins may mount
	// into instances. Empty: none. The panel alone can never expose the rest of the node.
	HostMounts []string `yaml:"host_mounts,omitempty"`
}

func Default() Config {
	return Config{
		ServerURL:       "http://localhost:3000",
		CredentialsFile: DefaultCredentialsPath,
		DataDir:         DefaultDataDir,
		MetricsInterval: 30 * time.Second,
		LogLevel:        "info",
	}
}

// Load reads the YAML config at path, layering it over Default(). A missing file is not an error.
func Load(path string) (Config, error) {
	cfg := Default()
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return cfg, nil
		}
		return cfg, fmt.Errorf("read config: %w", err)
	}
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return cfg, fmt.Errorf("parse config %s: %w", path, err)
	}
	if v := os.Getenv("GSM_SERVER_URL"); v != "" {
		cfg.ServerURL = v
	}
	if v := os.Getenv("GSM_LOG_LEVEL"); v != "" {
		cfg.LogLevel = v
	}
	if v := os.Getenv("GSM_DATA_DIR"); v != "" {
		cfg.DataDir = v
	}
	cfg.ServerURL = strings.TrimRight(cfg.ServerURL, "/")
	if cfg.DataDir == "" {
		cfg.DataDir = DefaultDataDir
	}
	cfg.DataDir = filepath.Clean(cfg.DataDir)
	if cfg.MetricsInterval < 5*time.Second {
		cfg.MetricsInterval = 5 * time.Second
	}
	roots := cfg.HostMounts[:0]
	for _, r := range cfg.HostMounts {
		r = filepath.Clean(strings.TrimSpace(r))
		// The whole node is never a mount root, and a relative path means nothing here.
		if filepath.IsAbs(r) && r != "/" {
			roots = append(roots, r)
		}
	}
	cfg.HostMounts = roots
	return cfg, nil
}

// Save writes the config back to path (used by `gsm-agent enroll`).
func (c Config) Save(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := yaml.Marshal(c)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

// WebSocketURL derives the agent WebSocket endpoint from ServerURL.
func (c Config) WebSocketURL() string {
	u := c.ServerURL
	switch {
	case strings.HasPrefix(u, "https://"):
		u = "wss://" + strings.TrimPrefix(u, "https://")
	case strings.HasPrefix(u, "http://"):
		u = "ws://" + strings.TrimPrefix(u, "http://")
	}
	return u + "/ws/agent"
}

// LoadToken reads the agent token. GSM_AGENT_TOKEN overrides the file (development convenience).
func (c Config) LoadToken() (string, error) {
	if v := os.Getenv("GSM_AGENT_TOKEN"); v != "" {
		return v, nil
	}
	data, err := os.ReadFile(c.CredentialsFile)
	if err != nil {
		return "", fmt.Errorf("read credentials %s (run `gsm-agent enroll` first): %w", c.CredentialsFile, err)
	}
	return strings.TrimSpace(string(data)), nil
}

// SaveToken persists the token with owner-only permissions.
func (c Config) SaveToken(token string) error {
	if err := os.MkdirAll(filepath.Dir(c.CredentialsFile), 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(c.CredentialsFile, []byte(token+"\n"), 0o600); err != nil {
		return err
	}
	return restrictToAdmins(c.CredentialsFile)
}

// Layout of the data directory.
func (c Config) InstancesDir() string { return filepath.Join(c.DataDir, "instances") }
func (c Config) LogsDir() string      { return filepath.Join(c.DataDir, "logs") }
func (c Config) BackupsDir() string   { return filepath.Join(c.DataDir, "backups") }
func (c Config) StateDir() string     { return filepath.Join(c.DataDir, "state") }
func (c Config) DatabasesDir() string { return filepath.Join(c.DataDir, "databases") }

// EnsureDataDir creates the data directory layout.
func (c Config) EnsureDataDir() error {
	for _, d := range []string{c.InstancesDir(), c.LogsDir(), c.BackupsDir(), c.StateDir(), c.DatabasesDir()} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return err
		}
	}
	return nil
}
