package acpproxy

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

func TestNamedTurnControlCannotAffectReplacementTurn(t *testing.T) {
	h := NewHandler(dummyConfig(), nil, nil)
	first, reserved := h.beginPromptInFlight(DefaultAgentServerName, "session", "first")
	require.True(t, reserved)
	release, err := h.acquireTurnControl(DefaultAgentServerName, "session", "first")
	require.NoError(t, err)
	finished := make(chan struct{})
	go func() {
		h.completeTurn(DefaultAgentServerName, "session", first, nil, nil)
		close(finished)
	}()
	// Even if the agent finishes A while the control call is sending, its
	// reservation survives until every side effect of that call is complete.
	select {
	case <-finished:
		require.FailNow(t, "turn completed before its control lease was released")
	case <-time.After(20 * time.Millisecond):
	}
	_, reserved = h.beginPromptInFlight(DefaultAgentServerName, "session", "second")
	assert.False(t, reserved)
	release()
	select {
	case <-finished:
	case <-time.After(time.Second):
		require.FailNow(t, "turn did not complete after release")
	}
	second, reserved := h.beginPromptInFlight(DefaultAgentServerName, "session", "second")
	require.True(t, reserved)
	_, err = h.acquireTurnControl(DefaultAgentServerName, "session", "first")
	require.ErrorContains(t, err, "no longer running")
	id, status, ok := h.CurrentTurn(DefaultAgentServerName, "session")
	require.True(t, ok)
	assert.Equal(t, "second", id)
	assert.Equal(t, "running", status)
	h.completeTurn(DefaultAgentServerName, "session", second, nil, nil)
	id, status, ok = h.CurrentTurn(DefaultAgentServerName, "session")
	require.True(t, ok)
	assert.Equal(t, "second", id)
	assert.Equal(t, "completed", status)
}

func TestPromptDuringLoadReportsLoading(t *testing.T) {
	h := NewHandler(dummyConfig(), nil, nil)
	h.loadScopes[promptSessionKey{agentServer: DefaultAgentServerName, sessionID: "session"}] = "client"
	_, reserved := h.beginPromptInFlight(DefaultAgentServerName, "session", "prompt")
	assert.False(t, reserved)
	require.ErrorContains(t, h.promptBusyError(DefaultAgentServerName, "session"), "history is loading")
}

func TestIdleSessionReservationExcludesPromptsAndOtherMutations(t *testing.T) {
	h := NewHandler(dummyConfig(), nil, nil)
	release, err := h.ReserveIdleSession(context.Background(), DefaultAgentServerName, "session")
	require.NoError(t, err)
	_, reserved := h.beginPromptInFlight(DefaultAgentServerName, "session", "prompt")
	assert.False(t, reserved)
	_, err = h.ReserveIdleSession(context.Background(), DefaultAgentServerName, "session")
	require.ErrorContains(t, err, "busy")
	// Reservations do not prevent work in a different conversation.
	other, reserved := h.beginPromptInFlight(DefaultAgentServerName, "other", "other")
	require.True(t, reserved)
	h.completeTurn(DefaultAgentServerName, "other", other, nil, nil)
	release()
	release() // Safe for deferred cleanup after an early explicit release.
	turn, reserved := h.beginPromptInFlight(DefaultAgentServerName, "session", "prompt")
	require.True(t, reserved)
	_, err = h.ReserveIdleSession(context.Background(), DefaultAgentServerName, "session")
	require.ErrorContains(t, err, "busy")
	h.completeTurn(DefaultAgentServerName, "session", turn, nil, nil)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = h.ReserveIdleSession(ctx, DefaultAgentServerName, "session")
	require.ErrorIs(t, err, context.Canceled)
}

