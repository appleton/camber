package control

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

func TestSubagentRunsInParentWorkspaceAndRecordsParentLinks(t *testing.T) {
	s, agent := tokenFixture(t, `{}`, false)
	parent, err := s.view(context.Background(), "parent", nil)
	require.NoError(t, err)
	require.NotEqual(t, parent.WorkspacePath, parent.Cwd, "the fixture distinguishes workspace and cwd")

	out, err := dispatchAs(s, "tok-parent", "chat.subagent", Args{ParentID: "parent", Text: "sub-task"})
	require.NoError(t, err)
	finishSpawn(t, agent)
	conversation := out["conversation"].(map[string]any)
	assert.Equal(t, parent.WorkspacePath, conversation["workspacePath"])
	assert.Equal(t, parent.Cwd, conversation["cwd"], "the sub-agent shares the parent's working directory and sidebar group")
	assert.Equal(t, "test", conversation["agentServer"], "the parent's agent by default")
	assert.Equal(t, "parent", conversation["parentId"])
	assert.Equal(t, "parent", conversation["rootId"])
	assert.NotContains(t, conversation, "originId", "a sub-agent is linked by its parent, not an origin")

	var stored map[string]any
	require.NoError(t, s.nav.ReadControlState(context.Background(), "conversation/"+conversation["id"].(string), &stored))
	assert.Equal(t, "parent", stored["parentId"], "the nav parent-link cache reads this record")
	assert.Equal(t, "parent", stored["rootId"])

	children := invoke(t, s, "chat.children", Args{ParentID: "parent"})
	require.Len(t, children["conversations"], 1)
	assert.Equal(t, conversation["id"], children["conversations"].([]any)[0].(map[string]any)["id"])
}

func TestSubagentRejectsWorkspaceSelection(t *testing.T) {
	s, agent := driftFixture(t, `{}`)
	project, err := s.nav.UpsertProject(context.Background(), &methods.ACPNavUpsertProjectParams{Path: t.TempDir()}, nil)
	require.NoError(t, err)
	for name, args := range map[string]Args{
		"workspacePath": {WorkspacePath: project.Path},
		"projectPath":   {ProjectPath: project.Path},
		"worktreeName":  {WorktreeName: "task"},
	} {
		args.ParentID, args.Text = "parent", "task"
		err := dispatchErr(s, "chat.subagent", args)
		require.ErrorContains(t, err, "parent's workspace", name)
		assert.ErrorContains(t, err, "chat.new", name)
	}
	require.ErrorContains(t, dispatchErr(s, "chat.subagent", Args{Text: "task"}), "parentId is required")
	assert.Empty(t, agent.callList(), "rejected before any agent call")
}

func TestSubagentInheritsAndGuardsLikeSpawn(t *testing.T) {
	t.Run("inheriting a live bypass mode needs the parent's token", func(t *testing.T) {
		s, agent := tokenFixture(t, `{}`, true)
		err := dispatchErr(s, "chat.subagent", Args{ParentID: "parent", Text: "task"})
		require.ErrorContains(t, err, "PERMISSION_ESCALATION")
		assert.Empty(t, agent.callList())
	})
	t.Run("the parent's token inherits its bypass mode", func(t *testing.T) {
		s, agent := tokenFixture(t, `{}`, true)
		_, err := dispatchAs(s, "tok-parent", "chat.subagent", Args{ParentID: "parent", Text: "task"})
		require.NoError(t, err)
		finishSpawn(t, agent)
		assert.Equal(t, "bypassPermissions", childMode(t, agent))
	})
}

