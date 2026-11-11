package acpnav

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
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
	assert.Contains(t, cfg.overrides, gitConfigEntry{"filter.lfs.smudge", "git-lfs smudge -- %f"})
	assert.Empty(t, cfg.contentDrivers)
	assert.Contains(t, isolatedGitEnv(), "GIT_CONFIG_KEY_3=lfs.standalonetransferagent")
	assert.Contains(t, isolatedGitEnv(), "GIT_CONFIG_VALUE_3=")

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
	notFound := exec.Command("sh", "-c", "exit 1").Run()
	var listArgs []string
	store := &Store{runGit: func(ctx context.Context, env []string, args ...string) ([]byte, error) {
		assert.Contains(t, env, "GIT_NO_LAZY_FETCH=1")
		switch {
		case slices.Contains(args, "--show-origin"):
			listArgs = args
		case slices.Contains(args, "--git-common-dir"):
			return []byte("/repo/.git\n"), nil
		case slices.Contains(args, "--verify"):
			return nil, notFound
		default:
			return nil, nil
		}
		rec := func(scope, origin, kv string) string { return scope + "\x00" + origin + "\x00" + kv }
		return []byte(strings.Join([]string{
			rec("global", "file:/home/u/.gitconfig", "filter.lfs.smudge\ngit-lfs smudge -- %f"),
			rec("local", "file:.git/config", "filter.lfs.smudge\nevil"),
			rec("local", "file:.git/config", "filter.my.driver.clean\nx"),
			rec("global", "file:/home/u/.gitconfig", "filter.mine.smudge\ncat"),
			rec("global", "file:/home/u/.gitconfig", "filter.crypt.smudge\ndecrypt"),
			rec("worktree", "file:.git/config.worktree", "filter.crypt.required\ntrue"),
			rec("local", "file:.git/config", "filter.blank.smudge\n"),
			rec("global", "file:/home/u/.gitconfig", "lfs.customtransfer.user.path\n/usr/bin/agent"),
			rec("local", "file:.git/config", "lfs.customtransfer.evil.path\n/tmp/evil"),
			rec("unknown", "file:/usr/share/git-core/gitconfig", "credential.helper\nosxkeychain"),
			rec("unknown", "file:/repo/.git/sneaky", "core.askpass\n/tmp/x"),
			rec("unknown", "blob:abc", "core.gitproxy\n/tmp/x"),
			rec("global", "file:/home/u/.gitconfig", "core.sshcommand\nssh -i key"),
			rec("local", "file:.git/config", "credential.https://example.com.helper\nstore"),
			rec("local", "file:.git/config", "credential.helper\n"),
			rec("local", "file:.git/config", "remote.origin.uploadpack\n/tmp/x"),
			rec("local", "file:.git/config", "remote.origin.url\n/tmp/x"),
		}, "\x00") + "\x00"), nil
	}}
	cfg, err := store.inspectRepoGitConfig(context.Background(), "/repo")
	require.NoError(t, err)
	assert.Equal(t, []string{"-C", "/repo", "config", "--null", "--show-scope", "--show-origin", "--list"}, listArgs)
	assert.Contains(t, cfg.overrides, gitConfigEntry{"filter.lfs.smudge", "git-lfs smudge -- %f"})
	assert.Contains(t, cfg.overrides, gitConfigEntry{"filter.lfs.required", "true"})
	assert.NotContains(t, cfg.overrides, gitConfigEntry{"filter.lfs.smudge", ""})
	assert.Contains(t, cfg.overrides, gitConfigEntry{"filter.my.driver.smudge", ""})
	assert.Contains(t, cfg.overrides, gitConfigEntry{"filter.blank.process", ""})
	assert.Contains(t, cfg.overrides, gitConfigEntry{"lfs.customtransfer.evil.path", ""})
	assert.NotContains(t, cfg.overrides, gitConfigEntry{"filter.mine.smudge", ""}, "user-global drivers are left alone")
	assert.NotContains(t, cfg.overrides, gitConfigEntry{"lfs.customtransfer.user.path", ""})
	assert.Equal(t, []string{"crypt"}, cfg.contentDrivers, "a repo-scoped key exposes the global smudge to blanking")
	assert.Equal(t, []string{"my.driver"}, cfg.cleanDrivers)
	assert.Equal(t, []string{"evil"}, cfg.customTransfers)
	assert.Equal(t, []string{"core.askpass", "core.gitproxy", "credential.https://example.com.helper", "remote.origin.uploadpack"}, cfg.commandKeys,
		"unknown scope is trusted only from files outside the repository; empty values and global keys are allowed")
}

