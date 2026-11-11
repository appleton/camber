package acpnav

import (
	"context"
	stderrors "errors"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strings"
)

// Isolated git is how control (CLI) automation runs git in a user's
// repository without executing repository-controlled commands. On top of
// IsolatedGitArgs it neutralises the repo-scoped configuration that makes git
// or git-lfs run commands during checkout and status:
//
//   - filter drivers (filter.<name>.smudge/clean/process) defined in the
//     repository's own config (local or worktree scope, including files those
//     scopes include) are blanked, except lfs, which is pinned to the
//     canonical git-lfs commands. Drivers defined only in system, global or
//     command-line config are the user's own and are left alone;
//   - git-lfs custom transfer agents defined in repo scope are blanked and
//     lfs.standalonetransferagent is always cleared.
//
// The configuration is enumerated from inside the worktree git will operate
// on, never from the root checkout: [includeIf "onbranch:..."] and
// [includeIf "gitdir:..."] sections resolve differently per worktree.
// Enumeration failures fail closed.
//
// A blanked smudge driver would silently leave files un-decoded (git-crypt
// ciphertext, for example), so isolated worktree creation refuses
// repositories with a repo-scoped non-LFS smudge or process driver, or a
// repo-scoped custom LFS transfer agent, and tells the user to use the
// desktop app instead.

// IsolatedGitArgs prefixes args with isolatedGitConfig.
func IsolatedGitArgs(args ...string) []string {
	return append(append([]string{}, isolatedGitConfig...), args...)
}

// CheckWorktreeClean returns an error unless git reports no uncommitted or
// untracked changes in the worktree at path. git runs isolated, with the
// repo's filter drivers neutralised, so a repo clean filter cannot run; with
// such a driver disabled, filtered files can only appear modified (the check
// fails closed), and the error says so.
func (s *Store) CheckWorktreeClean(ctx context.Context, path string) error {
	path = cleanPath(path)
	if path == "" {
		return fmt.Errorf("worktree path is required")
	}
	prefix, cfg, err := s.isolatedWorktreeArgs(ctx, path)
	if err != nil {
		return err
	}
	// --ignore-submodules=dirty compares submodule commits without running
	// git inside them; git worktree remove refuses initialized submodules.
	out, err := s.runGit(ctx, append(prefix, "-C", path, "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=dirty")...)
	if err != nil {
		return fmt.Errorf("checking worktree state: %w: %s", err, strings.TrimSpace(string(out)))
	}
	if strings.TrimSpace(string(out)) == "" {
		return nil
	}
	msg := "worktree contains uncommitted or untracked changes; preserve or commit them before removing it"
	if len(cfg.cleanDrivers) > 0 {
		msg += fmt.Sprintf(" (repository filter driver %s was disabled for this check, so filtered files can appear modified; if the worktree is clean, remove it from the desktop app)", strings.Join(cfg.cleanDrivers, ", "))
	}
	return stderrors.New(msg)
}

// isolatedGitConfig stops git from running repo-controlled hooks, fsmonitor,
// submodule recursion (submodule config is not enumerated) or a standalone
// git-lfs transfer agent.
var isolatedGitConfig = []string{
	"-c", "core.hooksPath=/dev/null",
	"-c", "core.fsmonitor=false",
	"-c", "submodule.recurse=false",
	"-c", "lfs.standalonetransferagent=",
}

// lfsFilterOverrides pins git-lfs to its canonical commands so a repo cannot
// repoint the lfs filter at something else.
var lfsFilterOverrides = []string{
	"-c", "filter.lfs.smudge=git-lfs smudge -- %f",
	"-c", "filter.lfs.process=git-lfs filter-process",
	"-c", "filter.lfs.clean=git-lfs clean -- %f",
	"-c", "filter.lfs.required=true",
}

// repoGitConfigPattern matches the config keys that make git or git-lfs run
// configured commands during checkout or status.
const repoGitConfigPattern = `^(filter\..*\.(smudge|clean|process|required)|lfs\.customtransfer\..*\.path)$`

// repoGitConfig is the command-running configuration visible in one worktree.
type repoGitConfig struct {
	// overrides are -c arguments neutralising it.
	overrides []string
	// contentDrivers are repo-scoped non-LFS drivers with a smudge or process
	// command: checked-out content depends on them.
	contentDrivers []string
	// cleanDrivers are repo-scoped non-LFS drivers with a clean or process
	// command: status detection depends on them.
	cleanDrivers []string
	// customTransfers are repo-scoped git-lfs custom transfer agents.
	customTransfers []string
}

// addWorktreeIsolated creates the worktree without checking anything out,
// enumerates the filter configuration from inside it (so per-branch and
// per-worktree includes are seen), refuses repositories whose checkout would
// need a repo-controlled driver, and then populates the worktree with every
// repo-scoped driver neutralised. Any failure after the worktree exists
// removes it and its branch. Must be called with the repo lock held.
func (s *Store) addWorktreeIsolated(ctx context.Context, projectPath, branch, worktreePath string) error {
	if out, err := s.runGit(ctx, IsolatedGitArgs("-C", projectPath, "worktree", "add", "--no-checkout", "-b", branch, worktreePath)...); err != nil {
		return fmt.Errorf("git worktree add failed: %w: %s", err, strings.TrimSpace(string(out)))
	}
	err := s.populateWorktreeIsolated(ctx, worktreePath)
	if err != nil {
		s.discardWorktree(ctx, projectPath, branch, worktreePath)
	}
	return err
}

