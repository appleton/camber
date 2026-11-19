package acpproxy

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"sync"
	"testing"

	acpsdk "github.com/coder/acp-go-sdk"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/appleton/camber/pkg/camber-helper/internal/handler/remoteaccess"
	"github.com/appleton/camber/pkg/camber-helper/methods"
)

// replayLogSink adds the session log's history capabilities to logBackedSink,
// matching the production sink in package handler.
type replayLogSink struct{ logBackedSink }

func (s *replayLogSink) MarkSessionHistory(a, id string, complete bool) {
	s.log.MarkSessionHistory(a, id, complete)
}
func (s *replayLogSink) SessionReplay(a, id, origin string) (SessionReplayStream, SessionCursor, bool) {
	stream, c, ok := s.log.SessionReplay(a, id, origin)
	return SessionReplayStream(stream), SessionCursor{Epoch: c.Epoch, Seq: c.Seq, TurnActive: c.TurnActive}, ok
}
func (s *replayLogSink) HasCompleteHistory(a, id string) bool { return s.log.HasCompleteHistory(a, id) }
func (s *replayLogSink) BeginLoadHistory(a, id string)        { s.log.BeginLoadHistory(a, id) }
func (s *replayLogSink) RecordLoadHistory(a, id string, m map[string]any) {
	s.log.RecordLoadHistory(a, id, m)
}
func (s *replayLogSink) EndLoadHistory(a, id string, loaded bool) {
	s.log.EndLoadHistory(a, id, loaded)
}

// TestControlRestoreThenLiveAttachReplaysLoadedHistory reproduces a control
// CLI send on an idle conversation: the helper loads the session (the agent
// replays its history to the control caller), a turn starts, and the desktop
// then opens the conversation. Its live attach must present the replayed
// history followed by the turn's live updates instead of being refused.
func TestControlRestoreThenLiveAttachReplaysLoadedHistory(t *testing.T) {
	const sessionID = "restored"
	agentInR, agentInW := io.Pipe()
	agentOutR, agentOutW := io.Pipe()
	t.Cleanup(func() {
		agentInW.Close()
		agentOutW.Close()
	})
	update := func(text string) []byte {
		b, _ := json.Marshal(map[string]any{
			"jsonrpc": "2.0", "method": acpsdk.ClientMethodSessionUpdate,
			"params": map[string]any{"sessionId": sessionID, "update": map[string]any{
				"sessionUpdate": "agent_message_chunk",
				"content":       map[string]any{"type": "text", "text": text},
			}},
		})
		return append(b, '\n')
	}
	go func() {
		scanner := bufio.NewScanner(agentInR)
		for scanner.Scan() {
			var req struct {
				ID     any    `json:"id"`
				Method string `json:"method"`
			}
			if json.Unmarshal(scanner.Bytes(), &req) != nil || req.ID == nil || req.Method != acpsdk.AgentMethodSessionLoad {
				continue
			}
			var out []byte
			for i := range 3 {
				out = append(out, update(fmt.Sprintf("history-%d", i))...)
			}
			resp, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{}})
			if _, err := agentOutW.Write(append(out, append(resp, '\n')...)); err != nil {
				return
			}
		}
	}()

	hub := remoteaccess.NewHub()
	var mu sync.Mutex
	var primary []map[string]any
	hub.SetPrimary(func(_ context.Context, _ string, params any) error {
		mu.Lock()
		defer mu.Unlock()
		primary = append(primary, params.(map[string]any)["message"].(map[string]any))
		return nil
	})
	log := remoteaccess.NewSessionLog(hub)
	h := NewHandler(dummyConfig(), nil, nil)
	h.SetSessionEvents(&replayLogSink{logBackedSink{log: log, hub: hub}})
	gCtx := newGlspContext(nil, nil)
	proc, client := h.processFor(DefaultAgentServerName, gCtx)
	proc.state = processState{kind: processStateRunning}
	proc.configuration = &sessionConfigurationCache{}
	proc.conn = acpsdk.NewClientSideConnection(client, agentInW, agentOutR)
	proc.initResp = &acpsdk.InitializeResponse{ProtocolVersion: acpsdk.ProtocolVersionNumber}

	// Control restore: the replay is scoped to the control caller only.
	controlCtx := methods.WithClientOrigin(context.Background(), "control")
	_, err := h.LoadSession(controlCtx, &methods.ACPLoadSessionParams{
		ACPAgentServerParams: methods.ACPAgentServerParams{AgentServer: DefaultAgentServerName},
		LoadSessionRequest:   acpsdk.LoadSessionRequest{SessionId: sessionID, Cwd: t.TempDir(), McpServers: []acpsdk.McpServer{}},
	}, gCtx)
	require.NoError(t, err)
	mu.Lock()
	assert.Empty(t, primary, "the control restore's replay never reaches the desktop")
	mu.Unlock()

	// The control send starts a turn, which streams a live update.
	_, reserved := h.beginPromptInFlight(DefaultAgentServerName, sessionID, "turn")
	require.True(t, reserved)
	client.routeSessionEvent(controlCtx, acpsdk.ClientMethodSessionUpdate, sessionID, "live")
	require.NoError(t, client.waitForSessionUpdates(controlCtx))

	// The desktop opens the conversation mid-turn.
	desktopCtx := methods.WithClientOrigin(context.Background(), remoteaccess.PrimaryOrigin)
	mu.Lock()
	primary = nil
	mu.Unlock()
	resp, err := h.LoadSession(desktopCtx, &methods.ACPLoadSessionParams{
		ACPAgentServerParams: methods.ACPAgentServerParams{AgentServer: DefaultAgentServerName},
		LoadSessionRequest: acpsdk.LoadSessionRequest{
			SessionId: sessionID, Cwd: t.TempDir(), McpServers: []acpsdk.McpServer{},
			Meta: map[string]any{liveAttachMetaKey: true},
		},
	}, gCtx)
	require.NoError(t, err, "a restored session's live attach must not be refused")
	require.NotNil(t, resp)
	assert.Equal(t, true, resp.Meta[liveAttachMetaKey])
	cursor, ok := resp.Meta[methods.LoadSessionCursorMetaKey].(map[string]any)
	require.True(t, ok)
	assert.EqualValues(t, 1, cursor["seq"], "the cursor covers the live update already replayed")

	mu.Lock()
	defer mu.Unlock()
	require.Len(t, primary, 5)
	assert.Equal(t, sessionReplayStartedMethod, primary[0]["method"])
	for i := range 3 {
		notif, ok := primary[i+1]["params"].(acpsdk.SessionNotification)
		require.True(t, ok)
		require.NotNil(t, notif.Update.AgentMessageChunk)
		require.NotNil(t, notif.Update.AgentMessageChunk.Content.Text)
		assert.Equal(t, fmt.Sprintf("history-%d", i), notif.Update.AgentMessageChunk.Content.Text.Text)
	}
	assert.Equal(t, "live", primary[4]["params"])
}

