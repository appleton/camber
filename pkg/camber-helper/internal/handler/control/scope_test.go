package control

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

func TestSendAndSteerToBypassConversationNeedProvenCaller(t *testing.T) {
	t.Run("saved bypass target rejects unproven send before restoring", func(t *testing.T) {
		for _, token := range []string{"", "tok-other", "unknown"} {
			s, agent := tokenFixture(t, savedDangerous, false)
			_, err := dispatchAs(s, token, "chat.send", Args{ConversationID: "parent", Text: "go"})
			require.ErrorContains(t, err, "PERMISSION_ESCALATION")
			assert.ErrorContains(t, err, "--caller-token")
			assert.ErrorContains(t, err, "desktop")
			assert.Empty(t, agent.callList(), "no restore and no prompt for token %q", token)
		}
	})
	t.Run("saved bypass target accepts its own token", func(t *testing.T) {
		s, agent := tokenFixture(t, savedDangerous, false)
		_, err := dispatchAs(s, "tok-parent", "chat.send", Args{ConversationID: "parent", Text: "go"})
		require.NoError(t, err)
		finishSpawn(t, agent)
		calls := agent.callList()
		assert.Contains(t, calls, "load")
		assert.Contains(t, calls, "set:mode")
		assert.Contains(t, calls, "prompt")
	})
	t.Run("live bypass target rejects unproven send and steer", func(t *testing.T) {
		for _, token := range []string{"", "tok-other"} {
			s, agent := tokenFixture(t, `{}`, true)
			_, err := dispatchAs(s, token, "chat.send", Args{ConversationID: "parent", Text: "go"})
			require.ErrorContains(t, err, "PERMISSION_ESCALATION")
			_, err = dispatchAs(s, token, "chat.steer", Args{ConversationID: "parent", Text: "go"})
			require.ErrorContains(t, err, "PERMISSION_ESCALATION")
			assert.Empty(t, agent.callList())
		}
	})
	t.Run("live bypass target accepts its own token for steer", func(t *testing.T) {
		s, agent := tokenFixture(t, `{}`, true)
		_, err := dispatchAs(s, "tok-parent", "chat.steer", Args{ConversationID: "parent", Text: "go"})
		require.NoError(t, err)
		assert.Equal(t, []string{"steer"}, agent.callList())
	})
	t.Run("safe target needs no token", func(t *testing.T) {
		s, agent := tokenFixture(t, savedSafe, false)
		_, err := dispatchAs(s, "", "chat.steer", Args{ConversationID: "parent", Text: "go"})
		require.NoError(t, err)
		_, err = dispatchAs(s, "", "chat.send", Args{ConversationID: "parent", Text: "go"})
		require.NoError(t, err)
		finishSpawn(t, agent)
		assert.Contains(t, agent.callList(), "prompt")
	})
}

func TestSendToBypassChildNeedsLiveBypassParent(t *testing.T) {
	t.Run("parent token with live bypass parent", func(t *testing.T) {
		s, agent := tokenFixture(t, `{}`, true)
		addChild(t, s, savedDangerous)
		_, err := dispatchAs(s, "tok-parent", "chat.send", Args{ConversationID: "kid", Text: "go"})
		require.NoError(t, err)
		finishSpawn(t, agent)
	})
	t.Run("another conversation's token", func(t *testing.T) {
		s, agent := tokenFixture(t, `{}`, true)
		addChild(t, s, savedDangerous)
		_, err := dispatchAs(s, "tok-other", "chat.send", Args{ConversationID: "kid", Text: "go"})
		require.ErrorContains(t, err, "PERMISSION_ESCALATION")
		assert.Empty(t, agent.callList())
	})
	t.Run("parent token while parent only has a saved bypass selection", func(t *testing.T) {
		s, agent := tokenFixture(t, savedDangerous, false)
		addChild(t, s, savedDangerous)
		_, err := dispatchAs(s, "tok-parent", "chat.send", Args{ConversationID: "kid", Text: "go"})
		require.ErrorContains(t, err, "PERMISSION_ESCALATION")
		assert.Empty(t, agent.callList())
	})
}

