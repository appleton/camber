package acpnav

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/appleton/camber/pkg/camber-helper/internal/handler/acpregistry"
	"github.com/appleton/camber/pkg/camber-helper/methods"
)

func TestAssistantConfigAgentServerStoreSetAndList(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "poolside", "assistant.json")
	require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o755))
	require.NoError(t, os.WriteFile(path, []byte(`{"other_setting":true}`), 0o644))
	store := NewAssistantConfigAgentServerStore(path)

	defaultAgentServer := "claude"
	require.NoError(t, store.SetAgentServers(ctx, methods.ACPAgentServers{
		"claude": {
			Command: "npx",
			Args:    []string{"-y", "@zed-industries/claude-code-acp"},
			Env: map[string]string{
				"ANTHROPIC_API_KEY": "test",
			},
			DefaultConfigOptions: map[string]string{
				"permission_mode": "default",
			},
		},
		"default": {
			Command: "pool",
			Args:    []string{"acp"},
		},
	}, &defaultAgentServer, nil))

	agentServers, err := store.ListAgentServers(ctx)
	require.NoError(t, err)
	require.Equal(t, methods.ACPAgentServerConfig{
		Type:    "custom",
		Command: "pool",
		Args:    []string{"acp"},
	}, agentServers["poolside"])
	require.Equal(t, methods.ACPAgentServerConfig{
		Type:    "custom",
		Command: "npx",
		Args:    []string{"-y", "@zed-industries/claude-code-acp"},
		Env: map[string]string{
			"ANTHROPIC_API_KEY": "test",
		},
		DefaultConfigOptions: map[string]string{
			"permission_mode": "default",
		},
	}, agentServers["claude"])

	gotDefault, err := store.GetDefaultAgentServer(ctx)
	require.NoError(t, err)
	require.Equal(t, "claude", gotDefault)

	data, err := os.ReadFile(path)
	require.NoError(t, err)
	require.Contains(t, string(data), `"$schema": "`+assistantConfigSchemaURL+`"`)
	require.Contains(t, string(data), `"other_setting": true`)
	require.Contains(t, string(data), `"agent_servers"`)
	require.Contains(t, string(data), `"default_agent_server": "claude"`)
}

func TestAssistantConfigAgentServerStorePinnedConfigOptionsRoundTrip(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "poolside", "assistant.json")
	store := NewAssistantConfigAgentServerStore(path)

	require.NoError(t, store.SetAgentServers(ctx, methods.ACPAgentServers{
		"claude": {
			Command: "npx",
			DefaultConfigOptions: map[string]string{
				"model":           "sonnet",
				"permission_mode": "default",
			},
			PinnedConfigOptions: []string{"model", "permission_mode"},
		},
		"codex-acp": {
			Type: "registry",
			DefaultConfigOptions: map[string]string{
				"mode": "full-access",
			},
			PinnedConfigOptions: []string{"mode"},
		},
	}, nil, nil))

	agentServers, err := store.ListAgentServers(ctx)
	require.NoError(t, err)
	assert.Equal(t, []string{"model", "permission_mode"}, agentServers["claude"].PinnedConfigOptions)
	assert.Equal(t, []string{"mode"}, agentServers["codex-acp"].PinnedConfigOptions)

	data, err := os.ReadFile(path)
	require.NoError(t, err)
	assert.Contains(t, string(data), `"pinned_config_options"`)
}

func TestAssistantConfigAgentServerStoreLocalAgentConfigOptionsRoundTrip(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "poolside", "assistant.json")
	store := NewAssistantConfigAgentServerStore(path)

	require.NoError(t, store.SetAgentServers(ctx, methods.ACPAgentServers{
		methods.LocalAgentServerName: {
			Type: "local",
			DefaultConfigOptions: map[string]string{
				"model": "malibu-local",
			},
			PinnedConfigOptions: []string{"model"},
		},
	}, nil, nil))

	agentServers, err := store.ListAgentServers(ctx)
	require.NoError(t, err)
	local, ok := agentServers[methods.LocalAgentServerName]
	require.True(t, ok)
	assert.Equal(t, "local", local.Type)
	assert.Equal(t, map[string]string{"model": "malibu-local"}, local.DefaultConfigOptions)
	assert.Equal(t, []string{"model"}, local.PinnedConfigOptions)

	data, err := os.ReadFile(path)
	require.NoError(t, err)
	assert.Contains(t, string(data), `"default_config_options"`)
	assert.Contains(t, string(data), `"pinned_config_options"`)
}

