package control

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

const driftOptions = `[{"id":"model","type":"select","category":"model","currentValue":"small","options":[{"value":"small"},{"value":"large"}]},{"id":"mode","type":"select","category":"mode","currentValue":"code","options":[{"value":"code"},{"value":"plan"},{"value":"bypassPermissions"}]}]`
const driftModes = `{"currentModeId":"code","availableModes":[{"id":"code"},{"id":"plan"},{"id":"bypassPermissions"}]}`

// driftAgent exposes both a mode option and legacy modes, like claude-acp.
type driftAgent struct {
	*fakeAgent
	parentLive    bool
	parentOptions json.RawMessage
	parentModes   json.RawMessage
}

func (a *driftAgent) SessionConfiguration(_, session string) (json.RawMessage, json.RawMessage, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if session == "parent-session" && a.parentLive {
		if a.parentOptions != nil {
			return a.parentOptions, a.parentModes, true
		}
		return append(json.RawMessage(nil), a.options...), json.RawMessage(driftModes), true
	}
	return nil, nil, false
}

func (a *driftAgent) LoadSession(context.Context, *methods.ACPLoadSessionParams, *glsp.Context) (*methods.ACPLoadSessionOutput, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.calls = append(a.calls, "load")
	a.parentLive = true
	a.options = json.RawMessage(driftOptions)
	var out methods.ACPLoadSessionOutput
	raw, _ := json.Marshal(map[string]any{"configOptions": json.RawMessage(driftOptions), "modes": json.RawMessage(driftModes)})
	return &out, json.Unmarshal(raw, &out)
}

func driftFixture(t *testing.T, metadata string) (*Service, *driftAgent) {
	t.Helper()
	s, base := fixture(t)
	base.options = json.RawMessage(driftOptions)
	base.modes = driftModes
	agent := &driftAgent{fakeAgent: base}
	s.agent = agent
	v, err := s.view(context.Background(), "parent", nil)
	require.NoError(t, err)
	v.SessionID = "parent-session"
	v.Metadata = json.RawMessage(metadata)
	_, err = s.nav.UpsertConversation(context.Background(), &methods.ACPNavUpsertConversationParams{Conversation: v.ACPNavConversation}, nil)
	require.NoError(t, err)
	return s, agent
}

func dispatchErr(s *Service, command string, args Args) error {
	raw, _ := json.Marshal(args)
	_, err := s.Dispatch(context.Background(), &methods.ControlDispatchParams{Command: command, Args: raw}, nil)
	return err
}

func (a *driftAgent) callList() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string(nil), a.calls...)
}

func finishSpawn(t *testing.T, a *driftAgent) {
	t.Helper()
	select {
	case <-a.started:
	case <-time.After(time.Second):
		require.FailNow(t, "child did not start")
	}
	close(a.finish)
}

func childMode(t *testing.T, a *driftAgent) string {
	t.Helper()
	a.mu.Lock()
	defer a.mu.Unlock()
	var unquoted string
	require.NoError(t, json.Unmarshal([]byte(modeValue(t, a.options)), &unquoted))
	return unquoted
}

func TestConfigSetModeKeepsLegacyModeInSyncForSpawn(t *testing.T) {
	s, agent := driftFixture(t, `{"sessionConfig":{"selections":{"model":"small","mode":"code"},"modeId":"code"}}`)
	invoke(t, s, "chat.config.set", Args{ConversationID: "parent", Mode: "plan"})
	parent, err := s.view(context.Background(), "parent", nil)
	require.NoError(t, err)
	saved, found, err := savedConfiguration(parent.Metadata)
	require.NoError(t, err)
	require.True(t, found)
	assert.Equal(t, "plan", saved.Config["mode"])
	assert.Equal(t, "plan", saved.Mode)

	// Reviewer repro: spawn from that parent must not see conflicting values.
	agent.mu.Lock()
	agent.parentLive = false
	agent.mu.Unlock()
	invoke(t, s, "chat.spawn", Args{ParentID: "parent", Text: "task"})
	finishSpawn(t, agent)
	assert.Equal(t, "plan", childMode(t, agent))
}

