package filesearch

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestBuildIndexSearchesAcrossDirectoryAndName(t *testing.T) {
	root := t.TempDir()
	require.NoError(t, os.Mkdir(filepath.Join(root, "human_data"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(root, "human_data", "README.md"), []byte("readme"), 0o644))

	idx, err := buildIndex(context.Background(), []WorkspaceFolder{{Path: root, Name: "root", Index: 0}}, nil)
	require.NoError(t, err)

	results, err := idx.search(context.Background(), "humandatareadme", queryModeFuzzy, []WorkspaceFolder{{Path: root, Name: "root", Index: 0}})
	require.NoError(t, err)
	require.NotEmpty(t, results)
	assert.Equal(t, "README.md", results[0].Name.Value)
	assert.Equal(t, "human_data", results[0].Directory.Value)
	assert.NotEmpty(t, results[0].Name.Indices)
	assert.NotEmpty(t, results[0].Directory.Indices)
}

func TestBuildIndexCachesRelativePathHaystacks(t *testing.T) {
	root := t.TempDir()
	require.NoError(t, os.Mkdir(filepath.Join(root, "docs"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(root, "docs", "README.md"), []byte("readme"), 0o644))

	idx, err := buildIndex(context.Background(), []WorkspaceFolder{{Path: root, Name: "root", Index: 0}}, nil)
	require.NoError(t, err)

	assert.Equal(t, len(idx.files), len(idx.fileRelativePaths))
	assert.Equal(t, len(idx.directories), len(idx.directoryRelPaths))
	assert.Contains(t, idx.fileRelativePaths, "docs/README.md")
	assert.Contains(t, idx.directoryRelPaths, "docs")
}

func TestBuildIndexIncludesOpenFilesOutsideWorkspace(t *testing.T) {
	root := t.TempDir()
	external := filepath.Join(t.TempDir(), "plan.md")
	require.NoError(t, os.WriteFile(external, []byte("plan"), 0o644))

	idx, err := buildIndex(context.Background(), []WorkspaceFolder{{Path: root, Name: "root", Index: 0}}, []string{external})
	require.NoError(t, err)

	results, err := idx.search(context.Background(), "plan", queryModeFuzzy, []WorkspaceFolder{{Path: root, Name: "root", Index: 0}})
	require.NoError(t, err)
	require.NotEmpty(t, results)
	assert.Equal(t, external, results[0].Path)
	assert.Equal(t, "Opened Files", results[0].Workspace.Value)
}

func TestGitListFilesExcludesIgnoredAndDeletedFiles(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	root := t.TempDir()
	git := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = root
		out, err := cmd.CombinedOutput()
		require.NoError(t, err, string(out))
	}
	git("init")
	git("config", "user.email", "test@example.com")
	git("config", "user.name", "Test")
	require.NoError(t, os.WriteFile(filepath.Join(root, ".gitignore"), []byte("ignored.txt\n"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(root, "tracked.txt"), []byte("tracked"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(root, "ignored.txt"), []byte("ignored"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(root, "deleted.txt"), []byte("deleted"), 0o644))
	git("add", ".gitignore", "tracked.txt", "deleted.txt")
	git("commit", "-m", "init")
	require.NoError(t, os.Remove(filepath.Join(root, "deleted.txt")))

	paths, ok := getFilesFromGit(context.Background(), WorkspaceFolder{Path: root, Name: "root", Index: 0})
	require.True(t, ok)

	var fromBase []string
	for _, path := range paths {
		fromBase = append(fromBase, path.fromBase)
	}
	assert.Contains(t, fromBase, "tracked.txt")
	assert.NotContains(t, fromBase, "ignored.txt")
	assert.NotContains(t, fromBase, "deleted.txt")
}

func TestWalkFallbackUsesWorkspaceIgnoreRules(t *testing.T) {
	root := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(root, ".gitignore"), []byte("gitignored.txt\n"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(root, ".camberignore"), []byte("poolignored.txt\n"), 0o644))
	require.NoError(t, os.Mkdir(filepath.Join(root, "node_modules"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(root, "visible.txt"), []byte("visible"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(root, "gitignored.txt"), []byte("ignored"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(root, "poolignored.txt"), []byte("ignored"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(root, "binary.bin"), []byte{0x00, 0x01, 0x02, 0x03}, 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(root, "node_modules", "package.json"), []byte("{}"), 0o644))

	paths, err := getFilesFromWalk(context.Background(), WorkspaceFolder{Path: root, Name: "root", Index: 0})
	require.NoError(t, err)

	var fromBase []string
	for _, path := range paths {
		fromBase = append(fromBase, path.fromBase)
	}
	assert.Contains(t, fromBase, "visible.txt")
	assert.NotContains(t, fromBase, "gitignored.txt")
	assert.NotContains(t, fromBase, "poolignored.txt")
	assert.NotContains(t, fromBase, "binary.bin")
	assert.NotContains(t, fromBase, "node_modules/")
	assert.NotContains(t, fromBase, "node_modules/package.json")
}

func TestWalkFallbackReturnsContextCancellation(t *testing.T) {
	root := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err := getFilesFromWalk(ctx, WorkspaceFolder{Path: root, Name: "root", Index: 0})

	require.ErrorIs(t, err, context.Canceled)
}

func TestFuzzyFindBoostsLiteralPathMatches(t *testing.T) {
	matches, err := fuzzyFind(context.Background(), "abc", []string{"a/b/c.go", "abc.go"}, resultLimit)
	require.NoError(t, err)
	require.Len(t, matches, 2)

	assert.Equal(t, "abc.go", matches[0].value)
	assert.Greater(t, matches[0].score, matches[1].score)
}
