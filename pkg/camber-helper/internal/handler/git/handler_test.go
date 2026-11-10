package git

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

// newTestRepo creates a temp git repository with a single initial commit
// containing tracked.txt.
func newTestRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	runGitT(t, dir, "init", "--initial-branch=main")
	runGitT(t, dir, "config", "user.email", "test@example.com")
	runGitT(t, dir, "config", "user.name", "Test")
	writeFile(t, dir, "tracked.txt", "one\ntwo\nthree\n")
	runGitT(t, dir, "add", ".")
	runGitT(t, dir, "commit", "-m", "initial")
	return dir
}

func runGitT(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	require.NoError(t, err, "git %v: %s", args, out)
}

func writeFile(t *testing.T, dir, name, contents string) {
	t.Helper()
	require.NoError(t, os.WriteFile(filepath.Join(dir, name), []byte(contents), 0o644))
}

func TestStatusNotARepo(t *testing.T) {
	server := NewServer()
	out, err := server.Status(context.Background(), &methods.GitStatusParams{Path: t.TempDir()}, nil)
	require.NoError(t, err)
	assert.False(t, out.IsRepo)
	assert.False(t, out.GitMissing)
}

func TestStatusDoesNotRewriteIndex(t *testing.T) {
	dir := newTestRepo(t)
	server := NewServer()

	// Make the tracked file stat-dirty (same content, different mtime) — the
	// state where `git status` and `git diff` opportunistically refresh the
	// stat cache and rewrite .git/index. The desktop file watcher reports
	// .git writes, retriggering the status that caused them (an infinite
	// reload loop), so a status read must leave the index untouched.
	past := time.Now().Add(-2 * time.Hour)
	require.NoError(t, os.Chtimes(filepath.Join(dir, "tracked.txt"), past, past))

	indexPath := filepath.Join(dir, ".git", "index")
	before, err := os.ReadFile(indexPath)
	require.NoError(t, err)

	status, err := server.Status(context.Background(), &methods.GitStatusParams{Path: dir}, nil)
	require.NoError(t, err)
	require.True(t, status.IsRepo)

	after, err := os.ReadFile(indexPath)
	require.NoError(t, err)
	assert.Equal(t, before, after, ".git/index must not be rewritten by a status read")
}

func TestGitUnavailableWithoutBinary(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	dir := t.TempDir()
	server := NewServer()
	ctx := context.Background()

	status, err := server.Status(ctx, &methods.GitStatusParams{Path: dir}, nil)
	require.NoError(t, err)
	assert.False(t, status.IsRepo)
	assert.True(t, status.GitMissing)

	opened, err := server.DiffOpen(ctx, &methods.GitDiffOpenParams{Path: dir}, nil)
	require.NoError(t, err)
	assert.True(t, opened.Unavailable)
	assert.True(t, opened.GitMissing)
	assert.Empty(t, opened.SessionID)
	assert.True(t, opened.Complete)
	assert.NotNil(t, opened.Files)
}

func TestDiffSessionUnavailableOutsideRepo(t *testing.T) {
	server := NewServer()
	opened, err := server.DiffOpen(context.Background(), &methods.GitDiffOpenParams{Path: t.TempDir()}, nil)
	require.NoError(t, err)
	assert.True(t, opened.Unavailable)
	assert.False(t, opened.GitMissing)
	assert.Empty(t, opened.SessionID)
	assert.True(t, opened.Complete)
	assert.NotNil(t, opened.Files)
}

func TestDiffSessionReportsGitDisappearingDuringRead(t *testing.T) {
	dir := newTestRepo(t)
	writeFile(t, dir, "tracked.txt", "changed\n")
	server := NewServer()
	ctx := context.Background()
	opened, err := server.DiffOpen(ctx, &methods.GitDiffOpenParams{Path: dir}, nil)
	require.NoError(t, err)
	t.Cleanup(func() {
		_, _ = server.DiffClose(ctx, &methods.GitDiffCloseParams{SessionID: opened.SessionID}, nil)
	})

	t.Setenv("PATH", t.TempDir())
	_, err = server.DiffRead(ctx, &methods.GitDiffReadParams{
		SessionID: opened.SessionID,
		File:      "tracked.txt",
	}, nil)
	require.Error(t, err)
	assert.ErrorIs(t, err, errGitMissing)
}

