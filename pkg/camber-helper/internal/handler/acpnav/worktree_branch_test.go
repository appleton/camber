package acpnav

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

func TestRenameWorktreeRenamesCreatedBranch(t *testing.T) {
	isolationEnv(t)
	ctx := context.Background()
	repo, _ := gitRepo(t, nil)
	store := isolationStore(t, repo)

	wt, err := store.CreateWorktree(ctx, repo, "bubbly-buoy")
	require.NoError(t, err)
	require.Equal(t, "camber/bubbly-buoy", currentBranch(t, wt.Path))

	require.NoError(t, store.RenameProject(ctx, wt.Path, "Fix Login: Bug!"))

	assert.Equal(t, "camber/fix-login-bug", currentBranch(t, wt.Path))
	assert.False(t, localBranchExists(ctx, repo, "camber/bubbly-buoy"))
	assert.Equal(t, "Fix Login: Bug!", projectByPath(t, store, wt.Path).Nickname)

	// Renaming again follows the new name, and an unchanged slug is a no-op.
	require.NoError(t, store.RenameProject(ctx, wt.Path, "fix login bug"))
	assert.Equal(t, "camber/fix-login-bug", currentBranch(t, wt.Path))
	assert.Equal(t, "fix login bug", projectByPath(t, store, wt.Path).Nickname)
}

func TestRenameWorktreeLeavesForeignBranchAlone(t *testing.T) {
	isolationEnv(t)
	ctx := context.Background()
	repo, git := gitRepo(t, nil)
	store := isolationStore(t, repo)

	wt, err := store.CreateWorktree(ctx, repo, "bubbly-buoy")
	require.NoError(t, err)
	git(wt.Path, "checkout", "-q", "-b", "feature/pr-123")

	require.NoError(t, store.RenameProject(ctx, wt.Path, "Review PR"))

	assert.Equal(t, "feature/pr-123", currentBranch(t, wt.Path))
	assert.False(t, localBranchExists(ctx, repo, "camber/review-pr"))
	assert.Equal(t, "Review PR", projectByPath(t, store, wt.Path).Nickname)
}

func TestRenameWorktreeLeavesDetachedHeadAlone(t *testing.T) {
	isolationEnv(t)
	ctx := context.Background()
	repo, git := gitRepo(t, nil)
	store := isolationStore(t, repo)

	wt, err := store.CreateWorktree(ctx, repo, "bubbly-buoy")
	require.NoError(t, err)
	git(wt.Path, "checkout", "-q", "--detach")

	require.NoError(t, store.RenameProject(ctx, wt.Path, "Detached"))

	assert.True(t, localBranchExists(ctx, repo, "camber/bubbly-buoy"))
	assert.False(t, localBranchExists(ctx, repo, "camber/detached"))
	assert.Equal(t, "Detached", projectByPath(t, store, wt.Path).Nickname)
}

func TestRenameWorktreeUniquifiesCollidingBranch(t *testing.T) {
	isolationEnv(t)
	ctx := context.Background()
	repo, git := gitRepo(t, nil)
	store := isolationStore(t, repo)
	git(repo, "branch", "camber/fix-login")

	wt, err := store.CreateWorktree(ctx, repo, "bubbly-buoy")
	require.NoError(t, err)

	require.NoError(t, store.RenameProject(ctx, wt.Path, "Fix login"))

	assert.Equal(t, "camber/fix-login-2", currentBranch(t, wt.Path))
	assert.True(t, localBranchExists(ctx, repo, "camber/fix-login"), "existing branch must be kept")

	// Renaming to the same name keeps the uniquified branch rather than
	// cycling to another suffix.
	require.NoError(t, store.RenameProject(ctx, wt.Path, "Fix login"))
	assert.Equal(t, "camber/fix-login-2", currentBranch(t, wt.Path))
}

