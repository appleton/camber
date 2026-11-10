package git

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/appleton/camber/pkg/camber-helper/methods"
	pkgerrors "github.com/pkg/errors"
)

// errGitMissing marks failures caused by the git binary not being installed
// (as opposed to git reporting an error), so status can tell the UI apart
// from "not a repository".
var errGitMissing = pkgerrors.New("git is not installed")

func isGitMissingError(err error) bool {
	var execErr *exec.Error
	return errors.As(err, &execErr) && errors.Is(execErr.Err, exec.ErrNotFound)
}

// gitOutput runs git in dir and returns stdout. On failure the error includes
// git's stderr so the UI can surface actionable messages (e.g. checkout
// conflicts).
func gitOutput(ctx context.Context, dir string, args ...string) (string, error) {
	out, _, err := runGit(ctx, dir, args...)
	return out, err
}

// gitOutputAllowExit1 is gitOutput but treats exit code 1 as success. Needed
// for `git diff --no-index`, which exits 1 when the files differ.
func gitOutputAllowExit1(ctx context.Context, dir string, args ...string) (string, error) {
	out, code, err := runGit(ctx, dir, args...)
	if err != nil && code == 1 {
		return out, nil
	}
	return out, err
}

func runGit(ctx context.Context, dir string, args ...string) (stdout string, exitCode int, err error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	cmd.Env = gitEnv()
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		if isGitMissingError(err) {
			return string(out), -1, errGitMissing
		}
		code := -1
		if exitErr, ok := err.(*exec.ExitError); ok {
			code = exitErr.ExitCode()
		}
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = err.Error()
		}
		return string(out), code, pkgerrors.Errorf("git %s: %s", strings.Join(args, " "), message)
	}
	return string(out), 0, nil
}

// gitEnv is the environment for every git command this package spawns.
// GIT_OPTIONAL_LOCKS=0 stops `git status` from taking .git/index.lock and
// opportunistically rewriting .git/index — writes the desktop file watcher
// would report, retriggering the UI refresh that ran the command. Note that
// `git diff` ignores this variable (observed on git 2.49) and still
// refreshes the index; paths that must never write use diff-index/diff-files
// plumbing instead. Mutating commands still take their mandatory locks and
// are unaffected.
func gitEnv() []string {
	return append(os.Environ(), "GIT_OPTIONAL_LOCKS=0")
}

// status assembles the full GitStatusOutput for a worktree path.
func status(ctx context.Context, dir string) (*methods.GitStatusOutput, error) {
	inside, err := gitOutput(ctx, dir, "rev-parse", "--is-inside-work-tree")
	if err != nil || strings.TrimSpace(inside) != "true" {
		// Not a repo (or git missing): report a benign non-repo status rather
		// than erroring, so the panel can render an empty state.
		return &methods.GitStatusOutput{
			IsRepo:     false,
			GitMissing: errors.Is(err, errGitMissing),
		}, nil
	}

	// Whether porcelain paths are cwd-relative or top-level-relative depends
	// on the git version and status.relativePaths. Running status from the
	// repo top level makes the two conventions coincide, so the output is
	// deterministically top-level-relative; rebaseOntoPrefix then converts to
	// the dir-relative convention every other camber/git method uses.
	statusDir := dir
	prefix := ""
	if topLevel, err := gitOutput(ctx, dir, "rev-parse", "--show-toplevel"); err == nil {
		if trimmed := strings.TrimSpace(topLevel); trimmed != "" {
			statusDir = trimmed
		}
	}
	if out, err := gitOutput(ctx, dir, "rev-parse", "--show-prefix"); err == nil {
		prefix = strings.TrimSpace(out)
	}

	out, err := gitOutput(ctx, statusDir, "status", "--porcelain=v2", "--branch", "--untracked-files=all")
	if err != nil {
		return nil, err
	}
	result := parsePorcelainV2(out)
	rebaseOntoPrefix(result, prefix)

	stashList, err := gitOutput(ctx, dir, "stash", "list")
	if err == nil {
		for _, line := range strings.Split(stashList, "\n") {
			if strings.TrimSpace(line) != "" {
				result.StashCount++
			}
		}
	}

	// Total +/− lines versus HEAD (staged + unstaged in one pass), scoped to
	// dir via the "." pathspec. Binary files report "-" in numstat and are
	// skipped. Best-effort: a failure (e.g. unborn HEAD in a fresh repo)
	// leaves the tracked counters at zero. diff-index rather than diff:
	// porcelain diff opportunistically rewrites .git/index (ignoring
	// GIT_OPTIONAL_LOCKS), and status must not write to the repo it reads —
	// the desktop file watcher reports .git writes and would retrigger the
	// status that caused them.
	if numstat, err := gitOutput(ctx, dir, "diff-index", "--find-renames", "--numstat", "HEAD", "--", "."); err == nil {
		result.Additions, result.Deletions = parseNumstatTotals(numstat)
	}
	// Git diff does not include untracked files, but every consuming UI treats
	// them as full additions. Count them with a fixed-size buffer so a large new
	// file does not become a large helper allocation; binary files contribute no
	// line total, matching numstat's behavior.
	for _, file := range result.Untracked {
		lines, binary, err := countTextFileLines(ctx, filepath.Join(dir, filepath.FromSlash(file.Path)))
		if err == nil && !binary {
			result.Additions += lines
		}
	}
	return result, nil
}

