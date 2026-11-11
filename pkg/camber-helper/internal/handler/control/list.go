package control

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"unicode/utf8"

	pkgerrors "github.com/pkg/errors"
	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

const (
	defaultListLimit = 200
	maxListLimit     = 500
	// listPageCap ends a chat.list page early so the response stays well
	// under the 1 MiB control frame limit whatever the titles hold.
	listPageCap = 512 * 1024
	// listStringCap bounds free-text summary fields (titles, errors).
	listStringCap = 512
)

// ConversationSummary is chat.list and chat.children's slim per-conversation
// row. Detail (metadata, configuration, the delegated task and result) is for
// chat.inspect.
type ConversationSummary struct {
	ID            string                                `json:"id"`
	Title         string                                `json:"title,omitempty"`
	Nickname      string                                `json:"nickname,omitempty"`
	WorkspacePath string                                `json:"workspacePath"`
	AgentServer   string                                `json:"agentServer"`
	ParentID      string                                `json:"parentId,omitempty"`
	RootID        string                                `json:"rootId,omitempty"`
	Status        string                                `json:"status,omitempty"`
	TurnID        string                                `json:"turnId,omitempty"`
	Error         string                                `json:"error,omitempty"`
	Archived      bool                                  `json:"archived"`
	UpdatedAt     string                                `json:"updatedAt,omitempty"`
	LiveStatus    *methods.ACPNavConversationLiveStatus `json:"liveStatus,omitempty"`
}

// listCursor is the opaque page token: the last returned id and its
// updatedAt, plus the next row's position as a fallback when that
// conversation is gone or has since moved.
type listCursor struct {
	After     string `json:"after"`
	UpdatedAt string `json:"updatedAt,omitempty"`
	Offset    int    `json:"offset"`
}

// listSummaries pages slim conversation summaries in navigation order (most
// recently updated first). With parent set it pages that conversation's
// direct children, archived ones included (chat.children); otherwise it pages
// every conversation, excluding archived ones unless a.Archived is set
// (chat.list).
func (s *Service) listSummaries(ctx context.Context, a Args, parent string, g *glsp.Context) (any, error) {
	limit := a.Limit
	if limit == 0 {
		limit = defaultListLimit
	}
	if limit < 0 || limit > maxListLimit {
		return nil, pkgerrors.Errorf("limit must be between 1 and %d", maxListLimit)
	}
	var cursor listCursor
	if a.Cursor != "" {
		raw, err := base64.RawURLEncoding.DecodeString(a.Cursor)
		if err != nil || json.Unmarshal(raw, &cursor) != nil || cursor.Offset < 0 {
			return nil, pkgerrors.Errorf("invalid cursor; pass nextCursor from the previous page of the same command")
		}
	}
	state, err := s.nav.List(ctx, &methods.ACPNavListParams{}, g)
	if err != nil {
		return nil, err
	}
	rows := make([]methods.ACPNavConversation, 0, len(state.Conversations))
	for _, c := range state.Conversations {
		if parent != "" {
			of, parentErr := s.parentOf(ctx, c)
			if parentErr != nil {
				return nil, parentErr
			}
			if of != parent {
				continue
			}
		} else if c.Archived && !a.Archived {
			continue
		}
		rows = append(rows, c)
	}
	start := resumeIndex(rows, cursor)

	out := []ConversationSummary{}
	size, end := 0, start
	for end < len(rows) && len(out) < limit {
		v, viewErr := s.viewFrom(ctx, rows[end])
		if viewErr != nil {
			return nil, viewErr
		}
		summary := summarize(s.withLiveState(v))
		encoded, _ := json.Marshal(summary)
		if len(out) > 0 && size+len(encoded)+1 > listPageCap {
			break
		}
		size += len(encoded) + 1
		out = append(out, summary)
		end++
	}
	result := map[string]any{"conversations": out, "hasMore": end < len(rows), "nextCursor": ""}
	if end < len(rows) && len(out) > 0 {
		token, _ := json.Marshal(listCursor{After: out[len(out)-1].ID, UpdatedAt: rows[end-1].UpdatedAt, Offset: end})
		result["nextCursor"] = base64.RawURLEncoding.EncodeToString(token)
	}
	return result, nil
}

// resumeIndex finds where the next page starts. It resumes after the last
// returned conversation where it still is, so conversations created or
// updated above it do not shift the page. If that conversation is gone or has
// itself moved (its updatedAt changed, or, ordered by touch time, it now sits
// above its old position), resuming after it would repeat or skip rows, so
// the recorded offset is used instead.
func resumeIndex(rows []methods.ACPNavConversation, cursor listCursor) int {
	start := min(cursor.Offset, len(rows))
	if cursor.After == "" {
		return start
	}
	for i, c := range rows {
		if c.ID != cursor.After {
			continue
		}
		moved := c.UpdatedAt != cursor.UpdatedAt || (c.UpdatedAt == "" && i < cursor.Offset-1)
		if !moved {
			return i + 1
		}
		return start
	}
	return start
}

// parentOf returns a conversation's control parent: the nav row's link, else
// the durable control record's.
func (s *Service) parentOf(ctx context.Context, c methods.ACPNavConversation) (string, error) {
	if c.ParentID != "" {
		return c.ParentID, nil
	}
	var stored storedRecord
	if err := s.nav.ReadControlState(ctx, "conversation/"+c.ID, &stored); err != nil {
		return "", err
	}
	return stored.ParentID, nil
}

func summarize(v View) ConversationSummary {
	return ConversationSummary{
		ID:            v.ID,
		Title:         capString(v.Title),
		Nickname:      capString(v.Nickname),
		WorkspacePath: v.WorkspacePath,
		AgentServer:   v.AgentServer,
		ParentID:      v.ParentID,
		RootID:        v.RootID,
		Status:        v.Status,
		TurnID:        v.TurnID,
		Error:         capString(v.Error),
		Archived:      v.Archived,
		UpdatedAt:     v.UpdatedAt,
		LiveStatus:    v.LiveStatus,
	}
}

func capString(s string) string {
	if len(s) <= listStringCap {
		return s
	}
	cut := listStringCap
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return strings.TrimRightFunc(s[:cut], func(r rune) bool { return r == ' ' }) + "…"
}
