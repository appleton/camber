package acpproxy

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/tliron/glsp"

	acphelpers "github.com/appleton/camber/pkg/acp"
	"github.com/appleton/camber/pkg/camber-helper/methods"
)

func newGlspContext(
	notifyCalls *[]notifyCapture,
	callCalls *[]callCapture,
) *glsp.Context {
	return &glsp.Context{
		Notify: func(_ context.Context, method string, params any) error {
			if notifyCalls != nil {
				*notifyCalls = append(*notifyCalls, notifyCapture{method: method, params: params})
			}
			return nil
		},
		Call: func(_ context.Context, method string, params any, result any) error {
			if callCalls != nil {
				*callCalls = append(*callCalls, callCapture{method: method, params: params})
			}
			return nil
		},
	}
}

func TestPromptPublishesTurnEndedAfterFailedCompaction(t *testing.T) {
	agentInR, agentInW := io.Pipe()
	agentOutR, agentOutW := io.Pipe()
	t.Cleanup(func() {
		agentInR.Close()
		agentInW.Close()
		agentOutR.Close()
		agentOutW.Close()
	})

	go func() {
		scanner := bufio.NewScanner(agentInR)
		if !scanner.Scan() {
			return
		}
		var req struct {
			ID any `json:"id"`
		}
		if json.Unmarshal(scanner.Bytes(), &req) != nil {
			return
		}
		messages := []map[string]any{
			{
				"jsonrpc": "2.0",
				"method":  acphelpers.ExtensionMethodCompactionUpdate,
				"params": map[string]any{
					"sessionId": "sess-1",
					"id":        "compaction-failed",
					"phase":     "started",
				},
			},
			{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"error": map[string]any{
					"code":    -32603,
					"message": "summarizer failed",
				},
			},
		}
		for _, message := range messages {
			encoded, _ := json.Marshal(message)
			if _, err := agentOutW.Write(append(encoded, '\n')); err != nil {
				return
			}
		}
	}()

	h := NewHandler(func() HandlerConfig {
		return HandlerConfig{AgentServers: map[string]AgentServerConfig{
			DefaultAgentServerName: {Command: "unused-in-test"},
		}}
	}, nil, nil)
	sink := &fakeEventSink{}
	h.SetSessionEvents(sink)
	gCtx := newGlspContext(nil, nil)
	proc, client := h.processFor(DefaultAgentServerName, gCtx)
	proc.state = processState{kind: processStateRunning}
	proc.conn = acpsdk.NewClientSideConnection(client, agentInW, agentOutR)
	proc.initResp = &acpsdk.InitializeResponse{ProtocolVersion: acpsdk.ProtocolVersionNumber}
	proc.session = "sess-1"

	resp, err := h.Prompt(context.Background(), &methods.ACPPromptParams{
		ACPAgentServerParams: methods.ACPAgentServerParams{AgentServer: DefaultAgentServerName},
		PromptRequest: acpsdk.PromptRequest{
			SessionId: "sess-1",
			Prompt: []acpsdk.ContentBlock{{
				Text: &acpsdk.ContentBlockText{Type: "text", Text: "compact"},
			}},
		},
	}, gCtx)
	require.Error(t, err)
	assert.Nil(t, resp)
	require.NoError(t, client.waitForSessionUpdates(context.Background()))

	published, _ := sink.snapshot()
	require.GreaterOrEqual(t, len(published), 3)
	assert.Equal(t, methods.ACPCompactionUpdateMethod, published[len(published)-2].message["method"])
	assert.Equal(t, methods.ACPTurnEndedMethod, published[len(published)-1].message["method"])
	assert.Equal(t, []string{"begin:sess-1", "end:sess-1"}, sink.turnSnapshot())
}

type notifyCapture struct {
	method string
	params any
}

type callCapture struct {
	method string
	params any
}

func TestNewHandler(t *testing.T) {
	h := NewHandler(nil, nil, nil)
	require.NotNil(t, h.procs)
	require.NotNil(t, h.clients)
}

func TestInitialize(t *testing.T) {
	t.Run("returns cached initialize response", func(t *testing.T) {
		h := NewHandler(dummyConfig(), nil, nil)
		gCtx := newGlspContext(nil, nil)
		proc, _ := h.processFor(DefaultAgentServerName, gCtx)
		proc.state = processState{kind: processStateRunning}
		proc.initResp = &acpsdk.InitializeResponse{
			ProtocolVersion: acpsdk.ProtocolVersionNumber,
			AuthMethods:     []acpsdk.AuthMethod{},
		}

		resp, err := h.Initialize(context.Background(), &methods.ACPInitializeParams{
			InitializeRequest: acpsdk.InitializeRequest{
				ProtocolVersion: acpsdk.ProtocolVersionNumber,
			},
		}, gCtx)

		require.NoError(t, err)
		require.NotNil(t, resp)
		assert.Equal(t, acpsdk.ProtocolVersion(acpsdk.ProtocolVersionNumber), resp.ProtocolVersion)
		assert.Empty(t, resp.AuthMethods)
	})
}

func TestRestartServer(t *testing.T) {
	h := NewHandler(dummyConfig(), nil, nil)
	gCtx := newGlspContext(nil, nil)
	proc, _ := h.processFor(DefaultAgentServerName, gCtx)
	proc.state = processState{kind: processStateRunning}
	proc.stdin = nopWriteCloser{}
	proc.initResp = &acpsdk.InitializeResponse{ProtocolVersion: acpsdk.ProtocolVersionNumber}
	proc.session = "s-123"

	resp, err := h.RestartServer(context.Background(), &methods.ACPAgentServerParams{}, gCtx)

	require.NoError(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, processStateUnstarted, proc.state.kind)
	assert.Nil(t, proc.initResp)
	assert.Empty(t, proc.session)
}

