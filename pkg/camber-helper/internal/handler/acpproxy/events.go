package acpproxy

import (
	"context"
	"encoding/json"
	"fmt"

	acpsdk "github.com/coder/acp-go-sdk"

	"github.com/appleton/camber/pkg/camber-helper/internal/gopls/gotoolsinternal/jsonrpc2"
	"github.com/appleton/camber/pkg/camber-helper/methods"
)

// SessionEventSink stamps, buffers, and fans out live session/update events
// to every connected client (desktop + remotes), and delivers session/load
// replay traffic to only the loading client. Implemented by the handler
// package on top of the remote-access hub and session log; nil when the
// helper runs without multi-client fan-out, in which case the legacy
// notify-the-origin path is used.
type SessionEventSink interface {
	// PublishSessionUpdate delivers a live agent JSON-RPC message to every
	// remote client and (unless skipPrimary) the primary, stamped with the
	// session's next sequence number. originDevice tags events a device
	// already rendered locally (relayed prompt user messages); that device's
	// transport drops the content but keeps the cursor advance.
	PublishSessionUpdate(agentServer, sessionID, originDevice string, skipPrimary bool, message map[string]any) int64
	// NotifyAll delivers an unstamped notification to every connected client.
	// It is reserved for legacy events that cannot be assigned to a session.
	NotifyAll(method string, params any)
	// NotifyClient delivers an unstamped notification to exactly one client.
	NotifyClient(originID string, method string, params any)
	// BeginTurn/EndTurn bracket a prompt turn. EndTurn is delivered through
	// the per-client notification queue (behind the turn's final publishes),
	// so it can arrive after the next turn's BeginTurn; implementations must
	// count matched pairs rather than track a boolean.
	BeginTurn(agentServer, sessionID string)
	EndTurn(agentServer, sessionID string)
	Cursor(agentServer, sessionID string) SessionCursor
}

// SessionCursor is a session's live-event stream position (see the sink's
// session log for semantics).
type SessionCursor struct {
	Epoch      string
	Seq        int64
	TurnActive bool
}

const liveAttachMetaKey = "camber/liveAttach"
const sessionReplayStartedMethod = "camber/acp/session_replay_started"

// Optional sink capability: only complete retained history is safe to present
// as a load response. A missing/evicted snapshot must never cause an active
// agent session to be reloaded as a fallback.
type sessionReplaySink interface {
	MarkSessionHistory(agentServer, sessionID string, complete bool)
	SessionReplay(agentServer, sessionID, originID string) ([]map[string]any, SessionCursor, bool)
}

func (h *Handler) markSessionHistory(agentServer, sessionID string, complete bool) {
	if sink, ok := h.events.(sessionReplaySink); ok {
		sink.MarkSessionHistory(normalizeServerName(agentServer), sessionID, complete)
	}
}

func activeSessionLoadError() error {
	err := &jsonrpc2.WireError{Code: -32001, Message: "This conversation is still running and cannot be reloaded safely; wait for the turn to finish"}
	err.SetError(map[string]any{"code": "SESSION_ACTIVE"})
	return err
}