func TestIsolatedGitEnvPassesKeysContainingEquals(t *testing.T) {
	isolationEnv(t)
	repo, git := gitRepo(t, map[string]string{".gitattributes": "*.txt filter=a=b\n", "a.txt": "hello\n"})
	marker := filepath.Join(t.TempDir(), "filter-ran")
	git(repo, "config", "filter.a=b.clean", markerCommand(marker))
	touch := func() {
		future := time.Now().Add(time.Hour)
		require.NoError(t, os.Chtimes(filepath.Join(repo, "a.txt"), future, future))
	}

	// Sanity: -c splits at the first "=" and so does not blank the driver.
	touch()
	git(repo, "-c", "filter.a=b.clean=", "status", "--porcelain")
	require.FileExists(t, marker)
	require.NoError(t, os.Remove(marker))

	// Inherited command-line config must not override the isolated config.
	sq := func(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }
	t.Setenv("GIT_CONFIG_PARAMETERS", sq("filter.a=b.clean")+"="+sq(markerCommand(marker)))
	t.Setenv("GIT_CONFIG_COUNT", "99")
	touch()
	out, err := runGitCommand(context.Background(), isolatedGitEnv(gitConfigEntry{"filter.a=b.clean", ""}), "-C", repo, "status", "--porcelain")
	require.NoError(t, err, string(out))
	assert.NoFileExists(t, marker, "the env key is not split at '=' and inherited config is dropped")
}

func TestIsolatedWorktreeRefusesSubsectionContainingEquals(t *testing.T) {
	isolationEnv(t)
	ctx := context.Background()
	repo, git := gitRepo(t, map[string]string{".gitattributes": "*.txt filter=a=b\n", "a.txt": "hello\n"})
	store := isolationStore(t, repo)
	wt, err := store.CreateWorktree(ctx, repo, "ui-equals")
	require.NoError(t, err)
	marker := filepath.Join(t.TempDir(), "filter-ran")
	git(repo, "config", "filter.a=b.clean", markerCommand(marker))
	future := time.Now().Add(time.Hour)
	require.NoError(t, os.Chtimes(filepath.Join(wt.Path, "a.txt"), future, future))

	err = store.CheckWorktreeClean(ctx, wt.Path)
	require.Error(t, err)
	assert.Contains(t, err.Error(), `filter.a=b.clean`)
	assert.Contains(t, err.Error(), "subsection containing")
	require.Error(t, store.RemoveWorktreeSafely(ctx, wt.Path))
	assert.DirExists(t, wt.Path)
	assert.NoFileExists(t, marker)

	_, err = store.CreateWorktreeIsolated(ctx, repo, "iso-equals")
	require.Error(t, err)
	assert.NoFileExists(t, marker)
	assertWorktreeDiscarded(t, store, repo, "iso-equals")
}

func TestIsolatedWorktreeRefusesGuardedSubsectionsContainingEquals(t *testing.T) {
	for _, key := range []string{"remote.a=b.url", "credential.https://x/?a=b.username", "lfs.customtransfer.a=b.args", "lfs.extension.a=b.priority"} {
		t.Run(key, func(t *testing.T) {
			isolationEnv(t)
			ctx := context.Background()
			repo, git := gitRepo(t, map[string]string{"a.txt": "hello\n"})
			git(repo, "config", key, "x")
			store := isolationStore(t, repo)

			_, err := store.CreateWorktreeIsolated(ctx, repo, "iso-guarded")
			require.Error(t, err)
			assert.Contains(t, err.Error(), "subsection containing")
			assertWorktreeDiscarded(t, store, repo, "iso-guarded")
		})
	}
}

func TestIsolatedWorktreeAllowsBranchNameContainingEquals(t *testing.T) {
	isolationEnv(t)
	ctx := context.Background()
	repo, git := gitRepo(t, map[string]string{"a.txt": "hello\n"})
	git(repo, "branch", "foo=bar")
	git(repo, "config", "branch.foo=bar.remote", "origin")
	git(repo, "config", "branch.foo=bar.merge", "refs/heads/foo=bar")
	store := isolationStore(t, repo)

	wt, err := store.CreateWorktreeIsolated(ctx, repo, "iso-branch-equals")
	require.NoError(t, err)
	require.NoError(t, store.CheckWorktreeClean(ctx, wt.Path))
	require.NoError(t, store.RemoveWorktreeSafely(ctx, wt.Path))
	assert.NoDirExists(t, wt.Path)
}