func TestStopChangedAgentServers(t *testing.T) {
	t.Run("keeps processes running for default-only and default-option changes", func(t *testing.T) {
		h := NewHandler(dummyConfig(), nil, nil)
		gCtx := newGlspContext(nil, nil)
		camberProc, _ := h.processFor(DefaultAgentServerName, gCtx)
		camberProc.state = processState{kind: processStateRunning}
		camberProc.stdin = nopWriteCloser{}
		codexProc, _ := h.processFor("codex-acp", gCtx)
		codexProc.state = processState{kind: processStateRunning}
		codexProc.stdin = nopWriteCloser{}

		before := map[string]AgentServerConfig{
			DefaultAgentServerName: {
				Command:              "pool",
				Args:                 []string{"acp"},
				DefaultConfigOptions: map[string]string{"model": "old"},
			},
			"codex-acp": {
				Command: "npx",
				Args:    []string{"-y", "@zed-industries/codex-acp@0.16.0"},
			},
		}
		after := map[string]AgentServerConfig{
			DefaultAgentServerName: {
				Command:              "pool",
				Args:                 []string{"acp"},
				DefaultConfigOptions: map[string]string{"model": "new"},
			},
			"codex-acp": {
				Command: "npx",
				Args:    []string{"-y", "@zed-industries/codex-acp@0.16.0"},
			},
		}

		require.NoError(t, h.StopChangedAgentServers(before, after))
		assert.Equal(t, processStateRunning, camberProc.state.kind)
		assert.Equal(t, processStateRunning, codexProc.state.kind)
	})

	t.Run("stops only the changed server", func(t *testing.T) {
		h := NewHandler(dummyConfig(), nil, nil)
		gCtx := newGlspContext(nil, nil)
		camberProc, _ := h.processFor(DefaultAgentServerName, gCtx)
		camberProc.state = processState{kind: processStateRunning}
		camberProc.stdin = nopWriteCloser{}
		codexProc, _ := h.processFor("codex-acp", gCtx)
		codexProc.state = processState{kind: processStateRunning}
		codexProc.stdin = nopWriteCloser{}

		before := map[string]AgentServerConfig{
			DefaultAgentServerName: {Command: "pool", Args: []string{"acp"}},
			"codex-acp":            {Command: "npx", Args: []string{"-y", "@zed-industries/codex-acp@0.16.0"}},
		}
		after := map[string]AgentServerConfig{
			DefaultAgentServerName: {Command: "pool", Args: []string{"acp"}},
			"codex-acp":            {Command: "npx", Args: []string{"-y", "@zed-industries/codex-acp@0.17.0"}},
		}

		require.NoError(t, h.StopChangedAgentServers(before, after))
		assert.Equal(t, processStateRunning, camberProc.state.kind)
		assert.Equal(t, processStateUnstarted, codexProc.state.kind)
	})

	t.Run("stops removed servers", func(t *testing.T) {
		h := NewHandler(dummyConfig(), nil, nil)
		gCtx := newGlspContext(nil, nil)
		codexProc, _ := h.processFor("codex-acp", gCtx)
		codexProc.state = processState{kind: processStateRunning}
		codexProc.stdin = nopWriteCloser{}

		before := map[string]AgentServerConfig{
			DefaultAgentServerName: {Command: "pool", Args: []string{"acp"}},
			"codex-acp":            {Command: "npx", Args: []string{"-y", "@zed-industries/codex-acp@0.16.0"}},
		}
		after := map[string]AgentServerConfig{
			DefaultAgentServerName: {Command: "pool", Args: []string{"acp"}},
		}

		require.NoError(t, h.StopChangedAgentServers(before, after))
		assert.Equal(t, processStateUnstarted, codexProc.state.kind)
	})

	t.Run("names the server that failed to stop", func(t *testing.T) {
		h := NewHandler(dummyConfig(), nil, nil)
		gCtx := newGlspContext(nil, nil)
		codexProc, _ := h.processFor("codex-acp", gCtx)
		codexProc.serverName = "codex-acp"
		codexProc.state = processState{kind: processStateRunning}
		codexProc.stdin = errWriteCloser{err: errors.New("pipe already closed")}

		before := map[string]AgentServerConfig{
			DefaultAgentServerName: {Command: "pool", Args: []string{"acp"}},
			"codex-acp":            {Command: "npx", Args: []string{"-y", "@zed-industries/codex-acp@0.16.0"}},
		}
		after := map[string]AgentServerConfig{
			DefaultAgentServerName: {Command: "pool", Args: []string{"acp"}},
		}

		err := h.StopChangedAgentServers(before, after)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "codex-acp")
		assert.Contains(t, err.Error(), "pipe already closed")
	})
}

// stopProcesses must run stops concurrently: each stop can wait for a
// subprocess to exit gracefully (see process.stop), so a serial loop would
// add those waits together and delay helper shutdown by seconds per agent.
// Every stdin close blocks until all of them are in flight, so a serial
// revert deadlocks here instead of passing slowly.
func TestStopProcessesStopsConcurrently(t *testing.T) {
	const n = 3
	arrived := make(chan struct{}, n)
	release := make(chan struct{})
	procs := make([]*process, 0, n)
	for i := range n {
		procs = append(procs, &process{
			serverName: fmt.Sprintf("agent-%d", i),
			state:      processState{kind: processStateRunning},
			stdin:      barrierWriteCloser{arrived: arrived, release: release},
		})
	}
	go func() {
		for range n {
			<-arrived
		}
		close(release)
	}()

	done := make(chan error, 1)
	go func() { done <- stopProcesses(procs) }()
	select {
	case err := <-done:
		require.NoError(t, err)
	case <-time.After(5 * time.Second):
		t.Fatal("stopProcesses appears to stop serially: the stdin closes never overlapped")
	}
}

type errWriteCloser struct{ err error }

func (errWriteCloser) Write(p []byte) (int, error) { return len(p), nil }
func (w errWriteCloser) Close() error              { return w.err }

// barrierWriteCloser's Close announces itself and blocks until released.
type barrierWriteCloser struct {
	arrived chan<- struct{}
	release <-chan struct{}
}

func (barrierWriteCloser) Write(p []byte) (int, error) { return len(p), nil }

func (b barrierWriteCloser) Close() error {
	b.arrived <- struct{}{}
	<-b.release
	return nil
}

func TestAgentServerConfigIsSafeForDeepEqualRuntimeComparison(t *testing.T) {
	assertDeepEqualSafeType(t, reflect.TypeOf(AgentServerConfig{}), map[reflect.Type]bool{})
}

func assertDeepEqualSafeType(t *testing.T, typ reflect.Type, seen map[reflect.Type]bool) {
	t.Helper()
	if seen[typ] {
		return
	}
	seen[typ] = true

	switch typ.Kind() {
	case reflect.Func:
		t.Fatalf("%s contains a func, which is unsafe for reflect.DeepEqual config comparisons", typ)
	case reflect.Float32, reflect.Float64:
		t.Fatalf("%s contains a float, which can be unsafe for reflect.DeepEqual config comparisons", typ)
	case reflect.Pointer, reflect.Slice, reflect.Array:
		assertDeepEqualSafeType(t, typ.Elem(), seen)
	case reflect.Map:
		assertDeepEqualSafeType(t, typ.Key(), seen)
		assertDeepEqualSafeType(t, typ.Elem(), seen)
	case reflect.Struct:
		for i := range typ.NumField() {
			field := typ.Field(i)
			assertDeepEqualSafeType(t, field.Type, seen)
		}
	}
}

func TestMethodsRequireInitialization(t *testing.T) {
	h := NewHandler(dummyConfig(), nil, nil)
	gCtx := newGlspContext(nil, nil)

	_, err := h.NewSession(context.Background(), &methods.ACPNewSessionParams{}, gCtx)
	require.ErrorContains(t, err, "call initialize first")

	_, err = h.LoadSession(context.Background(), &methods.ACPLoadSessionParams{}, gCtx)
	require.ErrorContains(t, err, "call initialize first")

	_, err = h.ResumeSession(context.Background(), &methods.ACPResumeSessionParams{}, gCtx)
	require.ErrorContains(t, err, "call initialize first")

	_, err = h.ListSessions(context.Background(), &methods.ACPListSessionsParams{}, gCtx)
	require.ErrorContains(t, err, "call initialize first")

	_, err = h.Prompt(context.Background(), &methods.ACPPromptParams{}, gCtx)
	require.ErrorContains(t, err, "call initialize first")

	_, err = h.Steer(context.Background(), &methods.ACPSteerParams{}, gCtx)
	require.ErrorContains(t, err, "call initialize first")

	_, err = h.Cancel(context.Background(), &methods.ACPCancelParams{}, gCtx)
	require.ErrorContains(t, err, "call initialize first")

	_, err = h.SetMode(context.Background(), &methods.ACPSetModeParams{}, gCtx)
	require.ErrorContains(t, err, "call initialize first")

	_, err = h.SetConfigOption(context.Background(), &methods.ACPSetConfigOptionParams{}, gCtx)
	require.ErrorContains(t, err, "call initialize first")
}

func TestSessionMethodsRequireSession(t *testing.T) {
	h := NewHandler(dummyConfig(), nil, nil)
	gCtx := newGlspContext(nil, nil)
	proc, _ := h.processFor(DefaultAgentServerName, gCtx)
	proc.state = processState{kind: processStateRunning}
	proc.conn = &acpsdk.ClientSideConnection{}
	proc.initResp = &acpsdk.InitializeResponse{
		ProtocolVersion: acpsdk.ProtocolVersionNumber,
	}

	_, err := h.Prompt(context.Background(), &methods.ACPPromptParams{}, gCtx)
	require.ErrorContains(t, err, "call session/new first")

	_, err = h.Cancel(context.Background(), &methods.ACPCancelParams{}, gCtx)
	require.ErrorContains(t, err, "call session/new first")

	_, err = h.SetMode(context.Background(), &methods.ACPSetModeParams{}, gCtx)
	require.ErrorContains(t, err, "call session/new first")

	_, err = h.SetConfigOption(context.Background(), &methods.ACPSetConfigOptionParams{}, gCtx)
	require.ErrorContains(t, err, "call session/new first")
}

