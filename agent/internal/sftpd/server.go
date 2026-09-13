// Package sftpd is the agent's SFTP server: one listener per node, every session confined to one
// instance's data directory. The agent decides nothing about who may sign in: it asks the server
// (sftp.auth) on every attempt and reports sessions as they open and close (sftp.session).
package sftpd

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"

	"github.com/ionnet/gsm/agent/internal/protocol"
)

const (
	hostKeyFile      = "sftp_host_ed25519_key"
	handshakeTimeout = 30 * time.Second
	authTimeout      = 10 * time.Second
	closeWait        = 5 * time.Second
	defaultMaxConns  = 100
	defaultMaxPerIP  = 10

	extUser       = "gsm-user"
	extUUID       = "gsm-uuid"
	extCredential = "gsm-credential"
	extMethod     = "gsm-method"
)

// Authenticator asks the server whether a sign-in may proceed. An error means "no".
type Authenticator func(ctx context.Context, p protocol.SFTPAuthParams) (protocol.SFTPAuthResult, error)

type Options struct {
	Auth Authenticator
	// Emit delivers sftp.session events; may be nil.
	Emit func(event string, data any)
	// InstanceDir is the data directory of an instance.
	InstanceDir func(uuid string) string
	// Owner is the uid:gid new files get, and whether to chown at all (only as root).
	Owner func(uuid string) (uid, gid int, chown bool)
	// StateDir holds the host key.
	StateDir string
	Log      *slog.Logger
	MaxConns int
	MaxPerIP int
}

type Server struct {
	opts    Options
	config  *ssh.ServerConfig
	hostKey string

	mu       sync.Mutex
	ln       net.Listener
	addr     string
	port     *int
	lastErr  *string
	sessions map[string]*session
	conns    int
	perIP    map[string]int
	closed   bool
}

type session struct {
	info  protocol.SFTPSessionInfo
	conn  *ssh.ServerConn
	done  chan struct{}
	stats counters
}

type counters struct {
	uploads, downloads, removed, renamed, mkdirs, bytesIn, bytesOut atomic.Int64
}

func (c *counters) snapshot() *protocol.SFTPSessionStats {
	return &protocol.SFTPSessionStats{
		Uploads:   c.uploads.Load(),
		Downloads: c.downloads.Load(),
		Removed:   c.removed.Load(),
		Renamed:   c.renamed.Load(),
		Mkdirs:    c.mkdirs.Load(),
		BytesIn:   c.bytesIn.Load(),
		BytesOut:  c.bytesOut.Load(),
	}
}

// An instance uuid from the server becomes a directory name; never trust it to be one.
var validUUID = regexp.MustCompile(`^[0-9a-fA-F-]{8,64}$`)

var errDenied = errors.New("access denied")

// New loads (or creates) the host key. The listener starts with Configure.
func New(opts Options) (*Server, error) {
	if opts.Log == nil {
		opts.Log = slog.Default()
	}
	if opts.MaxConns <= 0 {
		opts.MaxConns = defaultMaxConns
	}
	if opts.MaxPerIP <= 0 {
		opts.MaxPerIP = defaultMaxPerIP
	}
	signer, err := loadHostKey(opts.StateDir)
	if err != nil {
		return nil, fmt.Errorf("sftp host key: %w", err)
	}
	s := &Server{
		opts:     opts,
		hostKey:  ssh.FingerprintSHA256(signer.PublicKey()),
		sessions: map[string]*session{},
		perIP:    map[string]int{},
	}
	cfg := &ssh.ServerConfig{
		MaxAuthTries:  6,
		ServerVersion: "SSH-2.0-GSM",
		PasswordCallback: func(c ssh.ConnMetadata, pw []byte) (*ssh.Permissions, error) {
			return s.authenticate(c, "password", string(pw), "")
		},
		// Some clients only ever type a password through keyboard-interactive.
		KeyboardInteractiveCallback: func(c ssh.ConnMetadata, challenge ssh.KeyboardInteractiveChallenge) (*ssh.Permissions, error) {
			answers, err := challenge("", "", []string{"Password: "}, []bool{false})
			if err != nil || len(answers) != 1 {
				return nil, errDenied
			}
			return s.authenticate(c, "password", answers[0], "")
		},
		// x/crypto verifies the client's signature before a key sign-in succeeds; this only says
		// whether the key would be accepted.
		PublicKeyCallback: func(c ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			return s.authenticate(c, "publickey", "", strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key))))
		},
	}
	cfg.AddHostKey(signer)
	s.config = cfg
	return s, nil
}