// historyAgent is a fake agent for history tests: session/load replays
// `history` text chunks (or fails when failLoad), session/resume and
// session/new answer without replaying anything. It records the methods it
// received.
type historyAgent struct {
	sessionID string
	history   int
	failLoad  bool

	mu      sync.Mutex
	methods []string
}

func (a *historyAgent) received() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string(nil), a.methods...)
}

// start wires a handler (with a real session log behind its sink) to the fake
// agent and returns the handler, its ACP client, the log and a recorder of
// the messages the primary (desktop) receives.
func (a *historyAgent) start(t *testing.T, caps acpsdk.AgentCapabilities) (*Handler, *acpClient, *remoteaccess.SessionLog, *primaryRecorder) {
	t.Helper()
	agentInR, agentInW := io.Pipe()
	agentOutR, agentOutW := io.Pipe()
	t.Cleanup(func() {
		agentInW.Close()
		agentOutW.Close()
	})
	go func() {
		reader := bufio.NewReader(agentInR)
		for {
			line, err := reader.ReadBytes('\n')
			if err != nil {
				return
			}
			var req struct {
				ID     any    `json:"id"`
				Method string `json:"method"`
			}
			if json.Unmarshal(line, &req) != nil || req.ID == nil {
				continue
			}
			a.mu.Lock()
			a.methods = append(a.methods, req.Method)
			a.mu.Unlock()
			out := bytes.Buffer{}
			result := any(map[string]any{})
			switch req.Method {
			case acpsdk.AgentMethodSessionLoad:
				if a.failLoad {
					result = nil
					break
				}
				for i := range a.history {
					out.Write(textUpdate(a.sessionID, fmt.Sprintf("history-%d", i)))
				}
			case acpsdk.AgentMethodSessionNew:
				result = map[string]any{"sessionId": a.sessionID}
			}
			response := map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": result}
			if result == nil {
				delete(response, "result")
				response["error"] = map[string]any{"code": -32603, "message": "load failed"}
			}
			resp, _ := json.Marshal(response)
			out.Write(append(resp, '\n'))
			if _, err := agentOutW.Write(out.Bytes()); err != nil {
				return
			}
		}
	}()

	hub := remoteaccess.NewHub()
	recorder := &primaryRecorder{}
	hub.SetPrimary(recorder.notify)
	log := remoteaccess.NewSessionLog(hub)
	log.UseHistoryDir(t.TempDir())
	t.Cleanup(func() { _ = log.Close() })
	h := NewHandler(dummyConfig(), nil, nil)
	h.SetSessionEvents(&replayLogSink{logBackedSink{log: log, hub: hub}})
	gCtx := newGlspContext(nil, nil)
	proc, client := h.processFor(DefaultAgentServerName, gCtx)
	proc.state = processState{kind: processStateRunning}
	proc.configuration = &sessionConfigurationCache{}
	proc.conn = acpsdk.NewClientSideConnection(client, agentInW, agentOutR)
	proc.initResp = &acpsdk.InitializeResponse{ProtocolVersion: acpsdk.ProtocolVersionNumber, AgentCapabilities: caps}
	return h, client, log, recorder
}