func TestPromptRejectsConcurrentTurnForSameSession(t *testing.T) {
	h := NewHandler(dummyConfig(), nil, nil)
	gCtx := newGlspContext(nil, nil)
	proc, _ := h.processFor(DefaultAgentServerName, gCtx)
	proc.state = processState{kind: processStateRunning}
	proc.conn = &acpsdk.ClientSideConnection{}
	proc.initResp = &acpsdk.InitializeResponse{
		ProtocolVersion: acpsdk.ProtocolVersionNumber,
	}
	proc.session = "sess-1"

	// Simulate a turn already running for the session (started by any
	// connected surface); the reservation is what Prompt takes internally.
	turn, reserved := h.beginPromptInFlight(DefaultAgentServerName, "sess-1", "turn-1")
	require.True(t, reserved)
	require.NotNil(t, turn)

	_, err := h.Prompt(context.Background(), &methods.ACPPromptParams{}, gCtx)
	require.ErrorContains(t, err, "a turn is already running")

	// An explicit session ID resolves to the same reservation.
	_, err = h.Prompt(context.Background(), &methods.ACPPromptParams{
		PromptRequest: acpsdk.PromptRequest{SessionId: "sess-1"},
	}, gCtx)
	require.ErrorContains(t, err, "a turn is already running")

	// Other sessions are unaffected, and finishing the turn frees the session.
	turn2, reserved2 := h.beginPromptInFlight(DefaultAgentServerName, "sess-2", "")
	assert.True(t, reserved2)
	require.NotNil(t, turn2)
	h.completeTurn(DefaultAgentServerName, "sess-1", turn, nil, nil)
	_, reserved = h.beginPromptInFlight(DefaultAgentServerName, "sess-1", "")
	assert.True(t, reserved)
}

func TestPromptAttachesToRunningTurnWithSameTurnID(t *testing.T) {
	h := NewHandler(dummyConfig(), nil, nil)
	gCtx := newGlspContext(nil, nil)
	proc, _ := h.processFor(DefaultAgentServerName, gCtx)
	proc.state = processState{kind: processStateRunning}
	proc.conn = &acpsdk.ClientSideConnection{}
	proc.initResp = &acpsdk.InitializeResponse{
		ProtocolVersion: acpsdk.ProtocolVersionNumber,
	}
	proc.session = "sess-1"

	turn, reserved := h.beginPromptInFlight(DefaultAgentServerName, "sess-1", "turn-1")
	require.True(t, reserved)

	// A retry of the same turn (its connection dropped mid-turn) attaches and
	// resolves with the running turn's result.
	attached := make(chan error, 1)
	go func() {
		resp, err := h.Prompt(context.Background(), &methods.ACPPromptParams{
			PromptRequest: acpsdk.PromptRequest{
				SessionId: "sess-1",
				Meta:      map[string]any{"camber/turnId": "turn-1"},
			},
		}, gCtx)
		if err == nil && resp != nil && resp.StopReason == acpsdk.StopReasonEndTurn {
			attached <- nil
		} else {
			attached <- fmt.Errorf("unexpected attach result: %v / %v", resp, err)
		}
	}()

	// A different turnID is still rejected while the turn runs.
	_, err := h.Prompt(context.Background(), &methods.ACPPromptParams{
		PromptRequest: acpsdk.PromptRequest{
			SessionId: "sess-1",
			Meta:      map[string]any{"camber/turnId": "turn-other"},
		},
	}, gCtx)
	require.ErrorContains(t, err, "a turn is already running")

	h.completeTurn(DefaultAgentServerName, "sess-1", turn,
		&methods.ACPPromptOutput{StopReason: acpsdk.StopReasonEndTurn}, nil)
	select {
	case err := <-attached:
		require.NoError(t, err)
	case <-time.After(2 * time.Second):
		t.Fatal("attached retry never resolved")
	}

	// After completion the turnID resolves from the finished-turn cache
	// without touching the agent.
	resp, err := h.Prompt(context.Background(), &methods.ACPPromptParams{
		PromptRequest: acpsdk.PromptRequest{
			SessionId: "sess-1",
			Meta:      map[string]any{"camber/turnId": "turn-1"},
		},
	}, gCtx)
	require.NoError(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, acpsdk.StopReasonEndTurn, resp.StopReason)
}

func TestPromptReturnsMCPConnectorCredentialsErrorReportedOnStderr(t *testing.T) {
	agentInR, agentInW := io.Pipe()
	agentOutR, agentOutW := io.Pipe()
	t.Cleanup(func() {
		agentInR.Close()
		agentInW.Close()
		agentOutR.Close()
		agentOutW.Close()
	})

	promptReceived := make(chan struct{}, 1)
	go func() {
		scanner := bufio.NewScanner(agentInR)
		for scanner.Scan() {
			var req struct {
				Method string `json:"method"`
			}
			if json.Unmarshal(scanner.Bytes(), &req) == nil && req.Method == acpsdk.AgentMethodSessionPrompt {
				select {
				case promptReceived <- struct{}{}:
				default:
				}
			}
		}
	}()

	h := NewHandler(func() HandlerConfig {
		return HandlerConfig{AgentServers: map[string]AgentServerConfig{
			"codex-acp": {Command: "unused-in-test"},
		}}
	}, nil, nil)
	gCtx := newGlspContext(nil, nil)
	proc, client := h.processFor("codex-acp", gCtx)
	proc.state = processState{kind: processStateRunning}
	proc.conn = acpsdk.NewClientSideConnection(client, agentInW, agentOutR)
	proc.initResp = &acpsdk.InitializeResponse{ProtocolVersion: acpsdk.ProtocolVersionNumber}
	proc.session = "sess-1"

	promptDone := make(chan error, 1)
	go func() {
		_, err := h.Prompt(context.Background(), &methods.ACPPromptParams{
			ACPAgentServerParams: methods.ACPAgentServerParams{AgentServer: "codex-acp"},
			PromptRequest: acpsdk.PromptRequest{
				SessionId: "sess-1",
			},
		}, gCtx)
		promptDone <- err
	}()

	select {
	case <-promptReceived:
	case <-time.After(time.Second):
		t.Fatal("prompt was not forwarded to the agent")
	}
	proc.failActivePromptsFor(proc.cmd, &mcpConnectorCredentialsError{})

	select {
	case err := <-promptDone:
		var connectorErr *mcpConnectorCredentialsError
		require.ErrorAs(t, err, &connectorErr)
		assert.Contains(t, err.Error(), "reconnect the connector")
	case <-time.After(time.Second):
		t.Fatal("prompt stayed blocked after the runtime credentials error")
	}
}

