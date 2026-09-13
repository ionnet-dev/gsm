// Package inventory collects static facts about the node for the hello event and sys.inventory.
package inventory

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/ionnet/gsm/agent/internal/protocol"
)

// DockerInfoSource answers what the daemon reports; nil means "no client".
type DockerInfoSource interface {
	Info(ctx context.Context) protocol.DockerInfo
}

// Collect gathers the full inventory. Individual failures degrade to zero values rather than
// erroring: a partially known node is more useful than no node.
func Collect(ctx context.Context, dataDir string, dk DockerInfoSource) protocol.Inventory {
	hostname, _ := os.Hostname()
	inv := protocol.Inventory{
		Hostname:         hostname,
		MachineID:        machineID(dataDir),
		OS:               osRelease(),
		Kernel:           kernelRelease(),
		Arch:             Arch(),
		CPU:              cpuInfo(),
		MemoryTotalBytes: MemInfo()["MemTotal"],
		Disks:            Disks(),
		Addresses:        addresses(),
		BootTime:         bootTime(),
		Docker:           protocol.DockerInfo{Error: "docker client not initialised"},
		DataDir:          dataDir,
	}
	if dk != nil {
		inv.Docker = dk.Info(ctx)
	}
	return inv
}

func readTrimmed(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// Arch reports the conventional uname -m spelling so it matches release asset names.
func Arch() string {
	switch runtime.GOARCH {
	case "amd64":
		return "x86_64"
	case "arm64":
		return "aarch64"
	default:
		return runtime.GOARCH
	}
}

// machineID is /etc/machine-id, else the D-Bus copy, else an id persisted under the data dir.
func machineID(dataDir string) string {
	for _, p := range []string{"/etc/machine-id", "/var/lib/dbus/machine-id"} {
		if id := readTrimmed(p); id != "" {
			return id
		}
	}
	path := filepath.Join(dataDir, "machine-id")
	if id := readTrimmed(path); id != "" {
		return id
	}
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	id := hex.EncodeToString(b)
	_ = os.MkdirAll(dataDir, 0o755)
	_ = os.WriteFile(path, []byte(id+"\n"), 0o644)
	return id
}

func osRelease() protocol.OSInfo {
	info := protocol.OSInfo{ID: "linux", Name: "Linux"}
	f, err := os.Open("/etc/os-release")
	if err != nil {
		return info
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), "=")
		if !ok {
			continue
		}
		v = strings.Trim(v, `"`)
		switch k {
		case "ID":
			info.ID = v
		case "NAME":
			info.Name = v
		case "VERSION_ID":
			info.Version = v
		case "PRETTY_NAME":
			info.PrettyName = v
		}
	}
	if info.PrettyName == "" {
		info.PrettyName = strings.TrimSpace(info.Name + " " + info.Version)
	}
	return info
}

func kernelRelease() string {
	var u syscall.Utsname
	if err := syscall.Uname(&u); err != nil {
		return ""
	}
	b := make([]byte, 0, len(u.Release))
	for _, c := range u.Release {
		if c == 0 {
			break
		}
		b = append(b, byte(c))
	}
	return string(b)
}

func cpuInfo() protocol.CPUInfo {
	info := protocol.CPUInfo{Threads: runtime.NumCPU()}
	f, err := os.Open("/proc/cpuinfo")
	if err != nil {
		info.Cores = info.Threads
		return info
	}
	defer f.Close()
	cores := map[string]struct{}{}
	sc := bufio.NewScanner(f)
	var physID, coreID string
	flush := func() {
		if physID != "" || coreID != "" {
			cores[physID+"/"+coreID] = struct{}{}
		}
		physID, coreID = "", ""
	}
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), ":")
		if !ok {
			flush()
			continue
		}
		k, v = strings.TrimSpace(k), strings.TrimSpace(v)
		switch k {
		case "model name":
			if info.Model == "" {
				info.Model = v
			}
		case "physical id":
			physID = v
		case "core id":
			coreID = v
		}
	}
	flush()
	if len(cores) > 0 {
		info.Cores = len(cores)
	} else {
		info.Cores = info.Threads
	}
	return info
}

// MemInfo returns the /proc/meminfo table in bytes.
func MemInfo() map[string]uint64 {
	out := map[string]uint64{}
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return out
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), ":")
		if !ok {
			continue
		}
		fields := strings.Fields(v)
		if len(fields) == 0 {
			continue
		}
		n, err := strconv.ParseUint(fields[0], 10, 64)
		if err != nil {
			continue
		}
		if len(fields) > 1 && fields[1] == "kB" {
			n *= 1024
		}
		out[strings.TrimSpace(k)] = n
	}
	return out
}

var physicalFs = map[string]bool{
	"ext2": true, "ext3": true, "ext4": true, "xfs": true, "btrfs": true, "zfs": true, "f2fs": true,
	"vfat": true, "ntfs": true, "ntfs3": true, "fuseblk": true,
}

// Disks lists mounted physical filesystems from /proc/mounts.
func Disks() []protocol.DiskInfo {
	out := []protocol.DiskInfo{}
	f, err := os.Open("/proc/mounts")
	if err != nil {
		return out
	}
	defer f.Close()
	seen := map[string]bool{}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 3 || !physicalFs[fields[2]] || seen[fields[0]] {
			continue
		}
		mount := strings.ReplaceAll(fields[1], `\040`, " ")
		var st syscall.Statfs_t
		if err := syscall.Statfs(mount, &st); err != nil {
			continue
		}
		seen[fields[0]] = true
		out = append(out, protocol.DiskInfo{
			Device:     fields[0],
			Mountpoint: mount,
			Fstype:     fields[2],
			TotalBytes: st.Blocks * uint64(st.Bsize),
		})
	}
	return out
}

// addresses lists global unicast addresses of interfaces that are up (loopback and container
// plumbing left out).
func addresses() []string {
	out := []string{}
	ifaces, err := net.Interfaces()
	if err != nil {
		return out
	}
	for _, it := range ifaces {
		if it.Flags&net.FlagLoopback != 0 || it.Flags&net.FlagUp == 0 || VirtualNIC(it.Name) {
			continue
		}
		addrs, err := it.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			ip, _, err := net.ParseCIDR(a.String())
			if err != nil || !ip.IsGlobalUnicast() {
				continue
			}
			out = append(out, ip.String())
		}
	}
	return out
}

// VirtualNIC reports interfaces left out of the network figures: loopback and container plumbing.
func VirtualNIC(name string) bool {
	return name == "lo" || strings.HasPrefix(name, "veth") || strings.HasPrefix(name, "docker") ||
		strings.HasPrefix(name, "br-") || strings.HasPrefix(name, "virbr")
}

func bootTime() time.Time {
	b, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return time.Now().UTC()
	}
	fields := strings.Fields(string(b))
	if len(fields) == 0 {
		return time.Now().UTC()
	}
	up, _ := strconv.ParseFloat(fields[0], 64)
	return time.Now().Add(-time.Duration(up * float64(time.Second))).UTC().Truncate(time.Second)
}
