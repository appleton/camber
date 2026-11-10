// Package shellenv recovers the environment a user's login shell would
// provide. GUI launch contexts (Finder/launchd on macOS, desktop launchers on
// Linux) hand the helper a minimal environment — PATH is just the system
// directories and none of the user's shell-profile exports exist — while a
// terminal launch provides the full shell environment. Capturing the login
// shell's environment once and folding it into the process closes that gap at
// the source, so every exec.LookPath and exec.Command in the helper resolves
// binaries the way a terminal session would.
package shellenv

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	markerStart = "__CAMBER_ENV_START__"
	markerEnd   = "__CAMBER_ENV_END__"
	// captureTimeout bounds the login-shell run. Shell inits that source
	// version managers (nvm in particular) routinely take over two seconds,
	// so this is deliberately generous: the capture normally runs once at
	// startup and a successful result is cached for the process lifetime.
	captureTimeout = 5 * time.Second
	// captureRetryInterval rate-limits re-capturing after a failure so a
	// broken shell doesn't add captureTimeout to every agent launch, while
	// still letting a transiently slow shell recover later.
	captureRetryInterval = 30 * time.Second
)

var (
	captureMu          sync.Mutex
	capturedEnv        []string
	captureSucceeded   bool
	captureLastAttempt time.Time
)

// Capture returns the user's login-shell environment. A successful capture is
// cached for the process lifetime; failures are retried, rate-limited to one
// attempt per captureRetryInterval, so a transiently slow shell init does not
// disable the repair until the next restart. Returns nil when the environment
// could not be captured (Windows, missing shell, timeout).
func Capture() []string {
	if runtime.GOOS == "windows" {
		return nil
	}

	captureMu.Lock()
	defer captureMu.Unlock()

	if captureSucceeded {
		return slices.Clone(capturedEnv)
	}
	if !captureLastAttempt.IsZero() && time.Since(captureLastAttempt) < captureRetryInterval {
		return nil
	}
	captureLastAttempt = time.Now()

	env := captureFromLoginShell()
	if len(env) > 0 {
		capturedEnv = env
		captureSucceeded = true
	}
	return slices.Clone(env)
}

// ApplyToProcess folds the captured login-shell environment into this
// process's own environment: shell values win (they are the inherited values
// plus whatever the user's shell profile exports), and PATH becomes the shell
// PATH merged with the current one. Call once at server startup, before
// handlers that shell out are constructed.
//
// The repair only runs when the inherited PATH looks like a minimal GUI
// launch: a terminal launch already carries the full shell environment, and
// skipping keeps the (up to captureTimeout) capture off the startup path in
// the common dev case — including when the desktop app already repaired the
// environment this process inherited.
func ApplyToProcess() {
	if runtime.GOOS == "windows" {
		return
	}
	if !pathLooksMinimal(os.Getenv("PATH")) {
		return
	}

	before := os.Environ()
	after := Merge(before, Capture())
	updates := envUpdates(before, after)
	for _, update := range updates {
		key, value, _ := strings.Cut(update, "=")
		if err := os.Setenv(key, value); err != nil {
			slog.Warn("shellenv: set env", "key", key, "err", err)
		}
	}
	if len(updates) > 0 {
		slog.Info("shellenv: applied user shell environment",
			"updated", len(updates), "path", os.Getenv("PATH"))
	}
}

// Merge layers shellEnv over env: entries present in shellEnv replace the
// inherited ones, and PATH becomes the shell PATH (first) merged with the
// inherited PATH. When shellEnv carries no PATH — capture failed — the
// inherited PATH is extended with CommonUserToolDirs as a best-effort
// fallback. On Windows env is returned unchanged.
func Merge(env, shellEnv []string) []string {
	if runtime.GOOS == "windows" {
		return env
	}

	currentPath := envValue(env, "PATH")
	shellPath := envValue(shellEnv, "PATH")

	if len(shellEnv) > 0 {
		env = filterEnvKeysByMap(env, envKeySet(shellEnv))
		env = append(env, shellEnv...)
	}

	var nextPath string
	if shellPath != "" {
		nextPath = MergePathLists(shellPath, currentPath)
	} else {
		nextPath = MergePathLists(currentPath, strings.Join(CommonUserToolDirs(), string(os.PathListSeparator)))
	}
	if nextPath == "" {
		return env
	}

	env = filterEnvKeys(env, "PATH")
	return append(env, "PATH="+nextPath)
}