func TestSteerForwardsNativeExtension(t *testing.T) {
	agentInR, agentInW := io.Pipe()
	agentOutR, agentOutW := io.Pipe()
	t.Cleanup(func() {
		agentInR.Close()
		agentInW.Close()
		agentOutR.Close()
		agentOutW.Close()
	})

	type wireRequest struct {
		ID     any             `json:"id"`
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
	}
	requests := make(chan wireRequest, 1)
	go func() {
		scanner := bufio.NewScanner(agentInR)
		for scanner.Scan() {
			var req wireRequest
			if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
				continue
			}
			requests <- req
			resp, _ := json.Marshal(map[string]any{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"result":  map[string]any{"outcome": "injected"},
			})
			if _, err := agentOutW.Write(append(resp, '\n')); err != nil {
				return
			}
		}
	}()

	h := NewHandler(func() HandlerConfig {
		return HandlerConfig{AgentServers: map[string]AgentServerConfig{
			"claude-acp": {Command: "unused-in-test"},
		}}
	}, nil, nil)
	sink := &fakeEventSink{}
	h.SetSessionEvents(sink)
	gCtx := newGlspContext(nil, nil)
	proc, client := h.processFor("claude-acp", gCtx)
	proc.state = processState{kind: processStateRunning}
	proc.conn = acpsdk.NewClientSideConnection(client, agentInW, agentOutR)
	proc.initResp = &acpsdk.InitializeResponse{ProtocolVersion: acpsdk.ProtocolVersionNumber}

	resp, err := h.Steer(context.Background(), &methods.ACPSteerParams{
		ACPAgentServerParams: methods.ACPAgentServerParams{AgentServer: "claude-acp"},
		ACPSteerRequest: methods.ACPSteerRequest{
			SessionID: "sess-1",
			Prompt: []acpsdk.ContentBlock{{
				Text: &acpsdk.ContentBlockText{Type: "text", Text: "focus on the failing test"},
			}},
			Meta: map[string]any{"steering": map[string]any{"idleBehavior": "promptRequired"}},
		},
	}, gCtx)

	require.NoError(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, methods.ACPSteerOutcomeInjected, resp.Outcome)
	waitFor(t, func() bool {
		published, _ := sink.snapshot()
		return len(published) == 1
	})
	published, _ := sink.snapshot()
	paramsMap, ok := published[0].message["params"].(map[string]any)
	require.True(t, ok)
	update, ok := paramsMap["update"].(map[string]any)
	require.True(t, ok)
	assert.Equal(t, map[string]any{
		methods.ACPUserMessageSteerMetaKey: true,
	}, update["_meta"])

	select {
	case req := <-requests:
		assert.Equal(t, methods.ACPSessionSteeringExtensionMethod, req.Method)
		var params methods.ACPSteerRequest
		require.NoError(t, json.Unmarshal(req.Params, &params))
		assert.Equal(t, acpsdk.SessionId("sess-1"), params.SessionID)
		require.Len(t, params.Prompt, 1)
		require.NotNil(t, params.Prompt[0].Text)
		assert.Equal(t, "focus on the failing test", params.Prompt[0].Text.Text)
		assert.Equal(t, map[string]any{"steering": map[string]any{"idleBehavior": "promptRequired"}}, params.Meta)
	case <-time.After(time.Second):
		require.FailNow(t, "steering request was not forwarded to the agent")
	}
}

func TestPromptSkipsUserMessageMirrorForSteerFallback(t *testing.T) {
	for _, tt := range []struct {
		name             string
		meta             map[string]any
		wantUserMessages int
	}{
		{name: "ordinary prompt mirrors its user message", meta: nil, wantUserMessages: 1},
		{
			name:             "steer fallback prompt is not mirrored again",
			meta:             map[string]any{methods.ACPSteerFallbackMetaKey: true},
			wantUserMessages: 0,
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			agentInR, agentInW := io.Pipe()
			agentOutR, agentOutW := io.Pipe()
			t.Cleanup(func() {
				agentInR.Close()
				agentInW.Close()
				agentOutR.Close()
				agentOutW.Close()
			})

			go func() {
				scanner := bufio.NewScanner(agentInR)
				if !scanner.Scan() {
					return
				}
				var req struct {
					ID any `json:"id"`
				}
				if json.Unmarshal(scanner.Bytes(), &req) != nil {
					return
				}
				resp, _ := json.Marshal(map[string]any{
					"jsonrpc": "2.0",
					"id":      req.ID,
					"result":  map[string]any{"stopReason": "end_turn"},
				})
				if _, err := agentOutW.Write(append(resp, '\n')); err != nil {
					return
				}
			}()

			h := NewHandler(func() HandlerConfig {
				return HandlerConfig{AgentServers: map[string]AgentServerConfig{
					DefaultAgentServerName: {Command: "unused-in-test"},
				}}
			}, nil, nil)
			sink := &fakeEventSink{}
			h.SetSessionEvents(sink)
			gCtx := newGlspContext(nil, nil)
			proc, client := h.processFor(DefaultAgentServerName, gCtx)
			proc.state = processState{kind: processStateRunning}
			proc.conn = acpsdk.NewClientSideConnection(client, agentInW, agentOutR)
			proc.initResp = &acpsdk.InitializeResponse{ProtocolVersion: acpsdk.ProtocolVersionNumber}
			proc.session = "sess-1"

			resp, err := h.Prompt(context.Background(), &methods.ACPPromptParams{
				ACPAgentServerParams: methods.ACPAgentServerParams{AgentServer: DefaultAgentServerName},
				PromptRequest: acpsdk.PromptRequest{
					SessionId: "sess-1",
					Prompt: []acpsdk.ContentBlock{{
						Text: &acpsdk.ContentBlockText{Type: "text", Text: "focus on the failing test"},
					}},
					Meta: tt.meta,
				},
			}, gCtx)
			require.NoError(t, err)
			require.NotNil(t, resp)
			require.NoError(t, client.waitForSessionUpdates(context.Background()))

			published, _ := sink.snapshot()
			userMessages := 0
			for _, entry := range published {
				if entry.message["method"] == acpsdk.ClientMethodSessionUpdate {
					userMessages++
				}
			}
			assert.Equal(t, tt.wantUserMessages, userMessages)
		})
	}
}

