package acpproxy

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestBuildInitializeRequest(t *testing.T) {
	t.Run("uses helper defaults when request is omitted", func(t *testing.T) {
		req := buildInitializeRequest(nil)

		assert.Equal(t, acpsdk.ProtocolVersion(acpsdk.ProtocolVersionNumber), req.ProtocolVersion)
		require.NotNil(t, req.ClientInfo)
		assert.Equal(t, "camber-helper", req.ClientInfo.Name)
		assert.True(t, req.ClientCapabilities.Fs.ReadTextFile)
		assert.True(t, req.ClientCapabilities.Fs.WriteTextFile)
		assert.False(t, req.ClientCapabilities.Terminal)
		require.NotNil(t, req.ClientCapabilities.Elicitation)
		assert.NotNil(t, req.ClientCapabilities.Elicitation.Form)
		assert.Nil(t, req.ClientCapabilities.Elicitation.Url)
	})

	t.Run("preserves caller handshake", func(t *testing.T) {
		title := "VS Code"
		req := buildInitializeRequest(&acpsdk.InitializeRequest{
			ProtocolVersion: acpsdk.ProtocolVersion(99),
			Meta: map[string]any{
				"feature": "test",
			},
			ClientInfo: &acpsdk.Implementation{
				Name:    "assistant-ui",
				Title:   &title,
				Version: "1.2.3",
			},
			ClientCapabilities: acpsdk.ClientCapabilities{
				Terminal: true,
			},
		})

		assert.Equal(t, acpsdk.ProtocolVersion(99), req.ProtocolVersion)
		require.NotNil(t, req.Meta)
		assert.Equal(t, "test", req.Meta["feature"])
		require.NotNil(t, req.ClientInfo)
		assert.Equal(t, "assistant-ui", req.ClientInfo.Name)
		assert.True(t, req.ClientCapabilities.Terminal)
		// Elicitation is helper-owned, so it is advertised even for surfaces
		// that do not declare it themselves.
		require.NotNil(t, req.ClientCapabilities.Elicitation)
		assert.NotNil(t, req.ClientCapabilities.Elicitation.Form)
	})

	t.Run("preserves caller-declared elicitation capabilities", func(t *testing.T) {
		req := buildInitializeRequest(&acpsdk.InitializeRequest{
			ClientCapabilities: acpsdk.ClientCapabilities{
				Elicitation: &acpsdk.ElicitationCapabilities{
					Form: &acpsdk.ElicitationFormCapabilities{},
					Url:  &acpsdk.ElicitationUrlCapabilities{},
				},
			},
		})

		require.NotNil(t, req.ClientCapabilities.Elicitation)
		assert.NotNil(t, req.ClientCapabilities.Elicitation.Url)
	})
}

func TestMarkExited(t *testing.T) {
	t.Run("clears active process state", func(t *testing.T) {
		cmd := &exec.Cmd{}
		proc := &process{
			cmd:      cmd,
			conn:     &acpsdk.ClientSideConnection{},
			initResp: &acpsdk.InitializeResponse{ProtocolVersion: acpsdk.ProtocolVersionNumber},
			session:  "s1",
			stdin:    nopWriteCloser{},
			state:    processState{kind: processStateRunning},
		}

		require.True(t, proc.markExited(cmd))
		assert.Equal(t, processStateExited, proc.state.kind)
		assert.WithinDuration(t, time.Now(), proc.state.exitedAt, time.Second)
		assert.Nil(t, proc.cmd)
		assert.Nil(t, proc.conn)
		assert.Nil(t, proc.initResp)
		assert.Empty(t, proc.session)
		assert.Nil(t, proc.stdin)
	})

	t.Run("ignores stale process exit", func(t *testing.T) {
		activeCmd := &exec.Cmd{}
		staleCmd := &exec.Cmd{}
		conn := &acpsdk.ClientSideConnection{}
		proc := &process{
			cmd:   activeCmd,
			conn:  conn,
			state: processState{kind: processStateRunning},
		}

		require.False(t, proc.markExited(staleCmd))
		assert.Equal(t, processStateRunning, proc.state.kind)
		assert.Same(t, activeCmd, proc.cmd)
		assert.Same(t, conn, proc.conn)
	})
}

func TestMarkDisconnected(t *testing.T) {
	t.Run("clears the process when its active connection closes", func(t *testing.T) {
		cmd := &exec.Cmd{}
		conn := &acpsdk.ClientSideConnection{}
		proc := &process{
			cmd:      cmd,
			conn:     conn,
			initResp: &acpsdk.InitializeResponse{ProtocolVersion: acpsdk.ProtocolVersionNumber},
			session:  "s1",
			stdin:    nopWriteCloser{},
			state:    processState{kind: processStateRunning},
		}

		require.True(t, proc.markDisconnected(cmd, conn))
		assert.Equal(t, processStateExited, proc.state.kind)
		assert.WithinDuration(t, time.Now(), proc.state.exitedAt, time.Second)
		assert.Nil(t, proc.cmd)
		assert.Nil(t, proc.conn)
		assert.Nil(t, proc.initResp)
		assert.Empty(t, proc.session)
		assert.Nil(t, proc.stdin)
	})

	t.Run("ignores a stale connection closing", func(t *testing.T) {
		cmd := &exec.Cmd{}
		activeConn := &acpsdk.ClientSideConnection{}
		staleConn := &acpsdk.ClientSideConnection{}
		proc := &process{
			cmd:   cmd,
			conn:  activeConn,
			state: processState{kind: processStateRunning},
		}

		require.False(t, proc.markDisconnected(cmd, staleConn))
		assert.Equal(t, processStateRunning, proc.state.kind)
		assert.Same(t, cmd, proc.cmd)
		assert.Same(t, activeConn, proc.conn)
	})
}

