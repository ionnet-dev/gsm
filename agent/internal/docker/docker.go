// Package docker is a thin wrapper over the Docker Engine API client with only what the agent needs.
package docker

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/registry"
	"github.com/docker/docker/client"
	"github.com/docker/docker/errdefs"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/docker/go-connections/nat"

	"github.com/ionnet/gsm/agent/internal/protocol"
)

// LabelInstance marks containers the agent manages; its value is the instance uuid.
const (
	LabelInstance = "gsm.instance"
	LabelName     = "gsm.name"
	LabelManaged  = "gsm.managed"
)

// Client wraps the engine API client.
type Client struct {
	api    *client.Client
	authMu sync.RWMutex
	auth   *protocol.RegistryAuth
}

// New connects using the environment (DOCKER_HOST or the default socket), negotiating the API version.
func New() (*Client, error) {
	api, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		return nil, err
	}
	return &Client{api: api}, nil
}

// SetRegistryAuth stores credentials used by later pulls (nil clears them).
func (c *Client) SetRegistryAuth(a *protocol.RegistryAuth) {
	c.authMu.Lock()
	defer c.authMu.Unlock()
	c.auth = a
}

func (c *Client) registryAuthFor(ref string) string {
	c.authMu.RLock()
	a := c.auth
	c.authMu.RUnlock()
	if a == nil {
		return ""
	}
	// Only send credentials to the registry they belong to.
	server := strings.TrimSuffix(strings.TrimPrefix(strings.TrimPrefix(a.Server, "https://"), "http://"), "/")
	if server != "" && server != "docker.io" && !strings.HasPrefix(ref, server+"/") {
		return ""
	}
	b, _ := json.Marshal(registry.AuthConfig{Username: a.Username, Password: a.Password, ServerAddress: a.Server})
	return base64.URLEncoding.EncodeToString(b)
}

// Info reports what the daemon says about itself; Available is false when it cannot be reached.
func (c *Client) Info(ctx context.Context) protocol.DockerInfo {
	if c == nil {
		return protocol.DockerInfo{Error: "docker client not initialised"}
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	info, err := c.api.Info(ctx)
	if err != nil {
		return protocol.DockerInfo{Error: err.Error()}
	}
	return protocol.DockerInfo{
		Available:     true,
		Version:       info.ServerVersion,
		APIVersion:    c.api.ClientVersion(),
		StorageDriver: info.Driver,
		RootDir:       info.DockerRootDir,
	}
}

// ---- images ----

func (c *Client) ImageList(ctx context.Context) ([]protocol.ImageInfo, error) {
	list, err := c.api.ImageList(ctx, image.ListOptions{})
	if err != nil {
		return nil, err
	}
	out := make([]protocol.ImageInfo, 0, len(list))
	for _, im := range list {
		ref := im.ID
		if len(im.RepoTags) > 0 && im.RepoTags[0] != "<none>:<none>" {
			ref = im.RepoTags[0]
		}
		out = append(out, protocol.ImageInfo{
			Ref:     ref,
			ID:      im.ID,
			Size:    im.Size,
			Created: time.Unix(im.Created, 0).UTC(),
		})
	}
	return out, nil
}

// ImageExists reports whether the image is present locally.
func (c *Client) ImageExists(ctx context.Context, ref string) (bool, error) {
	_, _, err := c.api.ImageInspectWithRaw(ctx, ref)
	if err == nil {
		return true, nil
	}
	if errdefs.IsNotFound(err) {
		return false, nil
	}
	return false, err
}

// ImagePull pulls ref, reporting progress lines to onProgress (may be nil). Returns the image id.
func (c *Client) ImagePull(ctx context.Context, ref string, onProgress func(protocol.PullProgress)) (string, error) {
	rc, err := c.api.ImagePull(ctx, ref, image.PullOptions{RegistryAuth: c.registryAuthFor(ref)})
	if err != nil {
		return "", err
	}
	defer rc.Close()
	sc := bufio.NewScanner(rc)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		var msg struct {
			Status   string `json:"status"`
			ID       string `json:"id"`
			Error    string `json:"error"`
			Progress *struct {
				Current int64 `json:"current"`
				Total   int64 `json:"total"`
			} `json:"progressDetail"`
		}
		if err := json.Unmarshal(sc.Bytes(), &msg); err != nil {
			continue
		}
		if msg.Error != "" {
			return "", errors.New(msg.Error)
		}
		if onProgress != nil {
			p := protocol.PullProgress{Status: msg.Status, Layer: msg.ID}
			if msg.Progress != nil {
				p.Current, p.Total = msg.Progress.Current, msg.Progress.Total
			}
			onProgress(p)
		}
	}
	if err := sc.Err(); err != nil {
		return "", err
	}
	inspect, _, err := c.api.ImageInspectWithRaw(ctx, ref)
	if err != nil {
		return "", err
	}
	return inspect.ID, nil
}

