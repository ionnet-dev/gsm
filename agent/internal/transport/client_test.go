package transport

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/ionnet/gsm/agent/internal/protocol"
)

// A handler that outlives its connection must not answer on (and so close) the one that replaced it.
func TestLateReplyStaysOnItsConnection(t *testing.T) {
	conns := make(chan *websocket.Conn, 2)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		conns <- c
		<-r.Context().Done()
	}))
	defer srv.Close()

	reconnected := make(chan struct{})
	client := New(Options{URL: "ws" + strings.TrimPrefix(srv.URL, "http")})
	client.Handle("slow", func(ctx context.Context, _ json.RawMessage, st StreamWriter) (any, error) {
		<-ctx.Done()  // its connection went away...
		<-reconnected // ...and another has taken its place
		// Each stale write used to close the socket about half the time; enough of them always did.
		for i := 0; i < 20; i++ {
			_ = st.Send(map[string]string{"late": "chunk"})
		}
		return map[string]string{"late": "result"}, nil
	})
	client.Handle("ping", func(context.Context, json.RawMessage, StreamWriter) (any, error) {
		return map[string]string{"pong": "yes"}, nil
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = client.Run(ctx) }()

	first := <-conns
	write(t, first, protocol.NewRequest("s1", "slow", map[string]any{}))
	time.Sleep(50 * time.Millisecond)
	first.Close(websocket.StatusGoingAway, "restart")

	var second *websocket.Conn
	select {
	case second = <-conns:
	case <-time.After(5 * time.Second):
		t.Fatal("no reconnect")
	}
	time.Sleep(100 * time.Millisecond) // the new connection is in use
	close(reconnected)
	time.Sleep(200 * time.Millisecond) // the slow handler has answered by now
	write(t, second, protocol.NewRequest("p1", "ping", map[string]any{}))
	rctx, rcancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer rcancel()
	for {
		_, data, err := second.Read(rctx)
		if err != nil {
			t.Fatalf("the new connection broke: %v", err)
		}
		var env protocol.Envelope
		_ = json.Unmarshal(data, &env)
		if env.ID == "s1" {
			t.Fatalf("a reply to the old connection's request arrived on the new one: %s", data)
		}
		if env.ID == "p1" && env.T == "res" {
			return
		}
	}
}

func write(t *testing.T, c *websocket.Conn, env protocol.Envelope) {
	t.Helper()
	data, _ := json.Marshal(env)
	if err := c.Write(context.Background(), websocket.MessageText, data); err != nil {
		t.Fatal(err)
	}
}
