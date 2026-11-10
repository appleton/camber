package acpnav

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/adrg/xdg"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

func gitRepoWithPostCheckoutHook(t *testing.T) (repo, marker string) {
	t.Helper()
	repo = t.TempDir()
	marker = filepath.Join(t.TempDir(), "hook-ran")
	run := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = repo
		out, err := cmd.CombinedOutput()
		require.NoError(t, err, string(out))
	}
	run("init", "-q")
	run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init")
	hook := "#!/bin/sh\ntouch '" + marker + "'\n"
	require.NoError(t, os.WriteFile(filepath.Join(repo, ".git", "hooks", "post-checkout"), []byte(hook), 0o755))
	return repo, marker
}

func TestCreateWorktreeIsolatedSkipsRepoHooks(t *testing.T) {
	// xdg resolves StateHome at init from the process environment; Bazel's test
	// sandbox has no writable home, so point worktree storage at a temp dir.
	t.Cleanup(xdg.Reload) // registered first so it runs after Setenv restores the env
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	xdg.Reload()
	ctx := context.Background()
	repo, marker := gitRepoWithPostCheckoutHook(t)
	store, err := Open(ctx, filepath.Join(t.TempDir(), "nav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = store.Close() })

	_, err = store.UpsertProject(ctx, methods.ACPNavUpsertProjectParams{Path: repo})
	require.NoError(t, err)

	_, err = store.CreateWorktreeIsolated(ctx, repo, "iso-one")
	require.NoError(t, err)
	assert.NoFileExists(t, marker)

	_, err = store.CreateWorktree(ctx, repo, "ui-one")
	require.NoError(t, err)
	assert.FileExists(t, marker)
}

func TestCreateWorktreeIsolatedDisablesRepoFilterDrivers(t *testing.T) {
	t.Cleanup(xdg.Reload)
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	xdg.Reload()
	ctx := context.Background()
	repo := t.TempDir()
	marker := filepath.Join(t.TempDir(), "filter-ran")
	run := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = repo
		out, err := cmd.CombinedOutput()
		require.NoError(t, err, string(out))
	}
	run("init", "-q")
	require.NoError(t, os.WriteFile(filepath.Join(repo, ".gitattributes"), []byte("*.txt filter=evil\n"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(repo, "a.txt"), []byte("hello\n"), 0o644))
	run("add", ".")
	run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init")
	script := "touch '" + marker + "'; cat"
	run("config", "filter.evil.smudge", script)
	run("config", "filter.evil.process", "sh -c 'touch "+marker+"; exit 1'")
	run("config", "filter.evil.required", "true")

	store, err := Open(ctx, filepath.Join(t.TempDir(), "nav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = store.Close() })
	_, err = store.UpsertProject(ctx, methods.ACPNavUpsertProjectParams{Path: repo})
	require.NoError(t, err)

	overrides, err := store.filterDriverOverrides(ctx, repo)
	require.NoError(t, err)
	assert.Contains(t, overrides, "filter.evil.smudge=")

	wt, err := store.CreateWorktreeIsolated(ctx, repo, "iso-filter")
	require.NoError(t, err)
	assert.NoFileExists(t, marker)
	assert.FileExists(t, filepath.Join(wt.Path, "a.txt"))

	// The non-isolated path is unchanged: the driver runs (and may fail, as the
	// process filter is required) but must have been invoked.
	_, _ = store.CreateWorktree(ctx, repo, "ui-filter")
	assert.FileExists(t, marker)
}

func TestFilterDriverOverridesPinsLFS(t *testing.T) {
	store := &Store{runGit: func(ctx context.Context, args ...string) ([]byte, error) {
		return []byte("filter.lfs.smudge\nevil\x00filter.my.driver.clean\nx\x00filter.lfs.required\nfalse\x00"), nil
	}}
	overrides, err := store.filterDriverOverrides(context.Background(), "/repo")
	require.NoError(t, err)
	assert.Contains(t, overrides, "filter.lfs.smudge=git-lfs smudge -- %f")
	assert.Contains(t, overrides, "filter.lfs.required=true")
	assert.Contains(t, overrides, "filter.my.driver.smudge=")
	assert.NotContains(t, overrides, "filter.lfs.smudge=")
}
