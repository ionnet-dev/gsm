// Package instances runs game server instances as Docker containers: install, start, stop,
// console, crash restarts, stats, and reconciliation after an agent restart.
package instances

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ionnet/gsm/agent/internal/docker"
	"github.com/ionnet/gsm/agent/internal/metrics"
	"github.com/ionnet/gsm/agent/internal/protocol"
)

const (
	// Marker is written to the data directory once an install succeeded.
	Marker = ".gsm-installed"
	// StatsEvery is how often running instances are sampled.
	StatsEvery = 10 * time.Second
	// diskRefresh is how often an instance's data directory is measured.
	diskRefresh = 5 * time.Minute
	// stopGrace is the daemon-side grace after the stop signal before SIGKILL.
	stopGrace = 10
)

// InvalidError is a caller mistake; the RPC layer maps it to invalid_params.
type InvalidError struct{ Msg string }

func (e *InvalidError) Error() string { return e.Msg }

func invalid(format string, args ...any) error {
	return &InvalidError{Msg: fmt.Sprintf(format, args...)}
}

// Dirs is where instance data lives on the node.
type Dirs struct {
	Instances string
	Logs      string
	Backups   string
	State     string
}

// Emitter sends an event to the server; nil drops it (not connected yet).
type Emitter func(event string, data any)

// Manager owns every instance on the node.
type Manager struct {
	dk   *docker.Client
	dirs Dirs
	log  *slog.Logger
	// Root reports whether the agent may chown and run containers as arbitrary users.
	Root bool
	// ownUID/ownGID are used for containers when not root.
	ownUID, ownGID int

	emitMu sync.RWMutex
	emit   Emitter

	mu    sync.Mutex
	insts map[string]*instance
}

// instance is the in-memory record for one uuid; opMu serialises lifecycle operations.
type instance struct {
	uuid string
	opMu sync.Mutex

	mu            sync.Mutex
	spec          *protocol.InstanceSpec
	containerID   string
	state         string
	startedAt     time.Time
	exitCode      *int
	errMsg        *string
	stopRequested bool
	installing    bool
	ready         *regexp.Regexp
	attach        *docker.Attached
	transport     *transport // console commands go here instead of stdin when the spec says so
	stdinMu       sync.Mutex
	logFile       *consoleLog
	recent        *ring
	installRecent *ring
	crashes       []time.Time
	exited        chan struct{} // closed once the current container's exit was processed
	cancelPump    context.CancelFunc
	installCancel context.CancelFunc
	diskUsed      uint64
	diskAt        time.Time
}

// New creates a manager; call Reconcile before serving requests.
func New(dk *docker.Client, dirs Dirs, log *slog.Logger) *Manager {
	root := os.Geteuid() == 0
	if !root {
		log.Warn("not running as root: skipping chown and running containers as the agent's own user",
			"uid", os.Getuid(), "gid", os.Getgid())
	}
	return &Manager{dk: dk, dirs: dirs, log: log, Root: root, ownUID: os.Getuid(), ownGID: os.Getgid(), insts: map[string]*instance{}}
}

// SetEmitter installs (or clears, with nil) the function that delivers events to the server.
func (m *Manager) SetEmitter(e Emitter) {
	m.emitMu.Lock()
	defer m.emitMu.Unlock()
	m.emit = e
}

func (m *Manager) send(event string, data any) {
	m.emitMu.RLock()
	e := m.emit
	m.emitMu.RUnlock()
	if e != nil {
		e(event, data)
	}
}

// ---- paths ----

func (m *Manager) DataDir(uuid string) string   { return filepath.Join(m.dirs.Instances, uuid) }
func (m *Manager) LogDir(uuid string) string    { return filepath.Join(m.dirs.Logs, uuid) }
func (m *Manager) BackupDir(uuid string) string { return filepath.Join(m.dirs.Backups, uuid) }
func (m *Manager) statePath(uuid string) string { return filepath.Join(m.dirs.State, uuid+".json") }
func (m *Manager) consolePath(uuid string) string {
	return filepath.Join(m.dirs.Logs, uuid, "console.log")
}
func (m *Manager) installLogPath(uuid string) string {
	return filepath.Join(m.dirs.Logs, uuid, "install.log")
}

// Owner returns the uid:gid the instance's files should have and its container should run as.
func (m *Manager) Owner(spec *protocol.InstanceSpec) (uid, gid int) {
	if !m.Root {
		return m.ownUID, m.ownGID
	}
	if spec == nil {
		return 1500, 1500
	}
	return spec.User.UID, spec.User.GID
}

// OwnerOf is Owner for an instance the manager knows (defaults when it does not).
func (m *Manager) OwnerOf(uuid string) (uid, gid int, chown bool) {
	inst := m.lookup(uuid)
	var spec *protocol.InstanceSpec
	if inst != nil {
		inst.mu.Lock()
		spec = inst.spec
		inst.mu.Unlock()
	}
	uid, gid = m.Owner(spec)
	return uid, gid, m.Root
}