func textUpdate(sessionID, text string) []byte {
	b, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "method": acpsdk.ClientMethodSessionUpdate,
		"params": map[string]any{"sessionId": sessionID, "update": map[string]any{
			"sessionUpdate": "agent_message_chunk",
			"content":       map[string]any{"type": "text", "text": text},
		}},
	})
	return append(b, '\n')
}

type primaryRecorder struct {
	mu       sync.Mutex
	messages []map[string]any
}

func (r *primaryRecorder) notify(_ context.Context, _ string, params any) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.messages = append(r.messages, params.(map[string]any)["message"].(map[string]any))
	return nil
}

func (r *primaryRecorder) take() []map[string]any {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := r.messages
	r.messages = nil
	return out
}

// messageText extracts an agent_message_chunk's text from a replayed message,
// whether it is still the typed notification or came back from a spill file
// as plain JSON.
func messageText(t *testing.T, message map[string]any) string {
	t.Helper()
	raw, err := json.Marshal(message["params"])
	require.NoError(t, err)
	var notif acpsdk.SessionNotification
	if json.Unmarshal(raw, &notif) != nil || notif.Update.AgentMessageChunk == nil || notif.Update.AgentMessageChunk.Content.Text == nil {
		var text string
		require.NoError(t, json.Unmarshal(raw, &text), "neither a text chunk nor a string: %s", raw)
		return text
	}
	return notif.Update.AgentMessageChunk.Content.Text.Text
}

func desktopAttach(t *testing.T, h *Handler, sessionID string) (*acpsdk.LoadSessionResponse, error) {
	t.Helper()
	desktopCtx := methods.WithClientOrigin(context.Background(), remoteaccess.PrimaryOrigin)
	return h.LoadSession(desktopCtx, &methods.ACPLoadSessionParams{
		ACPAgentServerParams: methods.ACPAgentServerParams{AgentServer: DefaultAgentServerName},
		LoadSessionRequest: acpsdk.LoadSessionRequest{
			SessionId: acpsdk.SessionId(sessionID), Cwd: t.TempDir(), McpServers: []acpsdk.McpServer{},
			Meta: map[string]any{liveAttachMetaKey: true},
		},
	}, newGlspContext(nil, nil))
}

