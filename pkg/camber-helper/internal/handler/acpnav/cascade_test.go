package acpnav

import (
	"context"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

func cascadeFixture(t *testing.T, dbPath string, ids ...string) (*Server, *Store) {
	t.Helper()
	ctx := context.Background()
	store, err := Open(ctx, dbPath)
	require.NoError(t, err)
	server := NewServer()
	server.SetStore(store)
	t.Cleanup(func() { _ = server.Close() })
	_, err = store.UpsertProject(ctx, methods.ACPNavUpsertProjectParams{Path: "/ws"})
	require.NoError(t, err)
	for _, id := range ids {
		require.NoError(t, store.UpsertConversation(ctx, methods.ACPNavConversation{
			ID: id, WorkspacePath: "/ws", Cwd: "/ws", AgentServer: "agent", SessionID: "s-" + id, UpdatedAt: "2026-01-01T00:00:00Z",
		}))
	}
	return server, store
}

func link(t *testing.T, s *Server, child, parent string) {
	t.Helper()
	require.NoError(t, s.WriteControlState(context.Background(), "conversation/"+child, map[string]string{"parentId": parent}))
}

func archivedSet(t *testing.T, store *Store) map[string]bool {
	t.Helper()
	state, err := store.List(context.Background())
	require.NoError(t, err)
	out := map[string]bool{}
	for _, c := range state.Conversations {
		out[c.ID] = c.Archived
	}
	return out
}

func TestArchiveCascadesToDescendantsOnly(t *testing.T) {
	ctx := context.Background()
	server, store := cascadeFixture(t, filepath.Join(t.TempDir(), "nav.db"), "p", "c", "g", "other", "sibling")
	link(t, server, "c", "p")
	link(t, server, "g", "c")
	link(t, server, "sibling", "other")

	_, err := server.ArchiveConversation(ctx, &methods.ACPNavArchiveConversationParams{ConversationID: "p"}, nil)
	require.NoError(t, err)
	assert.Equal(t, map[string]bool{"p": true, "c": true, "g": true, "other": false, "sibling": false}, archivedSet(t, store))

	// Idempotent: archiving again, or an already-archived child, succeeds.
	_, err = server.ArchiveConversation(ctx, &methods.ACPNavArchiveConversationParams{ConversationID: "c"}, nil)
	require.NoError(t, err)
	_, err = server.ArchiveConversation(ctx, &methods.ACPNavArchiveConversationParams{ConversationID: "p"}, nil)
	require.NoError(t, err)
}

func TestArchiveCascadeBySessionAndCycleSafe(t *testing.T) {
	ctx := context.Background()
	server, store := cascadeFixture(t, filepath.Join(t.TempDir(), "nav.db"), "a", "b", "c")
	link(t, server, "b", "a")
	link(t, server, "a", "b") // cycle
	link(t, server, "c", "c") // self link
	require.NoError(t, store.ArchiveConversation(ctx, "/ws", "", "agent", "s-a"))
	assert.Equal(t, map[string]bool{"a": true, "b": true, "c": false}, archivedSet(t, store))
}

func TestWorktreeRemovalCascadesToDescendants(t *testing.T) {
	ctx := context.Background()
	server, store := cascadeFixture(t, filepath.Join(t.TempDir(), "nav.db"), "child")
	parent, wt := t.TempDir(), t.TempDir()
	parentProject, err := store.UpsertProject(ctx, methods.ACPNavUpsertProjectParams{Path: parent})
	require.NoError(t, err)
	pp := parentProject.Path
	wtProject, err := store.UpsertProject(ctx, methods.ACPNavUpsertProjectParams{Path: wt, IsWorktree: true, ParentPath: &pp})
	require.NoError(t, err)
	store.runGit = func(context.Context, ...string) ([]byte, error) { return nil, nil }
	require.NoError(t, store.UpsertConversation(ctx, methods.ACPNavConversation{ID: "wtroot", WorkspacePath: wtProject.Path, Cwd: wtProject.Path, AgentServer: "agent", SessionID: "s-wtroot", UpdatedAt: "2026-01-01T00:00:00Z"}))
	link(t, server, "child", "wtroot")

	require.NoError(t, store.RemoveWorktree(ctx, wtProject.Path))
	assert.Equal(t, map[string]bool{"wtroot": true, "child": true}, archivedSet(t, store))
}

func TestArchiveCascadeClosesDescendantSessionsNotRoot(t *testing.T) {
	ctx := context.Background()
	server, _ := cascadeFixture(t, filepath.Join(t.TempDir(), "nav.db"), "p", "c", "g")
	link(t, server, "c", "p")
	link(t, server, "g", "c")
	var mu sync.Mutex
	var closed []string
	done := make(chan struct{}, 4)
	server.SetArchivedSessionCloser(func(_ context.Context, agent, session string) {
		mu.Lock()
		closed = append(closed, agent+"/"+session)
		mu.Unlock()
		done <- struct{}{}
	})
	_, err := server.ArchiveConversation(ctx, &methods.ACPNavArchiveConversationParams{ConversationID: "p"}, nil)
	require.NoError(t, err)
	for range 2 {
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("closer not invoked")
		}
	}
	mu.Lock()
	defer mu.Unlock()
	assert.ElementsMatch(t, []string{"agent/s-c", "agent/s-g"}, closed)
}