func (c *Client) ImageRemove(ctx context.Context, ref string) error {
	_, err := c.api.ImageRemove(ctx, ref, image.RemoveOptions{PruneChildren: true})
	return err
}

// ---- containers ----

// PortSpec is one published port.
type PortSpec struct {
	Protocol  string // tcp | udp
	Host      int
	Container int
}

// CreateOptions is what the agent sets on a container.
type CreateOptions struct {
	Name        string
	Image       string
	Cmd         []string
	Env         []string
	WorkingDir  string
	User        string
	Labels      map[string]string
	Binds       []string
	Ports       []PortSpec
	BindAddress string
	MemoryBytes int64
	NanoCPUs    int64
	OpenStdin   bool
	AutoRemove  bool
	Init        bool
	StopSignal  string
}

// ContainerCreate creates (without starting) a container and returns its id.
func (c *Client) ContainerCreate(ctx context.Context, o CreateOptions) (string, error) {
	exposed := nat.PortSet{}
	bindings := nat.PortMap{}
	for _, p := range o.Ports {
		port, err := nat.NewPort(p.Protocol, fmt.Sprint(p.Container))
		if err != nil {
			return "", err
		}
		exposed[port] = struct{}{}
		bindings[port] = append(bindings[port], nat.PortBinding{HostIP: o.BindAddress, HostPort: fmt.Sprint(p.Host)})
	}
	cfg := &container.Config{
		Image:        o.Image,
		Cmd:          o.Cmd,
		Env:          o.Env,
		WorkingDir:   o.WorkingDir,
		User:         o.User,
		Labels:       o.Labels,
		ExposedPorts: exposed,
		OpenStdin:    o.OpenStdin,
		StdinOnce:    false,
		Tty:          false,
		AttachStdin:  o.OpenStdin,
		AttachStdout: true,
		AttachStderr: true,
	}
	if o.StopSignal != "" {
		cfg.StopSignal = o.StopSignal
	}
	host := &container.HostConfig{
		Binds:         o.Binds,
		PortBindings:  bindings,
		RestartPolicy: container.RestartPolicy{Name: container.RestartPolicyDisabled},
		AutoRemove:    o.AutoRemove,
		LogConfig:     container.LogConfig{Type: "json-file", Config: map[string]string{"max-size": "5m", "max-file": "2"}},
		Resources: container.Resources{
			Memory:     o.MemoryBytes,
			MemorySwap: o.MemoryBytes,
			NanoCPUs:   o.NanoCPUs,
		},
	}
	if o.MemoryBytes == 0 {
		host.Resources.MemorySwap = 0
	}
	if o.Init {
		t := true
		host.Init = &t
	}
	res, err := c.api.ContainerCreate(ctx, cfg, host, nil, nil, o.Name)
	if err != nil {
		return "", err
	}
	return res.ID, nil
}

func (c *Client) ContainerStart(ctx context.Context, id string) error {
	return c.api.ContainerStart(ctx, id, container.StartOptions{})
}

// ContainerStop sends the container's stop signal (or signal) and kills after timeout seconds.
func (c *Client) ContainerStop(ctx context.Context, id, signal string, timeoutSeconds int) error {
	opts := container.StopOptions{Timeout: &timeoutSeconds}
	if signal != "" {
		opts.Signal = signal
	}
	return c.api.ContainerStop(ctx, id, opts)
}

func (c *Client) ContainerKill(ctx context.Context, id string) error {
	err := c.api.ContainerKill(ctx, id, "SIGKILL")
	if err != nil && (errdefs.IsNotFound(err) || errdefs.IsConflict(err)) {
		return nil
	}
	return err
}

// ContainerRemove force-removes the container; a missing container is not an error.
func (c *Client) ContainerRemove(ctx context.Context, id string) error {
	err := c.api.ContainerRemove(ctx, id, container.RemoveOptions{Force: true})
	if err != nil && errdefs.IsNotFound(err) {
		return nil
	}
	return err
}

// Inspected is the subset of inspect data the agent uses.
type Inspected struct {
	ID         string
	Name       string
	Running    bool
	Status     string // created | running | paused | restarting | removing | exited | dead
	ExitCode   int
	StartedAt  time.Time
	FinishedAt time.Time
	Labels     map[string]string
}

var ErrNotFound = errors.New("container not found")

