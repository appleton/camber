package acpnav

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

func openTestStore(t *testing.T) *Store {
	t.Helper()
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "nav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = store.Close() })
	return store
}

// The helper binds (conversation → session) itself at session/new, so live
// status keyed by session id attaches from the first list — with NO client
// echo upsert involved. This closes the race where a mobile-created
// conversation's row had an empty session id while working=true was already
// set under the real session key, and the lost-upsert case where the echo
// never landed at all.
func TestBindConversationSessionAttachesLiveStatusWithoutClientUpsert(t *testing.T) {
	ctx := context.Background()
	store := openTestStore(t)
	server := NewServer()
	server.SetStore(store)

	const agentServer = "poolside"
	const conversationID = "conv-mobile-1"
	const workspacePath = "/Users/dev/project"
	const sessionID = "sess-abc-123"

	// Mobile creates a pending conversation row before session/new resolves.
	require.NoError(t, store.UpsertConversation(ctx, methods.ACPNavConversation{
		ID:            conversationID,
		WorkspacePath: workspacePath,
		AgentServer:   agentServer,
		Cwd:           workspacePath,
		Title:         "New conversation",
	}))

	// session/new resolves: the helper binds synchronously before returning.
	require.NoError(t, store.BindConversationSession(ctx, conversationID, agentServer, sessionID, workspacePath))

	// The turn starts; working=true is recorded under the real session key.
	require.True(t, server.applyConversationLiveStatus(agentServer, sessionID, ConversationLiveStatusPatch{
		Working: Bool(true),
	}))

	state, err := server.listWithLiveStatus(ctx)
	require.NoError(t, err)
	require.Len(t, state.Conversations, 1)
	got := state.Conversations[0]
	assert.Equal(t, sessionID, got.SessionID)
	// Bind must not clobber what the pending upsert already wrote.
	assert.Equal(t, "New conversation", got.Title)
	assert.Equal(t, workspacePath, got.WorkspacePath)
	require.NotNil(t, got.LiveStatus, "live status must attach with no client echo upsert")
	assert.True(t, got.LiveStatus.Working)
}

// A lost pending upsert (flaky remote socket) must not leave the session
// unbound: bind inserts a minimal active row so status and history stay
// reachable from every surface.
func TestBindConversationSessionInsertsRowWhenPendingUpsertNeverLanded(t *testing.T) {
	ctx := context.Background()
	store := openTestStore(t)
	server := NewServer()
	server.SetStore(store)

	require.NoError(t, store.BindConversationSession(ctx, "conv-lost", "poolside", "sess-9", "/Users/dev/project"))
	require.True(t, server.applyConversationLiveStatus("poolside", "sess-9", ConversationLiveStatusPatch{
		WaitingForUser: Bool(true),
	}))

	state, err := server.listWithLiveStatus(ctx)
	require.NoError(t, err)
	require.Len(t, state.Conversations, 1)
	got := state.Conversations[0]
	assert.Equal(t, "conv-lost", got.ID)
	assert.Equal(t, "sess-9", got.SessionID)
	assert.True(t, got.Active)
	assert.False(t, got.Archived)
	require.NotNil(t, got.LiveStatus)
	assert.True(t, got.LiveStatus.WaitingForUser)
}

func TestBindConversationSessionPreservesChatScopeWhenPendingUpsertNeverLanded(t *testing.T) {
	ctx := context.Background()
	setTestStateHome(t)
	store := openTestStore(t)

	created, err := NewServer().CreateChat(ctx, &methods.ACPNavCreateChatParams{
		SessionID: "conversation:chat-race",
	}, nil)
	require.NoError(t, err)
	require.NoError(t, store.BindConversationSession(
		ctx,
		"conversation:chat-race",
		"poolside",
		"sess-chat",
		created.Path,
	))

	conversations, err := store.listConversations(ctx)
	require.NoError(t, err)
	require.Len(t, conversations, 1)
	assert.Equal(t, chatWorkspacePath, conversations[0].WorkspacePath)
	assert.Equal(t, cleanPath(created.Path), conversations[0].Cwd)
}

// A conversation whose agent session is re-created (e.g. restored under a new
// session id) must track the newest binding.
func TestBindConversationSessionRebindsToNewestSession(t *testing.T) {
	ctx := context.Background()
	store := openTestStore(t)

	require.NoError(t, store.BindConversationSession(ctx, "conv-1", "poolside", "sess-old", "/repo"))
	require.NoError(t, store.BindConversationSession(ctx, "conv-1", "poolside", "sess-new", "/repo"))

	conversations, err := store.listConversations(ctx)
	require.NoError(t, err)
	require.Len(t, conversations, 1)
	assert.Equal(t, "sess-new", conversations[0].SessionID)
}

func TestBindConversationSessionValidatesInput(t *testing.T) {
	ctx := context.Background()
	store := openTestStore(t)

	assert.Error(t, store.BindConversationSession(ctx, "", "poolside", "sess", "/repo"))
	assert.Error(t, store.BindConversationSession(ctx, "conv", "", "sess", "/repo"))
	assert.Error(t, store.BindConversationSession(ctx, "conv", "poolside", "", "/repo"))
}
