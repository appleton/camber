package acpproxy

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"slices"
	"sync"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	acphelpers "github.com/appleton/camber/pkg/acp"
	"github.com/appleton/camber/pkg/camber-helper/methods"
)

type fakeEventSink struct {
	mu        sync.Mutex
	published []publishedEvent
	all       []broadcastEvent
	direct    []directEvent
	turns     []string
}

type publishedEvent struct {
	agentServer  string
	sessionID    string
	originDevice string
	skipPrimary  bool
	message      map[string]any
}

type directEvent struct {
	originID string
	method   string
	params   any
}

type broadcastEvent struct {
	method string
	params any
}

func (s *fakeEventSink) PublishSessionUpdate(agentServer, sessionID, originDevice string, skipPrimary bool, message map[string]any) int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.published = append(s.published, publishedEvent{
		agentServer:  agentServer,
		sessionID:    sessionID,
		originDevice: originDevice,
		skipPrimary:  skipPrimary,
		message:      message,
	})
	return int64(len(s.published))
}

func (s *fakeEventSink) NotifyClient(originID string, method string, params any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.direct = append(s.direct, directEvent{originID: originID, method: method, params: params})
}

type replayEventSink struct {
	fakeEventSink
	messages []map[string]any
	complete bool
}

func (s *replayEventSink) MarkSessionHistory(_, _ string, complete bool) {
	s.complete = complete
}

func (s *replayEventSink) SessionReplay(_, _, _ string) ([]map[string]any, SessionCursor, bool) {
	return s.messages, SessionCursor{Epoch: "epoch", Seq: 2, TurnActive: true}, s.complete
}

func TestLiveSessionAttachDoesNotReloadOrScopeRunningTurn(t *testing.T) {
	h := NewHandler(dummyConfig(), nil, nil)
	proc, client := h.processFor(DefaultAgentServerName, newGlspContext(nil, nil))
	proc.configuration = &sessionConfigurationCache{}
	proc.configuration.capture("running", []acpsdk.SessionConfigOption{}, nil)
	sink := &replayEventSink{
		complete: true,
		messages: []map[string]any{
			{"method": "session/update", "params": "first"},
			{"method": "session/update", "params": "second"},
		},
	}
	h.SetSessionEvents(sink)
	turn, reserved := h.beginPromptInFlight(DefaultAgentServerName, "running", "turn")
	require.True(t, reserved)
	ctx := methods.WithClientOrigin(context.Background(), "primary")
	response, attached, err := h.attachLiveSession(ctx, DefaultAgentServerName, acpsdk.LoadSessionRequest{
		SessionId: "running", Meta: map[string]any{liveAttachMetaKey: true},
	}, client)
	require.NoError(t, err)
	require.True(t, attached)
	require.NotNil(t, response)
	assert.Equal(t, true, response.Meta[liveAttachMetaKey])
	require.NoError(t, client.waitForSessionUpdates(ctx))
	_, direct := sink.snapshot()
	require.Len(t, direct, 3)
	first := direct[0].params.(map[string]any)["message"].(map[string]any)
	assert.Equal(t, sessionReplayStartedMethod, first["method"])
	for i, want := range sink.messages {
		assert.Equal(t, want, direct[i+1].params.(map[string]any)["message"])
		assert.Equal(t, "primary", direct[i+1].originID)
	}
	_, scoped := h.loadScopeFor(DefaultAgentServerName, "running")
	assert.False(t, scoped)
	assert.Same(t, turn, h.promptsInFlight[promptSessionKey{DefaultAgentServerName, "running"}])
	// Subsequent live updates still fan out to all readers.
	client.routeSessionEvent(ctx, "session/update", "running", "third")
	published, _ := sink.snapshot()
	require.Len(t, published, 1)
	assert.Equal(t, "third", published[0].message["params"])
}

