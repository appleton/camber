package acpnav

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/adrg/xdg"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

func setTestStateHome(t *testing.T) {
	t.Helper()
	previous := xdg.StateHome
	xdg.StateHome = t.TempDir()
	t.Cleanup(func() { xdg.StateHome = previous })
}

func TestStoreFileOpener(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })

	// Defaults to empty when nothing has been chosen yet.
	opener, err := store.GetFileOpener(ctx)
	require.NoError(t, err)
	assert.Equal(t, "", opener)

	// Persists and reads back a choice.
	require.NoError(t, store.SetFileOpener(ctx, "cursor"))
	opener, err = store.GetFileOpener(ctx)
	require.NoError(t, err)
	assert.Equal(t, "cursor", opener)

	// Updates an existing choice and trims whitespace.
	require.NoError(t, store.SetFileOpener(ctx, "  zed  "))
	opener, err = store.GetFileOpener(ctx)
	require.NoError(t, err)
	assert.Equal(t, "zed", opener)

	// Clearing falls back to empty (platform default).
	require.NoError(t, store.SetFileOpener(ctx, "   "))
	opener, err = store.GetFileOpener(ctx)
	require.NoError(t, err)
	assert.Equal(t, "", opener)
}

func TestStoreKeybindings(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })

	// Defaults to an empty map when nothing has been overridden yet.
	keybindings, err := store.GetKeybindings(ctx)
	require.NoError(t, err)
	assert.Empty(t, keybindings)

	// Persists and reads back overrides, including an explicit unbind (nil).
	modJ := "mod+j"
	require.NoError(t, store.SetKeybindings(ctx, methods.ACPNavKeybindings{
		"focusInput":     &modJ,
		"togglePlanMode": nil,
	}))
	keybindings, err = store.GetKeybindings(ctx)
	require.NoError(t, err)
	require.Len(t, keybindings, 2)
	require.NotNil(t, keybindings["focusInput"])
	assert.Equal(t, "mod+j", *keybindings["focusInput"])
	assert.Contains(t, keybindings, "togglePlanMode")
	assert.Nil(t, keybindings["togglePlanMode"])

	// Replaces the whole map on write.
	modK := "mod+k"
	require.NoError(t, store.SetKeybindings(ctx, methods.ACPNavKeybindings{"newConversation": &modK}))
	keybindings, err = store.GetKeybindings(ctx)
	require.NoError(t, err)
	require.Len(t, keybindings, 1)
	require.NotNil(t, keybindings["newConversation"])
	assert.Equal(t, "mod+k", *keybindings["newConversation"])

	// Clearing removes all overrides.
	require.NoError(t, store.SetKeybindings(ctx, methods.ACPNavKeybindings{}))
	keybindings, err = store.GetKeybindings(ctx)
	require.NoError(t, err)
	assert.Empty(t, keybindings)
}

func TestStoreProjectsAndConversations(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })

	parent, err := store.UpsertProject(ctx, methods.ACPNavUpsertProjectParams{
		Path: "/repo",
		Name: "repo",
	})
	require.NoError(t, err)
	parentPath := parent.Path
	_, err = store.UpsertProject(ctx, methods.ACPNavUpsertProjectParams{
		Path:       "/repo-worktree",
		Name:       "repo worktree",
		IsWorktree: true,
		ParentPath: &parentPath,
	})
	require.NoError(t, err)

	require.NoError(t, store.UpsertConversation(ctx, methods.ACPNavConversation{
		WorkspacePath: "/repo",
		AgentServer:   "poolside",
		SessionID:     "s-1",
		Cwd:           "/repo",
		Title:         "Build nav",
		UpdatedAt:     "2026-05-11T10:00:00Z",
	}))

	state, err := store.List(ctx)
	require.NoError(t, err)
	require.Len(t, state.Projects, 2)
	require.Len(t, state.Conversations, 1)
	require.Equal(t, "Build nav", state.Conversations[0].Title)

	require.NoError(t, store.SetProjectCollapsed(ctx, "/repo", true))
	state, err = store.List(ctx)
	require.NoError(t, err)
	require.True(t, state.Projects[0].Collapsed)

	settings, err := store.SetProjectSettings(ctx, methods.ACPNavSetProjectSettingsParams{
		Path:           "/repo",
		SetupScript:    "pnpm install",
		TeardownScript: "pnpm stop",
		UserPrompt:     "Reply like a pirate.",
	})
	require.NoError(t, err)
	require.Equal(t, "pnpm install", settings.SetupScript)
	require.Equal(t, "pnpm stop", settings.TeardownScript)
	require.Equal(t, "Reply like a pirate.", settings.UserPrompt)

	settings, err = store.GetProjectSettings(ctx, "/repo")
	require.NoError(t, err)
	require.Equal(t, "pnpm install", settings.SetupScript)
	require.Equal(t, "pnpm stop", settings.TeardownScript)
	require.Equal(t, "Reply like a pirate.", settings.UserPrompt)

	_, err = store.UpsertProject(ctx, methods.ACPNavUpsertProjectParams{
		Path: "/repo",
		Name: "repo",
	})
	require.NoError(t, err)
	state, err = store.List(ctx)
	require.NoError(t, err)
	require.True(t, state.Projects[0].Collapsed)
	require.Equal(t, "pnpm install", state.Projects[0].SetupScript)
	require.Equal(t, "pnpm stop", state.Projects[0].TeardownScript)
	require.Equal(t, "Reply like a pirate.", state.Projects[0].UserPrompt)

	require.NoError(t, store.ArchiveConversation(ctx, "/repo", "", "poolside", "s-1"))
	state, err = store.List(ctx)
	require.NoError(t, err)
	require.Len(t, state.Conversations, 1)
	require.False(t, state.Conversations[0].Active)
	require.True(t, state.Conversations[0].Archived)
}

func TestRenameProjectUpdatesRootNameAndWorktreeNickname(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })

	parent, err := store.UpsertProject(ctx, methods.ACPNavUpsertProjectParams{
		Path: "/repo",
		Name: "repo",
	})
	require.NoError(t, err)
	parentPath := parent.Path
	_, err = store.UpsertProject(ctx, methods.ACPNavUpsertProjectParams{
		Path:       "/repo-worktree",
		Name:       "repo worktree",
		IsWorktree: true,
		ParentPath: &parentPath,
	})
	require.NoError(t, err)

	require.NoError(t, store.RenameProject(ctx, "/repo", "Renamed Repo"))
	require.NoError(t, store.RenameProject(ctx, "/repo-worktree", "Renamed Worktree"))

	state, err := store.List(ctx)
	require.NoError(t, err)
	projects := map[string]methods.ACPNavProject{}
	for _, project := range state.Projects {
		projects[project.Path] = project
	}
	require.Contains(t, projects, "/repo")
	require.Contains(t, projects, "/repo-worktree")
	assert.Equal(t, "Renamed Repo", projects["/repo"].Name)
	assert.Equal(t, "Renamed Repo", projects["/repo"].Nickname)
	assert.Equal(t, "repo worktree", projects["/repo-worktree"].Name)
	assert.Equal(t, "Renamed Worktree", projects["/repo-worktree"].Nickname)
}