// TestLiveAttachReplaysLongReloadedHistoryAndLongTurn reloads a conversation
// whose history is several times the session log's buffer, then runs a turn
// that also outgrows it. Opening the conversation in the desktop must replay
// every history message and every live update of the turn, in order.
func TestLiveAttachReplaysLongReloadedHistoryAndLongTurn(t *testing.T) {
	const sessionID = "long"
	historyLen := 3*2048 + 11
	liveLen := 2*2048 + 7
	agent := &historyAgent{sessionID: sessionID, history: historyLen}
	h, client, _, primary := agent.start(t, acpsdk.AgentCapabilities{LoadSession: true})

	controlCtx := methods.WithClientOrigin(context.Background(), "control")
	_, err := h.LoadSession(controlCtx, &methods.ACPLoadSessionParams{
		ACPAgentServerParams: methods.ACPAgentServerParams{AgentServer: DefaultAgentServerName},
		LoadSessionRequest:   acpsdk.LoadSessionRequest{SessionId: sessionID, Cwd: t.TempDir(), McpServers: []acpsdk.McpServer{}},
	}, newGlspContext(nil, nil))
	require.NoError(t, err)

	_, reserved := h.beginPromptInFlight(DefaultAgentServerName, sessionID, "turn")
	require.True(t, reserved)
	h.events.BeginTurn(DefaultAgentServerName, sessionID)
	for i := range liveLen {
		client.routeSessionEvent(controlCtx, acpsdk.ClientMethodSessionUpdate, sessionID, fmt.Sprintf("live-%d", i))
	}
	require.NoError(t, client.waitForSessionUpdates(controlCtx))
	primary.take()

	resp, err := desktopAttach(t, h, sessionID)
	require.NoError(t, err, "a long transcript must not refuse the live attach")
	assert.Equal(t, true, resp.Meta[liveAttachMetaKey])
	cursor, ok := resp.Meta[methods.LoadSessionCursorMetaKey].(map[string]any)
	require.True(t, ok)
	assert.EqualValues(t, liveLen, cursor["seq"])
	assert.Equal(t, true, cursor["turnActive"])

	got := primary.take()
	require.Len(t, got, 1+historyLen+liveLen)
	assert.Equal(t, sessionReplayStartedMethod, got[0]["method"])
	for i := range historyLen {
		require.Equal(t, fmt.Sprintf("history-%d", i), messageText(t, got[1+i]), "history message %d", i)
	}
	for i := range liveLen {
		require.Equal(t, fmt.Sprintf("live-%d", i), messageText(t, got[1+historyLen+i]), "live message %d", i)
	}
}

// TestResumeKeepsRetainedHistoryForLiveAttach: session/resume does not change
// a session's past, so a transcript the helper already retains stays
// attachable, and the helper does not reload the agent to rebuild it.
func TestResumeKeepsRetainedHistoryForLiveAttach(t *testing.T) {
	const sessionID = "resumed"
	agent := &historyAgent{sessionID: sessionID, history: 2}
	h, client, _, primary := agent.start(t, acpsdk.AgentCapabilities{LoadSession: true})
	ctx := context.Background()
	gCtx := newGlspContext(nil, nil)

	_, err := h.NewSession(ctx, &methods.ACPNewSessionParams{
		ACPAgentServerParams: methods.ACPAgentServerParams{AgentServer: DefaultAgentServerName},
		NewSessionRequest:    acpsdk.NewSessionRequest{Cwd: t.TempDir(), McpServers: []acpsdk.McpServer{}},
	}, gCtx)
	require.NoError(t, err)
	client.routeSessionEvent(ctx, acpsdk.ClientMethodSessionUpdate, sessionID, "first turn")
	require.NoError(t, client.waitForSessionUpdates(ctx))

	_, err = h.ResumeSession(ctx, &methods.ACPResumeSessionParams{
		ACPAgentServerParams: methods.ACPAgentServerParams{AgentServer: DefaultAgentServerName},
		ResumeSessionRequest: acpsdk.ResumeSessionRequest{SessionId: sessionID, Cwd: t.TempDir()},
	}, gCtx)
	require.NoError(t, err)
	require.NoError(t, client.waitForSessionUpdates(ctx))
	assert.Equal(t, []string{acpsdk.AgentMethodSessionNew, acpsdk.AgentMethodSessionResume}, agent.received(),
		"a retained transcript needs no history-capturing load")

	_, reserved := h.beginPromptInFlight(DefaultAgentServerName, sessionID, "turn")
	require.True(t, reserved)
	client.routeSessionEvent(ctx, acpsdk.ClientMethodSessionUpdate, sessionID, "second turn")
	require.NoError(t, client.waitForSessionUpdates(ctx))
	primary.take()

	_, err = desktopAttach(t, h, sessionID)
	require.NoError(t, err, "resume must not discard the retained transcript")
	got := primary.take()
	require.Len(t, got, 3)
	assert.Equal(t, "first turn", messageText(t, got[1]))
	assert.Equal(t, "second turn", messageText(t, got[2]))
}

