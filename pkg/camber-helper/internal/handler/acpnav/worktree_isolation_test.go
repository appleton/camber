package acpnav

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/adrg/xdg"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

func TestCreateWorktreeIsolatedSkipsRepoHooks(t *testing.T) {
	isolationEnv(t)
	ctx := context.Background()
	repo, _ := gitRepo(t, nil)
	marker := filepath.Join(t.TempDir(), "hook-ran")
	hook := "#!/bin/sh\ntouch '" + marker + "'\n"
	require.NoError(t, os.WriteFile(filepath.Join(repo, ".git", "hooks", "post-checkout"), []byte(hook), 0o755))
	store := isolationStore(t, repo)

	_, err := store.CreateWorktreeIsolated(ctx, repo, "iso-one")
	require.NoError(t, err)
	assert.NoFileExists(t, marker)

	_, err = store.CreateWorktree(ctx, repo, "ui-one")
	require.NoError(t, err)
	assert.FileExists(t, marker)
}

func TestCreateWorktreeIsolatedBlanksRepoCleanOnlyDriver(t *testing.T) {
	isolationEnv(t)
	ctx := context.Background()
	repo, git := gitRepo(t, map[string]string{".gitattributes": "*.txt filter=evil\n", "a.txt": "hello\n"})
	marker := filepath.Join(t.TempDir(), "filter-ran")
	git(repo, "config", "filter.evil.clean", markerCommand(marker))
	store := isolationStore(t, repo)

	wt, err := store.CreateWorktreeIsolated(ctx, repo, "iso-clean")
	require.NoError(t, err)
	assert.FileExists(t, filepath.Join(wt.Path, "a.txt"))
	require.NoError(t, store.CheckWorktreeClean(ctx, wt.Path))
	assert.NoFileExists(t, marker)
}

func TestCreateWorktreeIsolatedRefusesRequiredSmudgeDriver(t *testing.T) {
	isolationEnv(t)
	ctx := context.Background()
	repo, git := gitRepo(t, map[string]string{".gitattributes": "*.txt filter=evil\n", "a.txt": "hello\n"})
	marker := filepath.Join(t.TempDir(), "filter-ran")
	git(repo, "config", "filter.evil.smudge", markerCommand(marker))
	git(repo, "config", "filter.evil.clean", markerCommand(marker))
	git(repo, "config", "filter.evil.required", "true")
	store := isolationStore(t, repo)

	_, err := store.CreateWorktreeIsolated(ctx, repo, "iso-crypt")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "filter driver evil")
	assert.Contains(t, err.Error(), "desktop app")
	assert.NoFileExists(t, marker)
	assertWorktreeDiscarded(t, store, repo, "iso-crypt")

	// The non-isolated path is unchanged: the driver runs.
	_, err = store.CreateWorktree(ctx, repo, "ui-crypt")
	require.NoError(t, err)
	assert.FileExists(t, marker)
}

func TestCreateWorktreeIsolatedSeesIncludeIfFilterDrivers(t *testing.T) {
	for _, condition := range []string{"onbranch:camber/**", "gitdir:**/worktrees/**"} {
		t.Run(condition, func(t *testing.T) {
			isolationEnv(t)
			ctx := context.Background()
			repo, git := gitRepo(t, map[string]string{".gitattributes": "*.txt filter=evil\n", "a.txt": "hello\n"})
			marker := filepath.Join(t.TempDir(), "filter-ran")
			include := filepath.Join(t.TempDir(), "filters.inc")
			git(repo, "config", "-f", include, "filter.evil.smudge", markerCommand(marker))
			git(repo, "config", "-f", include, "filter.evil.process", "sh -c 'touch "+marker+"; exit 1'")
			git(repo, "config", "includeIf."+condition+".path", include)
			store := isolationStore(t, repo)

			// Invisible from the root checkout, so only enumerating inside the
			// new worktree catches it.
			cfg, err := store.inspectRepoGitConfig(ctx, repo)
			require.NoError(t, err)
			assert.Empty(t, cfg.contentDrivers)

			_, err = store.CreateWorktreeIsolated(ctx, repo, "iso-include")
			require.Error(t, err)
			assert.Contains(t, err.Error(), "filter driver evil")
			assert.NoFileExists(t, marker)
			assertWorktreeDiscarded(t, store, repo, "iso-include")

			_, _ = store.CreateWorktree(ctx, repo, "ui-include")
			assert.FileExists(t, marker)
		})
	}
}

