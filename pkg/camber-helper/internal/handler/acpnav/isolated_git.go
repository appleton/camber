package acpnav

import (
	"context"
	stderrors "errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// Isolated git is how control (CLI) automation runs git in a user's
// repository without executing repository-controlled commands. Every
// isolated git command gets isolatedGitConfig and the per-repo overrides
// below through the environment (GIT_CONFIG_COUNT/KEY_n/VALUE_n, never -c,
// which splits at the first "=" and so cannot name a driver whose name
// contains one), with lazy fetching from promisor remotes and terminal
// prompts disabled.
//
// On top of that it handles the repo-scoped configuration that makes git or
// git-lfs run commands during checkout and status. Repo scope is the local
// and worktree config, including files they include; system, global and
// command-line config is the user's own and is left alone.
//
//   - filter drivers (filter.<name>.smudge/clean/process) defined in repo
//     scope are blanked, except lfs, which is pinned to the canonical
//     git-lfs commands;
//   - git-lfs custom transfer agents defined in repo scope are blanked and
//     lfs.standalonetransferagent is always cleared;
//   - keys that make git or git-lfs run a command to reach a server or fetch
//     credentials (core.sshCommand, core.askPass, core.gitProxy,
//     credential helpers, remote upload/receive-pack and remote helpers,
//     uploadpack.packObjectsHook, git-lfs extensions) cannot be neutralised
//     without breaking LFS downloads, so isolated create and remove refuse
//     the repository. So does a committed .lfsconfig pointing git-lfs at a
//     non-HTTP(S) endpoint or declaring extensions or transfer agents;
//   - a repo-scoped filter, remote, credential or git-lfs transfer agent or
//     extension key whose subsection contains "=" or a newline fails closed.
//
// The configuration is enumerated from inside the worktree git will operate
// on, never from the root checkout: [includeIf "onbranch:..."] and
// [includeIf "gitdir:..."] sections resolve differently per worktree.
// Enumeration failures fail closed.
//
// A blanked smudge driver would silently leave files un-decoded (git-crypt
// ciphertext, for example), so isolated worktree creation also refuses
// repositories with a repo-scoped non-LFS smudge or process driver, or a
// repo-scoped custom LFS transfer agent, and tells the user to use the
// desktop app instead.

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
	env, cfg, err := s.isolatedWorktreeEnv(ctx, path)
	if err != nil {
		return err
	}
	// --ignore-submodules=dirty compares submodule commits without running
	// git inside them; git worktree remove refuses initialized submodules.
	out, err := s.runGit(ctx, env, "-C", path, "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=dirty")
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

// gitConfigEntry is one configuration value passed to git as command-scope
// config.
type gitConfigEntry struct{ key, value string }

// isolatedGitConfig stops git from running repo-controlled hooks, fsmonitor,
// submodule recursion (submodule config is not enumerated), a standalone
// git-lfs transfer agent or the ext:: transport.
var isolatedGitConfig = []gitConfigEntry{
	{"core.hooksPath", "/dev/null"},
	{"core.fsmonitor", "false"},
	{"submodule.recurse", "false"},
	{"lfs.standalonetransferagent", ""},
	{"protocol.ext.allow", "never"},
}

// lfsFilterOverrides pins git-lfs to its canonical commands so a repo cannot
// repoint the lfs filter at something else.
var lfsFilterOverrides = []gitConfigEntry{
	{"filter.lfs.smudge", "git-lfs smudge -- %f"},
	{"filter.lfs.process", "git-lfs filter-process"},
	{"filter.lfs.clean", "git-lfs clean -- %f"},
	{"filter.lfs.required", "true"},
}

// isolatedGitEnv returns the environment for an isolated git command:
// isolatedGitConfig followed by overrides (later entries win), lazy fetching
// disabled (a promisor remote would otherwise run remote.<name>.uploadpack or
// ssh mid-checkout) and terminal prompts disabled. It sets GIT_CONFIG_COUNT
// explicitly, and runGitCommand drops any inherited command-line config.
func isolatedGitEnv(overrides ...gitConfigEntry) []string {
	entries := append(append([]gitConfigEntry{}, isolatedGitConfig...), overrides...)
	env := make([]string, 0, 3+2*len(entries))
	env = append(env, "GIT_NO_LAZY_FETCH=1", "GIT_TERMINAL_PROMPT=0", "GIT_CONFIG_COUNT="+strconv.Itoa(len(entries)))
	for i, e := range entries {
		n := strconv.Itoa(i)
		env = append(env, "GIT_CONFIG_KEY_"+n+"="+e.key, "GIT_CONFIG_VALUE_"+n+"="+e.value)
	}
	return env
}

// repoGitConfig is the command-running configuration visible in one worktree.
type repoGitConfig struct {
	// overrides neutralise the repo-scoped filter drivers and transfer agents.
	overrides []gitConfigEntry
	// contentDrivers are repo-scoped non-LFS drivers with a smudge or process
	// command: checked-out content depends on them.
	contentDrivers []string
	// cleanDrivers are repo-scoped non-LFS drivers with a clean or process
	// command: status detection depends on them.
	cleanDrivers []string
	// customTransfers are repo-scoped git-lfs custom transfer agents.
	customTransfers []string
	// commandKeys are repo-scoped (or .lfsconfig) keys that can make git or
	// git-lfs run a command and cannot be neutralised; isolated git refuses
	// to run while any is set.
	commandKeys []string
}

// commandKeysError is the refusal for a repository with commandKeys set.
func (c repoGitConfig) commandKeysError() error {
	if len(c.commandKeys) == 0 {
		return nil
	}
	return fmt.Errorf("repository config sets %s, which can run commands; do this from the desktop app", strings.Join(c.commandKeys, ", "))
}

// addWorktreeIsolated creates the worktree without checking anything out,
// enumerates the configuration from inside it (so per-branch and
// per-worktree includes are seen), refuses repositories whose checkout could
// run a repo-controlled command, and then populates the worktree with every
// repo-scoped driver neutralised. Any failure after the worktree exists
// removes it and its branch. Must be called with the repo lock held.
func (s *Store) addWorktreeIsolated(ctx context.Context, projectPath, branch, worktreePath string) error {
	if out, err := s.runGit(ctx, isolatedGitEnv(), "-C", projectPath, "worktree", "add", "--no-checkout", "-b", branch, worktreePath); err != nil {
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
	if err := cfg.commandKeysError(); err != nil {
		return err
	}
	if len(cfg.contentDrivers) > 0 {
		return fmt.Errorf("repository uses filter driver %s, which automation does not run; create this worktree from the desktop app", strings.Join(cfg.contentDrivers, ", "))
	}
	if len(cfg.customTransfers) > 0 {
		return fmt.Errorf("repository configures git-lfs custom transfer agent %s, which automation does not run; create this worktree from the desktop app", strings.Join(cfg.customTransfers, ", "))
	}
	if out, err := s.runGit(ctx, isolatedGitEnv(cfg.overrides...), "-C", worktreePath, "reset", "--quiet", "--hard"); err != nil {
		return fmt.Errorf("populating worktree failed: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// discardWorktree best-effort removes a worktree created by
// addWorktreeIsolated and the branch it created.
func (s *Store) discardWorktree(ctx context.Context, projectPath, branch, worktreePath string) {
	env := isolatedGitEnv()
	if _, err := s.runGit(ctx, env, "-C", projectPath, "worktree", "remove", "--force", worktreePath); err != nil {
		_ = os.RemoveAll(worktreePath)
		_, _ = s.runGit(ctx, env, "-C", projectPath, "worktree", "prune")
	}
	_, _ = s.runGit(ctx, env, "-C", projectPath, "branch", "-D", branch)
}

// isolatedWorktreeEnv returns the environment for running isolated git
// against the existing worktree at path: isolatedGitConfig plus overrides
// enumerated inside it. It refuses worktrees whose repo config sets
// command-running keys. A missing worktree directory gets isolatedGitConfig
// alone, since git neither checks out nor runs status in it.
func (s *Store) isolatedWorktreeEnv(ctx context.Context, path string) ([]string, repoGitConfig, error) {
	if _, err := os.Lstat(path); stderrors.Is(err, os.ErrNotExist) {
		return isolatedGitEnv(), repoGitConfig{}, nil
	}
	cfg, err := s.inspectRepoGitConfig(ctx, path)
	if err != nil {
		return nil, repoGitConfig{}, err
	}
	if err := cfg.commandKeysError(); err != nil {
		return nil, repoGitConfig{}, err
	}
	return isolatedGitEnv(cfg.overrides...), cfg, nil
}

// inspectRepoGitConfig enumerates, from inside dir, the configuration that
// makes git or git-lfs run commands, builds the overrides that disable the
// repo-scoped part of it, and collects the repo-scoped keys that cannot be
// disabled, including those in the repository's .lfsconfig.
func (s *Store) inspectRepoGitConfig(ctx context.Context, dir string) (repoGitConfig, error) {
	out, err := s.runGit(ctx, isolatedGitEnv(), "-C", dir, "config", "--null", "--show-scope", "--show-origin", "--list")
	if err != nil {
		return repoGitConfig{}, fmt.Errorf("listing git config: %w: %s", err, strings.TrimSpace(string(out)))
	}
	type driver struct{ repoScoped, content, clean bool }
	drivers := map[string]*driver{}
	transfers := map[string]struct{}{}
	commandKeys := map[string]struct{}{}
	var repoDirs []string // resolved lazily for unknown-scope origins
	// Records are "<scope>\0<origin>\0<key>\n<value>\0" (no "\n" for a
	// valueless boolean key).
	fields := strings.Split(string(out), "\x00")
	for i := 0; i+2 < len(fields); i += 3 {
		scope, origin := fields[i], fields[i+1]
		key, value, hasValue := strings.Cut(fields[i+2], "\n")
		value = strings.TrimSpace(value)
		repoScoped := true
		switch {
		case trustedConfigScope(scope):
			repoScoped = false
		case scope == "unknown":
			if repoDirs == nil {
				if repoDirs, err = s.repoDirs(ctx, dir); err != nil {
					return repoGitConfig{}, err
				}
			}
			repoScoped = !trustedUnknownOrigin(origin, repoDirs)
		}
		section, sub, name := splitConfigKey(key)
		if repoScoped && guardedSubsection(section, sub) && strings.ContainsAny(sub, "=\n") {
			return repoGitConfig{}, fmt.Errorf("repository config key %q has a subsection containing \"=\" or a newline, which automation does not handle; do this from the desktop app", key)
		}
		if repoScoped && (!hasValue || value != "") && commandRunningKey(section, sub, name) {
			commandKeys[key] = struct{}{}
		}
		if section == "lfs" {
			if transfer, ok := strings.CutPrefix(sub, "customtransfer."); ok && name == "path" && repoScoped {
				transfers[transfer] = struct{}{}
			}
			continue
		}
		if section != "filter" || sub == "" {
			continue
		}
		switch name {
		case "smudge", "clean", "process", "required":
		default:
			continue
		}
		d := drivers[sub]
		if d == nil {
			d = &driver{}
			drivers[sub] = d
		}
		d.repoScoped = d.repoScoped || repoScoped
		// Commands from any scope count: once a driver is repo-scoped every
		// one of its keys is blanked, including a user-defined smudge.
		if value == "" {
			continue
		}
		switch name {
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
			for _, attr := range []gitConfigEntry{{"smudge", ""}, {"clean", ""}, {"process", ""}, {"required", "false"}} {
				cfg.overrides = append(cfg.overrides, gitConfigEntry{"filter." + name + "." + attr.key, attr.value})
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
		cfg.overrides = append(cfg.overrides, gitConfigEntry{"lfs.customtransfer." + name + ".path", ""})
		cfg.customTransfers = append(cfg.customTransfers, name)
	}
	lfsKeys, err := s.inspectLFSConfig(ctx, dir)
	if err != nil {
		return repoGitConfig{}, err
	}
	cfg.commandKeys = sortedKeys(commandKeys)
	cfg.commandKeys = append(cfg.commandKeys, lfsKeys...)
	return cfg, nil
}

// inspectLFSConfig returns the keys in the repository's .lfsconfig that let
// committed content steer git-lfs into running commands: an lfs.url or
// remote.<name>.lfsurl that is not HTTP(S) (ssh endpoints run ssh, honouring
// core.sshCommand) and any extension or custom transfer declaration. git-lfs
// reads the working-tree file, else the index, else HEAD, so all three are
// checked. Read failures fail closed.
func (s *Store) inspectLFSConfig(ctx context.Context, dir string) ([]string, error) {
	var sources [][]string
	if _, err := os.Lstat(filepath.Join(dir, ".lfsconfig")); err == nil {
		sources = append(sources, []string{"--file", filepath.Join(dir, ".lfsconfig")})
	} else if !stderrors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("reading .lfsconfig: %w", err)
	}
	for _, rev := range []string{":.lfsconfig", "HEAD:.lfsconfig"} {
		out, err := s.runGit(ctx, isolatedGitEnv(), "-C", dir, "rev-parse", "--verify", "--quiet", rev)
		if err != nil {
			var exitErr *exec.ExitError
			if stderrors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
				continue // not present
			}
			return nil, fmt.Errorf("locating %s: %w: %s", rev, err, strings.TrimSpace(string(out)))
		}
		sources = append(sources, []string{"--blob", strings.TrimSpace(string(out))})
	}
	found := map[string]struct{}{}
	for _, source := range sources {
		args := append(append([]string{"-C", dir, "config", "--null"}, source...), "--list")
		out, err := s.runGit(ctx, isolatedGitEnv(), args...)
		if err != nil {
			return nil, fmt.Errorf("reading .lfsconfig: %w: %s", err, strings.TrimSpace(string(out)))
		}
		for _, record := range strings.Split(string(out), "\x00") {
			if record == "" {
				continue
			}
			key, value, _ := strings.Cut(record, "\n")
			section, sub, name := splitConfigKey(key)
			unsafe := false
			switch {
			case section == "lfs" && sub == "" && name == "url",
				section == "remote" && sub != "" && name == "lfsurl":
				unsafe = !httpURL(value)
			case section == "lfs" && (strings.HasPrefix(sub, "extension.") || strings.HasPrefix(sub, "customtransfer.")):
				unsafe = true
			}
			if unsafe {
				found[key+" (in .lfsconfig)"] = struct{}{}
			}
		}
	}
	return sortedKeys(found), nil
}

// repoDirs returns the worktree directory and the repository's common git
// directory, symlinks resolved, for judging unknown-scope config origins.
func (s *Store) repoDirs(ctx context.Context, dir string) ([]string, error) {
	out, err := s.runGit(ctx, isolatedGitEnv(), "-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return nil, fmt.Errorf("locating git directory: %w: %s", err, strings.TrimSpace(string(out)))
	}
	dirs := []string{}
	for _, d := range []string{dir, strings.TrimSpace(string(out))} {
		if resolved, err := filepath.EvalSymlinks(d); err == nil {
			d = resolved
		}
		dirs = append(dirs, filepath.Clean(d))
	}
	return dirs, nil
}

// trustedConfigScope reports whether config from scope was written by the
// user or the helper rather than by the repository. Unknown scopes are
// judged by origin (trustedUnknownOrigin).
func trustedConfigScope(scope string) bool {
	switch scope {
	case "system", "global", "command":
		return true
	}
	return false
}

// trustedUnknownOrigin reports whether an unknown-scope config entry comes
// from a file outside the repository. Apple's git reports its bundled
// system-wide gitconfig (which sets credential.helper) with unknown scope;
// anything else, or any file inside the worktree or git directory, is
// treated as repository-controlled.
func trustedUnknownOrigin(origin string, repoDirs []string) bool {
	path, ok := strings.CutPrefix(origin, "file:")
	if !ok || !filepath.IsAbs(path) {
		return false
	}
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		path = resolved
	}
	path = filepath.Clean(path)
	for _, d := range repoDirs {
		if path == d || strings.HasPrefix(path, d+string(filepath.Separator)) {
			return false
		}
	}
	return true
}

// commandRunningKey reports whether a config key (section and name
// lowercased, as git config --list prints them) can make git or git-lfs run
// a command while fetching objects or credentials.
func commandRunningKey(section, sub, name string) bool {
	switch section {
	case "core":
		switch name {
		case "askpass", "sshcommand", "gitproxy", "alternaterefscommand":
			return sub == ""
		}
	case "credential":
		return name == "helper"
	case "remote":
		switch name {
		case "uploadpack", "receivepack", "vcs":
			return sub != ""
		}
	case "uploadpack":
		return sub == "" && name == "packobjectshook"
	case "lfs":
		return strings.HasPrefix(sub, "extension.") && (name == "clean" || name == "smudge")
	}
	return false
}

// guardedSubsection reports whether a key's subsection names something the
// isolation overrides or refuses (filter drivers, git-lfs transfer agents and
// extensions, remotes, credential contexts), so a "=" or newline in it fails
// closed. Other sections, such as branch names, are not inspected.
func guardedSubsection(section, sub string) bool {
	switch section {
	case "filter", "remote", "credential":
		return true
	case "lfs":
		return strings.HasPrefix(sub, "customtransfer.") || strings.HasPrefix(sub, "extension.")
	}
	return false
}

// splitConfigKey splits "section.subsection.name" at its first and last
// dots; the subsection may itself contain dots.
func splitConfigKey(key string) (section, sub, name string) {
	first, last := strings.Index(key, "."), strings.LastIndex(key, ".")
	if first < 0 {
		return key, "", ""
	}
	if first == last {
		return key[:first], "", key[first+1:]
	}
	return key[:first], key[first+1 : last], key[last+1:]
}

// httpURL reports whether u is an HTTP(S) URL.
func httpURL(u string) bool {
	u = strings.ToLower(strings.TrimSpace(u))
	return strings.HasPrefix(u, "https://") || strings.HasPrefix(u, "http://")
}

// withoutGitConfigEnv drops command-line git config (GIT_CONFIG_PARAMETERS,
// GIT_CONFIG_COUNT, GIT_CONFIG_KEY_n, GIT_CONFIG_VALUE_n) from env.
func withoutGitConfigEnv(env []string) []string {
	kept := make([]string, 0, len(env))
	for _, kv := range env {
		name, _, _ := strings.Cut(kv, "=")
		if name == "GIT_CONFIG_PARAMETERS" || name == "GIT_CONFIG_COUNT" ||
			strings.HasPrefix(name, "GIT_CONFIG_KEY_") || strings.HasPrefix(name, "GIT_CONFIG_VALUE_") {
			continue
		}
		kept = append(kept, kv)
	}
	return kept
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
