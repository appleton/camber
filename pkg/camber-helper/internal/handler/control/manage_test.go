package control

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/adrg/xdg"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/camber-helper/internal/handler/acpproxy"
	"github.com/appleton/camber/pkg/camber-helper/methods"
)

func TestChatArchiveClosesSessionAndCascadesToRenderedSubAgents(t *testing.T) {
	s, agent := manageFixture(t, `{}`, false)
	parent := mustView(t, s, "parent")
	addManagedChild(t, s, "kid", "parent", parent.WorkspacePath, parent.Cwd)
	addManagedChild(t, s, "elsewhere", "parent", parent.WorkspacePath, t.TempDir())

	out, err := dispatchRaw(s, "", "chat.archive", map[string]any{"conversationId": "parent"}, nil)
	require.NoError(t, err)
	assert.Equal(t, []any{"parent"}, out["archived"])
	assert.Equal(t, []any{"kid"}, out["descendants"])
	assert.True(t, mustView(t, s, "parent").Archived)
	assert.True(t, mustView(t, s, "kid").Archived)
	assert.False(t, mustView(t, s, "elsewhere").Archived, "a sub-agent in another worktree is not rendered under the parent")
	assert.Contains(t, agent.callList(), "close:cancel", "archiving cancels the running turn and closes the session")
}

func TestChatRestoreRestoresArchivedConversation(t *testing.T) {
	s, _ := manageFixture(t, `{}`, false)
	_, err := dispatchRaw(s, "", "chat.restore", map[string]any{"conversationId": "parent"}, nil)
	require.ErrorContains(t, err, "not archived")

	_, err = dispatchRaw(s, "", "chat.archive", map[string]any{"conversationId": "parent"}, nil)
	require.NoError(t, err)
	out, err := dispatchRaw(s, "", "chat.restore", map[string]any{"conversationId": "parent"}, nil)
	require.NoError(t, err)
	assert.Equal(t, true, out["restored"])
	assert.False(t, mustView(t, s, "parent").Archived)
}

func TestChatRenameUsesAppRename(t *testing.T) {
	s, agent := manageFixture(t, `{}`, false)
	_, err := dispatchRaw(s, "", "chat.rename", map[string]any{"conversationId": "parent", "name": "  "}, nil)
	require.ErrorContains(t, err, "name is required")

	out, err := dispatchRaw(s, "", "chat.rename", map[string]any{"conversationId": "parent", "name": "Plain"}, nil)
	require.NoError(t, err)
	assert.Equal(t, "Plain", out["conversation"].(map[string]any)["nickname"])
	assert.Empty(t, agent.renamedSessions(), "no agent-side rename without the capability")

	agent.caps = acpproxy.SessionManagementCapabilities{Known: true, Rename: true}
	_, err = dispatchRaw(s, "", "chat.rename", map[string]any{"conversationId": "parent", "name": "Fancy"}, nil)
	require.NoError(t, err)
	v := mustView(t, s, "parent")
	assert.Equal(t, "Fancy", v.Nickname)
	assert.Equal(t, "Fancy", v.Title)
	require.Eventually(t, func() bool { return len(agent.renamedSessions()) == 1 }, 5*time.Second, 10*time.Millisecond)
	assert.Equal(t, "parent-session", agent.renamedSessions()[0])
}

func TestChatDeleteRequiresConfirmationAndSupport(t *testing.T) {
	s, agent := manageFixture(t, `{}`, false)
	_, err := dispatchRaw(s, "", "chat.delete", map[string]any{"conversationId": "parent"}, nil)
	require.ErrorContains(t, err, "confirm=true")
	assert.False(t, mustView(t, s, "parent").Archived)

	agent.caps = acpproxy.SessionManagementCapabilities{Known: true}
	_, err = dispatchRaw(s, "", "chat.delete", map[string]any{"conversationId": "parent", "confirm": true}, nil)
	require.ErrorContains(t, err, "does not support deleting sessions")
	mustView(t, s, "parent")

	agent.caps = acpproxy.SessionManagementCapabilities{Known: true, Delete: true}
	out, err := dispatchRaw(s, "", "chat.delete", map[string]any{"conversationId": "parent", "confirm": true}, nil)
	require.NoError(t, err)
	assert.Equal(t, true, out["deleted"])
	_, err = s.view(context.Background(), "parent", nil)
	require.Error(t, err)
	assert.Equal(t, []string{"parent-session"}, agent.deletedSessions())
	assert.Equal(t, []string{"parent-session"}, agent.cancelledTurns(), "a control delete always cancels a running turn first")
}