func TestStatusCleanRepo(t *testing.T) {
	dir := newTestRepo(t)
	server := NewServer()
	out, err := server.Status(context.Background(), &methods.GitStatusParams{Path: dir}, nil)
	require.NoError(t, err)
	assert.True(t, out.IsRepo)
	assert.Equal(t, "main", out.Branch)
	assert.Empty(t, out.Upstream)
	assert.Empty(t, out.Staged)
	assert.Empty(t, out.Unstaged)
	assert.Empty(t, out.Untracked)
	assert.Zero(t, out.StashCount)
}

func TestStatusUpstream(t *testing.T) {
	dir := newTestRepo(t)
	// A local bare remote is enough for git to report branch.upstream.
	remote := t.TempDir()
	runGitT(t, remote, "init", "--bare", "--initial-branch=main")
	runGitT(t, dir, "remote", "add", "origin", remote)
	runGitT(t, dir, "push", "--set-upstream", "origin", "main")

	server := NewServer()
	out, err := server.Status(context.Background(), &methods.GitStatusParams{Path: dir}, nil)
	require.NoError(t, err)
	assert.Equal(t, "main", out.Branch)
	assert.Equal(t, "origin/main", out.Upstream)
}

func TestStatusChanges(t *testing.T) {
	dir := newTestRepo(t)
	writeFile(t, dir, "tracked.txt", "one\nTWO\nthree\n")
	writeFile(t, dir, "new.txt", "hello\n")
	writeFile(t, dir, "staged.txt", "staged\n")
	runGitT(t, dir, "add", "staged.txt")

	server := NewServer()
	out, err := server.Status(context.Background(), &methods.GitStatusParams{Path: dir}, nil)
	require.NoError(t, err)

	require.Len(t, out.Staged, 1)
	assert.Equal(t, "staged.txt", out.Staged[0].Path)
	assert.Equal(t, "added", out.Staged[0].Status)

	require.Len(t, out.Unstaged, 1)
	assert.Equal(t, "tracked.txt", out.Unstaged[0].Path)
	assert.Equal(t, "modified", out.Unstaged[0].Status)

	require.Len(t, out.Untracked, 1)
	assert.Equal(t, "new.txt", out.Untracked[0].Path)
	assert.Equal(t, "untracked", out.Untracked[0].Status)

	// tracked.txt: "two" → "TWO" (+1/−1); staged.txt: new staged file (+1);
	// untracked new.txt is represented as a full addition (+1).
	assert.Equal(t, 3, out.Additions)
	assert.Equal(t, 1, out.Deletions)
}

func TestStatusLineCountsCleanRepo(t *testing.T) {
	dir := newTestRepo(t)
	server := NewServer()
	out, err := server.Status(context.Background(), &methods.GitStatusParams{Path: dir}, nil)
	require.NoError(t, err)
	assert.Zero(t, out.Additions)
	assert.Zero(t, out.Deletions)
}