func (s *Store) populateWorktreeIsolated(ctx context.Context, worktreePath string) error {
	cfg, err := s.inspectRepoGitConfig(ctx, worktreePath)
	if err != nil {
		return err
	}
	if len(cfg.contentDrivers) > 0 {
		return fmt.Errorf("repository uses filter driver %s, which automation does not run; create this worktree from the desktop app", strings.Join(cfg.contentDrivers, ", "))
	}
	if len(cfg.customTransfers) > 0 {
		return fmt.Errorf("repository configures git-lfs custom transfer agent %s, which automation does not run; create this worktree from the desktop app", strings.Join(cfg.customTransfers, ", "))
	}
	args := append(IsolatedGitArgs(cfg.overrides...), "-C", worktreePath, "reset", "--quiet", "--hard")
	if out, err := s.runGit(ctx, args...); err != nil {
		return fmt.Errorf("populating worktree failed: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// discardWorktree best-effort removes a worktree created by
// addWorktreeIsolated and the branch it created.
func (s *Store) discardWorktree(ctx context.Context, projectPath, branch, worktreePath string) {
	if _, err := s.runGit(ctx, IsolatedGitArgs("-C", projectPath, "worktree", "remove", "--force", worktreePath)...); err != nil {
		_ = os.RemoveAll(worktreePath)
		_, _ = s.runGit(ctx, IsolatedGitArgs("-C", projectPath, "worktree", "prune")...)
	}
	_, _ = s.runGit(ctx, IsolatedGitArgs("-C", projectPath, "branch", "-D", branch)...)
}

// isolatedWorktreeArgs returns the git global arguments for running git
// against the existing worktree at path: isolatedGitConfig plus overrides
// enumerated inside it. A missing worktree directory gets isolatedGitConfig
// alone, since git neither checks out nor runs status in it.
func (s *Store) isolatedWorktreeArgs(ctx context.Context, path string) ([]string, repoGitConfig, error) {
	if _, err := os.Lstat(path); stderrors.Is(err, os.ErrNotExist) {
		return IsolatedGitArgs(), repoGitConfig{}, nil
	}
	cfg, err := s.inspectRepoGitConfig(ctx, path)
	if err != nil {
		return nil, repoGitConfig{}, err
	}
	return IsolatedGitArgs(cfg.overrides...), cfg, nil
}

// inspectRepoGitConfig enumerates, from inside dir, the configuration that
// makes git or git-lfs run commands, and builds the overrides that disable
// the repo-scoped part of it.
func (s *Store) inspectRepoGitConfig(ctx context.Context, dir string) (repoGitConfig, error) {
	out, err := s.runGit(ctx, IsolatedGitArgs("-C", dir, "config", "--null", "--show-scope", "--get-regexp", repoGitConfigPattern)...)
	if err != nil {
		var exitErr *exec.ExitError
		if stderrors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
			return repoGitConfig{}, nil // no matching keys
		}
		return repoGitConfig{}, fmt.Errorf("listing git filter drivers: %w: %s", err, strings.TrimSpace(string(out)))
	}
	type driver struct{ repoScoped, content, clean bool }
	drivers := map[string]*driver{}
	transfers := map[string]struct{}{}
	// Records alternate "<scope>\0" and "<key>\n<value>\0" (no "\n" for a
	// valueless boolean key).
	fields := strings.Split(string(out), "\x00")
	for i := 0; i+1 < len(fields); i += 2 {
		repoScoped := !trustedConfigScope(fields[i])
		key, value, _ := strings.Cut(fields[i+1], "\n")
		value = strings.TrimSpace(value)
		if rest, ok := strings.CutPrefix(key, "lfs.customtransfer."); ok {
			if name, ok := strings.CutSuffix(rest, ".path"); ok && repoScoped {
				transfers[name] = struct{}{}
			}
			continue
		}
		rest, ok := strings.CutPrefix(key, "filter.")
		if !ok {
			continue
		}
		dot := strings.LastIndex(rest, ".")
		if dot <= 0 {
			continue
		}
		name, attr := rest[:dot], rest[dot+1:]
		d := drivers[name]
		if d == nil {
			d = &driver{}
			drivers[name] = d
		}
		d.repoScoped = d.repoScoped || repoScoped
		// Commands from any scope count: once a driver is repo-scoped every
		// one of its keys is blanked, including a user-defined smudge.
		if value == "" {
			continue
		}
		switch attr {
		case "smudge":
			d.content = true
		case "clean":
			d.clean = true
		case "process":
			d.content, d.clean = true, true
		}
	}

	var cfg repoGitConfig
	for _, name := range sortedKeys(drivers) {
		d := drivers[name]
		switch {
		case name == "lfs":
			cfg.overrides = append(cfg.overrides, lfsFilterOverrides...)
		case d.repoScoped:
			for _, v := range []string{"smudge=", "clean=", "process=", "required=false"} {
				cfg.overrides = append(cfg.overrides, "-c", "filter."+name+"."+v)
			}
			if d.content {
				cfg.contentDrivers = append(cfg.contentDrivers, name)
			}
			if d.clean {
				cfg.cleanDrivers = append(cfg.cleanDrivers, name)
			}
		}
	}
	for _, name := range sortedKeys(transfers) {
		cfg.overrides = append(cfg.overrides, "-c", "lfs.customtransfer."+name+".path=")
		cfg.customTransfers = append(cfg.customTransfers, name)
	}
	return cfg, nil
}

// trustedConfigScope reports whether config from scope was written by the
// user or the helper rather than by the repository. Unknown scopes are
// treated as repository-controlled.
func trustedConfigScope(scope string) bool {
	switch scope {
	case "system", "global", "command":
		return true
	}
	return false
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