func TestWatchDisconnect(t *testing.T) {
	cmd := &exec.Cmd{}
	conn := acpsdk.NewClientSideConnection(
		&acpClient{},
		nopWriteCloser{},
		strings.NewReader(""),
	)
	notified := make(chan error, 1)
	proc := &process{
		cmd:   cmd,
		conn:  conn,
		state: processState{kind: processStateRunning},
	}

	go proc.watchDisconnect("codex-acp", cmd, conn, func(_ string, err error) {
		notified <- err
	})

	select {
	case err := <-notified:
		require.EqualError(t, err, "ACP peer disconnected")
	case <-time.After(time.Second):
		require.FailNow(t, "disconnect notification timed out")
	}
	assert.Equal(t, processStateExited, proc.state.kind)
	assert.Nil(t, proc.conn)
}

func TestStopResetsToUnstarted(t *testing.T) {
	proc := &process{
		cmd:      &exec.Cmd{},
		conn:     &acpsdk.ClientSideConnection{},
		initResp: &acpsdk.InitializeResponse{ProtocolVersion: acpsdk.ProtocolVersionNumber},
		session:  "s1",
		stdin:    nopWriteCloser{},
		state:    processState{kind: processStateRunning},
	}

	require.NoError(t, proc.stop())
	assert.Equal(t, processStateUnstarted, proc.state.kind)
	assert.Nil(t, proc.cmd)
	assert.Nil(t, proc.conn)
	assert.Nil(t, proc.initResp)
	assert.Empty(t, proc.session)
	assert.Nil(t, proc.stdin)
}

func TestStopFiresOnStop(t *testing.T) {
	t.Run("running process fires onStop", func(t *testing.T) {
		var calls int
		proc := &process{
			cmd:    &exec.Cmd{},
			conn:   &acpsdk.ClientSideConnection{},
			stdin:  nopWriteCloser{},
			state:  processState{kind: processStateRunning},
			onStop: func() { calls++ },
		}

		require.NoError(t, proc.stop())
		assert.Equal(t, 1, calls)
		assert.Nil(t, proc.onStop)
	})

	t.Run("stopped process does not fire onStop", func(t *testing.T) {
		var calls int
		proc := &process{
			state:  processState{kind: processStateExited, exitedAt: time.Now()},
			onStop: func() { calls++ },
		}

		require.NoError(t, proc.stop())
		assert.Equal(t, 0, calls)
	})
}

func TestEnsureStartedBackoff(t *testing.T) {
	t.Run("waits after exit and respects context cancellation", func(t *testing.T) {
		proc := &process{state: processState{kind: processStateExited, exitedAt: time.Now()}}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
		defer cancel()

		configCalls := 0
		err := proc.ensureStarted(ctx, func() HandlerConfig {
			configCalls++
			return HandlerConfig{}
		}, DefaultAgentServerName, nil, nil, nil)

		require.ErrorIs(t, err, context.DeadlineExceeded)
		assert.Zero(t, configCalls, "config should not be read until retry delay has elapsed")
	})

	t.Run("reads fresh config after backoff", func(t *testing.T) {
		proc := &process{state: processState{kind: processStateExited, exitedAt: time.Now().Add(-processRestartBackoff)}}
		configCalls := 0

		err := proc.ensureStarted(context.Background(), func() HandlerConfig {
			configCalls++
			return HandlerConfig{
				AgentServers: map[string]AgentServerConfig{
					DefaultAgentServerName: {
						Command: "/nonexistent",
					},
				},
			}
		}, DefaultAgentServerName, nil, nil, nil)

		require.Error(t, err)
		assert.Contains(t, err.Error(), "start")
		assert.Equal(t, 1, configCalls)
	})
}

func TestSupportsSessionClose(t *testing.T) {
	capsProc := func(caps acpsdk.AgentCapabilities) *process {
		return &process{
			state:    processState{kind: processStateRunning},
			initResp: &acpsdk.InitializeResponse{AgentCapabilities: caps},
		}
	}

	t.Run("false without an initialize response", func(t *testing.T) {
		assert.False(t, (&process{}).supportsSessionClose())
	})

	t.Run("false without the close capability", func(t *testing.T) {
		assert.False(t, capsProc(acpsdk.AgentCapabilities{LoadSession: true}).supportsSessionClose())
	})

	t.Run("false with close but no way to reopen", func(t *testing.T) {
		caps := acpsdk.AgentCapabilities{
			SessionCapabilities: acpsdk.SessionCapabilities{Close: &acpsdk.SessionCloseCapabilities{}},
		}
		assert.False(t, capsProc(caps).supportsSessionClose())
	})

	t.Run("true with close and resume", func(t *testing.T) {
		caps := acpsdk.AgentCapabilities{
			SessionCapabilities: acpsdk.SessionCapabilities{
				Close:  &acpsdk.SessionCloseCapabilities{},
				Resume: &acpsdk.SessionResumeCapabilities{},
			},
		}
		assert.True(t, capsProc(caps).supportsSessionClose())
	})

	t.Run("true with close and loadSession", func(t *testing.T) {
		caps := acpsdk.AgentCapabilities{
			LoadSession:         true,
			SessionCapabilities: acpsdk.SessionCapabilities{Close: &acpsdk.SessionCloseCapabilities{}},
		}
		assert.True(t, capsProc(caps).supportsSessionClose())
	})
}