func TestNewRecordsOriginOnlyForProvenCaller(t *testing.T) {
	t.Run("token-proven caller becomes the origin", func(t *testing.T) {
		s, agent := tokenFixture(t, `{}`, false)
		project := registerProject(t, s)
		out, err := dispatchAs(s, "tok-parent", "chat.new", Args{AgentServer: "test", WorkspacePath: project, Text: "separate work"})
		require.NoError(t, err)
		finishSpawn(t, agent)
		conversation := out["conversation"].(map[string]any)
		id := conversation["id"].(string)
		assert.Equal(t, "parent", conversation["originId"])
		assert.NotContains(t, conversation, "parentId", "an independent conversation has no parent")
		assert.NotContains(t, conversation, "rootId")
		assert.Equal(t, project, conversation["workspacePath"])
		assert.Equal(t, project, conversation["cwd"])

		var stored map[string]any
		require.NoError(t, s.nav.ReadControlState(context.Background(), "conversation/"+id, &stored))
		assert.NotContains(t, stored, "parentId", "nothing for the desktop to nest, archive or silence by")
		assert.Equal(t, "parent", stored["originId"])

		inspected := invoke(t, s, "chat.inspect", Args{ConversationID: id})
		assert.Equal(t, "parent", inspected["originId"])
		listed := invoke(t, s, "chat.list", Args{})
		var summary map[string]any
		for _, row := range listed["conversations"].([]any) {
			if row.(map[string]any)["id"] == id {
				summary = row.(map[string]any)
			}
		}
		require.NotNil(t, summary)
		assert.Equal(t, "parent", summary["originId"])
		assert.NotContains(t, summary, "parentId")
		children := invoke(t, s, "chat.children", Args{ParentID: "parent"})
		assert.Empty(t, children["conversations"], "chat children lists only parentId links")
	})
	for name, token := range map[string]string{"no token": "", "unknown token": "unknown"} {
		t.Run(name, func(t *testing.T) {
			s, agent := tokenFixture(t, `{}`, false)
			project := registerProject(t, s)
			out, err := dispatchAs(s, token, "chat.new", Args{AgentServer: "test", WorkspacePath: project, Text: "separate work"})
			require.NoError(t, err)
			finishSpawn(t, agent)
			conversation := out["conversation"].(map[string]any)
			assert.NotContains(t, conversation, "originId")
			assert.NotContains(t, conversation, "parentId")
		})
	}
}

func TestNewWorkspaceChecks(t *testing.T) {
	s, agent := driftFixture(t, `{}`)
	project := registerProject(t, s)
	for name, tc := range map[string]struct {
		args Args
		want string
	}{
		"no workspace":             {Args{}, "workspacePath or projectPath is required"},
		"parent":                   {Args{ParentID: "parent", WorkspacePath: project}, "chat.subagent"},
		"workspace and project":    {Args{WorkspacePath: project, ProjectPath: project}, "not both"},
		"worktree without project": {Args{WorkspacePath: project, WorktreeName: "task"}, "worktreeName needs projectPath"},
		"unregistered workspace":   {Args{WorkspacePath: t.TempDir()}, "not a registered project or worktree"},
		"unregistered project":     {Args{ProjectPath: t.TempDir()}, "not a registered project or worktree"},
		"relative workspace":       {Args{WorkspacePath: "relative/path"}, "must be an absolute path"},
	} {
		tc.args.Text = "task"
		require.ErrorContains(t, dispatchErr(s, "chat.new", tc.args), tc.want, name)
	}
	assert.Empty(t, agent.callList(), "rejected before any agent call")

	out := invoke(t, s, "chat.new", Args{AgentServer: "test", ProjectPath: project, Text: "task"})
	finishSpawn(t, agent)
	assert.Equal(t, project, out["conversation"].(map[string]any)["workspacePath"], "a project alone runs in that project")
}