func loadHostKey(dir string) (ssh.Signer, error) {
	p := filepath.Join(dir, hostKeyFile)
	if b, err := os.ReadFile(p); err == nil {
		return ssh.ParsePrivateKey(b)
	} else if !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	block, err := ssh.MarshalPrivateKey(priv, "gsm-agent sftp host key")
	if err != nil {
		return nil, err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, pem.EncodeToMemory(block), 0o600); err != nil {
		return nil, err
	}
	if err := os.Rename(tmp, p); err != nil {
		return nil, err
	}
	return ssh.NewSignerFromKey(priv)
}

// HostKey is the SHA256 fingerprint of the host key, as clients show it.
func (s *Server) HostKey() string {
	if s == nil {
		return ""
	}
	return s.hostKey
}

func (s *Server) authenticate(c ssh.ConnMetadata, method, password, publicKey string) (*ssh.Permissions, error) {
	ip := hostOf(c.RemoteAddr())
	if s.opts.Auth == nil {
		return nil, errDenied
	}
	ctx, cancel := context.WithTimeout(context.Background(), authTimeout)
	defer cancel()
	res, err := s.opts.Auth(ctx, protocol.SFTPAuthParams{
		Username:      c.User(),
		Method:        method,
		Password:      password,
		PublicKey:     publicKey,
		RemoteAddress: ip,
	})
	if err != nil {
		s.opts.Log.Warn("sftp sign-in not checked; refusing", "user", c.User(), "ip", ip, "err", err)
		return nil, errDenied
	}
	if !res.Allowed || res.UserID <= 0 || !validUUID.MatchString(res.UUID) {
		// Clients offer every key they have, so refused keys are routine.
		level := slog.LevelInfo
		if method == "publickey" {
			level = slog.LevelDebug
		}
		s.opts.Log.Log(context.Background(), level, "sftp sign-in refused", "user", c.User(), "ip", ip, "method", method)
		return nil, errDenied
	}
	return &ssh.Permissions{Extensions: map[string]string{
		extUser:       strconv.Itoa(res.UserID),
		extUUID:       res.UUID,
		extCredential: res.Credential,
		extMethod:     method,
	}}, nil
}

// Configure (re)starts the listener on bind:port, or stops it when port is nil. Sessions that are
// already open are left alone. It returns the status after the change.
func (s *Server) Configure(port *int, bind string) protocol.SFTPStatus {
	if s == nil {
		return unavailable()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return s.statusLocked()
	}
	if port == nil {
		if s.ln != nil {
			s.opts.Log.Info("sftp stopped")
		}
		s.stopLocked()
		s.port = nil
		s.lastErr = nil
		return s.statusLocked()
	}
	if bind == "" {
		bind = "0.0.0.0"
	}
	p := *port
	s.port = &p
	addr := net.JoinHostPort(bind, strconv.Itoa(p))
	if s.ln != nil && s.addr == addr {
		return s.statusLocked()
	}
	s.stopLocked()
	s.addr = addr
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		msg := err.Error()
		s.lastErr = &msg
		s.opts.Log.Warn("sftp cannot listen", "addr", addr, "err", err)
		return s.statusLocked()
	}
	s.ln = ln
	s.lastErr = nil
	s.opts.Log.Info("sftp listening", "addr", ln.Addr().String(), "host_key", s.hostKey)
	go s.acceptLoop(ln)
	return s.statusLocked()
}

// Status is the current listener state.
func (s *Server) Status() protocol.SFTPStatus {
	if s == nil {
		return unavailable()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.statusLocked()
}

// Addr is where the listener is, or nil.
func (s *Server) Addr() net.Addr {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ln == nil {
		return nil
	}
	return s.ln.Addr()
}

func unavailable() protocol.SFTPStatus {
	msg := "SFTP is unavailable: the agent could not load its host key"
	return protocol.SFTPStatus{Error: &msg}
}

func (s *Server) statusLocked() protocol.SFTPStatus {
	st := protocol.SFTPStatus{Listening: s.ln != nil, HostKey: s.hostKey, Error: s.lastErr}
	if s.port != nil {
		p := *s.port
		st.Port = &p
	}
	return st
}

func (s *Server) stopLocked() {
	if s.ln != nil {
		_ = s.ln.Close()
		s.ln = nil
	}
	s.addr = ""
}

func (s *Server) acceptLoop(ln net.Listener) {
	for {
		c, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			s.opts.Log.Warn("sftp accept", "err", err)
			time.Sleep(100 * time.Millisecond)
			continue
		}
		go s.handleConn(c)
	}
}