func TestAssistantConfigAgentServerStoreDefaultAgentServerPinnedRoundTrip(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "poolside", "assistant.json")
	store := NewAssistantConfigAgentServerStore(path)

	defaultAgentServer := "claude"
	pinned := true
	require.NoError(t, store.SetAgentServers(ctx, methods.ACPAgentServers{
		"claude": {Command: "npx"},
	}, &defaultAgentServer, &pinned))

	gotPinned, err := store.GetDefaultAgentServerPinned(ctx)
	require.NoError(t, err)
	assert.True(t, gotPinned)
	data, err := os.ReadFile(path)
	require.NoError(t, err)
	assert.Contains(t, string(data), `"default_agent_server_pinned": true`)

	unpinned := false
	require.NoError(t, store.SetAgentServers(ctx, methods.ACPAgentServers{
		"claude": {Command: "npx"},
	}, nil, &unpinned))

	gotPinned, err = store.GetDefaultAgentServerPinned(ctx)
	require.NoError(t, err)
	assert.False(t, gotPinned)
	data, err = os.ReadFile(path)
	require.NoError(t, err)
	assert.NotContains(t, string(data), `"default_agent_server_pinned"`)
}

func TestAssistantConfigAgentServerStoreDefaultAgentServerPinnedPreservedWhenAbsent(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "poolside", "assistant.json")
	store := NewAssistantConfigAgentServerStore(path)

	defaultAgentServer := "claude"
	pinned := true
	require.NoError(t, store.SetAgentServers(ctx, methods.ACPAgentServers{
		"claude": {Command: "npx"},
	}, &defaultAgentServer, &pinned))

	require.NoError(t, store.SetAgentServers(ctx, methods.ACPAgentServers{
		"claude": {Command: "npx"},
		"gemini": {Command: "node"},
	}, nil, nil))

	gotDefault, err := store.GetDefaultAgentServer(ctx)
	require.NoError(t, err)
	assert.Equal(t, "claude", gotDefault)
	gotPinned, err := store.GetDefaultAgentServerPinned(ctx)
	require.NoError(t, err)
	assert.True(t, gotPinned)
}

func TestAssistantConfigAgentServerStorePinnedFieldsDefaultCleanWhenOmitted(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "poolside", "assistant.json")
	store := NewAssistantConfigAgentServerStore(path)

	defaultAgentServer := "claude"
	require.NoError(t, store.SetAgentServers(ctx, methods.ACPAgentServers{
		"claude": {Command: "npx"},
	}, &defaultAgentServer, nil))

	gotPinned, err := store.GetDefaultAgentServerPinned(ctx)
	require.NoError(t, err)
	assert.False(t, gotPinned)
	agentServers, err := store.ListAgentServers(ctx)
	require.NoError(t, err)
	assert.Nil(t, agentServers["claude"].PinnedConfigOptions)

	data, err := os.ReadFile(path)
	require.NoError(t, err)
	assert.NotContains(t, string(data), `"pinned_config_options"`)
	assert.NotContains(t, string(data), `"default_agent_server_pinned"`)
}

func TestAssistantConfigAgentServerStorePreservesConfiguredSchema(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "poolside", "assistant.json")
	require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o755))
	require.NoError(t, os.WriteFile(path, []byte(`{"$schema":"https://example.com/custom-schema.json"}`), 0o644))
	store := NewAssistantConfigAgentServerStore(path)

	require.NoError(t, store.SetAgentServers(ctx, methods.ACPAgentServers{
		"custom": {
			Command: "custom-agent",
		},
	}, nil, nil))

	data, err := os.ReadFile(path)
	require.NoError(t, err)
	require.Contains(t, string(data), `"$schema": "https://example.com/custom-schema.json"`)
	require.NotContains(t, string(data), assistantConfigSchemaURL)
}