// newProcessWithFakeSessionAgent wires a running process to a fake agent that
// answers every session/new call with a fresh sequential session id, and
// answers session/load and session/resume with an empty result, so tests can
// drive newSessionLocked, loadSessionLocked, and resumeSessionLocked without a
// real subprocess. The returned func performs one session/new call (tagged as
// a config probe when probe is true) and returns the session id the fake
// agent assigned.
func newProcessWithFakeSessionAgent(t *testing.T) (*process, func(probe bool) acpsdk.SessionId) {
	t.Helper()

	agentInR, agentInW := io.Pipe()
	agentOutR, agentOutW := io.Pipe()
	t.Cleanup(func() {
		agentInW.Close()
		agentOutW.Close()
	})

	go func() {
		scanner := bufio.NewScanner(agentInR)
		n := 0
		for scanner.Scan() {
			var req struct {
				ID     any    `json:"id"`
				Method string `json:"method"`
			}
			if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
				continue
			}
			var result any
			switch req.Method {
			case "session/new":
				n++
				result = map[string]any{"sessionId": fmt.Sprintf("session-%d", n)}
			case "session/load", "session/resume":
				result = map[string]any{}
			default:
				continue
			}
			resp, _ := json.Marshal(map[string]any{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"result":  result,
			})
			if _, err := agentOutW.Write(append(resp, '\n')); err != nil {
				return
			}
		}
	}()

	proc := &process{
		state: processState{kind: processStateRunning},
		conn:  acpsdk.NewClientSideConnection(&acpClient{}, agentInW, agentOutR),
	}

	newSession := func(probe bool) acpsdk.SessionId {
		t.Helper()
		req := acpsdk.NewSessionRequest{Cwd: "/tmp"}
		if probe {
			req.Meta = map[string]any{configProbeMetaKey: true}
		}
		proc.mu.Lock()
		resp, err := proc.newSessionLocked(context.Background(), req)
		proc.mu.Unlock()
		require.NoError(t, err)
		return resp.SessionId
	}

	return proc, newSession
}

func TestNewSessionLockedConfigProbeFallback(t *testing.T) {
	t.Run("adopts a probe session as the fallback when none is set", func(t *testing.T) {
		proc, newSession := newProcessWithFakeSessionAgent(t)

		probeID := newSession(true)
		require.NotEmpty(t, probeID)

		proc.mu.Lock()
		fallback := proc.session
		proc.mu.Unlock()
		assert.Equal(t, probeID, fallback)
	})

	t.Run("does not repoint an established fallback to a later probe session", func(t *testing.T) {
		proc, newSession := newProcessWithFakeSessionAgent(t)

		realID := newSession(false)
		require.NotEmpty(t, realID)

		probeID := newSession(true)
		require.NotEqual(t, realID, probeID, "test setup: probe must return a distinct session id")

		proc.mu.Lock()
		fallback := proc.session
		proc.mu.Unlock()
		assert.Equal(t, realID, fallback, "fallback must stay on the real session")
		assert.NotEqual(t, probeID, fallback, "a probe must not repoint an established fallback")
	})

	t.Run("a later real session still repoints the fallback", func(t *testing.T) {
		proc, newSession := newProcessWithFakeSessionAgent(t)

		_ = newSession(false) // establishes the initial fallback
		_ = newSession(true)  // must not disturb it

		realID := newSession(false)
		require.NotEmpty(t, realID)

		proc.mu.Lock()
		fallback := proc.session
		proc.mu.Unlock()
		assert.Equal(t, realID, fallback)
	})

	t.Run("a rotating probe replaces a fallback that is itself a probe", func(t *testing.T) {
		proc, newSession := newProcessWithFakeSessionAgent(t)

		firstProbeID := newSession(true)
		require.NotEmpty(t, firstProbeID)

		secondProbeID := newSession(true)
		require.NotEqual(t, firstProbeID, secondProbeID,
			"test setup: the rotation must return a distinct session id")

		proc.mu.Lock()
		fallback := proc.session
		proc.mu.Unlock()
		// The client closes a superseded probe after its drain window, so
		// leaving the fallback on the first one would point it at a closed
		// session.
		assert.Equal(t, secondProbeID, fallback, "rotation must move the fallback to the live probe")
	})
}

// TestNewSessionLockedConfigProbePreservesPromptRuntimeErr covers FIX 1: a
// config probe's session/new must not clear a latched promptRuntimeErr, since
// that latch is how the next real prompt learns about a fatal runtime failure
// (e.g. rejected MCP connector credentials) and fails fast with an actionable
// message. Only a non-probe session/new may clear it.
func TestNewSessionLockedConfigProbePreservesPromptRuntimeErr(t *testing.T) {
	t.Run("a config probe does not clear a latched runtime error", func(t *testing.T) {
		proc, newSession := newProcessWithFakeSessionAgent(t)
		proc.mu.Lock()
		proc.promptRuntimeErr = &mcpConnectorCredentialsError{}
		proc.mu.Unlock()

		probeID := newSession(true)
		require.NotEmpty(t, probeID)

		proc.mu.Lock()
		latched := proc.promptRuntimeErr
		proc.mu.Unlock()
		var connectorErr *mcpConnectorCredentialsError
		assert.ErrorAs(t, latched, &connectorErr,
			"a background probe must not clear a latch the next real prompt depends on")
	})

	t.Run("a real session clears a latched runtime error", func(t *testing.T) {
		proc, newSession := newProcessWithFakeSessionAgent(t)
		proc.mu.Lock()
		proc.promptRuntimeErr = &mcpConnectorCredentialsError{}
		proc.mu.Unlock()

		realID := newSession(false)
		require.NotEmpty(t, realID)

		proc.mu.Lock()
		latched := proc.promptRuntimeErr
		proc.mu.Unlock()
		assert.NoError(t, latched, "a real session/new must still clear a stale latch")
	})
}

// newLoadSessionRequest and newResumeSessionRequest build minimal requests for
// driving loadSessionLocked/resumeSessionLocked against the fake agent set up
// by newProcessWithFakeSessionAgent, tagged as a config probe when probe is
// true.
func newLoadSessionRequest(id acpsdk.SessionId, probe bool) acpsdk.LoadSessionRequest {
	req := acpsdk.LoadSessionRequest{SessionId: id, Cwd: "/tmp", McpServers: []acpsdk.McpServer{}}
	if probe {
		req.Meta = map[string]any{configProbeMetaKey: true}
	}
	return req
}