func TestRenameWorktreeLeavesPushedBranchAlone(t *testing.T) {
	isolationEnv(t)
	ctx := context.Background()
	repo, git := gitRepo(t, nil)
	remote := t.TempDir()
	git(remote, "init", "-q", "--bare")
	git(repo, "remote", "add", "origin", remote)
	store := isolationStore(t, repo)

	wt, err := store.CreateWorktree(ctx, repo, "bubbly-buoy")
	require.NoError(t, err)
	git(wt.Path, "push", "-q", "-u", "origin", "camber/bubbly-buoy")

	require.NoError(t, store.RenameProject(ctx, wt.Path, "Pushed work"))

	assert.Equal(t, "camber/bubbly-buoy", currentBranch(t, wt.Path))
	assert.Equal(t, "Pushed work", projectByPath(t, store, wt.Path).Nickname)
	assert.False(t, localBranchExists(ctx, repo, "camber/pushed-work"))
}

func TestRenameWorktreeLeavesBranchWithRemoteTrackingRefAlone(t *testing.T) {
	isolationEnv(t)
	ctx := context.Background()
	repo, git := gitRepo(t, nil)
	remote := t.TempDir()
	git(remote, "init", "-q", "--bare")
	git(repo, "remote", "add", "origin", remote)
	store := isolationStore(t, repo)

	wt, err := store.CreateWorktree(ctx, repo, "bubbly-buoy")
	require.NoError(t, err)
	// Pushed without -u: no upstream config, but origin/<branch> exists.
	git(wt.Path, "push", "-q", "origin", "camber/bubbly-buoy")
	require.Error(t, exec.Command("git", "-C", wt.Path, "config", "--get", "branch.camber/bubbly-buoy.remote").Run())
	require.NotEmpty(t, gitOutput(t, wt.Path, "for-each-ref", "refs/remotes/origin/camber/bubbly-buoy"))

	require.NoError(t, store.RenameProject(ctx, wt.Path, "Pushed work"))

	assert.Equal(t, "camber/bubbly-buoy", currentBranch(t, wt.Path))
	assert.Equal(t, "Pushed work", projectByPath(t, store, wt.Path).Nickname)
}

func TestPickWorktreeBranchName(t *testing.T) {
	ctx := context.Background()
	takenSet := func(names ...string) func(string) (bool, error) {
		return func(c string) (bool, error) {
			for _, n := range names {
				if n == c {
					return true, nil
				}
			}
			return false, nil
		}
	}

	got, err := pickWorktreeBranchName(ctx, "camber/a", "camber/old", takenSet("camber/a", "camber/a-2"))
	require.NoError(t, err)
	assert.Equal(t, "camber/a-3", got)

	got, err = pickWorktreeBranchName(ctx, "camber/a", "camber/a", takenSet("camber/a"))
	require.NoError(t, err)
	assert.Equal(t, "camber/a", got, "the current branch is never taken")
}

func TestPickWorktreeBranchNameStopsOnCheckError(t *testing.T) {
	boom := errors.New("git exploded")
	calls := 0
	_, err := pickWorktreeBranchName(context.Background(), "camber/a", "camber/old", func(string) (bool, error) {
		calls++
		return false, boom
	})
	require.ErrorIs(t, err, boom)
	assert.Contains(t, err.Error(), "checking worktree branch name")
	assert.Equal(t, 1, calls)
}

func TestPickWorktreeBranchNameStopsOnCancelledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	calls := 0
	_, err := pickWorktreeBranchName(ctx, "camber/a", "camber/old", func(string) (bool, error) {
		calls++
		cancel()
		return true, nil
	})
	require.ErrorIs(t, err, context.Canceled)
	assert.Equal(t, 1, calls)
}

func TestPickWorktreeBranchNameIsBounded(t *testing.T) {
	calls := 0
	_, err := pickWorktreeBranchName(context.Background(), "camber/a", "camber/old", func(string) (bool, error) {
		calls++
		return true, nil
	})
	require.Error(t, err)
	assert.Equal(t, maxWorktreeBranchSuffix, calls)
}