// TestResumeWithoutHistoryCapturesItByLoading: a session the helper holds no
// transcript for (helper restart, evicted entry) is reattached with a
// history-capturing session/load whose replay reaches no client, so a later
// turn can still be opened with its whole history.
func TestResumeWithoutHistoryCapturesItByLoading(t *testing.T) {
	const sessionID = "unknown"
	agent := &historyAgent{sessionID: sessionID, history: 3}
	h, client, _, primary := agent.start(t, acpsdk.AgentCapabilities{LoadSession: true})
	ctx := methods.WithClientOrigin(context.Background(), remoteaccess.PrimaryOrigin)

	resp, err := h.ResumeSession(ctx, &methods.ACPResumeSessionParams{
		ACPAgentServerParams: methods.ACPAgentServerParams{AgentServer: DefaultAgentServerName},
		ResumeSessionRequest: acpsdk.ResumeSessionRequest{SessionId: sessionID, Cwd: t.TempDir()},
	}, newGlspContext(nil, nil))
	require.NoError(t, err)
	require.NotNil(t, resp)
	require.NoError(t, client.waitForSessionUpdates(ctx))
	assert.Equal(t, []string{acpsdk.AgentMethodSessionLoad}, agent.received())
	assert.Empty(t, primary.take(), "the resuming client's transcript is left untouched")

	_, reserved := h.beginPromptInFlight(DefaultAgentServerName, sessionID, "turn")
	require.True(t, reserved)
	client.routeSessionEvent(ctx, acpsdk.ClientMethodSessionUpdate, sessionID, "live")
	require.NoError(t, client.waitForSessionUpdates(ctx))
	primary.take()

	_, err = desktopAttach(t, h, sessionID)
	require.NoError(t, err)
	got := primary.take()
	require.Len(t, got, 5)
	for i := range 3 {
		assert.Equal(t, fmt.Sprintf("history-%d", i), messageText(t, got[1+i]))
	}
	assert.Equal(t, "live", messageText(t, got[4]))
}

// TestResumeFallsBackWhenHistoryCannotBeCaptured: if the agent cannot load
// the session (or does not support loading), the resume still happens as
// requested; only the later live attach is refused (the desktop then reloads
// silently when the turn ends).
func TestResumeFallsBackWhenHistoryCannotBeCaptured(t *testing.T) {
	for name, tc := range map[string]struct {
		caps     acpsdk.AgentCapabilities
		failLoad bool
		want     []string
	}{
		"load fails":       {caps: acpsdk.AgentCapabilities{LoadSession: true}, failLoad: true, want: []string{acpsdk.AgentMethodSessionLoad, acpsdk.AgentMethodSessionResume}},
		"load unsupported": {want: []string{acpsdk.AgentMethodSessionResume}},
	} {
		t.Run(name, func(t *testing.T) {
			const sessionID = "unloadable"
			agent := &historyAgent{sessionID: sessionID, failLoad: tc.failLoad}
			h, client, _, _ := agent.start(t, tc.caps)
			ctx := context.Background()
			_, err := h.ResumeSession(ctx, &methods.ACPResumeSessionParams{
				ACPAgentServerParams: methods.ACPAgentServerParams{AgentServer: DefaultAgentServerName},
				ResumeSessionRequest: acpsdk.ResumeSessionRequest{SessionId: sessionID, Cwd: t.TempDir()},
			}, newGlspContext(nil, nil))
			require.NoError(t, err)
			require.NoError(t, client.waitForSessionUpdates(ctx))
			assert.Equal(t, tc.want, agent.received())

			_, reserved := h.beginPromptInFlight(DefaultAgentServerName, sessionID, "turn")
			require.True(t, reserved)
			_, err = desktopAttach(t, h, sessionID)
			require.Error(t, err)
			assert.Contains(t, err.Error(), "still running")
		})
	}
}