func (s *Server) admit(ip string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.conns >= s.opts.MaxConns || s.perIP[ip] >= s.opts.MaxPerIP {
		return false
	}
	s.conns++
	s.perIP[ip]++
	return true
}

func (s *Server) release(ip string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.conns--
	if s.perIP[ip]--; s.perIP[ip] <= 0 {
		delete(s.perIP, ip)
	}
}

func (s *Server) handleConn(nc net.Conn) {
	ip := hostOf(nc.RemoteAddr())
	if !s.admit(ip) {
		_ = nc.Close()
		s.opts.Log.Warn("sftp connection refused: too many connections", "ip", ip)
		return
	}
	defer s.release(ip)
	_ = nc.SetDeadline(time.Now().Add(handshakeTimeout))
	sconn, chans, reqs, err := ssh.NewServerConn(nc, s.config)
	if err != nil {
		_ = nc.Close()
		s.opts.Log.Debug("sftp handshake failed", "ip", ip, "err", err)
		return
	}
	defer sconn.Close()
	_ = nc.SetDeadline(time.Time{})
	// Global requests (port forwarding and the like) are all refused.
	go ssh.DiscardRequests(reqs)
	sess := s.open(sconn, ip)
	if sess == nil {
		return
	}
	defer s.finish(sess)
	var wg sync.WaitGroup
	for nch := range chans {
		if nch.ChannelType() != "session" {
			_ = nch.Reject(ssh.UnknownChannelType, "only SFTP is available")
			continue
		}
		ch, creqs, err := nch.Accept()
		if err != nil {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			s.serveChannel(sess, ch, creqs)
		}()
	}
	wg.Wait()
}

func (s *Server) open(sconn *ssh.ServerConn, ip string) *session {
	var ext map[string]string
	if sconn.Permissions != nil {
		ext = sconn.Permissions.Extensions
	}
	userID, _ := strconv.Atoi(ext[extUser])
	if userID <= 0 || !validUUID.MatchString(ext[extUUID]) {
		return nil
	}
	sess := &session{
		info: protocol.SFTPSessionInfo{
			ID:            newID(),
			UserID:        userID,
			UUID:          ext[extUUID],
			Method:        ext[extMethod],
			Credential:    ext[extCredential],
			RemoteAddress: ip,
			OpenedAt:      time.Now().UTC(),
		},
		conn: sconn,
		done: make(chan struct{}),
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.sessions[sess.info.ID] = sess
	s.mu.Unlock()
	s.opts.Log.Info("sftp session opened", "id", sess.info.ID, "user", sess.info.UserID, "uuid", sess.info.UUID, "ip", ip, "method", sess.info.Method)
	s.emit(sess, "opened", nil)
	return sess
}

func (s *Server) finish(sess *session) {
	s.mu.Lock()
	delete(s.sessions, sess.info.ID)
	s.mu.Unlock()
	close(sess.done)
	stats := sess.stats.snapshot()
	s.opts.Log.Info("sftp session closed", "id", sess.info.ID, "user", sess.info.UserID, "uuid", sess.info.UUID,
		"uploads", stats.Uploads, "downloads", stats.Downloads, "bytes_in", stats.BytesIn, "bytes_out", stats.BytesOut)
	s.emit(sess, "closed", stats)
}

func (s *Server) emit(sess *session, state string, stats *protocol.SFTPSessionStats) {
	if s.opts.Emit == nil {
		return
	}
	s.opts.Emit("sftp.session", protocol.SFTPSessionEvent{
		ID:            sess.info.ID,
		State:         state,
		UserID:        sess.info.UserID,
		UUID:          sess.info.UUID,
		Method:        sess.info.Method,
		RemoteAddress: sess.info.RemoteAddress,
		Stats:         stats,
	})
}

// serveChannel accepts the "sftp" subsystem once and refuses everything else (shells, commands,
// terminals, environment).
func (s *Server) serveChannel(sess *session, ch ssh.Channel, reqs <-chan *ssh.Request) {
	defer ch.Close()
	started := false
	for req := range reqs {
		ok := false
		if req.Type == "subsystem" && !started {
			var sub struct{ Name string }
			if ssh.Unmarshal(req.Payload, &sub) == nil && sub.Name == "sftp" {
				if err := s.startSFTP(sess, ch); err != nil {
					s.opts.Log.Warn("sftp cannot open the instance directory", "uuid", sess.info.UUID, "err", err)
				} else {
					ok, started = true, true
				}
			}
		}
		if req.WantReply {
			_ = req.Reply(ok, nil)
		}
	}
}

func (s *Server) startSFTP(sess *session, ch ssh.Channel) error {
	root, err := s.openRoot(sess.info.UUID)
	if err != nil {
		return err
	}
	uid, gid, chown := s.owner(sess.info.UUID)
	h := &handler{root: root, stats: &sess.stats, uid: uid, gid: gid, chown: chown}
	rs := sftp.NewRequestServer(ch, sftp.Handlers{FileGet: h, FilePut: h, FileCmd: h, FileList: h})
	go func() {
		if err := rs.Serve(); err != nil {
			s.opts.Log.Debug("sftp channel ended", "id", sess.info.ID, "err", err)
		}
		_ = rs.Close()
		_ = root.Close()
		_ = ch.Close()
	}()
	return nil
}

// openRoot opens the instance directory, creating it (owned by the container user) if the
// instance has never been installed.
func (s *Server) openRoot(uuid string) (*os.Root, error) {
	if s.opts.InstanceDir == nil || !validUUID.MatchString(uuid) {
		return nil, errors.New("no instance directory")
	}
	dir := s.opts.InstanceDir(uuid)
	if _, err := os.Stat(dir); errors.Is(err, fs.ErrNotExist) {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, err
		}
		if uid, gid, chown := s.owner(uuid); chown {
			_ = os.Lchown(dir, uid, gid)
		}
	}
	return os.OpenRoot(dir)
}

