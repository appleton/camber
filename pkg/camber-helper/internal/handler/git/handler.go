// Package git exposes camber/git/* JSON-RPC methods backing the desktop
// changes view: working-tree status, per-file diffs, staging, discarding, and
// committing. All git I/O happens here by shelling out to git in the
// worktree; the webview only receives normalized data.
package git

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/appleton/camber/pkg/camber-helper/methods"
	pkgerrors "github.com/pkg/errors"
	"github.com/tliron/glsp"
)

// Server implements the camber/git/* handlers. Diff viewing sessions retain
// only lightweight manifest metadata and bounded, disk-spooled patch pages;
// every mutating operation remains stateless.
type Server struct {
	diffMu       sync.Mutex
	diffSessions map[string]*diffSession
}

// NewServer constructs a Server.
func NewServer() *Server {
	return &Server{diffSessions: make(map[string]*diffSession)}
}

// Status returns the working-tree status for a worktree path.
func (s *Server) Status(ctx context.Context, params *methods.GitStatusParams, _ *glsp.Context) (*methods.GitStatusOutput, error) {
	return status(ctx, params.Path)
}

// DiffFile returns the unified diff for one file, staged or unstaged.
// Untracked files render as a full addition via --no-index.
func (s *Server) DiffFile(ctx context.Context, params *methods.GitDiffFileParams, _ *glsp.Context) (*methods.GitDiffFileOutput, error) {
	if err := validateRepoFile(params.Path, params.File); err != nil {
		return nil, err
	}
	var out string
	var err error
	switch {
	case params.Head:
		out, err = gitOutput(ctx, params.Path, "diff", "HEAD", "--", params.File)
	case params.Staged:
		out, err = gitOutput(ctx, params.Path, "diff", "--cached", "--", params.File)
	case params.Untracked:
		// --no-index exits 1 when the files differ, which is expected here.
		out, err = gitOutputAllowExit1(ctx, params.Path, "diff", "--no-index", "--", os.DevNull, params.File)
	default:
		out, err = gitOutput(ctx, params.Path, "diff", "--", params.File)
	}
	if err != nil {
		return nil, err
	}
	result := &methods.GitDiffFileOutput{
		Patch:  out,
		Binary: strings.Contains(out, "Binary files ") && !strings.Contains(out, "@@"),
	}
	if !result.Binary && result.Patch != "" {
		oldContent, newContent, ok := diffFileContents(ctx, params)
		if ok {
			result.HasContents = true
			result.OldContent = oldContent
			result.NewContent = newContent
		}
	}
	return result, nil
}

// diffFileContentsMaxBytes caps each side of the full-contents payload
// returned with a diff; larger files fall back to the collapsed-only view.
const diffFileContentsMaxBytes = 4 << 20 // 4 MiB

// diffFileContents loads the full before/after contents backing a diff so the
// viewer can expand collapsed unmodified lines. Returns ok=false when the
// contents are unavailable or too large; the diff itself still renders.
func diffFileContents(ctx context.Context, params *methods.GitDiffFileParams) (oldContent, newContent string, ok bool) {
	readWorktree := func() (string, bool) {
		data, err := os.ReadFile(filepath.Join(params.Path, filepath.FromSlash(params.File)))
		if err != nil || len(data) > diffFileContentsMaxBytes {
			return "", false
		}
		return string(data), true
	}
	// A missing blob (e.g. file not yet in HEAD or the index) reads as empty.
	// The ":./" form resolves the path relative to the command's cwd — a bare
	// "rev:path" is repo-top-level relative, which breaks for worktrees
	// rooted at a subdirectory of the repo.
	readBlob := func(rev string) (string, bool) {
		out, code, err := runGit(ctx, params.Path, "show", rev+":./"+params.File)
		if err != nil {
			if code > 0 {
				return "", true
			}
			return "", false
		}
		if len(out) > diffFileContentsMaxBytes {
			return "", false
		}
		return out, true
	}

	switch {
	case params.Head:
		// HEAD vs worktree.
		if oldContent, ok = readBlob("HEAD"); !ok {
			return "", "", false
		}
		if newContent, ok = readWorktree(); !ok {
			return "", "", false
		}
	case params.Staged:
		// HEAD vs index.
		if oldContent, ok = readBlob("HEAD"); !ok {
			return "", "", false
		}
		if newContent, ok = readBlob(""); !ok {
			return "", "", false
		}
	case params.Untracked:
		// Whole file is an addition.
		if newContent, ok = readWorktree(); !ok {
			return "", "", false
		}
	default:
		// Index vs worktree.
		if oldContent, ok = readBlob(""); !ok {
			return "", "", false
		}
		if newContent, ok = readWorktree(); !ok {
			return "", "", false
		}
	}
	return oldContent, newContent, true
}

