package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/ionnet/gsm/agent/internal/config"
	"github.com/ionnet/gsm/agent/internal/docker"
	"github.com/ionnet/gsm/agent/internal/inventory"
)

type enrollRequest struct {
	Token        string `json:"token"`
	Name         string `json:"name,omitempty"`
	AgentVersion string `json:"agentVersion"`
	Inventory    any    `json:"inventory"`
}

type enrollResponse struct {
	AgentToken string `json:"agentToken"`
	NodeID     int64  `json:"nodeId"`
	Name       string `json:"name"`
}

// enroll exchanges an enrollment token for a per-agent token and writes config + credentials.
func enroll(args []string) int {
	fs := flag.NewFlagSet("enroll", flag.ExitOnError)
	cfgPath := fs.String("config", config.DefaultConfigPath, "path to config.yaml")
	server := fs.String("server", "", "GSM server URL, e.g. https://gsm.example.com")
	token := fs.String("token", "", "enrollment token from the GSM UI")
	name := fs.String("name", "", "display name (defaults to hostname)")
	dataDir := fs.String("data-dir", "", "where instance data lives (default "+config.DefaultDataDir+")")
	insecure := fs.Bool("insecure", false, "skip TLS verification (development only)")
	_ = fs.Parse(args)
	if *server == "" || *token == "" {
		fmt.Fprintln(os.Stderr, "enroll: -server and -token are required")
		return 2
	}
	cfg, err := config.Load(*cfgPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	cfg.ServerURL = *server
	cfg.InsecureSkipVerify = *insecure
	if *dataDir != "" {
		cfg.DataDir = *dataDir
	}
	if err := cfg.EnsureDataDir(); err != nil {
		fmt.Fprintln(os.Stderr, "data directory:", err)
		return 1
	}
	agentToken, err := doEnroll(cfg, *token, *name)
	if err != nil {
		fmt.Fprintln(os.Stderr, "enroll failed:", err)
		return 1
	}
	if err := cfg.SaveToken(agentToken); err != nil {
		fmt.Fprintln(os.Stderr, "write credentials:", err)
		return 1
	}
	if err := cfg.Save(*cfgPath); err != nil {
		fmt.Fprintln(os.Stderr, "write config:", err)
		return 1
	}
	fmt.Printf("enrolled with %s; credentials written to %s\n", cfg.ServerURL, cfg.CredentialsFile)
	return 0
}

// doEnroll POSTs /api/v1/agents/enroll and returns the per-agent token.
func doEnroll(cfg config.Config, enrollmentToken, name string) (string, error) {
	var src inventory.DockerInfoSource
	if dk, err := docker.New(); err == nil {
		src = dk
	}
	inv := inventory.Collect(context.Background(), cfg.DataDir, src)
	if !inv.Docker.Available {
		fmt.Fprintf(os.Stderr, "warning: docker is not reachable (%s); instances cannot run until it is\n", inv.Docker.Error)
	}
	if name == "" {
		name, _ = os.Hostname()
	}
	body, _ := json.Marshal(enrollRequest{Token: enrollmentToken, Name: name, AgentVersion: version, Inventory: inv})

	client := &http.Client{Timeout: 30 * time.Second}
	if cfg.InsecureSkipVerify {
		client.Transport = &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}
	}
	resp, err := client.Post(cfg.ServerURL+"/api/v1/agents/enroll", "application/json", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		var apiErr struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.Unmarshal(data, &apiErr)
		if apiErr.Error.Message != "" {
			return "", fmt.Errorf("%s (%d)", apiErr.Error.Message, resp.StatusCode)
		}
		return "", fmt.Errorf("server returned %d", resp.StatusCode)
	}
	var out enrollResponse
	if err := json.Unmarshal(data, &out); err != nil {
		return "", fmt.Errorf("bad response: %w", err)
	}
	if out.AgentToken == "" {
		return "", fmt.Errorf("server returned no token")
	}
	fmt.Printf("registered as node #%d (%s)\n", out.NodeID, out.Name)
	return out.AgentToken, nil
}
