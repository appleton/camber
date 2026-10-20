package cambercli

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestInstallLinkPreservesExistingFilesAndLinks(t *testing.T) {
	directory := t.TempDir()
	executable := filepath.Join(directory, "desktop-camber")
	require.NoError(t, os.WriteFile(executable, []byte("binary"), 0755))
	targetDirectory := filepath.Join(directory, "bin")
	path, err := installLink(targetDirectory, executable)
	require.NoError(t, err)
	canonicalExecutable, err := filepath.EvalSymlinks(executable)
	require.NoError(t, err)
	target, err := os.Readlink(path)
	require.NoError(t, err)
	assert.Equal(t, canonicalExecutable, target)
	_, err = installLink(targetDirectory, executable)
	require.NoError(t, err)
	another := filepath.Join(directory, "another")
	require.NoError(t, os.WriteFile(another, []byte("other"), 0755))
	_, err = installLink(targetDirectory, another)
	require.ErrorContains(t, err, "different executable")
	require.NoError(t, os.Remove(path))
	require.NoError(t, os.WriteFile(path, []byte("user binary"), 0755))
	_, err = installLink(targetDirectory, executable)
	require.ErrorContains(t, err, "existing file")
	content, err := os.ReadFile(path)
	require.NoError(t, err)
	assert.Equal(t, "user binary", string(content))
}
func TestSkillInstallRemoveAndOwnership(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "poolside")
	f := &fakeCaller{}
	output, err := execute(t, f, "skill", "setup", "--directory", directory, "--json")
	require.NoError(t, err)
	assert.Contains(t, output, `"owned":true`)
	content, err := os.ReadFile(filepath.Join(directory, "SKILL.md"))
	require.NoError(t, err)
	assert.Contains(t, string(content), "camber skill show")
	_, err = execute(t, f, "skill", "status", "--directory", directory)
	require.NoError(t, err)
	_, err = execute(t, f, "skill", "setup", "--directory", directory)
	require.NoError(t, err)
	_, err = execute(t, f, "skill", "remove", "--directory", directory)
	require.NoError(t, err)
	_, err = os.Stat(filepath.Join(directory, "SKILL.md"))
	assert.ErrorIs(t, err, os.ErrNotExist)
	require.NoError(t, os.MkdirAll(directory, 0755))
	require.NoError(t, os.WriteFile(filepath.Join(directory, "SKILL.md"), []byte("user skill"), 0644))
	for _, action := range []string{"setup", "remove"} {
		_, err = execute(t, f, "skill", action, "--directory", directory)
		require.ErrorContains(t, err, "user-owned")
	}
	assert.Empty(t, f.calls)
}