func (m *Manager) chown(p string, spec *protocol.InstanceSpec) {
	if !m.Root {
		return
	}
	uid, gid := m.Owner(spec)
	_ = os.Chown(p, uid, gid)
}

// ---- registry ----

func (m *Manager) lookup(uuid string) *instance {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.insts[uuid]
}

func (m *Manager) get(uuid string) *instance {
	m.mu.Lock()
	defer m.mu.Unlock()
	inst := m.insts[uuid]
	if inst == nil {
		inst = &instance{uuid: uuid, state: protocol.StateStopped, recent: newRing(recentLines), installRecent: newRing(recentLines)}
		m.insts[uuid] = inst
	}
	return inst
}

// Known reports whether the manager knows a spec for the instance (needed for graceful stops).
func (m *Manager) Known(uuid string) bool {
	inst := m.lookup(uuid)
	if inst == nil {
		return false
	}
	inst.mu.Lock()
	defer inst.mu.Unlock()
	return inst.spec != nil
}

func (m *Manager) persistSpec(spec *protocol.InstanceSpec) error {
	if err := os.MkdirAll(m.dirs.State, 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(spec, "", "  ")
	if err != nil {
		return err
	}
	tmp := m.statePath(spec.UUID) + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, m.statePath(spec.UUID))
}

func (m *Manager) loadSpec(uuid string) *protocol.InstanceSpec {
	b, err := os.ReadFile(m.statePath(uuid))
	if err != nil {
		return nil
	}
	var spec protocol.InstanceSpec
	if json.Unmarshal(b, &spec) != nil || spec.UUID != uuid {
		return nil
	}
	return &spec
}

func (m *Manager) installed(uuid string) bool {
	_, err := os.Stat(filepath.Join(m.DataDir(uuid), Marker))
	return err == nil
}

// stateLocked builds the wire state; inst.mu must be held.
func (m *Manager) stateLocked(inst *instance) protocol.InstanceState {
	st := protocol.InstanceState{
		UUID:      inst.uuid,
		State:     inst.state,
		ExitCode:  inst.exitCode,
		Installed: m.installed(inst.uuid),
		Error:     inst.errMsg,
	}
	if inst.containerID != "" {
		id := inst.containerID
		st.ContainerID = &id
	}
	if !inst.startedAt.IsZero() && (inst.state == protocol.StateRunning || inst.state == protocol.StateStarting || inst.state == protocol.StateStopping) {
		t := inst.startedAt.UTC()
		st.StartedAt = &t
	}
	return st
}

// setState changes the state and tells the server; inst.mu must be held.
func (m *Manager) setStateLocked(inst *instance, state string) {
	inst.state = state
	st := m.stateLocked(inst)
	go m.send("inst.status", st)
}

// State returns the instance's current state.
func (m *Manager) State(uuid string) protocol.InstanceState {
	inst := m.get(uuid)
	inst.mu.Lock()
	defer inst.mu.Unlock()
	return m.stateLocked(inst)
}

// ---- console ----

func (m *Manager) consoleLine(inst *instance, text string) {
	line := protocol.ConsoleLine{At: nowMs(), Text: text}
	inst.recent.Add(line)
	if inst.logFile != nil {
		inst.logFile.Write([]protocol.ConsoleLine{line})
	}
	m.send("inst.console", protocol.InstConsoleEvent{UUID: inst.uuid, Stream: "console", Lines: []protocol.ConsoleLine{line}})
}

// flushConsole keeps a batch of game console lines and sends it to the server.
func (m *Manager) flushConsole(inst *instance, lines []protocol.ConsoleLine) {
	inst.recent.Add(lines...)
	if inst.logFile != nil {
		inst.logFile.Write(lines)
	}
	m.send("inst.console", protocol.InstConsoleEvent{UUID: inst.uuid, Stream: "console", Lines: lines})
}

// pump reads the attached container's output until it ends.
func (m *Manager) pump(ctx context.Context, inst *instance, att *docker.Attached) {
	b := newBatcher(func(lines []protocol.ConsoleLine) { m.flushConsole(inst, lines) })
	handle := func(text string) {
		b.Add(protocol.ConsoleLine{At: nowMs(), Text: text})
		inst.mu.Lock()
		if inst.state == protocol.StateStarting && inst.ready != nil && inst.ready.MatchString(text) {
			m.setStateLocked(inst, protocol.StateRunning)
		}
		inst.mu.Unlock()
	}
	var wg sync.WaitGroup
	for _, r := range []io.Reader{att.Stdout, att.Stderr} {
		wg.Add(1)
		go func(r io.Reader) {
			defer wg.Done()
			readLines(r, handle)
		}(r)
	}
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-ctx.Done():
		att.Close()
		<-done
	}
	b.Close()
}

// ConsoleTail returns the last n lines of the console or install log, from the log file when it
// exists and from memory otherwise.
func (m *Manager) ConsoleTail(uuid, stream string, n int) []protocol.ConsoleLine {
	path := m.consolePath(uuid)
	if stream == "install" {
		path = m.installLogPath(uuid)
	}
	if lines, err := TailFile(path, n); err == nil {
		return lines
	}
	inst := m.lookup(uuid)
	if inst == nil {
		return []protocol.ConsoleLine{}
	}
	if stream == "install" {
		return inst.installRecent.Last(n)
	}
	return inst.recent.Last(n)
}