func TestStatusSubdirWorktree(t *testing.T) {
	dir := newTestRepo(t)
	sub := filepath.Join(dir, "sub")
	require.NoError(t, os.MkdirAll(sub, 0o755))
	writeFile(t, dir, "sub/inner.txt", "one\ntwo\n")
	runGitT(t, dir, "add", ".")
	runGitT(t, dir, "commit", "-m", "add sub")

	// One change inside the subtree, one outside, one untracked inside.
	writeFile(t, dir, "sub/inner.txt", "one\nTWO\n")
	writeFile(t, dir, "tracked.txt", "outside change\n")
	writeFile(t, dir, "sub/new.txt", "hello\n")

	server := NewServer()
	ctx := context.Background()
	out, err := server.Status(ctx, &methods.GitStatusParams{Path: sub}, nil)
	require.NoError(t, err)

	// Paths are sub-relative and the outside change is excluded.
	require.Len(t, out.Unstaged, 1)
	assert.Equal(t, "inner.txt", out.Unstaged[0].Path)
	require.Len(t, out.Untracked, 1)
	assert.Equal(t, "new.txt", out.Untracked[0].Path)

	// Line totals are scoped to the subtree: inner.txt "two" → "TWO" and the
	// untracked new.txt is a full addition.
	assert.Equal(t, 2, out.Additions)
	assert.Equal(t, 1, out.Deletions)

	// Diffs (and their full contents) resolve sub-relative paths.
	diff, err := server.DiffFile(ctx, &methods.GitDiffFileParams{Path: sub, File: "inner.txt"}, nil)
	require.NoError(t, err)
	assert.Contains(t, diff.Patch, "+TWO")
	assert.True(t, diff.HasContents)
	assert.Equal(t, "one\ntwo\n", diff.OldContent)
	assert.Equal(t, "one\nTWO\n", diff.NewContent)
}

func TestStatusRename(t *testing.T) {
	dir := newTestRepo(t)
	runGitT(t, dir, "mv", "tracked.txt", "renamed.txt")

	server := NewServer()
	out, err := server.Status(context.Background(), &methods.GitStatusParams{Path: dir}, nil)
	require.NoError(t, err)

	require.Len(t, out.Staged, 1)
	assert.Equal(t, "renamed.txt", out.Staged[0].Path)
	assert.Equal(t, "tracked.txt", out.Staged[0].OrigPath)
	assert.Equal(t, "renamed", out.Staged[0].Status)
}

func TestDiffFile(t *testing.T) {
	dir := newTestRepo(t)
	writeFile(t, dir, "tracked.txt", "one\nTWO\nthree\n")

	server := NewServer()
	ctx := context.Background()

	out, err := server.DiffFile(ctx, &methods.GitDiffFileParams{Path: dir, File: "tracked.txt"}, nil)
	require.NoError(t, err)
	assert.Contains(t, out.Patch, "-two")
	assert.Contains(t, out.Patch, "+TWO")
	assert.False(t, out.Binary)
	// Full contents ride along so the viewer can expand unmodified lines.
	assert.True(t, out.HasContents)
	assert.Equal(t, "one\ntwo\nthree\n", out.OldContent)
	assert.Equal(t, "one\nTWO\nthree\n", out.NewContent)

	// Untracked file diff renders as a full addition.
	writeFile(t, dir, "new.txt", "hello\n")
	out, err = server.DiffFile(ctx, &methods.GitDiffFileParams{Path: dir, File: "new.txt", Untracked: true}, nil)
	require.NoError(t, err)
	assert.Contains(t, out.Patch, "+hello")
	assert.True(t, out.HasContents)
	assert.Empty(t, out.OldContent)
	assert.Equal(t, "hello\n", out.NewContent)

	// Staged diff.
	runGitT(t, dir, "add", "tracked.txt")
	out, err = server.DiffFile(ctx, &methods.GitDiffFileParams{Path: dir, File: "tracked.txt", Staged: true}, nil)
	require.NoError(t, err)
	assert.Contains(t, out.Patch, "+TWO")
	assert.True(t, out.HasContents)
	assert.Equal(t, "one\ntwo\nthree\n", out.OldContent)
	assert.Equal(t, "one\nTWO\nthree\n", out.NewContent)
}

func TestDiffFileHead(t *testing.T) {
	dir := newTestRepo(t)
	server := NewServer()
	ctx := context.Background()

	// Stage one change, then make another on top: the HEAD diff shows both.
	writeFile(t, dir, "tracked.txt", "one\nTWO\nthree\n")
	runGitT(t, dir, "add", "tracked.txt")
	writeFile(t, dir, "tracked.txt", "one\nTWO\nTHREE\n")

	out, err := server.DiffFile(ctx, &methods.GitDiffFileParams{Path: dir, File: "tracked.txt", Head: true}, nil)
	require.NoError(t, err)
	assert.Contains(t, out.Patch, "+TWO")
	assert.Contains(t, out.Patch, "+THREE")
	assert.True(t, out.HasContents)
	assert.Equal(t, "one\ntwo\nthree\n", out.OldContent)
	assert.Equal(t, "one\nTWO\nTHREE\n", out.NewContent)
}