func TestConfigRestoreOfSavedBypassNeedsProvenCaller(t *testing.T) {
	t.Run("list without proof reads saved selections without restoring", func(t *testing.T) {
		s, agent := tokenFixture(t, savedDangerous, false)
		out, err := dispatchAs(s, "", "chat.config.list", Args{ConversationID: "parent"})
		require.NoError(t, err)
		assert.Equal(t, false, out["restored"])
		assert.Equal(t, "bypassPermissions", recoveryValues(mustJSON(t, out["configOptions"]))["mode"])
		assert.Empty(t, agent.callList())
	})
	t.Run("set without proof is rejected before restoring", func(t *testing.T) {
		s, agent := tokenFixture(t, savedDangerous, false)
		_, err := dispatchAs(s, "", "chat.config.set", Args{ConversationID: "parent", Model: "large"})
		require.ErrorContains(t, err, "PERMISSION_ESCALATION")
		assert.Empty(t, agent.callList())
	})
	t.Run("list with the target's token restores", func(t *testing.T) {
		s, agent := tokenFixture(t, savedDangerous, false)
		_, err := dispatchAs(s, "tok-parent", "chat.config.list", Args{ConversationID: "parent"})
		require.NoError(t, err)
		assert.Contains(t, agent.callList(), "load")
	})
}

func TestArchivedConversationRejectsSendSteerAndConfigSet(t *testing.T) {
	s, agent := driftFixture(t, savedSafe)
	_, err := s.nav.ArchiveConversation(context.Background(), &methods.ACPNavArchiveConversationParams{ConversationID: "parent"}, nil)
	require.NoError(t, err)
	for command, args := range map[string]Args{
		"chat.send":       {ConversationID: "parent", Text: "go"},
		"chat.steer":      {ConversationID: "parent", Text: "go"},
		"chat.config.set": {ConversationID: "parent", Mode: "plan"},
	} {
		err := dispatchErr(s, command, args)
		require.ErrorContains(t, err, "conversation parent is archived; restore it first", command)
	}
	assert.Empty(t, agent.callList())
	out := invoke(t, s, "chat.stop", Args{ConversationID: "parent"})
	assert.Equal(t, true, out["cancelRequested"], "stop still works on archived conversations")
}

func TestControlPathsMustBeAbsoluteWithoutParentSegments(t *testing.T) {
	s, agent := driftFixture(t, `{}`)
	project, err := s.nav.UpsertProject(context.Background(), &methods.ACPNavUpsertProjectParams{Path: t.TempDir()}, nil)
	require.NoError(t, err)
	root := project.Path
	require.NoError(t, os.MkdirAll(filepath.Join(root, "pkg"), 0o755))
	require.NoError(t, os.Symlink(t.TempDir(), filepath.Join(root, "escape")))
	// Built by concatenation: filepath.Join would clean the ".." away.
	escape := root + string(filepath.Separator) + "escape" + string(filepath.Separator) + ".."
	for name, args := range map[string]Args{
		"spawn workspace": {AgentServer: "test", WorkspacePath: escape, Text: "task"},
		"spawn project":   {AgentServer: "test", ProjectPath: escape, Text: "task"},
		"spawn relative":  {AgentServer: "test", WorkspacePath: "pkg", Text: "task"},
	} {
		t.Run(name, func(t *testing.T) {
			err := dispatchErr(s, "chat.spawn", args)
			require.Error(t, err)
			assert.Regexp(t, `must not contain ".." segments|must be an absolute path`, err.Error())
		})
	}
	require.ErrorContains(t, dispatchErr(s, "agents.inspect", Args{AgentServer: "test", WorkspacePath: escape}), `must not contain ".." segments`)
	require.ErrorContains(t, dispatchErr(s, "worktrees.create", Args{ProjectPath: escape, WorktreeName: "x"}), `must not contain ".." segments`)
	assert.Empty(t, agent.callList())

	// The cleaned path is what the child records and the agent receives.
	untidy := root + string(filepath.Separator) + "." + string(filepath.Separator) + "pkg" + string(filepath.Separator)
	out := invoke(t, s, "chat.spawn", Args{AgentServer: "test", WorkspacePath: untidy, Text: "task"})
	finishSpawn(t, agent)
	conversation := out["conversation"].(map[string]any)
	assert.Equal(t, filepath.Join(root, "pkg"), conversation["workspacePath"])
	assert.Equal(t, filepath.Join(root, "pkg"), conversation["cwd"])
}