func TestDeleteConversationBySession(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })

	for _, conversation := range []methods.ACPNavConversation{
		{
			WorkspacePath: "/repo",
			AgentServer:   "poolside",
			SessionID:     "s-1",
			Cwd:           "/repo",
			Title:         "Camber one",
		},
		{
			WorkspacePath: "/repo",
			AgentServer:   "poolside",
			SessionID:     "s-1",
			Cwd:           "/repo",
			Title:         "Camber duplicate",
		},
		{
			WorkspacePath: "/repo",
			AgentServer:   "other",
			SessionID:     "s-1",
			Cwd:           "/repo",
			Title:         "Other server",
		},
	} {
		require.NoError(t, store.UpsertConversation(ctx, conversation))
	}

	require.NoError(t, store.DeleteConversationBySession(ctx, "poolside", "s-1"))

	state, err := store.List(ctx)
	require.NoError(t, err)
	require.Len(t, state.Conversations, 1)
	require.Equal(t, "other", state.Conversations[0].AgentServer)
}

func TestStoreReordersRootProjects(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })

	_, err = store.UpsertProject(ctx, methods.ACPNavUpsertProjectParams{Path: "/alpha", Name: "alpha"})
	require.NoError(t, err)
	_, err = store.UpsertProject(ctx, methods.ACPNavUpsertProjectParams{Path: "/bravo", Name: "bravo"})
	require.NoError(t, err)
	_, err = store.UpsertProject(ctx, methods.ACPNavUpsertProjectParams{Path: "/charlie", Name: "charlie"})
	require.NoError(t, err)

	state, err := store.List(ctx)
	require.NoError(t, err)
	require.Len(t, state.Projects, 3)
	require.Equal(t, []string{"/alpha", "/bravo", "/charlie"}, []string{
		state.Projects[0].Path,
		state.Projects[1].Path,
		state.Projects[2].Path,
	})

	require.NoError(t, store.ReorderProjects(ctx, []string{"/charlie", "/alpha", "/bravo"}))

	state, err = store.List(ctx)
	require.NoError(t, err)
	require.Len(t, state.Projects, 3)
	require.Equal(t, []string{"/charlie", "/alpha", "/bravo"}, []string{
		state.Projects[0].Path,
		state.Projects[1].Path,
		state.Projects[2].Path,
	})
	require.Equal(t, 0, state.Projects[0].DisplayOrder)
	require.Equal(t, 1, state.Projects[1].DisplayOrder)
	require.Equal(t, 2, state.Projects[2].DisplayOrder)
}

func TestStoreOrdersAndReordersWorktrees(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })

	parent, err := store.UpsertProject(ctx, methods.ACPNavUpsertProjectParams{Path: "/repo", Name: "repo"})
	require.NoError(t, err)
	parentPath := parent.Path

	// Each newly created worktree lands first within its parent.
	for _, name := range []string{"alpha", "bravo", "charlie"} {
		_, err = store.UpsertProject(ctx, methods.ACPNavUpsertProjectParams{
			Path:       "/repo/worktrees/" + name,
			Name:       name,
			IsWorktree: true,
			ParentPath: &parentPath,
		})
		require.NoError(t, err)
	}

	state, err := store.List(ctx)
	require.NoError(t, err)
	require.Len(t, state.Projects, 4)
	require.Equal(t, "/repo", state.Projects[0].Path, "root project sorts before its worktrees")
	require.Equal(t, []string{
		"/repo/worktrees/charlie",
		"/repo/worktrees/bravo",
		"/repo/worktrees/alpha",
	}, []string{state.Projects[1].Path, state.Projects[2].Path, state.Projects[3].Path})

	// An explicit reorder persists and renumbers from zero.
	require.NoError(t, store.ReorderWorktrees(ctx, parentPath, []string{
		"/repo/worktrees/alpha",
		"/repo/worktrees/bravo",
		"/repo/worktrees/charlie",
	}))

	state, err = store.List(ctx)
	require.NoError(t, err)
	require.Equal(t, []string{
		"/repo/worktrees/alpha",
		"/repo/worktrees/bravo",
		"/repo/worktrees/charlie",
	}, []string{state.Projects[1].Path, state.Projects[2].Path, state.Projects[3].Path})
	assert.Equal(t, 0, state.Projects[1].DisplayOrder)
	assert.Equal(t, 1, state.Projects[2].DisplayOrder)
	assert.Equal(t, 2, state.Projects[3].DisplayOrder)
}

func TestReorderWorktreesIsScopedToParent(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })

	repoA, err := store.UpsertProject(ctx, methods.ACPNavUpsertProjectParams{Path: "/a", Name: "a"})
	require.NoError(t, err)
	repoB, err := store.UpsertProject(ctx, methods.ACPNavUpsertProjectParams{Path: "/b", Name: "b"})
	require.NoError(t, err)
	pathA, pathB := repoA.Path, repoB.Path
	_, err = store.UpsertProject(ctx, methods.ACPNavUpsertProjectParams{
		Path: "/a/wt", Name: "wt", IsWorktree: true, ParentPath: &pathA,
	})
	require.NoError(t, err)
	_, err = store.UpsertProject(ctx, methods.ACPNavUpsertProjectParams{
		Path: "/b/wt", Name: "wt", IsWorktree: true, ParentPath: &pathB,
	})
	require.NoError(t, err)

	// Reordering under parent /a must not accept a worktree owned by /b.
	err = store.ReorderWorktrees(ctx, pathA, []string{"/b/wt"})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "worktree not found")
}

// Guards the 20260619 migration: legacy worktrees (all display_order 0) must be
// backfilled so the persisted order matches the previous created_at DESC
// rendering (newest first).
func TestBackfillWorktreeDisplayOrderPreservesNewestFirst(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })

	parent, err := store.UpsertProject(ctx, methods.ACPNavUpsertProjectParams{Path: "/repo", Name: "repo"})
	require.NoError(t, err)
	parentPath := parent.Path
	for _, name := range []string{"old", "mid", "new"} {
		_, err = store.UpsertProject(ctx, methods.ACPNavUpsertProjectParams{
			Path: "/repo/worktrees/" + name, Name: name, IsWorktree: true, ParentPath: &parentPath,
		})
		require.NoError(t, err)
	}

	// Recreate a pre-migration state: flat display_order, ordering only in created_at.
	_, err = store.db.ExecContext(ctx, `UPDATE projects SET display_order = 0 WHERE is_worktree = 1`)
	require.NoError(t, err)
	for path, createdAt := range map[string]string{
		"/repo/worktrees/old": "2026-05-20T09:00:00Z",
		"/repo/worktrees/mid": "2026-05-20T10:00:00Z",
		"/repo/worktrees/new": "2026-05-20T11:00:00Z",
	} {
		_, err = store.db.ExecContext(ctx, `UPDATE projects SET created_at = ? WHERE path = ?`, createdAt, path)
		require.NoError(t, err)
	}

	// The backfill statement from the migration.
	_, err = store.db.ExecContext(ctx, `
UPDATE projects
SET display_order = (
  SELECT COUNT(*)
  FROM projects AS sibling
  WHERE sibling.is_worktree = 1
    AND sibling.parent_path IS projects.parent_path
    AND (
      sibling.created_at > projects.created_at
      OR (sibling.created_at = projects.created_at AND sibling.path < projects.path)
    )
)
WHERE is_worktree = 1`)
	require.NoError(t, err)

	state, err := store.List(ctx)
	require.NoError(t, err)
	require.Len(t, state.Projects, 4)
	require.Equal(t, []string{
		"/repo/worktrees/new",
		"/repo/worktrees/mid",
		"/repo/worktrees/old",
	}, []string{state.Projects[1].Path, state.Projects[2].Path, state.Projects[3].Path})
	assert.Equal(t, 0, state.Projects[1].DisplayOrder)
	assert.Equal(t, 1, state.Projects[2].DisplayOrder)
	assert.Equal(t, 2, state.Projects[3].DisplayOrder)
}