func TestAssistantConfigAgentServerStoreIdentifiesMalformedConfig(t *testing.T) {
	path := filepath.Join(t.TempDir(), "poolside", "assistant.json")
	require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o755))
	require.NoError(t, os.WriteFile(path, []byte(`{"agent_servers":`), 0o644))
	store := NewAssistantConfigAgentServerStore(path)

	_, err := store.ListAgentServers(context.Background())

	require.ErrorContains(t, err, "assistant config: parsing "+path)
	require.True(t, IsAssistantConfigParseError(err))
}

func TestAssistantConfigAgentServerStoreRegistryEntry(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "poolside", "assistant.json")
	store := NewAssistantConfigAgentServerStore(path)

	require.NoError(t, store.SetAgentServers(ctx, methods.ACPAgentServers{
		"codex-acp": {
			Type:    "registry",
			Command: "npx",
			Args:    []string{"-y", "@zed-industries/codex-acp@0.16.0"},
			DefaultConfigOptions: map[string]string{
				"mode": "full-access",
			},
		},
	}, nil, nil))

	data, err := os.ReadFile(path)
	require.NoError(t, err)
	require.Contains(t, string(data), `"type": "registry"`)
	require.NotContains(t, string(data), `"command"`)
	require.NotContains(t, string(data), `"binary"`)

	agentServers, err := store.ListAgentServers(ctx)
	require.NoError(t, err)
	require.Equal(t, methods.ACPAgentServerConfig{
		Type: "registry",
		DefaultConfigOptions: map[string]string{
			"mode": "full-access",
		},
	}, agentServers["codex-acp"])

	require.NoError(t, store.RecordInstalledRegistryAgentServer(ctx, "codex-acp", methods.ACPAgentServerConfig{
		Type:    "registry",
		Command: "npx",
		Args:    []string{"-y", "@zed-industries/codex-acp@0.16.0"},
		DefaultConfigOptions: map[string]string{
			"mode": "full-access",
		},
	}))

	agentServers, err = store.ListAgentServers(ctx)
	require.NoError(t, err)
	require.Equal(t, methods.ACPAgentServerConfig{
		Type:    "registry",
		Command: "npx",
		Args:    []string{"-y", "@zed-industries/codex-acp@0.16.0"},
		DefaultConfigOptions: map[string]string{
			"mode": "full-access",
		},
	}, agentServers["codex-acp"])
}

func TestAssistantConfigAgentServerStoreRegistryBinaryRequiresLocalCache(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	t.Setenv("HOME", filepath.Join(dir, "home"))
	t.Setenv("XDG_CACHE_HOME", filepath.Join(dir, "cache"))
	path := filepath.Join(dir, "poolside", "assistant.json")
	store := NewAssistantConfigAgentServerStore(path)

	target, err := acpregistry.BinaryTarget(runtime.GOOS, runtime.GOARCH)
	require.NoError(t, err)
	archive := "https://example.com/codex-binary.tgz"
	cfg := methods.ACPAgentServerConfig{
		Type: "registry",
		Binary: map[string]methods.ACPAgentServerBinaryDistribution{
			target: {
				Archive: archive,
				Cmd:     "./codex-acp",
				Args:    []string{"serve"},
			},
		},
		DefaultConfigOptions: map[string]string{
			"mode": "full-access",
		},
	}
	require.NoError(t, store.SetAgentServers(ctx, methods.ACPAgentServers{"codex-acp": cfg}, nil, nil))
	require.NoError(t, store.RecordInstalledRegistryAgentServer(ctx, "codex-acp", cfg))

	agentServers, err := store.ListAgentServers(ctx)
	require.NoError(t, err)
	require.Equal(t, methods.ACPAgentServerConfig{
		Type: "registry",
		DefaultConfigOptions: map[string]string{
			"mode": "full-access",
		},
	}, agentServers["codex-acp"])

	root, err := acpregistry.BinaryInstallRoot("codex-acp", archive, "")
	require.NoError(t, err)
	require.NoError(t, os.MkdirAll(root, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(root, "codex-acp"), []byte("#!/bin/sh\n"), 0o755))

	agentServers, err = store.ListAgentServers(ctx)
	require.NoError(t, err)
	require.Equal(t, cfg, agentServers["codex-acp"])
}