func TestChatOpenRoutesToDesktop(t *testing.T) {
	s, _ := manageFixture(t, `{}`, false)
	_, err := dispatchRaw(s, "", "chat.open", map[string]any{"conversationId": "parent"}, nil)
	require.ErrorContains(t, err, "no Camber desktop window")

	var method string
	var params any
	g := desktopContext(func(m string, p any) { method, params = m, p })
	out, err := dispatchRaw(s, "", "chat.open", map[string]any{"conversationId": "parent"}, g)
	require.NoError(t, err)
	assert.Equal(t, true, out["opened"])
	assert.Equal(t, methods.DesktopAppOpenConversationMethod, method)
	assert.Equal(t, methods.DesktopAppOpenConversationParams{ConversationID: "parent"}, params)

	_, err = dispatchRaw(s, "", "chat.archive", map[string]any{"conversationId": "parent"}, nil)
	require.NoError(t, err)
	_, err = dispatchRaw(s, "", "chat.open", map[string]any{"conversationId": "parent"}, g)
	require.ErrorContains(t, err, "restore it first")
}

func TestConversationManagementOfBypassConversationNeedsProvenCaller(t *testing.T) {
	g := desktopContext(func(string, any) {})
	actions := map[string]map[string]any{
		"chat.archive": {"conversationId": "parent"},
		"chat.rename":  {"conversationId": "parent", "name": "x"},
		"chat.delete":  {"conversationId": "parent", "confirm": true},
		"chat.open":    {"conversationId": "parent"},
	}
	for action, args := range actions {
		t.Run(action, func(t *testing.T) {
			for _, token := range []string{"", "tok-other"} {
				s, agent := manageFixture(t, savedDangerous, false)
				_, err := dispatchRaw(s, token, action, args, g)
				require.ErrorContains(t, err, "PERMISSION_ESCALATION", token)
				assert.Empty(t, agent.callList(), token)
				assert.False(t, mustView(t, s, "parent").Archived)
			}
			s, _ := manageFixture(t, savedDangerous, false)
			_, err := dispatchRaw(s, "tok-parent", action, args, g)
			require.NoError(t, err, "the conversation's own token proves the caller")
		})
	}
	t.Run("chat.restore", func(t *testing.T) {
		s, _ := manageFixture(t, savedDangerous, false)
		_, err := dispatchRaw(s, "tok-parent", "chat.archive", map[string]any{"conversationId": "parent"}, nil)
		require.NoError(t, err)
		_, err = dispatchRaw(s, "", "chat.restore", map[string]any{"conversationId": "parent"}, nil)
		require.ErrorContains(t, err, "PERMISSION_ESCALATION")
		assert.True(t, mustView(t, s, "parent").Archived)
	})
}

