// Package netprobe serves net.probe: listen briefly on some ports and report which of them a
// one-time token reached. The server sends the token to the node's public address, so a port that
// receives it is reachable from outside. It only runs while the instance using the ports is
// stopped (otherwise the ports are taken and reported as not bound).
package netprobe

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ionnet/gsm/agent/internal/protocol"
)

const (
	minTimeout  = time.Second
	maxTimeout  = 15 * time.Second
	readTimeout = 3 * time.Second
	// Reply is sent back to whoever delivered the token.
	Reply = "GSM-PROBE-OK"
)

// Run opens every listener on the bind address, calls ready once they are open, and returns when
// each open listener has received the token, the timeout passed or ctx ended.
func Run(ctx context.Context, p protocol.ProbeParams, ready func(protocol.ProbeState)) protocol.ProbeState {
	timeout := time.Duration(p.TimeoutMs) * time.Millisecond
	timeout = max(minTimeout, min(maxTimeout, timeout))
	want := protocol.ProbePrefix + p.Token
	bind := p.BindAddress
	if bind == "" {
		bind = "0.0.0.0"
	}

	states := make([]protocol.ProbeListenerState, len(p.Listeners))
	arrived := make(chan int, len(p.Listeners))
	onces := make([]sync.Once, len(p.Listeners))
	var closers []io.Closer
	defer func() {
		for _, c := range closers {
			_ = c.Close()
		}
	}()

	open := 0
	for i, l := range p.Listeners {
		states[i] = protocol.ProbeListenerState{Port: l.Port, Protocol: l.Protocol}
		got := func() { onces[i].Do(func() { arrived <- i }) }
		addr := net.JoinHostPort(bind, strconv.Itoa(l.Port))
		var err error
		switch l.Protocol {
		case "tcp":
			var ln net.Listener
			if ln, err = net.Listen("tcp", addr); err == nil {
				closers = append(closers, ln)
				go serveTCP(ln, want, got)
			}
		case "udp":
			var pc net.PacketConn
			if pc, err = net.ListenPacket("udp", addr); err == nil {
				closers = append(closers, pc)
				go serveUDP(pc, want, got)
			}
		default:
			err = fmt.Errorf("unknown protocol %q", l.Protocol)
		}
		if err != nil {
			msg := err.Error()
			states[i].Error = &msg
			continue
		}
		states[i].Bound = true
		open++
	}
	ready(protocol.ProbeState{Listeners: append([]protocol.ProbeListenerState(nil), states...)})

	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for open > 0 {
		select {
		case i := <-arrived:
			states[i].Received = true
			open--
		case <-timer.C:
			return protocol.ProbeState{Listeners: states}
		case <-ctx.Done():
			return protocol.ProbeState{Listeners: states}
		}
	}
	return protocol.ProbeState{Listeners: states}
}

func serveTCP(ln net.Listener, want string, got func()) {
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		go func() {
			defer c.Close()
			_ = c.SetDeadline(time.Now().Add(readTimeout))
			line, _ := bufio.NewReader(io.LimitReader(c, 256)).ReadString('\n')
			if strings.TrimSpace(line) == want {
				_, _ = c.Write([]byte(Reply + "\n"))
				got()
			}
		}()
	}
}

func serveUDP(pc net.PacketConn, want string, got func()) {
	buf := make([]byte, 512)
	for {
		n, addr, err := pc.ReadFrom(buf)
		if err != nil {
			return
		}
		if strings.TrimSpace(string(buf[:n])) == want {
			_, _ = pc.WriteTo([]byte(Reply), addr)
			got()
		}
	}
}