// MergePathLists joins PATH-style lists in order, dropping empty entries and
// duplicates (first occurrence wins).
func MergePathLists(paths ...string) string {
	seen := map[string]struct{}{}
	merged := make([]string, 0)
	for _, pathList := range paths {
		for _, dir := range filepath.SplitList(pathList) {
			if dir == "" {
				continue
			}
			if _, ok := seen[dir]; ok {
				continue
			}
			seen[dir] = struct{}{}
			merged = append(merged, dir)
		}
	}
	return strings.Join(merged, string(os.PathListSeparator))
}

// CommonUserToolDirs lists directories where user-installed CLIs commonly
// live, filtered to those that exist. It is the fallback when the login-shell
// capture fails, so it should cover the popular package and version managers.
func CommonUserToolDirs() []string {
	dirs := []string{
		"/opt/homebrew/bin",
		"/opt/homebrew/sbin",
		"/usr/local/bin",
		"/usr/local/sbin",
	}

	if home, err := os.UserHomeDir(); err == nil && home != "" {
		userDirs := []string{
			filepath.Join(home, ".asdf", "shims"),
			filepath.Join(home, ".asdf", "bin"),
			filepath.Join(home, ".local", "bin"),
			filepath.Join(home, "bin"),
			filepath.Join(home, ".volta", "bin"),
			filepath.Join(home, ".bun", "bin"),
			filepath.Join(home, ".deno", "bin"),
			filepath.Join(home, ".cargo", "bin"),
			filepath.Join(home, ".npm-global", "bin"),
			filepath.Join(home, ".local", "share", "mise", "shims"),
			filepath.Join(home, ".local", "share", "fnm", "aliases", "default", "bin"),
		}
		if nvmBin := nvmDefaultBin(filepath.Join(home, ".nvm")); nvmBin != "" {
			userDirs = append(userDirs, nvmBin)
		}
		dirs = append(userDirs, dirs...)
	}

	existing := dirs[:0]
	for _, dir := range dirs {
		if stat, err := os.Stat(dir); err == nil && stat.IsDir() {
			existing = append(existing, dir)
		}
	}
	return existing
}

// nvmDefaultBin returns the bin directory of the newest node version an nvm
// install carries. nvm has no shims — the active version only exists on PATH
// inside a shell that sourced nvm.sh — so when shell capture fails the newest
// installed version is the best stand-in for the user's default.
func nvmDefaultBin(nvmDir string) string {
	versions, err := filepath.Glob(filepath.Join(nvmDir, "versions", "node", "v*"))
	if err != nil || len(versions) == 0 {
		return ""
	}
	slices.SortFunc(versions, func(a, b string) int {
		return compareNodeVersions(filepath.Base(a), filepath.Base(b))
	})
	return filepath.Join(versions[len(versions)-1], "bin")
}

func compareNodeVersions(a, b string) int {
	parse := func(v string) [3]int {
		var parts [3]int
		for i, segment := range strings.SplitN(strings.TrimPrefix(v, "v"), ".", 3) {
			if n, err := strconv.Atoi(segment); err == nil {
				parts[i] = n
			}
		}
		return parts
	}
	pa, pb := parse(a), parse(b)
	for i := range pa {
		if pa[i] != pb[i] {
			return pa[i] - pb[i]
		}
	}
	return 0
}

// pathLooksMinimal reports whether every PATH entry is a stock system
// directory — the shape launchd hands GUI apps. Any other entry means a shell
// (or an earlier repair, e.g. the desktop app's) already shaped this
// environment, so the capture can be skipped.
func pathLooksMinimal(path string) bool {
	systemDirs := map[string]struct{}{
		"/usr/bin":                      {},
		"/bin":                          {},
		"/usr/sbin":                     {},
		"/sbin":                         {},
		"/usr/local/bin":                {},
		"/usr/local/sbin":               {},
		"/System/Cryptexes/App/usr/bin": {},
	}
	for _, dir := range filepath.SplitList(path) {
		if dir == "" {
			continue
		}
		if _, ok := systemDirs[dir]; !ok {
			return false
		}
	}
	return true
}

