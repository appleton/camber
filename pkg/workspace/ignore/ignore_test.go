package ignore

import (
	"path/filepath"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCreateIgnoredChecker(t *testing.T) {
	fs := afero.NewMemMapFs()
	root := filepath.Join(string(filepath.Separator), "workspace")
	require.NoError(t, fs.MkdirAll(root, 0o755))
	require.NoError(t, afero.WriteFile(fs, filepath.Join(root, ".camberignore"), []byte("ignored.txt\n"), 0o644))
	require.NoError(t, afero.WriteFile(fs, filepath.Join(root, "ignored.txt"), []byte("text"), 0o644))
	require.NoError(t, afero.WriteFile(fs, filepath.Join(root, "regular.txt"), []byte("text"), 0o644))
	require.NoError(t, afero.WriteFile(fs, filepath.Join(root, "binary.dat"), []byte{0, 1, 2}, 0o644))

	checkIgnored, err := CreateIgnoredChecker(fs, root)
	require.NoError(t, err)

	assert.True(t, checkIgnored(filepath.Join(root, "ignored.txt"), false))
	assert.True(t, checkIgnored(filepath.Join(root, "binary.dat"), false))
	assert.False(t, checkIgnored(filepath.Join(root, "regular.txt"), false))
	assert.True(t, checkIgnored(filepath.Join(root, "node_modules"), true))
}