func TestIsolatedWorktreeRefusesCommandRunningRepoConfig(t *testing.T) {
	for _, tc := range []struct{ key, reported string }{
		{"core.sshCommand", "core.sshcommand"},
		{"core.askPass", "core.askpass"},
		{"core.gitProxy", "core.gitproxy"},
		{"credential.helper", "credential.helper"},
		{"credential.https://example.invalid.helper", "credential.https://example.invalid.helper"},
		{"remote.origin.uploadpack", "remote.origin.uploadpack"},
		{"remote.origin.receivepack", "remote.origin.receivepack"},
		{"remote.origin.vcs", "remote.origin.vcs"},
		{"uploadpack.packObjectsHook", "uploadpack.packobjectshook"},
		{"lfs.extension.foo.smudge", "lfs.extension.foo.smudge"},
	} {
		t.Run(tc.key, func(t *testing.T) {
			isolationEnv(t)
			ctx := context.Background()
			repo, git := gitRepo(t, map[string]string{"a.txt": "hello\n"})
			store := isolationStore(t, repo)
			wt, err := store.CreateWorktree(ctx, repo, "ui-existing")
			require.NoError(t, err)
			// Via an include, which the local scope reports as its own.
			include := filepath.Join(t.TempDir(), "cmd.inc")
			git(repo, "config", "-f", include, tc.key, "/bin/false")
			git(repo, "config", "include.path", include)

			_, err = store.CreateWorktreeIsolated(ctx, repo, "iso-cmd")
			require.Error(t, err)
			assert.Contains(t, err.Error(), "repository config sets "+tc.reported+", which can run commands")
			assert.Contains(t, err.Error(), "desktop app")
			assertWorktreeDiscarded(t, store, repo, "iso-cmd")

			err = store.RemoveWorktreeSafely(ctx, wt.Path)
			require.Error(t, err)
			assert.Contains(t, err.Error(), tc.reported)
			assert.DirExists(t, wt.Path)
			require.Error(t, store.CheckWorktreeClean(ctx, wt.Path))
		})
	}
}

func TestCreateWorktreeIsolatedAllowsUserGlobalCommandConfig(t *testing.T) {
	global := isolationEnv(t)
	ctx := context.Background()
	repo, git := gitRepo(t, map[string]string{"a.txt": "hello\n"})
	git(repo, "config", "-f", global, "core.sshCommand", "/bin/false")
	git(repo, "config", "-f", global, "credential.helper", "/bin/false")
	store := isolationStore(t, repo)

	wt, err := store.CreateWorktreeIsolated(ctx, repo, "iso-global-cmd")
	require.NoError(t, err)
	require.NoError(t, store.RemoveWorktreeSafely(ctx, wt.Path))
}

func TestCreateWorktreeIsolatedChecksLFSConfig(t *testing.T) {
	for _, tc := range []struct {
		name, lfsconfig, refused string
	}{
		{"ssh url", "[lfs]\n\turl = ssh://git@example.invalid/repo\n", "lfs.url (in .lfsconfig)"},
		{"scp url", "[lfs]\n\turl = git@example.invalid:repo\n", "lfs.url (in .lfsconfig)"},
		{"ext url", "[lfs]\n\turl = ext::sh -c touch% /tmp/x\n", "lfs.url (in .lfsconfig)"},
		{"remote lfsurl", "[remote \"origin\"]\n\tlfsurl = ssh://example.invalid/repo\n", "remote.origin.lfsurl (in .lfsconfig)"},
		{"extension", "[lfs \"extension.foo\"]\n\tsmudge = /bin/false\n", "lfs.extension.foo.smudge (in .lfsconfig)"},
		{"custom transfer", "[lfs \"customtransfer.foo\"]\n\tpath = /bin/false\n", "lfs.customtransfer.foo.path (in .lfsconfig)"},
		{"https url", "[lfs]\n\turl = https://example.invalid/repo.git/info/lfs\n\tlocksverify = false\n", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			isolationEnv(t)
			ctx := context.Background()
			repo, _ := gitRepo(t, map[string]string{".lfsconfig": tc.lfsconfig, "a.txt": "hello\n"})
			store := isolationStore(t, repo)

			wt, err := store.CreateWorktreeIsolated(ctx, repo, "iso-lfsconfig")
			if tc.refused == "" {
				require.NoError(t, err)
				require.NoError(t, store.RemoveWorktreeSafely(ctx, wt.Path))
				return
			}
			require.Error(t, err)
			assert.Contains(t, err.Error(), "repository config sets "+tc.refused)
			assertWorktreeDiscarded(t, store, repo, "iso-lfsconfig")

			// A worktree whose working-tree .lfsconfig was edited is refused on remove.
			ui, err := store.CreateWorktree(ctx, repo, "ui-lfsconfig")
			require.NoError(t, err)
			require.Error(t, store.RemoveWorktreeSafely(ctx, ui.Path))
			assert.DirExists(t, ui.Path)
		})
	}
}