func TestActiveSessionLoadAndCloseFailSafely(t *testing.T) {
	h := NewHandler(dummyConfig(), nil, nil)
	_, client := h.processFor(DefaultAgentServerName, newGlspContext(nil, nil))
	_, reserved := h.beginPromptInFlight(DefaultAgentServerName, "running", "turn")
	require.True(t, reserved)
	for _, meta := range []map[string]any{nil, {liveAttachMetaKey: true}} {
		_, attached, err := h.attachLiveSession(context.Background(), DefaultAgentServerName,
			acpsdk.LoadSessionRequest{SessionId: "running", Meta: meta}, client)
		assert.True(t, attached)
		require.ErrorContains(t, err, "still running")
	}
	// Even callers that raced the initial active check cannot reload the agent.
	_, err := h.beginSessionLoad(context.Background(), DefaultAgentServerName, "running", "primary")
	require.ErrorContains(t, err, "still running")
	_, err = h.CloseSession(context.Background(), &methods.ACPCloseSessionParams{
		ACPAgentServerParams: methods.ACPAgentServerParams{AgentServer: DefaultAgentServerName},
		CloseSessionRequest:  acpsdk.CloseSessionRequest{SessionId: "running"},
	}, newGlspContext(nil, nil))
	require.ErrorContains(t, err, "busy")
}

func TestLiveSessionAttachRefusesIncompleteHistory(t *testing.T) {
	h := NewHandler(dummyConfig(), nil, nil)
	proc, client := h.processFor(DefaultAgentServerName, newGlspContext(nil, nil))
	proc.configuration = &sessionConfigurationCache{}
	proc.configuration.capture("running", []acpsdk.SessionConfigOption{}, nil)
	sink := &replayEventSink{complete: false}
	h.SetSessionEvents(sink)
	_, reserved := h.beginPromptInFlight(DefaultAgentServerName, "running", "turn")
	require.True(t, reserved)
	_, attached, err := h.attachLiveSession(context.Background(), DefaultAgentServerName,
		acpsdk.LoadSessionRequest{SessionId: "running", Meta: map[string]any{liveAttachMetaKey: true}}, client)
	assert.True(t, attached)
	require.ErrorContains(t, err, "still running")
	_, direct := sink.snapshot()
	assert.Empty(t, direct, "do not reset the UI before confirming replay is complete")
}

func TestLoadingSessionExcludesNewPrompt(t *testing.T) {
	h := NewHandler(dummyConfig(), nil, nil)
	release, err := h.beginSessionLoad(context.Background(), DefaultAgentServerName, "loading", "primary")
	require.NoError(t, err)
	_, reserved := h.beginPromptInFlight(DefaultAgentServerName, "loading", "turn")
	assert.False(t, reserved)
	release()
	_, reserved = h.beginPromptInFlight(DefaultAgentServerName, "loading", "turn")
	assert.True(t, reserved)
}

func TestPromptReservationRechecksCompletedRetry(t *testing.T) {
	h := NewHandler(dummyConfig(), nil, nil)
	first, reserved := h.beginPromptInFlight(DefaultAgentServerName, "session", "turn")
	require.True(t, reserved)
	h.completeTurn(DefaultAgentServerName, "session", first, &methods.ACPPromptOutput{StopReason: acpsdk.StopReasonEndTurn}, nil)
	retry, reserved := h.beginPromptInFlight(DefaultAgentServerName, "session", "turn")
	assert.False(t, reserved)
	assert.Same(t, first, retry)
}

func (s *fakeEventSink) NotifyAll(method string, params any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.all = append(s.all, broadcastEvent{method: method, params: params})
}

func (s *fakeEventSink) BeginTurn(agentServer, sessionID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.turns = append(s.turns, "begin:"+sessionID)
}

func (s *fakeEventSink) EndTurn(agentServer, sessionID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.turns = append(s.turns, "end:"+sessionID)
}

func (s *fakeEventSink) Cursor(agentServer, sessionID string) SessionCursor {
	return SessionCursor{Epoch: "test-epoch", Seq: 7, TurnActive: false}
}

func (s *fakeEventSink) snapshot() ([]publishedEvent, []directEvent) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]publishedEvent(nil), s.published...), append([]directEvent(nil), s.direct...)
}

func (s *fakeEventSink) broadcastSnapshot() []broadcastEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]broadcastEvent(nil), s.all...)
}