// Guards the 20260619130000 migration: legacy root projects (all display_order
// 0) must be backfilled so the new display_order ordering preserves the previous
// alphabetical (name COLLATE NOCASE, path) order rather than re-sorting them.
func TestBackfillRootDisplayOrderPreservesAlphabetical(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })

	for _, p := range []struct{ path, name string }{
		{"/c", "Charlie"},
		{"/a", "alpha"},
		{"/b", "Bravo"},
	} {
		_, err = store.UpsertProject(ctx, methods.ACPNavUpsertProjectParams{Path: p.path, Name: p.name})
		require.NoError(t, err)
	}

	// Recreate a pre-migration state: every root shares display_order 0.
	_, err = store.db.ExecContext(ctx, `UPDATE projects SET display_order = 0 WHERE is_worktree = 0`)
	require.NoError(t, err)

	// The backfill statement from the migration.
	_, err = store.db.ExecContext(ctx, `
UPDATE projects
SET display_order = (
  SELECT COUNT(*)
  FROM projects AS sibling
  WHERE sibling.is_worktree = 0
    AND (
      sibling.name COLLATE NOCASE < projects.name COLLATE NOCASE
      OR (sibling.name COLLATE NOCASE = projects.name COLLATE NOCASE AND sibling.path < projects.path)
    )
)
WHERE is_worktree = 0`)
	require.NoError(t, err)

	state, err := store.List(ctx)
	require.NoError(t, err)
	require.Len(t, state.Projects, 3)
	require.Equal(t, []string{"/a", "/b", "/c"}, []string{
		state.Projects[0].Path, state.Projects[1].Path, state.Projects[2].Path,
	}, "case-insensitive alphabetical order is preserved")
	assert.Equal(t, 0, state.Projects[0].DisplayOrder)
	assert.Equal(t, 1, state.Projects[1].DisplayOrder)
	assert.Equal(t, 2, state.Projects[2].DisplayOrder)
}

func TestPrepareWorktreeReservesNameWithoutWritingDB(t *testing.T) {
	setTestStateHome(t)
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })

	_, err = store.UpsertProject(ctx, methods.ACPNavUpsertProjectParams{
		Path: "/repo",
		Name: "repo",
	})
	require.NoError(t, err)

	prepared, err := store.PrepareWorktree(ctx, "/repo")
	require.NoError(t, err)
	require.True(t, prepared.IsWorktree)
	require.NotEmpty(t, prepared.Name)

	state, err := store.List(ctx)
	require.NoError(t, err)
	require.Len(t, state.Projects, 1, "prepared worktree must not be persisted")

	second, err := store.PrepareWorktree(ctx, "/repo")
	require.NoError(t, err)
	require.NotEqual(t, prepared.Name, second.Name, "second prepare must skip the reserved name")
}

func TestReleasePreparedWorktreeFreesReservation(t *testing.T) {
	setTestStateHome(t)
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })

	_, err = store.UpsertProject(ctx, methods.ACPNavUpsertProjectParams{
		Path: "/repo",
		Name: "repo",
	})
	require.NoError(t, err)

	prepared, err := store.PrepareWorktree(ctx, "/repo")
	require.NoError(t, err)

	store.ReleasePreparedWorktree(prepared.Path)
	store.ReleasePreparedWorktree(prepared.Path) // idempotent

	require.Empty(t, store.preparedWorktrees, "release should clear the reservation")
}

func TestPrepareWorktreeDoesNotWaitForCreateGit(t *testing.T) {
	setTestStateHome(t)
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })

	_, err = store.UpsertProject(ctx, methods.ACPNavUpsertProjectParams{Path: "/repo", Name: "repo"})
	require.NoError(t, err)

	gitStarted := make(chan struct{})
	releaseGit := make(chan struct{})
	createDone := make(chan error, 1)
	store.runGit = func(context.Context, ...string) ([]byte, error) {
		close(gitStarted)
		<-releaseGit
		return nil, nil
	}

	go func() {
		_, err := store.CreateWorktree(ctx, "/repo", "feature")
		createDone <- err
	}()
	require.Eventually(t, func() bool {
		select {
		case <-gitStarted:
			return true
		default:
			return false
		}
	}, time.Second, time.Millisecond)

	prepared, err := store.PrepareWorktree(ctx, "/repo")
	require.NoError(t, err)
	require.NotEmpty(t, prepared.Name)

	close(releaseGit)
	require.NoError(t, <-createDone)
}

func TestCreateWorktreeSerializesGitForSameParentRepo(t *testing.T) {
	setTestStateHome(t)
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })
	_, err = store.UpsertProject(ctx, methods.ACPNavUpsertProjectParams{Path: "/repo", Name: "repo"})
	require.NoError(t, err)

	started := make(chan string, 2)
	releaseFirst := make(chan struct{})
	var mu sync.Mutex
	active := 0
	calls := 0
	store.runGit = func(_ context.Context, args ...string) ([]byte, error) {
		mu.Lock()
		active++
		assert.Equal(t, 1, active, "same-repo git commands must not overlap")
		calls++
		call := calls
		mu.Unlock()

		started <- args[len(args)-1]
		if call == 1 {
			<-releaseFirst
		}

		mu.Lock()
		active--
		mu.Unlock()
		return nil, nil
	}

	done := make(chan error, 2)
	go func() {
		_, err := store.CreateWorktree(ctx, "/repo", "one")
		done <- err
	}()
	go func() {
		_, err := store.CreateWorktree(ctx, "/repo", "two")
		done <- err
	}()

	first := <-started
	require.Contains(t, []string{
		filepath.Join(worktreeStorageDir("/repo"), "one"),
		filepath.Join(worktreeStorageDir("/repo"), "two"),
	}, first)
	select {
	case second := <-started:
		require.Failf(t, "second git command started before first completed", "second path: %s", second)
	case <-time.After(50 * time.Millisecond):
	}
	close(releaseFirst)
	<-started
	require.NoError(t, <-done)
	require.NoError(t, <-done)
}

func TestCreateWorktreeRunsGitInParallelForDifferentParentRepos(t *testing.T) {
	setTestStateHome(t)
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })
	_, err = store.UpsertProject(ctx, methods.ACPNavUpsertProjectParams{Path: "/repo-a", Name: "repo-a"})
	require.NoError(t, err)
	_, err = store.UpsertProject(ctx, methods.ACPNavUpsertProjectParams{Path: "/repo-b", Name: "repo-b"})
	require.NoError(t, err)

	started := make(chan string, 2)
	releaseGit := make(chan struct{})
	store.runGit = func(_ context.Context, args ...string) ([]byte, error) {
		started <- args[1]
		<-releaseGit
		return nil, nil
	}

	done := make(chan error, 2)
	go func() {
		_, err := store.CreateWorktree(ctx, "/repo-a", "one")
		done <- err
	}()
	go func() {
		_, err := store.CreateWorktree(ctx, "/repo-b", "two")
		done <- err
	}()

	require.Eventually(t, func() bool { return len(started) == 2 }, time.Second, time.Millisecond)
	close(releaseGit)
	require.ElementsMatch(t, []string{"/repo-a", "/repo-b"}, []string{<-started, <-started})
	require.NoError(t, <-done)
	require.NoError(t, <-done)
}

