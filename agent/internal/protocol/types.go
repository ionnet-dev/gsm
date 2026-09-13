// Package protocol mirrors shared/src/protocol/*.ts. Keep the two in sync; docs/protocol.md is the
// contract. JSON field names match the zod schemas exactly.
package protocol

import (
	"encoding/json"
	"time"
)

// ---- inventory & presence ---------------------------------------------------

type DiskInfo struct {
	Device     string `json:"device"`
	Mountpoint string `json:"mountpoint"`
	Fstype     string `json:"fstype"`
	TotalBytes uint64 `json:"totalBytes"`
}

type DockerInfo struct {
	Available     bool   `json:"available"`
	Error         string `json:"error"`
	Version       string `json:"version"`
	APIVersion    string `json:"apiVersion"`
	StorageDriver string `json:"storageDriver"`
	RootDir       string `json:"rootDir"`
}

type OSInfo struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Version    string `json:"version"`
	PrettyName string `json:"prettyName"`
}

type CPUInfo struct {
	Model   string `json:"model"`
	Cores   int    `json:"cores"`
	Threads int    `json:"threads"`
}

type Inventory struct {
	Hostname         string     `json:"hostname"`
	MachineID        string     `json:"machineId"`
	OS               OSInfo     `json:"os"`
	Kernel           string     `json:"kernel"`
	Arch             string     `json:"arch"`
	CPU              CPUInfo    `json:"cpu"`
	MemoryTotalBytes uint64     `json:"memoryTotalBytes"`
	Disks            []DiskInfo `json:"disks"`
	Addresses        []string   `json:"addresses"`
	BootTime         time.Time  `json:"bootTime"`
	Docker           DockerInfo `json:"docker"`
	DataDir          string     `json:"dataDir"`
}

type Hello struct {
	ProtocolVersion int       `json:"protocolVersion"`
	AgentVersion    string    `json:"agentVersion"`
	Inventory       Inventory `json:"inventory"`
}

type DiskUsage struct {
	Mountpoint string `json:"mountpoint"`
	UsedBytes  uint64 `json:"usedBytes"`
	TotalBytes uint64 `json:"totalBytes"`
}

type NetRates struct {
	RxBytesPerSec float64 `json:"rxBytesPerSec"`
	TxBytesPerSec float64 `json:"txBytesPerSec"`
}

type Metrics struct {
	At             time.Time   `json:"at"`
	CPUPct         float64     `json:"cpuPct"`
	MemUsedBytes   uint64      `json:"memUsedBytes"`
	MemTotalBytes  uint64      `json:"memTotalBytes"`
	SwapUsedBytes  uint64      `json:"swapUsedBytes"`
	SwapTotalBytes uint64      `json:"swapTotalBytes"`
	Load           [3]float64  `json:"load"`
	Disks          []DiskUsage `json:"disks"`
	Net            NetRates    `json:"net"`
	UptimeSeconds  uint64      `json:"uptimeSeconds"`
	DataUsedBytes  uint64      `json:"dataUsedBytes"`
}

type PingResult struct {
	At           time.Time `json:"at"`
	AgentVersion string    `json:"agentVersion"`
}

type RegistryAuth struct {
	Server   string `json:"server"`
	Username string `json:"username"`
	Password string `json:"password"`
}

type AgentConfigureParams struct {
	// Absent means "not mentioned": leave as is. A JSON null clears the credentials.
	RegistryAuth json.RawMessage `json:"registryAuth,omitempty"`
	// SFTP is nil when not mentioned: the listener stays as it is.
	SFTP *SFTPConfig `json:"sftp,omitempty"`
}

// SFTPConfig is agent.configure's sftp field. A nil Port stops the listener.
type SFTPConfig struct {
	Port        *int   `json:"port"`
	BindAddress string `json:"bindAddress"`
}

// AgentConfigureResult answers agent.configure.
type AgentConfigureResult struct {
	SFTP SFTPStatus `json:"sftp"`
}

// SFTPStatus says whether the SFTP listener is up; HostKey is the SHA256 fingerprint of its key.
type SFTPStatus struct {
	Listening bool    `json:"listening"`
	Port      *int    `json:"port"`
	HostKey   string  `json:"hostKey"`
	Error     *string `json:"error"`
}