func newResumeSessionRequest(id acpsdk.SessionId, probe bool) acpsdk.ResumeSessionRequest {
	req := acpsdk.ResumeSessionRequest{SessionId: id, Cwd: "/tmp"}
	if probe {
		req.Meta = map[string]any{configProbeMetaKey: true}
	}
	return req
}

// TestLoadSessionLockedConfigProbeFallback covers FIX 2's loadSessionLocked
// half: no client sends the probe marker on session/load today (it is latent,
// see the configProbeMetaKey comment in handler.go), but the guard must match
// newSessionLocked's so the bug cannot come back on this path either.
func TestLoadSessionLockedConfigProbeFallback(t *testing.T) {
	t.Run("adopts a probe session as the fallback when none is set", func(t *testing.T) {
		proc, _ := newProcessWithFakeSessionAgent(t)

		proc.mu.Lock()
		_, err := proc.loadSessionLocked(context.Background(), newLoadSessionRequest("probe-session", true))
		fallback := proc.session
		proc.mu.Unlock()

		require.NoError(t, err)
		assert.Equal(t, acpsdk.SessionId("probe-session"), fallback)
	})

	t.Run("does not repoint an established fallback to a probe load", func(t *testing.T) {
		proc, newSession := newProcessWithFakeSessionAgent(t)
		realID := newSession(false)
		require.NotEmpty(t, realID)
		proc.mu.Lock()
		proc.promptRuntimeErr = &mcpConnectorCredentialsError{}
		proc.mu.Unlock()

		proc.mu.Lock()
		_, err := proc.loadSessionLocked(context.Background(), newLoadSessionRequest("probe-session", true))
		fallback := proc.session
		latched := proc.promptRuntimeErr
		proc.mu.Unlock()

		require.NoError(t, err)
		assert.Equal(t, realID, fallback, "a probe load must not repoint an established fallback")
		var connectorErr *mcpConnectorCredentialsError
		assert.ErrorAs(t, latched, &connectorErr,
			"a probe load must not clear the runtime-error latch either")
	})

	t.Run("a non-probe load still repoints the fallback", func(t *testing.T) {
		proc, newSession := newProcessWithFakeSessionAgent(t)
		realID := newSession(false)
		require.NotEmpty(t, realID)

		proc.mu.Lock()
		_, err := proc.loadSessionLocked(context.Background(), newLoadSessionRequest("loaded-session", false))
		fallback := proc.session
		proc.mu.Unlock()

		require.NoError(t, err)
		assert.Equal(t, acpsdk.SessionId("loaded-session"), fallback)
	})
}

// TestResumeSessionLockedConfigProbeFallback mirrors
// TestLoadSessionLockedConfigProbeFallback for resumeSessionLocked.
func TestResumeSessionLockedConfigProbeFallback(t *testing.T) {
	t.Run("adopts a probe session as the fallback when none is set", func(t *testing.T) {
		proc, _ := newProcessWithFakeSessionAgent(t)

		proc.mu.Lock()
		_, err := proc.resumeSessionLocked(context.Background(), newResumeSessionRequest("probe-session", true))
		fallback := proc.session
		proc.mu.Unlock()

		require.NoError(t, err)
		assert.Equal(t, acpsdk.SessionId("probe-session"), fallback)
	})

	t.Run("does not repoint an established fallback to a probe resume", func(t *testing.T) {
		proc, newSession := newProcessWithFakeSessionAgent(t)
		realID := newSession(false)
		require.NotEmpty(t, realID)
		proc.mu.Lock()
		proc.promptRuntimeErr = &mcpConnectorCredentialsError{}
		proc.mu.Unlock()

		proc.mu.Lock()
		_, err := proc.resumeSessionLocked(context.Background(), newResumeSessionRequest("probe-session", true))
		fallback := proc.session
		latched := proc.promptRuntimeErr
		proc.mu.Unlock()

		require.NoError(t, err)
		assert.Equal(t, realID, fallback, "a probe resume must not repoint an established fallback")
		var connectorErr *mcpConnectorCredentialsError
		assert.ErrorAs(t, latched, &connectorErr,
			"a probe resume must not clear the runtime-error latch either")
	})

	t.Run("a non-probe resume still repoints the fallback", func(t *testing.T) {
		proc, newSession := newProcessWithFakeSessionAgent(t)
		realID := newSession(false)
		require.NotEmpty(t, realID)

		proc.mu.Lock()
		_, err := proc.resumeSessionLocked(context.Background(), newResumeSessionRequest("resumed-session", false))
		fallback := proc.session
		proc.mu.Unlock()

		require.NoError(t, err)
		assert.Equal(t, acpsdk.SessionId("resumed-session"), fallback)
	})
}

type nopWriteCloser struct{}

func (nopWriteCloser) Write(p []byte) (int, error) { return len(p), nil }
func (nopWriteCloser) Close() error                { return nil }

