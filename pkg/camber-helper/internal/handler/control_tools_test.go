package handler

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/appleton/camber/pkg/camber-helper/internal/handler/acpnav"
	"github.com/appleton/camber/pkg/camber-helper/methods"
)

func TestControlToolsShareAgentServerHandlersAndBroadcastChanges(t *testing.T) {
	h := New()
	h.config = &Config{AssistantHost: "desktop"}
	h.acpNavHandler.SetAgentServerStore(acpnav.NewAssistantConfigAgentServerStore(filepath.Join(t.TempDir(), "assistant.json")))
	var mu sync.Mutex
	var notified []string
	h.remoteHub.SetPrimary(func(_ context.Context, method string, _ any) error {
		mu.Lock()
		defer mu.Unlock()
		notified = append(notified, method)
		return nil
	})

	tools := h.controlTools()
	require.Same(t, h.appAgentServers, tools.AgentServers.Ops, "control actions share the desktop's agent-server mutations and their lock")
	ctx := context.Background()
	saved, err := tools.AgentServers.Ops.Edit(ctx, func(_ methods.ACPNavAgentServersState, set *methods.ACPNavSetAgentServersParams) error {
		set.AgentServers["mine"] = methods.ACPAgentServerConfig{Command: "my-acp"}
		return nil
	}, nil)
	require.NoError(t, err)
	assert.Equal(t, "my-acp", saved.AgentServers["mine"].Command)
	listed, err := tools.AgentServers.List(ctx, &methods.ACPNavListAgentServersParams{}, nil)
	require.NoError(t, err)
	assert.Equal(t, "my-acp", listed.AgentServers["mine"].Command)

	mu.Lock()
	defer mu.Unlock()
	assert.Contains(t, notified, methods.ACPNavAgentServersDidChangeMethod)
	assert.Same(t, h.mcpServersHandler, tools.MCPServers)
}

func TestControlToolsListSkillsUsesGivenWorkspaces(t *testing.T) {
	workspace := t.TempDir()
	dir := filepath.Join(workspace, ".camber", "skills", "ship")
	require.NoError(t, os.MkdirAll(dir, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte("---\nname: ship\ndescription: Ship it\n---\n"), 0o644))

	skills := New().controlTools().ListSkills([]string{workspace})
	var found bool
	for _, skill := range skills {
		if skill.Name == "ship" {
			found = true
			assert.Equal(t, "workspace", skill.Location)
			assert.Equal(t, dir, skill.DirPath)
		}
	}
	assert.True(t, found, "workspace skill listed")
}