func TestAssistantConfigAgentServerStoreRepairsInstalledRegistryCommand(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "poolside", "assistant.json")
	store := NewAssistantConfigAgentServerStore(path)

	require.NoError(t, store.SetAgentServers(ctx, methods.ACPAgentServers{
		"codex-acp": {
			Type: "registry",
			DefaultConfigOptions: map[string]string{
				"mode": "full-access",
			},
		},
	}, nil, nil))

	require.NoError(t, store.RepairInstalledRegistryAgentServers(ctx, func(ctx context.Context, name string) (methods.ACPAgentServerConfig, error) {
		if name != "codex-acp" {
			return methods.ACPAgentServerConfig{}, nil
		}
		return methods.ACPAgentServerConfig{
			Type:    "registry",
			Command: "npx",
			Args:    []string{"-y", "@zed-industries/codex-acp@0.16.0"},
		}, nil
	}))

	agentServers, err := store.ListAgentServers(ctx)
	require.NoError(t, err)
	require.Equal(t, methods.ACPAgentServerConfig{
		Type:    "registry",
		Command: "npx",
		Args:    []string{"-y", "@zed-industries/codex-acp@0.16.0"},
		DefaultConfigOptions: map[string]string{
			"mode": "full-access",
		},
	}, agentServers["codex-acp"])

	data, err := os.ReadFile(assistantRegistryInstallsPath(path))
	require.NoError(t, err)
	require.Contains(t, string(data), `"codex-acp"`)
	require.Contains(t, string(data), `"command": "npx"`)
}

func TestAssistantConfigAgentServerStoreRepairResolvesWithoutHoldingLock(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "poolside", "assistant.json")
	store := NewAssistantConfigAgentServerStore(path)

	require.NoError(t, store.SetAgentServers(ctx, methods.ACPAgentServers{
		"codex-acp": {Type: "registry"},
	}, nil, nil))

	require.NoError(t, store.RepairInstalledRegistryAgentServers(ctx, func(ctx context.Context, name string) (methods.ACPAgentServerConfig, error) {
		_, err := store.ListAgentServers(ctx)
		require.NoError(t, err)
		if name != "codex-acp" {
			return methods.ACPAgentServerConfig{}, nil
		}
		return methods.ACPAgentServerConfig{
			Type:    "registry",
			Command: "npx",
			Args:    []string{"-y", "@zed-industries/codex-acp@0.16.0"},
		}, nil
	}))

	agentServers, err := store.ListAgentServers(ctx)
	require.NoError(t, err)
	require.Equal(t, "npx", agentServers["codex-acp"].Command)
}

func TestAssistantConfigAgentServerStoreRepairsInstalledRegistryBinary(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	t.Setenv("HOME", filepath.Join(dir, "home"))
	t.Setenv("XDG_CACHE_HOME", filepath.Join(dir, "cache"))
	path := filepath.Join(dir, "poolside", "assistant.json")
	store := NewAssistantConfigAgentServerStore(path)

	target, err := acpregistry.BinaryTarget(runtime.GOOS, runtime.GOARCH)
	require.NoError(t, err)
	archive := "https://example.com/poolside-binary.tgz"
	resolved := methods.ACPAgentServerConfig{
		Type: "registry",
		Binary: map[string]methods.ACPAgentServerBinaryDistribution{
			target: {
				Archive: archive,
				Cmd:     "./camber-acp",
				Args:    []string{"serve"},
			},
		},
	}
	root, err := acpregistry.BinaryInstallRoot("poolside", archive, "")
	require.NoError(t, err)
	require.NoError(t, os.MkdirAll(root, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(root, "camber-acp"), []byte("#!/bin/sh\n"), 0o755))

	require.NoError(t, store.SetAgentServers(ctx, methods.ACPAgentServers{"poolside": {Type: "registry"}}, nil, nil))
	require.NoError(t, store.RepairInstalledRegistryAgentServers(ctx, func(context.Context, string) (methods.ACPAgentServerConfig, error) {
		return resolved, nil
	}))

	agentServers, err := store.ListAgentServers(ctx)
	require.NoError(t, err)
	require.Equal(t, resolved, agentServers["poolside"])
}