func TestScanForAuthUpdates(t *testing.T) {
	t.Run("forwards auth update notifications", func(t *testing.T) {
		input := strings.Join([]string{
			`{"jsonrpc":"2.0","method":"session/update","params":{"ignored":true}}`,
			`{"jsonrpc":"2.0","method":"authenticate/update","params":{"authUri":"https://example.com/device","message":"Sign in"}}`,
			`{"jsonrpc":"2.0","id":1,"method":"authenticate/update","params":{"ignored":true}}`,
			`not json`,
		}, "\n")

		var gotMethod string
		var gotParams any
		scanForAuthUpdates("qwen", strings.NewReader(input), func(_ context.Context, method string, params any) {
			gotMethod = method
			gotParams = params
		})

		assert.Equal(t, authenticateUpdateMethod, gotMethod)
		params, ok := gotParams.(map[string]any)
		require.True(t, ok)
		assert.Equal(t, "https://example.com/device", params["authUri"])
		assert.Equal(t, "Sign in", params["message"])
	})

	t.Run("uses empty params when omitted", func(t *testing.T) {
		var gotParams any
		scanForAuthUpdates("qwen", strings.NewReader(`{"jsonrpc":"2.0","method":"authenticate/update"}`), func(_ context.Context, _ string, params any) {
			gotParams = params
		})

		params, ok := gotParams.(map[string]any)
		require.True(t, ok)
		assert.Empty(t, params)
	})

	t.Run("continues past large non-auth messages", func(t *testing.T) {
		largeImageUpdate := `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"image","mimeType":"image/png","data":"` +
			strings.Repeat("a", 2*1024*1024) +
			`"}}}}`
		authUpdate := `{"jsonrpc":"2.0","method":"authenticate/update","params":{"message":"Sign in"}}`
		input := largeImageUpdate + "\n" + authUpdate + "\n"

		var gotParams any
		scanForAuthUpdates("codex-acp", strings.NewReader(input), func(_ context.Context, _ string, params any) {
			gotParams = params
		})

		params, ok := gotParams.(map[string]any)
		require.True(t, ok)
		assert.Equal(t, "Sign in", params["message"])
	})
}

func TestLineTail(t *testing.T) {
	tail := newLineTail(2)
	tail.Add("first")
	tail.Add("second")
	tail.Add("third")

	assert.Equal(t, "second\nthird", tail.String())
}

func TestInitializeError(t *testing.T) {
	t.Run("preserves original error when stderr is empty", func(t *testing.T) {
		err := initializeError(assert.AnError, "")

		assert.ErrorIs(t, err, assert.AnError)
		assert.NotContains(t, err.Error(), "subprocess stderr")
	})

	t.Run("includes subprocess stderr", func(t *testing.T) {
		err := initializeError(assert.AnError, "npm error E404\nnot found")

		assert.ErrorIs(t, err, assert.AnError)
		assert.Contains(t, err.Error(), "subprocess stderr:")
		assert.Contains(t, err.Error(), "npm error E404")
	})
}

func TestScanStderrCapturesTail(t *testing.T) {
	tail := newLineTail(3)

	scanStderr("poolside", strings.NewReader("one\ntwo\nthree\nfour\n"), tail, nil)

	assert.Equal(t, "two\nthree\nfour", tail.String())
}

func TestScanStderrReportsMCPConnectorCredentialsError(t *testing.T) {
	reported := make(chan error, 1)
	line := `2026-07-30T10:58:16.647Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when AuthRequired(AuthRequiredError { www_authenticate_header: "Bearer resource_metadata=\"https://mcp.grafana.com/.well-known/oauth-protected-resource\"" })`

	scanStderr("codex-acp", strings.NewReader(line+"\n"), nil, func(err error) {
		if err != nil {
			reported <- err
		}
	})

	select {
	case err := <-reported:
		var connectorErr *mcpConnectorCredentialsError
		require.ErrorAs(t, err, &connectorErr)
		assert.Contains(t, err.Error(), "reconnect the connector")
	default:
		t.Fatal("expected MCP connector credentials error")
	}
}

func TestMCPConnectorCredentialsErrorCancelsActivePrompts(t *testing.T) {
	conn := new(acpsdk.ClientSideConnection)
	proc := &process{
		state: processState{kind: processStateRunning},
		conn:  conn,
	}
	promptCtx, release, err := proc.contextForPrompt(context.Background(), conn)
	require.NoError(t, err)
	defer release()

	proc.failActivePromptsFor(proc.cmd, &mcpConnectorCredentialsError{})

	select {
	case <-promptCtx.Done():
		var connectorErr *mcpConnectorCredentialsError
		require.ErrorAs(t, context.Cause(promptCtx), &connectorErr)
	case <-time.After(time.Second):
		t.Fatal("active prompt was not cancelled")
	}

	_, _, err = proc.contextForPrompt(context.Background(), conn)
	var connectorErr *mcpConnectorCredentialsError
	require.ErrorAs(t, err, &connectorErr)
}

func TestMCPConnectorCredentialsErrorIgnoresStoppedProcess(t *testing.T) {
	stoppedCmd := new(exec.Cmd)
	activeCmd := new(exec.Cmd)
	conn := new(acpsdk.ClientSideConnection)
	proc := &process{
		state: processState{kind: processStateRunning},
		cmd:   activeCmd,
		conn:  conn,
	}
	promptCtx, release, err := proc.contextForPrompt(context.Background(), conn)
	require.NoError(t, err)
	defer release()

	proc.failActivePromptsFor(stoppedCmd, &mcpConnectorCredentialsError{})

	select {
	case <-promptCtx.Done():
		t.Fatal("stopped subprocess cancelled an active replacement prompt")
	default:
	}
	_, releaseSecond, err := proc.contextForPrompt(context.Background(), conn)
	require.NoError(t, err)
	releaseSecond()
}

func TestPromptCleanupDoesNotDeleteReplacementProcessCancel(t *testing.T) {
	firstConn := new(acpsdk.ClientSideConnection)
	proc := &process{
		state: processState{kind: processStateRunning},
		conn:  firstConn,
	}
	_, releaseFirst, err := proc.contextForPrompt(context.Background(), firstConn)
	require.NoError(t, err)

	secondConn := new(acpsdk.ClientSideConnection)
	proc.mu.Lock()
	proc.resetLocked(processState{kind: processStateRunning})
	proc.conn = secondConn
	proc.mu.Unlock()
	secondPromptCtx, releaseSecond, err := proc.contextForPrompt(context.Background(), secondConn)
	require.NoError(t, err)
	defer releaseSecond()

	releaseFirst()
	proc.failActivePromptsFor(proc.cmd, &mcpConnectorCredentialsError{})

	select {
	case <-secondPromptCtx.Done():
		var connectorErr *mcpConnectorCredentialsError
		require.ErrorAs(t, context.Cause(secondPromptCtx), &connectorErr)
	case <-time.After(time.Second):
		t.Fatal("replacement prompt lost its cancellation entry")
	}
}