func TestProjectChangesNeedLiveBypassCaller(t *testing.T) {
	folder := resolvedTempDir(t)
	for _, tc := range []struct {
		token string
		live  bool
	}{{"", true}, {"tok-other", true}, {"tok-parent", false}} {
		s, _ := manageFixture(t, `{}`, tc.live)
		_, err := dispatchRaw(s, tc.token, "projects.add", map[string]any{"projectPath": folder}, nil)
		require.ErrorContains(t, err, "PERMISSION_ESCALATION", tc)
		assert.ErrorContains(t, err, "folders agents may work in")
		_, err = dispatchRaw(s, tc.token, "projects.remove", map[string]any{"projectPath": folder}, nil)
		require.ErrorContains(t, err, "PERMISSION_ESCALATION", tc)
	}

	s, _ := manageFixture(t, `{}`, true)
	_, err := dispatchRaw(s, "tok-parent", "projects.add", map[string]any{"projectPath": "relative"}, nil)
	require.ErrorContains(t, err, "absolute")
	file := filepath.Join(folder, "file.txt")
	require.NoError(t, os.WriteFile(file, []byte("x"), 0o600))
	_, err = dispatchRaw(s, "tok-parent", "projects.add", map[string]any{"projectPath": file}, nil)
	require.ErrorContains(t, err, "not a folder")

	out, err := dispatchRaw(s, "tok-parent", "projects.add", map[string]any{"projectPath": folder}, nil)
	require.NoError(t, err)
	assert.Equal(t, folder, out["path"])
	assert.Equal(t, filepath.Base(folder), out["name"])

	var method string
	var params any
	g := desktopContext(func(m string, p any) { method, params = m, p })
	_, err = dispatchRaw(s, "tok-parent", "projects.remove", map[string]any{"projectPath": t.TempDir()}, g)
	require.ErrorContains(t, err, "not a registered root project")
	out, err = dispatchRaw(s, "tok-parent", "projects.remove", map[string]any{"projectPath": folder}, g)
	require.NoError(t, err)
	assert.Equal(t, true, out["removed"])
	assert.Equal(t, methods.DesktopAppRemoveProjectMethod, method)
	assert.Equal(t, methods.DesktopAppRemoveProjectParams{Path: folder}, params)
}

func TestWorktreeRenameSetsDisplayName(t *testing.T) {
	s, _ := manageFixture(t, `{}`, false)
	root, worktree := resolvedTempDir(t), resolvedTempDir(t)
	ctx := context.Background()
	_, err := s.nav.UpsertProject(ctx, &methods.ACPNavUpsertProjectParams{Path: root, Name: "root"}, nil)
	require.NoError(t, err)
	_, err = s.nav.UpsertProject(ctx, &methods.ACPNavUpsertProjectParams{Path: worktree, Name: "wt", IsWorktree: true, ParentPath: &root}, nil)
	require.NoError(t, err)

	_, err = dispatchRaw(s, "", "worktrees.rename", map[string]any{"workspacePath": root, "name": "x"}, nil)
	require.ErrorContains(t, err, "not registered", "a root project is not a worktree")
	_, err = dispatchRaw(s, "", "worktrees.rename", map[string]any{"workspacePath": worktree, "name": " "}, nil)
	require.ErrorContains(t, err, "name is required")

	out, err := dispatchRaw(s, "", "worktrees.rename", map[string]any{"workspacePath": worktree, "name": "Nice name"}, nil)
	require.NoError(t, err)
	assert.Equal(t, "Nice name", out["nickname"])
	assert.Equal(t, "wt", out["name"], "the worktree's directory name is unchanged")
}

func TestChatNewInChatsSection(t *testing.T) {
	previous := xdg.StateHome
	xdg.StateHome = resolvedTempDir(t)
	t.Cleanup(func() { xdg.StateHome = previous })
	s, agent := fixture(t)

	out := invoke(t, s, "chat.new", Args{WorkspacePath: chatWorkspacePath, AgentServer: "test", Text: "hello"})
	conversation := out["conversation"].(map[string]any)
	assert.Equal(t, chatWorkspacePath, conversation["workspacePath"])
	cwd := conversation["cwd"].(string)
	assert.True(t, filepath.IsAbs(cwd))
	assert.Equal(t, xdg.StateHome, filepath.Dir(filepath.Dir(filepath.Dir(cwd))), "the chat directory lives in Camber state, as for a desktop chat")
	info, err := os.Stat(cwd)
	require.NoError(t, err)
	assert.True(t, info.IsDir())
	<-agent.started
	close(agent.finish)
	stored := mustView(t, s, conversation["id"].(string))
	assert.Equal(t, chatWorkspacePath, stored.WorkspacePath, "the navigation row renders in Chats")
	assert.Equal(t, cwd, stored.Cwd)

	for _, args := range []Args{
		{WorkspacePath: chatWorkspacePath, ProjectPath: t.TempDir(), Text: "x"},
		{WorkspacePath: chatWorkspacePath, WorktreeName: "x", Text: "x"},
	} {
		assert.Error(t, dispatchErr(s, "chat.new", args))
	}
	assert.ErrorContains(t, dispatchErr(s, "chat.subagent", Args{ParentID: "parent", WorkspacePath: chatWorkspacePath, Text: "x"}), "absolute")
}

