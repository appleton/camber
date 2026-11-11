package control

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

func addConversations(t *testing.T, s *Service, n int, workspace string, metadata json.RawMessage) []string {
	t.Helper()
	nav := s.nav
	ids := make([]string, 0, n)
	for i := 0; i < n; i++ {
		id := fmt.Sprintf("c%03d", i)
		_, err := nav.UpsertConversation(context.Background(), &methods.ACPNavUpsertConversationParams{Conversation: methods.ACPNavConversation{
			ID: id, AgentServer: "test", WorkspacePath: workspace, Cwd: workspace, Title: "chat " + id,
			UpdatedAt: fmt.Sprintf("2026-01-01T00:%02d:%02dZ", i/60, i%60), Metadata: metadata,
		}}, nil)
		require.NoError(t, err)
		ids = append(ids, id)
	}
	return ids
}

func listPage(t *testing.T, s *Service, args Args) (ids []string, hasMore bool, next string, raw []byte) {
	t.Helper()
	encoded, err := json.Marshal(args)
	require.NoError(t, err)
	raw, err = s.Dispatch(context.Background(), &methods.ControlDispatchParams{Command: "chat.list", Args: encoded}, nil)
	require.NoError(t, err)
	var out struct {
		Conversations []map[string]any `json:"conversations"`
		HasMore       bool             `json:"hasMore"`
		NextCursor    string           `json:"nextCursor"`
	}
	require.NoError(t, json.Unmarshal(raw, &out))
	for _, c := range out.Conversations {
		ids = append(ids, c["id"].(string))
	}
	return ids, out.HasMore, out.NextCursor, raw
}

func TestChatListPagesSlimSummaries(t *testing.T) {
	s, _ := fixture(t)
	addConversations(t, s, 7, t.TempDir(), json.RawMessage(`{"big":"`+strings.Repeat("m", 4096)+`"}`))

	var all []string
	cursor := ""
	for page := 0; page < 10; page++ {
		ids, hasMore, next, raw := listPage(t, s, Args{Limit: 3, Cursor: cursor})
		assert.LessOrEqual(t, len(ids), 3)
		assert.NotContains(t, string(raw), "metadata")
		assert.NotContains(t, string(raw), "configOptions")
		all = append(all, ids...)
		if !hasMore {
			assert.Empty(t, next)
			break
		}
		require.NotEmpty(t, next)
		cursor = next
	}
	assert.Len(t, all, 8, "seven new conversations plus the fixture parent")
	// The fixture parent has no updatedAt, so its touch time (now) leads.
	assert.Equal(t, []string{"parent", "c006", "c005"}, all[:3], "most recently updated first")
	seen := map[string]bool{}
	for _, id := range all {
		assert.False(t, seen[id], "no duplicates across pages: %s", id)
		seen[id] = true
	}

	// A conversation created between pages does not shift the next page.
	first, _, next, _ := listPage(t, s, Args{Limit: 3})
	nav := s.nav
	_, err := nav.UpsertConversation(context.Background(), &methods.ACPNavUpsertConversationParams{Conversation: methods.ACPNavConversation{
		ID: "newest", AgentServer: "test", WorkspacePath: t.TempDir(), UpdatedAt: "2027-01-01T00:00:00Z"}}, nil)
	require.NoError(t, err)
	second, _, _, _ := listPage(t, s, Args{Limit: 3, Cursor: next})
	assert.Equal(t, []string{"parent", "c006", "c005"}, first)
	assert.Equal(t, []string{"c004", "c003", "c002"}, second)
}

func TestChatListExcludesArchivedByDefault(t *testing.T) {
	s, _ := fixture(t)
	workspace := t.TempDir()
	addConversations(t, s, 3, workspace, nil)
	nav := s.nav
	_, err := nav.ArchiveConversation(context.Background(), &methods.ACPNavArchiveConversationParams{WorkspacePath: workspace, ConversationID: "c001", AgentServer: "test"}, nil)
	require.NoError(t, err)

	ids, _, _, _ := listPage(t, s, Args{})
	assert.NotContains(t, ids, "c001")
	assert.Contains(t, ids, "c000")
	ids, _, _, raw := listPage(t, s, Args{Archived: true})
	assert.Contains(t, ids, "c001")
	assert.Contains(t, string(raw), `"archived":true`)
}

func TestChatListByteCapEndsPageEarly(t *testing.T) {
	s, _ := fixture(t)
	// Long workspace paths make each summary ~20 KiB.
	addConversations(t, s, 40, "/"+strings.Repeat("w", 20*1024), nil)
	ids, hasMore, next, raw := listPage(t, s, Args{Limit: maxListLimit})
	assert.Less(t, len(raw), listPageCap+4096)
	assert.Less(t, len(ids), 40)
	assert.NotEmpty(t, ids)
	assert.True(t, hasMore)
	rest, more, _, _ := listPage(t, s, Args{Limit: maxListLimit, Cursor: next})
	assert.False(t, more)
	assert.Len(t, append(ids, rest...), 41)
}