func TestCreateWorktreeSelfGeneratedNamesAreReservedWhileGitRuns(t *testing.T) {
	setTestStateHome(t)
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })
	_, err = store.UpsertProject(ctx, methods.ACPNavUpsertProjectParams{Path: "/repo", Name: "repo"})
	require.NoError(t, err)

	started := make(chan string, 2)
	releaseFirst := make(chan struct{})
	calls := 0
	var mu sync.Mutex
	store.runGit = func(_ context.Context, args ...string) ([]byte, error) {
		mu.Lock()
		calls++
		call := calls
		mu.Unlock()
		started <- args[len(args)-1]
		if call == 1 {
			<-releaseFirst
		}
		return nil, nil
	}

	done := make(chan methods.ACPNavProject, 2)
	errs := make(chan error, 2)
	go func() {
		project, err := store.CreateWorktree(ctx, "/repo", "")
		done <- project
		errs <- err
	}()
	go func() {
		project, err := store.CreateWorktree(ctx, "/repo", "")
		done <- project
		errs <- err
	}()

	<-started
	close(releaseFirst)
	<-started
	first := <-done
	second := <-done
	require.NoError(t, <-errs)
	require.NoError(t, <-errs)
	require.NotEqual(t, first.Path, second.Path)
}

func TestCreateWorktreeFailingExplicitNameDoesNotRemoveExistingDirectory(t *testing.T) {
	setTestStateHome(t)
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })

	existingPath := filepath.Join(worktreeStorageDir("/repo"), "feature")
	require.NoError(t, os.MkdirAll(existingPath, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(existingPath, "keep.txt"), []byte("keep"), 0o644))
	store.runGit = func(context.Context, ...string) ([]byte, error) {
		return []byte("already exists"), errors.New("git failed")
	}

	_, err = store.CreateWorktree(ctx, "/repo", "feature")
	require.Error(t, err)
	require.FileExists(t, filepath.Join(existingPath, "keep.txt"))
}

func TestStoreConversationMetadata(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })

	require.NoError(t, store.UpsertConversation(ctx, methods.ACPNavConversation{
		ID:            "conv-1",
		WorkspacePath: "/repo",
		AgentServer:   "poolside",
		SessionID:     "s-1",
		Cwd:           "/repo",
		Metadata:      []byte(`{"processes":["pnpm test"],"explored":[],"edited":[]}`),
	}))

	state, err := store.List(ctx)
	require.NoError(t, err)
	require.Len(t, state.Conversations, 1)
	require.JSONEq(t, `{"processes":["pnpm test"],"explored":[],"edited":[]}`, string(state.Conversations[0].Metadata))

	require.NoError(t, store.UpsertConversation(ctx, methods.ACPNavConversation{
		ID:            "conv-1",
		WorkspacePath: "/repo",
		AgentServer:   "poolside",
		SessionID:     "s-1",
		Cwd:           "/repo",
		Title:         "Updated title",
	}))

	state, err = store.List(ctx)
	require.NoError(t, err)
	require.Len(t, state.Conversations, 1)
	require.Equal(t, "Updated title", state.Conversations[0].Title)
	require.JSONEq(t, `{"processes":["pnpm test"],"explored":[],"edited":[]}`, string(state.Conversations[0].Metadata))
}

func TestUpdateConversationTitleByAgentSession(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })

	require.NoError(t, store.UpsertConversation(ctx, methods.ACPNavConversation{
		ID:            "conv-1",
		WorkspacePath: "/repo",
		AgentServer:   "claude-acp",
		SessionID:     "s-1",
		Cwd:           "/repo",
		Title:         "First prompt fallback",
		Nickname:      "My pinned name",
	}))
	require.NoError(t, store.ArchiveConversation(ctx, "/repo", "conv-1", "claude-acp", "s-1"))

	changed, err := store.UpdateConversationTitle(ctx, "claude-acp", "s-1", "Generated title")
	require.NoError(t, err)
	require.True(t, changed)

	state, err := store.List(ctx)
	require.NoError(t, err)
	require.Len(t, state.Conversations, 1)
	assert.Equal(t, "Generated title", state.Conversations[0].Title)
	assert.Equal(t, "My pinned name", state.Conversations[0].Nickname)
	assert.True(t, state.Conversations[0].Archived)

	changed, err = store.UpdateConversationTitle(ctx, "claude-acp", "s-1", "Generated title")
	require.NoError(t, err)
	assert.False(t, changed)

	changed, err = store.UpdateConversationTitle(ctx, "claude-acp", "missing", "Another title")
	require.NoError(t, err)
	assert.False(t, changed)
}

func TestRenameConversationConditionallyUpdatesTitle(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })

	require.NoError(t, store.UpsertConversation(ctx, methods.ACPNavConversation{
		ID:            "conv-1",
		WorkspacePath: "/repo",
		AgentServer:   "poolside",
		SessionID:     "s-1",
		Cwd:           "/repo",
		Title:         "Generated title",
	}))

	require.NoError(t, store.RenameConversation(ctx, "conv-1", "User nickname", ""))
	state, err := store.List(ctx)
	require.NoError(t, err)
	require.Len(t, state.Conversations, 1)
	require.Equal(t, "User nickname", state.Conversations[0].Nickname)
	require.Equal(t, "Generated title", state.Conversations[0].Title)

	require.NoError(t, store.RenameConversation(ctx, "conv-1", "Synced nickname", "Synced title"))
	state, err = store.List(ctx)
	require.NoError(t, err)
	require.Len(t, state.Conversations, 1)
	require.Equal(t, "Synced nickname", state.Conversations[0].Nickname)
	require.Equal(t, "Synced title", state.Conversations[0].Title)
}

func TestArchiveConversationMatchesCwdWhenWorkspacePathDiffers(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })

	require.NoError(t, store.UpsertConversation(ctx, methods.ACPNavConversation{
		WorkspacePath: "/repo",
		AgentServer:   "claude-acp",
		SessionID:     "s-1",
		Cwd:           "/repo-worktree",
		Title:         "Run pwd",
	}))

	require.NoError(t, store.ArchiveConversation(ctx, "/repo-worktree", "", "claude-acp", "s-1"))

	state, err := store.List(ctx)
	require.NoError(t, err)
	require.Len(t, state.Conversations, 1)
	require.True(t, state.Conversations[0].Archived)
}

func TestArchiveConversationBySessionFallsBackWhenWorkspacePathDiffers(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })

	require.NoError(t, store.UpsertConversation(ctx, methods.ACPNavConversation{
		WorkspacePath: "/repo",
		AgentServer:   "poolside",
		SessionID:     "s-1",
		Cwd:           "/repo",
		Title:         "Existing conversation",
	}))

	require.NoError(t, store.ArchiveConversation(ctx, ideWorkspacePath, "", "poolside", "s-1"))

	state, err := store.List(ctx)
	require.NoError(t, err)
	require.Len(t, state.Conversations, 1)
	require.True(t, state.Conversations[0].Archived)
}

func TestArchiveSessionlessConversationByID(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })

	require.NoError(t, store.UpsertConversation(ctx, methods.ACPNavConversation{
		ID:            "conv-1",
		WorkspacePath: "/repo-worktree",
		AgentServer:   "poolside",
		Cwd:           "/repo-worktree",
		Title:         "New conversation",
	}))

	require.NoError(t, store.ArchiveConversation(ctx, "/repo-worktree", "conv-1", "poolside", ""))

	state, err := store.List(ctx)
	require.NoError(t, err)
	require.Len(t, state.Conversations, 1)
	require.True(t, state.Conversations[0].Archived)
}

func TestArchiveSessionlessConversationByIDIgnoresWorkspacePath(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })

	require.NoError(t, store.UpsertConversation(ctx, methods.ACPNavConversation{
		ID:            "conv-1",
		WorkspacePath: "/repo",
		AgentServer:   "poolside",
		Cwd:           "/repo",
		Title:         "New conversation",
	}))

	require.NoError(t, store.ArchiveConversation(ctx, ideWorkspacePath, "conv-1", "poolside", ""))

	state, err := store.List(ctx)
	require.NoError(t, err)
	require.Len(t, state.Conversations, 1)
	require.True(t, state.Conversations[0].Archived)
}