// Stage stages files and returns the refreshed status.
func (s *Server) Stage(ctx context.Context, params *methods.GitStageParams, _ *glsp.Context) (*methods.GitStatusOutput, error) {
	if len(params.Files) == 0 {
		return nil, pkgerrors.New("no files to stage")
	}
	if err := validateRepoFiles(params.Path, params.Files); err != nil {
		return nil, err
	}
	args := append([]string{"add", "--"}, params.Files...)
	if _, err := gitOutput(ctx, params.Path, args...); err != nil {
		return nil, err
	}
	return status(ctx, params.Path)
}

// Unstage unstages files and returns the refreshed status.
func (s *Server) Unstage(ctx context.Context, params *methods.GitUnstageParams, _ *glsp.Context) (*methods.GitStatusOutput, error) {
	if len(params.Files) == 0 {
		return nil, pkgerrors.New("no files to unstage")
	}
	if err := validateRepoFiles(params.Path, params.Files); err != nil {
		return nil, err
	}
	args := append([]string{"restore", "--staged", "--"}, params.Files...)
	if _, err := gitOutput(ctx, params.Path, args...); err != nil {
		return nil, err
	}
	return status(ctx, params.Path)
}

// Discard restores tracked files from the index and deletes untracked files,
// then returns the refreshed status.
func (s *Server) Discard(ctx context.Context, params *methods.GitDiscardParams, _ *glsp.Context) (*methods.GitStatusOutput, error) {
	if len(params.Files) == 0 && len(params.UntrackedFiles) == 0 {
		return nil, pkgerrors.New("no files to discard")
	}
	if err := validateRepoFiles(params.Path, params.Files); err != nil {
		return nil, err
	}
	if err := validateRepoFiles(params.Path, params.UntrackedFiles); err != nil {
		return nil, err
	}
	if len(params.Files) > 0 {
		args := append([]string{"restore", "--"}, params.Files...)
		if _, err := gitOutput(ctx, params.Path, args...); err != nil {
			return nil, err
		}
	}
	if len(params.UntrackedFiles) > 0 {
		args := append([]string{"clean", "-f", "--"}, params.UntrackedFiles...)
		if _, err := gitOutput(ctx, params.Path, args...); err != nil {
			return nil, err
		}
	}
	return status(ctx, params.Path)
}

// Commit commits the staged changes and returns the refreshed status.
func (s *Server) Commit(ctx context.Context, params *methods.GitCommitParams, _ *glsp.Context) (*methods.GitStatusOutput, error) {
	message := strings.TrimSpace(params.Message)
	if message == "" {
		return nil, pkgerrors.New("commit message is empty")
	}
	if _, err := gitOutput(ctx, params.Path, "commit", "-m", message); err != nil {
		return nil, err
	}
	return status(ctx, params.Path)
}

// validateRepoFiles rejects path arguments that could escape the worktree or
// be parsed as git flags.
func validateRepoFiles(root string, files []string) error {
	for _, file := range files {
		if err := validateRepoFile(root, file); err != nil {
			return err
		}
	}
	return nil
}

func validateRepoFile(root, file string) error {
	if file == "" {
		return pkgerrors.New("empty file path")
	}
	if strings.HasPrefix(file, "-") {
		return pkgerrors.Errorf("invalid file path %q", file)
	}
	if filepath.IsAbs(file) {
		return pkgerrors.Errorf("file path must be repo-relative: %q", file)
	}
	clean := filepath.ToSlash(filepath.Clean(file))
	if clean == ".." || strings.HasPrefix(clean, "../") {
		return pkgerrors.Errorf("file path escapes the worktree: %q", file)
	}
	_ = root
	return nil
}
