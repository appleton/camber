package mcpservers

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"time"
)

const probeTimeout = 30 * time.Second

// ProbeResult holds the result of a transient MCP connection test.
type ProbeResult struct {
	OK        bool
	ToolCount int
	ToolNames []string
	Error     string
	ProbeAt   time.Time
}

// ProbeServer opens a transient MCP connection to the named server,
// runs initialize + tools/list, records the result, and closes.
// The entry's env/headers/bearer are used; bearerToken overrides bearer for OAuth.
func ProbeServer(ctx context.Context, entry mcpProbeEntry) ProbeResult {
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()

	if entry.Command != "" {
		return probeStdio(ctx, entry)
	}
	if entry.URL != "" {
		return probeHTTP(ctx, entry)
	}
	return ProbeResult{Error: "server has neither command nor url"}
}

type mcpProbeEntry struct {
	Name        string
	Command     string
	Args        []string
	Env         map[string]string
	URL         string
	Headers     map[string]string
	BearerToken string
}

// --- JSON-RPC primitives ---

type jsonrpcRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int    `json:"id,omitempty"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

type jsonrpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      int             `json:"id,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

type toolsListResult struct {
	Tools []struct {
		Name string `json:"name"`
	} `json:"tools"`
}

var idGen atomic.Int64

func nextID() int {
	return int(idGen.Add(1))
}

func marshalNotification(method string, params any) ([]byte, error) {
	req := jsonrpcRequest{
		JSONRPC: "2.0",
		Method:  method,
		Params:  params,
	}
	return json.Marshal(req)
}

// initializeParams is the payload for initialize.
var initializeParams = map[string]any{
	"protocolVersion": "2024-11-05",
	"capabilities":    map[string]any{},
	"clientInfo": map[string]any{
		"name":    "camber-helper",
		"version": "probe",
	},
}

// --- Stdio probe ---

func probeStdio(ctx context.Context, entry mcpProbeEntry) ProbeResult {
	env := os.Environ()
	for k, v := range entry.Env {
		env = append(env, k+"="+v)
	}

	args := entry.Args
	if args == nil {
		args = []string{}
	}
	cmd := exec.CommandContext(ctx, entry.Command, args...)
	cmd.Env = env

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return ProbeResult{Error: fmt.Sprintf("stdin pipe: %v", err)}
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return ProbeResult{Error: fmt.Sprintf("stdout pipe: %v", err)}
	}
	// Discard stderr to avoid blocking.
	cmd.Stderr = io.Discard

	if err := cmd.Start(); err != nil {
		return ProbeResult{Error: fmt.Sprintf("start: %v", err)}
	}
	defer func() {
		_ = stdin.Close()
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
		}
	}()

	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), 1*1024*1024)

	sendLine := func(data []byte) error {
		_, err := fmt.Fprintf(stdin, "%s\n", data)
		return err
	}
	readLine := func() (json.RawMessage, error) {
		if !scanner.Scan() {
			if err := scanner.Err(); err != nil {
				return nil, err
			}
			return nil, io.EOF
		}
		return json.RawMessage(scanner.Text()), nil
	}
	skipNotifications := func(expectedID int) (*jsonrpcResponse, error) {
		for {
			line, err := readLine()
			if err != nil {
				return nil, err
			}
			var resp jsonrpcResponse
			if err := json.Unmarshal(line, &resp); err != nil {
				continue // skip malformed lines
			}
			if resp.ID == 0 {
				continue // notification, skip
			}
			if resp.ID != expectedID {
				continue
			}
			return &resp, nil
		}
	}

	// initialize
	initID := nextID()
	initReq, _ := json.Marshal(jsonrpcRequest{JSONRPC: "2.0", ID: initID, Method: "initialize", Params: initializeParams})
	if err := sendLine(initReq); err != nil {
		return ProbeResult{Error: "send initialize: " + err.Error()}
	}
	initResp, err := skipNotifications(initID)
	if err != nil {
		return ProbeResult{Error: "read initialize: " + err.Error()}
	}
	if initResp.Error != nil {
		return ProbeResult{Error: fmt.Sprintf("initialize error %d: %s", initResp.Error.Code, initResp.Error.Message)}
	}

	// notifications/initialized (required by spec before any further requests)
	notif, _ := marshalNotification("notifications/initialized", map[string]any{})
	_ = sendLine(notif)

	// tools/list
	toolsID := nextID()
	toolsReq, _ := json.Marshal(jsonrpcRequest{JSONRPC: "2.0", ID: toolsID, Method: "tools/list", Params: map[string]any{}})
	if err := sendLine(toolsReq); err != nil {
		// tools/list is optional — server might not support it
		return ProbeResult{OK: true, ProbeAt: time.Now()}
	}
	toolsResp, err := skipNotifications(toolsID)
	if err != nil {
		return ProbeResult{OK: true, ProbeAt: time.Now()}
	}
	if toolsResp.Error != nil {
		return ProbeResult{OK: true, ProbeAt: time.Now()}
	}

	var toolsResult toolsListResult
	if err := json.Unmarshal(toolsResp.Result, &toolsResult); err == nil {
		names := make([]string, 0, len(toolsResult.Tools))
		for _, t := range toolsResult.Tools {
			names = append(names, t.Name)
		}
		return ProbeResult{OK: true, ToolCount: len(names), ToolNames: names, ProbeAt: time.Now()}
	}
	return ProbeResult{OK: true, ProbeAt: time.Now()}
}