func (c *Client) ContainerInspect(ctx context.Context, id string) (*Inspected, error) {
	j, err := c.api.ContainerInspect(ctx, id)
	if err != nil {
		if errdefs.IsNotFound(err) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	out := &Inspected{ID: j.ID, Name: strings.TrimPrefix(j.Name, "/")}
	if j.Config != nil {
		out.Labels = j.Config.Labels
	}
	if j.State != nil {
		out.Running = j.State.Running
		out.Status = j.State.Status
		out.ExitCode = j.State.ExitCode
		out.StartedAt, _ = time.Parse(time.RFC3339Nano, j.State.StartedAt)
		out.FinishedAt, _ = time.Parse(time.RFC3339Nano, j.State.FinishedAt)
	}
	return out, nil
}

// Managed is one container carrying the instance label.
type Managed struct {
	ID     string
	UUID   string
	Name   string
	State  string // created | running | paused | restarting | removing | exited | dead
	Labels map[string]string
}

// ContainerList lists every container (any state) with the instance label.
func (c *Client) ContainerList(ctx context.Context) ([]Managed, error) {
	f := filters.NewArgs(filters.Arg("label", LabelInstance))
	list, err := c.api.ContainerList(ctx, container.ListOptions{All: true, Filters: f})
	if err != nil {
		return nil, err
	}
	out := make([]Managed, 0, len(list))
	for _, ct := range list {
		name := ""
		if len(ct.Names) > 0 {
			name = strings.TrimPrefix(ct.Names[0], "/")
		}
		out = append(out, Managed{ID: ct.ID, UUID: ct.Labels[LabelInstance], Name: name, State: ct.State, Labels: ct.Labels})
	}
	return out, nil
}

// Attached is an open attach session: demultiplexed stdout/stderr and a stdin writer.
type Attached struct {
	Stdin  io.WriteCloser
	Stdout io.Reader
	Stderr io.Reader
	close  func()
}

func (a *Attached) Close() {
	if a != nil && a.close != nil {
		a.close()
	}
}

// ContainerAttach attaches to a non-TTY container. With logs, buffered output is replayed first.
func (c *Client) ContainerAttach(ctx context.Context, id string, stdin, logs bool) (*Attached, error) {
	resp, err := c.api.ContainerAttach(ctx, id, container.AttachOptions{
		Stream: true,
		Stdin:  stdin,
		Stdout: true,
		Stderr: true,
		Logs:   logs,
	})
	if err != nil {
		return nil, err
	}
	outR, outW := io.Pipe()
	errR, errW := io.Pipe()
	go func() {
		_, err := stdcopy.StdCopy(outW, errW, resp.Reader)
		outW.CloseWithError(err)
		errW.CloseWithError(err)
	}()
	var stdinW io.WriteCloser
	if stdin {
		stdinW = resp.Conn
	}
	return &Attached{Stdin: stdinW, Stdout: outR, Stderr: errR, close: func() {
		resp.Close()
		outR.Close()
		errR.Close()
	}}, nil
}

// ContainerWait blocks until the container exits and returns its exit code.
func (c *Client) ContainerWait(ctx context.Context, id string) (int, error) {
	okC, errC := c.api.ContainerWait(ctx, id, container.WaitConditionNotRunning)
	select {
	case res := <-okC:
		if res.Error != nil {
			return int(res.StatusCode), errors.New(res.Error.Message)
		}
		return int(res.StatusCode), nil
	case err := <-errC:
		return -1, err
	}
}

// Stats is one sample of a running container's resource usage.
type Stats struct {
	CPUPct        float64
	MemUsedBytes  uint64
	MemLimitBytes uint64
	NetRxBytes    uint64
	NetTxBytes    uint64
}

// ContainerStats takes a one-shot stats sample.
func (c *Client) ContainerStats(ctx context.Context, id string) (*Stats, error) {
	resp, err := c.api.ContainerStatsOneShot(ctx, id)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var s container.StatsResponse
	if err := json.NewDecoder(resp.Body).Decode(&s); err != nil {
		return nil, err
	}
	out := &Stats{}
	cpuDelta := float64(s.CPUStats.CPUUsage.TotalUsage) - float64(s.PreCPUStats.CPUUsage.TotalUsage)
	sysDelta := float64(s.CPUStats.SystemUsage) - float64(s.PreCPUStats.SystemUsage)
	cpus := float64(s.CPUStats.OnlineCPUs)
	if cpus == 0 {
		cpus = float64(len(s.CPUStats.CPUUsage.PercpuUsage))
	}
	if cpus == 0 {
		cpus = 1
	}
	if cpuDelta > 0 && sysDelta > 0 {
		out.CPUPct = cpuDelta / sysDelta * cpus * 100
	}
	out.MemUsedBytes = s.MemoryStats.Usage
	if v, ok := s.MemoryStats.Stats["inactive_file"]; ok && v < out.MemUsedBytes {
		out.MemUsedBytes -= v // cgroup v2
	} else if v, ok := s.MemoryStats.Stats["cache"]; ok && v < out.MemUsedBytes {
		out.MemUsedBytes -= v // cgroup v1
	}
	if s.MemoryStats.Limit > 0 && s.MemoryStats.Limit < 1<<62 {
		out.MemLimitBytes = s.MemoryStats.Limit
	}
	for _, n := range s.Networks {
		out.NetRxBytes += n.RxBytes
		out.NetTxBytes += n.TxBytes
	}
	return out, nil
}

// IsNotFound reports whether the daemon said the object does not exist.
func IsNotFound(err error) bool {
	return errors.Is(err, ErrNotFound) || errdefs.IsNotFound(err)
}