func TestNewDoesNotInheritFromOrigin(t *testing.T) {
	s, agent := tokenFixture(t, `{}`, true)
	agent.parentOptions = json.RawMessage(`[{"id":"model","type":"select","category":"model","currentValue":"large","options":[{"value":"small"},{"value":"large"}]},{"id":"mode","type":"select","category":"mode","currentValue":"bypassPermissions","options":[{"value":"code"},{"value":"plan"},{"value":"bypassPermissions"}]}]`)
	project := registerProject(t, s)
	_, err := dispatchAs(s, "tok-parent", "chat.new", Args{AgentServer: "test", WorkspacePath: project, Text: "task"})
	require.NoError(t, err, "no inherited bypass mode to guard")
	finishSpawn(t, agent)
	assert.Equal(t, "code", childMode(t, agent), "the agent default, not the origin's bypass mode")
	assert.Equal(t, "small", recoveryValues(agent.options)["model"], "the agent default, not the origin's model")
	assert.NotContains(t, agent.callList(), "set:model")
}

func TestNewBypassModeNeedsLiveBypassOrigin(t *testing.T) {
	for name, tc := range map[string]struct {
		token          string
		originMetadata string
		originLive     bool
	}{
		"no token":                    {"", `{}`, true},
		"conversation not in the nav": {"tok-other", `{}`, true},
		"origin not in bypass":        {"tok-parent", `{}`, false},
		"origin only saved in bypass": {"tok-parent", savedDangerous, false},
	} {
		t.Run(name, func(t *testing.T) {
			s, agent := tokenFixture(t, tc.originMetadata, tc.originLive)
			project := registerProject(t, s)
			_, err := dispatchAs(s, tc.token, "chat.new", Args{AgentServer: "test", WorkspacePath: project, Text: "task", Mode: "bypassPermissions"})
			require.ErrorContains(t, err, "PERMISSION_ESCALATION")
			assert.ErrorContains(t, err, "the conversation creating it")
			assert.Empty(t, agent.callList(), "rejected before any side effect")
		})
	}
	t.Run("live bypass origin", func(t *testing.T) {
		s, agent := tokenFixture(t, `{}`, true)
		project := registerProject(t, s)
		out, err := dispatchAs(s, "tok-parent", "chat.new", Args{AgentServer: "test", WorkspacePath: project, Text: "task", Mode: "bypassPermissions"})
		require.NoError(t, err)
		finishSpawn(t, agent)
		assert.Equal(t, "bypassPermissions", childMode(t, agent))
		assert.Equal(t, "parent", out["conversation"].(map[string]any)["originId"])
	})
}

func TestBypassConversationAcceptsItsOrigin(t *testing.T) {
	t.Run("send with the live bypass origin's token", func(t *testing.T) {
		s, agent := tokenFixture(t, `{}`, true)
		addOriginated(t, s, savedDangerous)
		_, err := dispatchAs(s, "tok-parent", "chat.send", Args{ConversationID: "solo", Text: "go"})
		require.NoError(t, err)
		finishSpawn(t, agent)
	})
	t.Run("steer with the live bypass origin's token", func(t *testing.T) {
		s, agent := tokenFixture(t, `{}`, true)
		addOriginated(t, s, savedDangerous)
		_, err := dispatchAs(s, "tok-parent", "chat.steer", Args{ConversationID: "solo", Text: "go"})
		require.NoError(t, err)
		assert.Equal(t, []string{"steer"}, agent.callList())
	})
	t.Run("config set with the live bypass origin's token", func(t *testing.T) {
		s, _ := tokenFixture(t, `{}`, true)
		addOriginated(t, s, savedSafe)
		_, err := dispatchAs(s, "tok-parent", "chat.config.set", Args{ConversationID: "solo", Mode: "bypassPermissions"})
		require.NoError(t, err)
	})
	for name, tc := range map[string]struct {
		token          string
		originMetadata string
		originLive     bool
	}{
		"another conversation's token": {"tok-other", `{}`, true},
		"no token":                     {"", `{}`, true},
		"origin only saved in bypass":  {"tok-parent", savedDangerous, false},
	} {
		t.Run("rejects "+name, func(t *testing.T) {
			s, agent := tokenFixture(t, tc.originMetadata, tc.originLive)
			addOriginated(t, s, savedDangerous)
			_, err := dispatchAs(s, tc.token, "chat.send", Args{ConversationID: "solo", Text: "go"})
			require.ErrorContains(t, err, "PERMISSION_ESCALATION")
			_, err = dispatchAs(s, tc.token, "chat.steer", Args{ConversationID: "solo", Text: "go"})
			require.ErrorContains(t, err, "PERMISSION_ESCALATION")
			_, err = dispatchAs(s, tc.token, "chat.config.set", Args{ConversationID: "solo", Mode: "bypassPermissions"})
			require.ErrorContains(t, err, "PERMISSION_ESCALATION")
			assert.Empty(t, agent.callList())
		})
	}
}