// SFTPAuthParams is the agent → server sftp.auth request, sent for every sign-in attempt.
type SFTPAuthParams struct {
	Username      string `json:"username"`
	Method        string `json:"method"` // password | publickey
	Password      string `json:"password,omitempty"`
	PublicKey     string `json:"publicKey,omitempty"` // authorized_keys format
	RemoteAddress string `json:"remoteAddress"`
}

// SFTPAuthResult binds an allowed session to a user and an instance.
type SFTPAuthResult struct {
	Allowed    bool   `json:"allowed"`
	UserID     int    `json:"userId,omitempty"`
	UUID       string `json:"uuid,omitempty"`
	Credential string `json:"credential,omitempty"`
}

// SFTPSessionsParams filters sftp.sessions; nil UserIDs means every session.
type SFTPSessionsParams struct {
	UserIDs []int `json:"userIds,omitempty"`
}

type SFTPSessionInfo struct {
	ID            string    `json:"id"`
	UserID        int       `json:"userId"`
	UUID          string    `json:"uuid"`
	Method        string    `json:"method"`
	Credential    string    `json:"credential"`
	RemoteAddress string    `json:"remoteAddress"`
	OpenedAt      time.Time `json:"openedAt"`
}

type SFTPSessionsResult struct {
	Sessions []SFTPSessionInfo `json:"sessions"`
}

type SFTPDisconnectParams struct {
	IDs []string `json:"ids"`
}

type SFTPDisconnectResult struct {
	Closed int `json:"closed"`
}

// SFTPSessionStats counts what one SSH connection did.
type SFTPSessionStats struct {
	Uploads   int64 `json:"uploads"`
	Downloads int64 `json:"downloads"`
	Removed   int64 `json:"removed"`
	Renamed   int64 `json:"renamed"`
	Mkdirs    int64 `json:"mkdirs"`
	BytesIn   int64 `json:"bytesIn"`
	BytesOut  int64 `json:"bytesOut"`
}

// SFTPSessionEvent is the sftp.session event: "opened" after sign-in, "closed" with Stats.
type SFTPSessionEvent struct {
	ID            string            `json:"id"`
	State         string            `json:"state"`
	UserID        int               `json:"userId"`
	UUID          string            `json:"uuid"`
	Method        string            `json:"method"`
	RemoteAddress string            `json:"remoteAddress"`
	Stats         *SFTPSessionStats `json:"stats"`
}

// Auth decodes the registryAuth field: present says whether it was sent at all.
func (p AgentConfigureParams) Auth() (present bool, auth *RegistryAuth, err error) {
	if len(p.RegistryAuth) == 0 {
		return false, nil, nil
	}
	if string(p.RegistryAuth) == "null" {
		return true, nil, nil
	}
	var a RegistryAuth
	if err := json.Unmarshal(p.RegistryAuth, &a); err != nil {
		return true, nil, err
	}
	return true, &a, nil
}

type AgentUpdateParams struct {
	Version string `json:"version"`
	Path    string `json:"path"`
	SHA256  string `json:"sha256"`
}

type AgentUpdateResult struct {
	Replaced bool   `json:"replaced"`
	Message  string `json:"message"`
}

type LogEvent struct {
	Level   string `json:"level"`
	Message string `json:"message"`
}

// ---- instances -----------------------------------------------------------------

type PortBinding struct {
	Name      string `json:"name"`
	Protocol  string `json:"protocol"` // tcp | udp
	Host      int    `json:"host"`
	Container int    `json:"container"`
}

type ResourceLimits struct {
	MemoryMb int     `json:"memoryMb"`
	CPUCores float64 `json:"cpuCores"`
	DiskMb   int     `json:"diskMb"`
}

type ConfigFileSpec struct {
	Path   string            `json:"path"`
	Format string            `json:"format"` // properties | json | ini | yaml
	Values map[string]string `json:"values"`
}

type StopSpec struct {
	Command        *string `json:"command"`
	Signal         string  `json:"signal"` // SIGTERM | SIGINT | SIGKILL
	TimeoutSeconds int     `json:"timeoutSeconds"`
}

type ConsoleSpec struct {
	ReadyPattern *string `json:"readyPattern"`
}

type UserSpec struct {
	UID int `json:"uid"`
	GID int `json:"gid"`
}

