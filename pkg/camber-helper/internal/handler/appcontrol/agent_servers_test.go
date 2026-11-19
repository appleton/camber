package appcontrol

import (
	"context"
	"fmt"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

func TestSetDefaultAgentServerPinsUnpinsAndFollows(t *testing.T) {
	ctx := context.Background()
	store := newFakeAgentServerStore()
	a := NewAgentServers(store.surface(), nil)

	out, err := a.SetDefaultAgentServer(ctx, &methods.AppSetDefaultAgentServerParams{AgentServer: "codex", Pinned: ptr(true)}, nil)
	require.NoError(t, err)
	assert.True(t, out.Applied)
	assert.Equal(t, "codex", out.State.DefaultAgentServer)
	assert.True(t, out.State.DefaultAgentServerPinned)

	// A last-used follow never moves a pinned default.
	out, err = a.SetDefaultAgentServer(ctx, &methods.AppSetDefaultAgentServerParams{AgentServer: "custom"}, nil)
	require.NoError(t, err)
	assert.False(t, out.Applied)
	assert.Equal(t, "codex", out.State.DefaultAgentServer)
	assert.Equal(t, 1, store.sets)

	// Unpinning keeps the default; the follow then moves it, keeping the pin off.
	out, err = a.SetDefaultAgentServer(ctx, &methods.AppSetDefaultAgentServerParams{Pinned: ptr(false)}, nil)
	require.NoError(t, err)
	assert.Equal(t, "codex", out.State.DefaultAgentServer)
	assert.False(t, out.State.DefaultAgentServerPinned)
	out, err = a.SetDefaultAgentServer(ctx, &methods.AppSetDefaultAgentServerParams{AgentServer: "custom"}, nil)
	require.NoError(t, err)
	assert.True(t, out.Applied)
	assert.Equal(t, "custom", out.State.DefaultAgentServer)
	assert.False(t, out.State.DefaultAgentServerPinned)

	// The legacy id is the built-in agent, which counts as configured.
	out, err = a.SetDefaultAgentServer(ctx, &methods.AppSetDefaultAgentServerParams{AgentServer: "default", Pinned: ptr(true)}, nil)
	require.NoError(t, err)
	assert.Equal(t, "poolside", out.State.DefaultAgentServer)

	_, err = a.SetDefaultAgentServer(ctx, &methods.AppSetDefaultAgentServerParams{AgentServer: "nope", Pinned: ptr(true)}, nil)
	require.ErrorContains(t, err, "not configured")
	_, err = a.SetDefaultAgentServer(ctx, &methods.AppSetDefaultAgentServerParams{Pinned: ptr(true)}, nil)
	require.Error(t, err)
}

func TestSetAgentDefaultConfigOptionPinsInOneWrite(t *testing.T) {
	ctx := context.Background()
	store := newFakeAgentServerStore()
	a := NewAgentServers(store.surface(), nil)

	out, err := a.SetAgentDefaultConfigOption(ctx, &methods.AppSetAgentDefaultConfigOptionParams{AgentServer: "custom", OptionID: "mode", Value: "plan", Pinned: ptr(true)}, nil)
	require.NoError(t, err)
	assert.True(t, out.Applied)
	assert.Equal(t, 1, store.sets, "value and pin land in one write")
	cfg := store.config("custom")
	assert.Equal(t, map[string]string{"model": "big", "mode": "plan"}, cfg.DefaultConfigOptions)
	assert.Equal(t, []string{"mode"}, cfg.PinnedConfigOptions)
	assert.Equal(t, "custom-acp", cfg.Command, "the rest of the entry is untouched")

	// A last-used follow skips the pinned key but writes unpinned ones.
	out, err = a.SetAgentDefaultConfigOption(ctx, &methods.AppSetAgentDefaultConfigOptionParams{AgentServer: "custom", OptionID: "mode", Value: "auto"}, nil)
	require.NoError(t, err)
	assert.False(t, out.Applied)
	assert.Equal(t, "plan", out.State.AgentServers["custom"].DefaultConfigOptions["mode"])
	out, err = a.SetAgentDefaultConfigOption(ctx, &methods.AppSetAgentDefaultConfigOptionParams{AgentServer: "custom", OptionID: "model", Value: "small"}, nil)
	require.NoError(t, err)
	assert.True(t, out.Applied)
	assert.Equal(t, "small", store.config("custom").DefaultConfigOptions["model"])
	assert.Equal(t, []string{"mode"}, store.config("custom").PinnedConfigOptions)

	// Unpin keeps the value unless asked to clear it; emptied lists are dropped.
	_, err = a.SetAgentDefaultConfigOption(ctx, &methods.AppSetAgentDefaultConfigOptionParams{AgentServer: "custom", OptionID: "mode", Pinned: ptr(false)}, nil)
	require.NoError(t, err)
	assert.Equal(t, "plan", store.config("custom").DefaultConfigOptions["mode"])
	assert.Nil(t, store.config("custom").PinnedConfigOptions)
	_, err = a.SetAgentDefaultConfigOption(ctx, &methods.AppSetAgentDefaultConfigOptionParams{AgentServer: "custom", OptionID: "mode", Pinned: ptr(false), ClearValue: true}, nil)
	require.NoError(t, err)
	assert.Equal(t, map[string]string{"model": "small"}, store.config("custom").DefaultConfigOptions)

	// The built-in agent gets an entry on demand; an unknown agent is skipped.
	out, err = a.SetAgentDefaultConfigOption(ctx, &methods.AppSetAgentDefaultConfigOptionParams{AgentServer: "", OptionID: "model", Value: "m", Pinned: ptr(true)}, nil)
	require.NoError(t, err)
	assert.True(t, out.Applied)
	assert.Equal(t, map[string]string{"model": "m"}, store.config("poolside").DefaultConfigOptions)
	sets := store.sets
	out, err = a.SetAgentDefaultConfigOption(ctx, &methods.AppSetAgentDefaultConfigOptionParams{AgentServer: "gone", OptionID: "model", Value: "m", Pinned: ptr(true)}, nil)
	require.NoError(t, err)
	assert.False(t, out.Applied)
	assert.Equal(t, sets, store.sets)

	_, err = a.SetAgentDefaultConfigOption(ctx, &methods.AppSetAgentDefaultConfigOptionParams{AgentServer: "custom", OptionID: "mode", Value: "x", Pinned: ptr(false)}, nil)
	require.Error(t, err)
	_, err = a.SetAgentDefaultConfigOption(ctx, &methods.AppSetAgentDefaultConfigOptionParams{AgentServer: "custom", OptionID: "mode", Value: "x", ClearValue: true}, nil)
	require.Error(t, err)
}

func TestInstallAgentServerUsesGivenOrRegistryConfig(t *testing.T) {
	ctx := context.Background()
	store := newFakeAgentServerStore()
	a := NewAgentServers(store.surface(), nil)

	given := methods.ACPAgentServerConfig{Type: "registry", Command: "given-acp"}
	out, err := a.InstallAgentServer(ctx, &methods.AppInstallAgentServerParams{AgentServer: "given", Config: &given}, nil)
	require.NoError(t, err)
	assert.Equal(t, given, out.Config)
	assert.Equal(t, given, out.State.AgentServers["given"])

	out, err = a.InstallAgentServer(ctx, &methods.AppInstallAgentServerParams{AgentServer: "gemini"}, nil)
	require.NoError(t, err)
	assert.Equal(t, "registry", out.Config.Type)
	assert.Equal(t, "gemini-acp", store.config("gemini").Command)
	assert.Equal(t, []string{"given", "gemini"}, store.installed)
	assert.Equal(t, map[string]string{"model": "big"}, store.config("custom").DefaultConfigOptions, "other entries keep their stored defaults")

	_, err = a.InstallAgentServer(ctx, &methods.AppInstallAgentServerParams{AgentServer: "gemini"}, nil)
	require.ErrorIs(t, err, ErrAgentServerExists)
}

func TestRemoveAgentServerArchivesItsConversations(t *testing.T) {
	ctx := context.Background()
	nav := navFixture(t, "p", "c")
	link(t, nav, "c", "p")
	_, err := nav.UpsertConversation(ctx, &methods.ACPNavUpsertConversationParams{Conversation: methods.ACPNavConversation{ID: "keep", WorkspacePath: "/ws", Cwd: "/ws", AgentServer: "custom", SessionID: "s-keep", UpdatedAt: "2026-01-01T00:00:00Z"}}, nil)
	require.NoError(t, err)
	store := newFakeAgentServerStore()
	store.state.AgentServers["agent"] = methods.ACPAgentServerConfig{Command: "agent-acp"}
	agent := &recordingAgent{}
	a := NewAgentServers(store.surface(), New(nav, agent))

	out, err := a.RemoveAgentServer(ctx, &methods.AppRemoveAgentServerParams{AgentServer: "agent"}, nil)
	require.NoError(t, err)
	assert.NotContains(t, out.State.AgentServers, "agent")
	assert.NotContains(t, store.state.AgentServers, "agent")
	assert.Empty(t, out.ArchiveError)
	assert.ElementsMatch(t, []methods.AppArchivedConversation{
		{ConversationID: "p", AgentServer: "agent", SessionID: "s-p"},
		{ConversationID: "c", AgentServer: "agent", SessionID: "s-c"},
	}, out.Archived)
	require.NotNil(t, out.NavState)
	assert.Equal(t, map[string]bool{"p": true, "c": true, "keep": false}, archived(t, nav))
	agent.mu.Lock()
	require.NotEmpty(t, agent.closed)
	assert.True(t, agent.closed[0].CancelInFlight)
	agent.mu.Unlock()

	_, err = a.RemoveAgentServer(ctx, &methods.AppRemoveAgentServerParams{AgentServer: "agent"}, nil)
	require.ErrorContains(t, err, "not configured")
}

// Every mutation re-reads and rewrites the whole map, so without the lock
// concurrent writers would drop each other's changes.
func TestAgentServerMutationsSerialize(t *testing.T) {
	ctx := context.Background()
	store := newFakeAgentServerStore()
	a := NewAgentServers(store.surface(), nil)

	var wg sync.WaitGroup
	for i := range 20 {
		wg.Add(1)
		go func(optionID string) {
			defer wg.Done()
			_, err := a.SetAgentDefaultConfigOption(ctx, &methods.AppSetAgentDefaultConfigOptionParams{AgentServer: "custom", OptionID: optionID, Value: "v"}, nil)
			assert.NoError(t, err)
		}(fmt.Sprintf("opt-%d", i))
	}
	wg.Wait()
	assert.Len(t, store.config("custom").DefaultConfigOptions, 21)
}

// fakeAgentServerStore stands in for the handler's agent server methods.
// List and Set are separate calls, so unserialized edits would race.
type fakeAgentServerStore struct {
	mu        sync.Mutex
	state     methods.ACPNavAgentServersState
	installed []string
	sets      int
}

func newFakeAgentServerStore() *fakeAgentServerStore {
	return &fakeAgentServerStore{state: methods.ACPNavAgentServersState{
		DefaultAgentServer: "poolside",
		AgentServers: methods.ACPAgentServers{
			"codex":  {Type: "registry", Command: "codex-acp"},
			"custom": {Type: "custom", Command: "custom-acp", DefaultConfigOptions: map[string]string{"model": "big"}},
		},
	}}
}

func (f *fakeAgentServerStore) surface() AgentServerStore {
	return AgentServerStore{
		List: func(context.Context, *methods.ACPNavListAgentServersParams, *glsp.Context) (methods.ACPNavAgentServersState, error) {
			f.mu.Lock()
			defer f.mu.Unlock()
			return cloneAgentServersState(f.state), nil
		},
		Set: func(_ context.Context, p *methods.ACPNavSetAgentServersParams, _ *glsp.Context) (methods.ACPNavAgentServersState, error) {
			f.mu.Lock()
			defer f.mu.Unlock()
			f.sets++
			f.state.AgentServers = p.AgentServers
			if p.DefaultAgentServer != nil {
				f.state.DefaultAgentServer = *p.DefaultAgentServer
			}
			if p.DefaultAgentServerPinned != nil {
				f.state.DefaultAgentServerPinned = *p.DefaultAgentServerPinned
			}
			return cloneAgentServersState(f.state), nil
		},
		Install: func(_ context.Context, p *methods.ACPNavInstallAgentServerParams, _ *glsp.Context) (methods.ACPNavInstallAgentServerOutput, error) {
			f.mu.Lock()
			defer f.mu.Unlock()
			f.installed = append(f.installed, p.AgentServer)
			return methods.ACPNavInstallAgentServerOutput{Installed: true}, nil
		},
		ResolveRegistry: func(_ context.Context, name string) (methods.ACPAgentServerConfig, error) {
			return methods.ACPAgentServerConfig{Command: name + "-acp"}, nil
		},
	}
}

func (f *fakeAgentServerStore) config(name string) methods.ACPAgentServerConfig {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.state.AgentServers[name]
}

func cloneAgentServersState(state methods.ACPNavAgentServersState) methods.ACPNavAgentServersState {
	out := state
	out.AgentServers = methods.ACPAgentServers{}
	for name, cfg := range state.AgentServers {
		out.AgentServers[name] = cfg
	}
	return out
}

func ptr[T any](v T) *T {
	return &v
}