func TestClaudeSteerKeepsPromptOpenThroughContinuation(t *testing.T) {
	for _, tt := range []struct {
		name                string
		earlyPromptResponse func(id any) map[string]any
	}{
		{
			name: "normal prompt response",
			earlyPromptResponse: func(id any) map[string]any {
				return map[string]any{
					"jsonrpc": "2.0",
					"id":      id,
					"result":  map[string]any{"stopReason": "end_turn"},
				}
			},
		},
		{
			name: "user result diagnostic",
			earlyPromptResponse: func(id any) map[string]any {
				return map[string]any{
					"jsonrpc": "2.0",
					"id":      id,
					"error": map[string]any{
						"code":    -32603,
						"message": "Internal error: " + steeringTurnBoundaryDiagnostic,
					},
				}
			},
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			agentInR, agentInW := io.Pipe()
			agentOutR, agentOutW := io.Pipe()
			t.Cleanup(func() {
				agentInR.Close()
				agentInW.Close()
				agentOutR.Close()
				agentOutW.Close()
			})

			type wireRequest struct {
				ID     any    `json:"id"`
				Method string `json:"method"`
			}
			promptReceived := make(chan struct{})
			earlyPromptSettled := make(chan struct{})
			finishContinuation := make(chan struct{})
			agentDone := make(chan struct{})
			go func() {
				defer close(agentDone)
				write := func(message map[string]any) bool {
					encoded, _ := json.Marshal(message)
					_, err := agentOutW.Write(append(encoded, '\n'))
					return err == nil
				}
				usageUpdate := func(used int, origin string) map[string]any {
					update := map[string]any{
						"sessionUpdate": "usage_update",
						"used":          used,
						"size":          200_000,
						"cost": map[string]any{
							"amount":   0.01,
							"currency": "USD",
						},
					}
					if origin != "" {
						update["_meta"] = map[string]any{
							"_claude/origin": map[string]any{"kind": origin},
						}
					}
					return map[string]any{
						"jsonrpc": "2.0",
						"method":  acpsdk.ClientMethodSessionUpdate,
						"params": map[string]any{
							"sessionId": "sess-1",
							"update":    update,
						},
					}
				}

				var promptID any
				scanner := bufio.NewScanner(agentInR)
				for scanner.Scan() {
					var req wireRequest
					if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
						continue
					}
					switch req.Method {
					case acpsdk.AgentMethodSessionPrompt:
						promptID = req.ID
						close(promptReceived)
					case methods.ACPSessionSteeringExtensionMethod:
						if !write(map[string]any{
							"jsonrpc": "2.0",
							"id":      req.ID,
							"result":  map[string]any{"outcome": "injected"},
						}) || !write(usageUpdate(100, "")) || !write(tt.earlyPromptResponse(promptID)) {
							return
						}
						close(earlyPromptSettled)
						<-finishContinuation
						write(map[string]any{
							"jsonrpc": "2.0",
							"method":  acpsdk.ClientMethodSessionUpdate,
							"params": map[string]any{
								"sessionId": "sess-1",
								"update": map[string]any{
									"sessionUpdate": "agent_message_chunk",
									"content":       map[string]any{"type": "text", "text": "continued"},
								},
							},
						})
						write(usageUpdate(150, "user"))
						return
					}
				}
			}()

			h := NewHandler(func() HandlerConfig {
				return HandlerConfig{AgentServers: map[string]AgentServerConfig{
					"claude-acp": {Command: "unused-in-test"},
				}}
			}, nil, nil)
			gCtx := newGlspContext(nil, nil)
			proc, client := h.processFor("claude-acp", gCtx)
			proc.state = processState{kind: processStateRunning}
			proc.conn = acpsdk.NewClientSideConnection(client, agentInW, agentOutR)
			proc.initResp = &acpsdk.InitializeResponse{
				ProtocolVersion: acpsdk.ProtocolVersionNumber,
				AgentInfo:       &acpsdk.Implementation{Name: claudeAgentPackageName},
			}
			proc.session = "sess-1"

			type promptResult struct {
				resp *methods.ACPPromptOutput
				err  error
			}
			promptDone := make(chan promptResult, 1)
			go func() {
				resp, err := h.Prompt(context.Background(), &methods.ACPPromptParams{
					ACPAgentServerParams: methods.ACPAgentServerParams{AgentServer: "claude-acp"},
					PromptRequest: acpsdk.PromptRequest{
						SessionId: "sess-1",
						Prompt: []acpsdk.ContentBlock{{
							Text: &acpsdk.ContentBlockText{Type: "text", Text: "write a long poem"},
						}},
					},
				}, gCtx)
				promptDone <- promptResult{resp: resp, err: err}
			}()

			select {
			case <-promptReceived:
			case <-time.After(time.Second):
				t.Fatal("prompt was not forwarded to the agent")
			}

			steerResp, err := h.Steer(context.Background(), &methods.ACPSteerParams{
				ACPAgentServerParams: methods.ACPAgentServerParams{AgentServer: "claude-acp"},
				ACPSteerRequest: methods.ACPSteerRequest{
					SessionID: "sess-1",
					Prompt: []acpsdk.ContentBlock{{
						Text: &acpsdk.ContentBlockText{Type: "text", Text: "make it shorter"},
					}},
				},
			}, gCtx)
			require.NoError(t, err)
			require.NotNil(t, steerResp)
			assert.Equal(t, methods.ACPSteerOutcomeInjected, steerResp.Outcome)

			select {
			case <-earlyPromptSettled:
			case <-time.After(time.Second):
				t.Fatal("fake agent did not settle the interrupted prompt")
			}
			select {
			case result := <-promptDone:
				t.Fatalf("prompt settled before the steered continuation: %#v", result)
			case <-time.After(50 * time.Millisecond):
			}

			close(finishContinuation)
			select {
			case result := <-promptDone:
				require.NoError(t, result.err)
				require.NotNil(t, result.resp)
				assert.Equal(t, acpsdk.StopReasonEndTurn, result.resp.StopReason)
			case <-time.After(time.Second):
				t.Fatal("prompt did not settle after the steered continuation")
			}
			select {
			case <-agentDone:
			case <-time.After(time.Second):
				t.Fatal("fake agent did not finish")
			}
		})
	}
}

func TestCodexGoalControlForwardsNativeExtension(t *testing.T) {
	agentInR, agentInW := io.Pipe()
	agentOutR, agentOutW := io.Pipe()
	t.Cleanup(func() {
		agentInR.Close()
		agentInW.Close()
		agentOutR.Close()
		agentOutW.Close()
	})

	type wireRequest struct {
		ID     any             `json:"id"`
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
	}
	requests := make(chan wireRequest, 1)
	go func() {
		scanner := bufio.NewScanner(agentInR)
		if !scanner.Scan() {
			return
		}
		var req wireRequest
		if json.Unmarshal(scanner.Bytes(), &req) != nil {
			return
		}
		requests <- req
		notification, _ := json.Marshal(map[string]any{
			"jsonrpc": "2.0",
			"method":  acpsdk.ClientMethodSessionUpdate,
			"params": map[string]any{
				"sessionId": "sess-1",
				"update": map[string]any{
					"sessionUpdate": "session_info_update",
					"title":         "Goal paused",
				},
			},
		})
		agentOutW.Write(append(notification, '\n'))
		encoded, _ := json.Marshal(map[string]any{
			"jsonrpc": "2.0",
			"id":      req.ID,
			"result":  map[string]any{},
		})
		agentOutW.Write(append(encoded, '\n'))
	}()

	h := NewHandler(func() HandlerConfig {
		return HandlerConfig{AgentServers: map[string]AgentServerConfig{
			"codex-acp": {Command: "unused-in-test"},
		}}
	}, nil, nil)
	notifyStarted := make(chan notifyCapture, 1)
	releaseNotify := make(chan struct{})
	gCtx := &glsp.Context{
		Notify: func(_ context.Context, method string, params any) error {
			notifyStarted <- notifyCapture{method: method, params: params}
			<-releaseNotify
			return nil
		},
		Call: func(_ context.Context, _ string, _ any, _ any) error { return nil },
	}
	proc, client := h.processFor("codex-acp", gCtx)
	proc.state = processState{kind: processStateRunning}
	proc.conn = acpsdk.NewClientSideConnection(client, agentInW, agentOutR)
	proc.initResp = &acpsdk.InitializeResponse{ProtocolVersion: acpsdk.ProtocolVersionNumber}

	type controlResult struct {
		resp *methods.ACPCodexGoalControlOutput
		err  error
	}
	controlDone := make(chan controlResult, 1)
	go func() {
		resp, err := h.CodexGoalControl(context.Background(), &methods.ACPCodexGoalControlParams{
			ACPAgentServerParams: methods.ACPAgentServerParams{AgentServer: "codex-acp"},
			ACPCodexGoalControlRequest: methods.ACPCodexGoalControlRequest{
				SessionID: "sess-1",
				Action:    methods.ACPCodexGoalControlPause,
			},
		}, gCtx)
		controlDone <- controlResult{resp: resp, err: err}
	}()

	var delivered notifyCapture
	select {
	case delivered = <-notifyStarted:
	case <-time.After(time.Second):
		close(releaseNotify)
		require.FailNow(t, "goal update was not queued for client delivery")
	}
	returnedBeforeDelivery := false
	select {
	case <-controlDone:
		returnedBeforeDelivery = true
	case <-time.After(50 * time.Millisecond):
	}
	close(releaseNotify)
	require.False(t, returnedBeforeDelivery, "goal control returned before its goal update was delivered")

	result := <-controlDone
	require.NoError(t, result.err)
	require.NotNil(t, result.resp)
	assert.Equal(t, methods.JSONRPCNotifyMethod, delivered.method)
	select {
	case req := <-requests:
		assert.Equal(t, methods.ACPCodexGoalControlExtensionMethod, req.Method)
		var params methods.ACPCodexGoalControlRequest
		require.NoError(t, json.Unmarshal(req.Params, &params))
		assert.Equal(t, acpsdk.SessionId("sess-1"), params.SessionID)
		assert.Equal(t, methods.ACPCodexGoalControlPause, params.Action)
	case <-time.After(time.Second):
		require.FailNow(t, "goal control request was not forwarded to the agent")
	}
}

