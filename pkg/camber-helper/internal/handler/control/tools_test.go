package control

import (
	"context"
	"encoding/json"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/camber-helper/internal/handler/acpnav"
	"github.com/appleton/camber/pkg/camber-helper/internal/handler/appcontrol"
	"github.com/appleton/camber/pkg/camber-helper/methods"
)

func TestAgentsInstallNeedsLiveBypassCallerAndKeepsOtherEntries(t *testing.T) {
	s, _ := tokenFixture(t, "", true)
	store := newFakeAgentStore()
	s.SetTools(Tools{AgentServers: store.tools(s)})

	_, err := dispatchTool(s, "", "agents.install", map[string]any{"agentServer": "gemini"})
	require.Error(t, err)
	assert.True(t, isPermissionEscalation(err), err.Error())
	_, err = dispatchTool(s, "tok-other", "agents.install", map[string]any{"agentServer": "gemini"})
	require.Error(t, err)
	assert.True(t, isPermissionEscalation(err))
	assert.Empty(t, store.installed)
	assert.Zero(t, store.sets)

	out, err := dispatchTool(s, "tok-parent", "agents.install", map[string]any{"agentServer": "gemini"})
	require.NoError(t, err)
	assert.Equal(t, true, out["installed"])
	assert.Equal(t, []string{"gemini"}, store.installed)
	saved := store.state.AgentServers
	assert.Equal(t, "registry", saved["gemini"].Type)
	assert.Equal(t, map[string]string{"model": "big"}, saved["custom-a"].DefaultConfigOptions, "other entries keep their stored defaults")
	agent := out["agent"].(map[string]any)
	assert.Equal(t, map[string]any{"GEMINI_KEY": "[set]"}, agent["env"])

	_, err = dispatchTool(s, "tok-parent", "agents.install", map[string]any{"agentServer": "gemini"})
	require.ErrorContains(t, err, "already installed")
	_, err = dispatchTool(s, "tok-parent", "agents.install", map[string]any{"agentServer": "poolside"})
	require.ErrorContains(t, err, "managed by the app")
}

func TestAgentsAddEditRemoveCustomAgent(t *testing.T) {
	s, agent := tokenFixture(t, "", true)
	store := newFakeAgentStore()
	s.SetTools(Tools{AgentServers: store.tools(s)})

	_, err := dispatchTool(s, "", "agents.add", map[string]any{"agentServer": "mine", "command": "my-acp"})
	require.True(t, isPermissionEscalation(err))

	out, err := dispatchTool(s, "tok-parent", "agents.add", map[string]any{"agentServer": "mine", "command": "my-acp", "args": []string{"--acp"}, "env": map[string]string{"TOKEN": "s3cret", "MODE": "x"}})
	require.NoError(t, err)
	raw, _ := json.Marshal(out)
	assert.NotContains(t, string(raw), "s3cret")
	assert.Equal(t, "custom", store.state.AgentServers["mine"].Type)
	assert.Equal(t, "s3cret", store.state.AgentServers["mine"].Env["TOKEN"])

	_, err = dispatchTool(s, "tok-parent", "agents.edit", map[string]any{"agentServer": "mine", "unsetEnv": []string{"MODE"}, "args": []string{}})
	require.NoError(t, err)
	assert.Equal(t, map[string]string{"TOKEN": "s3cret"}, store.state.AgentServers["mine"].Env)
	assert.Empty(t, store.state.AgentServers["mine"].Args)
	_, err = dispatchTool(s, "tok-parent", "agents.edit", map[string]any{"agentServer": "reg", "command": "x"})
	require.ErrorContains(t, err, "only custom agents")

	ctx := context.Background()
	_, err = s.nav.UpsertConversation(ctx, &methods.ACPNavUpsertConversationParams{Conversation: methods.ACPNavConversation{ID: "mine-chat", AgentServer: "mine", SessionID: "mine-session", WorkspacePath: t.TempDir(), Cwd: t.TempDir()}}, nil)
	require.NoError(t, err)
	_, err = dispatchTool(s, "", "agents.remove", map[string]any{"agentServer": "mine"})
	require.True(t, isPermissionEscalation(err))
	out, err = dispatchTool(s, "tok-parent", "agents.remove", map[string]any{"agentServer": "mine"})
	require.NoError(t, err)
	assert.Equal(t, []any{"mine-chat"}, out["archivedConversations"])
	assert.NotContains(t, store.state.AgentServers, "mine")
	archived, err := s.view(ctx, "mine-chat", nil)
	require.NoError(t, err)
	assert.True(t, archived.Archived)
	assert.Contains(t, agent.callList(), "close:cancel")
	_, err = dispatchTool(s, "tok-parent", "agents.remove", map[string]any{"agentServer": "poolside"})
	require.ErrorContains(t, err, "managed by the app")
}

