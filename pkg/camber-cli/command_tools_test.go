package cambercli

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestToolCommandsDispatchActions(t *testing.T) {
	cases := []struct {
		args    []string
		command string
		input   map[string]any
	}{
		{[]string{"agents", "install", "gemini"}, "agents.install", map[string]any{"agentServer": "gemini"}},
		{[]string{"agents", "remove", "gemini"}, "agents.remove", map[string]any{"agentServer": "gemini"}},
		{[]string{"agents", "default", "--unpin"}, "agents.default", map[string]any{"unpin": true}},
		{[]string{"agents", "config", "default", "claude", "mode", "plan"}, "agents.config.default", map[string]any{"agentServer": "claude", "optionId": "mode", "value": "plan"}},
		{[]string{"agents", "config", "default", "claude", "mode", "--unpin", "--clear-value"}, "agents.config.default", map[string]any{"agentServer": "claude", "optionId": "mode", "unpin": true, "clearValue": true}},
		{[]string{"agents", "restart", "claude", "--force"}, "agents.restart", map[string]any{"agentServer": "claude", "force": true}},
		{[]string{"agents", "runtimes"}, "agents.runtimes", map[string]any{}},
		{[]string{"mcp", "enable", "files"}, "mcp.enable", map[string]any{"name": "files"}},
		{[]string{"mcp", "sign-in", "files"}, "mcp.signIn", map[string]any{"name": "files"}},
		{[]string{"skills", "list", "--agent", "claude"}, "skills.list", map[string]any{"agentServer": "claude"}},
		{[]string{"models", "download", "org/m"}, "models.download", map[string]any{"modelId": "org/m"}},
		{[]string{"models", "download", "org/m", "--cancel"}, "models.cancel", map[string]any{"modelId": "org/m"}},
		{[]string{"models", "unload"}, "models.unload", map[string]any{}},
	}
	for _, tc := range cases {
		f := &fakeCaller{}
		_, err := execute(t, f, tc.args...)
		require.NoError(t, err, tc.args)
		require.Len(t, f.calls, 1, tc.args)
		assert.Equal(t, tc.command, f.calls[0].params["command"], tc.args)
		assert.Equal(t, tc.input, f.calls[0].params["args"], tc.args)
	}
}

func TestToolCommandsReadSecretsFromFiles(t *testing.T) {
	dir := t.TempDir()
	envFile := filepath.Join(dir, "env")
	require.NoError(t, os.WriteFile(envFile, []byte("# comment\nAPI_KEY=s3cret=x\n\nOTHER=1\n"), 0o600))
	tokenFile := filepath.Join(dir, "token")
	require.NoError(t, os.WriteFile(tokenFile, []byte("tok3n\n"), 0o600))

	f := &fakeCaller{}
	_, err := execute(t, f, "mcp", "add", "files", "--command", "files-mcp", "--arg", "--stdio", "--env-file", envFile, "--env", "OTHER=2", "--skip-test")
	require.NoError(t, err)
	require.Len(t, f.calls, 1)
	assert.Equal(t, map[string]any{"name": "files", "command": "files-mcp", "args": []string{"--stdio"}, "env": map[string]any{"API_KEY": "s3cret=x", "OTHER": "2"}, "skipTest": true}, f.calls[0].params["args"])

	f = &fakeCaller{}
	_, err = execute(t, f, "mcp", "edit", "remote", "--bearer-token-file", tokenFile, "--unset-header", "X-Old")
	require.NoError(t, err)
	assert.Equal(t, map[string]any{"name": "remote", "bearerToken": "tok3n", "unsetHeaders": []string{"X-Old"}}, f.calls[0].params["args"])

	f = &fakeCaller{}
	_, err = execute(t, f, "agents", "add", "mine", "--command", "my-acp", "--env", "NOEQUALS")
	require.ErrorContains(t, err, "KEY=VALUE")
	assert.Empty(t, f.calls)
}

func TestToolCommandsValidateArguments(t *testing.T) {
	for _, args := range [][]string{
		{"agents", "default"},
		{"agents", "default", "claude", "--unpin"},
		{"agents", "config", "default", "claude", "mode"},
		{"agents", "config", "default", "claude", "mode", "plan", "--unpin"},
		{"agents", "edit", "mine", "--arg", "x", "--clear-args"},
	} {
		f := &fakeCaller{}
		_, err := execute(t, f, args...)
		require.Error(t, err, args)
		assert.Empty(t, f.calls, args)
	}
}
