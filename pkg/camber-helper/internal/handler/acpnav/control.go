package acpnav

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	"github.com/appleton/camber/pkg/camber-helper/methods"
	pkgerrors "github.com/pkg/errors"
	"github.com/tliron/glsp"
)

// ControlConversation reads one navigation row and its current live status.
// Output polling must not enumerate every project and conversation.
func (s *Server) ControlConversation(ctx context.Context, id string) (methods.ACPNavConversation, error) {
	if s.store == nil {
		return methods.ACPNavConversation{}, pkgerrors.WithStack(sql.ErrConnDone)
	}
	if id == "" {
		return methods.ACPNavConversation{}, pkgerrors.New("conversationId is required")
	}
	conversations, err := s.store.queryConversations(ctx, id)
	if err != nil {
		return methods.ACPNavConversation{}, err
	}
	state := s.overlayLiveStatus(methods.ACPNavState{Conversations: conversations})
	if s.stateFilter != nil {
		state = s.stateFilter(state)
	}
	if len(state.Conversations) != 1 {
		return methods.ACPNavConversation{}, pkgerrors.Errorf("conversation %q does not exist", id)
	}
	return state.Conversations[0], nil
}

// ReadControlState loads durable orchestration state separately from UI-owned
// conversation metadata, which clients can replace during a navigation update.
func (s *Server) ReadControlState(ctx context.Context, id string, value any) error {
	if s.store == nil {
		return pkgerrors.WithStack(sql.ErrConnDone)
	}
	var raw string
	err := s.store.db.QueryRowContext(ctx, `SELECT value FROM metadata WHERE key = ?`, "control/"+id).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return pkgerrors.WithStack(err)
	}
	return pkgerrors.WithStack(json.Unmarshal([]byte(raw), value))
}

func (s *Server) WriteControlState(ctx context.Context, id string, value any) error {
	if s.store == nil {
		return pkgerrors.WithStack(sql.ErrConnDone)
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return pkgerrors.WithStack(err)
	}
	return pkgerrors.WithStack(s.store.writeControlState(ctx, id, string(raw)))
}

// CheckWorktreeClean is Store.CheckWorktreeClean for control automation: an
// isolated `git status` that fails unless the worktree has no uncommitted or
// untracked changes.
func (s *Server) CheckWorktreeClean(ctx context.Context, path string) error {
	if s.store == nil {
		return pkgerrors.WithStack(sql.ErrConnDone)
	}
	return s.store.CheckWorktreeClean(ctx, path)
}

// RemoveWorktreeSafely uses Git's normal dirty and lock guards for automation.
func (s *Server) RemoveWorktreeSafely(ctx context.Context, path string, g *glsp.Context) (methods.ACPNavState, error) {
	if s.store == nil {
		return methods.ACPNavState{}, pkgerrors.WithStack(sql.ErrConnDone)
	}
	if err := s.store.RemoveWorktreeSafely(ctx, path); err != nil {
		return methods.ACPNavState{}, err
	}
	state, err := s.listWithLiveStatus(ctx)
	if err == nil {
		s.notifyState(ctx, g, state)
	}
	return state, err
}

// SetConversationConfig merges only the desktop's sessionConfig snapshot. UI
// metadata (file history, tool summaries) and archive state remain untouched.
func (s *Server) SetConversationConfig(ctx context.Context, id, agent, session string, config json.RawMessage, g *glsp.Context) error {
	if s.store == nil {
		return pkgerrors.WithStack(sql.ErrConnDone)
	}
	tx, err := s.store.db.BeginTx(ctx, nil)
	if err != nil {
		return pkgerrors.WithStack(err)
	}
	defer tx.Rollback()
	var raw string
	if err = tx.QueryRowContext(ctx, `SELECT metadata_json FROM conversations WHERE id=? AND agent_server=? AND session_id=?`, id, agent, session).Scan(&raw); err != nil {
		return pkgerrors.Wrap(err, "conversation session changed while applying configuration")
	}
	metadata := map[string]json.RawMessage{}
	if raw != "" {
		if err = json.Unmarshal([]byte(raw), &metadata); err != nil {
			return pkgerrors.WithStack(err)
		}
	}
	metadata["sessionConfig"] = config
	encoded, err := json.Marshal(metadata)
	if err != nil {
		return pkgerrors.WithStack(err)
	}
	if _, err = tx.ExecContext(ctx, `UPDATE conversations SET metadata_json=? WHERE id=? AND agent_server=? AND session_id=?`, string(encoded), id, agent, session); err != nil {
		return pkgerrors.WithStack(err)
	}
	if err = tx.Commit(); err != nil {
		return pkgerrors.WithStack(err)
	}
	state, err := s.listWithLiveStatus(ctx)
	if err == nil {
		s.notifyState(ctx, g, state)
	}
	return err
}