func TestRenameWorktreeRenamesBranchWithLocalAutoSetupMergeUpstream(t *testing.T) {
	isolationEnv(t)
	ctx := context.Background()
	repo, git := gitRepo(t, nil)
	git(repo, "config", "branch.autoSetupMerge", "always")
	store := isolationStore(t, repo)

	wt, err := store.CreateWorktree(ctx, repo, "bubbly-buoy")
	require.NoError(t, err)
	require.Equal(t, ".", strings.TrimSpace(gitOutput(t, wt.Path, "config", "--get", "branch.camber/bubbly-buoy.remote")))

	require.NoError(t, store.RenameProject(ctx, wt.Path, "Local upstream"))

	assert.Equal(t, "camber/local-upstream", currentBranch(t, wt.Path))
}

func TestRenameWorktreeAvoidsBranchNameOfRemoteTrackingRef(t *testing.T) {
	isolationEnv(t)
	ctx := context.Background()
	repo, git := gitRepo(t, nil)
	remote := t.TempDir()
	git(remote, "init", "-q", "--bare")
	git(repo, "remote", "add", "origin", remote)
	// An old PR branch lives on origin; no local branch of that name remains.
	git(repo, "branch", "old-pr")
	git(repo, "push", "-q", "origin", "old-pr:camber/fix-login")
	git(repo, "fetch", "-q", "origin")
	require.NotEmpty(t, gitOutput(t, repo, "for-each-ref", "refs/remotes/origin/camber/fix-login"))
	store := isolationStore(t, repo)

	wt, err := store.CreateWorktree(ctx, repo, "bubbly-buoy")
	require.NoError(t, err)

	require.NoError(t, store.RenameProject(ctx, wt.Path, "Fix login"))

	assert.Equal(t, "camber/fix-login-2", currentBranch(t, wt.Path))
}

func TestRenameWorktreeAvoidsDirectoryRefConflict(t *testing.T) {
	isolationEnv(t)
	ctx := context.Background()
	repo, git := gitRepo(t, nil)
	store := isolationStore(t, repo)
	git(repo, "branch", "camber/fix-login/extra")

	wt, err := store.CreateWorktree(ctx, repo, "bubbly-buoy")
	require.NoError(t, err)

	require.NoError(t, store.RenameProject(ctx, wt.Path, "Fix login"))

	assert.Equal(t, "camber/fix-login-2", currentBranch(t, wt.Path))
	assert.True(t, localBranchExists(ctx, repo, "camber/fix-login/extra"))
}

func TestRenameWorktreeBranchSkipsRepoHooks(t *testing.T) {
	for _, mode := range []string{"hooks-dir", "core.hooksPath"} {
		t.Run(mode, func(t *testing.T) {
			isolationEnv(t)
			ctx := context.Background()
			repo, git := gitRepo(t, nil)
			store := isolationStore(t, repo)
			wt, err := store.CreateWorktree(ctx, repo, "bubbly-buoy")
			require.NoError(t, err)

			marker := filepath.Join(t.TempDir(), "hook-ran")
			hook := "#!/bin/sh\ntouch '" + marker + "'\n"
			hooksDir := filepath.Join(repo, ".git", "hooks")
			if mode == "core.hooksPath" {
				hooksDir = t.TempDir()
				git(repo, "config", "core.hooksPath", hooksDir)
			}
			require.NoError(t, os.WriteFile(filepath.Join(hooksDir, "reference-transaction"), []byte(hook), 0o755))

			// Sanity check: the hook fires for an ordinary, non-isolated
			// git command.
			git(repo, "branch", "hook-probe")
			require.FileExists(t, marker)
			require.NoError(t, os.Remove(marker))

			require.NoError(t, store.RenameProject(ctx, wt.Path, "Hook test"))

			assert.Equal(t, "camber/hook-test", currentBranch(t, wt.Path))
			assert.NoFileExists(t, marker)
		})
	}
}