func TestDiffSessionPagesLargeFile(t *testing.T) {
	dir := newTestRepo(t)
	var oldContents strings.Builder
	var newContents strings.Builder
	for i := range 1_000 {
		fmt.Fprintf(&oldContents, "old line %d\n", i)
		fmt.Fprintf(&newContents, "new line %d\n", i)
	}
	writeFile(t, dir, "large.txt", oldContents.String())
	runGitT(t, dir, "add", "large.txt")
	runGitT(t, dir, "commit", "-m", "add large file")
	writeFile(t, dir, "large.txt", newContents.String())

	server := NewServer()
	ctx := context.Background()
	opened, err := server.DiffOpen(ctx, &methods.GitDiffOpenParams{
		Path:       dir,
		TargetPath: "large.txt",
	}, nil)
	require.NoError(t, err)
	t.Cleanup(func() {
		_, _ = server.DiffClose(ctx, &methods.GitDiffCloseParams{SessionID: opened.SessionID}, nil)
	})
	require.NotEmpty(t, opened.SessionID)
	require.NotNil(t, opened.Target)
	assert.Equal(t, "large.txt", opened.Target.Path)
	assert.Empty(t, opened.Files)
	assert.Equal(t, "0", opened.NextCursor)
	assert.False(t, opened.Complete)

	cursor := ""
	chunks := 0
	additions := 0
	deletions := 0
	for {
		page, err := server.DiffRead(ctx, &methods.GitDiffReadParams{
			SessionID: opened.SessionID,
			File:      "large.txt",
			Cursor:    cursor,
		}, nil)
		require.NoError(t, err)
		if page.Complete {
			break
		}
		require.NotNil(t, page.Chunk)
		assert.LessOrEqual(t, page.Chunk.Rows, diffChunkMaxRows)
		assert.LessOrEqual(t, len(page.Chunk.Patch), diffChunkMaxBytes)
		assert.Contains(t, page.Chunk.Patch, "diff --git")
		chunks++
		additions += page.Chunk.Additions
		deletions += page.Chunk.Deletions
		cursor = page.NextCursor
	}
	assert.Greater(t, chunks, 1)
	assert.Equal(t, 1_000, additions)
	assert.Equal(t, 1_000, deletions)

	// Previously-read pages are replayable from the bounded disk spool.
	replayed, err := server.DiffRead(ctx, &methods.GitDiffReadParams{
		SessionID: opened.SessionID,
		File:      "large.txt",
		Cursor:    "0",
	}, nil)
	require.NoError(t, err)
	require.NotNil(t, replayed.Chunk)
	assert.NotEmpty(t, replayed.Chunk.Patch)

	require.Eventually(t, func() bool {
		stats, statsErr := server.DiffStats(ctx, &methods.GitDiffStatsParams{SessionID: opened.SessionID}, nil)
		return statsErr == nil && stats.Ready && stats.Stats != nil
	}, time.Second, 10*time.Millisecond)
}

func TestDiffSessionTargetOutsideScope(t *testing.T) {
	dir := newTestRepo(t)
	writeFile(t, dir, "tracked.txt", "before\n")
	runGitT(t, dir, "add", "tracked.txt")
	runGitT(t, dir, "commit", "-m", "add tracked file")
	writeFile(t, dir, "tracked.txt", "after\n")

	server := NewServer()
	ctx := context.Background()
	opened, err := server.DiffOpen(ctx, &methods.GitDiffOpenParams{
		Path:       dir,
		Scope:      methods.GitDiffScopeStaged,
		TargetPath: "tracked.txt",
	}, nil)
	require.NoError(t, err)
	t.Cleanup(func() {
		_, _ = server.DiffClose(ctx, &methods.GitDiffCloseParams{SessionID: opened.SessionID}, nil)
	})
	assert.Nil(t, opened.Target)
	assert.NotNil(t, opened.Files)

	listed, err := server.DiffList(ctx, &methods.GitDiffListParams{
		SessionID: opened.SessionID,
		Cursor:    opened.NextCursor,
	}, nil)
	require.NoError(t, err)
	assert.True(t, listed.Complete)
	assert.NotNil(t, listed.Files)
	assert.Empty(t, listed.Files)
}

