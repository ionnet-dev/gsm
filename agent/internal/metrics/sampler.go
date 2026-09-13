// Package metrics samples live node resource usage from /proc and /sys.
package metrics

import (
	"bufio"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/ionnet/gsm/agent/internal/inventory"
	"github.com/ionnet/gsm/agent/internal/protocol"
)

type cpuTimes struct{ idle, total uint64 }
type netTotals struct{ rx, tx uint64 }

// DataUsageRefresh is how often the data directory is measured.
const DataUsageRefresh = 5 * time.Minute

// Sampler keeps the previous CPU and network counters so it can report rates.
type Sampler struct {
	dataDir string
	prevCPU cpuTimes
	prevNet map[string]netTotals
	prevAt  time.Time

	mu         sync.Mutex
	dataUsed   uint64
	dataUsedAt time.Time
	measuring  bool
}

func NewSampler(dataDir string) *Sampler {
	s := &Sampler{dataDir: dataDir}
	s.prevCPU = readCPU()
	s.prevNet = readNet()
	s.prevAt = time.Now()
	return s
}

// Sample produces one Metrics snapshot. Call it on a steady interval for meaningful rates.
func (s *Sampler) Sample() protocol.Metrics {
	now := time.Now()
	elapsed := now.Sub(s.prevAt).Seconds()
	if elapsed <= 0 {
		elapsed = 1
	}
	cpu := readCPU()
	var cpuPct float64
	if dt := cpu.total - s.prevCPU.total; dt > 0 {
		cpuPct = 100 * (1 - float64(delta(cpu.idle, s.prevCPU.idle))/float64(dt))
	}
	s.prevCPU = cpu

	nets := readNet()
	rates := netRates(s.prevNet, nets, elapsed)
	s.prevNet = nets
	s.prevAt = now

	mem := inventory.MemInfo()
	memTotal := mem["MemTotal"]
	memAvail := mem["MemAvailable"]
	if memAvail == 0 {
		memAvail = mem["MemFree"] + mem["Buffers"] + mem["Cached"]
	}
	swapTotal, swapFree := mem["SwapTotal"], mem["SwapFree"]

	return protocol.Metrics{
		At:             now.UTC(),
		CPUPct:         clamp(cpuPct, 0, 100),
		MemUsedBytes:   delta(memTotal, memAvail),
		MemTotalBytes:  memTotal,
		SwapUsedBytes:  delta(swapTotal, swapFree),
		SwapTotalBytes: swapTotal,
		Load:           loadAvg(),
		Disks:          diskUsage(inventory.Disks()),
		Net:            rates,
		UptimeSeconds:  uptime(),
		DataUsedBytes:  s.dataUsedBytes(),
	}
}

// dataUsedBytes returns the cached size of the data directory, refreshing it in the background.
func (s *Sampler) dataUsedBytes() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	if time.Since(s.dataUsedAt) > DataUsageRefresh && !s.measuring {
		s.measuring = true
		go func() {
			size := DirSize(s.dataDir)
			s.mu.Lock()
			s.dataUsed, s.dataUsedAt, s.measuring = size, time.Now(), false
			s.mu.Unlock()
		}()
	}
	return s.dataUsed
}

// DirSize adds up the apparent size of regular files under dir (symlinks not followed).
func DirSize(dir string) uint64 {
	var total uint64
	_ = filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
		if err != nil || d == nil || !d.Type().IsRegular() {
			return nil
		}
		if info, err := d.Info(); err == nil {
			total += uint64(info.Size())
		}
		return nil
	})
	return total
}

// delta is cur-prev for a counter, or 0 when it went backwards (interface reset, wrap).
func delta(cur, prev uint64) uint64 {
	if cur < prev {
		return 0
	}
	return cur - prev
}

func clamp(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// netRates adds up the per-interface byte deltas into rates.
func netRates(prev, cur map[string]netTotals, secs float64) protocol.NetRates {
	var r protocol.NetRates
	for name, c := range cur {
		if p, ok := prev[name]; ok {
			r.RxBytesPerSec += float64(delta(c.rx, p.rx)) / secs
			r.TxBytesPerSec += float64(delta(c.tx, p.tx)) / secs
		}
	}
	return r
}

// parseNetDev reads /proc/net/dev into per-interface byte counters.
func parseNetDev(s string) map[string]netTotals {
	out := map[string]netTotals{}
	for _, line := range strings.Split(s, "\n") {
		name, rest, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		name = strings.TrimSpace(name)
		fields := strings.Fields(rest)
		if inventory.VirtualNIC(name) || len(fields) < 9 {
			continue
		}
		rx, _ := strconv.ParseUint(fields[0], 10, 64)
		tx, _ := strconv.ParseUint(fields[8], 10, 64)
		out[name] = netTotals{rx, tx}
	}
	return out
}

func readNet() map[string]netTotals {
	b, err := os.ReadFile("/proc/net/dev")
	if err != nil {
		return map[string]netTotals{}
	}
	return parseNetDev(string(b))
}

func diskUsage(mounts []protocol.DiskInfo) []protocol.DiskUsage {
	disks := []protocol.DiskUsage{}
	for _, d := range mounts {
		var st syscall.Statfs_t
		if err := syscall.Statfs(d.Mountpoint, &st); err != nil {
			continue
		}
		total := st.Blocks * uint64(st.Bsize)
		free := st.Bavail * uint64(st.Bsize)
		disks = append(disks, protocol.DiskUsage{Mountpoint: d.Mountpoint, UsedBytes: delta(total, free), TotalBytes: total})
	}
	return disks
}

func readCPU() cpuTimes {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return cpuTimes{}
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 8 || fields[0] != "cpu" {
			continue
		}
		var t cpuTimes
		for i, fv := range fields[1:] {
			n, _ := strconv.ParseUint(fv, 10, 64)
			t.total += n
			if i == 3 || i == 4 { // idle, iowait
				t.idle += n
			}
		}
		return t
	}
	return cpuTimes{}
}

func loadAvg() [3]float64 {
	var out [3]float64
	b, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return out
	}
	fields := strings.Fields(string(b))
	for i := 0; i < 3 && i < len(fields); i++ {
		out[i], _ = strconv.ParseFloat(fields[i], 64)
	}
	return out
}

func uptime() uint64 {
	b, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return 0
	}
	fields := strings.Fields(string(b))
	if len(fields) == 0 {
		return 0
	}
	f, _ := strconv.ParseFloat(fields[0], 64)
	return uint64(f)
}