func TestNormalizeAgentServers(t *testing.T) {
	t.Run("adds default Camber registry server to custom config", func(t *testing.T) {
		servers := NormalizeAgentServers(map[string]AgentServerConfig{
			"echo": {
				Command: "node",
				Args:    []string{"echo-acp.mjs"},
			},
		})

		assert.Equal(t, AgentServerConfig{
			Command: "",
		}, servers[DefaultAgentServerName])
		assert.NotContains(t, servers, LocalAgentServerName)
		assert.NotContains(t, servers, LegacyDefaultAgentServerName)
		assert.Equal(t, AgentServerConfig{
			Command: "node",
			Args:    []string{"echo-acp.mjs"},
		}, servers["echo"])
	})

	t.Run("preserves explicitly configured local server", func(t *testing.T) {
		servers := NormalizeAgentServers(map[string]AgentServerConfig{
			LocalAgentServerName: {Type: "local"},
		})

		assert.Equal(t, AgentServerConfig{Type: "local"}, servers[LocalAgentServerName])
	})

	t.Run("preserves configured Camber entries", func(t *testing.T) {
		servers := NormalizeAgentServers(map[string]AgentServerConfig{
			DefaultAgentServerName: {
				Command: "pool",
				Args:    []string{"custom-acp"},
			},
		})

		assert.Equal(t, AgentServerConfig{
			Command: "pool",
			Args:    []string{"custom-acp"},
		}, servers[DefaultAgentServerName])
	})

	t.Run("replaces legacy self placeholders for Camber entries", func(t *testing.T) {
		for _, command := range []string{"{{SELF}}", "{{$SELF}}"} {
			servers := NormalizeAgentServers(map[string]AgentServerConfig{
				DefaultAgentServerName: {
					Command:              command,
					Args:                 []string{"acp"},
					DefaultConfigOptions: map[string]string{"mode": "plan"},
				},
			})

			assert.Equal(t, AgentServerConfig{
				Command:              "",
				DefaultConfigOptions: map[string]string{"mode": "plan"},
			}, servers[DefaultAgentServerName])
		}
	})

	t.Run("treats legacy default as Camber alias", func(t *testing.T) {
		servers := NormalizeAgentServers(map[string]AgentServerConfig{
			LegacyDefaultAgentServerName: {
				Command: "pool",
				Args:    []string{"custom-acp"},
			},
		})

		assert.Equal(t, DefaultAgentServerName, NormalizeAgentServerName(""))
		assert.Equal(t, DefaultAgentServerName, NormalizeAgentServerName(LegacyDefaultAgentServerName))
		assert.Contains(t, servers, DefaultAgentServerName)
		assert.NotContains(t, servers, LegacyDefaultAgentServerName)
	})
}

func TestBuildProcessEnv(t *testing.T) {
	t.Run("uses user shell PATH before app PATH", func(t *testing.T) {
		withUserShellEnvProvider(t, func() []string {
			return []string{"PATH=" + pathList("/shell/bin", "/usr/bin")}
		})
		t.Setenv("PATH", pathList("/app/bin", "/usr/bin"))

		env, err := buildProcessEnv(startConfig{
			binary: "node",
		})
		require.NoError(t, err)

		assert.Equal(t, pathList("/shell/bin", "/usr/bin", "/app/bin"), lastEnvValue(env, "PATH"))
	})

	t.Run("uses user shell env before app env", func(t *testing.T) {
		withUserShellEnvProvider(t, func() []string {
			return []string{
				"PATH=/shell/bin",
				"VOLTA_HOME=/shell/volta",
				"SHELL_ONLY=value",
			}
		})
		t.Setenv("PATH", "/app/bin")
		t.Setenv("VOLTA_HOME", "/app/volta")

		env, err := buildProcessEnv(startConfig{
			binary: "node",
		})
		require.NoError(t, err)

		assert.Equal(t, "/shell/volta", lastEnvValue(env, "VOLTA_HOME"))
		assert.Equal(t, "value", lastEnvValue(env, "SHELL_ONLY"))
	})

	t.Run("preserves configured agent PATH override", func(t *testing.T) {
		withUserShellEnvProvider(t, func() []string {
			return []string{"PATH=/shell/bin"}
		})
		t.Setenv("PATH", "/app/bin")

		env, err := buildProcessEnv(startConfig{
			binary: "node",
			env: map[string]string{
				"PATH": "/agent/bin",
			},
		})
		require.NoError(t, err)

		assert.Equal(t, "/agent/bin", lastEnvValue(env, "PATH"))
	})

	t.Run("adds common user tool dirs when shell PATH is unavailable", func(t *testing.T) {
		withUserShellEnvProvider(t, func() []string {
			return nil
		})
		home := t.TempDir()
		asdfShims := filepath.Join(home, ".asdf", "shims")
		asdfBin := filepath.Join(home, ".asdf", "bin")
		require.NoError(t, os.MkdirAll(asdfShims, 0o755))
		require.NoError(t, os.MkdirAll(asdfBin, 0o755))
		t.Setenv("HOME", home)
		t.Setenv("PATH", "/usr/bin")

		env, err := buildProcessEnv(startConfig{
			binary: "node",
		})
		require.NoError(t, err)

		pathDirs := filepath.SplitList(lastEnvValue(env, "PATH"))
		assert.Contains(t, pathDirs, asdfShims)
		assert.Contains(t, pathDirs, asdfBin)
	})

	t.Run("uses camber npm cache for npx agent servers", func(t *testing.T) {
		withUserShellEnvProvider(t, func() []string {
			return nil
		})
		t.Setenv(npmConfigCacheEnvKey, "/broken-lower-cache")
		t.Setenv(npmConfigCacheEnvKeyUpper, "/broken-upper-cache")

		env, err := buildProcessEnv(startConfig{
			binary: "npx",
		})
		require.NoError(t, err)

		expectedCacheDir, err := camberNPMCacheDir()
		require.NoError(t, err)
		assert.Equal(t, expectedCacheDir, lastEnvValue(env, npmConfigCacheEnvKey))
		assert.Empty(t, lastEnvValue(env, npmConfigCacheEnvKeyUpper))
	})

	t.Run("preserves configured npm cache for npx agent servers", func(t *testing.T) {
		withUserShellEnvProvider(t, func() []string {
			return nil
		})
		t.Setenv(npmConfigCacheEnvKey, "/shell-cache")

		env, err := buildProcessEnv(startConfig{
			binary: "npx",
			env: map[string]string{
				npmConfigCacheEnvKey: "/agent-cache",
			},
		})
		require.NoError(t, err)

		assert.Equal(t, "/agent-cache", lastEnvValue(env, npmConfigCacheEnvKey))
	})

	t.Run("does not add npm cache for non-npx agent servers", func(t *testing.T) {
		withUserShellEnvProvider(t, func() []string {
			return nil
		})
		t.Setenv(npmConfigCacheEnvKey, "")

		env, err := buildProcessEnv(startConfig{
			binary: "node",
		})
		require.NoError(t, err)

		assert.Empty(t, lastEnvValue(env, npmConfigCacheEnvKey))
	})
}