func TestDiffSessionPagesManifest(t *testing.T) {
	dir := newTestRepo(t)
	for i := range diffManifestPageSize + 5 {
		writeFile(t, dir, fmt.Sprintf("untracked-%03d.txt", i), "new\n")
	}

	server := NewServer()
	ctx := context.Background()
	opened, err := server.DiffOpen(ctx, &methods.GitDiffOpenParams{Path: dir}, nil)
	require.NoError(t, err)
	t.Cleanup(func() {
		_, _ = server.DiffClose(ctx, &methods.GitDiffCloseParams{SessionID: opened.SessionID}, nil)
	})
	require.Empty(t, opened.Files)
	assert.NotNil(t, opened.Files)
	assert.False(t, opened.Complete)
	assert.Equal(t, "0", opened.NextCursor)

	first, err := server.DiffList(ctx, &methods.GitDiffListParams{
		SessionID: opened.SessionID,
		Cursor:    opened.NextCursor,
	}, nil)
	require.NoError(t, err)
	require.Len(t, first.Files, diffManifestPageSize)
	assert.False(t, first.Complete)
	assert.NotEmpty(t, first.NextCursor)

	next, err := server.DiffList(ctx, &methods.GitDiffListParams{
		SessionID: opened.SessionID,
		Cursor:    first.NextCursor,
	}, nil)
	require.NoError(t, err)
	require.Len(t, next.Files, 5)
	assert.True(t, next.Complete)
	assert.Empty(t, next.NextCursor)
	for _, file := range append(first.Files, next.Files...) {
		assert.Equal(t, "untracked", file.Status)
		assert.False(t, file.StatsReady)
		assert.Zero(t, file.Additions)
		assert.Zero(t, file.Deletions)
	}
}

func TestDiffSessionStatsIncludePerFileCounts(t *testing.T) {
	dir := newTestRepo(t)
	writeFile(t, dir, "tracked.txt", "ONE\ntwo\nTHREE\n")

	server := NewServer()
	ctx := context.Background()
	opened, err := server.DiffOpen(ctx, &methods.GitDiffOpenParams{Path: dir}, nil)
	require.NoError(t, err)
	t.Cleanup(func() {
		_, _ = server.DiffClose(ctx, &methods.GitDiffCloseParams{SessionID: opened.SessionID}, nil)
	})

	listed, err := server.DiffList(ctx, &methods.GitDiffListParams{
		SessionID: opened.SessionID,
		Cursor:    opened.NextCursor,
	}, nil)
	require.NoError(t, err)
	require.Len(t, listed.Files, 1)
	assert.Equal(t, "tracked.txt", listed.Files[0].Path)
	assert.False(t, listed.Files[0].StatsReady)

	var stats *methods.GitDiffStats
	require.Eventually(t, func() bool {
		result, statsErr := server.DiffStats(ctx, &methods.GitDiffStatsParams{SessionID: opened.SessionID}, nil)
		if statsErr != nil || !result.Ready || result.Stats == nil {
			return false
		}
		stats = result.Stats
		return true
	}, 2*time.Second, 10*time.Millisecond)
	require.NotNil(t, stats)
	require.Len(t, stats.FileStats, 1)
	assert.Equal(t, "tracked.txt", stats.FileStats[0].Path)
	assert.Equal(t, 2, stats.FileStats[0].Additions)
	assert.Equal(t, 2, stats.FileStats[0].Deletions)
}