func TestCreateWorktreeIsolatedRunsUserGlobalFilterDriver(t *testing.T) {
	global := isolationEnv(t)
	ctx := context.Background()
	repo, git := gitRepo(t, map[string]string{".gitattributes": "*.txt filter=mine\n", "a.txt": "hello\n"})
	marker := filepath.Join(t.TempDir(), "filter-ran")
	git(repo, "config", "-f", global, "filter.mine.smudge", markerCommand(marker))
	store := isolationStore(t, repo)

	_, err := store.CreateWorktreeIsolated(ctx, repo, "iso-global")
	require.NoError(t, err)
	assert.FileExists(t, marker)
}

func TestCreateWorktreeIsolatedRefusesRepoLFSCustomTransfer(t *testing.T) {
	isolationEnv(t)
	ctx := context.Background()
	repo, git := gitRepo(t, map[string]string{"a.txt": "hello\n"})
	git(repo, "config", "lfs.customtransfer.evil.path", "/bin/false")
	store := isolationStore(t, repo)

	_, err := store.CreateWorktreeIsolated(ctx, repo, "iso-transfer")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "custom transfer agent evil")
	assertWorktreeDiscarded(t, store, repo, "iso-transfer")
}

func TestCreateWorktreeIsolatedNeutralisesLFSTransferAgents(t *testing.T) {
	if _, err := exec.LookPath("git-lfs"); err != nil {
		t.Skip("git-lfs not installed")
	}
	isolationEnv(t)
	ctx := context.Background()
	repo, git := gitRepo(t, map[string]string{".gitattributes": "*.bin filter=lfs diff=lfs merge=lfs -text\n", "a.txt": "hello\n"})
	marker := filepath.Join(t.TempDir(), "transfer-ran")
	git(repo, "config", "filter.lfs.smudge", markerCommand(marker))
	git(repo, "config", "filter.lfs.required", "true")
	git(repo, "config", "lfs.standalonetransferagent", "evil")
	store := isolationStore(t, repo)

	cfg, err := store.inspectRepoGitConfig(ctx, repo)
	require.NoError(t, err)
	assert.Contains(t, cfg.overrides, "filter.lfs.smudge=git-lfs smudge -- %f")
	assert.Empty(t, cfg.contentDrivers)
	assert.Contains(t, IsolatedGitArgs(), "lfs.standalonetransferagent=")

	wt, err := store.CreateWorktreeIsolated(ctx, repo, "iso-lfs")
	require.NoError(t, err)
	assert.FileExists(t, filepath.Join(wt.Path, "a.txt"))
	assert.NoFileExists(t, marker)
}

func TestRemoveWorktreeIsolatedSkipsRepoCleanDriver(t *testing.T) {
	isolationEnv(t)
	ctx := context.Background()
	repo, git := gitRepo(t, map[string]string{".gitattributes": "*.txt filter=evil\n", "a.txt": "hello\n"})
	marker := filepath.Join(t.TempDir(), "filter-ran")
	// Only visible inside linked worktrees, never from the root checkout.
	include := filepath.Join(t.TempDir(), "filters.inc")
	git(repo, "config", "-f", include, "filter.evil.clean", markerCommand(marker))
	git(repo, "config", "includeIf.gitdir:**/worktrees/**.path", include)
	store := isolationStore(t, repo)

	wt, err := store.CreateWorktreeIsolated(ctx, repo, "iso-remove")
	require.NoError(t, err)
	control, err := store.CreateWorktreeIsolated(ctx, repo, "control")
	require.NoError(t, err)
	// A changed mtime forces git to re-hash the file through the clean filter.
	future := time.Now().Add(time.Hour)
	for _, dir := range []string{wt.Path, control.Path} {
		require.NoError(t, os.Chtimes(filepath.Join(dir, "a.txt"), future, future))
	}

	require.NoError(t, store.CheckWorktreeClean(ctx, wt.Path))
	require.NoError(t, store.RemoveWorktreeSafely(ctx, wt.Path))
	assert.NoDirExists(t, wt.Path)
	assert.NoFileExists(t, marker)

	// Sanity: plain git in the same setup does run the clean filter.
	git(control.Path, "status", "--porcelain")
	assert.FileExists(t, marker)
}

func TestCheckWorktreeCleanReportsDisabledCleanDriver(t *testing.T) {
	isolationEnv(t)
	ctx := context.Background()
	repo, git := gitRepo(t, map[string]string{".gitattributes": "*.txt filter=evil\n", "a.txt": "hello\n"})
	git(repo, "config", "filter.evil.clean", "cat")
	store := isolationStore(t, repo)
	wt, err := store.CreateWorktreeIsolated(ctx, repo, "iso-dirty")
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(wt.Path, "a.txt"), []byte("changed\n"), 0o644))

	err = store.CheckWorktreeClean(ctx, wt.Path)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "uncommitted or untracked changes")
	assert.Contains(t, err.Error(), "filter driver evil was disabled")
	require.Error(t, store.RemoveWorktreeSafely(ctx, wt.Path))
	assert.DirExists(t, wt.Path)
}

