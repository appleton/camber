package acpnav

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"
)

// ArchivedSessionCloser is invoked, best-effort and off the request path, for
// every descendant conversation the archive cascade newly archived while it
// had an agent-side session. It should cancel the running turn and close the
// session. acpnav cannot import acpproxy, so the handler injects it.
type ArchivedSessionCloser func(ctx context.Context, agentServer, sessionID string)

// archivedSessionCloseTimeout bounds the whole background close sweep.
const archivedSessionCloseTimeout = 30 * time.Second

type archivedSession struct {
	AgentServer string
	SessionID   string
}

// archiveDescendantsTx archives every non-archived conversation descended from
// roots through control-state parent links, transitively and cycle-safe. Roots
// themselves are never touched. It returns the sessions of the newly archived
// descendants and how many rows it archived.
func archiveDescendantsTx(ctx context.Context, tx *sql.Tx, roots []string) ([]archivedSession, int, error) {
	if len(roots) == 0 {
		return nil, 0, nil
	}
	children, err := controlChildren(ctx, tx)
	if err != nil {
		return nil, 0, err
	}
	visited := make(map[string]bool, len(roots))
	queue := make([]string, 0, len(roots))
	for _, id := range roots {
		if !visited[id] {
			visited[id] = true
			queue = append(queue, id)
		}
	}
	now := nowString()
	var sessions []archivedSession
	count := 0
	for len(queue) > 0 {
		id := queue[0]
		queue = queue[1:]
		for _, child := range children[id] {
			if visited[child] {
				continue
			}
			visited[child] = true
			queue = append(queue, child)
			var archived int
			var agentServer, sessionID string
			err := tx.QueryRowContext(ctx, `SELECT archived, agent_server, COALESCE(session_id, '') FROM conversations WHERE id = ?`, child).Scan(&archived, &agentServer, &sessionID)
			if err == sql.ErrNoRows || (err == nil && archived != 0) {
				continue
			}
			if err != nil {
				return nil, 0, fmt.Errorf("reading descendant conversation: %w", err)
			}
			if _, err := tx.ExecContext(ctx, `UPDATE conversations SET active = 0, archived = 1, touched_at = ? WHERE id = ?`, now, child); err != nil {
				return nil, 0, fmt.Errorf("archiving descendant conversation: %w", err)
			}
			count++
			if sessionID != "" {
				sessions = append(sessions, archivedSession{AgentServer: agentServer, SessionID: sessionID})
			}
		}
	}
	return sessions, count, nil
}

// controlChildren maps parent conversation id to child ids from control state.
func controlChildren(ctx context.Context, tx *sql.Tx) (map[string][]string, error) {
	rows, err := tx.QueryContext(ctx, `SELECT key, value FROM metadata WHERE key >= ? AND key < ?`, "control/conversation/", "control/conversation0")
	if err != nil {
		return nil, fmt.Errorf("listing control state: %w", err)
	}
	defer rows.Close()
	children := map[string][]string{}
	for rows.Next() {
		var key, raw string
		if err := rows.Scan(&key, &raw); err != nil {
			return nil, fmt.Errorf("scanning control state: %w", err)
		}
		var l struct {
			ParentID string `json:"parentId"`
		}
		if json.Unmarshal([]byte(raw), &l) != nil || l.ParentID == "" {
			continue
		}
		id := strings.TrimPrefix(key, "control/conversation/")
		if id != l.ParentID {
			children[l.ParentID] = append(children[l.ParentID], id)
		}
	}
	return children, rows.Err()
}

// reconcileArchivedOrphans archives conversations whose ancestor is already
// archived. Sessions are deliberately not closed: it runs at store open, when
// nothing can be live.
func (s *Store) reconcileArchivedOrphans(ctx context.Context) (int, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("starting tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	roots, err := queryIDs(ctx, tx, `SELECT id FROM conversations WHERE archived = 1`)
	if err != nil {
		return 0, err
	}
	_, count, err := archiveDescendantsTx(ctx, tx, roots)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	if count > 0 {
		slog.InfoContext(ctx, "acpnav: archived orphaned sub-agent conversations", "count", count)
	}
	return count, nil
}

func queryIDs(ctx context.Context, q interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}, query string, args ...any) ([]string, error) {
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("listing conversation ids: %w", err)
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scanning conversation id: %w", err)
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// closeArchivedSessions hands cascaded sessions to the injected closer on a
// background goroutine so the archive response never waits on agent I/O.
func (s *Store) closeArchivedSessions(ctx context.Context, sessions []archivedSession) {
	closer := s.archivedSessionCloser.Load()
	if closer == nil || len(sessions) == 0 {
		return
	}
	bg := context.WithoutCancel(ctx)
	go func() {
		bg, cancel := context.WithTimeout(bg, archivedSessionCloseTimeout)
		defer cancel()
		for _, session := range sessions {
			(*closer)(bg, session.AgentServer, session.SessionID)
		}
	}()
}