func TestDiffSessionUnbornStatsUseCurrentWorktree(t *testing.T) {
	dir := t.TempDir()
	runGitT(t, dir, "init", "--initial-branch=main")
	writeFile(t, dir, "new.txt", "staged\n")
	runGitT(t, dir, "add", "new.txt")
	writeFile(t, dir, "new.txt", "staged\nunstaged one\nunstaged two\n")

	server := NewServer()
	ctx := context.Background()
	opened, err := server.DiffOpen(ctx, &methods.GitDiffOpenParams{Path: dir}, nil)
	require.NoError(t, err)
	t.Cleanup(func() {
		_, _ = server.DiffClose(ctx, &methods.GitDiffCloseParams{SessionID: opened.SessionID}, nil)
	})

	var stats *methods.GitDiffStats
	require.Eventually(t, func() bool {
		result, statsErr := server.DiffStats(ctx, &methods.GitDiffStatsParams{SessionID: opened.SessionID}, nil)
		if statsErr != nil || !result.Ready || result.Stats == nil {
			return false
		}
		stats = result.Stats
		return true
	}, 2*time.Second, 10*time.Millisecond)
	require.NotNil(t, stats)
	assert.Equal(t, 1, stats.Files)
	assert.Equal(t, 3, stats.Additions)
	assert.Zero(t, stats.Deletions)
	require.Len(t, stats.FileStats, 1)
	assert.Equal(t, 3, stats.FileStats[0].Additions)
}

func TestDiffSessionPacksHunksIntoOneChunk(t *testing.T) {
	dir := newTestRepo(t)
	lines := make([]string, 100)
	for i := range lines {
		lines[i] = fmt.Sprintf("line %d", i)
	}
	writeFile(t, dir, "multi.txt", strings.Join(lines, "\n")+"\n")
	runGitT(t, dir, "add", "multi.txt")
	runGitT(t, dir, "commit", "-m", "add multi")
	// Three edits far enough apart for three separate hunks.
	lines[10] = "changed 10"
	lines[50] = "changed 50"
	lines[90] = "changed 90"
	writeFile(t, dir, "multi.txt", strings.Join(lines, "\n")+"\n")

	server := NewServer()
	ctx := context.Background()
	opened, err := server.DiffOpen(ctx, &methods.GitDiffOpenParams{Path: dir, TargetPath: "multi.txt"}, nil)
	require.NoError(t, err)
	t.Cleanup(func() {
		_, _ = server.DiffClose(ctx, &methods.GitDiffCloseParams{SessionID: opened.SessionID}, nil)
	})

	page, err := server.DiffRead(ctx, &methods.GitDiffReadParams{
		SessionID: opened.SessionID,
		File:      "multi.txt",
	}, nil)
	require.NoError(t, err)
	require.NotNil(t, page.Chunk)
	assert.Equal(t, 3, page.Chunk.Hunks)
	assert.Equal(t, 3, strings.Count(page.Chunk.Patch, "\n@@ -"))
	assert.Equal(t, 3, page.Chunk.Additions)
	assert.Equal(t, 3, page.Chunk.Deletions)

	next, err := server.DiffRead(ctx, &methods.GitDiffReadParams{
		SessionID: opened.SessionID,
		File:      "multi.txt",
		Cursor:    page.NextCursor,
	}, nil)
	require.NoError(t, err)
	assert.True(t, next.Complete)
	assert.Nil(t, next.Chunk)
}

func TestParseDiffChunksSplitsAtHunkBoundaries(t *testing.T) {
	var patch strings.Builder
	patch.WriteString("diff --git a/many.txt b/many.txt\n--- a/many.txt\n+++ b/many.txt\n")
	// 250 two-row hunks = 500 rows: one full 400-row chunk, one 100-row rest.
	for i := range 250 {
		line := i*10 + 1
		fmt.Fprintf(&patch, "@@ -%d,1 +%d,1 @@\n-old %d\n+new %d\n", line, line, i, i)
	}
	var chunks []methods.GitDiffChunk
	err := parseDiffChunks(strings.NewReader(patch.String()), func(chunk methods.GitDiffChunk) error {
		chunks = append(chunks, chunk)
		return nil
	})
	require.NoError(t, err)
	require.Len(t, chunks, 2)
	assert.Equal(t, 400, chunks[0].Rows)
	assert.Equal(t, 200, chunks[0].Hunks)
	assert.Equal(t, 100, chunks[1].Rows)
	assert.Equal(t, 50, chunks[1].Hunks)
	for _, chunk := range chunks {
		assert.True(t, strings.HasPrefix(chunk.Patch, "diff --git"))
		assert.Equal(t, chunk.Hunks, strings.Count(chunk.Patch, "\n@@ -"))
	}
}