func TestRestoreConversationRecreatesProject(t *testing.T) {
	ctx := context.Background()
	projectPath := t.TempDir()
	cleanProjectPath, err := filepath.EvalSymlinks(projectPath)
	require.NoError(t, err)
	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })

	require.NoError(t, store.RestoreConversation(ctx, methods.ACPNavConversation{
		ID:            "conv-1",
		WorkspacePath: projectPath,
		AgentServer:   "poolside",
		SessionID:     "s-1",
		Cwd:           projectPath,
		Title:         "Restored",
		UpdatedAt:     "2026-05-11T10:00:00Z",
	}))

	state, err := store.List(ctx)
	require.NoError(t, err)
	require.Len(t, state.Projects, 1)
	require.Equal(t, cleanProjectPath, state.Projects[0].Path)
	require.Len(t, state.Conversations, 1)
	require.Equal(t, "conv-1", state.Conversations[0].ID)
	require.Equal(t, "Restored", state.Conversations[0].Title)
}

func TestUpsertProjectClassifiesLinkedGitWorktreeFromMetadata(t *testing.T) {
	ctx := context.Background()
	repoPath, worktreePath := createMetadataOnlyGitWorktree(t)

	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })

	project, err := store.UpsertProject(ctx, methods.ACPNavUpsertProjectParams{
		Path: worktreePath,
		Name: filepath.Base(worktreePath),
	})
	require.NoError(t, err)

	state, err := store.List(ctx)
	require.NoError(t, err)
	require.Len(t, state.Projects, 2)
	require.Equal(t, cleanPath(worktreePath), project.Path)
	require.True(t, project.IsWorktree)
	require.NotNil(t, project.ParentPath)
	require.Equal(t, cleanPath(repoPath), *project.ParentPath)
	require.Equal(t, cleanPath(repoPath), state.Projects[0].Path)
	require.False(t, state.Projects[0].IsWorktree)
	require.Equal(t, cleanPath(worktreePath), state.Projects[1].Path)
	require.True(t, state.Projects[1].IsWorktree)
}

func TestUpsertProjectStoresPlainProject(t *testing.T) {
	ctx := context.Background()
	projectPath := t.TempDir()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })

	project, err := store.UpsertProject(ctx, methods.ACPNavUpsertProjectParams{
		Path: projectPath,
		Name: filepath.Base(projectPath),
	})
	require.NoError(t, err)

	require.Equal(t, cleanPath(projectPath), project.Path)
	require.False(t, project.IsWorktree)
	require.Nil(t, project.ParentPath)
}

func TestUpsertProjectClassifiesLinkedGitWorktreeFromGitDirWhenMetadataMissing(t *testing.T) {
	ctx := context.Background()
	repoPath, worktreePath := createMetadataOnlyGitWorktree(t)
	require.NoError(t, os.RemoveAll(filepath.Join(repoPath, ".git", "worktrees")))

	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })

	project, err := store.UpsertProject(ctx, methods.ACPNavUpsertProjectParams{
		Path: worktreePath,
		Name: filepath.Base(worktreePath),
	})
	require.NoError(t, err)

	state, err := store.List(ctx)
	require.NoError(t, err)
	require.Len(t, state.Projects, 2)
	require.Equal(t, cleanPath(worktreePath), project.Path)
	require.True(t, project.IsWorktree)
	require.NotNil(t, project.ParentPath)
	require.Equal(t, cleanPath(repoPath), *project.ParentPath)
	require.Equal(t, cleanPath(repoPath), state.Projects[0].Path)
	require.False(t, state.Projects[0].IsWorktree)
	require.Equal(t, cleanPath(worktreePath), state.Projects[1].Path)
	require.True(t, state.Projects[1].IsWorktree)
}

func TestRestoreConversationKeepsLinkedGitWorktreeUnderParentProject(t *testing.T) {
	ctx := context.Background()
	repoPath, worktreePath := createMetadataOnlyGitWorktree(t)
	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })

	require.NoError(t, store.RestoreConversation(ctx, methods.ACPNavConversation{
		ID:            "conv-1",
		WorkspacePath: worktreePath,
		AgentServer:   "poolside",
		SessionID:     "s-1",
		Cwd:           worktreePath,
		Title:         "Restored worktree",
	}))

	state, err := store.List(ctx)
	require.NoError(t, err)
	require.Len(t, state.Projects, 2)
	require.Equal(t, cleanPath(repoPath), state.Projects[0].Path)
	require.False(t, state.Projects[0].IsWorktree)
	require.Equal(t, cleanPath(worktreePath), state.Projects[1].Path)
	require.True(t, state.Projects[1].IsWorktree)
	require.NotNil(t, state.Projects[1].ParentPath)
	require.Equal(t, cleanPath(repoPath), *state.Projects[1].ParentPath)
	require.Len(t, state.Conversations, 1)
	require.Equal(t, cleanPath(worktreePath), state.Conversations[0].WorkspacePath)
	require.Equal(t, cleanPath(worktreePath), state.Conversations[0].Cwd)
}

func TestRestoreConversationConvertsExistingLinkedGitWorktreeProject(t *testing.T) {
	ctx := context.Background()
	repoPath, worktreePath := createMetadataOnlyGitWorktree(t)
	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })

	_, err = store.UpsertProject(ctx, methods.ACPNavUpsertProjectParams{
		Path:       worktreePath,
		Name:       filepath.Base(worktreePath),
		IsWorktree: true,
	})
	require.NoError(t, err)
	_, err = store.db.ExecContext(ctx, `UPDATE projects SET is_worktree = 0, parent_path = NULL WHERE path = ?`, cleanPath(worktreePath))
	require.NoError(t, err)

	require.NoError(t, store.RestoreConversation(ctx, methods.ACPNavConversation{
		ID:            "conv-1",
		WorkspacePath: worktreePath,
		AgentServer:   "poolside",
		SessionID:     "s-1",
		Cwd:           worktreePath,
		Title:         "Restored worktree",
	}))

	state, err := store.List(ctx)
	require.NoError(t, err)
	require.Len(t, state.Projects, 2)
	require.Equal(t, cleanPath(repoPath), state.Projects[0].Path)
	require.False(t, state.Projects[0].IsWorktree)
	require.Equal(t, cleanPath(worktreePath), state.Projects[1].Path)
	require.True(t, state.Projects[1].IsWorktree)
	require.NotNil(t, state.Projects[1].ParentPath)
	require.Equal(t, cleanPath(repoPath), *state.Projects[1].ParentPath)
}

func TestRestoreConversationUsesExistingConversationIDForSession(t *testing.T) {
	ctx := context.Background()
	projectPath := t.TempDir()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })

	require.NoError(t, store.UpsertConversation(ctx, methods.ACPNavConversation{
		ID:            "local-conv-1",
		WorkspacePath: projectPath,
		AgentServer:   "poolside",
		SessionID:     "s-1",
		Cwd:           projectPath,
		Title:         "Archived",
	}))
	require.NoError(t, store.ArchiveConversation(ctx, projectPath, "local-conv-1", "poolside", "s-1"))

	require.NoError(t, store.RestoreConversation(ctx, methods.ACPNavConversation{
		ID:            "s-1",
		WorkspacePath: projectPath,
		AgentServer:   "poolside",
		SessionID:     "s-1",
		Cwd:           projectPath,
		Title:         "Restored",
	}))

	state, err := store.List(ctx)
	require.NoError(t, err)
	require.Len(t, state.Conversations, 1)
	require.Equal(t, "local-conv-1", state.Conversations[0].ID)
	require.Equal(t, "Restored", state.Conversations[0].Title)
}