// manageAgent adds the session management calls acpproxy provides.
type manageAgent struct {
	*driftAgent
	caps      acpproxy.SessionManagementCapabilities
	deleted   []string
	renamed   []string
	cancelled []string
}

func (a *manageAgent) DeleteSession(_ context.Context, p *methods.ACPDeleteSessionParams, _ *glsp.Context) (*methods.ACPDeleteSessionOutput, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.deleted = append(a.deleted, string(p.SessionId))
	return &methods.ACPDeleteSessionOutput{}, nil
}

func (a *manageAgent) RenameSession(_ context.Context, p *methods.ACPRenameSessionParams, _ *glsp.Context) (*methods.ACPRenameSessionOutput, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.renamed = append(a.renamed, string(p.SessionID))
	return &methods.ACPRenameSessionOutput{}, nil
}

func (a *manageAgent) CancelInFlightTurn(_ context.Context, _, sessionID string, _ *glsp.Context) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.cancelled = append(a.cancelled, sessionID)
	return nil
}

func (a *manageAgent) SessionManagementCapabilities(string) acpproxy.SessionManagementCapabilities {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.caps
}

func (a *manageAgent) deletedSessions() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string(nil), a.deleted...)
}

func (a *manageAgent) renamedSessions() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string(nil), a.renamed...)
}

func (a *manageAgent) cancelledTurns() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string(nil), a.cancelled...)
}

// manageFixture is tokenFixture (a "parent" conversation with session
// "parent-session", caller tokens tok-parent and tok-other) with the session
// management calls available.
func manageFixture(t *testing.T, metadata string, parentLiveBypass bool) (*Service, *manageAgent) {
	t.Helper()
	s, drift := tokenFixture(t, metadata, parentLiveBypass)
	agent := &manageAgent{driftAgent: drift}
	s.agent = agent
	return s, agent
}

func addManagedChild(t *testing.T, s *Service, id, parent, workspacePath, cwd string) {
	t.Helper()
	child := methods.ACPNavConversation{ID: id, AgentServer: "test", SessionID: id + "-session", WorkspacePath: workspacePath, Cwd: cwd}
	view := View{ACPNavConversation: child}
	view.ParentID, view.RootID = parent, parent
	require.NoError(t, s.save(context.Background(), view))
	_, err := s.nav.UpsertConversation(context.Background(), &methods.ACPNavUpsertConversationParams{Conversation: child}, nil)
	require.NoError(t, err)
}

// resolvedTempDir is a temporary directory with symlinks resolved, as the
// navigation store records paths.
func resolvedTempDir(t *testing.T) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	require.NoError(t, err)
	return dir
}

// desktopContext is a desktop connection whose requests go to call.
func desktopContext(call func(method string, params any)) *glsp.Context {
	return &glsp.Context{
		Call: func(_ context.Context, method string, params any, _ any) error {
			call(method, params)
			return nil
		},
		Notify: func(context.Context, string, any) error { return nil },
	}
}

func mustView(t *testing.T, s *Service, id string) View {
	t.Helper()
	v, err := s.view(context.Background(), id, nil)
	require.NoError(t, err)
	return v
}

func dispatchRaw(s *Service, token, command string, args map[string]any, g *glsp.Context) (map[string]any, error) {
	raw, _ := json.Marshal(args)
	result, err := s.Dispatch(context.Background(), &methods.ControlDispatchParams{Command: command, Args: raw, CallerToken: token}, g)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	return out, json.Unmarshal(result, &out)
}
