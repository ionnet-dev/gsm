//go:build !windows

package config

func defaultConfigPath() string      { return "/etc/gsm-agent/config.yaml" }
func defaultCredentialsPath() string { return "/var/lib/gsm-agent/credentials" }
func defaultDataDir() string         { return "/var/lib/gsm" }

// restrictToAdmins is a no-op: the 0600 mode already keeps the file to root.
func restrictToAdmins(string) error { return nil }