// attachLiveSession replays on the same queue as live publishes. The reset
// marker discards any updates the loading UI saw before this snapshot; updates
// after it arrive after replay, exactly once, without scoping them away from
// other clients or calling session/load on the agent.
func (h *Handler) attachLiveSession(ctx context.Context, serverName string, req acpsdk.LoadSessionRequest, client *acpClient) (*acpsdk.LoadSessionResponse, bool, error) {
	h.mu.Lock()
	active := h.promptsInFlight[promptSessionKey{agentServer: serverName, sessionID: string(req.SessionId)}] != nil
	h.mu.Unlock()
	if !active {
		return nil, false, nil
	}
	sink, ok := h.events.(sessionReplaySink)
	if !ok || req.Meta[liveAttachMetaKey] != true {
		return nil, true, activeSessionLoadError()
	}
	options, modes, known := h.SessionConfiguration(serverName, string(req.SessionId))
	if !known {
		return nil, true, activeSessionLoadError()
	}
	response := &acpsdk.LoadSessionResponse{}
	if len(options) > 0 {
		if err := json.Unmarshal(options, &response.ConfigOptions); err != nil {
			return nil, true, err
		}
	}
	if len(modes) > 0 {
		if err := json.Unmarshal(modes, &response.Modes); err != nil {
			return nil, true, err
		}
	}
	done := make(chan error, 1)
	origin := methods.ClientOriginFromContext(ctx)
	client.asyncNotifications.enqueue(func(_ context.Context, _ string, _ any) {
		if err := ctx.Err(); err != nil {
			done <- err
			return
		}
		messages, cursor, complete := sink.SessionReplay(serverName, string(req.SessionId), origin)
		if !complete {
			done <- activeSessionLoadError()
			return
		}
		h.events.NotifyClient(origin, methods.JSONRPCNotifyMethod, bridgeMessage(serverName, map[string]any{
			"jsonrpc": "2.0", "method": sessionReplayStartedMethod,
			"params": map[string]any{"sessionId": req.SessionId},
		}))
		for _, message := range messages {
			if err := ctx.Err(); err != nil {
				done <- err
				return
			}
			h.events.NotifyClient(origin, methods.JSONRPCNotifyMethod, bridgeMessage(serverName, message))
		}
		response.Meta = map[string]any{
			liveAttachMetaKey: true,
			methods.LoadSessionCursorMetaKey: map[string]any{
				"epoch": cursor.Epoch, "seq": cursor.Seq, "turnActive": cursor.TurnActive,
			},
		}
		done <- nil
	}, "", nil)
	select {
	case err := <-done:
		return response, true, err
	case <-ctx.Done():
		return nil, true, ctx.Err()
	}
}

// SetSessionEvents installs the live-event sink. Call once during setup,
// before any traffic.
func (h *Handler) SetSessionEvents(sink SessionEventSink) {
	h.events = sink
}

// beginSessionLoad reserves the session's load slot, serializing overlapping
// session/load calls, and records which client the (unclassifiable) mix of
// replay and live session/update traffic must be scoped to for the duration.
// The returned release must be called after the load's notification flush.
func (h *Handler) beginSessionLoad(ctx context.Context, agentServer, sessionID, originID string) (func(), error) {
	key := promptSessionKey{agentServer: agentServer, sessionID: sessionID}
	for {
		h.mu.Lock()
		if _, busy := h.loadScopes[key]; !busy {
			if h.promptsInFlight[key] != nil {
				h.mu.Unlock()
				return nil, activeSessionLoadError()
			}
			done := make(chan struct{})
			h.loadScopes[key] = originID
			h.loadDone[key] = done
			h.mu.Unlock()
			return func() {
				h.mu.Lock()
				delete(h.loadScopes, key)
				delete(h.loadDone, key)
				h.mu.Unlock()
				close(done)
			}, nil
		}
		wait := h.loadDone[key]
		h.mu.Unlock()
		select {
		case <-wait:
		case <-ctx.Done():
			return nil, fmt.Errorf("acpproxy: waiting for concurrent session load: %w", ctx.Err())
		}
	}
}

// loadScopeFor reports the client a session's update traffic is currently
// scoped to, if a session/load is in flight.
func (h *Handler) loadScopeFor(agentServer, sessionID string) (string, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	origin, ok := h.loadScopes[promptSessionKey{agentServer: agentServer, sessionID: sessionID}]
	return origin, ok
}

// waitForLoadScopeClear blocks until no session/load is in flight for the
// session. Prompt calls this while holding the turn reservation: if a turn
// started while a load window was open, its agent updates would be scoped to
// the loading client and lost for everyone else.
func (h *Handler) waitForLoadScopeClear(ctx context.Context, agentServer, sessionID string) error {
	key := promptSessionKey{agentServer: agentServer, sessionID: sessionID}
	for {
		h.mu.Lock()
		wait, busy := h.loadDone[key]
		h.mu.Unlock()
		if !busy {
			return nil
		}
		select {
		case <-wait:
		case <-ctx.Done():
			return fmt.Errorf("acpproxy: waiting for session load to finish: %w", ctx.Err())
		}
	}
}
