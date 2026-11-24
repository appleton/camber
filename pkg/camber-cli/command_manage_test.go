package cambercli

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestManagementCommandsDispatch(t *testing.T) {
	wd, err := os.Getwd()
	require.NoError(t, err)
	t.Setenv("CAMBER_CONVERSATION_ID", "env-chat")
	for _, tc := range []struct {
		args    []string
		command string
		want    map[string]any
	}{
		{[]string{"chat", "archive", "c1"}, "chat.archive", map[string]any{"conversationId": "c1"}},
		{[]string{"chat", "archive"}, "chat.archive", map[string]any{"conversationId": "env-chat"}},
		{[]string{"chat", "restore", "c1"}, "chat.restore", map[string]any{"conversationId": "c1"}},
		{[]string{"chat", "open", "c1"}, "chat.open", map[string]any{"conversationId": "c1"}},
		{[]string{"chat", "rename", "c1", "New name"}, "chat.rename", map[string]any{"conversationId": "c1", "name": "New name"}},
		{[]string{"chat", "delete", "c1", "--yes"}, "chat.delete", map[string]any{"conversationId": "c1", "confirm": true}},
		{[]string{"projects", "add", "proj"}, "projects.add", map[string]any{"projectPath": filepath.Join(wd, "proj")}},
		{[]string{"projects", "remove", "/abs/proj"}, "projects.remove", map[string]any{"projectPath": "/abs/proj"}},
		{[]string{"worktrees", "rename", "/abs/wt", "Nice"}, "worktrees.rename", map[string]any{"workspacePath": "/abs/wt", "name": "Nice"}},
	} {
		f := &fakeCaller{}
		_, err := execute(t, f, tc.args...)
		require.NoError(t, err, tc.args)
		require.Len(t, f.calls, 1, tc.args)
		assert.Equal(t, tc.command, f.calls[0].params["command"], tc.args)
		assert.Equal(t, tc.want, f.calls[0].params["args"], tc.args)
	}
}

func TestChatDeleteRequiresYes(t *testing.T) {
	f := &fakeCaller{}
	_, err := execute(t, f, "chat", "delete", "c1")
	require.ErrorContains(t, err, "--yes")
	assert.Empty(t, f.calls)
}

func TestChatNewChatDispatchesChatWorkspace(t *testing.T) {
	f := &fakeCaller{}
	_, err := execute(t, f, "chat", "new", "--chat", "--agent", "codex", "--model", "sol", "--text", "hello", "--request-id", "r1", "--caller-token", "tok")
	require.NoError(t, err)
	require.Len(t, f.calls, 1)
	assert.Equal(t, "chat.new", f.calls[0].params["command"])
	assert.Equal(t, "tok", f.calls[0].params["callerToken"])
	args := f.calls[0].params["args"].(map[string]any)
	assert.Equal(t, "CHAT", args["workspacePath"])
	assert.Equal(t, "codex", args["agentServer"])
	assert.Equal(t, "sol", args["model"])
	assert.Equal(t, "hello", args["text"])
	assert.Equal(t, "r1", args["requestId"])

	// --chat sends the same task and configuration keys as a workspace
	// conversation, minus the workspace selection.
	workspace := &fakeCaller{}
	_, err = execute(t, workspace, "chat", "new", "--workspace", "/w", "--text", "hello")
	require.NoError(t, err)
	sent := workspace.calls[0].params["args"].(map[string]any)
	for key := range sent {
		if key == "projectPath" || key == "worktreeName" {
			continue
		}
		assert.Contains(t, args, key)
	}

	for _, flag := range [][]string{{"--workspace", "/w"}, {"--project", "/p"}, {"--new-worktree", "x"}} {
		f := &fakeCaller{}
		_, err := execute(t, f, append([]string{"chat", "new", "--chat", "--text", "x"}, flag...)...)
		require.ErrorContains(t, err, "--chat", flag)
		assert.Empty(t, f.calls)
	}
}