func TestAgentsDefaultsAndBypassDefaultOption(t *testing.T) {
	s, _ := tokenFixture(t, "", true)
	store := newFakeAgentStore()
	s.SetTools(Tools{AgentServers: store.tools(s)})
	_, err := s.nav.UpsertConfigCache(context.Background(), &methods.ACPNavUpsertConfigCacheParams{AgentServer: "custom-a", ConfigOptions: json.RawMessage(opaqueOptions)}, nil)
	require.NoError(t, err)

	out, err := dispatchTool(s, "", "agents.default", map[string]any{"agentServer": "custom-a"})
	require.NoError(t, err)
	assert.Equal(t, "custom-a", out["defaultAgentServer"])
	assert.True(t, store.state.DefaultAgentServerPinned)
	_, err = dispatchTool(s, "", "agents.default", map[string]any{"unpin": true})
	require.NoError(t, err)
	assert.False(t, store.state.DefaultAgentServerPinned)
	assert.Equal(t, "custom-a", store.state.DefaultAgentServer)

	// Judged by display name: the opaque value is labelled "Full access".
	_, err = dispatchTool(s, "", "agents.config.default", map[string]any{"agentServer": "custom-a", "optionId": "mode", "value": "danger-full-access"})
	require.True(t, isPermissionEscalation(err))
	_, err = dispatchTool(s, "", "agents.config.default", map[string]any{"agentServer": "custom-a", "optionId": "mode", "value": "made-up"})
	require.ErrorContains(t, err, "unsupported value")
	_, err = dispatchTool(s, "", "agents.config.default", map[string]any{"agentServer": "custom-a", "optionId": "mode", "value": "read-only"})
	require.NoError(t, err)
	assert.Equal(t, "read-only", store.state.AgentServers["custom-a"].DefaultConfigOptions["mode"])
	assert.Equal(t, []string{"mode"}, store.state.AgentServers["custom-a"].PinnedConfigOptions)
	_, err = dispatchTool(s, "tok-parent", "agents.config.default", map[string]any{"agentServer": "custom-a", "optionId": "mode", "value": "danger-full-access"})
	require.NoError(t, err)
	assert.Equal(t, "danger-full-access", store.state.AgentServers["custom-a"].DefaultConfigOptions["mode"])

	_, err = dispatchTool(s, "", "agents.config.default", map[string]any{"agentServer": "custom-a", "optionId": "mode", "unpin": true, "clearValue": true})
	require.NoError(t, err)
	assert.Equal(t, map[string]string{"model": "big"}, store.state.AgentServers["custom-a"].DefaultConfigOptions)
	assert.Nil(t, store.state.AgentServers["custom-a"].PinnedConfigOptions)
}

func TestAgentsRestartWaitsForWorkingConversations(t *testing.T) {
	s, _ := tokenFixture(t, "", false)
	store := newFakeAgentStore()
	s.SetTools(Tools{AgentServers: store.tools(s)})
	ctx := context.Background()
	_, err := s.nav.UpsertConversation(ctx, &methods.ACPNavUpsertConversationParams{Conversation: methods.ACPNavConversation{ID: "busy", AgentServer: "custom-a", SessionID: "busy-session", WorkspacePath: t.TempDir(), Cwd: t.TempDir()}}, nil)
	require.NoError(t, err)
	require.NoError(t, s.nav.SetConversationLiveStatus(ctx, nil, "custom-a", "busy-session", acpnav.ConversationLiveStatusPatch{Working: acpnav.Bool(true)}))

	_, err = dispatchTool(s, "", "agents.restart", map[string]any{"agentServer": "custom-a"})
	require.ErrorContains(t, err, "working conversations")
	assert.Empty(t, store.restarted)
	_, err = dispatchTool(s, "", "agents.restart", map[string]any{"agentServer": "custom-a", "force": true})
	require.NoError(t, err)
	assert.Equal(t, []string{"custom-a"}, store.restarted)
	_, err = dispatchTool(s, "", "agents.restart", map[string]any{"agentServer": "nope"})
	require.ErrorContains(t, err, "not configured")
}