func TestSpawnConflictingValuesClosesPreparedSession(t *testing.T) {
	s, agent := fixture(t)
	err := dispatchErr(s, "chat.spawn", Args{ParentID: "parent", Text: "task", RequestID: "conflict", Model: "large", Config: map[string]any{"model": "small"}})
	require.ErrorContains(t, err, "conflicting values for option model")
	agent.mu.Lock()
	assert.Equal(t, []string{"new", "close:cancel"}, agent.calls)
	agent.mu.Unlock()
	digest := sha256.Sum256([]byte("parent\x00conflict"))
	child, err := s.view(context.Background(), "child-"+hex.EncodeToString(digest[:16]), nil)
	require.NoError(t, err)
	assert.Equal(t, "failed", child.Status)
	assert.Contains(t, child.Error, "conflicting values")
}

// addChild registers "kid" under "parent" with the given saved metadata.
func addChild(t *testing.T, s *Service, metadata string) {
	t.Helper()
	kid := methods.ACPNavConversation{ID: "kid", AgentServer: "test", SessionID: "kid-session", WorkspacePath: t.TempDir(), Cwd: t.TempDir(), Metadata: json.RawMessage(metadata)}
	kid.ParentID = "parent"
	view := View{ACPNavConversation: kid}
	view.RootID = "parent"
	require.NoError(t, s.save(context.Background(), view))
	_, err := s.nav.UpsertConversation(context.Background(), &methods.ACPNavUpsertConversationParams{Conversation: kid}, nil)
	require.NoError(t, err)
}

// schemaAgent loads the parent session with a fixed schema, so a saved
// selection's meaning is only known once the session is loaded.
type schemaAgent struct {
	*driftAgent
	schema string
}

func (a *schemaAgent) LoadSession(context.Context, *methods.ACPLoadSessionParams, *glsp.Context) (*methods.ACPLoadSessionOutput, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.calls = append(a.calls, "load")
	a.parentLive = true
	a.options = json.RawMessage(a.schema)
	var out methods.ACPLoadSessionOutput
	raw, _ := json.Marshal(map[string]any{"configOptions": json.RawMessage(a.schema)})
	return &out, json.Unmarshal(raw, &out)
}

func (a *schemaAgent) CloseSession(ctx context.Context, p *methods.ACPCloseSessionParams, g *glsp.Context) (*methods.ACPCloseSessionOutput, error) {
	out, err := a.fakeAgent.CloseSession(ctx, p, g)
	a.mu.Lock()
	a.parentLive = false
	a.mu.Unlock()
	return out, err
}

// approvalOptions has a mode-category option whose id is not "mode".
const approvalOptions = `[{"id":"approval","type":"select","category":"mode","currentValue":"ask","options":[{"value":"ask","name":"Ask"},{"value":"bypassPermissions","name":"Bypass"}]}]`

func schemaFixture(t *testing.T, schema, metadata string) (*Service, *schemaAgent) {
	t.Helper()
	s, drift := tokenFixture(t, metadata, false)
	agent := &schemaAgent{driftAgent: drift, schema: schema}
	s.agent = agent
	return s, agent
}

