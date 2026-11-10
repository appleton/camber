package acpproxy

import (
	"context"
	"encoding/json"
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
	s.direct = append(s.direct, directEvent{originID: originID, method: method})
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

func TestWaitForLoadScopeClear(t *testing.T) {
	h := NewHandler(dummyConfig(), nil, nil)
	require.NoError(t, h.waitForLoadScopeClear(context.Background(), DefaultAgentServerName, "s1"))

	release, err := h.beginSessionLoad(context.Background(), DefaultAgentServerName, "s1", "remote:dev/a")
	require.NoError(t, err)

	cleared := make(chan struct{})
	go func() {
		assert.NoError(t, h.waitForLoadScopeClear(context.Background(), DefaultAgentServerName, "s1"))
		close(cleared)
	}()

	select {
	case <-cleared:
		t.Fatal("wait must block while the load is in flight")
	case <-time.After(50 * time.Millisecond):
	}

	release()
	select {
	case <-cleared:
	case <-time.After(2 * time.Second):
		t.Fatal("wait never returned after the load released")
	}
}