type InstanceSpec struct {
	UUID           string            `json:"uuid"`
	Name           string            `json:"name"`
	Image          string            `json:"image"`
	Startup        string            `json:"startup"`
	Env            map[string]string `json:"env"`
	Ports          []PortBinding     `json:"ports"`
	BindAddress    string            `json:"bindAddress"`
	Limits         ResourceLimits    `json:"limits"`
	Stop           StopSpec          `json:"stop"`
	Console        ConsoleSpec       `json:"console"`
	Files          []ConfigFileSpec  `json:"files"`
	RestartOnCrash bool              `json:"restartOnCrash"`
	User           UserSpec          `json:"user"`
}

type InstallSpec struct {
	Image          *string           `json:"image"`
	Script         string            `json:"script"`
	Env            map[string]string `json:"env"`
	TimeoutSeconds int               `json:"timeoutSeconds"`
}

// Agent-reported instance states.
const (
	StateStopped    = "stopped"
	StateStarting   = "starting"
	StateRunning    = "running"
	StateStopping   = "stopping"
	StateCrashed    = "crashed"
	StateInstalling = "installing"
)

type InstanceState struct {
	UUID        string     `json:"uuid"`
	State       string     `json:"state"`
	ContainerID *string    `json:"containerId"`
	StartedAt   *time.Time `json:"startedAt"`
	ExitCode    *int       `json:"exitCode"`
	Installed   bool       `json:"installed"`
	Error       *string    `json:"error"`
}

type InstanceStats struct {
	UUID          string    `json:"uuid"`
	At            time.Time `json:"at"`
	CPUPct        float64   `json:"cpuPct"`
	MemUsedBytes  uint64    `json:"memUsedBytes"`
	MemLimitBytes uint64    `json:"memLimitBytes"`
	NetRxBytes    uint64    `json:"netRxBytes"`
	NetTxBytes    uint64    `json:"netTxBytes"`
	DiskUsedBytes uint64    `json:"diskUsedBytes"`
	UptimeSeconds uint64    `json:"uptimeSeconds"`
}

type ConsoleLine struct {
	At   int64  `json:"at"` // ms since the epoch
	Text string `json:"text"`
}

type InstallOutputChunk struct {
	Lines []ConsoleLine `json:"lines"`
}

type InstListResult struct {
	Instances []InstanceState `json:"instances"`
}

type InstUUIDParams struct {
	UUID string `json:"uuid"`
}

type InstInstallParams struct {
	Spec    InstanceSpec `json:"spec"`
	Install InstallSpec  `json:"install"`
}

type InstInstallResult struct {
	ExitCode   int   `json:"exitCode"`
	DurationMs int64 `json:"durationMs"`
}

type InstStartParams struct {
	Spec InstanceSpec `json:"spec"`
}

type InstStopParams struct {
	UUID  string `json:"uuid"`
	Force bool   `json:"force"`
}

type InstCommandParams struct {
	UUID    string `json:"uuid"`
	Command string `json:"command"`
}

type InstConsoleTailParams struct {
	UUID   string `json:"uuid"`
	Stream string `json:"stream"` // console | install
	Lines  int    `json:"lines"`
}

type InstConsoleTailResult struct {
	Lines []ConsoleLine `json:"lines"`
}

type InstRemoveParams struct {
	UUID        string `json:"uuid"`
	DeleteFiles bool   `json:"deleteFiles"`
}

type InstStatsParams struct {
	UUIDs []string `json:"uuids"`
}

type InstStatsResult struct {
	Stats []InstanceStats `json:"stats"`
}

// Events agent -> server.

type InstConsoleEvent struct {
	UUID   string        `json:"uuid"`
	Stream string        `json:"stream"`
	Lines  []ConsoleLine `json:"lines"`
}

type InstStatsEvent struct {
	Stats []InstanceStats `json:"stats"`
}

// ---- files -----------------------------------------------------------------

type FileEntry struct {
	Name       string    `json:"name"`
	Type       string    `json:"type"` // file | dir | symlink | other
	Size       int64     `json:"size"`
	Mode       int       `json:"mode"`
	Mtime      time.Time `json:"mtime"`
	TargetType *string   `json:"targetType"`
}

const FileListMax = 10_000

type FileListResult struct {
	Path      string      `json:"path"`
	Entries   []FileEntry `json:"entries"`
	Truncated bool        `json:"truncated"`
}

type FileStatResult struct {
	Path  string    `json:"path"`
	Entry FileEntry `json:"entry"`
}

type FileReadResult struct {
	Path     string    `json:"path"`
	Size     int64     `json:"size"`
	Mtime    time.Time `json:"mtime"`
	Mode     int       `json:"mode"`
	SHA256   string    `json:"sha256"`
	TooLarge bool      `json:"tooLarge"`
	Binary   bool      `json:"binary"`
	Content  *string   `json:"content"`
}

