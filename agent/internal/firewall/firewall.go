// Package firewall opens instance and SFTP ports in the node's firewall (ufw or firewalld) when
// the server asks. It remembers the rules it added (state/firewall.json) and only ever removes
// those; a rule that was already there is reported as "existing" and left alone. While the node
// does not allow firewall management, nothing is opened, but removing the agent's rules still
// works (instance deleted, ports changed, management turned off).
package firewall

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ionnet/gsm/agent/internal/protocol"
)

// Runner runs a command and returns its combined output. Tests replace it.
type Runner func(ctx context.Context, name string, args ...string) (string, error)

// Exec is the real Runner: no shell, a 20 s limit.
func Exec(ctx context.Context, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
	return string(out), err
}

const (
	UFW       = "ufw"
	Firewalld = "firewalld"
	// SFTPKey is the key of the node's SFTP rule.
	SFTPKey = "sftp"
)

var keyRE = regexp.MustCompile(`^instance:[0-9a-fA-F-]{8,64}$`)

// ValidInstanceKey reports whether key names an instance's rules ("instance:<uuid>").
func ValidInstanceKey(key string) bool { return keyRE.MatchString(key) }

// ValidPorts checks ports sent by the server.
func ValidPorts(ports []protocol.FirewallPort) bool {
	if len(ports) > 32 {
		return false
	}
	for _, p := range ports {
		if p.Port < 1 || p.Port > 65535 || (p.Protocol != "tcp" && p.Protocol != "udp") {
			return false
		}
	}
	return true
}

type rule struct {
	Port     int    `json:"port"`
	Protocol string `json:"protocol"`
	Backend  string `json:"backend"`
	// Existing rules were there before the agent looked; they are never removed.
	Existing bool `json:"existing"`
}

// Manager keeps the agent's rules per key.
type Manager struct {
	mu      sync.Mutex
	path    string
	run     Runner
	log     *slog.Logger
	managed bool
	rules   map[string][]rule
}

// New loads the rules the agent added before a restart.
func New(stateDir string, run Runner, log *slog.Logger) *Manager {
	m := &Manager{path: filepath.Join(stateDir, "firewall.json"), run: run, log: log, rules: map[string][]rule{}}
	if data, err := os.ReadFile(m.path); err == nil {
		if err := json.Unmarshal(data, &m.rules); err != nil {
			log.Warn("firewall state unreadable; starting empty", "err", err)
			m.rules = map[string][]rule{}
		}
	}
	return m
}

func (m *Manager) save() {
	data, _ := json.MarshalIndent(m.rules, "", "  ")
	tmp := m.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		m.log.Warn("saving firewall state", "err", err)
		return
	}
	_ = os.Rename(tmp, m.path)
}

// detect returns the active firewall ("" when none) and an error when a firewall tool exists but
// could not be asked (not root, …).
func (m *Manager) detect(ctx context.Context) (string, error) {
	var problems []string
	out, err := m.run(ctx, "ufw", "status")
	if err == nil && strings.Contains(out, "Status: active") {
		return UFW, nil
	}
	if err != nil && !errors.Is(err, exec.ErrNotFound) {
		problems = append(problems, "ufw: "+firstLine(out, err))
	}
	out, err = m.run(ctx, "firewall-cmd", "--state")
	if strings.TrimSpace(out) == "running" {
		return Firewalld, nil
	}
	if err != nil && !errors.Is(err, exec.ErrNotFound) && !strings.Contains(out, "not running") {
		problems = append(problems, "firewalld: "+firstLine(out, err))
	}
	if len(problems) > 0 {
		return "", errors.New(strings.Join(problems, "; "))
	}
	return "", nil
}

func firstLine(out string, err error) string {
	if s := strings.TrimSpace(out); s != "" {
		return strings.SplitN(s, "\n", 2)[0]
	}
	return err.Error()
}

func spec(port int, proto string) string { return fmt.Sprintf("%d/%s", port, proto) }

// ufwAllowRE matches "30000/tcp", "30000", "30000:30999/tcp" rules allowing from anywhere.
var ufwAllowRE = regexp.MustCompile(`(?m)^(\d+)(?::(\d+))?(?:/(tcp|udp))?(?:\s+\(v6\))?\s+ALLOW(?:\s+IN)?\s+Anywhere`)

func (m *Manager) exists(ctx context.Context, backend string, port int, proto string) (bool, error) {
	switch backend {
	case UFW:
		out, err := m.run(ctx, "ufw", "status")
		if err != nil {
			return false, errors.New(firstLine(out, err))
		}
		for _, g := range ufwAllowRE.FindAllStringSubmatch(out, -1) {
			lo, _ := strconv.Atoi(g[1])
			hi := lo
			if g[2] != "" {
				hi, _ = strconv.Atoi(g[2])
			}
			if port >= lo && port <= hi && (g[3] == "" || g[3] == proto) {
				return true, nil
			}
		}
		return false, nil
	case Firewalld:
		for _, args := range [][]string{
			{"--query-port=" + spec(port, proto)},
			{"--permanent", "--query-port=" + spec(port, proto)},
		} {
			if out, _ := m.run(ctx, "firewall-cmd", args...); strings.TrimSpace(out) == "yes" {
				return true, nil
			}
		}
		return false, nil
	}
	return false, fmt.Errorf("unknown firewall %q", backend)
}

func (m *Manager) open(ctx context.Context, backend, key string, port int, proto string) error {
	switch backend {
	case UFW:
		if out, err := m.run(ctx, "ufw", "allow", spec(port, proto), "comment", "gsm "+key); err != nil {
			return errors.New(firstLine(out, err))
		}
		return nil
	case Firewalld:
		for _, args := range [][]string{
			{"--permanent", "--add-port=" + spec(port, proto)},
			{"--add-port=" + spec(port, proto)},
		} {
			if out, err := m.run(ctx, "firewall-cmd", args...); err != nil {
				return errors.New(firstLine(out, err))
			}
		}
		return nil
	}
	return fmt.Errorf("unknown firewall %q", backend)
}

