package control

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/camber-helper/internal/handler/acpnav"
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

const (
	savedSafe      = `{"sessionConfig":{"selections":{"model":"small","mode":"code"},"modeId":"code"}}`
	savedDangerous = `{"sessionConfig":{"selections":{"model":"small","mode":"bypassPermissions"},"modeId":"bypassPermissions"}}`
	liveBypass     = `[{"id":"model","type":"select","category":"model","currentValue":"small","options":[{"value":"small"},{"value":"large"}]},{"id":"mode","type":"select","category":"mode","currentValue":"bypassPermissions","options":[{"value":"code"},{"value":"plan"},{"value":"bypassPermissions"}]}]`
	liveBypassMode = `{"currentModeId":"bypassPermissions","availableModes":[{"id":"code"},{"id":"plan"},{"id":"bypassPermissions"}]}`
	// opaqueOptions labels its bypass choice only by display name.
	opaqueOptions = `[{"id":"mode","type":"select","category":"mode","currentValue":"read-only","options":[{"value":"read-only","name":"Read only"},{"value":"danger-full-access","name":"Full access"}]}]`
)

// tokenFixture registers caller tokens for "parent" and an unrelated "other"
// conversation, which is live in a bypass mode of its own.
func tokenFixture(t *testing.T, metadata string, parentLiveBypass bool) (*Service, *driftAgent) {
	t.Helper()
	s, agent := driftFixture(t, metadata)
	s.callers = fakeCallers{"tok-parent": "parent", "tok-other": "other"}
	if parentLiveBypass {
		agent.parentLive = true
		agent.parentOptions = json.RawMessage(liveBypass)
		agent.parentModes = json.RawMessage(liveBypassMode)
	}
	return s, agent
}

func dispatchAs(s *Service, token, command string, args Args) (map[string]any, error) {
	raw, _ := json.Marshal(args)
	result, err := s.Dispatch(context.Background(), &methods.ControlDispatchParams{Command: command, Args: raw, CallerToken: token}, nil)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	return out, json.Unmarshal(result, &out)
}

func TestSpawnRejectsForeignParentLaundering(t *testing.T) {
	requests := map[string]Args{
		"explicit mode":   {Mode: "bypassPermissions"},
		"explicit config": {Config: map[string]any{"mode": "bypassPermissions"}},
		"inherited":       {},
	}
	for name, args := range requests {
		for _, token := range []string{"", "tok-other", "unknown"} {
			t.Run(name+"/token="+token, func(t *testing.T) {
				s, agent := tokenFixture(t, `{}`, true)
				args.ParentID, args.Text = "parent", "task"
				_, err := dispatchAs(s, token, "chat.spawn", args)
				require.ErrorContains(t, err, "PERMISSION_ESCALATION")
				assert.ErrorContains(t, err, "--caller-token")
				assert.Empty(t, agent.callList(), "rejected before any side effect")
			})
		}
	}
}

func TestSpawnBypassAllowedWithParentTokenWhenParentLive(t *testing.T) {
	for name, args := range map[string]Args{
		"explicit":  {Mode: "bypassPermissions"},
		"inherited": {},
	} {
		t.Run(name, func(t *testing.T) {
			s, agent := tokenFixture(t, `{}`, true)
			args.ParentID, args.Text = "parent", "task"
			_, err := dispatchAs(s, "tok-parent", "chat.spawn", args)
			require.NoError(t, err)
			finishSpawn(t, agent)
			assert.Equal(t, "bypassPermissions", childMode(t, agent))
		})
	}
}

func TestSpawnSavedDangerousParentIsNotEnough(t *testing.T) {
	for name, args := range map[string]Args{
		"explicit":  {Mode: "bypassPermissions"},
		"inherited": {},
	} {
		t.Run(name, func(t *testing.T) {
			s, agent := tokenFixture(t, savedDangerous, false)
			args.ParentID, args.Text = "parent", "task"
			_, err := dispatchAs(s, "tok-parent", "chat.spawn", args)
			require.ErrorContains(t, err, "PERMISSION_ESCALATION")
			assert.Empty(t, agent.callList())
		})
	}
	t.Run("explicit safe mode overrides inheritance", func(t *testing.T) {
		s, agent := tokenFixture(t, savedDangerous, false)
		_, err := dispatchAs(s, "", "chat.spawn", Args{ParentID: "parent", Text: "task", Mode: "plan"})
		require.NoError(t, err)
		finishSpawn(t, agent)
		assert.Equal(t, "plan", childMode(t, agent))
	})
	t.Run("different agent does not inherit", func(t *testing.T) {
		s, agent := tokenFixture(t, savedDangerous, false)
		_, err := dispatchAs(s, "", "chat.spawn", Args{ParentID: "parent", Text: "task", AgentServer: "other-agent"})
		require.NoError(t, err)
		finishSpawn(t, agent)
		assert.Equal(t, "code", childMode(t, agent))
	})
	t.Run("default applied by agent is not a caller choice", func(t *testing.T) {
		s, agent := tokenFixture(t, `{}`, false)
		agent.options = json.RawMessage(`[{"id":"mode","type":"select","category":"mode","currentValue":"bypassPermissions","options":[{"value":"code"},{"value":"bypassPermissions"}]}]`)
		_, err := dispatchAs(s, "", "chat.spawn", Args{ParentID: "parent", Text: "task"})
		require.NoError(t, err)
		finishSpawn(t, agent)
	})
}

