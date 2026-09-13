// Package transfer moves file bytes over HTTP to /api/v1/agents/transfers/:token, beside the
// control socket: the agent GETs an upload's bytes from the server and POSTs a download's bytes.
package transfer

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// Client talks to the server's transfer relay with the agent's credentials.
type Client struct {
	Base  string
	Token string
	HTTP  *http.Client
}

// New builds a client for serverURL.
func New(serverURL, token string, insecure bool) *Client {
	httpClient := &http.Client{}
	if insecure {
		httpClient.Transport = &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}
	}
	return &Client{Base: strings.TrimRight(serverURL, "/"), Token: token, HTTP: httpClient}
}

func (c *Client) url(token, suffix string) string {
	return c.Base + "/api/v1/agents/transfers/" + token + suffix
}

func (c *Client) do(req *http.Request) (*http.Response, error) {
	req.Header.Set("Authorization", "Bearer "+c.Token)
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		defer resp.Body.Close()
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		var e struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		msg := strings.TrimSpace(string(body))
		if json.Unmarshal(body, &e) == nil && e.Error.Message != "" {
			msg = e.Error.Message
		}
		return nil, fmt.Errorf("transfer: server returned %d: %s", resp.StatusCode, msg)
	}
	return resp, nil
}

// Get opens the byte stream the server offers under token.
func (c *Client) Get(ctx context.Context, token string) (io.ReadCloser, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.url(token, ""), nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.do(req)
	if err != nil {
		return nil, err
	}
	return resp.Body, nil
}

// Digest asks the server for the SHA-256 of what it sent for token.
func (c *Client) Digest(ctx context.Context, token string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.url(token, "/digest"), nil)
	if err != nil {
		return "", err
	}
	resp, err := c.do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var d struct {
		SHA256 string `json:"sha256"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&d); err != nil {
		return "", fmt.Errorf("transfer digest: %w", err)
	}
	return d.SHA256, nil
}

// Post sends body to the server under token (length -1 for chunked) and returns the SHA-256 the
// server counted.
func (c *Client) Post(ctx context.Context, token string, body io.Reader, length int64) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url(token, ""), body)
	if err != nil {
		return "", err
	}
	req.ContentLength = length
	req.Header.Set("Content-Type", "application/octet-stream")
	resp, err := c.do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var got struct {
		SHA256 string `json:"sha256"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		return "", fmt.Errorf("transfer: %w", err)
	}
	return got.SHA256, nil
}