func (m *Manager) close(ctx context.Context, r rule) error {
	switch r.Backend {
	case UFW:
		if out, err := m.run(ctx, "ufw", "delete", "allow", spec(r.Port, r.Protocol)); err != nil {
			return errors.New(firstLine(out, err))
		}
		return nil
	case Firewalld:
		var errs []string
		for _, args := range [][]string{
			{"--permanent", "--remove-port=" + spec(r.Port, r.Protocol)},
			{"--remove-port=" + spec(r.Port, r.Protocol)},
		} {
			if out, err := m.run(ctx, "firewall-cmd", args...); err != nil {
				errs = append(errs, firstLine(out, err))
			}
		}
		if len(errs) > 0 {
			return errors.New(strings.Join(errs, "; "))
		}
		return nil
	}
	return fmt.Errorf("unknown firewall %q", r.Backend)
}

func ruleState(r rule) protocol.FirewallRule {
	state := "open"
	if r.Existing {
		state = "existing"
	}
	return protocol.FirewallRule{Port: r.Port, Protocol: r.Protocol, State: state}
}

func failed(p protocol.FirewallPort, msg string) protocol.FirewallRule {
	return protocol.FirewallRule{Port: p.Port, Protocol: p.Protocol, State: "error", Error: &msg}
}

func optional(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// Apply makes the agent's rules for key exactly ports: rules it added that are no longer wanted
// are removed, wanted ones are added (only while management is allowed).
func (m *Manager) Apply(ctx context.Context, key string, ports []protocol.FirewallPort) protocol.FirewallApplyResult {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.apply(ctx, key, ports)
}

func (m *Manager) apply(ctx context.Context, key string, ports []protocol.FirewallPort) protocol.FirewallApplyResult {
	wanted := func(r rule) bool {
		for _, p := range ports {
			if p.Port == r.Port && p.Protocol == r.Protocol {
				return true
			}
		}
		return false
	}
	var keep []rule
	for _, r := range m.rules[key] {
		if wanted(r) || r.Existing {
			if wanted(r) {
				keep = append(keep, r)
			}
			continue
		}
		if err := m.close(ctx, r); err != nil {
			m.log.Warn("removing firewall rule", "key", key, "port", spec(r.Port, r.Protocol), "err", err)
			keep = append(keep, r) // try again next time
			continue
		}
		m.log.Info("firewall rule removed", "key", key, "port", spec(r.Port, r.Protocol), "firewall", r.Backend)
	}

	result := protocol.FirewallApplyResult{Rules: []protocol.FirewallRule{}}
	var backend string
	var detectErr error
	if len(ports) > 0 {
		backend, detectErr = m.detect(ctx)
		result.Backend = optional(backend)
	}
	for _, p := range ports {
		if i := indexOf(keep, p); i >= 0 {
			result.Rules = append(result.Rules, ruleState(keep[i]))
			continue
		}
		switch {
		case !m.managed:
			result.Rules = append(result.Rules, failed(p, "Firewall management is off on this node"))
			continue
		case backend == "" && detectErr != nil:
			result.Rules = append(result.Rules, failed(p, detectErr.Error()))
			continue
		case backend == "":
			result.Rules = append(result.Rules, failed(p, "No ufw or firewalld is active on this node"))
			continue
		}
		exists, err := m.exists(ctx, backend, p.Port, p.Protocol)
		if err != nil {
			result.Rules = append(result.Rules, failed(p, err.Error()))
			continue
		}
		r := rule{Port: p.Port, Protocol: p.Protocol, Backend: backend, Existing: exists}
		if !exists {
			if err := m.open(ctx, backend, key, p.Port, p.Protocol); err != nil {
				result.Rules = append(result.Rules, failed(p, err.Error()))
				continue
			}
			m.log.Info("firewall rule added", "key", key, "port", spec(p.Port, p.Protocol), "firewall", backend)
		}
		keep = append(keep, r)
		result.Rules = append(result.Rules, ruleState(r))
	}
	if len(keep) == 0 {
		delete(m.rules, key)
	} else {
		m.rules[key] = keep
	}
	m.save()
	return result
}

func indexOf(rules []rule, p protocol.FirewallPort) int {
	for i, r := range rules {
		if r.Port == p.Port && r.Protocol == p.Protocol {
			return i
		}
	}
	return -1
}

// Remove drops every rule the agent added for key (allowed even while management is off).
func (m *Manager) Remove(ctx context.Context, key string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.rules[key]; ok {
		m.apply(ctx, key, nil)
	}
}

// Configure sets whether management is allowed. Turned off, every rule the agent added goes;
// turned on, the SFTP port's rule follows sftpPort (nil: SFTP off, no rule).
func (m *Manager) Configure(ctx context.Context, managed bool, sftpPort *int) protocol.FirewallStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.managed = managed
	status := protocol.FirewallStatus{Managed: managed, SFTP: []protocol.FirewallRule{}}
	if !managed {
		for key := range m.rules {
			m.apply(ctx, key, nil)
		}
	} else {
		var ports []protocol.FirewallPort
		if sftpPort != nil {
			ports = []protocol.FirewallPort{{Port: *sftpPort, Protocol: "tcp"}}
		}
		status.SFTP = m.apply(ctx, SFTPKey, ports).Rules
	}
	backend, err := m.detect(ctx)
	status.Backend = optional(backend)
	if err != nil && backend == "" {
		msg := err.Error()
		status.Error = &msg
	}
	return status
}