func TestMCPActionsRedactAndGuard(t *testing.T) {
	s, _ := tokenFixture(t, "", true)
	mcp := &fakeMCP{servers: []methods.MCPServerEntry{
		{Name: "files", Enabled: true, Command: "files-mcp", Env: map[string]string{"API_KEY": "s3cret"}},
		{Name: "remote", Enabled: true, URL: "https://example.test/mcp", AuthMode: "bearer", BearerToken: "tok3n", Headers: map[string]string{"X-Key": "h3ader"}},
	}, test: methods.MCPServersTestConnectionOutput{OK: true, ToolCount: 2}}
	s.SetTools(Tools{MCPServers: mcp})

	out, err := dispatchTool(s, "", "mcp.list", nil)
	require.NoError(t, err)
	raw, _ := json.Marshal(out)
	for _, secret := range []string{"s3cret", "tok3n", "h3ader"} {
		assert.NotContains(t, string(raw), secret)
	}
	assert.Contains(t, string(raw), `"API_KEY":"[set]"`)

	add := map[string]any{"name": "new-one", "command": "npx", "args": []string{"x"}, "env": map[string]string{"K": "v4lue"}}
	_, err = dispatchTool(s, "", "mcp.add", add)
	require.True(t, isPermissionEscalation(err))
	assert.Zero(t, mcp.probes, "nothing runs before the guard")

	mcp.test = methods.MCPServersTestConnectionOutput{OK: false, Error: "boom"}
	_, err = dispatchTool(s, "tok-parent", "mcp.add", add)
	require.ErrorContains(t, err, "connection test failed: boom")
	assert.Len(t, mcp.servers, 2)
	add["skipTest"] = true
	out, err = dispatchTool(s, "tok-parent", "mcp.add", add)
	require.NoError(t, err)
	raw, _ = json.Marshal(out)
	assert.NotContains(t, string(raw), "v4lue")
	require.Len(t, mcp.servers, 3)
	_, err = dispatchTool(s, "tok-parent", "mcp.add", map[string]any{"name": "bad name", "command": "x"})
	require.ErrorContains(t, err, "letters, digits")

	_, err = dispatchTool(s, "tok-parent", "mcp.edit", map[string]any{"name": "remote", "headers": map[string]string{"X-Other": "o"}})
	require.NoError(t, err)
	remote := mcp.find("remote")
	assert.Equal(t, "tok3n", remote.BearerToken, "stored secrets survive an edit")
	assert.Equal(t, map[string]string{"X-Key": "h3ader", "X-Other": "o"}, remote.Headers)

	_, err = dispatchTool(s, "", "mcp.disable", map[string]any{"name": "files"})
	require.NoError(t, err)
	assert.False(t, mcp.find("files").Enabled)
	_, err = dispatchTool(s, "", "mcp.test", map[string]any{"name": "files"})
	require.NoError(t, err)
	_, err = dispatchTool(s, "", "mcp.remove", map[string]any{"name": "files"})
	require.True(t, isPermissionEscalation(err))
	_, err = dispatchTool(s, "tok-parent", "mcp.remove", map[string]any{"name": "files"})
	require.NoError(t, err)
	assert.Empty(t, mcp.find("files").Name)

	_, err = dispatchTool(s, "", "mcp.signIn", map[string]any{"name": "remote"})
	require.True(t, isPermissionEscalation(err))
	_, err = dispatchTool(s, "tok-parent", "mcp.signIn", map[string]any{"name": "remote"})
	require.ErrorContains(t, err, "does not use OAuth")
	_, err = dispatchTool(s, "", "mcp.signOut", map[string]any{"name": "remote"})
	require.NoError(t, err)
}