func TestBypassLabelledOnlyByNameIsRejected(t *testing.T) {
	t.Run("spawn", func(t *testing.T) {
		s, agent := tokenFixture(t, savedSafe, false)
		agent.options = json.RawMessage(opaqueOptions)
		_, err := dispatchAs(s, "", "chat.spawn", Args{ParentID: "parent", Text: "task", Mode: "danger-full-access"})
		require.ErrorContains(t, err, "PERMISSION_ESCALATION")
		calls := agent.callList()
		assert.Contains(t, calls, "close:cancel", "the prepared session is closed")
		assert.NotContains(t, calls, "set:mode")
		assert.NotContains(t, calls, "prompt")
	})
	t.Run("spawn with unresolvable mode", func(t *testing.T) {
		s, agent := tokenFixture(t, savedSafe, false)
		agent.options = json.RawMessage(opaqueOptions)
		_, err := dispatchAs(s, "", "chat.spawn", Args{ParentID: "parent", Text: "task", Config: map[string]any{"mode": "secret-mode"}})
		require.ErrorContains(t, err, "unsupported value")
		assert.NotContains(t, agent.callList(), "prompt")
	})
	t.Run("config set", func(t *testing.T) {
		s, agent := tokenFixture(t, `{}`, false)
		agent.parentLive = true
		agent.parentOptions = json.RawMessage(opaqueOptions)
		agent.parentModes = json.RawMessage(`{}`)
		_, err := dispatchAs(s, "tok-parent", "chat.config.set", Args{ConversationID: "parent", Config: map[string]any{"mode": "danger-full-access"}})
		require.ErrorContains(t, err, "PERMISSION_ESCALATION")
		assert.Empty(t, agent.callList())
	})
	t.Run("legacy mode name", func(t *testing.T) {
		value, err := schemaDangerousValue(nil, json.RawMessage(`{"currentModeId":"ask","availableModes":[{"id":"ask","name":"Ask"},{"id":"auto-x","name":"YOLO"}]}`), Args{Mode: "auto-x"})
		require.NoError(t, err)
		assert.Equal(t, "auto-x", value)
		_, err = schemaDangerousValue(nil, json.RawMessage(`{"availableModes":[{"id":"ask"}]}`), Args{Mode: "missing"})
		assert.ErrorContains(t, err, "unsupported mode")
	})
}

func TestConfigSetBypassEscalation(t *testing.T) {
	t.Run("rejected from a safe conversation", func(t *testing.T) {
		s, agent := tokenFixture(t, savedSafe, false)
		for _, args := range []Args{{Mode: "bypassPermissions"}, {Config: map[string]any{"mode": "bypassPermissions"}}} {
			args.ConversationID = "parent"
			_, err := dispatchAs(s, "tok-parent", "chat.config.set", args)
			require.ErrorContains(t, err, "PERMISSION_ESCALATION")
		}
		assert.Empty(t, agent.callList())
	})
	t.Run("live dangerous target needs its own token", func(t *testing.T) {
		for _, token := range []string{"", "tok-other"} {
			s, _ := tokenFixture(t, `{}`, true)
			_, err := dispatchAs(s, token, "chat.config.set", Args{ConversationID: "parent", Mode: "plan"})
			require.NoError(t, err, "non-bypass changes need no token")
		}
		s, _ := tokenFixture(t, `{}`, true)
		s.agent.(*driftAgent).parentOptions = json.RawMessage(strings.Replace(liveBypass, `"currentValue":"bypassPermissions"`, `"currentValue":"code"`, 1))
		_, err := dispatchAs(s, "tok-other", "chat.config.set", Args{ConversationID: "parent", Mode: "bypassPermissions"})
		require.ErrorContains(t, err, "PERMISSION_ESCALATION")
	})
	t.Run("allowed when token-proven target is live dangerous", func(t *testing.T) {
		s, _ := tokenFixture(t, `{}`, true)
		_, err := dispatchAs(s, "tok-parent", "chat.config.set", Args{ConversationID: "parent", Mode: "bypassPermissions", Config: map[string]any{"model": "large"}})
		require.NoError(t, err)
	})
	t.Run("saved dangerous target is not enough", func(t *testing.T) {
		s, _ := tokenFixture(t, savedDangerous, false)
		_, err := dispatchAs(s, "tok-parent", "chat.config.set", Args{ConversationID: "parent", Mode: "bypassPermissions"})
		require.ErrorContains(t, err, "PERMISSION_ESCALATION")
	})
	addKid := func(t *testing.T, s *Service) {
		t.Helper()
		kid := methods.ACPNavConversation{ID: "kid", AgentServer: "test", SessionID: "kid-session", WorkspacePath: t.TempDir(), Cwd: t.TempDir(), Metadata: json.RawMessage(savedSafe)}
		kid.ParentID = "parent"
		view := View{ACPNavConversation: kid}
		view.RootID = "parent"
		require.NoError(t, s.save(context.Background(), view))
		_, err := s.nav.UpsertConversation(context.Background(), &methods.ACPNavUpsertConversationParams{Conversation: kid}, nil)
		require.NoError(t, err)
	}
	t.Run("allowed on a child with the live dangerous parent's token", func(t *testing.T) {
		s, _ := tokenFixture(t, `{}`, true)
		addKid(t, s)
		_, err := dispatchAs(s, "tok-parent", "chat.config.set", Args{ConversationID: "kid", Mode: "bypassPermissions"})
		require.NoError(t, err)
	})
	t.Run("rejected on a child with another conversation's token", func(t *testing.T) {
		s, _ := tokenFixture(t, `{}`, true)
		addKid(t, s)
		_, err := dispatchAs(s, "tok-other", "chat.config.set", Args{ConversationID: "kid", Mode: "bypassPermissions"})
		require.ErrorContains(t, err, "PERMISSION_ESCALATION")
	})
}

