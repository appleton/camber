package github

import (
	"context"
	"os/exec"
	"strings"

	pkgerrors "github.com/pkg/errors"
)

// gitOutput runs git in dir and returns trimmed stdout.
func gitOutput(ctx context.Context, dir string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return "", pkgerrors.Wrapf(err, "git %s", strings.Join(args, " "))
	}
	return strings.TrimSpace(string(out)), nil
}

// currentBranch returns the checked-out branch for a worktree, or "" when
// detached.
func currentBranch(ctx context.Context, dir string) (string, error) {
	branch, err := gitOutput(ctx, dir, "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		return "", err
	}
	if branch == "HEAD" {
		// Detached HEAD has no branch to map to a PR.
		return "", nil
	}
	return branch, nil
}

// isWorkTree reports whether dir is inside a git work tree. Unlike
// currentBranch it also holds for repos with no commits yet, where HEAD is
// unborn and rev-parse HEAD fails.
func isWorkTree(ctx context.Context, dir string) bool {
	out, err := gitOutput(ctx, dir, "rev-parse", "--is-inside-work-tree")
	return err == nil && out == "true"
}

// originRepo resolves the GitHub repository for a worktree from its origin
// remote. ok is false when there is no remote or it is not a parseable URL.
func originRepo(ctx context.Context, dir string) (repoRef, bool) {
	// We look up the origin remote, which covers the common worktree case.
	remote, err := gitOutput(ctx, dir, "remote", "get-url", "origin")
	if err != nil || remote == "" {
		return repoRef{}, false
	}
	return parseRemoteURL(remote)
}
