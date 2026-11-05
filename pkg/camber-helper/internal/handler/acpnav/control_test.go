package acpnav

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

func TestSafeWorktreeRemovalPreservesGitFailure(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "nav.db"))
	require.NoError(t, err)
	defer store.Close()
	parent := t.TempDir()
	path := filepath.Join(parent, "child")
	parentProject, err := store.UpsertProject(ctx, methods.ACPNavUpsertProjectParams{Path: parent})
	require.NoError(t, err)
	parent = parentProject.Path
	_, err = store.UpsertProject(ctx, methods.ACPNavUpsertProjectParams{Path: path, IsWorktree: true, ParentPath: &parent})
	require.NoError(t, err)
	store.runGit = func(_ context.Context, args ...string) ([]byte, error) {
		assert.NotContains(t, args, "--force")
		return []byte("worktree is locked"), errors.New("exit status 128")
	}
	err = store.RemoveWorktreeSafely(ctx, path)
	require.ErrorContains(t, err, "worktree is locked")
	state, err := store.List(ctx)
	require.NoError(t, err)
	assert.Len(t, state.Projects, 2)
}
func TestControlStatePersistsAcrossStoreReopen(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "nav.db")
	store, err := Open(ctx, dbPath)
	require.NoError(t, err)
	server := NewServer()
	server.SetStore(store)
	require.NoError(t, server.WriteControlState(ctx, "conversation/child", map[string]string{"parentId": "parent"}))
	require.NoError(t, server.Close())
	store, err = Open(ctx, dbPath)
	require.NoError(t, err)
	server.SetStore(store)
	defer server.Close()
	var record map[string]string
	require.NoError(t, server.ReadControlState(ctx, "conversation/child", &record))
	assert.Equal(t, "parent", record["parentId"])
}

func TestControlConversationIncludesLiveStatusAndHostFiltering(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "nav.db"))
	require.NoError(t, err)
	server := NewServer()
	server.SetStore(store)
	defer server.Close()
	require.NoError(t, store.UpsertConversation(ctx, methods.ACPNavConversation{ID: "wanted", AgentServer: "test", SessionID: "session", WorkspacePath: t.TempDir()}))
	require.NoError(t, store.UpsertConversation(ctx, methods.ACPNavConversation{ID: "other", AgentServer: "test", WorkspacePath: t.TempDir()}))
	server.liveStatuses["test\x00session"] = methods.ACPNavConversationLiveStatus{Working: true}
	conversation, err := server.ControlConversation(ctx, "wanted")
	require.NoError(t, err)
	assert.Equal(t, "wanted", conversation.ID)
	require.NotNil(t, conversation.LiveStatus)
	assert.True(t, conversation.LiveStatus.Working)
	_, err = server.ControlConversation(ctx, "missing")
	require.ErrorContains(t, err, "does not exist")
	server.SetStateFilter(func(state methods.ACPNavState) methods.ACPNavState {
		state.Conversations = nil
		return state
	})
	_, err = server.ControlConversation(ctx, "wanted")
	require.ErrorContains(t, err, "does not exist")
}

func TestListIncludesControlParentLinks(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "nav.db"))
	require.NoError(t, err)
	server := NewServer()
	server.SetStore(store)
	defer server.Close()
	require.NoError(t, store.UpsertConversation(ctx, methods.ACPNavConversation{ID: "parent", AgentServer: "test", WorkspacePath: t.TempDir()}))
	require.NoError(t, store.UpsertConversation(ctx, methods.ACPNavConversation{ID: "child", AgentServer: "test", WorkspacePath: t.TempDir()}))
	require.NoError(t, server.WriteControlState(ctx, "conversation/child", map[string]string{"parentId": "parent", "rootId": "parent", "task": "x"}))

	state, err := store.List(ctx)
	require.NoError(t, err)
	byID := map[string]methods.ACPNavConversation{}
	for _, c := range state.Conversations {
		byID[c.ID] = c
	}
	assert.Equal(t, "parent", byID["child"].ParentID)
	assert.Equal(t, "parent", byID["child"].RootID)
	assert.Empty(t, byID["parent"].ParentID)
	assert.Empty(t, byID["parent"].RootID)

	one, err := server.ControlConversation(ctx, "child")
	require.NoError(t, err)
	assert.Equal(t, "parent", one.ParentID)
}
