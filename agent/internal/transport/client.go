// Package transport maintains the agent's WebSocket connection to the server and dispatches RPC.
package transport

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/rand"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/ionnet/gsm/agent/internal/protocol"
)

// StreamWriter lets a handler emit chunks tied to the request before returning its result.
type StreamWriter interface {
	Send(chunk any) error
}

// Handler serves one method. It may stream chunks and must return a JSON-marshalable result or an error.
// Returning a *protocol.RPCError preserves the code; any other error becomes "internal".
type Handler func(ctx context.Context, params json.RawMessage, stream StreamWriter) (any, error)

type Options struct {
	URL                string
	Token              string
	InsecureSkipVerify bool
	// OnConnect runs after each successful connection (used to send hello). Errors close the connection.
	OnConnect func(ctx context.Context, c *Client) error
	// Urgent reports whether work is waiting on the server (runs that went on without a
	// connection); while it does, reconnect attempts are at most urgentBackoff apart.
	Urgent func() bool
	Log    *slog.Logger
}

const (
	maxBackoff    = 60 * time.Second
	urgentBackoff = 5 * time.Second
	// A connection that lasted this long counts as healthy and resets the backoff.
	stableAfter = 30 * time.Second
)

// Client is safe for concurrent use. Run blocks and reconnects forever until ctx is cancelled.
type Client struct {
	opts     Options
	handlers map[string]Handler
	ordered  map[string]bool
	mu       sync.RWMutex

	connMu sync.Mutex
	conn   *websocket.Conn

	pendingMu sync.Mutex
	pending   map[string]chan protocol.Envelope
	nextID    uint64

	inflightMu sync.Mutex
	inflight   map[string]context.CancelFunc
}

func New(opts Options) *Client {
	if opts.Log == nil {
		opts.Log = slog.Default()
	}
	return &Client{
		opts:     opts,
		handlers: map[string]Handler{},
		ordered:  map[string]bool{},
		pending:  map[string]chan protocol.Envelope{},
		inflight: map[string]context.CancelFunc{},
	}
}

// Handle registers a method. Each request runs in its own goroutine.
func (c *Client) Handle(method string, h Handler) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.handlers[method] = h
}

// HandleOrdered registers a method whose requests must be processed strictly in arrival order
// (terminal input, resizes). They share one worker per connection, so keep these handlers fast.
func (c *Client) HandleOrdered(method string, h Handler) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.handlers[method] = h
	c.ordered[method] = true
}

// Run connects with exponential backoff and serves until ctx is done. The backoff starts over after
// a connection that had been up for a while, so a server restart is followed by a quick reconnect.
func (c *Client) Run(ctx context.Context) error {
	backoff := time.Second
	for {
		since, err := c.runOnce(ctx)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if !since.IsZero() && time.Since(since) >= stableAfter {
			backoff = time.Second
		}
		wait := backoff
		var closeErr websocket.CloseError
		if errors.As(err, &closeErr) && closeErr.Code == websocket.StatusPolicyViolation {
			// Server rejected our credentials; back off hard rather than hammering.
			c.opts.Log.Error("server rejected connection", "reason", closeErr.Reason)
			backoff, wait = maxBackoff, maxBackoff
		} else {
			if c.opts.Urgent != nil && wait > urgentBackoff && c.opts.Urgent() {
				wait = urgentBackoff
			}
			if err != nil {
				c.opts.Log.Warn("connection lost", "err", err, "retry_in", wait)
			}
		}
		jitter := time.Duration(rand.Int63n(int64(wait / 4)))
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(wait + jitter):
		}
		if backoff < maxBackoff {
			backoff *= 2
		}
	}
}

// runOnce dials and serves one connection; since is when it was established (zero if it wasn't).
func (c *Client) runOnce(ctx context.Context) (since time.Time, err error) {
	dialCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	httpClient := &http.Client{}
	if c.opts.InsecureSkipVerify {
		httpClient.Transport = &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}
	}
	conn, _, err := websocket.Dial(dialCtx, c.opts.URL, &websocket.DialOptions{
		HTTPClient: httpClient,
		HTTPHeader: http.Header{"Authorization": []string{"Bearer " + c.opts.Token}},
	})
	if err != nil {
		return time.Time{}, fmt.Errorf("dial: %w", err)
	}
	since = time.Now()
	conn.SetReadLimit(16 << 20)
	c.setConn(conn)
	defer func() {
		c.setConn(nil)
		conn.Close(websocket.StatusNormalClosure, "bye")
		c.failPending()
	}()
	c.opts.Log.Info("connected", "url", c.opts.URL)

	connCtx, cancelConn := context.WithCancel(ctx)
	defer cancelConn()

	// Single worker for order-sensitive methods; the socket reader feeds it in wire order.
	orderedQ := make(chan protocol.Envelope, 1024)
	go func() {
		for env := range orderedQ {
			c.serve(connCtx, conn, env)
		}
	}()
	defer close(orderedQ)

	if c.opts.OnConnect != nil {
		if err := c.opts.OnConnect(connCtx, c); err != nil {
			return since, fmt.Errorf("on connect: %w", err)
		}
	}

	for {
		_, data, err := conn.Read(connCtx)
		if err != nil {
			return since, err
		}
		var env protocol.Envelope
		if err := json.Unmarshal(data, &env); err != nil {
			c.opts.Log.Warn("bad envelope", "err", err)
			continue
		}
		switch env.T {
		case "req":
			c.mu.RLock()
			ordered := c.ordered[env.Method]
			c.mu.RUnlock()
			if ordered {
				select {
				case orderedQ <- env:
				default:
					_ = sendOn(connCtx, conn, protocol.NewError(env.ID, protocol.ErrUnavailable, "input queue full"))
				}
			} else {
				go c.serve(connCtx, conn, env)
			}
		case "res":
			c.deliver(env)
		case "stream":
			// Server -> agent streams are not used yet (shell input arrives as requests).
		case "event":
			c.opts.Log.Debug("event from server", "event", env.Event)
		}
	}
}

