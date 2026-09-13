package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sync"

	"github.com/ionnet/gsm/agent/internal/instances"
	"github.com/ionnet/gsm/agent/internal/instfs"
	"github.com/ionnet/gsm/agent/internal/protocol"
	"github.com/ionnet/gsm/agent/internal/transfer"
	"github.com/ionnet/gsm/agent/internal/transport"
)

// fileOps tracks cancellable operations by the server's op id, for fs.cancel.
type fileOps struct {
	mu  sync.Mutex
	ops map[string]context.CancelFunc
}

func newFileOps() *fileOps { return &fileOps{ops: map[string]context.CancelFunc{}} }

func (o *fileOps) start(ctx context.Context, id string) (context.Context, func()) {
	ctx, cancel := context.WithCancel(ctx)
	o.mu.Lock()
	o.ops[id] = cancel
	o.mu.Unlock()
	return ctx, func() {
		cancel()
		o.mu.Lock()
		delete(o.ops, id)
		o.mu.Unlock()
	}
}

func (o *fileOps) cancel(id string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if c, ok := o.ops[id]; ok {
		c()
	}
}

// fsErr maps sandbox errors to RPC errors.
func fsErr(err error) error {
	if err == nil {
		return nil
	}
	var ie *instfs.InvalidError
	if errors.As(err, &ie) {
		return &protocol.RPCError{Code: protocol.ErrInvalidParams, Message: ie.Msg, Data: ie.Data}
	}
	return rpcErr(err)
}

// ops is shared by the file and backup handlers so one fs.cancel reaches both.
var ops = newFileOps()