func TestCodexGoalControlRejectsInvalidRequests(t *testing.T) {
	h := NewHandler(dummyConfig(), nil, nil)
	gCtx := newGlspContext(nil, nil)

	_, err := h.CodexGoalControl(context.Background(), &methods.ACPCodexGoalControlParams{}, gCtx)
	require.ErrorContains(t, err, "sessionId is required")

	_, err = h.CodexGoalControl(context.Background(), &methods.ACPCodexGoalControlParams{
		ACPCodexGoalControlRequest: methods.ACPCodexGoalControlRequest{
			SessionID: "sess-1",
			Action:    "resume",
		},
	}, gCtx)
	require.ErrorContains(t, err, "unsupported action")
}

func TestClaudeSteerCompletionWaitReleasesOnCancel(t *testing.T) {
	h := NewHandler(dummyConfig(), nil, nil)
	turn, reserved := h.beginPromptInFlight("claude-acp", "sess-1", "")
	require.True(t, reserved)
	require.True(t, h.beginPromptSteer("claude-acp", "sess-1"))
	h.finishPromptSteer("claude-acp", "sess-1", true, true)

	type waitResult struct {
		completion claudeSteerCompletion
		err        error
	}
	done := make(chan waitResult, 1)
	go func() {
		completion, err := h.waitForClaudeSteeredCompletion(context.Background(), turn)
		done <- waitResult{completion: completion, err: err}
	}()

	select {
	case result := <-done:
		t.Fatalf("completion wait returned before cancellation: %#v", result)
	case <-time.After(50 * time.Millisecond):
	}

	h.cancelPromptWait("claude-acp", "sess-1")
	select {
	case result := <-done:
		require.NoError(t, result.err)
		assert.True(t, result.completion.accepted)
		assert.True(t, result.completion.cancelled)
	case <-time.After(time.Second):
		t.Fatal("completion wait did not release after cancellation")
	}
}

func TestClaudeAutonomousUsageUpdate(t *testing.T) {
	for _, tt := range []struct {
		kind       string
		autonomous bool
	}{
		{kind: "task-notification", autonomous: true},
		{kind: "peer", autonomous: true},
		{kind: "coordinator", autonomous: true},
		{kind: "observer", autonomous: true},
		{kind: "observer-activity", autonomous: true},
		{kind: "user", autonomous: false},
		{kind: "", autonomous: false},
	} {
		t.Run(tt.kind, func(t *testing.T) {
			usage := &acpsdk.SessionUsageUpdate{}
			if tt.kind != "" {
				usage.Meta = map[string]any{
					"_claude/origin": map[string]any{"kind": tt.kind},
				}
			}
			assert.Equal(t, tt.autonomous, isClaudeAutonomousUsageUpdate(usage))
		})
	}
}

func TestProcessReadyForSessionPreflight(t *testing.T) {
	t.Run("keeps healthy process", func(t *testing.T) {
		calls := 0
		h := NewHandler(preflightConfig(func(_ context.Context, agentServer string) (bool, error) {
			calls++
			assert.Equal(t, LocalAgentServerName, agentServer)
			return true, nil
		}), nil, nil)
		gCtx := newGlspContext(nil, nil)
		proc, _ := h.processFor(LocalAgentServerName, gCtx)
		proc.state = processState{kind: processStateRunning}
		proc.stdin = nopWriteCloser{}
		proc.initResp = &acpsdk.InitializeResponse{ProtocolVersion: acpsdk.ProtocolVersionNumber}

		got, err := h.processReadyForSession(context.Background(), gCtx, LocalAgentServerName)

		require.NoError(t, err)
		assert.Same(t, proc, got)
		assert.Equal(t, 1, calls)
		assert.Equal(t, processStateRunning, proc.state.kind)
		assert.NotNil(t, proc.stdin)
	})

	t.Run("restarts unhealthy process", func(t *testing.T) {
		calls := 0
		h := NewHandler(preflightConfig(func(_ context.Context, agentServer string) (bool, error) {
			calls++
			assert.Equal(t, LocalAgentServerName, agentServer)
			return false, nil
		}), nil, nil)
		gCtx := newGlspContext(nil, nil)
		proc, _ := h.processFor(LocalAgentServerName, gCtx)
		proc.state = processState{kind: processStateRunning}
		proc.stdin = nopWriteCloser{}
		proc.initResp = &acpsdk.InitializeResponse{ProtocolVersion: acpsdk.ProtocolVersionNumber}
		proc.initReq = &acpsdk.InitializeRequest{
			ProtocolVersion: acpsdk.ProtocolVersionNumber,
			ClientInfo: &acpsdk.Implementation{
				Name:    "camber-test",
				Version: "test",
			},
		}

		_, err := h.processReadyForSession(context.Background(), gCtx, LocalAgentServerName)

		require.ErrorContains(t, err, "acpproxy: start")
		assert.Equal(t, 1, calls)
		assert.Equal(t, processStateUnstarted, proc.state.kind)
		assert.Nil(t, proc.stdin)
		req := proc.initializeRequest()
		require.NotNil(t, req)
		require.NotNil(t, req.ClientInfo)
		assert.Equal(t, "camber-test", req.ClientInfo.Name)
	})

	t.Run("skips stopped process", func(t *testing.T) {
		calls := 0
		h := NewHandler(preflightConfig(func(context.Context, string) (bool, error) {
			calls++
			return false, nil
		}), nil, nil)
		gCtx := newGlspContext(nil, nil)

		_, err := h.processReadyForSession(context.Background(), gCtx, LocalAgentServerName)

		require.NoError(t, err)
		assert.Equal(t, 0, calls)
	})
}

func TestProcessReadyForSessionSelfHeal(t *testing.T) {
	t.Run("restarts exited process with retained initialize request", func(t *testing.T) {
		h := NewHandler(preflightConfig(nil), nil, nil)
		gCtx := newGlspContext(nil, nil)
		proc, _ := h.processFor(LocalAgentServerName, gCtx)
		proc.state = processState{kind: processStateExited}
		proc.initReq = &acpsdk.InitializeRequest{
			ProtocolVersion: acpsdk.ProtocolVersionNumber,
			ClientInfo: &acpsdk.Implementation{
				Name:    "camber-test",
				Version: "test",
			},
		}

		_, err := h.processReadyForSession(context.Background(), gCtx, LocalAgentServerName)

		// The restart attempt reached spawn (and failed on the test's
		// nonexistent binary) instead of leaving the dead slot to fail the
		// session call with "not initialized".
		require.ErrorContains(t, err, "acpproxy: start")
		req := proc.initializeRequest()
		require.NotNil(t, req)
		require.NotNil(t, req.ClientInfo)
		assert.Equal(t, "camber-test", req.ClientInfo.Name)
	})

	t.Run("leaves a never-initialized slot for the initialize-first error", func(t *testing.T) {
		h := NewHandler(preflightConfig(nil), nil, nil)
		gCtx := newGlspContext(nil, nil)

		_, err := h.processReadyForSession(context.Background(), gCtx, LocalAgentServerName)

		require.NoError(t, err)
	})

	t.Run("declines to restart once the handler is closed", func(t *testing.T) {
		h := NewHandler(preflightConfig(nil), nil, nil)
		gCtx := newGlspContext(nil, nil)
		proc, _ := h.processFor(LocalAgentServerName, gCtx)
		proc.state = processState{kind: processStateExited}
		proc.initReq = &acpsdk.InitializeRequest{ProtocolVersion: acpsdk.ProtocolVersionNumber}
		require.NoError(t, h.Close())

		_, err := h.processReadyForSession(context.Background(), gCtx, LocalAgentServerName)

		// No spawn was attempted: a subprocess started now would outlive the
		// helper that owns it.
		require.NoError(t, err)
	})
}

