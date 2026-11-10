package acpnav

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAssistantConfigSchemaContract(t *testing.T) {
	data := readRepositoryTestFile(t, "schemas/assistant/v1.json")
	var schema map[string]any
	require.NoError(t, json.Unmarshal(data, &schema))

	assert.Equal(t, "https://json-schema.org/draft/2020-12/schema", schema["$schema"])
	assert.Equal(t, assistantConfigSchemaURL, schema["$id"])
	assert.Equal(t, true, schema["additionalProperties"])

	properties := schemaMap(t, schema, "properties")
	assert.Equal(t,
		[]string{"$schema", "agent_servers", "default_agent_server", "default_agent_server_pinned"},
		sortedSchemaKeys(properties),
	)

	agentServers := schemaMap(t, properties, "agent_servers")
	additionalProperties := schemaMap(t, agentServers, "additionalProperties")
	assert.Equal(t, "#/$defs/agentServer", additionalProperties["$ref"])

	defs := schemaMap(t, schema, "$defs")
	assert.Equal(t,
		[]string{
			"agentServer",
			"customAgentServer",
			"localAgentServer",
			"pinnedConfigOptions",
			"registryAgentServer",
			"stringMap",
		},
		sortedSchemaKeys(defs),
	)
	for _, definition := range []string{
		"customAgentServer",
		"localAgentServer",
		"registryAgentServer",
	} {
		assert.Equalf(
			t,
			true,
			schemaMap(t, defs, definition)["additionalProperties"],
			"%s must accept unknown fields for forward compatibility",
			definition,
		)
	}
	assert.Equal(t,
		[]string{"args", "command", "default_config_options", "env", "pinned_config_options", "type"},
		sortedSchemaKeys(schemaMap(t, schemaMap(t, defs, "customAgentServer"), "properties")),
	)
	assert.Equal(t,
		[]string{"default_config_options", "pinned_config_options", "type"},
		sortedSchemaKeys(schemaMap(t, schemaMap(t, defs, "registryAgentServer"), "properties")),
	)
	assert.Equal(t,
		[]string{"type"},
		sortedSchemaKeys(schemaMap(t, schemaMap(t, defs, "localAgentServer"), "properties")),
	)
}

func TestAssistantConfigDocumentationExamplesAreJSONWithSchema(t *testing.T) {
	data := readRepositoryTestFile(t, "docs/acp-agent-configuration.md")
	blocks := regexp.MustCompile("(?s)```json\\n(.*?)\\n```").FindAllSubmatch(data, -1)
	require.NotEmpty(t, blocks)

	for index, block := range blocks {
		var example map[string]any
		require.NoErrorf(t, json.Unmarshal(block[1], &example), "JSON example %d", index+1)
		assert.Equalf(t, assistantConfigSchemaURL, example["$schema"], "JSON example %d", index+1)
	}
}

func schemaMap(t *testing.T, parent map[string]any, key string) map[string]any {
	t.Helper()
	value, ok := parent[key].(map[string]any)
	require.Truef(t, ok, "schema field %q must be an object", key)
	return value
}

func sortedSchemaKeys(values map[string]any) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func readRepositoryTestFile(t *testing.T, relativePath string) []byte {
	t.Helper()
	candidates := []string{
		relativePath,
		filepath.Join("..", "..", "..", "..", "..", relativePath),
	}
	if testSrcDir := os.Getenv("TEST_SRCDIR"); testSrcDir != "" {
		if testWorkspace := os.Getenv("TEST_WORKSPACE"); testWorkspace != "" {
			candidates = append(candidates, filepath.Join(testSrcDir, testWorkspace, relativePath))
		}
	}
	for _, candidate := range candidates {
		data, err := os.ReadFile(candidate)
		if err == nil {
			return data
		}
	}
	t.Fatalf("repository test file %q was not found in %v", relativePath, candidates)
	return nil
}