func TestAssistantConfigAgentServerStoreRepairsImplicitCamberRegistryBinary(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	t.Setenv("HOME", filepath.Join(dir, "home"))
	t.Setenv("XDG_CACHE_HOME", filepath.Join(dir, "cache"))
	path := filepath.Join(dir, "poolside", "assistant.json")
	store := NewAssistantConfigAgentServerStore(path)

	target, err := acpregistry.BinaryTarget(runtime.GOOS, runtime.GOARCH)
	require.NoError(t, err)
	archive := "https://example.com/poolside-binary.tgz"
	resolved := methods.ACPAgentServerConfig{
		Type: "registry",
		Binary: map[string]methods.ACPAgentServerBinaryDistribution{
			target: {
				Archive: archive,
				Cmd:     "./camber-acp",
				Args:    []string{"serve"},
			},
		},
	}
	root, err := acpregistry.BinaryInstallRoot("poolside", archive, "")
	require.NoError(t, err)
	require.NoError(t, os.MkdirAll(root, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(root, "camber-acp"), []byte("#!/bin/sh\n"), 0o755))

	require.NoError(t, store.SetAgentServers(ctx, methods.ACPAgentServers{"claude": {Command: "npx"}}, nil, nil))
	require.NoError(t, store.RepairInstalledRegistryAgentServers(ctx, func(_ context.Context, name string) (methods.ACPAgentServerConfig, error) {
		require.Equal(t, "poolside", name)
		return resolved, nil
	}))

	data, err := os.ReadFile(assistantRegistryInstallsPath(path))
	require.NoError(t, err)
	require.Contains(t, string(data), `"poolside"`)
	require.Contains(t, string(data), `"archive": "https://example.com/poolside-binary.tgz"`)
}

func TestAssistantConfigAgentServerStoreDoesNotRepairCustomCamber(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "poolside", "assistant.json")
	store := NewAssistantConfigAgentServerStore(path)

	require.NoError(t, store.SetAgentServers(ctx, methods.ACPAgentServers{"poolside": {Command: "custom-pool"}}, nil, nil))
	require.NoError(t, store.RepairInstalledRegistryAgentServers(ctx, func(context.Context, string) (methods.ACPAgentServerConfig, error) {
		t.Fatal("custom camber should not be repaired as a registry agent server")
		return methods.ACPAgentServerConfig{}, nil
	}))

	_, err := os.Stat(assistantRegistryInstallsPath(path))
	require.ErrorIs(t, err, os.ErrNotExist)
}

func TestAssistantConfigAgentServerStoreRepairSkipsMissingRegistryBinary(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	t.Setenv("HOME", filepath.Join(dir, "home"))
	t.Setenv("XDG_CACHE_HOME", filepath.Join(dir, "cache"))
	path := filepath.Join(dir, "poolside", "assistant.json")
	store := NewAssistantConfigAgentServerStore(path)

	target, err := acpregistry.BinaryTarget(runtime.GOOS, runtime.GOARCH)
	require.NoError(t, err)
	require.NoError(t, store.SetAgentServers(ctx, methods.ACPAgentServers{"poolside": {Type: "registry"}}, nil, nil))
	require.NoError(t, store.RepairInstalledRegistryAgentServers(ctx, func(context.Context, string) (methods.ACPAgentServerConfig, error) {
		return methods.ACPAgentServerConfig{
			Type: "registry",
			Binary: map[string]methods.ACPAgentServerBinaryDistribution{
				target: {
					Archive: "https://example.com/poolside-binary.tgz",
					Cmd:     "./camber-acp",
				},
			},
		}, nil
	}))

	agentServers, err := store.ListAgentServers(ctx)
	require.NoError(t, err)
	require.Equal(t, methods.ACPAgentServerConfig{Type: "registry"}, agentServers["poolside"])
	_, err = os.Stat(assistantRegistryInstallsPath(path))
	require.ErrorIs(t, err, os.ErrNotExist)
}

