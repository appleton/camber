package mcpservers

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gopkg.in/yaml.v3"
)

func readSettingsYAML(t *testing.T, path string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(path)
	require.NoError(t, err)
	doc := map[string]any{}
	require.NoError(t, yaml.Unmarshal(data, &doc))
	return doc
}

func TestWritePoolServerDisabled_CreatesFileAndSetsFlag(t *testing.T) {
	// Nested dir that doesn't exist yet — the writer must create it.
	path := filepath.Join(t.TempDir(), "nested", "settings.yaml")
	require.NoError(t, writePoolServerDisabled(path, "github", true))

	doc := readSettingsYAML(t, path)
	servers, ok := doc["mcp_servers"].(map[string]any)
	require.True(t, ok)
	gh, ok := servers["github"].(map[string]any)
	require.True(t, ok)
	assert.Equal(t, true, gh["disabled"])
}

func TestWritePoolServerDisabled_PreservesUnrelatedSettings(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.yaml")
	seed := "telemetry: true\n" +
		"mcp_servers:\n" +
		"  other:\n" +
		"    disabled: false\n" +
		"    custom_key: keep-me\n"
	require.NoError(t, os.WriteFile(path, []byte(seed), 0o600))

	require.NoError(t, writePoolServerDisabled(path, "github", true))

	doc := readSettingsYAML(t, path)
	assert.Equal(t, true, doc["telemetry"], "unrelated top-level key preserved")

	servers := doc["mcp_servers"].(map[string]any)
	other, ok := servers["other"].(map[string]any)
	require.True(t, ok, "unrelated server preserved")
	assert.Equal(t, "keep-me", other["custom_key"])
	assert.Equal(t, false, other["disabled"])

	gh := servers["github"].(map[string]any)
	assert.Equal(t, true, gh["disabled"])
}

func TestWritePoolServerDisabled_TogglesExisting(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.yaml")
	require.NoError(t, writePoolServerDisabled(path, "github", true))
	require.NoError(t, writePoolServerDisabled(path, "github", false))

	doc := readSettingsYAML(t, path)
	servers := doc["mcp_servers"].(map[string]any)
	gh := servers["github"].(map[string]any)
	assert.Equal(t, false, gh["disabled"])
}
