package acpproxy

import (
	"context"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"github.com/appleton/camber/pkg/camber-helper/internal/gopls/gotoolsinternal/jsonrpc2"
	"github.com/appleton/camber/pkg/camber-helper/methods"
)

// ReserveWorkspace excludes new session bindings while a caller snapshots and
// removes the workspace. Already-started session setup must finish first;
// existing sessions are protected separately with ReserveIdleSession.
func (h *Handler) ReserveWorkspace(ctx context.Context, path string) (func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	path = canonicalWorkspace(path)
	if path == "" {
		return nil, &jsonrpc2.WireError{Code: -32602, Message: "Workspace path is required"}
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for existing := range h.reservedWorkspaces {
		if withinWorkspace(existing, path) || withinWorkspace(path, existing) {
			return nil, workspaceBusyError()
		}
	}
	for cwd, count := range h.workspaceSessionCalls {
		if count > 0 && withinWorkspace(path, cwd) {
			return nil, workspaceBusyError()
		}
	}
	if h.reservedWorkspaces == nil {
		h.reservedWorkspaces = make(map[string]struct{})
	}
	h.reservedWorkspaces[path] = struct{}{}
	var once sync.Once
	return func() {
		once.Do(func() {
			h.mu.Lock()
			defer h.mu.Unlock()
			delete(h.reservedWorkspaces, path)
		})
	}, nil
}

// ReserveIdleSession atomically excludes prompt starts while a caller changes
// settings or removes session resources. Callers must release the reservation
// on every exit path; overlapping operations fail rather than sharing it.
func (h *Handler) ReserveIdleSession(ctx context.Context, agentServer, sessionID string) (func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	key := promptSessionKey{agentServer: normalizeServerName(agentServer), sessionID: sessionID}
	h.mu.Lock()
	_, reserved := h.idleSessions[key]
	if reserved || h.promptsInFlight[key] != nil {
		h.mu.Unlock()
		err := &jsonrpc2.WireError{Code: -32001, Message: "Conversation is busy; wait for its current operation to finish"}
		err.SetError(map[string]any{"code": "CONVERSATION_BUSY"})
		return nil, err
	}
	if h.idleSessions == nil {
		h.idleSessions = make(map[promptSessionKey]struct{})
	}
	h.idleSessions[key] = struct{}{}
	h.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			h.mu.Lock()
			defer h.mu.Unlock()
			delete(h.idleSessions, key)
		})
	}, nil
}

// CurrentTurn identifies the actual helper-owned turn, including prompts from
// desktop or remote surfaces. Recently completed turns remain visible while
// retained by the existing bounded idempotency cache.
func (h *Handler) CurrentTurn(agentServer, sessionID string) (id, status string, ok bool) {
	key := promptSessionKey{agentServer: normalizeServerName(agentServer), sessionID: sessionID}
	h.mu.Lock()
	defer h.mu.Unlock()
	if turn := h.promptsInFlight[key]; turn != nil {
		return turn.turnID, "running", true
	}
	for i := len(h.finishedTurnOrder) - 1; i >= 0; i-- {
		turn := h.finishedTurns[h.finishedTurnOrder[i]]
		if turn == nil || turn.key != key {
			continue
		}
		status := "completed"
		if turn.err != nil {
			status = "failed"
		} else if turn.cancelled {
			status = "cancelled"
		}
		return turn.turnID, status, true
	}
	return "", "", false
}

// TurnEndCursor returns the stream boundary captured by the queued turnEnded
// publication itself, so a later turn can never extend an earlier turn's poll.
func (h *Handler) TurnEndCursor(ctx context.Context, agentServer, sessionID, turnID string) (epoch string, seq int64, ok bool, err error) {
	key := promptSessionKey{agentServer: normalizeServerName(agentServer), sessionID: sessionID}
	h.mu.Lock()
	turn := h.promptsInFlight[key]
	if turn == nil || turn.turnID != turnID {
		turn = h.finishedTurns[turnID]
	}
	if turn == nil || turn.key != key || !turn.eventsQueued {
		h.mu.Unlock()
		return "", 0, false, nil
	}
	done := turn.eventsDone
	h.mu.Unlock()
	select {
	case <-ctx.Done():
		return "", 0, false, ctx.Err()
	case <-done:
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	return turn.endCursor.Epoch, turn.endCursor.Seq, true, nil
}

func (h *Handler) beginWorkspaceSession(cwd string) (func(), error) {
	cwd = canonicalWorkspace(cwd)
	h.mu.Lock()
	defer h.mu.Unlock()
	for workspace := range h.reservedWorkspaces {
		if withinWorkspace(workspace, cwd) {
			return nil, workspaceBusyError()
		}
	}
	if h.workspaceSessionCalls == nil {
		h.workspaceSessionCalls = make(map[string]int)
	}
	h.workspaceSessionCalls[cwd]++
	var once sync.Once
	return func() {
		once.Do(func() {
			h.mu.Lock()
			defer h.mu.Unlock()
			h.workspaceSessionCalls[cwd]--
			if h.workspaceSessionCalls[cwd] == 0 {
				delete(h.workspaceSessionCalls, cwd)
			}
		})
	}, nil
}

func canonicalWorkspace(path string) string {
	if path == "" {
		return ""
	}
	if absolute, err := filepath.Abs(path); err == nil {
		path = absolute
	}
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		path = resolved
	} else {
		// Keep aliases such as /var -> /private/var stable after teardown
		// removes the final path components but still holds its reservation.
		for parent := filepath.Dir(path); ; parent = filepath.Dir(parent) {
			if resolved, err := filepath.EvalSymlinks(parent); err == nil {
				suffix, _ := filepath.Rel(parent, path)
				path = filepath.Join(resolved, suffix)
				break
			}
			if parent == filepath.Dir(parent) {
				break
			}
		}
	}
	if runtime.GOOS == "windows" {
		path = strings.ToLower(path)
	}
	return filepath.Clean(path)
}