// Command writes a line to the game's stdin.
func (m *Manager) Command(uuid, text string) error {
	inst := m.lookup(uuid)
	if inst == nil {
		return invalid("unknown instance")
	}
	inst.mu.Lock()
	att := inst.attach
	tr := inst.transport
	state := inst.state
	inst.mu.Unlock()
	running := state == protocol.StateRunning || state == protocol.StateStarting || state == protocol.StateStopping
	if tr != nil && running {
		if err := tr.Send(text); err != nil {
			return invalid("%s", err.Error())
		}
		return nil
	}
	if att == nil || att.Stdin == nil || !running {
		return invalid("the instance is not running")
	}
	inst.stdinMu.Lock()
	defer inst.stdinMu.Unlock()
	_, err := io.WriteString(att.Stdin, strings.TrimRight(text, "\r\n")+"\n")
	return err
}

// ---- install ----

// Install runs the install script in a one-off container, streaming its output.
func (m *Manager) Install(ctx context.Context, spec *protocol.InstanceSpec, install *protocol.InstallSpec, stream func([]protocol.ConsoleLine)) (*protocol.InstInstallResult, error) {
	inst := m.get(spec.UUID)
	inst.opMu.Lock()
	defer inst.opMu.Unlock()

	inst.mu.Lock()
	if inst.state == protocol.StateRunning || inst.state == protocol.StateStarting || inst.state == protocol.StateStopping {
		inst.mu.Unlock()
		return nil, invalid("stop the instance before installing")
	}
	if inst.installing {
		inst.mu.Unlock()
		return nil, invalid("an install is already running")
	}
	inst.spec = spec
	inst.installing = true
	inst.errMsg = nil
	m.setStateLocked(inst, protocol.StateInstalling)
	inst.mu.Unlock()
	_ = m.persistSpec(spec)

	finish := func(errMsg string) {
		inst.mu.Lock()
		inst.installing = false
		inst.installCancel = nil
		if errMsg != "" {
			inst.errMsg = &errMsg
		}
		m.setStateLocked(inst, protocol.StateStopped)
		inst.mu.Unlock()
	}

	dataDir := m.DataDir(spec.UUID)
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		finish(err.Error())
		return nil, err
	}
	m.chown(dataDir, spec)
	logDir := m.LogDir(spec.UUID)
	if err := os.MkdirAll(logDir, 0o755); err != nil {
		finish(err.Error())
		return nil, err
	}
	scriptPath := filepath.Join(logDir, "install.sh")
	script := install.Script
	if !strings.HasSuffix(script, "\n") {
		script += "\n"
	}
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		finish(err.Error())
		return nil, err
	}
	_ = os.Truncate(m.installLogPath(spec.UUID), 0)
	logFile, err := openConsoleLog(m.installLogPath(spec.UUID))
	if err != nil {
		finish(err.Error())
		return nil, err
	}
	defer logFile.Close()

	image := spec.Image
	if install.Image != nil && *install.Image != "" {
		image = *install.Image
	}
	timeout := time.Duration(install.TimeoutSeconds) * time.Second
	if timeout <= 0 {
		timeout = 30 * time.Minute
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	inst.mu.Lock()
	inst.installCancel = cancel
	inst.mu.Unlock()

	b := newBatcher(func(lines []protocol.ConsoleLine) {
		inst.installRecent.Add(lines...)
		logFile.Write(lines)
		if stream != nil {
			stream(lines)
		}
		m.send("inst.console", protocol.InstConsoleEvent{UUID: spec.UUID, Stream: "install", Lines: lines})
	})
	say := func(text string) { b.Add(protocol.ConsoleLine{At: nowMs(), Text: text}) }

	if err := m.ensureImage(ctx, image, say); err != nil {
		say("[GSM] image pull failed: " + err.Error())
		b.Close()
		finish(err.Error())
		return nil, err
	}
	env := map[string]string{}
	for k, v := range spec.Env {
		env[k] = v
	}
	for k, v := range install.Env {
		env[k] = v
	}
	uid, gid := m.Owner(spec)
	name := "gsm-install-" + spec.UUID
	_ = m.dk.ContainerRemove(ctx, name)
	id, err := m.dk.ContainerCreate(ctx, docker.CreateOptions{
		Name:       name,
		Image:      image,
		Cmd:        []string{"sh", "/gsm/install.sh"},
		Env:        envList(env),
		WorkingDir: "/data",
		User:       fmt.Sprintf("%d:%d", uid, gid),
		Labels:     map[string]string{docker.LabelManaged: "true", "gsm.install": spec.UUID, docker.LabelName: spec.Name},
		Binds:      []string{dataDir + ":/data", scriptPath + ":/gsm/install.sh:ro"},
		Init:       false, // the base image runs tini as its entrypoint already
	})
	if err != nil {
		say("[GSM] cannot create the install container: " + err.Error())
		b.Close()
		finish(err.Error())
		return nil, err
	}
	defer m.dk.ContainerRemove(context.Background(), id)

	att, err := m.dk.ContainerAttach(ctx, id, false, true)
	if err != nil {
		b.Close()
		finish(err.Error())
		return nil, err
	}
	defer att.Close()
	started := time.Now()
	say(fmt.Sprintf("[GSM] running install script in %s", image))
	if err := m.dk.ContainerStart(ctx, id); err != nil {
		say("[GSM] cannot start the install container: " + err.Error())
		b.Close()
		finish(err.Error())
		return nil, err
	}
	var wg sync.WaitGroup
	for _, r := range []io.Reader{att.Stdout, att.Stderr} {
		wg.Add(1)
		go func(r io.Reader) {
			defer wg.Done()
			readLines(r, say)
		}(r)
	}
	code, werr := m.dk.ContainerWait(ctx, id)
	if werr != nil && ctx.Err() != nil {
		_ = m.dk.ContainerKill(context.Background(), id)
		say("[GSM] install cancelled: " + ctx.Err().Error())
		wg.Wait()
		b.Close()
		finish("install cancelled or timed out")
		return nil, ctx.Err()
	}
	wg.Wait()
	if werr != nil {
		say("[GSM] install failed: " + werr.Error())
		b.Close()
		finish(werr.Error())
		return nil, werr
	}
	if code == 0 {
		markerPath := filepath.Join(dataDir, Marker)
		_ = os.WriteFile(markerPath, []byte(time.Now().UTC().Format(time.RFC3339)+"\n"), 0o644)
		m.chown(markerPath, spec)
		say("[GSM] install finished")
	} else {
		say(fmt.Sprintf("[GSM] install script exited with code %d", code))
	}
	b.Close()
	errMsg := ""
	if code != 0 {
		errMsg = fmt.Sprintf("install script exited with code %d", code)
	}
	finish(errMsg)
	return &protocol.InstInstallResult{ExitCode: code, DurationMs: time.Since(started).Milliseconds()}, nil
}