func TestParseDiffChunksSynthesizesMidHunkContinuation(t *testing.T) {
	var patch strings.Builder
	patch.WriteString("diff --git a/big.txt b/big.txt\n--- a/big.txt\n+++ b/big.txt\n")
	patch.WriteString("@@ -1,500 +1,500 @@ func context\n")
	for i := range 250 {
		fmt.Fprintf(&patch, "-old %d\n+new %d\n", i, i)
	}
	var chunks []methods.GitDiffChunk
	err := parseDiffChunks(strings.NewReader(patch.String()), func(chunk methods.GitDiffChunk) error {
		chunks = append(chunks, chunk)
		return nil
	})
	require.NoError(t, err)
	require.Len(t, chunks, 2)
	assert.Equal(t, 400, chunks[0].Rows)
	assert.Equal(t, 1, chunks[0].Hunks)
	assert.Equal(t, 100, chunks[1].Rows)
	assert.Equal(t, 1, chunks[1].Hunks)
	// The continuation carries a synthesized header at the split position
	// with counts covering only its own lines, keeping the hunk context.
	assert.Contains(t, chunks[1].Patch, "@@ -201,50 +201,50 @@ func context\n")
}

func TestDiffContents(t *testing.T) {
	dir := newTestRepo(t)
	writeFile(t, dir, "tracked.txt", "one\nTWO\nthree\n")
	writeFile(t, dir, "fresh.txt", "brand new\n")

	server := NewServer()
	ctx := context.Background()
	opened, err := server.DiffOpen(ctx, &methods.GitDiffOpenParams{Path: dir}, nil)
	require.NoError(t, err)
	t.Cleanup(func() {
		_, _ = server.DiffClose(ctx, &methods.GitDiffCloseParams{SessionID: opened.SessionID}, nil)
	})

	tracked, err := server.DiffContents(ctx, &methods.GitDiffContentsParams{
		SessionID: opened.SessionID,
		File:      "tracked.txt",
	}, nil)
	require.NoError(t, err)
	assert.True(t, tracked.HasContents)
	assert.Equal(t, "one\ntwo\nthree\n", tracked.OldContent)
	assert.Equal(t, "one\nTWO\nthree\n", tracked.NewContent)

	untracked, err := server.DiffContents(ctx, &methods.GitDiffContentsParams{
		SessionID: opened.SessionID,
		File:      "fresh.txt",
	}, nil)
	require.NoError(t, err)
	assert.True(t, untracked.HasContents)
	assert.Empty(t, untracked.OldContent)
	assert.Equal(t, "brand new\n", untracked.NewContent)
}

func TestDiffContentsStagedScopeReadsIndex(t *testing.T) {
	dir := newTestRepo(t)
	writeFile(t, dir, "tracked.txt", "one\nstaged\nthree\n")
	runGitT(t, dir, "add", "tracked.txt")
	// Worktree drifts after staging; the staged scope must read the index.
	writeFile(t, dir, "tracked.txt", "one\nworktree\nthree\n")

	server := NewServer()
	ctx := context.Background()
	opened, err := server.DiffOpen(ctx, &methods.GitDiffOpenParams{
		Path:  dir,
		Scope: methods.GitDiffScopeStaged,
	}, nil)
	require.NoError(t, err)
	t.Cleanup(func() {
		_, _ = server.DiffClose(ctx, &methods.GitDiffCloseParams{SessionID: opened.SessionID}, nil)
	})

	contents, err := server.DiffContents(ctx, &methods.GitDiffContentsParams{
		SessionID: opened.SessionID,
		File:      "tracked.txt",
	}, nil)
	require.NoError(t, err)
	assert.True(t, contents.HasContents)
	assert.Equal(t, "one\ntwo\nthree\n", contents.OldContent)
	assert.Equal(t, "one\nstaged\nthree\n", contents.NewContent)
}

