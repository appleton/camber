package cambercli

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestDiscoveryValidatesLiveIdentity(t *testing.T) {
	directory := t.TempDir()
	serveDesktop(t, directory, "live", "live")
	serveDesktop(t, directory, "stale", "replacement")
	require.NoError(t, os.WriteFile(filepath.Join(directory, "broken.json"), []byte("broken"), 0600))
	client := &Client{Directory: directory, Timeout: time.Second}
	instances, err := client.Instances(context.Background())
	require.NoError(t, err)
	require.Len(t, instances, 1)
	assert.Equal(t, "live", instances[0].InstanceID)
}

func TestBusyDesktopIsNotReportedAsMissing(t *testing.T) {
	t.Setenv("CAMBER_INSTANCE_ID", "")
	dir, err := os.MkdirTemp("/tmp", "pcb-")
	require.NoError(t, err)
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	socket := filepath.Join(dir, "socket")
	listener, err := net.Listen("unix", socket)
	require.NoError(t, err)
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			// Read the small test request to avoid platform-specific reset
			// behavior when closing a socket with unread incoming bytes.
			_, _ = readFrame(conn)
			_, _ = io.WriteString(conn, "{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32005,\"message\":\"Camber control is busy\"}}\n")
			_ = conn.Close()
		}
	}()
	raw, err := json.Marshal(Instance{ProtocolVersion: 1, InstanceID: "busy", SocketPath: socket})
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(dir, "busy.json"), raw, 0600))
	for _, id := range []string{"", "busy"} {
		client := &Client{Directory: dir, InstanceID: id, Timeout: time.Second}
		_, err := client.Select(context.Background())
		var rpcErr *RPCError
		require.ErrorAs(t, err, &rpcErr)
		assert.Equal(t, -32005, rpcErr.Code)
	}
}

func TestDefaultDirectoryUsesControlOverride(t *testing.T) {
	t.Setenv("CAMBER_CONTROL_DIR", filepath.Join(t.TempDir(), "control"))
	directory, err := DefaultDirectory()
	if runtime.GOOS == "windows" {
		require.ErrorContains(t, err, "not supported on windows")
		return
	}
	require.NoError(t, err)
	assert.Equal(t, os.Getenv("CAMBER_CONTROL_DIR"), directory)
}

func TestControlPlatformSupportIsExplicit(t *testing.T) {
	assert.NoError(t, controlPlatformError("darwin"))
	assert.NoError(t, controlPlatformError("linux"))
	require.ErrorContains(t, controlPlatformError("windows"), "not supported on windows")
}

func TestDefaultDirectoryUsesNativeLocation(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CAMBER_CONTROL_DIR", "")
	t.Setenv("XDG_STATE_HOME", "")

	directory, err := DefaultDirectory()
	if runtime.GOOS == "windows" {
		require.ErrorContains(t, err, "not supported on windows")
		return
	}
	require.NoError(t, err)
	if runtime.GOOS == "darwin" {
		assert.Equal(t, filepath.Join(home, "Library", "Application Support", "Camber", "control"), directory)
	} else {
		assert.Equal(t, filepath.Join(home, ".local", "state", "camber", "control"), directory)
	}
}

func TestSelectionIsExplicitInheritedOrUnique(t *testing.T) {
	t.Setenv("CAMBER_INSTANCE_ID", "")
	directory := t.TempDir()
	serveDesktop(t, directory, "one", "one")
	serveDesktop(t, directory, "two", "two")
	client := &Client{Directory: directory, Timeout: time.Second}
	_, err := client.Select(context.Background())
	require.ErrorContains(t, err, "multiple Camber desktops")
	t.Setenv("CAMBER_INSTANCE_ID", "two")
	instance, err := client.Select(context.Background())
	require.NoError(t, err)
	assert.Equal(t, "two", instance.InstanceID)
	client.InstanceID = "one"
	instance, err = client.Select(context.Background())
	require.NoError(t, err)
	assert.Equal(t, "one", instance.InstanceID)
	client.InstanceID = "gone"
	_, err = client.Select(context.Background())
	require.ErrorContains(t, err, "unavailable")
}
func TestCallUsesIdentityBoundExistingSocket(t *testing.T) {
	t.Setenv("CAMBER_INSTANCE_ID", "")
	directory := t.TempDir()
	requests := serveDesktop(t, directory, "desktop", "desktop")
	client := &Client{Directory: directory, Timeout: time.Second}
	result, err := client.Call(context.Background(), "camber/control/dispatch", map[string]any{"command": "chat.list", "args": map[string]any{}})
	require.NoError(t, err)
	assert.JSONEq(t, `{"ok":true}`, string(result))
	requests.mu.Lock()
	defer requests.mu.Unlock()
	require.Len(t, requests.items, 2)
	assert.Equal(t, "camber/control/handshake", requests.items[0]["method"])
	assert.Equal(t, "camber/control/dispatch", requests.items[1]["method"])
	assert.Equal(t, "desktop", requests.items[1]["instanceId"])
}
func TestReadFrameRejectsOversizeAndUnterminatedResponses(t *testing.T) {
	_, err := readFrame(strings.NewReader(strings.Repeat("x", maxFrameBytes+1) + "\n"))
	require.ErrorContains(t, err, "exceeds")
	_, err = readFrame(strings.NewReader(`{"result":true}`))
	require.ErrorIs(t, err, io.ErrUnexpectedEOF)
	data, err := readFrame(strings.NewReader("{}\nignored"))
	require.NoError(t, err)
	assert.Equal(t, "{}", string(data))
}
func TestMissingDiscoveryDirectoryIsEmpty(t *testing.T) {
	t.Setenv("CAMBER_INSTANCE_ID", "")
	client := &Client{Directory: filepath.Join(t.TempDir(), "missing")}
	instances, err := client.Instances(context.Background())
	require.NoError(t, err)
	assert.Empty(t, instances)
	_, err = client.Select(context.Background())
	require.ErrorContains(t, err, "no running Camber")
}

type recordedRequests struct {
	mu    sync.Mutex
	items []map[string]any
}

func serveDesktop(t *testing.T, directory, id, liveID string) *recordedRequests {
	t.Helper()
	// Unix socket paths are short even when the test temporary directory is long on macOS.
	socketFile, err := os.CreateTemp("", "camber-test-*.sock")
	require.NoError(t, err)
	socket := socketFile.Name()
	require.NoError(t, socketFile.Close())
	require.NoError(t, os.Remove(socket))
	listener, err := net.Listen("unix", socket)
	require.NoError(t, err)
	t.Cleanup(func() { _ = listener.Close(); _ = os.Remove(socket) })
	manifest := Instance{ProtocolVersion: 1, InstanceID: id, SocketPath: socket, PID: os.Getpid()}
	data, err := json.Marshal(manifest)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(directory, id+".json"), data, 0600))
	requests := &recordedRequests{}
	go func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer connection.Close()
				var request map[string]any
				if json.NewDecoder(connection).Decode(&request) != nil {
					return
				}
				requests.mu.Lock()
				requests.items = append(requests.items, request)
				requests.mu.Unlock()
				var result any = map[string]any{"ok": true}
				if request["method"] == "camber/control/handshake" {
					result = map[string]any{"instanceId": liveID, "protocolVersion": 1}
				}
				_ = json.NewEncoder(connection).Encode(map[string]any{"jsonrpc": "2.0", "id": request["id"], "result": result})
			}()
		}
	}()
	return requests
}
