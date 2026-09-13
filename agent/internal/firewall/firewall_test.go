package firewall

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os/exec"
	"strings"
	"testing"

	"github.com/ionnet/gsm/agent/internal/protocol"
)

// fakeUFW is an active ufw with a rule table; it records every command.
type fakeUFW struct {
	rules map[string]bool // "30000/tcp"
	cmds  []string
}

func (f *fakeUFW) run(_ context.Context, name string, args ...string) (string, error) {
	f.cmds = append(f.cmds, name+" "+strings.Join(args, " "))
	if name == "firewall-cmd" {
		return "", exec.ErrNotFound
	}
	switch args[0] {
	case "status":
		var b strings.Builder
		b.WriteString("Status: active\n\nTo                         Action      From\n--                         ------      ----\n")
		for r := range f.rules {
			b.WriteString(r + "                  ALLOW       Anywhere\n")
			b.WriteString(r + " (v6)             ALLOW       Anywhere (v6)\n")
		}
		return b.String(), nil
	case "allow":
		f.rules[args[1]] = true
		return "Rule added\nRule added (v6)\n", nil
	case "delete":
		delete(f.rules, args[2])
		return "Rule deleted\n", nil
	}
	return "", errors.New("unexpected")
}

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func ports(specs ...protocol.FirewallPort) []protocol.FirewallPort { return specs }

func TestOpensFollowsAndRemovesOnlyItsOwnRules(t *testing.T) {
	ctx := context.Background()
	ufw := &fakeUFW{rules: map[string]bool{"25565/tcp": true}}
	dir := t.TempDir()
	m := New(dir, ufw.run, quiet())
	m.Configure(ctx, true, nil)
	key := "instance:3f9a2c1b-0000-4000-8000-000000000000"

	res := m.Apply(ctx, key, ports(protocol.FirewallPort{Port: 30000, Protocol: "tcp"}, protocol.FirewallPort{Port: 25565, Protocol: "tcp"}))
	if res.Backend == nil || *res.Backend != UFW {
		t.Fatalf("backend = %v", res.Backend)
	}
	if res.Rules[0].State != "open" || res.Rules[1].State != "existing" {
		t.Fatalf("rules = %+v", res.Rules)
	}
	if !ufw.rules["30000/tcp"] {
		t.Fatal("30000/tcp was not added")
	}
	var added bool
	for _, c := range ufw.cmds {
		if c == "ufw allow 30000/tcp comment gsm "+key {
			added = true
		}
	}
	if !added {
		t.Errorf("expected a commented ufw rule, got %v", ufw.cmds)
	}

	// The port changes: the old rule goes, the new one comes, the pre-existing one stays.
	m.Apply(ctx, key, ports(protocol.FirewallPort{Port: 30100, Protocol: "tcp"}))
	if ufw.rules["30000/tcp"] || !ufw.rules["30100/tcp"] || !ufw.rules["25565/tcp"] {
		t.Fatalf("after the port change: %v", ufw.rules)
	}

	// A restarted agent still knows its rules.
	m2 := New(dir, ufw.run, quiet())
	m2.Remove(ctx, key)
	if ufw.rules["30100/tcp"] || !ufw.rules["25565/tcp"] {
		t.Fatalf("after remove: %v", ufw.rules)
	}
}

func TestNothingOpensWhileUnmanagedButRemovalWorks(t *testing.T) {
	ctx := context.Background()
	ufw := &fakeUFW{rules: map[string]bool{}}
	m := New(t.TempDir(), ufw.run, quiet())
	key := "instance:3f9a2c1b-0000-4000-8000-000000000000"
	res := m.Apply(ctx, key, ports(protocol.FirewallPort{Port: 30000, Protocol: "udp"}))
	if res.Rules[0].State != "error" || !strings.Contains(*res.Rules[0].Error, "off") || len(ufw.rules) != 0 {
		t.Fatalf("unmanaged apply: %+v %v", res.Rules, ufw.rules)
	}

	sftp := 2022
	st := m.Configure(ctx, true, &sftp)
	if len(st.SFTP) != 1 || st.SFTP[0].State != "open" || !ufw.rules["2022/tcp"] {
		t.Fatalf("sftp rule: %+v %v", st.SFTP, ufw.rules)
	}
	m.Apply(ctx, key, ports(protocol.FirewallPort{Port: 30000, Protocol: "udp"}))
	// Turning management off removes everything the agent added.
	st = m.Configure(ctx, false, &sftp)
	if len(ufw.rules) != 0 || st.Managed {
		t.Fatalf("after turning off: %v", ufw.rules)
	}
}

func TestFirewalldAndNoFirewall(t *testing.T) {
	ctx := context.Background()
	open := map[string]bool{}
	firewalld := func(_ context.Context, name string, args ...string) (string, error) {
		if name == "ufw" {
			return "", exec.ErrNotFound
		}
		last := args[len(args)-1]
		switch {
		case last == "--state":
			return "running\n", nil
		case strings.HasPrefix(last, "--query-port="):
			if open[strings.TrimPrefix(last, "--query-port=")] {
				return "yes\n", nil
			}
			return "no\n", errors.New("exit status 1")
		case strings.HasPrefix(last, "--add-port="):
			open[strings.TrimPrefix(last, "--add-port=")] = true
			return "success\n", nil
		case strings.HasPrefix(last, "--remove-port="):
			delete(open, strings.TrimPrefix(last, "--remove-port="))
			return "success\n", nil
		}
		return "", errors.New("unexpected")
	}
	m := New(t.TempDir(), firewalld, quiet())
	p := 2022
	st := m.Configure(ctx, true, &p)
	if st.Backend == nil || *st.Backend != Firewalld || st.SFTP[0].State != "open" || !open["2022/tcp"] {
		t.Fatalf("firewalld: %+v %v", st, open)
	}

	none := func(context.Context, string, ...string) (string, error) { return "", exec.ErrNotFound }
	m = New(t.TempDir(), none, quiet())
	st = m.Configure(ctx, true, &p)
	if st.Backend != nil || st.SFTP[0].State != "error" || !strings.Contains(*st.SFTP[0].Error, "No ufw or firewalld") {
		t.Fatalf("no firewall: %+v", st)
	}
	notRoot := func(context.Context, string, ...string) (string, error) {
		return "ERROR: You need to be root to run this script\n", errors.New("exit status 1")
	}
	st = New(t.TempDir(), notRoot, quiet()).Configure(ctx, true, &p)
	if st.Error == nil || !strings.Contains(*st.Error, "root") {
		t.Fatalf("not root: %+v", st)
	}
}

func TestValidation(t *testing.T) {
	if !ValidInstanceKey("instance:3f9a2c1b-0000-4000-8000-000000000000") || ValidInstanceKey("sftp") || ValidInstanceKey("instance:../x") {
		t.Fatal("ValidInstanceKey")
	}
	if ValidPorts(ports(protocol.FirewallPort{Port: 0, Protocol: "tcp"})) || ValidPorts(ports(protocol.FirewallPort{Port: 22, Protocol: "icmp"})) {
		t.Fatal("ValidPorts")
	}
}