func TestRestoreChatConversationDoesNotCreateProject(t *testing.T) {
	ctx := context.Background()
	chatPath := t.TempDir()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })

	require.NoError(t, store.RestoreConversation(ctx, methods.ACPNavConversation{
		ID:            "chat-1",
		WorkspacePath: chatWorkspacePath,
		AgentServer:   "poolside",
		SessionID:     "s-1",
		Cwd:           chatPath,
		Title:         "Restored chat",
	}))

	state, err := store.List(ctx)
	require.NoError(t, err)
	require.Empty(t, state.Projects)
	require.Len(t, state.Conversations, 1)
	require.Equal(t, chatWorkspacePath, state.Conversations[0].WorkspacePath)
	require.Equal(t, cleanPath(chatPath), state.Conversations[0].Cwd)
}

func TestConversationWorkingDirectoriesRoundTrip(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })

	require.NoError(t, store.UpsertConversation(ctx, methods.ACPNavConversation{
		ID:                 "conv-1",
		WorkspacePath:      "/repo",
		AgentServer:        "poolside",
		SessionID:          "s-1",
		Cwd:                "/repo",
		WorkingDirectories: []string{"/repo", "/other"},
	}))

	state, err := store.List(ctx)
	require.NoError(t, err)
	require.Len(t, state.Conversations, 1)
	require.Equal(t, []string{"/repo", "/other"}, state.Conversations[0].WorkingDirectories)

	require.NoError(t, store.ArchiveConversation(ctx, "/repo", "conv-1", "poolside", "s-1"))
	state, err = store.List(ctx)
	require.NoError(t, err)
	require.Len(t, state.Conversations, 1)
	require.True(t, state.Conversations[0].Archived)
	require.Equal(t, []string{"/repo", "/other"}, state.Conversations[0].WorkingDirectories)
}

func TestConversationWorkingDirectoriesDefaultToCwd(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })

	require.NoError(t, store.UpsertConversation(ctx, methods.ACPNavConversation{
		ID:            "conv-1",
		WorkspacePath: "/repo",
		AgentServer:   "poolside",
		Cwd:           "/repo/subdir",
	}))

	state, err := store.List(ctx)
	require.NoError(t, err)
	require.Len(t, state.Conversations, 1)
	require.Equal(t, []string{"/repo/subdir"}, state.Conversations[0].WorkingDirectories)
}

func TestRestoreIDEConversationDoesNotRequireRealWorkspacePath(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })

	require.NoError(t, store.RestoreConversation(ctx, methods.ACPNavConversation{
		ID:                 "conv-1",
		WorkspacePath:      "IDE",
		AgentServer:        "poolside",
		SessionID:          "s-1",
		Cwd:                "/repo",
		WorkingDirectories: []string{"/repo", "/other"},
	}))

	state, err := store.List(ctx)
	require.NoError(t, err)
	require.Empty(t, state.Projects)
	require.Len(t, state.Conversations, 1)
	require.Equal(t, "IDE", state.Conversations[0].WorkspacePath)
	require.Equal(t, []string{"/repo", "/other"}, state.Conversations[0].WorkingDirectories)
}

func createMetadataOnlyGitWorktree(t *testing.T) (string, string) {
	t.Helper()

	base := t.TempDir()
	repoPath := filepath.Join(base, "repo")
	worktreePath := filepath.Join(base, "repo-worktree")
	gitDir := filepath.Join(repoPath, ".git")
	worktreeGitDir := filepath.Join(gitDir, "worktrees", "repo-worktree")
	require.NoError(t, os.MkdirAll(worktreeGitDir, 0o755))
	require.NoError(t, os.MkdirAll(worktreePath, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(worktreePath, ".git"), []byte("gitdir: "+worktreeGitDir+"\n"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(worktreeGitDir, "commondir"), []byte("../..\n"), 0o644))
	return repoPath, worktreePath
}

func TestRestoreConversationRejectsMissingWorkspace(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })

	err = store.RestoreConversation(ctx, methods.ACPNavConversation{
		ID:            "conv-1",
		WorkspacePath: filepath.Join(t.TempDir(), "missing"),
		AgentServer:   "poolside",
		Cwd:           "/missing",
	})
	require.ErrorContains(t, err, "workspace path does not exist")

	state, err := store.List(ctx)
	require.NoError(t, err)
	require.Empty(t, state.Projects)
	require.Empty(t, state.Conversations)
}

func TestStoreSessionlessConversationAssociatesSessionLater(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })

	require.NoError(t, store.UpsertConversation(ctx, methods.ACPNavConversation{
		ID:            "conv-1",
		WorkspacePath: "/repo",
		AgentServer:   "poolside",
		Cwd:           "/repo",
		Title:         "New conversation",
	}))

	state, err := store.List(ctx)
	require.NoError(t, err)
	require.Len(t, state.Conversations, 1)
	require.Equal(t, "conv-1", state.Conversations[0].ID)
	require.Empty(t, state.Conversations[0].SessionID)

	require.NoError(t, store.UpsertConversation(ctx, methods.ACPNavConversation{
		ID:            "conv-1",
		WorkspacePath: "/repo",
		AgentServer:   "claude",
		SessionID:     "s-1",
		Cwd:           "/repo",
		Title:         "First prompt",
	}))

	state, err = store.List(ctx)
	require.NoError(t, err)
	require.Len(t, state.Conversations, 1)
	require.Equal(t, "conv-1", state.Conversations[0].ID)
	require.Equal(t, "claude", state.Conversations[0].AgentServer)
	require.Equal(t, "s-1", state.Conversations[0].SessionID)
	require.Equal(t, "First prompt", state.Conversations[0].Title)
}

func TestStoreSessionlessConversationNoopUpsertKeepsSortPosition(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })

	require.NoError(t, store.UpsertConversation(ctx, methods.ACPNavConversation{
		ID:            "old-draft",
		WorkspacePath: "/repo",
		AgentServer:   "poolside",
		Cwd:           "/repo",
		Title:         "Old draft",
	}))
	require.NoError(t, store.UpsertConversation(ctx, methods.ACPNavConversation{
		ID:            "new-draft",
		WorkspacePath: "/repo",
		AgentServer:   "poolside",
		Cwd:           "/repo",
		Title:         "New draft",
	}))
	_, err = store.db.ExecContext(ctx, `UPDATE conversations SET touched_at = ? WHERE id = ?`, "2026-05-11T09:00:00Z", "old-draft")
	require.NoError(t, err)
	_, err = store.db.ExecContext(ctx, `UPDATE conversations SET touched_at = ? WHERE id = ?`, "2026-05-11T10:00:00Z", "new-draft")
	require.NoError(t, err)

	require.NoError(t, store.UpsertConversation(ctx, methods.ACPNavConversation{
		ID:            "old-draft",
		WorkspacePath: "/repo",
		AgentServer:   "poolside",
		Cwd:           "/repo",
		Title:         "Old draft",
	}))

	state, err := store.List(ctx)
	require.NoError(t, err)
	require.Len(t, state.Conversations, 2)
	require.Equal(t, "new-draft", state.Conversations[0].ID)
	require.Equal(t, "old-draft", state.Conversations[1].ID)
}

