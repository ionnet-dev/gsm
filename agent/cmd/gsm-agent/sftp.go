package main

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/ionnet/gsm/agent/internal/config"
	"github.com/ionnet/gsm/agent/internal/instances"
	"github.com/ionnet/gsm/agent/internal/protocol"
	"github.com/ionnet/gsm/agent/internal/sftpd"
	"github.com/ionnet/gsm/agent/internal/transport"
)

// newSFTP builds the SFTP server, which asks the server about every sign-in. It returns nil when the
// host key cannot be loaded; agent.configure then reports SFTP as unavailable.
func newSFTP(ctx context.Context, client *transport.Client, cfg config.Config, m *instances.Manager, log *slog.Logger) *sftpd.Server {
	srv, err := sftpd.New(sftpd.Options{
		Auth: func(ctx context.Context, p protocol.SFTPAuthParams) (protocol.SFTPAuthResult, error) {
			var res protocol.SFTPAuthResult
			err := client.Request(ctx, "sftp.auth", p, &res)
			return res, err
		},
		Emit: func(event string, data any) {
			if err := client.Emit(ctx, event, data); err != nil {
				log.Debug("emit failed", "event", event, "err", err)
			}
		},
		InstanceDir: m.DataDir,
		Owner:       m.OwnerOf,
		StateDir:    cfg.StateDir(),
		Log:         log.With("component", "sftp"),
	})
	if err != nil {
		log.Error("sftp unavailable", "err", err)
		return nil
	}
	return srv
}

// registerSFTP wires sftp.sessions and sftp.disconnect (the server re-checks access on its side).
func registerSFTP(client *transport.Client, srv *sftpd.Server) {
	client.Handle("sftp.sessions", func(_ context.Context, raw json.RawMessage, _ transport.StreamWriter) (any, error) {
		var p protocol.SFTPSessionsParams
		if err := decode(raw, &p, nil); err != nil {
			return nil, err
		}
		return protocol.SFTPSessionsResult{Sessions: srv.Sessions(p.UserIDs)}, nil
	})
	client.Handle("sftp.disconnect", func(_ context.Context, raw json.RawMessage, _ transport.StreamWriter) (any, error) {
		var p protocol.SFTPDisconnectParams
		if err := decode(raw, &p, nil); err != nil {
			return nil, err
		}
		return protocol.SFTPDisconnectResult{Closed: srv.Disconnect(p.IDs)}, nil
	})
}