func TestSkillsListMergesAgentPublishedSkills(t *testing.T) {
	s, _ := fixture(t)
	var gotWorkspaces []string
	s.SetTools(Tools{ListSkills: func(workspaces []string) []InstalledSkill {
		gotWorkspaces = workspaces
		return []InstalledSkill{{Name: "review", Description: "local", Location: "user", DirPath: "/home/u/.claude/skills/review"}, {Name: "deploy", Location: "workspace"}}
	}})
	_, err := s.nav.UpsertConfigCache(context.Background(), &methods.ACPNavUpsertConfigCacheParams{AgentServer: "test", AvailableCommands: json.RawMessage(`[{"name":"$review","description":"published"},{"name":"compact"},{"name":"plan","_meta":{"camber/slash_command_category":"skill"}}]`)}, nil)
	require.NoError(t, err)

	out, err := dispatchTool(s, "", "skills.list", map[string]any{"agentServer": "test"})
	require.NoError(t, err)
	assert.Nil(t, gotWorkspaces, "defaults to the desktop's workspace folders")
	raw, _ := json.Marshal(out["skills"])
	var skills []listedSkill
	require.NoError(t, json.Unmarshal(raw, &skills))
	require.Len(t, skills, 3)
	assert.Equal(t, listedSkill{Name: "deploy", Invocation: "$deploy", Source: "workspace"}, skills[0])
	assert.Equal(t, "plan", skills[1].Name)
	assert.Equal(t, listedSkill{Name: "review", Invocation: "$review", Description: "published", Source: "agent", AgentServer: "test"}, skills[2])

	_, err = dispatchTool(s, "", "skills.list", map[string]any{"workspacePath": t.TempDir()})
	require.ErrorContains(t, err, "not a registered project")
}

func TestToolsActionsWithoutBackendFailClearly(t *testing.T) {
	s, _ := fixture(t)
	for _, action := range []string{"agents.runtimes", "mcp.list", "skills.list"} {
		_, err := dispatchTool(s, "", action, nil)
		require.Error(t, err, action)
		assert.Contains(t, err.Error(), "not available", action)
	}
}

func dispatchTool(s *Service, token, command string, args any) (map[string]any, error) {
	var raw json.RawMessage
	if args != nil {
		raw, _ = json.Marshal(args)
	}
	result, err := s.Dispatch(context.Background(), &methods.ControlDispatchParams{Command: command, Args: raw, CallerToken: token}, nil)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	return out, json.Unmarshal(result, &out)
}

// fakeAgentStore stands in for the handler's agent server methods.
type fakeAgentStore struct {
	mu        sync.Mutex
	state     methods.ACPNavAgentServersState
	installed []string
	restarted []string
	sets      int
}

func newFakeAgentStore() *fakeAgentStore {
	return &fakeAgentStore{state: methods.ACPNavAgentServersState{
		DefaultAgentServer: "poolside",
		AgentServers: methods.ACPAgentServers{
			"poolside": {Type: "custom"},
			"custom-a": {Type: "custom", Command: "a-acp", DefaultConfigOptions: map[string]string{"model": "big"}},
			"reg":      {Type: "registry", Command: "npx"},
		},
	}}
}

