package acpproxy

import (
	"bufio"
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
func (s *replayLogSink) SessionReplay(a, id, origin string) ([]map[string]any, SessionCursor, bool) {
	messages, c, ok := s.log.SessionReplay(a, id, origin)
	return messages, SessionCursor{Epoch: c.Epoch, Seq: c.Seq, TurnActive: c.TurnActive}, ok
}
func (s *replayLogSink) BeginLoadHistory(a, id string) { s.log.BeginLoadHistory(a, id) }
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