func TestRenameWorktreeBranchSkippedWhenRepoRefusedIsolation(t *testing.T) {
	isolationEnv(t)
	ctx := context.Background()
	repo, git := gitRepo(t, nil)
	store := isolationStore(t, repo)
	wt, err := store.CreateWorktree(ctx, repo, "bubbly-buoy")
	require.NoError(t, err)
	git(repo, "config", "core.sshCommand", "true")

	require.NoError(t, store.RenameProject(ctx, wt.Path, "Refused"))

	assert.Equal(t, "camber/bubbly-buoy", currentBranch(t, wt.Path))
	assert.Equal(t, "Refused", projectByPath(t, store, wt.Path).Nickname)
}

func TestWorktreeBranchCustomPrefix(t *testing.T) {
	isolationEnv(t)
	ctx := context.Background()
	repo, _ := gitRepo(t, nil)
	store := isolationStore(t, repo)

	legacy, err := store.CreateWorktree(ctx, repo, "legacy-one")
	require.NoError(t, err)
	require.Equal(t, "camber/legacy-one", currentBranch(t, legacy.Path))

	require.NoError(t, store.SetWorktreeBranchPrefix(ctx, "  andy/  "))
	prefix, err := store.GetWorktreeBranchPrefix(ctx)
	require.NoError(t, err)
	require.Equal(t, "andy/", prefix)

	wt, err := store.CreateWorktree(ctx, repo, "bubbly-buoy")
	require.NoError(t, err)
	assert.Equal(t, "andy/bubbly-buoy", currentBranch(t, wt.Path))

	require.NoError(t, store.RenameProject(ctx, wt.Path, "New name"))
	assert.Equal(t, "andy/new-name", currentBranch(t, wt.Path))

	// A worktree created under the default prefix still counts as ours and
	// moves to the configured prefix.
	require.NoError(t, store.RenameProject(ctx, legacy.Path, "Legacy work"))
	assert.Equal(t, "andy/legacy-work", currentBranch(t, legacy.Path))

	prepared, err := store.PrepareWorktree(ctx, repo)
	require.NoError(t, err)
	created, err := store.CreateWorktree(ctx, repo, prepared.Name)
	require.NoError(t, err)
	assert.Equal(t, "andy/"+prepared.Name, currentBranch(t, created.Path))
}

func TestWorktreeBranchEmptyPrefix(t *testing.T) {
	isolationEnv(t)
	ctx := context.Background()
	repo, git := gitRepo(t, nil)
	store := isolationStore(t, repo)

	require.NoError(t, store.SetWorktreeBranchPrefix(ctx, ""))
	prefix, err := store.GetWorktreeBranchPrefix(ctx)
	require.NoError(t, err)
	require.Equal(t, "", prefix)

	wt, err := store.CreateWorktree(ctx, repo, "bubbly-buoy")
	require.NoError(t, err)
	require.Equal(t, "bubbly-buoy", currentBranch(t, wt.Path))

	require.NoError(t, store.RenameProject(ctx, wt.Path, "First name"))
	assert.Equal(t, "first-name", currentBranch(t, wt.Path))

	// The branch is now named after the display name, which still marks it as
	// ours for the next rename.
	require.NoError(t, store.RenameProject(ctx, wt.Path, "Second name"))
	assert.Equal(t, "second-name", currentBranch(t, wt.Path))

	// With no prefix to recognise, an unrelated checked-out branch is left
	// alone.
	git(wt.Path, "checkout", "-q", "-b", "someone-elses-pr")
	require.NoError(t, store.RenameProject(ctx, wt.Path, "Third name"))
	assert.Equal(t, "someone-elses-pr", currentBranch(t, wt.Path))
	assert.False(t, localBranchExists(ctx, repo, "third-name"))
}