type FileWriteResult struct {
	Path   string    `json:"path"`
	Size   int64     `json:"size"`
	SHA256 string    `json:"sha256"`
	Mtime  time.Time `json:"mtime"`
}

type FileTransferResult struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

type FsPathParams struct {
	UUID string `json:"uuid"`
	Path string `json:"path"`
}

type FsReadParams struct {
	UUID     string `json:"uuid"`
	Path     string `json:"path"`
	MaxBytes int64  `json:"maxBytes"`
}

type FsWriteParams struct {
	UUID         string  `json:"uuid"`
	Path         string  `json:"path"`
	Content      string  `json:"content"`
	ExpectSHA256 *string `json:"expectSha256"`
	Create       bool    `json:"create"`
}

type FsRenameParams struct {
	UUID string `json:"uuid"`
	From string `json:"from"`
	To   string `json:"to"`
}

type FsPathsParams struct {
	UUID  string   `json:"uuid"`
	Paths []string `json:"paths"`
}

type FsDeleteResult struct {
	Deleted int `json:"deleted"`
}

type FsChmodParams struct {
	UUID      string   `json:"uuid"`
	Paths     []string `json:"paths"`
	Mode      int      `json:"mode"`
	Recursive bool     `json:"recursive"`
}

type FsChmodResult struct {
	Changed int `json:"changed"`
}

type FsExtractParams struct {
	UUID string `json:"uuid"`
	Path string `json:"path"`
	Dest string `json:"dest"`
}

type FsExtractResult struct {
	Files int `json:"files"`
}

type FsCompressParams struct {
	UUID  string   `json:"uuid"`
	Paths []string `json:"paths"`
	Dest  string   `json:"dest"`
}

type FsCancelParams struct {
	OpID string `json:"opId"`
}

type FsUploadParams struct {
	OpID      string `json:"opId"`
	Token     string `json:"token"`
	UUID      string `json:"uuid"`
	Path      string `json:"path"`
	Size      int64  `json:"size"`
	Overwrite bool   `json:"overwrite"`
}

type FsDownloadParams struct {
	OpID    string   `json:"opId"`
	Token   string   `json:"token"`
	UUID    string   `json:"uuid"`
	Paths   []string `json:"paths"`
	Archive bool     `json:"archive"`
}

type PathResult struct {
	Path string `json:"path"`
}

// ---- backups -----------------------------------------------------------------

type BackupProgress struct {
	Bytes int64 `json:"bytes"`
	Files int   `json:"files"`
}

type BackupCreateParams struct {
	UUID     string   `json:"uuid"`
	BackupID string   `json:"backupId"`
	Ignore   []string `json:"ignore"`
}

type BackupCreateResult struct {
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
	Files  int    `json:"files"`
}

type BackupRestoreParams struct {
	UUID     string `json:"uuid"`
	BackupID string `json:"backupId"`
	Wipe     bool   `json:"wipe"`
}

type BackupRestoreResult struct {
	Files int `json:"files"`
}

type BackupRefParams struct {
	UUID     string `json:"uuid"`
	BackupID string `json:"backupId"`
}

type BackupDownloadParams struct {
	OpID     string `json:"opId"`
	Token    string `json:"token"`
	UUID     string `json:"uuid"`
	BackupID string `json:"backupId"`
}

type BackupDownloadResult struct {
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

type BackupListEntry struct {
	BackupID string    `json:"backupId"`
	Size     int64     `json:"size"`
	Mtime    time.Time `json:"mtime"`
}

type BackupListResult struct {
	Backups []BackupListEntry `json:"backups"`
}

// ---- images -----------------------------------------------------------------

type ImageInfo struct {
	Ref     string    `json:"ref"`
	ID      string    `json:"id"`
	Size    int64     `json:"size"`
	Created time.Time `json:"created"`
}

type PullProgress struct {
	Status  string `json:"status"`
	Layer   string `json:"layer"`
	Current int64  `json:"current"`
	Total   int64  `json:"total"`
}

type ImageListResult struct {
	Images []ImageInfo `json:"images"`
}

type ImageRefParams struct {
	Ref string `json:"ref"`
}

type ImagePullResult struct {
	Ref string `json:"ref"`
	ID  string `json:"id"`
}