func TestNewRequestIDReplaysAndIsScopedByAction(t *testing.T) {
	s, agent := tokenFixture(t, `{}`, false)
	project := registerProject(t, s)
	args := Args{AgentServer: "test", WorkspacePath: project, Text: "task", RequestID: "same"}
	first, err := dispatchAs(s, "tok-parent", "chat.new", args)
	require.NoError(t, err)
	finishSpawn(t, agent)
	again, err := dispatchAs(s, "tok-parent", "chat.new", args)
	require.NoError(t, err)
	assert.Equal(t, first["conversation"].(map[string]any)["id"], again["conversation"].(map[string]any)["id"])
	assert.Equal(t, first["turnId"], again["turnId"])
	_, err = dispatchAs(s, "tok-parent", "chat.new", Args{AgentServer: "test", WorkspacePath: project, Text: "other task", RequestID: "same"})
	require.ErrorContains(t, err, "different arguments")
	assert.Equal(t, 1, agent.next, "replays create no session")

	request := Args{ParentID: "parent", RequestID: "same"}
	ids := map[string]bool{
		requestConversationID(request, createLegacySpawn, ""):                       true,
		requestConversationID(request, createSubagent, ""):                          true,
		requestConversationID(Args{RequestID: "same"}, createIndependent, "parent"): true,
		requestConversationID(Args{RequestID: "same"}, createIndependent, "other"):  true,
	}
	assert.Len(t, ids, 4, "one requestId never replays across actions or origins")
}

func TestDescribeCreationActions(t *testing.T) {
	s, _ := fixture(t)
	subagent := invoke(t, s, "actions.describe", Args{Name: "chat.subagent"})
	schema := subagent["inputSchema"].(map[string]any)
	assert.ElementsMatch(t, []any{"parentId", "text"}, schema["required"])
	properties := schema["properties"].(map[string]any)
	for _, field := range []string{"workspacePath", "projectPath", "worktreeName"} {
		assert.NotContains(t, properties, field)
	}
	created := invoke(t, s, "actions.describe", Args{Name: "chat.new"})
	properties = created["inputSchema"].(map[string]any)["properties"].(map[string]any)
	assert.NotContains(t, properties, "parentId")
	assert.Contains(t, properties, "worktreeName")
	actions := invoke(t, s, "actions.list", Args{})
	assert.Subset(t, actions["commands"], []any{"chat.subagent", "chat.new", "chat.spawn"})
}

func registerProject(t *testing.T, s *Service) string {
	t.Helper()
	project, err := s.nav.UpsertProject(context.Background(), &methods.ACPNavUpsertProjectParams{Path: t.TempDir()}, nil)
	require.NoError(t, err)
	return project.Path
}

// addOriginated records "solo", an independent conversation that "parent"
// created with chat.new.
func addOriginated(t *testing.T, s *Service, metadata string) {
	t.Helper()
	solo := methods.ACPNavConversation{ID: "solo", AgentServer: "test", SessionID: "solo-session", WorkspacePath: t.TempDir(), Cwd: t.TempDir(), Metadata: json.RawMessage(metadata)}
	view := View{ACPNavConversation: solo, OriginID: "parent"}
	require.NoError(t, s.save(context.Background(), view))
	_, err := s.nav.UpsertConversation(context.Background(), &methods.ACPNavUpsertConversationParams{Conversation: solo}, nil)
	require.NoError(t, err)
}