// rebaseOntoPrefix rewrites top-level-relative change paths to be relative to
// the worktree subdirectory identified by prefix (git's `rev-parse
// --show-prefix`, e.g. "sub/dir/"), dropping entries outside that subtree.
// A repo-root worktree has an empty prefix and is left untouched.
func rebaseOntoPrefix(result *methods.GitStatusOutput, prefix string) {
	if prefix == "" {
		return
	}
	filter := func(changes []methods.GitFileChange) []methods.GitFileChange {
		out := make([]methods.GitFileChange, 0, len(changes))
		for _, change := range changes {
			path, ok := strings.CutPrefix(change.Path, prefix)
			if !ok {
				continue
			}
			change.Path = path
			if orig, ok := strings.CutPrefix(change.OrigPath, prefix); ok {
				change.OrigPath = orig
			}
			out = append(out, change)
		}
		return out
	}
	result.Staged = filter(result.Staged)
	result.Unstaged = filter(result.Unstaged)
	result.Untracked = filter(result.Untracked)
}

// parseNumstatTotals sums the additions/deletions columns of
// `git diff --numstat` output, skipping binary entries ("-").
func parseNumstatTotals(out string) (additions, deletions int) {
	for _, line := range strings.Split(out, "\n") {
		fields := strings.SplitN(line, "\t", 3)
		if len(fields) < 3 {
			continue
		}
		if added, err := strconv.Atoi(fields[0]); err == nil {
			additions += added
		}
		if deleted, err := strconv.Atoi(fields[1]); err == nil {
			deletions += deleted
		}
	}
	return additions, deletions
}

// parsePorcelainV2 parses `git status --porcelain=v2 --branch` output.
func parsePorcelainV2(out string) *methods.GitStatusOutput {
	result := &methods.GitStatusOutput{
		IsRepo:    true,
		Staged:    []methods.GitFileChange{},
		Unstaged:  []methods.GitFileChange{},
		Untracked: []methods.GitFileChange{},
	}
	for _, line := range strings.Split(out, "\n") {
		if line == "" {
			continue
		}
		switch {
		case strings.HasPrefix(line, "# branch.head "):
			head := strings.TrimPrefix(line, "# branch.head ")
			if head == "(detached)" {
				result.Detached = true
			} else {
				result.Branch = head
			}
		case strings.HasPrefix(line, "# branch.upstream "):
			result.Upstream = strings.TrimPrefix(line, "# branch.upstream ")
		case strings.HasPrefix(line, "# branch.ab "):
			// "# branch.ab +<ahead> -<behind>"
			fields := strings.Fields(strings.TrimPrefix(line, "# branch.ab "))
			if len(fields) == 2 {
				if ahead, err := strconv.Atoi(strings.TrimPrefix(fields[0], "+")); err == nil {
					result.Ahead = ahead
				}
				if behind, err := strconv.Atoi(strings.TrimPrefix(fields[1], "-")); err == nil {
					result.Behind = behind
				}
			}
		case strings.HasPrefix(line, "1 "):
			parseChangedEntry(line, result)
		case strings.HasPrefix(line, "2 "):
			parseRenamedEntry(line, result)
		case strings.HasPrefix(line, "u "):
			// Unmerged entry: "u <XY> <sub> <m1..m3> <mW> <h1..h3> <path>"
			fields := strings.SplitN(line, " ", 11)
			if len(fields) == 11 {
				result.Unstaged = append(result.Unstaged, methods.GitFileChange{
					Path:   fields[10],
					Status: "unmerged",
				})
			}
		case strings.HasPrefix(line, "? "):
			result.Untracked = append(result.Untracked, methods.GitFileChange{
				Path:   strings.TrimPrefix(line, "? "),
				Status: "untracked",
			})
		}
	}
	return result
}

// parseChangedEntry parses a "1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>"
// porcelain v2 entry into staged/unstaged changes.
func parseChangedEntry(line string, result *methods.GitStatusOutput) {
	fields := strings.SplitN(line, " ", 9)
	if len(fields) != 9 {
		return
	}
	xy, path := fields[1], fields[8]
	appendChange(result, xy, path, "")
}

// parseRenamedEntry parses a "2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\t<origPath>"
// porcelain v2 rename/copy entry.
func parseRenamedEntry(line string, result *methods.GitStatusOutput) {
	fields := strings.SplitN(line, " ", 10)
	if len(fields) != 10 {
		return
	}
	xy := fields[1]
	paths := strings.SplitN(fields[9], "\t", 2)
	if len(paths) != 2 {
		return
	}
	appendChange(result, xy, paths[0], paths[1])
}

func appendChange(result *methods.GitStatusOutput, xy, path, origPath string) {
	if len(xy) != 2 {
		return
	}
	if staged := changeStatus(xy[0]); staged != "" {
		result.Staged = append(result.Staged, methods.GitFileChange{
			Path:     path,
			OrigPath: origPath,
			Status:   staged,
		})
	}
	if unstaged := changeStatus(xy[1]); unstaged != "" {
		result.Unstaged = append(result.Unstaged, methods.GitFileChange{
			Path:   path,
			Status: unstaged,
		})
	}
}

// changeStatus maps a porcelain XY letter to the wire status; "." (unchanged)
// maps to "".
func changeStatus(code byte) string {
	switch code {
	case '.':
		return ""
	case 'M':
		return "modified"
	case 'A':
		return "added"
	case 'D':
		return "deleted"
	case 'R':
		return "renamed"
	case 'C':
		return "copied"
	case 'T':
		return "typechange"
	case 'U':
		return "unmerged"
	default:
		return "unknown"
	}
}