func TestWorkspaceReservationExcludesSessionSetupInBothDirections(t *testing.T) {
	h := NewHandler(dummyConfig(), nil, nil)
	workspace := t.TempDir()
	child := filepath.Join(workspace, "child")
	require.NoError(t, os.Mkdir(child, 0o700))
	finishSetup, err := h.beginWorkspaceSession(child)
	require.NoError(t, err)
	_, err = h.ReserveWorkspace(context.Background(), workspace)
	require.ErrorContains(t, err, "operation in progress")
	finishSetup()
	release, err := h.ReserveWorkspace(context.Background(), workspace)
	require.NoError(t, err)
	// The public session APIs must reject before reaching the agent connection.
	h.procs[DefaultAgentServerName] = &process{state: processState{kind: processStateRunning}}
	ctx := context.Background()
	gCtx := newGlspContext(nil, nil)
	_, err = h.NewSession(ctx, &methods.ACPNewSessionParams{
		ACPAgentServerParams: methods.ACPAgentServerParams{AgentServer: DefaultAgentServerName},
		NewSessionRequest:    acpsdk.NewSessionRequest{Cwd: child},
	}, gCtx)
	require.ErrorContains(t, err, "operation in progress")
	_, err = h.LoadSession(ctx, &methods.ACPLoadSessionParams{
		ACPAgentServerParams: methods.ACPAgentServerParams{AgentServer: DefaultAgentServerName},
		LoadSessionRequest:   acpsdk.LoadSessionRequest{SessionId: "loaded", Cwd: child},
	}, gCtx)
	require.ErrorContains(t, err, "operation in progress")
	_, err = h.ResumeSession(ctx, &methods.ACPResumeSessionParams{
		ACPAgentServerParams: methods.ACPAgentServerParams{AgentServer: DefaultAgentServerName},
		ResumeSessionRequest: acpsdk.ResumeSessionRequest{SessionId: "resumed", Cwd: child},
	}, gCtx)
	require.ErrorContains(t, err, "operation in progress")
	for _, cwd := range []string{workspace, child, filepath.Join(child, ".."), ""} {
		_, err := h.beginWorkspaceSession(cwd)
		require.ErrorContains(t, err, "operation in progress", cwd)
	}
	_, err = h.ReserveWorkspace(context.Background(), child)
	require.ErrorContains(t, err, "operation in progress")
	otherSetup, err := h.beginWorkspaceSession(t.TempDir())
	require.NoError(t, err)
	otherSetup()
	require.NoError(t, os.RemoveAll(workspace))
	_, err = h.beginWorkspaceSession(child)
	require.ErrorContains(t, err, "operation in progress", "lease survives removal of its directory")
	release()
	release()
	finishSetup, err = h.beginWorkspaceSession(child)
	require.NoError(t, err)
	finishSetup()
}

type cursorEventSink struct{ fakeEventSink }

func (s *cursorEventSink) Cursor(agentServer, sessionID string) SessionCursor {
	s.mu.Lock()
	defer s.mu.Unlock()
	return SessionCursor{Epoch: "epoch", Seq: int64(len(s.published))}
}

func TestTurnEndCursorIsFixedBeforeLaterTurnEvents(t *testing.T) {
	h := NewHandler(dummyConfig(), nil, nil)
	sink := &cursorEventSink{}
	h.events = sink
	client := &acpClient{handler: h, agentServer: DefaultAgentServerName}
	turn, reserved := h.beginPromptInFlight(DefaultAgentServerName, "session", "")
	require.True(t, reserved)
	assert.NotEmpty(t, turn.turnID, "UI prompts also receive a stable identity")
	h.mu.Lock()
	turn.eventsQueued = true
	h.mu.Unlock()
	client.enqueueTurnEndedForTurn("session", turn)
	h.completeTurn(DefaultAgentServerName, "session", turn, nil, nil)
	client.asyncNotifications.enqueue(func(context.Context, string, any) {
		sink.PublishSessionUpdate(DefaultAgentServerName, "session", "", false, map[string]any{"later": true})
	}, "later", nil)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	require.NoError(t, client.waitForSessionUpdates(ctx))
	epoch, seq, ok, err := h.TurnEndCursor(ctx, DefaultAgentServerName, "session", turn.turnID)
	require.NoError(t, err)
	require.True(t, ok)
	assert.Equal(t, "epoch", epoch)
	assert.Equal(t, int64(1), seq)
	assert.Equal(t, int64(2), sink.Cursor(DefaultAgentServerName, "session").Seq)
}

func TestObserveTurnRetainsBoundariesAfterAnotherTurnStarts(t *testing.T) {
	h := NewHandler(dummyConfig(), nil, nil)
	sink := &cursorEventSink{}
	h.events = sink
	client := &acpClient{handler: h, agentServer: DefaultAgentServerName}
	first, reserved := h.beginPromptInFlight(DefaultAgentServerName, "session", "ui-a")
	require.True(t, reserved)
	h.mu.Lock()
	first.eventsQueued = true
	first.startCursor = SessionCursor{Epoch: "epoch", Seq: 0}
	h.mu.Unlock()
	client.enqueueTurnEndedForTurn("session", first)
	h.completeTurn(DefaultAgentServerName, "session", first, nil, nil)
	_, reserved = h.beginPromptInFlight(DefaultAgentServerName, "session", "ui-b")
	require.True(t, reserved)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	observed, found, err := h.ObserveTurn(ctx, DefaultAgentServerName, "session", "ui-a")
	require.NoError(t, err)
	require.True(t, found)
	assert.Equal(t, "completed", observed.Status)
	assert.True(t, observed.Finished)
	assert.Equal(t, int64(0), observed.StartSeq)
	assert.Equal(t, int64(1), observed.EndSeq)
	h.mu.Lock()
	first.cancelled = true
	h.mu.Unlock()
	observed, found, err = h.ObserveTurn(ctx, DefaultAgentServerName, "session", "ui-a")
	require.NoError(t, err)
	require.True(t, found)
	assert.Equal(t, "cancelled", observed.Status)
	_, found, err = h.ObserveTurn(ctx, DefaultAgentServerName, "other-session", "ui-a")
	require.NoError(t, err)
	assert.False(t, found)
}