func TestStoreAgentServers(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })

	defaultAgentServer := "claude"
	require.NoError(t, store.SetAgentServers(ctx, methods.ACPAgentServers{
		"claude": {
			Command: "npx",
			Args:    []string{"-y", "@zed-industries/claude-code-acp"},
			Env: map[string]string{
				"ANTHROPIC_API_KEY": "test",
			},
			Binary: map[string]methods.ACPAgentServerBinaryDistribution{
				"darwin-aarch64": {
					Archive: "https://example.com/claude.tar.gz",
					Cmd:     "./claude",
				},
			},
			DefaultConfigOptions: map[string]string{
				"permission_mode": "default",
			},
		},
		"default": {
			Command: "pool",
			Args:    []string{"acp"},
		},
	}, &defaultAgentServer, nil))

	agentServers, err := store.ListAgentServers(ctx)
	require.NoError(t, err)
	require.Equal(t, methods.ACPAgentServerConfig{
		Command: "pool",
		Args:    []string{"acp"},
	}, agentServers["poolside"])
	require.Equal(t, methods.ACPAgentServerConfig{
		Command: "npx",
		Args:    []string{"-y", "@zed-industries/claude-code-acp"},
		Env: map[string]string{
			"ANTHROPIC_API_KEY": "test",
		},
		Binary: map[string]methods.ACPAgentServerBinaryDistribution{
			"darwin-aarch64": {
				Archive: "https://example.com/claude.tar.gz",
				Cmd:     "./claude",
			},
		},
		DefaultConfigOptions: map[string]string{
			"permission_mode": "default",
		},
	}, agentServers["claude"])

	gotDefault, err := store.GetDefaultAgentServer(ctx)
	require.NoError(t, err)
	require.Equal(t, "claude", gotDefault)
}

func TestStoreAgentServersAllowsBuiltinCamberWithoutCommand(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })

	require.NoError(t, store.SetAgentServers(ctx, methods.ACPAgentServers{
		"poolside": {
			DefaultConfigOptions: map[string]string{
				"model": "anthropic/claude-fable-5",
			},
		},
	}, nil, nil))

	agentServers, err := store.ListAgentServers(ctx)
	require.NoError(t, err)
	require.Equal(t, methods.ACPAgentServerConfig{
		DefaultConfigOptions: map[string]string{
			"model": "anthropic/claude-fable-5",
		},
	}, agentServers["poolside"])

	err = store.SetAgentServers(ctx, methods.ACPAgentServers{
		"claude": {},
	}, nil, nil)
	require.ErrorContains(t, err, `agent server "claude" command is required`)
}

func TestStoreConfigCache(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })

	entry, err := store.GetConfigCache(ctx, "default")
	require.NoError(t, err)
	require.Nil(t, entry)

	entry, err = store.UpsertConfigCache(ctx, methods.ACPNavUpsertConfigCacheParams{
		AgentServer:        "default",
		ConfigOptions:      []byte(`[{"id":"model","type":"select","currentValue":"gpt-5"}]`),
		Modes:              []byte(`{"currentModeId":"plan","availableModes":[]}`),
		AvailableCommands:  []byte(`[{"name":"help"}]`),
		PromptCapabilities: []byte(`{"image":true,"embeddedContext":false}`),
		AgentInfo:          []byte(`{"name":"pool","title":"Camber","version":"0.3.19"}`),
	})
	require.NoError(t, err)
	require.Equal(t, "poolside", entry.AgentServer)
	require.JSONEq(t, `[{"id":"model","type":"select","currentValue":"gpt-5"}]`, string(entry.ConfigOptions))
	require.JSONEq(t, `{"image":true,"embeddedContext":false}`, string(entry.PromptCapabilities))
	require.JSONEq(t, `{"name":"pool","title":"Camber","version":"0.3.19"}`, string(entry.AgentInfo))
	require.NotEmpty(t, entry.CachedAt)

	entry, err = store.GetConfigCache(ctx, "poolside")
	require.NoError(t, err)
	require.NotNil(t, entry)
	require.JSONEq(t, `{"currentModeId":"plan","availableModes":[]}`, string(entry.Modes))
	require.JSONEq(t, `[{"name":"help"}]`, string(entry.AvailableCommands))
	require.JSONEq(t, `{"image":true,"embeddedContext":false}`, string(entry.PromptCapabilities))
	require.JSONEq(t, `{"name":"pool","title":"Camber","version":"0.3.19"}`, string(entry.AgentInfo))

	// Capabilities and agent info default to JSON null when omitted (not
	// persisted as empty).
	entry, err = store.UpsertConfigCache(ctx, methods.ACPNavUpsertConfigCacheParams{
		AgentServer:   "no-caps",
		ConfigOptions: []byte(`[]`),
	})
	require.NoError(t, err)
	require.JSONEq(t, `null`, string(entry.PromptCapabilities))
	require.JSONEq(t, `null`, string(entry.AgentInfo))
}

func TestSetAgentServersPreservesConfigCache(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })

	_, err = store.UpsertConfigCache(ctx, methods.ACPNavUpsertConfigCacheParams{
		AgentServer:   "claude",
		ConfigOptions: []byte(`[]`),
	})
	require.NoError(t, err)

	require.NoError(t, store.SetAgentServers(ctx, methods.ACPAgentServers{
		"claude": {Command: "npx", Args: []string{"claude-acp"}},
	}, nil, nil))

	entry, err := store.GetConfigCache(ctx, "claude")
	require.NoError(t, err)
	require.NotNil(t, entry)
}

func TestSeedAgentServersOnlyOnce(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })

	require.NoError(t, store.SeedAgentServersIfNeeded(ctx, methods.ACPAgentServers{
		"claude": {Command: "npx", Args: []string{"claude-acp"}},
	}))
	require.NoError(t, store.SeedAgentServersIfNeeded(ctx, methods.ACPAgentServers{
		"gemini": {Command: "npx", Args: []string{"gemini-acp"}},
	}))

	agentServers, err := store.ListAgentServers(ctx)
	require.NoError(t, err)
	require.Contains(t, agentServers, "claude")
	require.NotContains(t, agentServers, "gemini")
}

func TestAlliterativeWorktreeWords(t *testing.T) {
	wordPattern := regexp.MustCompile(`^[a-z][a-z0-9]*$`)
	require.Len(t, alliterativeWorktreeWords, 26)

	for i, set := range alliterativeWorktreeWords {
		require.Equal(t, string(rune('a'+i)), set.letter)
		require.Len(t, set.letter, 1)
		require.GreaterOrEqual(t, len(set.adjectives), 15, "adjectives for %q", set.letter)
		require.GreaterOrEqual(t, len(set.nouns), 15, "nouns for %q", set.letter)

		for _, adjective := range set.adjectives {
			require.True(t, strings.HasPrefix(adjective, set.letter), "adjective %q should start with %q", adjective, set.letter)
			require.True(t, wordPattern.MatchString(adjective), "adjective %q should be slug-safe", adjective)
		}
		for _, noun := range set.nouns {
			require.True(t, strings.HasPrefix(noun, set.letter), "noun %q should start with %q", noun, set.letter)
			require.True(t, wordPattern.MatchString(noun), "noun %q should be slug-safe", noun)
		}
	}
}

func TestRandomAlliterativeWorktreeName(t *testing.T) {
	name, err := randomAlliterativeWorktreeName()
	require.NoError(t, err)

	parts := strings.Split(name, "-")
	require.Len(t, parts, 2)
	require.Equal(t, parts[0][0], parts[1][0])
}

func TestUniqueWorktreeNameAddsNumericalSuffix(t *testing.T) {
	existing := map[string]bool{
		"bubbly-buoy":   true,
		"bubbly-buoy-2": true,
	}

	name := uniqueWorktreeName("bubbly-buoy", func(candidate string) bool {
		return existing[candidate]
	})

	require.Equal(t, "bubbly-buoy-3", name)
}

func TestWorktreeBranchUsesGeneratedName(t *testing.T) {
	require.Equal(t, "camber/bubbly-buoy-3", worktreeBranch("bubbly-buoy-3"))
}