func (s *fakeEventSink) turnSnapshot() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.turns...)
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("condition not reached in time")
}

func sessionUpdateFor(sessionID string) acpsdk.SessionNotification {
	return acpsdk.SessionNotification{SessionId: acpsdk.SessionId(sessionID)}
}

func TestSessionUpdateRoutesThroughSinkWhenInstalled(t *testing.T) {
	h := NewHandler(dummyConfig(), nil, nil)
	sink := &fakeEventSink{}
	h.SetSessionEvents(sink)
	_, client := h.processFor(DefaultAgentServerName, newGlspContext(nil, nil))

	require.NoError(t, client.SessionUpdate(context.Background(), sessionUpdateFor("s1")))
	waitFor(t, func() bool { published, _ := sink.snapshot(); return len(published) == 1 })

	published, direct := sink.snapshot()
	assert.Empty(t, direct)
	assert.Equal(t, DefaultAgentServerName, published[0].agentServer)
	assert.Equal(t, "s1", published[0].sessionID)
	assert.Empty(t, published[0].originDevice)
	assert.False(t, published[0].skipPrimary)
}

func TestSessionUpdateFallsBackToNotifyWithoutSink(t *testing.T) {
	h := NewHandler(dummyConfig(), nil, nil)
	var notifies []notifyCapture
	_, client := h.processFor(DefaultAgentServerName, newGlspContext(&notifies, nil))

	require.NoError(t, client.SessionUpdate(context.Background(), sessionUpdateFor("s1")))
	require.NoError(t, client.waitForSessionUpdates(context.Background()))
	require.Len(t, notifies, 1)
	assert.Equal(t, methods.JSONRPCNotifyMethod, notifies[0].method)
}

func TestPublishUserMessageAssignsOneUniqueIDPerRelayedMessage(t *testing.T) {
	h := NewHandler(dummyConfig(), nil, nil)
	sink := &fakeEventSink{}
	h.SetSessionEvents(sink)
	_, client := h.processFor(DefaultAgentServerName, newGlspContext(nil, nil))

	prompt := []acpsdk.ContentBlock{
		{Text: &acpsdk.ContentBlockText{Type: "text", Text: "first"}},
		{Text: &acpsdk.ContentBlockText{Type: "text", Text: " second"}},
	}
	steer := []acpsdk.ContentBlock{
		{Text: &acpsdk.ContentBlockText{Type: "text", Text: "change direction"}},
	}
	publishUserMessage(client, sink, DefaultAgentServerName, "s1", methods.PrimaryClientOrigin, prompt, false)
	publishUserMessage(client, sink, DefaultAgentServerName, "s1", methods.PrimaryClientOrigin, steer, true)
	require.NoError(t, client.waitForSessionUpdates(context.Background()))

	published, _ := sink.snapshot()
	require.Len(t, published, 3)
	updateFor := func(event publishedEvent) map[string]any {
		params, ok := event.message["params"].(map[string]any)
		require.True(t, ok)
		update, ok := params["update"].(map[string]any)
		require.True(t, ok)
		return update
	}
	first := updateFor(published[0])
	second := updateFor(published[1])
	steered := updateFor(published[2])
	firstID, ok := first["messageId"].(string)
	require.True(t, ok)
	require.NotEmpty(t, firstID)
	assert.Equal(t, firstID, second["messageId"], "blocks from one prompt must materialize together")
	assert.NotEqual(t, firstID, steered["messageId"], "a steer must not merge into the preceding prompt")
	assert.Equal(t, map[string]any{methods.ACPUserMessageSteerMetaKey: true}, steered["_meta"])
}