func (m *Manager) ensureImage(ctx context.Context, ref string, say func(string)) error {
	ok, err := m.dk.ImageExists(ctx, ref)
	if err != nil {
		return err
	}
	if ok {
		return nil
	}
	say("[GSM] pulling image " + ref)
	last := time.Now()
	_, err = m.dk.ImagePull(ctx, ref, func(p protocol.PullProgress) {
		if p.Layer == "" || time.Since(last) > 2*time.Second {
			last = time.Now()
			if p.Total > 0 {
				say(fmt.Sprintf("[GSM] %s %s %d%%", p.Layer, p.Status, p.Current*100/p.Total))
			} else if p.Layer == "" {
				say("[GSM] " + p.Status)
			}
		}
	})
	if err != nil {
		return err
	}
	say("[GSM] image ready")
	return nil
}

func envList(env map[string]string) []string {
	out := make([]string, 0, len(env))
	for k, v := range env {
		out = append(out, k+"="+v)
	}
	return out
}

// ---- start ----

// Start (re)creates the container from the spec and starts it.
func (m *Manager) Start(ctx context.Context, spec *protocol.InstanceSpec) (*protocol.InstanceState, error) {
	inst := m.get(spec.UUID)
	inst.opMu.Lock()
	defer inst.opMu.Unlock()
	return m.startLocked(ctx, inst, spec)
}