func TestProjectStorageNameIncludesProjectBaseAndStableHash(t *testing.T) {
	require.Equal(t, "repo-816fc349d3fa", projectStorageName("/repo"))
}

func TestRemoveWorktreeDeletesNavStateWhenGitRemoveFails(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })

	parentPath := cleanPath(t.TempDir())
	_, err = store.UpsertProject(ctx, methods.ACPNavUpsertProjectParams{
		Path: parentPath,
		Name: "parent",
	})
	require.NoError(t, err)
	_, err = store.UpsertProject(ctx, methods.ACPNavUpsertProjectParams{
		Path:       "/missing-worktree",
		Name:       "missing worktree",
		IsWorktree: true,
		ParentPath: &parentPath,
	})
	require.NoError(t, err)
	require.NoError(t, store.UpsertConversation(ctx, methods.ACPNavConversation{
		ID:            "conv-1",
		WorkspacePath: "/missing-worktree",
		AgentServer:   "poolside",
		Cwd:           "/missing-worktree",
		Title:         "Pending cleanup",
	}))

	require.NoError(t, store.RemoveWorktree(ctx, "/missing-worktree"))

	state, err := store.List(ctx)
	require.NoError(t, err)
	require.Len(t, state.Projects, 1)
	require.Equal(t, parentPath, state.Projects[0].Path)
	require.Empty(t, state.Conversations)
}

func TestRemoveWorktreeArchivesSessionConversationsUnderParent(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })

	parentPath := cleanPath(t.TempDir())
	_, err = store.UpsertProject(ctx, methods.ACPNavUpsertProjectParams{
		Path: parentPath,
		Name: "parent",
	})
	require.NoError(t, err)
	_, err = store.UpsertProject(ctx, methods.ACPNavUpsertProjectParams{
		Path:       "/worktree-with-session",
		Name:       "worktree",
		IsWorktree: true,
		ParentPath: &parentPath,
	})
	require.NoError(t, err)
	require.NoError(t, store.UpsertConversation(ctx, methods.ACPNavConversation{
		ID:            "conv-session",
		WorkspacePath: "/worktree-with-session",
		AgentServer:   "poolside",
		SessionID:     "session-1",
		Cwd:           "/worktree-with-session",
		Title:         "Worktree work",
		Active:        true,
	}))
	require.NoError(t, store.UpsertConversation(ctx, methods.ACPNavConversation{
		ID:            "conv-draft",
		WorkspacePath: "/worktree-with-session",
		AgentServer:   "poolside",
		Cwd:           "/worktree-with-session",
		Title:         "Draft",
		Active:        true,
	}))

	require.NoError(t, store.RemoveWorktree(ctx, "/worktree-with-session"))

	state, err := store.List(ctx)
	require.NoError(t, err)
	require.Len(t, state.Conversations, 1)
	conversation := state.Conversations[0]
	assert.Equal(t, "conv-session", conversation.ID)
	assert.Equal(t, parentPath, conversation.WorkspacePath)
	// cwd keeps pointing at the removed worktree so readers know where the
	// session actually ran.
	assert.Equal(t, "/worktree-with-session", conversation.Cwd)
	assert.True(t, conversation.Archived)
	assert.False(t, conversation.Active)
}

func TestRemoveWorktreeUsesPerRepoLock(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })

	parentA := cleanPath(filepath.Join(t.TempDir(), "repo-a"))
	parentB := cleanPath(filepath.Join(t.TempDir(), "repo-b"))
	_, err = store.UpsertProject(ctx, methods.ACPNavUpsertProjectParams{Path: parentA, Name: "repo-a"})
	require.NoError(t, err)
	_, err = store.UpsertProject(ctx, methods.ACPNavUpsertProjectParams{Path: parentB, Name: "repo-b"})
	require.NoError(t, err)
	_, err = store.UpsertProject(ctx, methods.ACPNavUpsertProjectParams{
		Path:       "/repo-b-worktree",
		Name:       "repo-b worktree",
		IsWorktree: true,
		ParentPath: &parentB,
	})
	require.NoError(t, err)

	store.repoLock(parentA).Lock()
	t.Cleanup(func() { store.repoLock(parentA).Unlock() })

	gitCalled := make(chan string, 1)
	store.runGit = func(_ context.Context, args ...string) ([]byte, error) {
		gitCalled <- args[1]
		return []byte("failed"), errors.New("git failed")
	}

	require.NoError(t, store.RemoveWorktree(ctx, "/repo-b-worktree"))
	require.Equal(t, parentB, <-gitCalled)
}

func TestStoreGithubColorMode(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })

	// Defaults to empty when nothing has been chosen yet.
	mode, err := store.GetGithubColorMode(ctx)
	require.NoError(t, err)
	assert.Equal(t, "", mode)

	// Persists and reads back a choice.
	require.NoError(t, store.SetGithubColorMode(ctx, "review"))
	mode, err = store.GetGithubColorMode(ctx)
	require.NoError(t, err)
	assert.Equal(t, "review", mode)

	// Updates an existing choice and trims whitespace.
	require.NoError(t, store.SetGithubColorMode(ctx, "  checks  "))
	mode, err = store.GetGithubColorMode(ctx)
	require.NoError(t, err)
	assert.Equal(t, "checks", mode)

	// Clearing falls back to empty (client default).
	require.NoError(t, store.SetGithubColorMode(ctx, "   "))
	mode, err = store.GetGithubColorMode(ctx)
	require.NoError(t, err)
	assert.Equal(t, "", mode)
}

// Each iteration upgrades a separate copy of the May schema and its history.
// Required migrations must finish before any navigation request is served.
func BenchmarkOpenUpgrade(b *testing.B) {
	ctx := context.Background()
	dir := b.TempDir()
	templatePath := filepath.Join(dir, "template.db")
	db, err := sql.Open("sqlite3", templatePath)
	require.NoError(b, err)
	entries, err := migrationsFS.ReadDir("migrations")
	require.NoError(b, err)
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".up.sql") || entry.Name()[:14] > "20260518120000" {
			continue
		}
		migration, err := migrationsFS.ReadFile("migrations/" + entry.Name())
		require.NoError(b, err)
		_, err = db.Exec(string(migration))
		require.NoError(b, err)
	}
	_, err = db.Exec(`CREATE TABLE acp_nav_migrations(version bigint NOT NULL, dirty boolean NOT NULL); INSERT INTO acp_nav_migrations VALUES(20260518120000,0)`)
	require.NoError(b, err)
	tx, err := db.Begin()
	require.NoError(b, err)
	for i := 0; i < 10_000; i++ {
		_, err = tx.Exec(`INSERT INTO conversations(id,workspace_path,agent_server,session_id,cwd,title,created_at,touched_at) VALUES(?,'/fixture','fixture',?,'/fixture','history','2026-05-18','2026-05-18')`, fmt.Sprint(i), fmt.Sprint(i))
		require.NoError(b, err)
	}
	require.NoError(b, tx.Commit())
	require.NoError(b, db.Close())
	template, err := os.ReadFile(templatePath)
	require.NoError(b, err)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		b.StopTimer()
		path := filepath.Join(dir, fmt.Sprintf("upgrade-%d.db", i))
		require.NoError(b, os.WriteFile(path, template, 0o600))
		b.StartTimer()
		store, err := Open(ctx, path)
		b.StopTimer()
		require.NoError(b, err)
		var count int
		require.NoError(b, store.db.QueryRow(`SELECT count(*) FROM conversations`).Scan(&count))
		require.Equal(b, 10_000, count)
		require.NoError(b, store.Close())
		b.StartTimer()
	}
}
