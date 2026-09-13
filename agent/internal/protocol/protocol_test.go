package protocol

import (
	"encoding/json"
	"os"
	"testing"
)

func TestHelloFixture(t *testing.T) {
	data, err := os.ReadFile("../../../shared/fixtures/hello.json")
	if err != nil {
		t.Skip("fixture not available:", err)
	}
	var h Hello
	if err := json.Unmarshal(data, &h); err != nil {
		t.Fatal(err)
	}
	if h.ProtocolVersion != Version || h.Inventory.Hostname != "node-1" || !h.Inventory.Docker.Available {
		t.Fatalf("unexpected hello: %+v", h)
	}
	if h.Inventory.DataDir != "/var/lib/gsm" || len(h.Inventory.Disks) != 1 || h.Inventory.BootTime.IsZero() {
		t.Fatalf("unexpected inventory: %+v", h.Inventory)
	}
	out, err := json.Marshal(h)
	if err != nil {
		t.Fatal(err)
	}
	var again Hello
	if err := json.Unmarshal(out, &again); err != nil {
		t.Fatal(err)
	}
	if again.Inventory.Docker.APIVersion != "1.52" {
		t.Fatalf("round trip lost fields: %s", out)
	}
	// The wire form must use the schema's camelCase names.
	for _, key := range []string{`"protocolVersion"`, `"memoryTotalBytes"`, `"apiVersion"`, `"dataDir"`} {
		if !containsKey(out, key) {
			t.Fatalf("missing %s in %s", key, out)
		}
	}
}

func TestInstanceSpecFixture(t *testing.T) {
	data, err := os.ReadFile("../../../shared/fixtures/instance-spec.json")
	if err != nil {
		t.Skip("fixture not available:", err)
	}
	var spec InstanceSpec
	if err := json.Unmarshal(data, &spec); err != nil {
		t.Fatal(err)
	}
	if spec.UUID != "6f1c2a1e-9b7d-4c1a-8a0e-3d2b1c0f9e8d" || spec.Stop.Command == nil || *spec.Stop.Command != "stop" {
		t.Fatalf("unexpected spec: %+v", spec)
	}
	if spec.Console.ReadyPattern == nil || spec.Limits.MemoryMb != 4096 || spec.User.UID != 1500 {
		t.Fatalf("unexpected spec: %+v", spec)
	}
	if len(spec.Ports) != 1 || spec.Ports[0].Host != 30000 || len(spec.Files) != 1 || spec.Files[0].Values["server-port"] != "30000" {
		t.Fatalf("unexpected spec: %+v", spec)
	}
	out, err := json.Marshal(spec)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{`"restartOnCrash"`, `"bindAddress"`, `"readyPattern"`, `"timeoutSeconds"`} {
		if !containsKey(out, key) {
			t.Fatalf("missing %s in %s", key, out)
		}
	}
}

func TestConfigureNullClearsAuth(t *testing.T) {
	var p AgentConfigureParams
	if err := json.Unmarshal([]byte(`{"registryAuth":null}`), &p); err != nil {
		t.Fatal(err)
	}
	if present, auth, err := p.Auth(); !present || auth != nil || err != nil {
		t.Fatalf("null should be present-but-nil: %+v", p)
	}
	var q AgentConfigureParams
	if err := json.Unmarshal([]byte(`{}`), &q); err != nil {
		t.Fatal(err)
	}
	if present, _, _ := q.Auth(); present {
		t.Fatalf("absent should not be present: %+v", q)
	}
	var r AgentConfigureParams
	_ = json.Unmarshal([]byte(`{"registryAuth":{"server":"ghcr.io","username":"u","password":"p"}}`), &r)
	if _, auth, _ := r.Auth(); auth == nil || auth.Username != "u" {
		t.Fatalf("auth not decoded: %+v", r)
	}
}

func containsKey(b []byte, key string) bool {
	return len(b) > 0 && indexOf(string(b), key) >= 0
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