func TestChatListRejectsBadPaging(t *testing.T) {
	s, _ := fixture(t)
	for _, args := range []string{`{"limit":501}`, `{"limit":-1}`, `{"cursor":"!!"}`} {
		_, err := s.Dispatch(context.Background(), &methods.ControlDispatchParams{Command: "chat.list", Args: json.RawMessage(args)}, nil)
		assert.Error(t, err, args)
	}
}

func TestChatListMovedAnchorFallsBackToOffset(t *testing.T) {
	s, _ := fixture(t)
	addConversations(t, s, 7, t.TempDir(), nil)
	first, _, next, _ := listPage(t, s, Args{Limit: 3})
	require.Equal(t, []string{"parent", "c006", "c005"}, first)
	// The page's last conversation is updated and moves to the top.
	_, err := s.nav.UpsertConversation(context.Background(), &methods.ACPNavUpsertConversationParams{Conversation: methods.ACPNavConversation{
		ID: "c005", AgentServer: "test", WorkspacePath: t.TempDir(), Title: "chat c005", UpdatedAt: "2027-01-01T00:00:00Z"}}, nil)
	require.NoError(t, err)
	second, _, _, _ := listPage(t, s, Args{Limit: 3, Cursor: next})
	assert.Equal(t, []string{"c004", "c003", "c002"}, second, "no repeated rows after the anchor moved")
}

func childrenPage(t *testing.T, s *Service, args Args) (ids []string, hasMore bool, next string, raw []byte) {
	t.Helper()
	encoded, err := json.Marshal(args)
	require.NoError(t, err)
	raw, err = s.Dispatch(context.Background(), &methods.ControlDispatchParams{Command: "chat.children", Args: encoded}, nil)
	require.NoError(t, err)
	var out struct {
		Conversations []map[string]any `json:"conversations"`
		HasMore       bool             `json:"hasMore"`
		NextCursor    string           `json:"nextCursor"`
	}
	require.NoError(t, json.Unmarshal(raw, &out))
	for _, c := range out.Conversations {
		ids = append(ids, c["id"].(string))
	}
	return ids, out.HasMore, out.NextCursor, raw
}

func TestChatChildrenPagesSlimSummariesOfDirectChildren(t *testing.T) {
	s, _ := fixture(t)
	workspace := t.TempDir()
	ids := addConversations(t, s, 5, workspace, json.RawMessage(`{"big":"`+strings.Repeat("m", 4096)+`"}`))
	// c000..c003 are children of parent; c004 is a grandchild.
	for i, id := range ids {
		v, err := s.view(context.Background(), id, nil)
		require.NoError(t, err)
		v.ParentID, v.RootID = "parent", "parent"
		if i == 4 {
			v.ParentID = "c000"
		}
		v.Task = strings.Repeat("t", 4096)
		require.NoError(t, s.save(context.Background(), v))
	}
	_, err := s.nav.ArchiveConversation(context.Background(), &methods.ACPNavArchiveConversationParams{WorkspacePath: workspace, ConversationID: "c001", AgentServer: "test"}, nil)
	require.NoError(t, err)

	var all []string
	cursor := ""
	for page := 0; page < 5; page++ {
		got, hasMore, next, raw := childrenPage(t, s, Args{ConversationID: "parent", Limit: 2, Cursor: cursor})
		assert.LessOrEqual(t, len(got), 2)
		assert.NotContains(t, string(raw), "metadata")
		assert.NotContains(t, string(raw), "task")
		all = append(all, got...)
		if !hasMore {
			break
		}
		cursor = next
	}
	assert.Equal(t, []string{"c003", "c002", "c001", "c000"}, all, "direct children only, archived included")

	grandchildren, _, _, _ := childrenPage(t, s, Args{ParentID: "c000"})
	assert.Equal(t, []string{"c004"}, grandchildren)

	for _, args := range []string{`{}`, `{"parentId":"parent","limit":501}`, `{"parentId":"parent","cursor":"!!"}`, `{"parentId":"parent","archived":true}`} {
		_, err := s.Dispatch(context.Background(), &methods.ControlDispatchParams{Command: "chat.children", Args: json.RawMessage(args)}, nil)
		assert.Error(t, err, args)
	}
}

func TestChatChildrenByteCapEndsPageEarly(t *testing.T) {
	s, _ := fixture(t)
	ids := addConversations(t, s, 40, "/"+strings.Repeat("w", 20*1024), nil)
	for _, id := range ids {
		v, err := s.view(context.Background(), id, nil)
		require.NoError(t, err)
		v.ParentID = "parent"
		require.NoError(t, s.save(context.Background(), v))
	}
	got, hasMore, next, raw := childrenPage(t, s, Args{ParentID: "parent", Limit: maxListLimit})
	assert.Less(t, len(raw), listPageCap+4096)
	assert.NotEmpty(t, got)
	assert.True(t, hasMore)
	rest, more, _, _ := childrenPage(t, s, Args{ParentID: "parent", Limit: maxListLimit, Cursor: next})
	assert.False(t, more)
	assert.Len(t, append(got, rest...), 40)
}