func TestClaudePromptSuggestionRoutesThroughSessionEventSink(t *testing.T) {
	h := NewHandler(dummyConfig(), nil, nil)
	sink := &fakeEventSink{}
	h.SetSessionEvents(sink)
	_, client := h.processFor("claude-acp", newGlspContext(nil, nil))

	raw := json.RawMessage(`{
		"sessionId": "s1",
		"message": {
			"type": "prompt_suggestion",
			"suggestion": "Run the focused tests",
			"uuid": "suggestion-1",
			"session_id": "claude-session-1"
		}
	}`)
	out, err := client.HandleExtensionMethod(context.Background(), methods.ACPClaudeSDKMessageMethod, raw)

	require.NoError(t, err)
	assert.Nil(t, out)
	require.NoError(t, client.waitForSessionUpdates(context.Background()))

	published, direct := sink.snapshot()
	assert.Empty(t, direct)
	require.Len(t, published, 1)
	assert.Equal(t, "claude-acp", published[0].agentServer)
	assert.Equal(t, "s1", published[0].sessionID)
	assert.Equal(t, methods.ACPClaudeSDKMessageMethod, published[0].message["method"])
}

func TestCompactionUpdateUsesSessionFanoutOrLegacyBroadcast(t *testing.T) {
	h := NewHandler(dummyConfig(), nil, nil)
	sink := &fakeEventSink{}
	h.SetSessionEvents(sink)
	_, client := h.processFor(DefaultAgentServerName, newGlspContext(nil, nil))

	for _, raw := range []json.RawMessage{
		json.RawMessage(`{"sessionId":"s1","id":"scoped","phase":"started"}`),
		json.RawMessage(`{"id":"legacy","phase":"started"}`),
	} {
		out, err := client.HandleExtensionMethod(context.Background(), acphelpers.ExtensionMethodCompactionUpdate, raw)
		require.NoError(t, err)
		assert.Nil(t, out)
	}
	require.NoError(t, client.waitForSessionUpdates(context.Background()))

	published, direct := sink.snapshot()
	require.Len(t, published, 1)
	assert.Empty(t, direct)
	assert.Equal(t, "s1", published[0].sessionID)
	assert.Equal(t, methods.ACPCompactionUpdateMethod, published[0].message["method"])

	broadcasts := sink.broadcastSnapshot()
	require.Len(t, broadcasts, 1)
	assert.Equal(t, methods.JSONRPCNotifyMethod, broadcasts[0].method)
	bridge, ok := broadcasts[0].params.(map[string]any)
	require.True(t, ok)
	message, ok := bridge["message"].(map[string]any)
	require.True(t, ok)
	assert.Equal(t, methods.ACPCompactionUpdateMethod, message["method"])
}

func TestTurnEndedFollowsCompactionAndReachesEverySurface(t *testing.T) {
	h := NewHandler(dummyConfig(), nil, nil)
	sink := &fakeEventSink{}
	h.SetSessionEvents(sink)
	_, client := h.processFor(DefaultAgentServerName, newGlspContext(nil, nil))
	sink.BeginTurn(DefaultAgentServerName, "s1")

	out, err := client.HandleExtensionMethod(
		context.Background(),
		acphelpers.ExtensionMethodCompactionUpdate,
		json.RawMessage(`{"sessionId":"s1","id":"failed","phase":"started"}`),
	)
	require.NoError(t, err)
	assert.Nil(t, out)
	client.enqueueTurnEnded("s1")
	require.NoError(t, client.waitForSessionUpdates(context.Background()))

	published, direct := sink.snapshot()
	assert.Empty(t, direct)
	require.Len(t, published, 2)
	assert.Equal(t, methods.ACPCompactionUpdateMethod, published[0].message["method"])
	assert.Equal(t, methods.ACPTurnEndedMethod, published[1].message["method"])
	assert.Equal(t, []string{"begin:s1", "end:s1"}, sink.turnSnapshot())
}

func TestTurnEndedIsNeverScopedToConcurrentLoad(t *testing.T) {
	h := NewHandler(dummyConfig(), nil, nil)
	sink := &fakeEventSink{}
	h.SetSessionEvents(sink)
	_, client := h.processFor(DefaultAgentServerName, newGlspContext(nil, nil))
	sink.BeginTurn(DefaultAgentServerName, "s1")
	release, err := h.beginSessionLoad(context.Background(), DefaultAgentServerName, "s1", "remote:dev/a")
	require.NoError(t, err)
	defer release()

	client.enqueueTurnEnded("s1")
	require.NoError(t, client.waitForSessionUpdates(context.Background()))

	published, direct := sink.snapshot()
	assert.Empty(t, direct)
	require.Len(t, published, 1)
	assert.Equal(t, methods.ACPTurnEndedMethod, published[0].message["method"])
	assert.Equal(t, []string{"begin:s1", "end:s1"}, sink.turnSnapshot())
}