func TestOpenReconcilesArchivedOrphans(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "nav.db")
	server, store := cascadeFixture(t, dbPath, "p", "c", "g", "free")
	link(t, server, "c", "p")
	link(t, server, "g", "c")
	// Archive only the parent, bypassing the cascade, to model legacy data.
	_, err := store.db.ExecContext(ctx, `UPDATE conversations SET archived = 1 WHERE id = 'p'`)
	require.NoError(t, err)
	require.NoError(t, server.Close())

	reopened, err := Open(ctx, dbPath)
	require.NoError(t, err)
	t.Cleanup(func() { _ = reopened.Close() })
	assert.Equal(t, map[string]bool{"p": true, "c": true, "g": true, "free": false}, archivedSet(t, reopened))
}

func TestUpsertKeepsArchivedSubAgentArchivedUntilRestored(t *testing.T) {
	ctx := context.Background()
	ws := t.TempDir()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "nav.db"))
	require.NoError(t, err)
	server := NewServer()
	server.SetStore(store)
	t.Cleanup(func() { _ = server.Close() })
	_, err = store.UpsertProject(ctx, methods.ACPNavUpsertProjectParams{Path: ws})
	require.NoError(t, err)
	conversation := func(id string) methods.ACPNavConversation {
		return methods.ACPNavConversation{ID: id, WorkspacePath: ws, Cwd: ws, AgentServer: "agent", SessionID: "s-" + id, UpdatedAt: "2026-01-01T00:00:00Z"}
	}
	for _, id := range []string{"p", "c", "plain"} {
		require.NoError(t, store.UpsertConversation(ctx, conversation(id)))
	}
	link(t, server, "c", "p")
	_, err = server.ArchiveConversation(ctx, &methods.ACPNavArchiveConversationParams{ConversationID: "p"}, nil)
	require.NoError(t, err)
	_, err = server.ArchiveConversation(ctx, &methods.ACPNavArchiveConversationParams{ConversationID: "plain"}, nil)
	require.NoError(t, err)

	// A late save from the child's finishing turn must not revive it; other
	// conversations keep the existing upsert-unarchives behaviour.
	require.NoError(t, store.UpsertConversation(ctx, conversation("c")))
	require.NoError(t, store.UpsertConversation(ctx, conversation("plain")))
	assert.Equal(t, map[string]bool{"p": true, "c": true, "plain": false}, archivedSet(t, store))

	require.NoError(t, store.RestoreConversation(ctx, conversation("c")))
	assert.False(t, archivedSet(t, store)["c"])
}