func TestCreateWorktreeIsolatedDoesNotLazyFetch(t *testing.T) {
	for _, scope := range []string{"global", "local"} {
		t.Run(scope, func(t *testing.T) {
			global := isolationEnv(t)
			ctx := context.Background()
			repo, git := gitRepo(t, map[string]string{"a.txt": "hello\n"})
			marker := filepath.Join(t.TempDir(), "fetch-ran")
			// Drop the blob so checkout would have to fetch it from the promisor.
			out, err := exec.Command("git", "-C", repo, "rev-parse", "HEAD:a.txt").Output()
			require.NoError(t, err)
			blob := strings.TrimSpace(string(out))
			require.NoError(t, os.Remove(filepath.Join(repo, ".git", "objects", blob[:2], blob[2:])))
			git(repo, "config", "core.repositoryformatversion", "1")
			git(repo, "config", "extensions.partialClone", "origin")
			git(repo, "config", "remote.origin.url", t.TempDir())
			git(repo, "config", "remote.origin.promisor", "true")
			uploadPack := []string{"config", "remote.origin.uploadpack", "touch '" + marker + "'; false"}
			if scope == "global" {
				uploadPack = append([]string{"config", "-f", global}, uploadPack[1:]...)
			}
			git(repo, uploadPack...)
			store := isolationStore(t, repo)

			_, err = store.CreateWorktreeIsolated(ctx, repo, "iso-lazy")
			require.Error(t, err)
			if scope == "local" {
				assert.Contains(t, err.Error(), "repository config sets remote.origin.uploadpack")
			}
			assert.NoFileExists(t, marker)
			assertWorktreeDiscarded(t, store, repo, "iso-lazy")

			// Sanity: plain git does lazily fetch through the promisor.
			_ = exec.Command("git", "-C", repo, "cat-file", "-p", blob).Run()
			assert.FileExists(t, marker)
		})
	}
}

func TestCreateWorktreeIsolatedRefusesLFSDownloadWithRepoSSHCommand(t *testing.T) {
	if _, err := exec.LookPath("git-lfs"); err != nil {
		t.Skip("git-lfs not installed")
	}
	isolationEnv(t)
	ctx := context.Background()
	pointer := "version https://git-lfs.github.com/spec/v1\n" +
		"oid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\n" +
		"size 12345\n"
	repo, git := gitRepo(t, map[string]string{
		".gitattributes": "*.bin filter=lfs diff=lfs merge=lfs -text\n",
		".lfsconfig":     "[lfs]\n\turl = https://example.invalid/repo.git/info/lfs\n",
		"a.bin":          pointer,
	})
	marker := filepath.Join(t.TempDir(), "ssh-ran")
	git(repo, "config", "filter.lfs.smudge", "git-lfs smudge -- %f")
	git(repo, "config", "filter.lfs.process", "git-lfs filter-process")
	git(repo, "config", "filter.lfs.required", "true")
	git(repo, "config", "lfs.url", "ssh://git@example.invalid/repo")
	git(repo, "config", "core.sshCommand", "touch '"+marker+"'; false")
	store := isolationStore(t, repo)

	_, err := store.CreateWorktreeIsolated(ctx, repo, "iso-lfs-ssh")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "repository config sets core.sshcommand")
	assert.NoFileExists(t, marker)
	assertWorktreeDiscarded(t, store, repo, "iso-lfs-ssh")

	// Sanity: the non-isolated path downloads through the repo's ssh command.
	_, _ = store.CreateWorktree(ctx, repo, "ui-lfs-ssh")
	assert.FileExists(t, marker)
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
