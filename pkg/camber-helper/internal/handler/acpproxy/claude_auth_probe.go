package acpproxy

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"os/exec"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

// The Claude ACP adapter creates sessions without checking credentials — auth
// failures only surface when a prompt hits the API — so a config-probe
// session/new succeeds even for a logged-out user and the client can never
// learn auth-required state before the first message. The adapter does ship a
// headless escape hatch: running the agent command with `--cli auth status`
// prints `{"loggedIn": bool, "apiProvider": string, ...}` without any
// interaction. For config probes we run that check alongside session/new and
// convert a logged-out result into the standard ACP auth_required error,
// making Claude indistinguishable from agents that gate session/new (pool,
// codex-acp). Remove once the adapter reports auth_required at session/new.

const claudeAgentPackageName = "@agentclientprotocol/claude-agent-acp"
const claudeAuthStatusTimeout = 30 * time.Second

type claudeAuthStatus struct {
	LoggedIn    bool   `json:"loggedIn"`
	AuthMethod  string `json:"authMethod"`
	APIProvider string `json:"apiProvider"`
}

// maybeProbeClaudeAuthStatus starts a background auth-status check for a
// config-probe session/new against the Claude adapter. It returns nil when the
// check does not apply (not a probe, not Claude, no client-facing auth methods,
// or a previous check on this subprocess already verified a usable state —
// login or a non-first-party provider); otherwise it returns a channel that
// yields either an auth_required error to surface in place of the session/new
// result, or nil to proceed. The check fails open: timeouts, spawn errors, and
// unparseable output never block the probe.
func (h *Handler) maybeProbeClaudeAuthStatus(ctx context.Context, proc *process, agentServer string, meta any) <-chan error {
	if !isConfigProbeSession(meta) || !proc.needsClaudeAuthStatusCheck() {
		return nil
	}
	binary, args, env, dir, snapshotCmd, ok := proc.commandSnapshot()
	if !ok {
		return nil
	}

	result := make(chan error, 1)
	go func() {
		// Keep the parent's cancellation: if session/new fails or the client
		// cancels, nobody reads this result and the spawned status process
		// should die with the request rather than run out its timeout.
		statusCtx, cancel := context.WithTimeout(ctx, claudeAuthStatusTimeout)
		defer cancel()

		cmd := exec.CommandContext(statusCtx, binary, append(args, "--cli", "auth", "status")...)
		configureProcessCommand(cmd)
		cmd.Env = env
		cmd.Dir = dir
		var stdout bytes.Buffer
		cmd.Stdout = &stdout
		// A logged-out status exits non-zero, so only treat the run as failed
		// when stdout carries no parseable status document.
		runErr := cmd.Run()

		var status claudeAuthStatus
		if err := json.Unmarshal(stdout.Bytes(), &status); err != nil {
			slog.Warn("acpproxy: claude auth status check inconclusive",
				"server", agentServer, "runErr", runErr, "parseErr", err)
			result <- nil
			return
		}
		if status.LoggedIn {
			proc.markClaudeAuthStatusVerified(snapshotCmd)
			result <- nil
			return
		}
		// A non-first-party provider (Bedrock, Vertex, gateway) can be usable
		// without a Claude login; never block those. That routing is stable
		// configuration, not a login state that can change out from under a
		// live subprocess, so cache it exactly like a positive login result —
		// otherwise every recurring config probe respawns this 30s subprocess
		// for no reason.
		if status.APIProvider != "" && status.APIProvider != "firstParty" {
			proc.markClaudeAuthStatusVerified(snapshotCmd)
			result <- nil
			return
		}
		slog.Info("acpproxy: claude reports logged out; converting config probe to auth_required",
			"server", agentServer)
		result <- preserveACPError("acpproxy: claude auth status",
			acpsdk.NewAuthRequired(map[string]string{
				"message": "Log in to Claude to start a session.",
			}))
	}()
	return result
}

// needsClaudeAuthStatusCheck reports whether the running subprocess is the
// Claude ACP adapter with client-facing auth methods and no usable auth check
// recorded for this subprocess instance yet. Only usable results (a login or
// a non-first-party provider) are cached (on the process, cleared on
// restart): a logged-out firstParty user may log in through the terminal auth
// flow without the adapter restarting, so that result must be re-checked on
// the next probe.
func (p *process) needsClaudeAuthStatusCheck() bool {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.claudeAuthVerified || p.initResp == nil {
		return false
	}
	if p.initResp.AgentInfo == nil || p.initResp.AgentInfo.Name != claudeAgentPackageName {
		return false
	}
	// No auth methods means the adapter hid auth on purpose (e.g. Bedrock or
	// Vertex routing) — there is nothing the user could log in to.
	return len(p.initResp.AuthMethods) > 0
}

// isClaudeAgent reports whether this process is the Claude ACP adapter. Keep
// the identity check here beside the adapter-specific auth workaround so
// callers do not infer the implementation from a user-configured server name.
func (p *process) isClaudeAgent() bool {
	p.mu.Lock()
	defer p.mu.Unlock()

	return p.initResp != nil && p.initResp.AgentInfo != nil && p.initResp.AgentInfo.Name == claudeAgentPackageName
}

// markClaudeAuthStatusVerified records a positive result, but only when the
// subprocess the status command was snapshotted from is still the live one: a
// restart in between means the result describes a dead process and must not
// exempt its replacement from checking.
func (p *process) markClaudeAuthStatusVerified(snapshotCmd *exec.Cmd) {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.cmd != snapshotCmd {
		return
	}
	p.claudeAuthVerified = true
}

// commandSnapshot copies the running subprocess's spawn parameters so the
// auth-status check runs the exact same binary with the same environment. The
// returned cmd is the identity of the subprocess the snapshot belongs to.
func (p *process) commandSnapshot() (binary string, args []string, env []string, dir string, cmd *exec.Cmd, ok bool) {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.cmd == nil || len(p.cmd.Args) == 0 {
		return "", nil, nil, "", nil, false
	}
	return p.cmd.Args[0], append([]string{}, p.cmd.Args[1:]...), append([]string{}, p.cmd.Env...), p.cmd.Dir, p.cmd, true
}
