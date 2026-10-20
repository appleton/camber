// Package cambercli implements the native client for a running Camber desktop.
package cambercli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const ProtocolVersion = 1
const maxFrameBytes = 1024 * 1024

// Instance is published by the desktop, and verified against its live handshake.
type Instance struct {
	ProtocolVersion int    `json:"protocolVersion"`
	InstanceID      string `json:"instanceId"`
	PID             int    `json:"pid"`
	StartedAt       string `json:"startedAt"`
	SocketPath      string `json:"socketPath"`
	AppVersion      string `json:"appVersion"`
}

// RPCError preserves the desktop's structured error details.
type RPCError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *RPCError) Error() string { return fmt.Sprintf("desktop error %d: %s", e.Code, e.Message) }

func controlPlatformError(goos string) error {
	if goos == "windows" {
		return errors.New("camber CLI control is not supported on windows")
	}
	return nil
}

// Client only talks to an existing desktop. It never starts another helper.
type Client struct {
	Directory  string
	InstanceID string
	Timeout    time.Duration
}

func DefaultDirectory() (string, error) {
	if err := controlPlatformError(runtime.GOOS); err != nil {
		return "", err
	}
	if directory := os.Getenv("CAMBER_CONTROL_DIR"); directory != "" {
		return directory, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	if runtime.GOOS == "darwin" {
		return filepath.Join(home, "Library", "Application Support", "Camber", "control"), nil
	}
	state := os.Getenv("XDG_STATE_HOME")
	if state == "" {
		state = filepath.Join(home, ".local", "state")
	}
	return filepath.Join(state, "poolside", "control"), nil
}

// Instances lists only endpoints whose live identity matches their discovery file.
func (c *Client) Instances(ctx context.Context) ([]Instance, error) {
	if err := controlPlatformError(runtime.GOOS); err != nil {
		return nil, err
	}
	directory := c.Directory
	if directory == "" {
		var err error
		directory, err = DefaultDirectory()
		if err != nil {
			return nil, err
		}
	}
	entries, err := os.ReadDir(directory)
	if errors.Is(err, os.ErrNotExist) {
		return []Instance{}, nil
	}
	if err != nil {
		return nil, err
	}
	instances := []Instance{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(directory, entry.Name()))
		if err != nil {
			continue
		}
		var instance Instance
		if json.Unmarshal(data, &instance) != nil || instance.InstanceID == "" || instance.SocketPath == "" || instance.ProtocolVersion != ProtocolVersion {
			continue
		}
		if _, err = c.handshake(ctx, instance); err == nil {
			instances = append(instances, instance)
		} else {
			var rpcErr *RPCError
			wanted := c.InstanceID
			if wanted == "" {
				wanted = os.Getenv("CAMBER_INSTANCE_ID")
			}
			if errors.As(err, &rpcErr) && rpcErr.Code == -32005 && (wanted == "" || wanted == instance.InstanceID) {
				return nil, rpcErr
			}
			if wanted != "" && wanted == instance.InstanceID {
				return nil, fmt.Errorf("camber instance %q handshake failed: %w", wanted, err)
			}
		}
	}
	return instances, nil
}

func (c *Client) Select(ctx context.Context) (Instance, error) {
	instances, err := c.Instances(ctx)
	if err != nil {
		return Instance{}, err
	}
	wanted := c.InstanceID
	if wanted == "" {
		wanted = os.Getenv("CAMBER_INSTANCE_ID")
	}
	if wanted != "" {
		for _, instance := range instances {
			if instance.InstanceID == wanted {
				return instance, nil
			}
		}
		return Instance{}, fmt.Errorf("camber instance %q is unavailable; run camber instances list --json", wanted)
	}
	if len(instances) == 1 {
		return instances[0], nil
	}
	if len(instances) == 0 {
		return Instance{}, errors.New("no running Camber desktop found; start the desktop app and run camber instances list --json")
	}
	ids := make([]string, len(instances))
	for i, instance := range instances {
		ids[i] = instance.InstanceID
	}
	return Instance{}, fmt.Errorf("multiple Camber desktops are running (%s); select one with --instance ID", strings.Join(ids, ", "))
}

