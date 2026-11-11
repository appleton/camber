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
	store.runGit = func(context.Context, []string, ...string) ([]byte, error) { return nil, nil }
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
			require.FailNow(t, "closer not invoked")
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

func TestCloseSweepGivesEveryDescendantALiveContext(t *testing.T) {
	ctx := context.Background()
	server, store := cascadeFixture(t, filepath.Join(t.TempDir(), "nav.db"))
	release := make(chan struct{})
	var mu sync.Mutex
	var called, expired []string
	started := make(chan struct{}, 4)
	server.SetArchivedSessionCloser(func(c context.Context, agent, session string) {
		mu.Lock()
		called = append(called, session)
		if c.Err() != nil {
			expired = append(expired, session)
		}
		mu.Unlock()
		started <- struct{}{}
		<-release // every close blocks until all have started
	})
	store.closeArchivedSessions(ctx, []archivedSession{{"agent", "a"}, {"agent", "b"}, {"agent", "c"}})
	for range 3 {
		select {
		case <-started:
		case <-time.After(5 * time.Second):
			require.FailNow(t, "closers were not run concurrently")
		}
	}
	close(release)
	mu.Lock()
	defer mu.Unlock()
	assert.ElementsMatch(t, []string{"a", "b", "c"}, called)
	assert.Empty(t, expired)
}

func TestInsertUnderArchivedParentIsArchivedAndClosed(t *testing.T) {
	ctx := context.Background()
	server, store := cascadeFixture(t, filepath.Join(t.TempDir(), "nav.db"), "p")
	closed := make(chan string, 1)
	server.SetArchivedSessionCloser(func(_ context.Context, agent, session string) { closed <- agent + "/" + session })
	link(t, server, "kid", "p")
	_, err := server.ArchiveConversation(ctx, &methods.ACPNavArchiveConversationParams{ConversationID: "p"}, nil)
	require.NoError(t, err)

	require.NoError(t, store.UpsertConversation(ctx, methods.ACPNavConversation{ID: "kid", WorkspacePath: "/ws", Cwd: "/ws", AgentServer: "agent", SessionID: "s-kid", UpdatedAt: "2026-01-01T00:00:00Z"}))
	require.NoError(t, store.UpsertConversation(ctx, methods.ACPNavConversation{ID: "free", WorkspacePath: "/ws", Cwd: "/ws", AgentServer: "agent", SessionID: "s-free", UpdatedAt: "2026-01-01T00:00:00Z"}))
	assert.Equal(t, map[string]bool{"p": true, "kid": true, "free": false}, archivedSet(t, store))
	select {
	case got := <-closed:
		assert.Equal(t, "agent/s-kid", got)
	case <-time.After(5 * time.Second):
		require.FailNow(t, "closer not invoked for child inserted under archived parent")
	}
}

func TestRestoredSubAgentSurvivesReopenUntilParentArchivedAgain(t *testing.T) {
	ctx := context.Background()
	ws := t.TempDir()
	dbPath := filepath.Join(t.TempDir(), "nav.db")
	store, err := Open(ctx, dbPath)
	require.NoError(t, err)
	server := NewServer()
	server.SetStore(store)
	_, err = store.UpsertProject(ctx, methods.ACPNavUpsertProjectParams{Path: ws})
	require.NoError(t, err)
	conversation := func(id string) methods.ACPNavConversation {
		return methods.ACPNavConversation{ID: id, WorkspacePath: ws, Cwd: ws, AgentServer: "agent", SessionID: "s-" + id, UpdatedAt: "2026-01-01T00:00:00Z"}
	}
	for _, id := range []string{"p", "c", "g"} {
		require.NoError(t, store.UpsertConversation(ctx, conversation(id)))
	}
	link(t, server, "c", "p")
	link(t, server, "g", "c")
	_, err = server.ArchiveConversation(ctx, &methods.ACPNavArchiveConversationParams{ConversationID: "p"}, nil)
	require.NoError(t, err)
	require.NoError(t, store.RestoreConversation(ctx, conversation("c")))
	require.NoError(t, server.Close())

	store, err = Open(ctx, dbPath)
	require.NoError(t, err)
	server = NewServer()
	server.SetStore(store)
	t.Cleanup(func() { _ = server.Close() })
	assert.Equal(t, map[string]bool{"p": true, "c": false, "g": true}, archivedSet(t, store))

	// Archiving the parent again re-archives the child and clears the marker.
	_, err = server.ArchiveConversation(ctx, &methods.ACPNavArchiveConversationParams{ConversationID: "p"}, nil)
	require.NoError(t, err)
	assert.Equal(t, map[string]bool{"p": true, "c": true, "g": true}, archivedSet(t, store))
	var n int
	require.NoError(t, store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM metadata WHERE key = ?`, restoredKey("c")).Scan(&n))
	assert.Zero(t, n)
	_, err = store.reconcileArchivedOrphans(ctx)
	require.NoError(t, err)
	assert.True(t, archivedSet(t, store)["c"])
}

func TestParentLinkCacheStaysCoherentAfterControlWrite(t *testing.T) {
	ctx := context.Background()
	server, store := cascadeFixture(t, filepath.Join(t.TempDir(), "nav.db"), "p", "q", "c")
	parentOf := func() (string, string) {
		state, err := store.List(ctx)
		require.NoError(t, err)
		for _, c := range state.Conversations {
			if c.ID == "c" {
				return c.ParentID, c.RootID
			}
		}
		return "?", "?"
	}
	parent, root := parentOf() // loads the cache
	assert.Empty(t, parent)
	assert.Empty(t, root)

	require.NoError(t, server.WriteControlState(ctx, "conversation/c", map[string]string{"parentId": "p", "rootId": "p"}))
	parent, root = parentOf()
	assert.Equal(t, "p", parent)
	assert.Equal(t, "p", root)

	require.NoError(t, server.WriteControlState(ctx, "conversation/c", map[string]string{"parentId": "q", "rootId": "p"}))
	parent, _ = parentOf()
	assert.Equal(t, "q", parent)

	require.NoError(t, server.WriteControlState(ctx, "conversation/c", map[string]string{"note": "no links"}))
	parent, root = parentOf()
	assert.Empty(t, parent)
	assert.Empty(t, root)
}