func TestRestoreJudgesSavedSelectionsAgainstLoadedSchema(t *testing.T) {
	cases := map[string]struct{ schema, metadata, option, value string }{
		"opaque value named Full access under id mode":    {opaqueOptions, `{"sessionConfig":{"selections":{"mode":"danger-full-access"}}}`, "mode", "danger-full-access"},
		"bypass value under a mode option not named mode": {approvalOptions, `{"sessionConfig":{"selections":{"approval":"bypassPermissions"}}}`, "approval", "bypassPermissions"},
	}
	for name, tc := range cases {
		t.Run(name+"/unproven send is rejected and nothing applied", func(t *testing.T) {
			for _, token := range []string{"", "tok-other"} {
				s, agent := schemaFixture(t, tc.schema, tc.metadata)
				_, err := dispatchAs(s, token, "chat.send", Args{ConversationID: "parent", Text: "go"})
				require.ErrorContains(t, err, "PERMISSION_ESCALATION")
				assert.ErrorContains(t, err, "--caller-token")
				assert.Equal(t, []string{"load", "close"}, agent.callList(), "loaded to read the schema, then closed without applying or prompting")
				_, _, live := agent.SessionConfiguration("test", "parent-session")
				assert.False(t, live, "no loaded session is left behind")
				parent, viewErr := s.view(context.Background(), "parent", nil)
				require.NoError(t, viewErr)
				assert.NotEqual(t, "running", parent.Status)
				assert.JSONEq(t, tc.metadata, string(parent.Metadata), "saved selections untouched")
			}
		})
		t.Run(name+"/unproven config set is rejected", func(t *testing.T) {
			s, agent := schemaFixture(t, tc.schema, tc.metadata)
			_, err := dispatchAs(s, "", "chat.config.set", Args{ConversationID: "parent", Config: map[string]any{tc.option: tc.value}})
			require.ErrorContains(t, err, "PERMISSION_ESCALATION")
			for _, call := range agent.callList() {
				assert.NotContains(t, []string{"set:" + tc.option, "prompt"}, call)
			}
		})
		t.Run(name+"/unproven config list shows saved selections without restoring", func(t *testing.T) {
			s, agent := schemaFixture(t, tc.schema, tc.metadata)
			out, err := dispatchAs(s, "", "chat.config.list", Args{ConversationID: "parent"})
			require.NoError(t, err)
			assert.Equal(t, false, out["restored"])
			assert.Equal(t, tc.value, recoveryValues(mustJSON(t, out["configOptions"]))[tc.option])
			assert.Equal(t, []string{"load", "close"}, agent.callList())
		})
		t.Run(name+"/proven caller restores and prompts", func(t *testing.T) {
			s, agent := schemaFixture(t, tc.schema, tc.metadata)
			_, err := dispatchAs(s, "tok-parent", "chat.send", Args{ConversationID: "parent", Text: "go"})
			require.NoError(t, err)
			finishSpawn(t, agent.driftAgent)
			assert.Equal(t, []string{"load", "set:" + tc.option, "prompt"}, agent.callList())
		})
	}
}

func TestSavedBypassJudgedByRecordedSchemaBeforeLoading(t *testing.T) {
	for name, tc := range map[string]struct{ schema, metadata string }{
		"named Full access": {opaqueOptions, `{"sessionConfig":{"selections":{"mode":"danger-full-access"}}}`},
		"mode category":     {approvalOptions, `{"sessionConfig":{"selections":{"approval":"bypassPermissions"}}}`},
	} {
		t.Run(name, func(t *testing.T) {
			s, agent := schemaFixture(t, tc.schema, tc.metadata)
			v, err := s.view(context.Background(), "parent", nil)
			require.NoError(t, err)
			v.ConfigOptions = json.RawMessage(tc.schema)
			require.NoError(t, s.save(context.Background(), v))
			_, err = dispatchAs(s, "", "chat.send", Args{ConversationID: "parent", Text: "go"})
			require.ErrorContains(t, err, "PERMISSION_ESCALATION")
			assert.Empty(t, agent.callList(), "the recorded schema rejects before any agent call")
		})
	}
}

func TestSpawnUnderParentUsesExplicitProject(t *testing.T) {
	s, agent := driftFixture(t, `{}`)
	project, err := s.nav.UpsertProject(context.Background(), &methods.ACPNavUpsertProjectParams{Path: t.TempDir()}, nil)
	require.NoError(t, err)
	out := invoke(t, s, "chat.spawn", Args{ParentID: "parent", ProjectPath: project.Path, Text: "task"})
	finishSpawn(t, agent)
	conversation := out["conversation"].(map[string]any)
	assert.Equal(t, project.Path, conversation["workspacePath"], "the explicit project, not the parent's workspace")
	assert.Equal(t, project.Path, conversation["cwd"])
	assert.Equal(t, "parent", conversation["parentId"])

	err = dispatchErr(s, "chat.spawn", Args{ParentID: "parent", ProjectPath: t.TempDir(), Text: "task"})
	require.ErrorContains(t, err, "not a registered project or worktree", "the project is still checked")
}