// registerFiles wires fs.*: plain operations are requests; uploads and downloads move bytes over HTTP.
func registerFiles(client *transport.Client, m *instances.Manager, xfer *transfer.Client, log *slog.Logger) {
	fsFor := func(uuid string) *instfs.FS {
		uid, gid, chown := m.OwnerOf(uuid)
		return &instfs.FS{Root: m.DataDir(uuid), UID: uid, GID: gid, Chown: chown}
	}

	client.Handle("fs.list", func(_ context.Context, raw json.RawMessage, _ transport.StreamWriter) (any, error) {
		var p protocol.FsPathParams
		if err := decode(raw, &p, func() bool { return p.UUID != "" }); err != nil {
			return nil, err
		}
		res, err := fsFor(p.UUID).List(p.Path)
		return res, fsErr(err)
	})
	client.Handle("fs.stat", func(_ context.Context, raw json.RawMessage, _ transport.StreamWriter) (any, error) {
		var p protocol.FsPathParams
		if err := decode(raw, &p, func() bool { return p.UUID != "" }); err != nil {
			return nil, err
		}
		res, err := fsFor(p.UUID).Stat(p.Path)
		return res, fsErr(err)
	})
	client.Handle("fs.read", func(_ context.Context, raw json.RawMessage, _ transport.StreamWriter) (any, error) {
		var p protocol.FsReadParams
		if err := decode(raw, &p, func() bool { return p.UUID != "" && p.MaxBytes > 0 }); err != nil {
			return nil, err
		}
		res, err := fsFor(p.UUID).Read(p.Path, p.MaxBytes)
		return res, fsErr(err)
	})
	client.Handle("fs.write", func(_ context.Context, raw json.RawMessage, _ transport.StreamWriter) (any, error) {
		var p protocol.FsWriteParams
		if err := decode(raw, &p, func() bool { return p.UUID != "" }); err != nil {
			return nil, err
		}
		res, err := fsFor(p.UUID).Write(p.Path, p.Content, p.ExpectSHA256, p.Create)
		log.Info("fs.write", "uuid", p.UUID, "path", p.Path, "bytes", len(p.Content), "create", p.Create, "err", errText(err))
		return res, fsErr(err)
	})
	client.Handle("fs.mkdir", func(_ context.Context, raw json.RawMessage, _ transport.StreamWriter) (any, error) {
		var p protocol.FsPathParams
		if err := decode(raw, &p, func() bool { return p.UUID != "" }); err != nil {
			return nil, err
		}
		path, err := fsFor(p.UUID).Mkdir(p.Path)
		if err != nil {
			return nil, fsErr(err)
		}
		return protocol.PathResult{Path: path}, nil
	})
	client.Handle("fs.rename", func(_ context.Context, raw json.RawMessage, _ transport.StreamWriter) (any, error) {
		var p protocol.FsRenameParams
		if err := decode(raw, &p, func() bool { return p.UUID != "" }); err != nil {
			return nil, err
		}
		path, err := fsFor(p.UUID).Rename(p.From, p.To)
		log.Info("fs.rename", "uuid", p.UUID, "from", p.From, "to", p.To, "err", errText(err))
		if err != nil {
			return nil, fsErr(err)
		}
		return protocol.PathResult{Path: path}, nil
	})
	client.Handle("fs.delete", func(_ context.Context, raw json.RawMessage, _ transport.StreamWriter) (any, error) {
		var p protocol.FsPathsParams
		if err := decode(raw, &p, func() bool { return p.UUID != "" && len(p.Paths) > 0 }); err != nil {
			return nil, err
		}
		n, err := fsFor(p.UUID).Delete(p.Paths)
		log.Info("fs.delete", "uuid", p.UUID, "paths", p.Paths, "deleted", n, "err", errText(err))
		if err != nil {
			return nil, fsErr(err)
		}
		return protocol.FsDeleteResult{Deleted: n}, nil
	})
	client.Handle("fs.chmod", func(_ context.Context, raw json.RawMessage, _ transport.StreamWriter) (any, error) {
		var p protocol.FsChmodParams
		if err := decode(raw, &p, func() bool { return p.UUID != "" && len(p.Paths) > 0 && p.Mode >= 0 && p.Mode <= 0o777 }); err != nil {
			return nil, err
		}
		n, err := fsFor(p.UUID).Chmod(p.Paths, p.Mode, p.Recursive)
		if err != nil {
			return nil, fsErr(err)
		}
		return protocol.FsChmodResult{Changed: n}, nil
	})
	client.Handle("fs.extract", func(ctx context.Context, raw json.RawMessage, _ transport.StreamWriter) (any, error) {
		var p protocol.FsExtractParams
		if err := decode(raw, &p, func() bool { return p.UUID != "" && p.Path != "" }); err != nil {
			return nil, err
		}
		n, err := fsFor(p.UUID).Extract(ctx, p.Path, p.Dest)
		log.Info("fs.extract", "uuid", p.UUID, "path", p.Path, "dest", p.Dest, "files", n, "err", errText(err))
		if err != nil {
			return nil, fsErr(err)
		}
		return protocol.FsExtractResult{Files: n}, nil
	})
	client.Handle("fs.compress", func(ctx context.Context, raw json.RawMessage, _ transport.StreamWriter) (any, error) {
		var p protocol.FsCompressParams
		if err := decode(raw, &p, func() bool { return p.UUID != "" && len(p.Paths) > 0 && p.Dest != "" }); err != nil {
			return nil, err
		}
		res, err := fsFor(p.UUID).Compress(ctx, p.Paths, p.Dest)
		log.Info("fs.compress", "uuid", p.UUID, "paths", p.Paths, "dest", p.Dest, "err", errText(err))
		return res, fsErr(err)
	})
	client.Handle("fs.cancel", func(_ context.Context, raw json.RawMessage, _ transport.StreamWriter) (any, error) {
		var p protocol.FsCancelParams
		if err := decode(raw, &p, func() bool { return p.OpID != "" }); err != nil {
			return nil, err
		}
		ops.cancel(p.OpID)
		return map[string]any{}, nil
	})

	client.Handle("fs.upload", func(ctx context.Context, raw json.RawMessage, _ transport.StreamWriter) (any, error) {
		var p protocol.FsUploadParams
		if err := decode(raw, &p, func() bool { return p.OpID != "" && p.Token != "" && p.UUID != "" && p.Size >= 0 }); err != nil {
			return nil, err
		}
		octx, done := ops.start(ctx, p.OpID)
		defer done()
		body, err := xfer.Get(octx, p.Token)
		if err != nil {
			return nil, err
		}
		defer body.Close()
		confirm := func(sha string) error {
			want, err := xfer.Digest(octx, p.Token)
			if err != nil {
				return err
			}
			if want != sha {
				return fmt.Errorf("checksum mismatch: received %s, the server sent %s", sha, want)
			}
			return nil
		}
		res, err := fsFor(p.UUID).Receive(octx, p.Path, p.Size, p.Overwrite, body, confirm)
		log.Info("fs.upload", "uuid", p.UUID, "path", p.Path, "bytes", p.Size, "err", errText(err))
		return res, fsErr(err)
	})

	client.Handle("fs.download", func(ctx context.Context, raw json.RawMessage, _ transport.StreamWriter) (any, error) {
		var p protocol.FsDownloadParams
		if err := decode(raw, &p, func() bool {
			return p.OpID != "" && p.Token != "" && p.UUID != "" && len(p.Paths) > 0 && (p.Archive || len(p.Paths) == 1)
		}); err != nil {
			return nil, err
		}
		octx, done := ops.start(ctx, p.OpID)
		defer done()
		f := fsFor(p.UUID)
		length := int64(-1) // chunked for archives
		if !p.Archive {
			size, err := f.FileSize(p.Paths[0])
			if err != nil {
				return nil, fsErr(err)
			}
			length = size
		}
		res, err := postStream(octx, xfer, p.Token, length, func(w io.Writer) (*protocol.FileTransferResult, error) {
			return f.Send(octx, p.Paths, p.Archive, w)
		})
		log.Info("fs.download", "uuid", p.UUID, "paths", p.Paths, "archive", p.Archive, "err", errText(err))
		return res, fsErr(err)
	})
}

// postStream runs produce with a pipe as its writer while POSTing the pipe to the transfer relay,
// then checks the server counted the same SHA-256.
func postStream(ctx context.Context, xfer *transfer.Client, token string, length int64, produce func(io.Writer) (*protocol.FileTransferResult, error)) (*protocol.FileTransferResult, error) {
	pr, pw := io.Pipe()
	var result *protocol.FileTransferResult
	var runErr error
	sent := make(chan struct{})
	go func() {
		defer close(sent)
		result, runErr = produce(pw)
		pw.CloseWithError(runErr)
	}()
	sha, err := xfer.Post(ctx, token, pr, length)
	pr.CloseWithError(errors.New("transfer ended"))
	<-sent
	if runErr != nil {
		return nil, runErr
	}
	if err != nil {
		return nil, err
	}
	if sha != result.SHA256 {
		return nil, fmt.Errorf("checksum mismatch: sent %s, the server received %s", result.SHA256, sha)
	}
	return result, nil
}

func errText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