func TestControlOutputRedactsCallerTokens(t *testing.T) {
	s, agent := tokenFixture(t, `{}`, false)
	out, err := dispatchAs(s, "", "chat.spawn", Args{ParentID: "parent", Text: "echo tok-parent please"})
	require.NoError(t, err)
	finishSpawn(t, agent)
	raw := mustJSON(t, out)
	assert.NotContains(t, string(raw), "tok-parent")
	assert.Contains(t, string(raw), "[redacted]")
}

// archivingAgent archives the parent while the child's session is created,
// standing in for a user archiving during a slow preparation.
type archivingAgent struct {
	*driftAgent
	nav *acpnav.Server
}

func (a *archivingAgent) NewSession(ctx context.Context, p *methods.ACPNewSessionParams, g *glsp.Context) (*methods.ACPNewSessionOutput, error) {
	out, err := a.driftAgent.NewSession(ctx, p, g)
	if err == nil {
		_, err = a.nav.ArchiveConversation(ctx, &methods.ACPNavArchiveConversationParams{ConversationID: "parent"}, g)
	}
	return out, err
}

func TestSpawnParentArchivedDuringPreparation(t *testing.T) {
	s, base := driftFixture(t, `{}`)
	s.agent = &archivingAgent{driftAgent: base, nav: s.nav}
	err := dispatchErr(s, "chat.spawn", Args{ParentID: "parent", Text: "task", RequestID: "late"})
	require.ErrorContains(t, err, "was archived while the child was being prepared")
	digest := sha256.Sum256([]byte("parent\x00late"))
	child, err := s.view(context.Background(), "child-"+hex.EncodeToString(digest[:16]), nil)
	require.NoError(t, err)
	assert.True(t, child.Archived)
	assert.Equal(t, "failed", child.Status)
	calls := base.callList()
	assert.Contains(t, calls, "close:cancel")
	assert.NotContains(t, calls, "prompt")
}

func TestWorktreeCreateRequiresRegisteredRootProject(t *testing.T) {
	s, agent := driftFixture(t, `{}`)
	project, err := s.nav.UpsertProject(context.Background(), &methods.ACPNavUpsertProjectParams{Path: t.TempDir()}, nil)
	require.NoError(t, err)
	root := project.Path
	sub := filepath.Join(root, "pkg")
	require.NoError(t, os.MkdirAll(sub, 0o755))
	worktree := t.TempDir()
	_, err = s.nav.UpsertProject(context.Background(), &methods.ACPNavUpsertProjectParams{Path: worktree, IsWorktree: true, ParentPath: &root}, nil)
	require.NoError(t, err)
	for name, path := range map[string]string{"unregistered": t.TempDir(), "subdirectory": sub, "worktree": worktree, "missing": ""} {
		t.Run(name, func(t *testing.T) {
			err := dispatchErr(s, "worktrees.create", Args{ProjectPath: path, WorktreeName: "x"})
			require.Error(t, err)
			assert.Regexp(t, "not a registered root project|projectPath is required", err.Error())
			err = dispatchErr(s, "chat.spawn", Args{AgentServer: "test", ProjectPath: path, WorkspacePath: root, WorktreeName: "x", Text: "task"})
			require.Error(t, err)
			assert.Regexp(t, "not a registered root project|projectPath is required|not a registered project or worktree", err.Error())
		})
	}
	assert.Empty(t, agent.callList())
}

func TestProbeWorkspaceMustBeRegistered(t *testing.T) {
	s, agent := driftFixture(t, `{}`)
	for _, command := range []string{"agents.inspect", "agents.config.options"} {
		err := dispatchErr(s, command, Args{AgentServer: "test", WorkspacePath: t.TempDir()})
		require.ErrorContains(t, err, "not a registered project or worktree")
	}
	assert.Empty(t, agent.callList())
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