func TestAssistantConfigAgentServerStoreSeedAgentServersIfNeeded(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "poolside", "assistant.json")
	store := NewAssistantConfigAgentServerStore(path)

	require.NoError(t, store.SeedAgentServersIfNeeded(ctx, methods.ACPAgentServers{
		"claude": {Command: "npx"},
	}))
	require.NoError(t, store.SeedAgentServersIfNeeded(ctx, methods.ACPAgentServers{
		"gemini": {Command: "node"},
	}))

	agentServers, err := store.ListAgentServers(ctx)
	require.NoError(t, err)
	require.Contains(t, agentServers, "claude")
	require.NotContains(t, agentServers, "gemini")
}

func TestAssistantConfigAgentServerStoreMigratesFromDB(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	dbStore, err := Open(ctx, filepath.Join(dir, "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, dbStore.Close()) })

	defaultAgentServer := "claude"
	require.NoError(t, dbStore.SetAgentServers(ctx, methods.ACPAgentServers{
		"claude": {Command: "npx"},
		"poolside": {
			Command: "{{SELF}}",
			DefaultConfigOptions: map[string]string{
				"mode": "auto",
			},
		},
	}, &defaultAgentServer, nil))

	assistantConfigPath := filepath.Join(dir, "poolside", "assistant.json")
	store := NewAssistantConfigAgentServerStore(assistantConfigPath)
	require.NoError(t, store.MigrateFromDB(ctx, dbStore))

	agentServers, err := store.ListAgentServers(ctx)
	require.NoError(t, err)
	require.Equal(t, methods.ACPAgentServerConfig{Type: "custom", Command: "npx"}, agentServers["claude"])
	require.Equal(t, methods.ACPAgentServerConfig{
		Type:    "custom",
		Command: "{{SELF}}",
		DefaultConfigOptions: map[string]string{
			"mode": "auto",
		},
	}, agentServers["poolside"])
	gotDefault, err := store.GetDefaultAgentServer(ctx)
	require.NoError(t, err)
	require.Equal(t, "claude", gotDefault)

	data, err := os.ReadFile(assistantConfigPath)
	require.NoError(t, err)
	require.Contains(t, string(data), `"command": "{{SELF}}"`)

	dbAgentServers, err := dbStore.ListAgentServers(ctx)
	require.NoError(t, err)
	require.Empty(t, dbAgentServers)
}

func TestAssistantConfigAgentServerStoreMigratesFromDBWithoutOverwritingAssistantConfig(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	dbStore, err := Open(ctx, filepath.Join(dir, "acpnav.db"))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, dbStore.Close()) })

	dbDefaultAgentServer := "claude"
	require.NoError(t, dbStore.SetAgentServers(ctx, methods.ACPAgentServers{
		"claude": {Command: "npx"},
		"gemini": {Command: "node-from-db"},
	}, &dbDefaultAgentServer, nil))

	assistantConfigPath := filepath.Join(dir, "poolside", "assistant.json")
	store := NewAssistantConfigAgentServerStore(assistantConfigPath)
	poolDefaultAgentServer := "gemini"
	require.NoError(t, store.SetAgentServers(ctx, methods.ACPAgentServers{
		"gemini":    {Command: "node-from-pool"},
		"codex-acp": {Type: "registry"},
	}, &poolDefaultAgentServer, nil))
	require.NoError(t, store.MigrateFromDB(ctx, dbStore))

	agentServers, err := store.ListAgentServers(ctx)
	require.NoError(t, err)
	require.Equal(t, methods.ACPAgentServerConfig{Type: "custom", Command: "npx"}, agentServers["claude"])
	require.Equal(t, methods.ACPAgentServerConfig{Type: "custom", Command: "node-from-pool"}, agentServers["gemini"])
	require.Equal(t, methods.ACPAgentServerConfig{
		Type: "registry",
	}, agentServers["codex-acp"])
	gotDefault, err := store.GetDefaultAgentServer(ctx)
	require.NoError(t, err)
	require.Equal(t, "gemini", gotDefault)

	data, err := os.ReadFile(assistantConfigPath)
	require.NoError(t, err)
	require.Contains(t, string(data), `"codex-acp"`)
	require.Contains(t, string(data), `"type": "registry"`)

	dbAgentServers, err := dbStore.ListAgentServers(ctx)
	require.NoError(t, err)
	require.Empty(t, dbAgentServers)
}