func TestResolveExecutablePath(t *testing.T) {
	t.Run("uses provided env PATH", func(t *testing.T) {
		dir := t.TempDir()
		npx := filepath.Join(dir, "npx")
		require.NoError(t, os.WriteFile(npx, []byte("#!/bin/sh\n"), 0o755))

		resolved, err := resolveExecutablePath("npx", []string{"PATH=" + dir})
		require.NoError(t, err)

		assert.Equal(t, npx, resolved)
	})

	t.Run("leaves explicit path unchanged", func(t *testing.T) {
		resolved, err := resolveExecutablePath("./node_modules/.bin/acp", []string{"PATH=/nowhere"})
		require.NoError(t, err)

		assert.Equal(t, "./node_modules/.bin/acp", resolved)
	})

	t.Run("ignores non-executable file", func(t *testing.T) {
		dir := t.TempDir()
		require.NoError(t, os.WriteFile(filepath.Join(dir, "npx"), []byte("nope"), 0o644))

		resolved, err := resolveExecutablePath("definitely-missing-camber-test-bin", []string{"PATH=" + dir})

		assert.Empty(t, resolved)
		assert.Error(t, err)
	})
}

func TestCamberNPMCacheDir(t *testing.T) {
	t.Run("falls back to temp dir when user cache is unavailable", func(t *testing.T) {
		t.Setenv("HOME", "")
		t.Setenv("XDG_CACHE_HOME", "")

		cacheDir, err := camberNPMCacheDir()
		require.NoError(t, err)

		assert.Equal(t, filepath.Join(os.TempDir(), "poolside", "acp", "npm"), cacheDir)
	})
}

func TestNpxInstallDirName(t *testing.T) {
	// Known value: the dir npx@11 created for this exact spec on disk.
	assert.Equal(t, "18dd321ac7067500", npxInstallDirName("@agentclientprotocol/codex-acp@1.1.4"))
}

func TestNpxPackageSpecs(t *testing.T) {
	assert.Equal(t, []string{"@agentclientprotocol/claude-agent-acp@0.59.0"}, npxPackageSpecs([]string{"-y", "@agentclientprotocol/claude-agent-acp@0.59.0"}))
	assert.Equal(t, []string{"pkg"}, npxPackageSpecs([]string{"--yes", "--loglevel=silly", "pkg", "extra"}))
	assert.Equal(t, []string{"@scope/agent"}, npxPackageSpecs([]string{"--package=@scope/agent", "agent-bin"}))
	assert.Equal(t, []string{"@scope/agent"}, npxPackageSpecs([]string{"--package", "@scope/agent", "agent-bin"}))
	assert.Equal(t, []string{"@scope/agent"}, npxPackageSpecs([]string{"-p", "@scope/agent", "agent-bin"}))
	assert.Equal(t, []string{"a", "b"}, npxPackageSpecs([]string{"-p", "a", "--package=b", "bin"}))
	assert.Empty(t, npxPackageSpecs([]string{"-y"}))
	assert.Empty(t, npxPackageSpecs(nil))

	assert.Empty(t, npxPackageSpecs([]string{"--loglevel", "silly", "pkg"}))
	assert.Equal(t, []string{"@scope/agent"}, npxPackageSpecs([]string{"--loglevel", "silly", "--package=@scope/agent", "bin"}))
}