// --- HTTP probe (Streamable HTTP, MCP 2024-11-05+) ---

func probeHTTP(ctx context.Context, entry mcpProbeEntry) ProbeResult {
	// initialize
	initID := nextID()
	initReq, _ := json.Marshal(jsonrpcRequest{JSONRPC: "2.0", ID: initID, Method: "initialize", Params: initializeParams})
	initResp, sessionID, err := httpMCPRequest(ctx, entry, "", initReq, initID)
	if err != nil {
		return ProbeResult{Error: "connect: " + err.Error()}
	}
	if initResp != nil && initResp.Error != nil {
		return ProbeResult{Error: fmt.Sprintf("initialize error %d: %s", initResp.Error.Code, initResp.Error.Message)}
	}
	if initResp == nil || len(initResp.Result) == 0 {
		// A real MCP server answers initialize with a result; anything else (a
		// plain 200, a non-JSON body, an empty result) is not an MCP endpoint.
		return ProbeResult{Error: "not an MCP server: no initialize result"}
	}

	// notifications/initialized (required before further requests)
	notif, _ := marshalNotification("notifications/initialized", map[string]any{})
	if _, sid, nerr := httpMCPRequest(ctx, entry, sessionID, notif, 0); nerr == nil {
		sessionID = sid
	}

	// tools/list
	toolsID := nextID()
	toolsReq, _ := json.Marshal(jsonrpcRequest{JSONRPC: "2.0", ID: toolsID, Method: "tools/list", Params: map[string]any{}})
	toolsResp, _, err := httpMCPRequest(ctx, entry, sessionID, toolsReq, toolsID)
	if err != nil || toolsResp == nil || toolsResp.Error != nil {
		// Connected, but the server didn't return a usable tool list.
		return ProbeResult{OK: true, ProbeAt: time.Now()}
	}

	var toolsResult toolsListResult
	if err := json.Unmarshal(toolsResp.Result, &toolsResult); err == nil {
		names := make([]string, 0, len(toolsResult.Tools))
		for _, t := range toolsResult.Tools {
			names = append(names, t.Name)
		}
		return ProbeResult{OK: true, ToolCount: len(names), ToolNames: names, ProbeAt: time.Now()}
	}
	return ProbeResult{OK: true, ProbeAt: time.Now()}
}

// httpMCPRequest performs one Streamable-HTTP MCP call. It threads the
// Mcp-Session-Id (returned on initialize, echoed on later calls) and parses
// either a plain JSON response or an SSE (text/event-stream) body, returning the
// JSON-RPC response matching wantID. A notification (wantID 0 / 202 Accepted)
// returns a nil response and no error.
func httpMCPRequest(
	ctx context.Context,
	entry mcpProbeEntry,
	sessionID string,
	payload []byte,
	wantID int,
) (*jsonrpcResponse, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, entry.URL, bytes.NewReader(payload))
	if err != nil {
		return nil, sessionID, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("MCP-Protocol-Version", "2024-11-05")
	// A managed bearer/OAuth token overrides any user-supplied Authorization
	// header; shared with BuildACPServer via buildAuthHeaders.
	for _, h := range buildAuthHeaders(entry.Headers, entry.BearerToken) {
		req.Header.Set(h.Name, h.Value)
	}
	if sessionID != "" {
		req.Header.Set("Mcp-Session-Id", sessionID)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, sessionID, err
	}
	defer resp.Body.Close()

	if sid := resp.Header.Get("Mcp-Session-Id"); sid != "" {
		sessionID = sid
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, sessionID, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	if resp.StatusCode == http.StatusAccepted {
		return nil, sessionID, nil // notification accepted, no body
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, 4*1024*1024))
	if err != nil {
		return nil, sessionID, err
	}

	if strings.Contains(resp.Header.Get("Content-Type"), "text/event-stream") {
		return parseSSEForID(body, wantID), sessionID, nil
	}

	var rpcResp jsonrpcResponse
	if err := json.Unmarshal(body, &rpcResp); err != nil {
		return nil, sessionID, nil
	}
	return &rpcResp, sessionID, nil
}

// parseSSEForID scans an SSE body for the JSON-RPC response with the given id.
func parseSSEForID(body []byte, wantID int) *jsonrpcResponse {
	scanner := bufio.NewScanner(bytes.NewReader(body))
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" {
			continue
		}
		var resp jsonrpcResponse
		if err := json.Unmarshal([]byte(data), &resp); err != nil {
			continue
		}
		if resp.ID == wantID {
			return &resp
		}
	}
	return nil
}
