package acpregistry

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestBinaryTarget(t *testing.T) {
	target, err := BinaryTarget("darwin", "arm64")
	assert.NoError(t, err)
	assert.Equal(t, "darwin-aarch64", target)

	target, err = BinaryTarget("linux", "amd64")
	assert.NoError(t, err)
	assert.Equal(t, "linux-x86_64", target)

	target, err = BinaryTarget("windows", "amd64")
	assert.NoError(t, err)
	assert.Equal(t, "windows-x86_64", target)
}

func TestAgentsCacheDirHonorsOverride(t *testing.T) {
	override := t.TempDir()
	t.Setenv("CAMBER_ACP_AGENTS_DIR", override)

	dir, err := AgentsCacheDir()
	require.NoError(t, err)
	assert.Equal(t, override, dir)

	root, err := BinaryInstallRoot("poolside", "https://example.com/pool.tar.gz", "")
	require.NoError(t, err)
	assert.Equal(t, override, filepath.Dir(filepath.Dir(root)),
		"binary install root should live under the overridden agents cache dir")
}

func TestBinaryInstallRootIncludesChecksum(t *testing.T) {
	t.Setenv("CAMBER_ACP_AGENTS_DIR", t.TempDir())

	first, err := BinaryInstallRoot("poolside", "https://example.com/pool.tar.gz", strings.Repeat("a", 64))
	require.NoError(t, err)
	second, err := BinaryInstallRoot("poolside", "https://example.com/pool.tar.gz", strings.Repeat("b", 64))
	require.NoError(t, err)

	assert.NotEqual(t, first, second)
}

func TestAgentsCacheDirDefaultsToUserCache(t *testing.T) {
	t.Setenv("CAMBER_ACP_AGENTS_DIR", "")
	t.Setenv("HOME", t.TempDir())

	dir, err := AgentsCacheDir()
	require.NoError(t, err)
	assert.Equal(t, "acp-agents", filepath.Base(dir))
	assert.Equal(t, "poolside", filepath.Base(filepath.Dir(dir)))
}