func TestRestoreWithDriftedPersistedModePrefersOption(t *testing.T) {
	s, agent := driftFixture(t, `{"sessionConfig":{"selections":{"model":"small","mode":"plan"},"modeId":"code"}}`)
	out := invoke(t, s, "chat.config.list", Args{ConversationID: "parent"})
	assert.Equal(t, "plan", recoveryValues(mustJSON(t, out["configOptions"]))["mode"])
	assert.Contains(t, agent.callList(), "load")
	assert.Equal(t, "plan", out["modes"].(map[string]any)["currentModeId"])
}

func TestSpawnFromLiveParentWithDriftedCache(t *testing.T) {
	s, agent := driftFixture(t, `{}`)
	agent.parentLive = true
	agent.parentOptions = json.RawMessage(`[{"id":"model","type":"select","category":"model","currentValue":"small"},{"id":"mode","type":"select","category":"mode","currentValue":"plan"}]`)
	agent.parentModes = json.RawMessage(driftModes)
	invoke(t, s, "chat.spawn", Args{ParentID: "parent", Text: "task"})
	finishSpawn(t, agent)
	assert.Equal(t, "plan", childMode(t, agent))
}

func TestSpawnRejectsExplicitBypassFromSafeParent(t *testing.T) {
	for name, args := range map[string]Args{
		"mode flag":  {Mode: "bypassPermissions"},
		"config map": {Config: map[string]any{"mode": "bypassPermissions"}},
	} {
		t.Run(name, func(t *testing.T) {
			s, agent := driftFixture(t, `{"sessionConfig":{"selections":{"model":"small","mode":"code"},"modeId":"code"}}`)
			args.ParentID, args.Text = "parent", "task"
			err := dispatchErr(s, "chat.spawn", args)
			require.ErrorContains(t, err, "PERMISSION_ESCALATION")
			assert.Empty(t, agent.callList(), "no agent calls before validation")
		})
	}
}

func TestSpawnBypassAllowedWhenParentAlreadyDangerousOrInherited(t *testing.T) {
	metadata := `{"sessionConfig":{"selections":{"model":"small","mode":"bypassPermissions"},"modeId":"bypassPermissions"}}`
	t.Run("explicit matches dangerous parent", func(t *testing.T) {
		s, agent := driftFixture(t, metadata)
		invoke(t, s, "chat.spawn", Args{ParentID: "parent", Text: "task", Mode: "bypassPermissions"})
		finishSpawn(t, agent)
		assert.Equal(t, "bypassPermissions", childMode(t, agent))
	})
	t.Run("inherited", func(t *testing.T) {
		s, agent := driftFixture(t, metadata)
		invoke(t, s, "chat.spawn", Args{ParentID: "parent", Text: "task"})
		finishSpawn(t, agent)
		assert.Equal(t, "bypassPermissions", childMode(t, agent))
	})
	t.Run("default applied by agent is not a caller choice", func(t *testing.T) {
		s, agent := driftFixture(t, `{}`)
		agent.options = json.RawMessage(`[{"id":"mode","type":"select","category":"mode","currentValue":"bypassPermissions","options":[{"value":"code"},{"value":"bypassPermissions"}]}]`)
		invoke(t, s, "chat.spawn", Args{ParentID: "parent", Text: "task"})
		finishSpawn(t, agent)
	})
}

