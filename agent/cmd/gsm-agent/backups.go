package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"

	"github.com/ionnet/gsm/agent/internal/backups"
	"github.com/ionnet/gsm/agent/internal/instances"
	"github.com/ionnet/gsm/agent/internal/instfs"
	"github.com/ionnet/gsm/agent/internal/protocol"
	"github.com/ionnet/gsm/agent/internal/transfer"
	"github.com/ionnet/gsm/agent/internal/transport"
)

func backupErr(err error) error {
	if err == nil {
		return nil
	}
	var ie *backups.InvalidError
	if errors.As(err, &ie) {
		return invalidParams(ie.Msg)
	}
	return rpcErr(err)
}

// registerBackups wires backup.*.
func registerBackups(client *transport.Client, m *instances.Manager, xfer *transfer.Client, log *slog.Logger) {
	// Archives live in <dataDir>/backups/<uuid>; ArchivePath is called with that directory directly.
	backupsDir := func(uuid string) string { return m.BackupDir(uuid) }

	client.Handle("backup.create", func(ctx context.Context, raw json.RawMessage, stream transport.StreamWriter) (any, error) {
		var p protocol.BackupCreateParams
		if err := decode(raw, &p, func() bool { return p.UUID != "" && p.BackupID != "" }); err != nil {
			return nil, err
		}
		dest := backups.ArchivePath(backupsDir(p.UUID), "", p.BackupID)
		log.Info("backup.create", "uuid", p.UUID, "backup", p.BackupID)
		if p.Database != nil {
			// The dump rides in the archive as .gsm/database.sql.gz; the files keep no copy.
			if err := m.DumpForBackup(ctx, p.UUID, p.Database); err != nil {
				log.Warn("backup.create: database dump failed", "uuid", p.UUID, "err", err)
				return nil, rpcErr(fmt.Errorf("database dump: %w", err))
			}
			defer m.RemoveBackupDump(p.UUID)
		}
		res, err := backups.Create(ctx, m.DataDir(p.UUID), dest, p.Ignore, func(pr protocol.BackupProgress) {
			_ = stream.Send(pr)
		})
		if err == nil {
			uid, gid, chown := m.OwnerOf(p.UUID)
			if chown {
				_ = os.Chown(dest, uid, gid)
			}
		}
		log.Info("backup.create done", "uuid", p.UUID, "backup", p.BackupID, "err", errText(err))
		return res, backupErr(err)
	})
	client.Handle("backup.restore", func(ctx context.Context, raw json.RawMessage, stream transport.StreamWriter) (any, error) {
		var p protocol.BackupRestoreParams
		if err := decode(raw, &p, func() bool { return p.UUID != "" && p.BackupID != "" }); err != nil {
			return nil, err
		}
		if m.IsRunning(p.UUID) {
			return nil, invalidParams("stop the instance before restoring a backup")
		}
		uid, gid, chown := m.OwnerOf(p.UUID)
		archive := backups.ArchivePath(backupsDir(p.UUID), "", p.BackupID)
		log.Info("backup.restore", "uuid", p.UUID, "backup", p.BackupID, "wipe", p.Wipe)
		res, err := backups.Restore(ctx, archive, m.DataDir(p.UUID), p.Wipe, uid, gid, chown, func(pr protocol.BackupProgress) {
			_ = stream.Send(pr)
		})
		if err == nil && p.Database != nil {
			found, ierr := m.RestoreBackupDump(ctx, p.UUID, p.Database)
			if ierr != nil {
				log.Warn("backup.restore: database import failed", "uuid", p.UUID, "err", ierr)
				return nil, rpcErr(fmt.Errorf("the files are back, but importing the database failed: %w", ierr))
			}
			if found {
				log.Info("backup.restore: database imported", "uuid", p.UUID)
			}
		}
		return res, backupErr(err)
	})
	client.Handle("backup.delete", func(_ context.Context, raw json.RawMessage, _ transport.StreamWriter) (any, error) {
		var p protocol.BackupRefParams
		if err := decode(raw, &p, func() bool { return p.UUID != "" && p.BackupID != "" }); err != nil {
			return nil, err
		}
		log.Info("backup.delete", "uuid", p.UUID, "backup", p.BackupID)
		return map[string]any{}, backupErr(backups.Delete(backupsDir(p.UUID), "", p.BackupID))
	})
	client.Handle("backup.list", func(_ context.Context, raw json.RawMessage, _ transport.StreamWriter) (any, error) {
		var p protocol.InstUUIDParams
		if err := decode(raw, &p, func() bool { return p.UUID != "" }); err != nil {
			return nil, err
		}
		list, err := backups.List(backupsDir(p.UUID), "")
		if err != nil {
			return nil, err
		}
		return protocol.BackupListResult{Backups: list}, nil
	})
	client.Handle("backup.download", func(ctx context.Context, raw json.RawMessage, _ transport.StreamWriter) (any, error) {
		var p protocol.BackupDownloadParams
		if err := decode(raw, &p, func() bool { return p.OpID != "" && p.Token != "" && p.UUID != "" && p.BackupID != "" }); err != nil {
			return nil, err
		}
		octx, done := ops.start(ctx, p.OpID)
		defer done()
		archive := backups.ArchivePath(backupsDir(p.UUID), "", p.BackupID)
		info, err := os.Stat(archive)
		if err != nil {
			return nil, invalidParams("the backup archive is not on the node")
		}
		// The backups directory is its own sandbox root here: the archive is served by name.
		f := &instfs.FS{Root: backupsDir(p.UUID)}
		res, err := postStream(octx, xfer, p.Token, info.Size(), func(w io.Writer) (*protocol.FileTransferResult, error) {
			return f.Send(octx, []string{p.BackupID + ".tar.gz"}, false, w)
		})
		log.Info("backup.download", "uuid", p.UUID, "backup", p.BackupID, "err", errText(err))
		if err != nil {
			return nil, fsErr(err)
		}
		return protocol.BackupDownloadResult{Size: res.Size, SHA256: res.SHA256}, nil
	})
}