func TestLoadScopeRoutesUpdatesToLoaderOnly(t *testing.T) {
	h := NewHandler(dummyConfig(), nil, nil)
	sink := &fakeEventSink{}
	h.SetSessionEvents(sink)
	_, client := h.processFor(DefaultAgentServerName, newGlspContext(nil, nil))

	release, err := h.beginSessionLoad(context.Background(), DefaultAgentServerName, "s1", "remote:dev/a")
	require.NoError(t, err)

	// Updates for the loading session go only to the loader, unstamped.
	require.NoError(t, client.SessionUpdate(context.Background(), sessionUpdateFor("s1")))
	// Updates for other sessions keep flowing through the stamped fan-out.
	require.NoError(t, client.SessionUpdate(context.Background(), sessionUpdateFor("other")))
	require.NoError(t, client.waitForSessionUpdates(context.Background()))

	published, direct := sink.snapshot()
	require.Len(t, direct, 1)
	assert.Equal(t, "remote:dev/a", direct[0].originID)
	assert.Equal(t, methods.JSONRPCNotifyMethod, direct[0].method)
	require.Len(t, published, 1)
	assert.Equal(t, "other", published[0].sessionID)

	release()
	require.NoError(t, client.SessionUpdate(context.Background(), sessionUpdateFor("s1")))
	require.NoError(t, client.waitForSessionUpdates(context.Background()))
	published, direct = sink.snapshot()
	assert.Len(t, direct, 1, "after release, updates must broadcast again")
	assert.Len(t, published, 2)
}

func TestBeginSessionLoadSerializesPerSession(t *testing.T) {
	h := NewHandler(dummyConfig(), nil, nil)
	h.SetSessionEvents(&fakeEventSink{})

	release1, err := h.beginSessionLoad(context.Background(), DefaultAgentServerName, "s1", "remote:dev/a")
	require.NoError(t, err)

	second := make(chan struct{})
	go func() {
		release2, err := h.beginSessionLoad(context.Background(), DefaultAgentServerName, "s1", "remote:dev/b")
		assert.NoError(t, err)
		release2()
		close(second)
	}()

	select {
	case <-second:
		t.Fatal("second load must wait for the first to release")
	case <-time.After(50 * time.Millisecond):
	}

	release1()
	select {
	case <-second:
	case <-time.After(2 * time.Second):
		t.Fatal("second load never proceeded after release")
	}

	// A load on a different session does not serialize against s1.
	release3, err := h.beginSessionLoad(context.Background(), DefaultAgentServerName, "s2", "remote:dev/c")
	require.NoError(t, err)
	release3()
}

func TestBeginSessionLoadHonorsContextCancel(t *testing.T) {
	h := NewHandler(dummyConfig(), nil, nil)
	release, err := h.beginSessionLoad(context.Background(), DefaultAgentServerName, "s1", "remote:dev/a")
	require.NoError(t, err)
	defer release()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = h.beginSessionLoad(ctx, DefaultAgentServerName, "s1", "remote:dev/b")
	require.Error(t, err)
}

// historyEventSink records session-log bookkeeping in call order.
type historyEventSink struct {
	fakeEventSink
	calls []string
}

func (s *historyEventSink) PublishSessionUpdate(agentServer, sessionID, originDevice string, skipPrimary bool, message map[string]any) int64 {
	s.mu.Lock()
	s.calls = append(s.calls, "publish:"+sessionID)
	s.mu.Unlock()
	return s.fakeEventSink.PublishSessionUpdate(agentServer, sessionID, originDevice, skipPrimary, message)
}

func (s *historyEventSink) MarkSessionHistory(_, sessionID string, complete bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = append(s.calls, fmt.Sprintf("mark:%s:%t", sessionID, complete))
}

func (s *historyEventSink) SessionReplay(_, _, _ string) ([]map[string]any, SessionCursor, bool) {
	return nil, SessionCursor{}, false
}

