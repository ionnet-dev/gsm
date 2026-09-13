package metrics

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseNetDevSkipsVirtualInterfaces(t *testing.T) {
	s := `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0
enp5s0: 5000 40 0 0 0 0 0 0 7000 30 0 0 0 0 0 0
docker0: 1 1 0 0 0 0 0 0 1 1 0 0 0 0 0 0
vethab12: 1 1 0 0 0 0 0 0 1 1 0 0 0 0 0 0`
	got := parseNetDev(s)
	if len(got) != 1 || got["enp5s0"] != (netTotals{5000, 7000}) {
		t.Fatalf("got %+v", got)
	}
	r := netRates(map[string]netTotals{"enp5s0": {2000, 1000}}, got, 30)
	if r.RxBytesPerSec != 100 || r.TxBytesPerSec != 200 {
		t.Fatalf("got %+v", r)
	}
}

func TestDirSize(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a"), make([]byte, 100), 0o644)
	os.MkdirAll(filepath.Join(dir, "sub"), 0o755)
	os.WriteFile(filepath.Join(dir, "sub", "b"), make([]byte, 50), 0o644)
	if got := DirSize(dir); got != 150 {
		t.Fatalf("got %d", got)
	}
}