func (c *Client) setConn(conn *websocket.Conn) {
	c.connMu.Lock()
	defer c.connMu.Unlock()
	c.conn = conn
}

// Send writes one envelope on the current connection. Safe for concurrent use.
func (c *Client) Send(ctx context.Context, env protocol.Envelope) error {
	c.connMu.Lock()
	conn := c.conn
	c.connMu.Unlock()
	if conn == nil {
		return errors.New("not connected")
	}
	return sendOn(ctx, conn, env)
}

// sendOn writes one envelope on conn. A ctx that is already done means the sender's connection is
// gone, so nothing is written. The write itself only has a timeout: the websocket library closes
// the socket when a write's context is cancelled, and a stale context must not take down a
// connection that has since replaced the sender's.
func sendOn(ctx context.Context, conn *websocket.Conn, env protocol.Envelope) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	data, err := json.Marshal(env)
	if err != nil {
		return err
	}
	wctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return conn.Write(wctx, websocket.MessageText, data)
}

// Emit sends a fire-and-forget event.
func (c *Client) Emit(ctx context.Context, event string, data any) error {
	return c.Send(ctx, protocol.NewEvent(event, data))
}

// Request performs an RPC call to the server and waits for its response.
func (c *Client) Request(ctx context.Context, method string, params any, result any) error {
	c.pendingMu.Lock()
	c.nextID++
	id := fmt.Sprintf("a%d", c.nextID)
	ch := make(chan protocol.Envelope, 1)
	c.pending[id] = ch
	c.pendingMu.Unlock()
	defer func() {
		c.pendingMu.Lock()
		delete(c.pending, id)
		c.pendingMu.Unlock()
	}()

	if err := c.Send(ctx, protocol.NewRequest(id, method, params)); err != nil {
		return err
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case res, ok := <-ch:
		if !ok {
			return errors.New("connection closed")
		}
		if res.OK == nil || !*res.OK {
			if res.Error != nil {
				return res.Error
			}
			return errors.New("request failed")
		}
		if result != nil && len(res.Result) > 0 {
			return json.Unmarshal(res.Result, result)
		}
		return nil
	}
}

func (c *Client) deliver(env protocol.Envelope) {
	c.pendingMu.Lock()
	ch := c.pending[env.ID]
	c.pendingMu.Unlock()
	if ch != nil {
		ch <- env
	}
}

func (c *Client) failPending() {
	c.pendingMu.Lock()
	defer c.pendingMu.Unlock()
	for id, ch := range c.pending {
		close(ch)
		delete(c.pending, id)
	}
}

// Cancel aborts an in-flight request handler by its request id.
func (c *Client) Cancel(id string) bool {
	c.inflightMu.Lock()
	defer c.inflightMu.Unlock()
	if cancel, ok := c.inflight[id]; ok {
		cancel()
		return true
	}
	return false
}

// streamWriter sends a request's chunks on the connection the request came in on.
type streamWriter struct {
	conn *websocket.Conn
	ctx  context.Context
	id   string
	seq  int
	mu   sync.Mutex
}

func (s *streamWriter) Send(chunk any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	env := protocol.NewStream(s.id, s.seq, chunk, false)
	s.seq++
	return sendOn(s.ctx, s.conn, env)
}

// serve runs a request's handler and answers on conn, the connection the request came in on; if
// that one has gone by the time the handler returns, the answer is dropped.
func (c *Client) serve(ctx context.Context, conn *websocket.Conn, req protocol.Envelope) {
	c.mu.RLock()
	h := c.handlers[req.Method]
	c.mu.RUnlock()
	if h == nil {
		_ = sendOn(ctx, conn, protocol.NewError(req.ID, protocol.ErrUnknownMethod, "unknown method "+req.Method))
		return
	}

	hctx, cancel := context.WithCancel(ctx)
	c.inflightMu.Lock()
	c.inflight[req.ID] = cancel
	c.inflightMu.Unlock()
	defer func() {
		cancel()
		c.inflightMu.Lock()
		delete(c.inflight, req.ID)
		c.inflightMu.Unlock()
	}()

	sw := &streamWriter{conn: conn, ctx: ctx, id: req.ID}
	result, err := h(hctx, req.Params, sw)
	if sw.seq > 0 {
		// Close the stream before the result so the server sees a well-ordered sequence.
		_ = sendOn(ctx, conn, protocol.NewStream(req.ID, sw.seq, nil, true))
	}
	if err != nil {
		var rpcErr *protocol.RPCError
		if errors.As(err, &rpcErr) {
			_ = sendOn(ctx, conn, protocol.Envelope{T: "res", ID: req.ID, OK: new(bool), Error: rpcErr})
		} else {
			if ctx.Err() == nil {
				c.opts.Log.Error("handler failed", "method", req.Method, "err", err)
			}
			_ = sendOn(ctx, conn, protocol.NewError(req.ID, protocol.ErrInternal, err.Error()))
		}
		return
	}
	if result == nil {
		result = map[string]any{}
	}
	_ = sendOn(ctx, conn, protocol.NewResult(req.ID, result))
}