func TestSetConfigOptionRequestSessionID(t *testing.T) {
	t.Run("preserves value id request session", func(t *testing.T) {
		req, sessionID, err := setConfigOptionRequestSessionID(acpsdk.SetSessionConfigOptionRequest{
			ValueId: &acpsdk.SetSessionConfigOptionValueId{
				SessionId: "requested-session",
				ConfigId:  "mode",
				Value:     "plan",
			},
		}, "active-session")

		require.NoError(t, err)
		assert.Equal(t, acpsdk.SessionId("requested-session"), sessionID)
		require.NotNil(t, req.ValueId)
		assert.Equal(t, acpsdk.SessionId("requested-session"), req.ValueId.SessionId)
	})

	t.Run("preserves boolean request session", func(t *testing.T) {
		req, sessionID, err := setConfigOptionRequestSessionID(acpsdk.SetSessionConfigOptionRequest{
			Boolean: &acpsdk.SetSessionConfigOptionBoolean{
				SessionId: "requested-session",
				ConfigId:  "enabled",
				Value:     true,
			},
		}, "active-session")

		require.NoError(t, err)
		assert.Equal(t, acpsdk.SessionId("requested-session"), sessionID)
		require.NotNil(t, req.Boolean)
		assert.Equal(t, acpsdk.SessionId("requested-session"), req.Boolean.SessionId)
	})

	t.Run("falls back to active session", func(t *testing.T) {
		req, sessionID, err := setConfigOptionRequestSessionID(acpsdk.SetSessionConfigOptionRequest{
			ValueId: &acpsdk.SetSessionConfigOptionValueId{
				ConfigId: "mode",
				Value:    "plan",
			},
		}, "active-session")

		require.NoError(t, err)
		assert.Equal(t, acpsdk.SessionId("active-session"), sessionID)
		require.NotNil(t, req.ValueId)
		assert.Equal(t, acpsdk.SessionId("active-session"), req.ValueId.SessionId)
	})

	t.Run("requires a session", func(t *testing.T) {
		_, _, err := setConfigOptionRequestSessionID(acpsdk.SetSessionConfigOptionRequest{
			ValueId: &acpsdk.SetSessionConfigOptionValueId{
				ConfigId: "mode",
				Value:    "plan",
			},
		}, "")

		require.ErrorContains(t, err, "call session/new first")
	})

	t.Run("rejects unsupported variant after session exists", func(t *testing.T) {
		_, _, err := setConfigOptionRequestSessionID(acpsdk.SetSessionConfigOptionRequest{}, "active-session")

		require.ErrorContains(t, err, "unsupported request variant")
	})
}

