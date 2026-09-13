// Package logging configures the process-wide structured logger.
package logging

import (
	"log/slog"
	"os"
	"strings"
)

// Setup installs a slog default logger at the given level ("debug", "info", "warn", "error").
// Under systemd the journal already timestamps lines, so we emit key=value text without time.
func Setup(level string) *slog.Logger {
	h := slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{
		Level: parseLevel(level),
		ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
			if a.Key == slog.TimeKey && len(groups) == 0 && os.Getenv("INVOCATION_ID") != "" {
				return slog.Attr{} // running under systemd: journald has the timestamp
			}
			return a
		},
	})
	l := slog.New(h)
	slog.SetDefault(l)
	return l
}

func parseLevel(level string) slog.Level {
	switch strings.ToLower(level) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}