func (m *Manager) startLocked(ctx context.Context, inst *instance, spec *protocol.InstanceSpec) (*protocol.InstanceState, error) {
	inst.mu.Lock()
	switch inst.state {
	case protocol.StateRunning, protocol.StateStarting, protocol.StateStopping:
		st := m.stateLocked(inst)
		inst.mu.Unlock()
		return &st, nil
	case protocol.StateInstalling:
		inst.mu.Unlock()
		return nil, invalid("the instance is installing")
	}
	inst.spec = spec
	inst.errMsg = nil
	inst.exitCode = nil
	inst.stopRequested = false
	var ready *regexp.Regexp
	if spec.Console.ReadyPattern != nil && *spec.Console.ReadyPattern != "" {
		re, err := regexp.Compile(*spec.Console.ReadyPattern)
		if err != nil {
			m.log.Warn("bad ready pattern; treating start as ready", "uuid", spec.UUID, "err", err)
		} else {
			ready = re
		}
	}
	inst.ready = ready
	inst.mu.Unlock()
	_ = m.persistSpec(spec)

	fail := func(err error) (*protocol.InstanceState, error) {
		inst.mu.Lock()
		msg := err.Error()
		inst.errMsg = &msg
		m.setStateLocked(inst, protocol.StateStopped)
		st := m.stateLocked(inst)
		inst.mu.Unlock()
		return &st, err
	}

	dataDir := m.DataDir(spec.UUID)
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return fail(err)
	}
	m.chown(dataDir, spec)
	if !m.installed(spec.UUID) {
		return fail(invalid("the instance is not installed yet"))
	}
	if inst.logFile == nil {
		lf, err := openConsoleLog(m.consolePath(spec.UUID))
		if err != nil {
			return fail(err)
		}
		inst.logFile = lf
	}
	say := func(text string) { m.consoleLine(inst, text) }
	if err := m.ensureImage(ctx, spec.Image, say); err != nil {
		return fail(fmt.Errorf("image pull failed: %w", err))
	}
	uid, gid := m.Owner(spec)
	for _, cf := range spec.Files {
		if err := ApplyConfigFile(dataDir, cf, uid, gid); err != nil {
			if !m.Root && strings.Contains(err.Error(), "operation not permitted") {
				continue
			}
			return fail(fmt.Errorf("config file: %w", err))
		}
	}

	name := "gsm-" + spec.UUID
	_ = m.dk.ContainerRemove(ctx, name)
	ports := make([]docker.PortSpec, 0, len(spec.Ports))
	for _, p := range spec.Ports {
		ports = append(ports, docker.PortSpec{Protocol: p.Protocol, Host: p.Host, Container: p.Container})
	}
	bind := spec.BindAddress
	if bind == "" {
		bind = "0.0.0.0"
	}
	id, err := m.dk.ContainerCreate(ctx, docker.CreateOptions{
		Name:        name,
		Image:       spec.Image,
		Cmd:         []string{"sh", "-c", spec.Startup},
		Env:         envList(spec.Env),
		WorkingDir:  "/data",
		User:        fmt.Sprintf("%d:%d", uid, gid),
		Labels:      map[string]string{docker.LabelInstance: spec.UUID, docker.LabelName: spec.Name, docker.LabelManaged: "true"},
		Binds:       []string{dataDir + ":/data"},
		Ports:       ports,
		BindAddress: bind,
		MemoryBytes: int64(spec.Limits.MemoryMb) << 20,
		NanoCPUs:    int64(spec.Limits.CPUCores * 1e9),
		OpenStdin:   true,
		Init:        false, // the base image runs tini as its entrypoint already
		StopSignal:  spec.Stop.Signal,
	})
	if err != nil {
		return fail(fmt.Errorf("create container: %w", err))
	}
	att, err := m.dk.ContainerAttach(context.Background(), id, true, false)
	if err != nil {
		_ = m.dk.ContainerRemove(ctx, id)
		return fail(fmt.Errorf("attach: %w", err))
	}
	if err := m.dk.ContainerStart(ctx, id); err != nil {
		att.Close()
		_ = m.dk.ContainerRemove(ctx, id)
		return fail(fmt.Errorf("start container: %w", err))
	}
	m.log.Info("instance started", "uuid", spec.UUID, "name", spec.Name, "container", id[:12])
	say(fmt.Sprintf("[GSM] container started (%s)", spec.Image))
	m.track(inst, id, att, ready == nil)
	inst.mu.Lock()
	st := m.stateLocked(inst)
	inst.mu.Unlock()
	return &st, nil
}

// track wires the console pump and the exit watcher for a container; sets the state.
func (m *Manager) track(inst *instance, id string, att *docker.Attached, readyNow bool) {
	pctx, cancel := context.WithCancel(context.Background())
	exited := make(chan struct{})
	inst.mu.Lock()
	inst.containerID = id
	inst.attach = att
	inst.transport = nil
	if inst.spec != nil && inst.spec.Console.Transport != nil {
		inst.transport = m.startTransport(pctx, inst, id, *inst.spec.Console.Transport)
	}
	inst.cancelPump = cancel
	inst.exited = exited
	inst.startedAt = time.Now()
	if readyNow {
		m.setStateLocked(inst, protocol.StateRunning)
	} else {
		m.setStateLocked(inst, protocol.StateStarting)
	}
	inst.mu.Unlock()
	go m.pump(pctx, inst, att)
	go m.watch(inst, id, exited, cancel)
}

// startTransport opens the console transport for a container and keeps it open until ctx ends
// (the container exited). Called with inst.mu held.
func (m *Manager) startTransport(ctx context.Context, inst *instance, containerID string, spec protocol.ConsoleTransport) *transport {
	b := newBatcher(func(lines []protocol.ConsoleLine) { m.flushConsole(inst, lines) })
	address := func(ctx context.Context) (string, error) {
		insp, err := m.dk.ContainerInspect(ctx, containerID)
		if err != nil {
			return "", err
		}
		if insp.IPAddress == "" {
			return "", errors.New("the container has no network address")
		}
		return net.JoinHostPort(insp.IPAddress, strconv.Itoa(spec.Port)), nil
	}
	emit := func(text string) { b.Add(protocol.ConsoleLine{At: nowMs(), Text: text}) }
	note := func(text string) {
		inst.mu.Lock()
		quiet := inst.state == protocol.StateStopping || inst.containerID != containerID
		inst.mu.Unlock()
		if !quiet {
			m.consoleLine(inst, text)
		}
	}
	t := newTransport(spec, address, emit, note)
	go func() {
		t.run(ctx)
		b.Close()
	}()
	return t
}