func TestInspectRepoGitConfigScopes(t *testing.T) {
	var gotArgs []string
	store := &Store{runGit: func(ctx context.Context, args ...string) ([]byte, error) {
		gotArgs = args
		return []byte(strings.Join([]string{
			"global", "filter.lfs.smudge\ngit-lfs smudge -- %f",
			"local", "filter.lfs.smudge\nevil",
			"local", "filter.my.driver.clean\nx",
			"global", "filter.mine.smudge\ncat",
			"global", "filter.crypt.smudge\ndecrypt",
			"worktree", "filter.crypt.required\ntrue",
			"local", "filter.blank.smudge\n",
			"global", "lfs.customtransfer.user.path\n/usr/bin/agent",
			"local", "lfs.customtransfer.evil.path\n/tmp/evil",
		}, "\x00") + "\x00"), nil
	}}
	cfg, err := store.inspectRepoGitConfig(context.Background(), "/repo")
	require.NoError(t, err)
	assert.Equal(t, []string{"-C", "/repo", "config", "--null", "--show-scope", "--get-regexp", repoGitConfigPattern}, gotArgs[len(gotArgs)-7:])
	assert.Contains(t, cfg.overrides, "filter.lfs.smudge=git-lfs smudge -- %f")
	assert.Contains(t, cfg.overrides, "filter.lfs.required=true")
	assert.NotContains(t, cfg.overrides, "filter.lfs.smudge=")
	assert.Contains(t, cfg.overrides, "filter.my.driver.smudge=")
	assert.Contains(t, cfg.overrides, "filter.blank.process=")
	assert.Contains(t, cfg.overrides, "lfs.customtransfer.evil.path=")
	assert.NotContains(t, cfg.overrides, "filter.mine.smudge=", "user-global drivers are left alone")
	assert.NotContains(t, cfg.overrides, "lfs.customtransfer.user.path=")
	assert.Equal(t, []string{"crypt"}, cfg.contentDrivers, "a repo-scoped key exposes the global smudge to blanking")
	assert.Equal(t, []string{"my.driver"}, cfg.cleanDrivers)
	assert.Equal(t, []string{"evil"}, cfg.customTransfers)
}

// isolationEnv points worktree storage and git's global config at temp files
// and returns the global config path. xdg resolves StateHome at init from the
// process environment, and Bazel's test sandbox has no writable home.
func isolationEnv(t *testing.T) string {
	t.Helper()
	t.Cleanup(xdg.Reload) // registered first so it runs after Setenv restores the env
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	xdg.Reload()
	global := filepath.Join(t.TempDir(), "gitconfig")
	require.NoError(t, os.WriteFile(global, nil, 0o644))
	t.Setenv("GIT_CONFIG_GLOBAL", global)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	return global
}

// gitRepo creates a repository with one commit holding files, and returns it
// with a helper that runs git in a directory and requires success.
func gitRepo(t *testing.T, files map[string]string) (string, func(dir string, args ...string)) {
	t.Helper()
	repo := t.TempDir()
	git := func(dir string, args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		out, err := cmd.CombinedOutput()
		require.NoError(t, err, string(out))
	}
	git(repo, "init", "-q")
	for name, content := range files {
		require.NoError(t, os.WriteFile(filepath.Join(repo, name), []byte(content), 0o644))
	}
	git(repo, "add", "-A")
	git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init")
	return repo, git
}

func isolationStore(t *testing.T, repo string) *Store {
	t.Helper()
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "nav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = store.Close() })
	_, err = store.UpsertProject(ctx, methods.ACPNavUpsertProjectParams{Path: repo})
	require.NoError(t, err)
	return store
}

// markerCommand is a pass-through filter command that records it ran.
func markerCommand(marker string) string {
	return "touch '" + marker + "'; cat"
}

func assertWorktreeDiscarded(t *testing.T, store *Store, repo, name string) {
	t.Helper()
	path := filepath.Join(worktreeStorageDir(repo), name)
	assert.NoDirExists(t, path)
	assert.False(t, localBranchExists(context.Background(), repo, worktreeBranch(name)), "branch should be deleted")
	exists, err := store.projectExists(context.Background(), path)
	require.NoError(t, err)
	assert.False(t, exists)
	out, err := exec.Command("git", "-C", repo, "worktree", "list", "--porcelain").CombinedOutput()
	require.NoError(t, err, string(out))
	assert.NotContains(t, string(out), path)
}