func TestConfigSetBypassEscalation(t *testing.T) {
	safe := `{"sessionConfig":{"selections":{"model":"small","mode":"code"},"modeId":"code"}}`
	t.Run("rejected", func(t *testing.T) {
		s, agent := driftFixture(t, safe)
		for _, args := range []Args{{Mode: "bypassPermissions"}, {Config: map[string]any{"mode": "bypassPermissions"}}} {
			args.ConversationID = "parent"
			require.ErrorContains(t, dispatchErr(s, "chat.config.set", args), "PERMISSION_ESCALATION")
		}
		assert.Empty(t, agent.callList())
	})
	t.Run("allowed when target already dangerous", func(t *testing.T) {
		s, _ := driftFixture(t, `{"sessionConfig":{"selections":{"model":"small","mode":"bypassPermissions"},"modeId":"bypassPermissions"}}`)
		invoke(t, s, "chat.config.set", Args{ConversationID: "parent", Mode: "bypassPermissions", Config: map[string]any{"model": "large"}})
	})
	t.Run("allowed when parent dangerous", func(t *testing.T) {
		s, _ := driftFixture(t, `{"sessionConfig":{"selections":{"model":"small","mode":"bypassPermissions"},"modeId":"bypassPermissions"}}`)
		kid := methods.ACPNavConversation{ID: "kid", AgentServer: "test", SessionID: "kid-session", WorkspacePath: t.TempDir(), Cwd: t.TempDir(), Metadata: json.RawMessage(safe)}
		kid.ParentID = "parent"
		view := View{ACPNavConversation: kid}
		view.RootID = "parent"
		require.NoError(t, s.save(context.Background(), view))
		_, err := s.nav.UpsertConversation(context.Background(), &methods.ACPNavUpsertConversationParams{Conversation: kid}, nil)
		require.NoError(t, err)
		invoke(t, s, "chat.config.set", Args{ConversationID: "kid", Mode: "bypassPermissions"})
	})
}

func TestSpawnRejectedUnderArchivedParent(t *testing.T) {
	s, agent := driftFixture(t, `{}`)
	_, err := s.nav.ArchiveConversation(context.Background(), &methods.ACPNavArchiveConversationParams{ConversationID: "parent"}, nil)
	require.NoError(t, err)
	err = dispatchErr(s, "chat.spawn", Args{ParentID: "parent", Text: "task"})
	require.ErrorContains(t, err, "is archived")
	assert.Empty(t, agent.callList(), "no agent calls for an archived parent")
}

func TestSpawnWorkspaceMustBeRegistered(t *testing.T) {
	s, agent := driftFixture(t, `{}`)
	err := dispatchErr(s, "chat.spawn", Args{AgentServer: "test", WorkspacePath: t.TempDir(), Text: "task"})
	require.ErrorContains(t, err, "not a registered project or worktree")
	assert.Empty(t, agent.callList())

	root := t.TempDir()
	_, err = s.nav.UpsertProject(context.Background(), &methods.ACPNavUpsertProjectParams{Path: root}, nil)
	require.NoError(t, err)
	sub := filepath.Join(root, "pkg", "x")
	require.NoError(t, os.MkdirAll(sub, 0o755))
	outside := t.TempDir()
	require.NoError(t, os.Symlink(outside, filepath.Join(root, "escape")))
	require.ErrorContains(t, dispatchErr(s, "chat.spawn", Args{AgentServer: "test", WorkspacePath: filepath.Join(root, "escape"), Text: "task"}), "not a registered project")
	require.ErrorContains(t, dispatchErr(s, "chat.spawn", Args{AgentServer: "test", WorkspacePath: filepath.Join(root, "..", "elsewhere"), Text: "task"}), "not a registered project")

	invoke(t, s, "chat.spawn", Args{AgentServer: "test", WorkspacePath: sub, Text: "task"})
	finishSpawn(t, agent)
}

func TestIsDangerousModeValue(t *testing.T) {
	for _, v := range []string{"bypassPermissions", "agent-full-access", "full-access", "always-allow", "Allow All", "yolo", "bypass_x"} {
		assert.True(t, isDangerousModeValue(v), v)
	}
	for _, v := range []string{"", "plan", "default", "acceptEdits", "read-only", "auto"} {
		assert.False(t, isDangerousModeValue(v), v)
	}
}

func mustJSON(t *testing.T, v any) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(v)
	require.NoError(t, err)
	return raw
}
