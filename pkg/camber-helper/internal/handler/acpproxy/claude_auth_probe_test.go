package acpproxy

import (
	"os/exec"
	"testing"

	acpsdk "github.com/coder/acp-go-sdk"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func claudeInitResp(authMethods []acpsdk.AuthMethod) *acpsdk.InitializeResponse {
	return &acpsdk.InitializeResponse{
		AgentInfo:   &acpsdk.Implementation{Name: claudeAgentPackageName},
		AuthMethods: authMethods,
	}
}

func terminalAuthMethods() []acpsdk.AuthMethod {
	return []acpsdk.AuthMethod{{Terminal: &acpsdk.AuthMethodTerminalInline{Id: "claude-login"}}}
}

func TestNeedsClaudeAuthStatusCheck(t *testing.T) {
	t.Run("claude adapter with auth methods needs a check", func(t *testing.T) {
		p := &process{initResp: claudeInitResp(terminalAuthMethods())}
		assert.True(t, p.needsClaudeAuthStatusCheck())
	})

	t.Run("skips other agents", func(t *testing.T) {
		p := &process{initResp: &acpsdk.InitializeResponse{
			AgentInfo:   &acpsdk.Implementation{Name: "@zed-industries/codex-acp"},
			AuthMethods: terminalAuthMethods(),
		}}
		assert.False(t, p.needsClaudeAuthStatusCheck())
	})

	t.Run("skips when the adapter hides auth methods (bedrock/vertex)", func(t *testing.T) {
		p := &process{initResp: claudeInitResp(nil)}
		assert.False(t, p.needsClaudeAuthStatusCheck())
	})

	t.Run("skips before initialize", func(t *testing.T) {
		p := &process{}
		assert.False(t, p.needsClaudeAuthStatusCheck())
	})

	t.Run("positive result is cached until the subprocess restarts", func(t *testing.T) {
		p := &process{
			initResp: claudeInitResp(terminalAuthMethods()),
			cmd:      exec.Command("/bin/sh", "-c", "true"),
		}
		p.markClaudeAuthStatusVerified(p.cmd)
		assert.False(t, p.needsClaudeAuthStatusCheck())

		p.mu.Lock()
		p.resetLocked(processState{kind: processStateUnstarted})
		p.mu.Unlock()
		p.initResp = claudeInitResp(terminalAuthMethods())
		assert.True(t, p.needsClaudeAuthStatusCheck(), "restart must clear the cached verification")
	})

	t.Run("a stale snapshot cannot verify a replacement subprocess", func(t *testing.T) {
		p := &process{
			initResp: claudeInitResp(terminalAuthMethods()),
			cmd:      exec.Command("/bin/sh", "-c", "true"),
		}
		staleCmd := p.cmd
		// The subprocess restarted while the status command was running.
		p.mu.Lock()
		p.resetLocked(processState{kind: processStateUnstarted})
		p.mu.Unlock()
		p.initResp = claudeInitResp(terminalAuthMethods())
		p.cmd = exec.Command("/bin/sh", "-c", "true")

		p.markClaudeAuthStatusVerified(staleCmd)
		assert.True(t, p.needsClaudeAuthStatusCheck(),
			"a result for the dead subprocess must not exempt the new one")
	})
}

func TestMaybeProbeClaudeAuthStatusSkipsNonProbeSessions(t *testing.T) {
	h := &Handler{}
	p := &process{initResp: claudeInitResp(terminalAuthMethods())}

	assert.Nil(t, h.maybeProbeClaudeAuthStatus(t.Context(), p, "claude-acp", nil),
		"a real session must not run the auth-status subprocess")
	assert.Nil(t, h.maybeProbeClaudeAuthStatus(t.Context(), p, "claude-acp",
		map[string]any{configProbeMetaKey: false}))
	assert.Nil(t, h.maybeProbeClaudeAuthStatus(t.Context(), p, "claude-acp",
		map[string]any{configProbeMetaKey: true}),
		"a probe session without a running command has nothing to snapshot")
}

// claudeProcessWithStatusOutput builds a process whose spawn command is a shell
// stub, so the appended `--cli auth status` args are ignored and the probe sees
// the scripted output.
func claudeProcessWithStatusOutput(script string) *process {
	return &process{
		initResp: claudeInitResp(terminalAuthMethods()),
		cmd:      exec.Command("/bin/sh", "-c", script),
	}
}

func probeMeta() map[string]any {
	return map[string]any{configProbeMetaKey: true}
}

func TestMaybeProbeClaudeAuthStatusResults(t *testing.T) {
	h := &Handler{}

	t.Run("logged-out first-party converts to auth_required", func(t *testing.T) {
		p := claudeProcessWithStatusOutput(
			`echo '{"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"}'; exit 1`)
		ch := h.maybeProbeClaudeAuthStatus(t.Context(), p, "claude-acp", probeMeta())
		require.NotNil(t, ch)
		err := <-ch
		require.Error(t, err)
		assert.Contains(t, err.Error(), "Authentication required")
		assert.False(t, p.claudeAuthVerified, "a negative result must not be cached")
	})

	t.Run("logged-in passes and caches the verification", func(t *testing.T) {
		p := claudeProcessWithStatusOutput(
			`echo '{"loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty"}'`)
		ch := h.maybeProbeClaudeAuthStatus(t.Context(), p, "claude-acp", probeMeta())
		require.NotNil(t, ch)
		require.NoError(t, <-ch)
		assert.True(t, p.claudeAuthVerified)
		assert.Nil(t, h.maybeProbeClaudeAuthStatus(t.Context(), p, "claude-acp", probeMeta()),
			"a verified subprocess skips further checks")
	})

	t.Run("logged-out on a non-first-party provider never blocks and caches the result", func(t *testing.T) {
		// FIX 3 (recurring-probe review): a non-firstParty provider
		// (Bedrock/Vertex/gateway) is stable configuration, not a login
		// state, so it must be cached like a positive login result.
		// Otherwise every recurring config probe (roughly every 10 minutes
		// while a draft conversation is open) respawns the 30s
		// `--cli auth status` subprocess for no reason.
		p := claudeProcessWithStatusOutput(
			`echo '{"loggedIn": false, "authMethod": "none", "apiProvider": "bedrock"}'; exit 1`)
		ch := h.maybeProbeClaudeAuthStatus(t.Context(), p, "claude-acp", probeMeta())
		require.NotNil(t, ch)
		assert.NoError(t, <-ch)
		assert.True(t, p.claudeAuthVerified,
			"a non-firstParty provider is stable configuration and must be latched")
		assert.Nil(t, h.maybeProbeClaudeAuthStatus(t.Context(), p, "claude-acp", probeMeta()),
			"a verified non-firstParty subprocess skips further checks")
	})

	t.Run("malformed output fails open", func(t *testing.T) {
		p := claudeProcessWithStatusOutput(`echo 'not json'; exit 3`)
		ch := h.maybeProbeClaudeAuthStatus(t.Context(), p, "claude-acp", probeMeta())
		require.NotNil(t, ch)
		assert.NoError(t, <-ch)
		assert.False(t, p.claudeAuthVerified)
	})
}