// isUsableShell requires an absolute path to an existing non-directory, so a
// bogus $SHELL (unset, relative, missing) falls back to the platform default
// instead of failing the capture or running something unintended.
func isUsableShell(shell string) bool {
	if shell == "" || !filepath.IsAbs(shell) {
		return false
	}
	stat, err := os.Stat(shell)
	return err == nil && !stat.IsDir()
}

func captureFromLoginShell() []string {
	shell := os.Getenv("SHELL")
	if !isUsableShell(shell) {
		if runtime.GOOS == "darwin" {
			shell = "/bin/zsh"
		} else {
			shell = "/bin/sh"
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), captureTimeout)
	defer cancel()

	script := fmt.Sprintf("printf '%%s\\n' %s; env; printf '%%s\\n' %s", markerStart, markerEnd)
	cmd := exec.CommandContext(ctx, shell, shellArgs(shell, script)...)
	output, err := cmd.Output()
	if err != nil {
		slog.Warn("shellenv: login shell capture failed", "shell", shell, "err", err)
		return nil
	}

	return extractMarkedEnv(string(output))
}

func shellArgs(shell, script string) []string {
	switch filepath.Base(shell) {
	case "fish":
		return []string{"-l", "-c", script}
	case "sh":
		return []string{"-ic", script}
	default:
		return []string{"-ilc", script}
	}
}

func extractMarkedEnv(output string) []string {
	start := strings.LastIndex(output, markerStart)
	if start < 0 {
		return nil
	}
	start += len(markerStart)
	end := strings.Index(output[start:], markerEnd)
	if end < 0 {
		return nil
	}
	block := strings.TrimSpace(output[start : start+end])
	if block == "" {
		return nil
	}

	env := []string{}
	for _, line := range strings.Split(block, "\n") {
		line = strings.TrimRight(line, "\r")
		key, _, ok := strings.Cut(line, "=")
		if !ok || key == "" || shouldDropKey(key) {
			continue
		}
		env = append(env, line)
	}
	return env
}

func shouldDropKey(key string) bool {
	switch key {
	case "_", "OLDPWD", "PWD", "SHLVL":
		return true
	default:
		return false
	}
}

// envUpdates returns the entries of after whose value differs from (or is
// missing in) before.
func envUpdates(before, after []string) []string {
	current := make(map[string]string, len(before))
	for _, entry := range before {
		key, value, ok := strings.Cut(entry, "=")
		if ok {
			current[key] = value
		}
	}

	updates := []string{}
	for _, entry := range after {
		key, value, ok := strings.Cut(entry, "=")
		if !ok {
			continue
		}
		if existing, ok := current[key]; !ok || existing != value {
			updates = append(updates, entry)
		}
	}
	return updates
}

func envValue(env []string, key string) string {
	var value string
	for _, entry := range env {
		entryKey, entryValue, ok := strings.Cut(entry, "=")
		if ok && entryKey == key {
			value = entryValue
		}
	}
	return value
}

func envKeySet(env []string) map[string]struct{} {
	keys := make(map[string]struct{}, len(env))
	for _, entry := range env {
		key, _, ok := strings.Cut(entry, "=")
		if ok {
			keys[key] = struct{}{}
		}
	}
	return keys
}

func filterEnvKeys(env []string, keys ...string) []string {
	if len(keys) == 0 {
		return env
	}
	remove := make(map[string]struct{}, len(keys))
	for _, key := range keys {
		remove[key] = struct{}{}
	}
	return filterEnvKeysByMap(env, remove)
}

func filterEnvKeysByMap(env []string, remove map[string]struct{}) []string {
	if len(remove) == 0 {
		return env
	}

	filtered := make([]string, 0, len(env))
	for _, entry := range env {
		key, _, _ := strings.Cut(entry, "=")
		if _, ok := remove[key]; ok {
			continue
		}
		filtered = append(filtered, entry)
	}
	return filtered
}
