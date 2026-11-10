package filesearch

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestResolveDirectFilesystemPath(t *testing.T) {
	root := t.TempDir()
	require.NoError(t, os.Mkdir(filepath.Join(root, "documents"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(root, "documents", "report.md"), []byte("report"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(root, ".hidden"), []byte("hidden"), 0o644))

	t.Run("lists relative directory contents", func(t *testing.T) {
		listing, err := resolveDirectFilesystemPath(context.Background(), "./documents/", []WorkspaceFolder{{
			Path:  root,
			Name:  "root",
			Index: 0,
		}})
		require.NoError(t, err)
		require.Len(t, listing.files, 1)
		assert.Equal(t, "report.md", listing.files[0].Name.Value)
		assert.Equal(t, filepath.Join("documents", "report.md"), listing.files[0].DisplayPath)
		assert.Equal(t, []string{"parent", "current"}, controlKinds(listing))
	})

	t.Run("does not expose hidden files unless the partial starts with dot", func(t *testing.T) {
		withoutDot, err := resolveDirectFilesystemPath(context.Background(), root+string(filepath.Separator), nil)
		require.NoError(t, err)
		assert.NotContains(t, fileNames(withoutDot), ".hidden")

		withDot, err := resolveDirectFilesystemPath(context.Background(), filepath.Join(root, ".h"), nil)
		require.NoError(t, err)
		assert.Contains(t, fileNames(withDot), ".hidden")
	})

	t.Run("preserves bare slash for workspace directory search", func(t *testing.T) {
		listing, err := resolveDirectFilesystemPath(context.Background(), "/", nil)
		require.NoError(t, err)
		assert.Empty(t, listing.files)
		assert.Empty(t, listing.controls)
	})

	t.Run("falls through for unmatched root partials", func(t *testing.T) {
		listing, err := resolveDirectFilesystemPath(context.Background(), "/camber-definitely-not-found-91c0e055", nil)
		require.NoError(t, err)
		assert.Empty(t, listing.files)
		assert.Empty(t, listing.controls)
	})

	t.Run("resolves quoted absolute paths", func(t *testing.T) {
		report := filepath.Join(root, "documents", "report.md")
		listing, err := resolveDirectFilesystemPath(context.Background(), `"`+report+`"`, nil)
		require.NoError(t, err)
		require.Len(t, listing.files, 1)
		assert.Equal(t, report, listing.files[0].Path)
	})

	t.Run("lists symlinked files and directories", func(t *testing.T) {
		require.NoError(t, os.Symlink(filepath.Join(root, "documents", "report.md"), filepath.Join(root, "linked-report.md")))
		require.NoError(t, os.Symlink(filepath.Join(root, "documents"), filepath.Join(root, "linked-documents")))

		listing, err := resolveDirectFilesystemPath(context.Background(), root+string(filepath.Separator), nil)
		require.NoError(t, err)
		assert.Contains(t, fileNames(listing), "linked-report.md")
		assert.Contains(t, fileNames(listing), "linked-documents")
	})
}

func TestResolveMultiRootRelativePath(t *testing.T) {
	client := t.TempDir()
	server := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(server, "server-file.ts"), []byte("server"), 0o644))
	workspaces := []WorkspaceFolder{
		{Path: client, Name: "app", Index: 0},
		{Path: server, Name: "app", Index: 1},
	}

	listing, err := resolveDirectFilesystemPath(context.Background(), "./", workspaces)
	require.NoError(t, err)
	assert.Equal(t, []string{"app-0", "app-1"}, fileNames(listing))
	assert.Equal(t, []string{"./app-0/", "./app-1/"}, []string{listing.files[0].NavigationPath, listing.files[1].NavigationPath})

	listing, err = resolveDirectFilesystemPath(context.Background(), "./app-1/", workspaces)
	require.NoError(t, err)
	assert.Contains(t, fileNames(listing), "server-file.ts")
	assert.Equal(t, "./app-1/server-file.ts", listing.files[0].DisplayPath)
}

func fileNames(listing directoryListing) []string {
	names := make([]string, 0, len(listing.files))
	for _, file := range listing.files {
		names = append(names, file.Name.Value)
	}
	return names
}

func controlKinds(listing directoryListing) []string {
	kinds := make([]string, 0, len(listing.controls))
	for _, control := range listing.controls {
		kinds = append(kinds, control.Kind)
	}
	return kinds
}