func TestCloseSession(t *testing.T) {
	closeParams := func(sessionID string) *methods.ACPCloseSessionParams {
		return &methods.ACPCloseSessionParams{
			ACPAgentServerParams: methods.ACPAgentServerParams{AgentServer: DefaultAgentServerName},
			CloseSessionRequest:  acpsdk.CloseSessionRequest{SessionId: acpsdk.SessionId(sessionID)},
		}
	}

	t.Run("no-op when the agent server was never started", func(t *testing.T) {
		h := NewHandler(dummyConfig(), nil, nil)
		gCtx := newGlspContext(nil, nil)

		out, err := h.CloseSession(context.Background(), closeParams("s1"), gCtx)
		require.NoError(t, err)
		assert.NotNil(t, out)
	})

	t.Run("no-op when the process is not running", func(t *testing.T) {
		h := NewHandler(dummyConfig(), nil, nil)
		gCtx := newGlspContext(nil, nil)
		h.processFor(DefaultAgentServerName, gCtx)

		out, err := h.CloseSession(context.Background(), closeParams("s1"), gCtx)
		require.NoError(t, err)
		assert.NotNil(t, out)
	})

	t.Run("no-op when the agent cannot close or reopen sessions", func(t *testing.T) {
		h := NewHandler(dummyConfig(), nil, nil)
		gCtx := newGlspContext(nil, nil)
		proc, _ := h.processFor(DefaultAgentServerName, gCtx)
		proc.state = processState{kind: processStateRunning}
		// A nil conn would panic if the handler tried to forward the call.
		proc.conn = nil
		proc.initResp = &acpsdk.InitializeResponse{
			ProtocolVersion: acpsdk.ProtocolVersionNumber,
			AgentCapabilities: acpsdk.AgentCapabilities{
				SessionCapabilities: acpsdk.SessionCapabilities{
					Close: &acpsdk.SessionCloseCapabilities{},
				},
			},
		}

		out, err := h.CloseSession(context.Background(), closeParams("s1"), gCtx)
		require.NoError(t, err)
		assert.NotNil(t, out)
	})

	t.Run("treats an already-gone session as closed", func(t *testing.T) {
		agentInR, agentInW := io.Pipe()
		agentOutR, agentOutW := io.Pipe()
		t.Cleanup(func() {
			agentInW.Close()
			agentOutW.Close()
		})

		go func() {
			scanner := bufio.NewScanner(agentInR)
			for scanner.Scan() {
				var req struct {
					ID any `json:"id"`
				}
				if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
					continue
				}
				resp, _ := json.Marshal(map[string]any{
					"jsonrpc": "2.0",
					"id":      req.ID,
					"error": map[string]any{
						"code":    -32603,
						"message": "Internal error",
						"data":    map[string]any{"details": "Session not found"},
					},
				})
				if _, err := agentOutW.Write(append(resp, '\n')); err != nil {
					return
				}
			}
		}()

		h := NewHandler(dummyConfig(), nil, nil)
		gCtx := newGlspContext(nil, nil)
		proc, client := h.processFor(DefaultAgentServerName, gCtx)
		proc.state = processState{kind: processStateRunning}
		proc.conn = acpsdk.NewClientSideConnection(client, agentInW, agentOutR)
		proc.initResp = &acpsdk.InitializeResponse{
			ProtocolVersion: acpsdk.ProtocolVersionNumber,
			AgentCapabilities: acpsdk.AgentCapabilities{
				LoadSession: true,
				SessionCapabilities: acpsdk.SessionCapabilities{
					Close:  &acpsdk.SessionCloseCapabilities{},
					Resume: &acpsdk.SessionResumeCapabilities{},
				},
			},
		}

		out, err := h.CloseSession(context.Background(), closeParams("already-closed"), gCtx)
		require.NoError(t, err)
		assert.NotNil(t, out)
	})

	t.Run("forwards session/close when capabilities allow", func(t *testing.T) {
		agentInR, agentInW := io.Pipe()
		agentOutR, agentOutW := io.Pipe()
		t.Cleanup(func() {
			agentInW.Close()
			agentOutW.Close()
		})

		type wireRequest struct {
			ID     any             `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		requests := make(chan wireRequest, 1)
		go func() {
			scanner := bufio.NewScanner(agentInR)
			for scanner.Scan() {
				var req wireRequest
				if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
					continue
				}
				requests <- req
				resp, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{}})
				if _, err := agentOutW.Write(append(resp, '\n')); err != nil {
					return
				}
			}
		}()

		h := NewHandler(dummyConfig(), nil, nil)
		gCtx := newGlspContext(nil, nil)
		proc, client := h.processFor(DefaultAgentServerName, gCtx)
		proc.state = processState{kind: processStateRunning}
		proc.conn = acpsdk.NewClientSideConnection(client, agentInW, agentOutR)
		proc.initResp = &acpsdk.InitializeResponse{
			ProtocolVersion: acpsdk.ProtocolVersionNumber,
			AgentCapabilities: acpsdk.AgentCapabilities{
				LoadSession: true,
				SessionCapabilities: acpsdk.SessionCapabilities{
					Close:  &acpsdk.SessionCloseCapabilities{},
					Resume: &acpsdk.SessionResumeCapabilities{},
				},
			},
		}

		out, err := h.CloseSession(context.Background(), closeParams("s1"), gCtx)
		require.NoError(t, err)
		require.NotNil(t, out)

		select {
		case req := <-requests:
			assert.Equal(t, "session/close", req.Method)
			var params acpsdk.CloseSessionRequest
			require.NoError(t, json.Unmarshal(req.Params, &params))
			assert.Equal(t, acpsdk.SessionId("s1"), params.SessionId)
		case <-time.After(time.Second):
			require.FailNow(t, "session/close was not forwarded to the agent")
		}
	})
}

// dummyConfig returns a ConfigFn that points at a non-existent binary.
// The process won't actually start, but ensureStarted will wire the closures
// before attempting to spawn the subprocess.
func dummyConfig() ConfigFn {
	return func() HandlerConfig {
		return HandlerConfig{
			WorkingDir: "/tmp",
			AgentServers: map[string]AgentServerConfig{
				DefaultAgentServerName: {
					Command: "/nonexistent",
				},
			},
		}
	}
}

func preflightConfig(ready AgentServerReadinessProvider) ConfigFn {
	return func() HandlerConfig {
		return HandlerConfig{
			WorkingDir: "/tmp",
			AgentServers: map[string]AgentServerConfig{
				LocalAgentServerName: {
					Command: "/nonexistent",
				},
			},
			AgentServerReady: ready,
		}
	}
}

func TestEnsureStartedWiresEnvelope(t *testing.T) {
	t.Run("notify wraps in JSON-RPC envelope", func(t *testing.T) {
		var captures []notifyCapture
		gCtx := newGlspContext(&captures, nil)

		h := NewHandler(dummyConfig(), nil, nil)
		// ensureStarted wires the closures before proc.start, which will fail
		// (no binary) — that's fine, we only need the closures.
		_, _ = h.ensureStarted(context.Background(), gCtx, DefaultAgentServerName, nil)
		_, client := h.processFor(DefaultAgentServerName, gCtx)
		require.NotNil(t, client.notify, "notify should be wired after ensureStarted")

		client.notify(context.Background(), "session/update", map[string]string{"key": "val"})

		require.Len(t, captures, 1)
		assert.Equal(t, methods.JSONRPCNotifyMethod, captures[0].method)

		bridge, ok := captures[0].params.(map[string]any)
		require.True(t, ok)
		assert.Equal(t, DefaultAgentServerName, bridge["agentServer"])
		envelope, ok := bridge["message"].(map[string]any)
		require.True(t, ok)
		assert.Equal(t, "2.0", envelope["jsonrpc"])
		assert.Equal(t, "session/update", envelope["method"])
		assert.Equal(t, map[string]string{"key": "val"}, envelope["params"])
	})

	t.Run("request wraps in JSON-RPC envelope with unique id", func(t *testing.T) {
		var captures []callCapture
		gCtx := newGlspContext(nil, &captures)

		h := NewHandler(dummyConfig(), nil, nil)
		_, _ = h.ensureStarted(context.Background(), gCtx, DefaultAgentServerName, nil)
		_, client := h.processFor(DefaultAgentServerName, gCtx)
		require.NotNil(t, client.request, "request should be wired after ensureStarted")

		var result any
		_ = client.request(context.Background(), "session/request_permission", "params1", &result)
		_ = client.request(context.Background(), "session/request_permission", "params2", &result)

		require.Len(t, captures, 2)
		for i, c := range captures {
			assert.Equal(t, methods.JSONRPCRequestMethod, c.method, "call %d", i)

			bridge, ok := c.params.(map[string]any)
			require.True(t, ok, "call %d", i)
			assert.Equal(t, DefaultAgentServerName, bridge["agentServer"], "call %d", i)
			envelope, ok := bridge["message"].(map[string]any)
			require.True(t, ok, "call %d", i)
			assert.Equal(t, "2.0", envelope["jsonrpc"], "call %d", i)
			assert.Equal(t, "session/request_permission", envelope["method"], "call %d", i)
			assert.NotEmpty(t, envelope["id"], "call %d: id should be set", i)
		}

		// IDs should be unique across calls.
		id0 := captures[0].params.(map[string]any)["message"].(map[string]any)["id"]
		id1 := captures[1].params.(map[string]any)["message"].(map[string]any)["id"]
		assert.NotEqual(t, id0, id1, "each request should get a unique id")
	})

	t.Run("closures wired only once", func(t *testing.T) {
		var captures1 []notifyCapture
		gCtx1 := newGlspContext(&captures1, nil)

		var captures2 []notifyCapture
		gCtx2 := newGlspContext(&captures2, nil)

		h := NewHandler(dummyConfig(), nil, nil)
		_, _ = h.ensureStarted(context.Background(), gCtx1, DefaultAgentServerName, nil)
		_, _ = h.ensureStarted(context.Background(), gCtx2, DefaultAgentServerName, nil)
		_, client := h.processFor(DefaultAgentServerName, gCtx1)

		client.notify(context.Background(), "test", nil)

		assert.Len(t, captures1, 1, "should use first glsp context")
		assert.Len(t, captures2, 0, "second glsp context should be ignored")
	})
}

func TestAgentLaunchErrorToJSONRPC(t *testing.T) {
	t.Run("wraps install errors with the dedicated code", func(t *testing.T) {
		err := agentLaunchErrorToJSONRPC(fmt.Errorf("start: %w", &AgentInstallError{
			AgentServer: "poolside",
			Err:         fmt.Errorf("fetch ACP registry: connection refused"),
		}))

		var rpcErr *methods.JSONRPCError
		require.ErrorAs(t, err, &rpcErr)
		assert.Equal(t, methods.CamberErrorCodeAgentInstallFailed, rpcErr.Code)
		require.NotNil(t, rpcErr.Data)
		require.NotNil(t, rpcErr.Data.AgentInstall)
		assert.Equal(t, "poolside", rpcErr.Data.AgentInstall.AgentServer)
	})

	t.Run("wraps missing-runtime errors with a user-facing message", func(t *testing.T) {
		err := agentLaunchErrorToJSONRPC(fmt.Errorf("start: %w", &MissingRuntimeError{
			AgentServer: "codex-acp",
			Launcher:    "npx",
			Provider:    "Node.js",
			Err:         fmt.Errorf(`resolve executable "npx": executable file not found in $PATH`),
		}))

		var rpcErr *methods.JSONRPCError
		require.ErrorAs(t, err, &rpcErr)
		assert.Equal(t, methods.CamberErrorCodeAgentInstallFailed, rpcErr.Code)
		assert.Equal(t,
			"This agent runs through npx, which was not found on this machine. Install Node.js to use this agent.",
			rpcErr.Message)
		require.NotNil(t, rpcErr.Data)
		require.NotNil(t, rpcErr.Data.AgentInstall)
		assert.Equal(t, "codex-acp", rpcErr.Data.AgentInstall.AgentServer)
	})

	t.Run("passes other errors through", func(t *testing.T) {
		original := fmt.Errorf("some other failure")
		assert.Equal(t, original, agentLaunchErrorToJSONRPC(original))
		assert.NoError(t, agentLaunchErrorToJSONRPC(nil))
	})
}