func (s *historyEventSink) ForgetSession(_, sessionID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = append(s.calls, "forget:"+sessionID)
}

func (s *historyEventSink) callSnapshot() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.calls...)
}

// TestConfigProbeSessionLeavesNoLogEntry checks that a config probe never
// claims a history slot and that closing it forgets what its streaming
// updates logged, while a real session keeps its history across close.
func TestConfigProbeSessionLeavesNoLogEntry(t *testing.T) {
	agentInR, agentInW := io.Pipe()
	agentOutR, agentOutW := io.Pipe()
	t.Cleanup(func() {
		agentInW.Close()
		agentOutW.Close()
	})
	var sessions int
	go func() {
		scanner := bufio.NewScanner(agentInR)
		for scanner.Scan() {
			var req struct {
				ID     any    `json:"id"`
				Method string `json:"method"`
			}
			if json.Unmarshal(scanner.Bytes(), &req) != nil || req.ID == nil {
				continue
			}
			if req.Method != acpsdk.AgentMethodSessionNew {
				continue
			}
			sessions++
			id := fmt.Sprintf("s%d", sessions)
			// Emit an update before answering, as agents announce commands.
			update, _ := json.Marshal(map[string]any{
				"jsonrpc": "2.0",
				"method":  acpsdk.ClientMethodSessionUpdate,
				"params": map[string]any{
					"sessionId": id,
					"update": map[string]any{
						"sessionUpdate":     "available_commands_update",
						"availableCommands": []any{},
					},
				},
			})
			resp, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{"sessionId": id}})
			if _, err := agentOutW.Write(append(append(update, '\n'), append(resp, '\n')...)); err != nil {
				return
			}
		}
	}()

	h := NewHandler(dummyConfig(), nil, nil)
	sink := &historyEventSink{}
	h.SetSessionEvents(sink)
	gCtx := newGlspContext(nil, nil)
	proc, client := h.processFor(DefaultAgentServerName, gCtx)
	proc.state = processState{kind: processStateRunning}
	proc.conn = acpsdk.NewClientSideConnection(client, agentInW, agentOutR)
	proc.initResp = &acpsdk.InitializeResponse{ProtocolVersion: acpsdk.ProtocolVersionNumber}

	ctx := context.Background()
	newSession := func(meta map[string]any) string {
		resp, err := h.NewSession(ctx, &methods.ACPNewSessionParams{
			ACPAgentServerParams: methods.ACPAgentServerParams{AgentServer: DefaultAgentServerName},
			NewSessionRequest:    acpsdk.NewSessionRequest{Cwd: t.TempDir(), McpServers: []acpsdk.McpServer{}, Meta: meta},
		}, gCtx)
		require.NoError(t, err)
		id := string(resp.SessionId)
		// The agent's update may still be in flight on the connection.
		require.Eventually(t, func() bool {
			return slices.Contains(sink.callSnapshot(), "publish:"+id)
		}, 2*time.Second, 5*time.Millisecond)
		return id
	}
	closeSession := func(id string) {
		_, err := h.CloseSession(ctx, &methods.ACPCloseSessionParams{
			ACPAgentServerParams: methods.ACPAgentServerParams{AgentServer: DefaultAgentServerName},
			CloseSessionRequest:  acpsdk.CloseSessionRequest{SessionId: acpsdk.SessionId(id)},
		}, gCtx)
		require.NoError(t, err)
		require.NoError(t, client.waitForSessionUpdates(ctx))
	}

	probe := newSession(map[string]any{configProbeMetaKey: true})
	closeSession(probe)
	real := newSession(nil)
	closeSession(real)

	calls := sink.callSnapshot()
	require.Len(t, calls, 4)
	assert.Equal(t, []string{"publish:" + probe, "forget:" + probe}, calls[:2],
		"a probe is never marked and is forgotten after its updates publish")
	assert.ElementsMatch(t, []string{"publish:" + real, "mark:" + real + ":true"}, calls[2:],
		"a real session keeps its history across close")
	assert.Empty(t, h.probeSessions, "closed probes are no longer tracked")
}