func TestClearNpxCacheEntry(t *testing.T) {
	setupCacheEntry := func(t *testing.T, pkg string) string {
		t.Setenv("HOME", t.TempDir())
		t.Setenv("XDG_CACHE_HOME", "")
		cacheDir, err := camberNPMCacheDir()
		require.NoError(t, err)
		installDir := filepath.Join(cacheDir, "_npx", npxInstallDirName(pkg))
		require.NoError(t, os.MkdirAll(filepath.Join(installDir, "node_modules"), 0o755))
		return installDir
	}

	t.Run("removes the agent's cache entry", func(t *testing.T) {
		installDir := setupCacheEntry(t, "@agentclientprotocol/codex-acp@1.1.4")

		err := clearNpxCacheEntry(startConfig{
			binary:    "npx",
			extraArgs: []string{"-y", "@agentclientprotocol/codex-acp@1.1.4"},
		})

		require.NoError(t, err)
		assert.NoDirExists(t, installDir)
	})

	t.Run("does not touch a custom npm cache", func(t *testing.T) {
		installDir := setupCacheEntry(t, "@agentclientprotocol/codex-acp@1.1.4")

		err := clearNpxCacheEntry(startConfig{
			binary:    "npx",
			extraArgs: []string{"-y", "@agentclientprotocol/codex-acp@1.1.4"},
			env:       map[string]string{npmConfigCacheEnvKey: "/custom-cache"},
		})

		assert.Error(t, err)
		assert.DirExists(t, installDir)
	})

	t.Run("ignores non-npx binaries", func(t *testing.T) {
		assert.Error(t, clearNpxCacheEntry(startConfig{binary: "node", extraArgs: []string{"pkg"}}))
	})

	t.Run("errors when no entry exists", func(t *testing.T) {
		t.Setenv("HOME", t.TempDir())
		t.Setenv("XDG_CACHE_HOME", "")

		assert.ErrorIs(t, clearNpxCacheEntry(startConfig{
			binary:    "npx",
			extraArgs: []string{"-y", "@agentclientprotocol/codex-acp@1.1.4"},
		}), os.ErrNotExist)
	})

	t.Run("errors on multiple package specs", func(t *testing.T) {
		assert.Error(t, clearNpxCacheEntry(startConfig{
			binary:    "npx",
			extraArgs: []string{"-p", "a", "--package=b", "bin"},
		}))
	})
}

func TestStartLockedSelfHeal(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses a shell script as fake npx")
	}

	setup := func(t *testing.T) (cfg startConfig, installDir, markerFile string) {
		home := t.TempDir()
		t.Setenv("HOME", home)
		t.Setenv("XDG_CACHE_HOME", "")
		withUserShellEnvProvider(t, func() []string { return nil })

		pkg := "@agentclientprotocol/codex-acp@1.1.4"
		cacheDir, err := camberNPMCacheDir()
		require.NoError(t, err)
		installDir = filepath.Join(cacheDir, "_npx", npxInstallDirName(pkg))
		require.NoError(t, os.MkdirAll(installDir, 0o755))
		require.NoError(t, os.WriteFile(filepath.Join(installDir, "package.json"), []byte("{}"), 0o644))

		binDir := t.TempDir()
		markerFile = filepath.Join(binDir, "runs")
		script := "#!/bin/sh\necho run >> " + markerFile + "\necho boom >&2\nexit 1\n"
		require.NoError(t, os.WriteFile(filepath.Join(binDir, "npx"), []byte(script), 0o755))

		cfg = startConfig{
			serverName: "codex-acp",
			binary:     "npx",
			extraArgs:  []string{"-y", pkg},
			env:        map[string]string{"PATH": binDir},
		}
		return cfg, installDir, markerFile
	}

	countRuns := func(t *testing.T, markerFile string) int {
		data, err := os.ReadFile(markerFile)
		require.NoError(t, err)
		return strings.Count(string(data), "run")
	}

	t.Run("clears cache entry and retries once on handshake failure", func(t *testing.T) {
		cfg, installDir, markerFile := setup(t)
		proc := &process{}

		err := proc.startLocked(context.Background(), cfg, &acpClient{}, defaultInitializeRequest())

		require.Error(t, err)
		var handshakeErr *initializeHandshakeError
		assert.ErrorAs(t, err, &handshakeErr)
		assert.NoDirExists(t, installDir)
		assert.Equal(t, 2, countRuns(t, markerFile))
	})

	t.Run("does not retry when there is no cache entry to clear", func(t *testing.T) {
		cfg, installDir, markerFile := setup(t)
		require.NoError(t, os.RemoveAll(installDir))
		proc := &process{}

		err := proc.startLocked(context.Background(), cfg, &acpClient{}, defaultInitializeRequest())

		require.Error(t, err)
		assert.Equal(t, 1, countRuns(t, markerFile))
	})

	t.Run("does not retry on spawn failure", func(t *testing.T) {
		cfg, installDir, _ := setup(t)
		cfg.binary = "/nonexistent-binary"
		proc := &process{}

		err := proc.startLocked(context.Background(), cfg, &acpClient{}, defaultInitializeRequest())

		require.Error(t, err)
		var handshakeErr *initializeHandshakeError
		assert.False(t, errors.As(err, &handshakeErr))
		assert.DirExists(t, installDir)
	})

	t.Run("does not clear cache or retry when the caller context is canceled", func(t *testing.T) {
		cfg, installDir, _ := setup(t)
		proc := &process{}
		ctx, cancel := context.WithCancel(context.Background())
		cancel()

		err := proc.startLocked(ctx, cfg, &acpClient{}, defaultInitializeRequest())

		require.Error(t, err)
		assert.DirExists(t, installDir)
	})
}

func TestPruneBrokenNpxCache(t *testing.T) {
	cacheDir := t.TempDir()
	brokenDir := filepath.Join(cacheDir, "_npx", "broken")
	goodDir := filepath.Join(cacheDir, "_npx", "good")
	require.NoError(t, os.MkdirAll(filepath.Join(brokenDir, "node_modules"), 0o755))
	require.NoError(t, os.MkdirAll(goodDir, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(goodDir, "package.json"), []byte("{}"), 0o644))

	require.NoError(t, pruneBrokenNpxCache(cacheDir))

	assert.NoDirExists(t, brokenDir)
	assert.DirExists(t, goodDir)
}

func lastEnvValue(env []string, key string) string {
	var value string
	for _, entry := range env {
		entryKey, entryValue, ok := strings.Cut(entry, "=")
		if ok && entryKey == key {
			value = entryValue
		}
	}
	return value
}

func withUserShellEnvProvider(t *testing.T, provider func() []string) {
	t.Helper()

	previous := userShellEnvProvider
	userShellEnvProvider = provider
	t.Cleanup(func() {
		userShellEnvProvider = previous
	})
}

func pathList(dirs ...string) string {
	return strings.Join(dirs, string(os.PathListSeparator))
}
