package filesearch

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/appleton/camber/pkg/camber-helper/methods"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSearchCanExcludeOpenFilesOutsideWorkspace(t *testing.T) {
	root := t.TempDir()
	external := filepath.Join(t.TempDir(), "plan.md")
	require.NoError(t, os.WriteFile(external, []byte("plan"), 0o644))

	srv := NewServer(nil)
	srv.openFiles[external] = struct{}{}

	params := &methods.SearchFilesParams{
		Query:      "plan",
		Workspaces: []methods.SearchFilesWorkspaceFolder{{Path: root, Name: "root", Index: 0}},
	}

	withOpenFiles, err := srv.Search(context.Background(), params, nil)
	require.NoError(t, err)
	require.Len(t, withOpenFiles.Files, 1)
	assert.Equal(t, external, withOpenFiles.Files[0].Path)

	params.ExcludeOpenFilesOutsideWorkspaces = true
	withoutOpenFiles, err := srv.Search(context.Background(), params, nil)
	require.NoError(t, err)
	assert.Empty(t, withoutOpenFiles.Files)
}