func withinWorkspace(workspace, cwd string) bool {
	// Missing cwd is unknown, so exclude it conservatively during teardown.
	if cwd == "" {
		return true
	}
	relative, err := filepath.Rel(workspace, cwd)
	return err == nil && relative != ".." && !filepath.IsAbs(relative) &&
		!strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func workspaceBusyError() error {
	err := &jsonrpc2.WireError{Code: -32001, Message: "Workspace has an operation in progress; wait for it to finish"}
	err.SetError(map[string]any{"code": "WORKSPACE_BUSY"})
	return err
}

func (h *Handler) promptBusyError(agentServer, sessionID string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	key := promptSessionKey{agentServer: normalizeServerName(agentServer), sessionID: sessionID}
	code, message := "CONVERSATION_BUSY", "Conversation is busy with a turn or session operation; retry after it finishes"
	if _, loading := h.loadScopes[key]; loading {
		code, message = "SESSION_LOADING", "Conversation history is loading; retry after loading finishes"
	} else if h.promptsInFlight[key] != nil {
		message = "a turn is already running in this conversation; wait for it to finish or stop it first"
	}
	err := &jsonrpc2.WireError{Code: -32001, Message: message}
	err.SetError(map[string]any{"code": code})
	return err
}

// acquireTurnControl validates and reserves the live turn atomically. Holding
// this lease keeps completeTurn from releasing the session to the next prompt,
// without holding Handler.mu across an agent RPC or a status-store write.
func (h *Handler) acquireTurnControl(agentServer, sessionID, expected string) (func(), error) {
	key := promptSessionKey{agentServer: normalizeServerName(agentServer), sessionID: sessionID}
	h.mu.Lock()
	turn := h.promptsInFlight[key]
	if expected != "" && (turn == nil || turn.turnID != expected) {
		h.mu.Unlock()
		err := &jsonrpc2.WireError{Code: -32001, Message: "The requested turn is no longer running in this conversation"}
		err.SetError(map[string]any{"code": "TURN_MISMATCH"})
		return nil, err
	}
	if turn == nil {
		h.mu.Unlock()
		return func() {}, nil
	}
	turn.controlPending++
	h.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			h.mu.Lock()
			defer h.mu.Unlock()
			turn.controlPending--
			signalSteerStateChangedLocked(turn)
		})
	}, nil
}

func expectedTurnID(meta map[string]any) string {
	id, _ := meta["camber/expectedTurnId"].(string)
	return id
}

// ObserveTurn looks up a specific retained turn, including UI-started turns.
// The start and end cursors belong to the turn, never the latest session turn.
func (h *Handler) ObserveTurn(ctx context.Context, agentServer, sessionID, turnID string) (methods.ControlObservedTurn, bool, error) {
	key := promptSessionKey{agentServer: normalizeServerName(agentServer), sessionID: sessionID}
	h.mu.Lock()
	turn := h.promptsInFlight[key]
	finished := turn == nil || turn.turnID != turnID
	if finished {
		turn = h.finishedTurns[turnID]
	}
	if turn == nil || turn.key != key || turn.startCursor.Epoch == "" {
		h.mu.Unlock()
		return methods.ControlObservedTurn{}, false, nil
	}
	out := methods.ControlObservedTurn{TurnID: turnID, Status: "running", Epoch: turn.startCursor.Epoch, StartSeq: turn.startCursor.Seq, Finished: finished}
	if finished {
		out.Status = "completed"
		out.Result = turn.resp
		if turn.err != nil {
			out.Status = "failed"
			out.Error = turn.err.Error()
		} else if turn.cancelled || (turn.resp != nil && turn.resp.StopReason == "cancelled") {
			out.Status = "cancelled"
		}
	}
	h.mu.Unlock()
	if finished {
		epoch, seq, found, err := h.TurnEndCursor(ctx, agentServer, sessionID, turnID)
		if err != nil {
			return out, false, err
		}
		if !found || epoch != out.Epoch {
			return out, false, nil
		}
		out.EndSeq = seq
	}
	return out, true, nil
}
