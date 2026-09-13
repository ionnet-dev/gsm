// gsm-agent is the Ionnet GSM node agent. It connects outbound to the GSM server and runs game
// server instances as Docker containers on this machine.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"runtime"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/ionnet/gsm/agent/internal/config"
	"github.com/ionnet/gsm/agent/internal/docker"
	"github.com/ionnet/gsm/agent/internal/instances"
	"github.com/ionnet/gsm/agent/internal/inventory"
	"github.com/ionnet/gsm/agent/internal/logging"
	"github.com/ionnet/gsm/agent/internal/metrics"
	"github.com/ionnet/gsm/agent/internal/protocol"
	"github.com/ionnet/gsm/agent/internal/sftpd"
	"github.com/ionnet/gsm/agent/internal/transfer"
	"github.com/ionnet/gsm/agent/internal/transport"
	"github.com/ionnet/gsm/agent/internal/update"
)

// version is injected at build time: -ldflags "-X main.version=1.2.3"
var version = "dev"

func main() {
	update.CleanUp()
	if code, handled := serviceMain(); handled {
		os.Exit(code)
	}
	if len(os.Args) < 2 {
		os.Exit(run(os.Args[1:]))
	}
	switch os.Args[1] {
	case "version", "--version", "-v":
		fmt.Println(version)
	case "enroll":
		os.Exit(enroll(os.Args[2:]))
	case "inventory":
		cfg, _ := config.Load(config.DefaultConfigPath)
		dk, _ := docker.New()
		var src inventory.DockerInfoSource
		if dk != nil {
			src = dk
		}
		inv := inventory.Collect(context.Background(), cfg.DataDir, src)
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		_ = enc.Encode(inv)
	case "run":
		os.Exit(run(os.Args[2:]))
	case "service":
		os.Exit(serviceCommand(os.Args[2:]))
	case "help", "-h", "--help":
		usage()
	default:
		if os.Args[1][0] == '-' {
			os.Exit(run(os.Args[1:]))
		}
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n", os.Args[1])
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprintf(os.Stderr, `gsm-agent %s — Ionnet GSM node agent

Usage:
  gsm-agent [run] [-config PATH]      connect to the server and serve requests (default)
  gsm-agent enroll -token TOKEN -server URL [-name NAME] [-config PATH]
  gsm-agent inventory                 print the collected inventory as JSON
  gsm-agent version
`, version)
}

// restarting is set when an agent update wants the process replaced; systemd restarts it.
var restarting atomic.Bool

const restartExitCode = 3

func invalidParams(msg string) error {
	return &protocol.RPCError{Code: protocol.ErrInvalidParams, Message: msg}
}

// rpcErr maps package errors to RPC errors so the server can tell a refusal from a failure.
func rpcErr(err error) error {
	if err == nil {
		return nil
	}
	var rpc *protocol.RPCError
	if errors.As(err, &rpc) {
		return rpc
	}
	var ie *instances.InvalidError
	if errors.As(err, &ie) {
		return invalidParams(ie.Msg)
	}
	return err
}

func run(args []string) int {
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	cfgPath := fs.String("config", config.DefaultConfigPath, "path to config.yaml")
	_ = fs.Parse(args)

	cfg, err := config.Load(*cfgPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	log := logging.Setup(cfg.LogLevel)
	token, err := cfg.LoadToken()
	if err != nil {
		log.Error(err.Error())
		return 1
	}
	if err := cfg.EnsureDataDir(); err != nil {
		log.Error("data directory", "dir", cfg.DataDir, "err", err)
		return 1
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	dk, err := docker.New()
	if err != nil {
		log.Error("docker client", "err", err)
		return 1
	}
	if info := dk.Info(ctx); !info.Available {
		log.Warn("docker is not reachable; instances cannot run until it is", "err", info.Error)
	} else {
		log.Info("docker", "version", info.Version, "api", info.APIVersion, "driver", info.StorageDriver)
	}

	manager := instances.New(dk, instances.Dirs{
		Instances: cfg.InstancesDir(),
		Logs:      cfg.LogsDir(),
		Backups:   cfg.BackupsDir(),
		State:     cfg.StateDir(),
	}, log)
	if err := manager.Reconcile(ctx); err != nil {
		log.Warn("reconcile failed", "err", err)
	}
	defer manager.Shutdown()

	sampler := metrics.NewSampler(cfg.DataDir)
	xfer := transfer.New(cfg.ServerURL, token, cfg.InsecureSkipVerify)

	client := transport.New(transport.Options{
		URL:                cfg.WebSocketURL(),
		Token:              token,
		InsecureSkipVerify: cfg.InsecureSkipVerify,
		Log:                log,
		OnConnect: func(ctx context.Context, c *transport.Client) error {
			hello := protocol.Hello{
				ProtocolVersion: protocol.Version,
				AgentVersion:    version,
				Inventory:       inventory.Collect(ctx, cfg.DataDir, dk),
			}
			if err := c.Emit(ctx, "hello", hello); err != nil {
				return err
			}
			manager.SetEmitter(func(event string, data any) {
				if err := c.Emit(ctx, event, data); err != nil {
					log.Debug("emit failed", "event", event, "err", err)
				}
			})
			go metricsLoop(ctx, c, sampler, cfg.MetricsInterval, log)
			go manager.StatsLoop(ctx)
			go func() {
				<-ctx.Done()
				manager.SetEmitter(nil)
			}()
			return nil
		},
	})

	sftpSrv := newSFTP(ctx, client, cfg, manager, log)
	defer sftpSrv.Close()

	registerAgent(client, cfg, dk, manager, sftpSrv, log, stop)
	registerInstances(client, manager, sftpSrv, log)
	registerFiles(client, manager, xfer, log)
	registerBackups(client, manager, xfer, log)
	registerImages(client, dk, log)
	registerSFTP(client, sftpSrv)

	log.Info("gsm-agent starting", "version", version, "server", cfg.ServerURL, "os", runtime.GOOS, "data_dir", cfg.DataDir)
	if err := client.Run(ctx); err != nil && ctx.Err() == nil {
		log.Error("agent stopped", "err", err)
		return 1
	}
	log.Info("gsm-agent stopped")
	if restarting.Load() {
		return restartExitCode
	}
	return 0
}

func metricsLoop(ctx context.Context, c *transport.Client, s *metrics.Sampler, every time.Duration, log *slog.Logger) {
	t := time.NewTimer(2 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := c.Emit(ctx, "metrics", s.Sample()); err != nil {
				log.Debug("metrics emit failed", "err", err)
			}
			t.Reset(every)
		}
	}
}

// registerAgent wires agent.ping, agent.configure (registry credentials and the SFTP listener),
// agent.update and sys.inventory.
func registerAgent(client *transport.Client, cfg config.Config, dk *docker.Client, manager *instances.Manager, sftpSrv *sftpd.Server, log *slog.Logger, stop context.CancelFunc) {
	client.Handle("agent.ping", func(context.Context, json.RawMessage, transport.StreamWriter) (any, error) {
		return protocol.PingResult{At: time.Now().UTC(), AgentVersion: version}, nil
	})
	client.Handle("sys.inventory", func(ctx context.Context, _ json.RawMessage, _ transport.StreamWriter) (any, error) {
		return inventory.Collect(ctx, cfg.DataDir, dk), nil
	})
	client.Handle("agent.configure", func(_ context.Context, raw json.RawMessage, _ transport.StreamWriter) (any, error) {
		var p protocol.AgentConfigureParams
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, invalidParams("invalid agent.configure params")
		}
		if present, auth, err := p.Auth(); err != nil {
			return nil, invalidParams("invalid registryAuth")
		} else if present {
			dk.SetRegistryAuth(auth)
			log.Info("registry credentials", "set", auth != nil)
		}
		status := sftpSrv.Status()
		if p.SFTP != nil {
			status = sftpSrv.Configure(p.SFTP.Port, p.SFTP.BindAddress)
		}
		return protocol.AgentConfigureResult{SFTP: status}, nil
	})
	client.Handle("agent.update", func(_ context.Context, raw json.RawMessage, _ transport.StreamWriter) (any, error) {
		var p protocol.AgentUpdateParams
		if err := json.Unmarshal(raw, &p); err != nil || p.Path == "" || len(p.SHA256) != 64 {
			return nil, invalidParams("invalid agent.update params")
		}
		if p.Version == version {
			return protocol.AgentUpdateResult{Replaced: false, Message: "already running " + version}, nil
		}
		log.Info("agent.update", "from", version, "to", p.Version)
		if err := update.Apply(cfg.ServerURL, p.Path, p.SHA256, cfg.InsecureSkipVerify); err != nil {
			log.Error("agent.update failed", "err", err)
			return nil, err
		}
		go func() {
			time.Sleep(1500 * time.Millisecond)
			log.Info("restarting into new version", "version", p.Version)
			restarting.Store(true)
			manager.Shutdown()
			stop()
			time.Sleep(2 * time.Second)
			os.Exit(restartExitCode)
		}()
		return protocol.AgentUpdateResult{Replaced: true, Message: "binary replaced; restarting"}, nil
	})
}

func decode(raw json.RawMessage, v any, ok func() bool) error {
	if err := json.Unmarshal(raw, v); err != nil || (ok != nil && !ok()) {
		return invalidParams("invalid params")
	}
	return nil
}

func validSpec(s *protocol.InstanceSpec) bool {
	return s != nil && s.UUID != "" && s.Image != "" && s.Startup != ""
}

// registerInstances wires inst.*.
func registerInstances(client *transport.Client, m *instances.Manager, sftpSrv *sftpd.Server, log *slog.Logger) {
	client.Handle("inst.list", func(ctx context.Context, _ json.RawMessage, _ transport.StreamWriter) (any, error) {
		list, err := m.List(ctx)
		if err != nil {
			return nil, err
		}
		return protocol.InstListResult{Instances: list}, nil
	})
	client.Handle("inst.status", func(_ context.Context, raw json.RawMessage, _ transport.StreamWriter) (any, error) {
		var p protocol.InstUUIDParams
		if err := decode(raw, &p, func() bool { return p.UUID != "" }); err != nil {
			return nil, err
		}
		return m.State(p.UUID), nil
	})
	client.Handle("inst.install", func(ctx context.Context, raw json.RawMessage, stream transport.StreamWriter) (any, error) {
		var p protocol.InstInstallParams
		if err := decode(raw, &p, func() bool { return validSpec(&p.Spec) && p.Install.Script != "" }); err != nil {
			return nil, err
		}
		log.Info("inst.install", "uuid", p.Spec.UUID, "name", p.Spec.Name)
		res, err := m.Install(ctx, &p.Spec, &p.Install, func(lines []protocol.ConsoleLine) {
			_ = stream.Send(protocol.InstallOutputChunk{Lines: lines})
		})
		return res, rpcErr(err)
	})
	client.Handle("inst.start", func(ctx context.Context, raw json.RawMessage, _ transport.StreamWriter) (any, error) {
		var p protocol.InstStartParams
		if err := decode(raw, &p, func() bool { return validSpec(&p.Spec) }); err != nil {
			return nil, err
		}
		log.Info("inst.start", "uuid", p.Spec.UUID, "name", p.Spec.Name)
		st, err := m.Start(ctx, &p.Spec)
		if err != nil {
			return nil, rpcErr(err)
		}
		return st, nil
	})
	client.Handle("inst.stop", func(ctx context.Context, raw json.RawMessage, _ transport.StreamWriter) (any, error) {
		var p protocol.InstStopParams
		if err := decode(raw, &p, func() bool { return p.UUID != "" }); err != nil {
			return nil, err
		}
		log.Info("inst.stop", "uuid", p.UUID, "force", p.Force)
		st, err := m.Stop(ctx, p.UUID, p.Force)
		if err != nil {
			return nil, rpcErr(err)
		}
		return st, nil
	})
	client.Handle("inst.restart", func(ctx context.Context, raw json.RawMessage, _ transport.StreamWriter) (any, error) {
		var p protocol.InstStartParams
		if err := decode(raw, &p, func() bool { return validSpec(&p.Spec) }); err != nil {
			return nil, err
		}
		log.Info("inst.restart", "uuid", p.Spec.UUID)
		st, err := m.Restart(ctx, &p.Spec)
		if err != nil {
			return nil, rpcErr(err)
		}
		return st, nil
	})
	client.HandleOrdered("inst.command", func(_ context.Context, raw json.RawMessage, _ transport.StreamWriter) (any, error) {
		var p protocol.InstCommandParams
		if err := decode(raw, &p, func() bool { return p.UUID != "" && p.Command != "" }); err != nil {
			return nil, err
		}
		return map[string]any{}, rpcErr(m.Command(p.UUID, p.Command))
	})
	client.Handle("inst.consoleTail", func(_ context.Context, raw json.RawMessage, _ transport.StreamWriter) (any, error) {
		p := protocol.InstConsoleTailParams{Stream: "console", Lines: 500}
		if err := decode(raw, &p, func() bool {
			return p.UUID != "" && p.Lines >= 1 && p.Lines <= 5000 && (p.Stream == "console" || p.Stream == "install")
		}); err != nil {
			return nil, err
		}
		return protocol.InstConsoleTailResult{Lines: m.ConsoleTail(p.UUID, p.Stream, p.Lines)}, nil
	})
	client.Handle("inst.remove", func(ctx context.Context, raw json.RawMessage, _ transport.StreamWriter) (any, error) {
		var p protocol.InstRemoveParams
		if err := decode(raw, &p, func() bool { return p.UUID != "" }); err != nil {
			return nil, err
		}
		log.Info("inst.remove", "uuid", p.UUID, "delete_files", p.DeleteFiles)
		// Nobody may keep files open in a directory that is about to go.
		sftpSrv.CloseInstance(p.UUID)
		return map[string]any{}, rpcErr(m.Remove(ctx, p.UUID, p.DeleteFiles))
	})
	client.Handle("inst.stats", func(ctx context.Context, raw json.RawMessage, _ transport.StreamWriter) (any, error) {
		var p protocol.InstStatsParams
		if err := decode(raw, &p, nil); err != nil {
			return nil, err
		}
		return protocol.InstStatsResult{Stats: m.Stats(ctx, p.UUIDs)}, nil
	})
}

// registerImages wires image.*.
func registerImages(client *transport.Client, dk *docker.Client, log *slog.Logger) {
	client.Handle("image.list", func(ctx context.Context, _ json.RawMessage, _ transport.StreamWriter) (any, error) {
		images, err := dk.ImageList(ctx)
		if err != nil {
			return nil, err
		}
		return protocol.ImageListResult{Images: images}, nil
	})
	client.Handle("image.pull", func(ctx context.Context, raw json.RawMessage, stream transport.StreamWriter) (any, error) {
		var p protocol.ImageRefParams
		if err := decode(raw, &p, func() bool { return p.Ref != "" }); err != nil {
			return nil, err
		}
		log.Info("image.pull", "ref", p.Ref)
		last := time.Now()
		id, err := dk.ImagePull(ctx, p.Ref, func(pr protocol.PullProgress) {
			// Layer progress is chatty; pass it on at most a few times a second.
			if pr.Layer == "" || time.Since(last) > 250*time.Millisecond {
				last = time.Now()
				_ = stream.Send(pr)
			}
		})
		if err != nil {
			return nil, err
		}
		return protocol.ImagePullResult{Ref: p.Ref, ID: id}, nil
	})
	client.Handle("image.remove", func(ctx context.Context, raw json.RawMessage, _ transport.StreamWriter) (any, error) {
		var p protocol.ImageRefParams
		if err := decode(raw, &p, func() bool { return p.Ref != "" }); err != nil {
			return nil, err
		}
		log.Info("image.remove", "ref", p.Ref)
		if err := dk.ImageRemove(ctx, p.Ref); err != nil {
			if docker.IsNotFound(err) {
				return nil, invalidParams("no such image: " + p.Ref)
			}
			return nil, err
		}
		return map[string]any{}, nil
	})
}