// watch waits for the container to exit and records the outcome.
func (m *Manager) watch(inst *instance, id string, exited chan struct{}, cancelPump context.CancelFunc) {
	defer close(exited)
	code, err := m.dk.ContainerWait(context.Background(), id)
	// Let the pump drain what the container printed last.
	time.Sleep(200 * time.Millisecond)
	cancelPump()
	inst.mu.Lock()
	if inst.containerID != id {
		inst.mu.Unlock()
		return // superseded
	}
	if inst.attach != nil {
		inst.attach.Close()
		inst.attach = nil
	}
	inst.transport = nil
	inst.containerID = ""
	inst.exitCode = &code
	requested := inst.stopRequested
	spec := inst.spec
	if err != nil {
		msg := err.Error()
		inst.errMsg = &msg
	}
	restart := false
	attempt := 0
	switch {
	case requested || (code == 0 && err == nil):
		m.setStateLocked(inst, protocol.StateStopped)
	default:
		if spec != nil && spec.RestartOnCrash {
			var ok bool
			ok, attempt, inst.crashes = crashRestartAllowed(inst.crashes, time.Now())
			restart = ok
		}
		m.setStateLocked(inst, protocol.StateCrashed)
	}
	inst.mu.Unlock()
	if requested {
		m.consoleLine(inst, fmt.Sprintf("[GSM] container stopped (exit code %d)", code))
	} else if code == 0 && err == nil {
		m.consoleLine(inst, "[GSM] container exited normally")
	} else if restart {
		m.consoleLine(inst, fmt.Sprintf("[GSM] container exited with code %d, restarting (attempt %d/%d)", code, attempt, crashBudget))
	} else {
		m.consoleLine(inst, fmt.Sprintf("[GSM] container exited with code %d; not restarting", code))
	}
	m.log.Info("container exited", "uuid", inst.uuid, "code", code, "requested", requested, "restart", restart)
	_ = m.dk.ContainerRemove(context.Background(), id)
	if restart {
		go func() {
			time.Sleep(crashRestartDelay)
			inst.opMu.Lock()
			defer inst.opMu.Unlock()
			inst.mu.Lock()
			spec := inst.spec
			state := inst.state
			inst.mu.Unlock()
			if spec == nil || state != protocol.StateCrashed {
				return
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
			defer cancel()
			if _, err := m.startLocked(ctx, inst, spec); err != nil {
				m.log.Warn("crash restart failed", "uuid", inst.uuid, "err", err)
			}
		}()
	}
}

// ---- stop ----

// Stop ends the container gracefully (or with SIGKILL when force) and waits for the exit.
func (m *Manager) Stop(ctx context.Context, uuid string, force bool) (*protocol.InstanceState, error) {
	inst := m.get(uuid)
	inst.opMu.Lock()
	defer inst.opMu.Unlock()
	return m.stopLocked(ctx, inst, force)
}

func (m *Manager) stopLocked(ctx context.Context, inst *instance, force bool) (*protocol.InstanceState, error) {
	inst.mu.Lock()
	if inst.installing {
		if inst.installCancel != nil {
			inst.installCancel()
		}
		st := m.stateLocked(inst)
		inst.mu.Unlock()
		return &st, nil
	}
	id := inst.containerID
	exited := inst.exited
	spec := inst.spec
	if inst.state == protocol.StateCrashed {
		// Nothing runs, but a crash restart may be pending: settling on stopped cancels it.
		inst.stopRequested = true
		inst.crashes = nil
		m.setStateLocked(inst, protocol.StateStopped)
		st := m.stateLocked(inst)
		inst.mu.Unlock()
		m.consoleLine(inst, "[GSM] stop requested; crash restarts cancelled")
		return &st, nil
	}
	if id == "" || (inst.state != protocol.StateRunning && inst.state != protocol.StateStarting && inst.state != protocol.StateStopping) {
		st := m.stateLocked(inst)
		inst.mu.Unlock()
		return &st, nil
	}
	inst.stopRequested = true
	m.setStateLocked(inst, protocol.StateStopping)
	att := inst.attach
	tr := inst.transport
	inst.mu.Unlock()

	wait := func(d time.Duration) bool {
		select {
		case <-exited:
			return true
		case <-time.After(d):
			return false
		case <-ctx.Done():
			return false
		}
	}
	if !force {
		timeout := 30 * time.Second
		signal := "SIGTERM"
		if spec != nil {
			if spec.Stop.TimeoutSeconds > 0 {
				timeout = time.Duration(spec.Stop.TimeoutSeconds) * time.Second
			}
			if spec.Stop.Signal != "" {
				signal = spec.Stop.Signal
			}
			if spec.Stop.Command != nil && *spec.Stop.Command != "" && (tr != nil || (att != nil && att.Stdin != nil)) {
				m.consoleLine(inst, "[GSM] stopping: "+*spec.Stop.Command)
				var err error
				if tr != nil {
					err = tr.Send(*spec.Stop.Command)
				} else {
					inst.stdinMu.Lock()
					_, err = io.WriteString(att.Stdin, *spec.Stop.Command+"\n")
					inst.stdinMu.Unlock()
				}
				if err != nil {
					m.consoleLine(inst, "[GSM] the stop command did not go through: "+err.Error())
				} else if wait(timeout) {
					return m.finalState(inst), nil
				}
			}
		}
		m.consoleLine(inst, "[GSM] sending "+signal)
		_ = m.dk.ContainerStop(ctx, id, signal, stopGrace)
		if wait(time.Duration(stopGrace+5) * time.Second) {
			return m.finalState(inst), nil
		}
	}
	m.consoleLine(inst, "[GSM] killing the container")
	_ = m.dk.ContainerKill(ctx, id)
	if !wait(30 * time.Second) {
		return nil, fmt.Errorf("the container did not exit after SIGKILL")
	}
	return m.finalState(inst), nil
}

func (m *Manager) finalState(inst *instance) *protocol.InstanceState {
	inst.mu.Lock()
	defer inst.mu.Unlock()
	st := m.stateLocked(inst)
	return &st
}

// Restart stops (gracefully) and starts again from the spec.
func (m *Manager) Restart(ctx context.Context, spec *protocol.InstanceSpec) (*protocol.InstanceState, error) {
	inst := m.get(spec.UUID)
	inst.opMu.Lock()
	defer inst.opMu.Unlock()
	if _, err := m.stopLocked(ctx, inst, false); err != nil {
		return nil, err
	}
	return m.startLocked(ctx, inst, spec)
}

// Remove kills and removes the container and, with deleteFiles, everything the instance owns.
func (m *Manager) Remove(ctx context.Context, uuid string, deleteFiles bool) error {
	inst := m.get(uuid)
	inst.opMu.Lock()
	defer inst.opMu.Unlock()
	if _, err := m.stopLocked(ctx, inst, true); err != nil {
		m.log.Warn("stop before remove failed", "uuid", uuid, "err", err)
	}
	_ = m.dk.ContainerRemove(ctx, "gsm-"+uuid)
	_ = m.dk.ContainerRemove(ctx, "gsm-install-"+uuid)
	inst.mu.Lock()
	if inst.logFile != nil {
		inst.logFile.Close()
		inst.logFile = nil
	}
	inst.mu.Unlock()
	_ = os.Remove(m.statePath(uuid))
	if deleteFiles {
		for _, d := range []string{m.DataDir(uuid), m.LogDir(uuid), m.BackupDir(uuid)} {
			if err := os.RemoveAll(d); err != nil {
				return err
			}
		}
	}
	m.mu.Lock()
	delete(m.insts, uuid)
	m.mu.Unlock()
	return nil
}

// ---- listing & reconcile ----

// List reports every instance the node knows: labelled containers and persisted specs.
func (m *Manager) List(ctx context.Context) ([]protocol.InstanceState, error) {
	containers, err := m.dk.ContainerList(ctx)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	out := []protocol.InstanceState{}
	for _, c := range containers {
		if c.UUID == "" {
			continue
		}
		seen[c.UUID] = true
		inst := m.get(c.UUID)
		inst.mu.Lock()
		st := m.stateLocked(inst)
		if inst.containerID == "" {
			// A container we are not tracking (should not happen after Reconcile); report docker's view.
			id := c.ID
			st.ContainerID = &id
			switch c.State {
			case "running", "restarting":
				st.State = protocol.StateRunning
			default:
				st.State = protocol.StateStopped
			}
		}
		inst.mu.Unlock()
		out = append(out, st)
	}
	m.mu.Lock()
	known := make([]*instance, 0, len(m.insts))
	for _, inst := range m.insts {
		known = append(known, inst)
	}
	m.mu.Unlock()
	for _, inst := range known {
		if seen[inst.uuid] {
			continue
		}
		seen[inst.uuid] = true
		inst.mu.Lock()
		out = append(out, m.stateLocked(inst))
		inst.mu.Unlock()
	}
	if entries, err := os.ReadDir(m.dirs.State); err == nil {
		for _, e := range entries {
			uuid := strings.TrimSuffix(e.Name(), ".json")
			if uuid == e.Name() || seen[uuid] {
				continue
			}
			inst := m.get(uuid)
			inst.mu.Lock()
			if inst.spec == nil {
				inst.spec = m.loadSpec(uuid)
			}
			out = append(out, m.stateLocked(inst))
			inst.mu.Unlock()
		}
	}
	return out, nil
}

// Reconcile re-attaches to containers left running by a previous agent process and loads specs.
func (m *Manager) Reconcile(ctx context.Context) error {
	containers, err := m.dk.ContainerList(ctx)
	if err != nil {
		return err
	}
	for _, c := range containers {
		if c.UUID == "" {
			continue
		}
		inst := m.get(c.UUID)
		inst.mu.Lock()
		if inst.spec == nil {
			inst.spec = m.loadSpec(c.UUID)
		}
		if inst.spec != nil && inst.spec.Console.ReadyPattern != nil {
			inst.ready, _ = regexp.Compile(*inst.spec.Console.ReadyPattern)
		}
		if inst.logFile == nil {
			inst.logFile, _ = openConsoleLog(m.consolePath(c.UUID))
		}
		inst.mu.Unlock()
		switch c.State {
		case "running":
			att, err := m.dk.ContainerAttach(context.Background(), c.ID, true, false)
			if err != nil {
				m.log.Warn("cannot re-attach", "uuid", c.UUID, "err", err)
				continue
			}
			if insp, err := m.dk.ContainerInspect(ctx, c.ID); err == nil && !insp.StartedAt.IsZero() {
				inst.mu.Lock()
				inst.startedAt = insp.StartedAt
				inst.mu.Unlock()
			}
			// A container that survived an agent restart has been up a while: count it as ready.
			m.track(inst, c.ID, att, true)
			m.consoleLine(inst, "[GSM] agent reconnected to the running container")
			m.log.Info("re-attached to running instance", "uuid", c.UUID, "container", c.ID[:12])
		default:
			insp, err := m.dk.ContainerInspect(ctx, c.ID)
			inst.mu.Lock()
			if err == nil {
				code := insp.ExitCode
				inst.exitCode = &code
				if code != 0 && c.State == "exited" {
					inst.state = protocol.StateCrashed
				} else {
					inst.state = protocol.StateStopped
				}
			}
			inst.mu.Unlock()
			_ = m.dk.ContainerRemove(ctx, c.ID)
		}
	}
	if entries, err := os.ReadDir(m.dirs.State); err == nil {
		for _, e := range entries {
			uuid := strings.TrimSuffix(e.Name(), ".json")
			if uuid == e.Name() {
				continue
			}
			inst := m.get(uuid)
			inst.mu.Lock()
			if inst.spec == nil {
				inst.spec = m.loadSpec(uuid)
			}
			inst.mu.Unlock()
		}
	}
	return nil
}

// ---- stats ----

// Stats samples the running instances among uuids (all running ones when empty).
func (m *Manager) Stats(ctx context.Context, uuids []string) []protocol.InstanceStats {
	m.mu.Lock()
	var targets []*instance
	if len(uuids) == 0 {
		for _, inst := range m.insts {
			targets = append(targets, inst)
		}
	} else {
		for _, u := range uuids {
			if inst := m.insts[u]; inst != nil {
				targets = append(targets, inst)
			}
		}
	}
	m.mu.Unlock()
	out := []protocol.InstanceStats{}
	for _, inst := range targets {
		inst.mu.Lock()
		id := inst.containerID
		running := inst.state == protocol.StateRunning || inst.state == protocol.StateStarting || inst.state == protocol.StateStopping
		started := inst.startedAt
		disk, diskAt := inst.diskUsed, inst.diskAt
		inst.mu.Unlock()
		if id == "" || !running {
			continue
		}
		if time.Since(diskAt) > diskRefresh {
			disk = metrics.DirSize(m.DataDir(inst.uuid))
			inst.mu.Lock()
			inst.diskUsed, inst.diskAt = disk, time.Now()
			inst.mu.Unlock()
		}
		s, err := m.dk.ContainerStats(ctx, id)
		if err != nil {
			continue
		}
		var uptime uint64
		if !started.IsZero() {
			uptime = uint64(time.Since(started).Seconds())
		}
		out = append(out, protocol.InstanceStats{
			UUID:          inst.uuid,
			At:            time.Now().UTC(),
			CPUPct:        s.CPUPct,
			MemUsedBytes:  s.MemUsedBytes,
			MemLimitBytes: s.MemLimitBytes,
			NetRxBytes:    s.NetRxBytes,
			NetTxBytes:    s.NetTxBytes,
			DiskUsedBytes: disk,
			UptimeSeconds: uptime,
		})
	}
	return out
}

// StatsLoop emits inst.stats every StatsEvery until ctx ends.
func (m *Manager) StatsLoop(ctx context.Context) {
	t := time.NewTicker(StatsEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			stats := m.Stats(ctx, nil)
			if len(stats) > 0 {
				m.send("inst.stats", protocol.InstStatsEvent{Stats: stats})
			}
		}
	}
}

// IsRunning reports whether the instance's container is up (files and backups refuse some
// operations then).
func (m *Manager) IsRunning(uuid string) bool {
	inst := m.lookup(uuid)
	if inst == nil {
		return false
	}
	inst.mu.Lock()
	defer inst.mu.Unlock()
	return inst.containerID != "" || inst.installing
}

// Shutdown closes attachments (containers keep running for the next agent process).
func (m *Manager) Shutdown() {
	m.mu.Lock()
	insts := make([]*instance, 0, len(m.insts))
	for _, inst := range m.insts {
		insts = append(insts, inst)
	}
	m.mu.Unlock()
	for _, inst := range insts {
		inst.mu.Lock()
		if inst.cancelPump != nil {
			inst.cancelPump()
		}
		if inst.logFile != nil {
			inst.logFile.Close()
			inst.logFile = nil
		}
		inst.mu.Unlock()
	}
}