func (s *Server) owner(uuid string) (int, int, bool) {
	if s.opts.Owner == nil {
		return os.Getuid(), os.Getgid(), false
	}
	return s.opts.Owner(uuid)
}

// Sessions lists open sessions, only those of userIDs unless it is nil.
func (s *Server) Sessions(userIDs []int) []protocol.SFTPSessionInfo {
	out := []protocol.SFTPSessionInfo{}
	if s == nil {
		return out
	}
	want := map[int]bool{}
	for _, id := range userIDs {
		want[id] = true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, sess := range s.sessions {
		if userIDs == nil || want[sess.info.UserID] {
			out = append(out, sess.info)
		}
	}
	return out
}

// Disconnect closes the sessions with these ids and says how many there were.
func (s *Server) Disconnect(ids []string) int {
	if s == nil {
		return 0
	}
	s.mu.Lock()
	var hit []*session
	for _, id := range ids {
		if sess, ok := s.sessions[id]; ok {
			hit = append(hit, sess)
		}
	}
	s.mu.Unlock()
	for _, sess := range hit {
		_ = sess.conn.Close()
	}
	return len(hit)
}

// CloseInstance ends every session on the instance and waits (briefly) until they are gone, so
// nothing holds its directory open while it is removed.
func (s *Server) CloseInstance(uuid string) {
	if s == nil {
		return
	}
	s.mu.Lock()
	var hit []*session
	for _, sess := range s.sessions {
		if sess.info.UUID == uuid {
			hit = append(hit, sess)
		}
	}
	s.mu.Unlock()
	for _, sess := range hit {
		_ = sess.conn.Close()
	}
	deadline := time.After(closeWait)
	for _, sess := range hit {
		select {
		case <-sess.done:
		case <-deadline:
			return
		}
	}
}

// Close stops the listener and ends every session.
func (s *Server) Close() {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.closed = true
	s.stopLocked()
	var all []*session
	for _, sess := range s.sessions {
		all = append(all, sess)
	}
	s.mu.Unlock()
	for _, sess := range all {
		_ = sess.conn.Close()
	}
}

func hostOf(a net.Addr) string {
	if a == nil {
		return ""
	}
	host, _, err := net.SplitHostPort(a.String())
	if err != nil {
		return a.String()
	}
	return host
}

func newID() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
