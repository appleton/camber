package acpproxy

import (
	"context"
	"fmt"
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