func (c *Client) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	instance, err := c.Select(ctx)
	if err != nil {
		return nil, err
	}
	// Pin the selected identity for the lifetime of this invocation, including follow.
	// A desktop restart must not redirect an existing reader to a different instance.
	c.InstanceID = instance.InstanceID
	return c.request(ctx, instance, method, params)
}

func (c *Client) handshake(ctx context.Context, instance Instance) (json.RawMessage, error) {
	result, err := c.request(ctx, instance, "camber/control/handshake", map[string]any{"protocolVersion": ProtocolVersion})
	if err != nil {
		return nil, err
	}
	var identity struct {
		InstanceID      string `json:"instanceId"`
		ProtocolVersion int    `json:"protocolVersion"`
	}
	if err = json.Unmarshal(result, &identity); err != nil {
		return nil, err
	}
	if identity.InstanceID != instance.InstanceID {
		return nil, errors.New("desktop instance identity changed")
	}
	if identity.ProtocolVersion != ProtocolVersion {
		return nil, fmt.Errorf("unsupported desktop control protocol %d", identity.ProtocolVersion)
	}
	return result, nil
}

func (c *Client) request(ctx context.Context, instance Instance, method string, params any) (json.RawMessage, error) {
	timeout := c.Timeout
	if timeout == 0 {
		timeout = 35 * time.Second
	}
	requestCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	connection, err := (&net.Dialer{}).DialContext(requestCtx, "unix", instance.SocketPath)
	if err != nil {
		return nil, fmt.Errorf("connect to Camber: %w", err)
	}
	defer connection.Close()
	if deadline, ok := requestCtx.Deadline(); ok {
		_ = connection.SetDeadline(deadline)
	}
	stop := context.AfterFunc(requestCtx, func() { _ = connection.Close() })
	defer stop()
	request := struct {
		JSONRPC    string `json:"jsonrpc"`
		ID         int    `json:"id"`
		InstanceID string `json:"instanceId,omitempty"`
		Method     string `json:"method"`
		Params     any    `json:"params,omitempty"`
	}{"2.0", 1, instance.InstanceID, method, params}
	data, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	if len(data) >= maxFrameBytes {
		return nil, errors.New("request exceeds desktop control frame limit (1 MiB)")
	}
	if _, err = connection.Write(append(data, '\n')); err != nil {
		return nil, err
	}
	// A bounded reader avoids allocating an unbounded response from a broken endpoint.
	data, err = readFrame(connection)
	if err != nil {
		return nil, fmt.Errorf("read desktop response: %w", err)
	}
	var response struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      *int            `json:"id"`
		Result  json.RawMessage `json:"result"`
		Error   *RPCError       `json:"error"`
	}
	if err = json.Unmarshal(data, &response); err != nil {
		return nil, fmt.Errorf("invalid desktop response: %w", err)
	}
	// A saturated endpoint rejects before reading a request and therefore
	// cannot echo its ID. Accept only its explicit connection-level busy error.
	if response.JSONRPC == "2.0" && response.ID == nil && response.Error != nil && response.Error.Code == -32005 {
		return nil, response.Error
	}
	if response.JSONRPC != "2.0" || response.ID == nil || *response.ID != 1 {
		return nil, errors.New("desktop returned an invalid JSON-RPC response identity")
	}
	if response.Error != nil {
		return nil, response.Error
	}
	if response.Result == nil {
		return nil, errors.New("desktop response has no result")
	}
	return response.Result, nil
}

func readFrame(reader io.Reader) ([]byte, error) {
	// Read one byte at a time only at the frame boundary; buffered reads amortize socket IO.
	limited := io.LimitReader(reader, maxFrameBytes+1)
	var data []byte
	buffer := make([]byte, 4096)
	for {
		n, err := limited.Read(buffer)
		if n > 0 {
			for _, b := range buffer[:n] {
				if b == '\n' {
					return data, nil
				}
				data = append(data, b)
				if len(data) > maxFrameBytes {
					return nil, errors.New("desktop response exceeds 1 MiB")
				}
			}
		}
		if err != nil {
			if err == io.EOF {
				return nil, io.ErrUnexpectedEOF
			}
			return nil, err
		}
	}
}