func TestSetWorktreeBranchPrefixValidates(t *testing.T) {
	isolationEnv(t)
	ctx := context.Background()
	repo, _ := gitRepo(t, nil)
	store := isolationStore(t, repo)

	prefix, err := store.GetWorktreeBranchPrefix(ctx)
	require.NoError(t, err)
	assert.Equal(t, defaultWorktreeBranchPrefix, prefix)

	for _, invalid := range []string{"a b/", "-x/", "foo//", "bad..", "x~", "camber/:"} {
		assert.Error(t, store.SetWorktreeBranchPrefix(ctx, invalid), invalid)
	}
	prefix, err = store.GetWorktreeBranchPrefix(ctx)
	require.NoError(t, err)
	assert.Equal(t, defaultWorktreeBranchPrefix, prefix, "invalid prefixes must not be stored")

	require.NoError(t, store.SetWorktreeBranchPrefix(ctx, "team-"))
	prefix, err = store.GetWorktreeBranchPrefix(ctx)
	require.NoError(t, err)
	assert.Equal(t, "team-", prefix)
}

func TestBranchSlug(t *testing.T) {
	for name, want := range map[string]string{
		"Fix Login Bug":       "fix-login-bug",
		"  spaced   out  ":    "spaced-out",
		"feat/ui: new thing!": "feat-ui-new-thing",
		"v1.2 release":        "v1.2-release",
		"a..b":                "a.b",
		".hidden.":            "hidden",
		"thing.lock":          "thing",
		"snake_case":          "snake_case",
		"Ünïcode Näme":        "ünïcode-näme",
		"~^:?*[\\":            "",
		"@{-1}":               "1",
	} {
		assert.Equal(t, want, branchSlug(name), name)
	}
}

func TestOwnedWorktreeBranch(t *testing.T) {
	assert.True(t, ownedWorktreeBranch("andy/dir", "andy/", "dir", "Name"))
	assert.True(t, ownedWorktreeBranch("andy/name-2", "andy/", "dir", "Name"))
	assert.True(t, ownedWorktreeBranch("camber/dir", "andy/", "dir", "Name"), "default prefix is always ours")
	assert.True(t, ownedWorktreeBranch("camber/my-name-3", "andy/", "dir", "My name"))
	assert.False(t, ownedWorktreeBranch("andy/my-own-feature", "andy/", "dir", "Name"))
	assert.False(t, ownedWorktreeBranch("camber/other", "camber/", "dir", "Name"))
	assert.False(t, ownedWorktreeBranch("andy/name-x", "andy/", "dir", "Name"))
	assert.False(t, ownedWorktreeBranch("andy/name-", "andy/", "dir", "Name"))
	assert.False(t, ownedWorktreeBranch("pr-branch", "andy/", "dir", "pr-branch"), "no empty prefix when one is configured")
	assert.False(t, ownedWorktreeBranch("dir", "andy/", "dir", "Name"))
	assert.True(t, ownedWorktreeBranch("dir", "", "dir", "Name"))
	assert.True(t, ownedWorktreeBranch("my-name-3", "", "dir", "My name"))
	assert.False(t, ownedWorktreeBranch("my-name-x", "", "dir", "My name"))
	assert.False(t, ownedWorktreeBranch("pr-branch", "", "dir", "Name"))
}

func currentBranch(t *testing.T, dir string) string {
	t.Helper()
	return gitOutput(t, dir, "symbolic-ref", "--short", "HEAD")
}

func gitOutput(t *testing.T, dir string, args ...string) string {
	t.Helper()
	out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).CombinedOutput()
	require.NoError(t, err, string(out))
	return strings.TrimSpace(string(out))
}

func projectByPath(t *testing.T, store *Store, path string) methods.ACPNavProject {
	t.Helper()
	state, err := store.List(context.Background())
	require.NoError(t, err)
	for _, project := range state.Projects {
		if project.Path == path {
			return project
		}
	}
	require.Failf(t, "project not found", "path: %s", path)
	return methods.ACPNavProject{}
}