func TestParseDiffChunksTruncatesOversizedLine(t *testing.T) {
	patch := "diff --git a/large.txt b/large.txt\n" +
		"new file mode 100644\n" +
		"--- /dev/null\n" +
		"+++ b/large.txt\n" +
		"@@ -0,0 +1,1 @@\n+" + strings.Repeat("x", diffLineMaxBytes*3) + "\n"
	var chunks []methods.GitDiffChunk
	err := parseDiffChunks(strings.NewReader(patch), func(chunk methods.GitDiffChunk) error {
		chunks = append(chunks, chunk)
		return nil
	})
	require.NoError(t, err)
	require.Len(t, chunks, 1)
	assert.Equal(t, 1, chunks[0].Rows)
	assert.Equal(t, 1, chunks[0].Additions)
	assert.Equal(t, 1, chunks[0].TruncatedLines)
	assert.Contains(t, chunks[0].Patch, "[line omitted:")
	assert.Less(t, len(chunks[0].Patch), diffChunkMaxBytes)
}

func TestDiffFileRejectsEscapingPaths(t *testing.T) {
	dir := newTestRepo(t)
	server := NewServer()
	ctx := context.Background()

	_, err := server.DiffFile(ctx, &methods.GitDiffFileParams{Path: dir, File: "../outside.txt"}, nil)
	assert.Error(t, err)
	_, err = server.DiffFile(ctx, &methods.GitDiffFileParams{Path: dir, File: "--flag"}, nil)
	assert.Error(t, err)
	_, err = server.DiffFile(ctx, &methods.GitDiffFileParams{Path: dir, File: "/abs/path.txt"}, nil)
	assert.Error(t, err)
}

func TestStageUnstageCommit(t *testing.T) {
	dir := newTestRepo(t)
	writeFile(t, dir, "tracked.txt", "one\nTWO\nthree\n")

	server := NewServer()
	ctx := context.Background()

	out, err := server.Stage(ctx, &methods.GitStageParams{Path: dir, Files: []string{"tracked.txt"}}, nil)
	require.NoError(t, err)
	require.Len(t, out.Staged, 1)
	assert.Empty(t, out.Unstaged)

	out, err = server.Unstage(ctx, &methods.GitUnstageParams{Path: dir, Files: []string{"tracked.txt"}}, nil)
	require.NoError(t, err)
	assert.Empty(t, out.Staged)
	require.Len(t, out.Unstaged, 1)

	_, err = server.Stage(ctx, &methods.GitStageParams{Path: dir, Files: []string{"tracked.txt"}}, nil)
	require.NoError(t, err)
	out, err = server.Commit(ctx, &methods.GitCommitParams{Path: dir, Message: "update tracked"}, nil)
	require.NoError(t, err)
	assert.Empty(t, out.Staged)
	assert.Empty(t, out.Unstaged)
}

func TestCommitEmptyMessage(t *testing.T) {
	dir := newTestRepo(t)
	server := NewServer()
	_, err := server.Commit(context.Background(), &methods.GitCommitParams{Path: dir, Message: "  "}, nil)
	assert.Error(t, err)
}

func TestDiscard(t *testing.T) {
	dir := newTestRepo(t)
	writeFile(t, dir, "tracked.txt", "changed\n")
	writeFile(t, dir, "new.txt", "hello\n")

	server := NewServer()
	out, err := server.Discard(context.Background(), &methods.GitDiscardParams{
		Path:           dir,
		Files:          []string{"tracked.txt"},
		UntrackedFiles: []string{"new.txt"},
	}, nil)
	require.NoError(t, err)
	assert.Empty(t, out.Unstaged)
	assert.Empty(t, out.Untracked)

	contents, err := os.ReadFile(filepath.Join(dir, "tracked.txt"))
	require.NoError(t, err)
	assert.Equal(t, "one\ntwo\nthree\n", string(contents))
	assert.NoFileExists(t, filepath.Join(dir, "new.txt"))
}