// tools wires the fake store behind the shared agent-server mutations, as
// handler.controlTools does with the real handlers.
func (f *fakeAgentStore) tools(s *Service) AgentServerTools {
	list := func(context.Context, *methods.ACPNavListAgentServersParams, *glsp.Context) (methods.ACPNavAgentServersState, error) {
		f.mu.Lock()
		defer f.mu.Unlock()
		return cloneAgentState(f.state), nil
	}
	return AgentServerTools{
		List: list,
		CheckRuntimes: func(context.Context, *methods.ACPNavCheckAgentRuntimesParams, *glsp.Context) (methods.ACPNavAgentRuntimesState, error) {
			return methods.ACPNavAgentRuntimesState{NPX: methods.ACPNavAgentRuntimeStatus{Available: true}}, nil
		},
		Restart: func(_ context.Context, p *methods.ACPAgentServerParams, _ *glsp.Context) (*methods.ACPRestartServerOutput, error) {
			f.mu.Lock()
			defer f.mu.Unlock()
			f.restarted = append(f.restarted, p.AgentServer)
			return &methods.ACPRestartServerOutput{}, nil
		},
		Ops: appcontrol.NewAgentServers(appcontrol.AgentServerStore{
			List: list,
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
				return cloneAgentState(f.state), nil
			},
			Install: func(_ context.Context, p *methods.ACPNavInstallAgentServerParams, _ *glsp.Context) (methods.ACPNavInstallAgentServerOutput, error) {
				f.mu.Lock()
				defer f.mu.Unlock()
				f.installed = append(f.installed, p.AgentServer)
				return methods.ACPNavInstallAgentServerOutput{Installed: true}, nil
			},
			ResolveRegistry: func(_ context.Context, name string) (methods.ACPAgentServerConfig, error) {
				return methods.ACPAgentServerConfig{Type: "registry", Command: "npx", Args: []string{"-y", name + "-acp"}, Env: map[string]string{"GEMINI_KEY": "registry-default"}}, nil
			},
		}, appcontrol.New(s.nav, s.agent)),
	}
}

func cloneAgentState(state methods.ACPNavAgentServersState) methods.ACPNavAgentServersState {
	out := state
	out.AgentServers = methods.ACPAgentServers{}
	for name, cfg := range state.AgentServers {
		out.AgentServers[name] = cfg
	}
	return out
}

type fakeMCP struct {
	MCPServerTools
	servers []methods.MCPServerEntry
	test    methods.MCPServersTestConnectionOutput
	probes  int
}

func (f *fakeMCP) find(name string) methods.MCPServerEntry {
	for _, entry := range f.servers {
		if entry.Name == name {
			return entry
		}
	}
	return methods.MCPServerEntry{}
}

func (f *fakeMCP) List(context.Context, *methods.MCPServersListParams, *glsp.Context) (*methods.MCPServersListOutput, error) {
	return &methods.MCPServersListOutput{Servers: append([]methods.MCPServerEntry(nil), f.servers...)}, nil
}

func (f *fakeMCP) Upsert(_ context.Context, p *methods.MCPServersUpsertParams, _ *glsp.Context) (*methods.MCPServersUpsertOutput, error) {
	for i, entry := range f.servers {
		if entry.Name == p.Server.Name {
			f.servers[i] = p.Server
			return &methods.MCPServersUpsertOutput{}, nil
		}
	}
	f.servers = append(f.servers, p.Server)
	return &methods.MCPServersUpsertOutput{}, nil
}

func (f *fakeMCP) Delete(_ context.Context, p *methods.MCPServersDeleteParams, _ *glsp.Context) (*methods.MCPServersDeleteOutput, error) {
	kept := f.servers[:0]
	for _, entry := range f.servers {
		if entry.Name != p.Name {
			kept = append(kept, entry)
		}
	}
	f.servers = kept
	return &methods.MCPServersDeleteOutput{}, nil
}

func (f *fakeMCP) SetEnabled(_ context.Context, p *methods.MCPServersSetEnabledParams, _ *glsp.Context) (*methods.MCPServersSetEnabledOutput, error) {
	for i := range f.servers {
		if f.servers[i].Name == p.Name {
			f.servers[i].Enabled = p.Enabled
		}
	}
	return &methods.MCPServersSetEnabledOutput{}, nil
}

func (f *fakeMCP) SignOut(context.Context, *methods.MCPServersSignOutParams, *glsp.Context) (*methods.MCPServersSignOutOutput, error) {
	return &methods.MCPServersSignOutOutput{}, nil
}

func (f *fakeMCP) TestConnection(context.Context, *methods.MCPServersTestConnectionParams, *glsp.Context) (*methods.MCPServersTestConnectionOutput, error) {
	f.probes++
	out := f.test
	return &out, nil
}

func (f *fakeMCP) TestConfig(context.Context, *methods.MCPServersTestConfigParams, *glsp.Context) (*methods.MCPServersTestConfigOutput, error) {
	f.probes++
	out := methods.MCPServersTestConfigOutput(f.test)
	return &out, nil
}
