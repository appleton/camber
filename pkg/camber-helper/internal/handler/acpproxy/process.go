package acpproxy

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha512"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"

	"github.com/appleton/camber/pkg/camber-helper/internal/shellenv"
	"github.com/appleton/camber/pkg/camber-helper/methods"
	"github.com/appleton/camber/pkg/common/version"
)

const (
	DefaultAgentServerName       = "poolside"
	LocalAgentServerName         = methods.LocalAgentServerName
	LegacyDefaultAgentServerName = "default"
	npmConfigCacheEnvKey         = "npm_config_cache"
	npmConfigCacheEnvKeyUpper    = "NPM_CONFIG_CACHE"
	authenticateUpdateMethod     = acpsdk.AgentMethodAuthenticate + "/update"
	initializeHandshakeTimeout   = 30 * time.Second
	processRestartBackoff        = 3 * time.Second
)

// How long a stopping subprocess gets to exit on its own after its stdin
// closes, and then again after being asked to terminate. Agents persist state
// as they shut down, so killing one outright can strand a conversation:
// `pool acp` writes the record that maps an ACP session to its backend
// session, and a session whose record never lands replays an empty transcript
// and can never be prompted again (PE-2460). Variables so tests can shorten
// the ladder.
var (
	processStdinExitGrace  = 2 * time.Second
	processSignalExitGrace = time.Second
)

var legacySelfCommands = map[string]struct{}{
	"{{SELF}}":  {},
	"{{$SELF}}": {},
}

// userShellEnvProvider is swapped in tests; production uses the shared
// shell-environment capture (which the server also applies process-wide at
// startup — the per-agent merge here keeps agent launches correct even when
// the helper is embedded without that startup step).
var userShellEnvProvider = shellenv.Capture

// process manages the lifecycle of a `pool acp` child process.
type process struct {
	mu sync.Mutex
	// serverName identifies the agent server this slot serves. It outlives any
	// one subprocess instance, so resetLocked leaves it alone.
	serverName    string
	state         processState
	cmd           *exec.Cmd
	conn          *acpsdk.ClientSideConnection
	configuration *sessionConfigurationCache
	initResp      *acpsdk.InitializeResponse
	initReq       *acpsdk.InitializeRequest
	session       acpsdk.SessionId
	// sessionIsProbe records whether `session` came from a config probe, so a
	// later probe may replace it while a real session may not be displaced.
	// See adoptSessionLocked.
	sessionIsProbe bool
	stdin          io.WriteCloser
	// exited is closed once the current subprocess has been reaped, letting
	// stop wait for a voluntary exit without racing watchExit for cmd.Wait.
	exited chan struct{}
	onStop func()
	// claudeAuthVerified records a usable `--cli auth status` result (a login
	// or a non-first-party provider) for this subprocess instance (see
	// claude_auth_probe.go). Positive-only: cleared on restart, never set on
	// an inconclusive or logged-out-firstParty result.
	claudeAuthVerified bool
	// promptRuntimeErr records a fatal runtime failure reported only on the
	// subprocess's stderr. promptCancels lets that signal release any ACP
	// prompts the adapter otherwise leaves pending indefinitely.
	promptRuntimeErr error
	promptCancels    map[uint64]context.CancelCauseFunc
	nextPromptID     uint64
}

type processStateKind uint8

const (
	processStateUnstarted processStateKind = iota
	processStateRunning
	processStateExited
)

type processState struct {
	kind     processStateKind
	exitedAt time.Time
}

func (p *process) isRunningLocked() bool {
	return p.state.kind == processStateRunning
}

func (p *process) isRunning() bool {
	p.mu.Lock()
	defer p.mu.Unlock()

	return p.isRunningLocked()
}

// name returns the agent server this slot serves, so stop errors can say
// which agent failed to stop. Empty for a slot that never started.
func (p *process) name() string {
	p.mu.Lock()
	defer p.mu.Unlock()

	return p.serverName
}

// adoptSessionLocked records the fallback session used to attribute untagged
// elicitations and empty-sessionId requests. A config probe never displaces a
// real session — that would route a mid-turn elicitation to a throwaway
// session no surface renders — but it does replace an earlier probe: the
// client closes a superseded probe after a drain window, so keeping the old
// one would leave the fallback pointing at a closed session. Must be called
// with p.mu held.
func (p *process) adoptSessionLocked(id acpsdk.SessionId, probe bool) {
	if probe && p.session != "" && !p.sessionIsProbe {
		return
	}
	p.session = id
	p.sessionIsProbe = probe
}

// resetLocked clears all runtime fields that are tied to one subprocess
// instance and records the lifecycle state that should follow.
func (p *process) resetLocked(state processState) {
	p.configuration.invalidate()
	p.configuration = nil
	p.cmd = nil
	p.conn = nil
	p.initResp = nil
	p.session = ""
	p.sessionIsProbe = false
	p.stdin = nil
	p.exited = nil
	p.onStop = nil
	p.claudeAuthVerified = false
	p.promptRuntimeErr = nil
	p.promptCancels = nil
	p.state = state
}

func (p *process) initializedConn() (*acpsdk.ClientSideConnection, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	if !p.isRunningLocked() {
		return nil, fmt.Errorf("acpproxy: not initialized; call initialize first")
	}

	return p.conn, nil
}

func (p *process) initializeRequest() *acpsdk.InitializeRequest {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.initReq == nil {
		return nil
	}
	req := *p.initReq
	return &req
}

type startConfig struct {
	serverName string
	binary     string
	extraArgs  []string
	env        map[string]string
	// processDir is the working directory for the subprocess itself (e.g. repo root for go run).
	processDir string
	onExit     func(serverName string, err error)
}

type AgentServerConfig struct {
	Type                 string                                   `json:"type,omitempty"`
	Command              string                                   `json:"command,omitempty"`
	Args                 []string                                 `json:"args,omitempty"`
	Env                  map[string]string                        `json:"env,omitempty"`
	Binary               map[string]AgentServerBinaryDistribution `json:"binary,omitempty"`
	DefaultConfigOptions map[string]string                        `json:"default_config_options,omitempty"`
}

type AgentServerBinaryDistribution struct {
	Archive string            `json:"archive"`
	SHA256  string            `json:"sha256,omitempty"`
	Cmd     string            `json:"cmd"`
	Args    []string          `json:"args,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
}

// MCPServerInjector is called by the proxy before each session/new, session/load,
// or session/resume to get the set of user MCP servers to inject. It returns the
// servers to add and a list of unavailable entries with their reasons. Nil return
// means no injection.
type MCPServerInjector func(ctx context.Context, agentServer string, caps acpsdk.McpCapabilities) (servers []acpsdk.McpServer, unavailable []methods.MCPServerStatus)

// AgentServerReadinessProvider is called before session boundaries for agent
// servers with helper-owned runtime dependencies. Returning false tells the
// proxy to restart the ACP subprocess so fresh runtime environment can be
// injected before session/new or session/load.
type AgentServerReadinessProvider func(context.Context, string) (bool, error)

type HandlerConfig struct {
	WorkingDir             string
	AgentServers           map[string]AgentServerConfig
	AgentServerEnvProvider func(context.Context, string) (map[string]string, error)
	AgentServerReady       AgentServerReadinessProvider
	// MCPServerInjector is optional. When set, it is called for every session/new,
	// session/load, and session/resume (except config-probe sessions) to inject
	// user MCP servers.
	MCPServerInjector MCPServerInjector
}

func DefaultAgentServers() map[string]AgentServerConfig {
	return map[string]AgentServerConfig{
		DefaultAgentServerName: defaultAgentServerConfig(),
	}
}

func NormalizeAgentServers(agentServers map[string]AgentServerConfig) map[string]AgentServerConfig {
	normalized := DefaultAgentServers()
	for name, cfg := range agentServers {
		normalizedName := NormalizeAgentServerName(name)
		if normalizedName == DefaultAgentServerName {
			normalized[DefaultAgentServerName] = mergeDefaultAgentServerConfig(cfg)
			continue
		}
		if normalizedName == LocalAgentServerName {
			normalized[LocalAgentServerName] = mergeLocalAgentServerConfig(cfg)
			continue
		}
		normalized[normalizedName] = cfg
	}
	return normalized
}

func NormalizeAgentServerName(serverName string) string {
	if serverName == "" || serverName == LegacyDefaultAgentServerName {
		return DefaultAgentServerName
	}
	return serverName
}

func defaultAgentServerConfig() AgentServerConfig {
	return AgentServerConfig{
		Command: "",
	}
}

func defaultLocalAgentServerConfig() AgentServerConfig {
	return AgentServerConfig{
		Type:    "local",
		Command: "",
	}
}

func mergeDefaultAgentServerConfig(cfg AgentServerConfig) AgentServerConfig {
	merged := defaultAgentServerConfig()
	merged.Type = cfg.Type
	if cfg.Command != "" && !isLegacySelfCommand(cfg.Command) {
		merged.Command = cfg.Command
		merged.Args = cfg.Args
	}
	merged.Env = cfg.Env
	merged.Binary = cfg.Binary
	merged.DefaultConfigOptions = cfg.DefaultConfigOptions
	return merged
}

func mergeLocalAgentServerConfig(cfg AgentServerConfig) AgentServerConfig {
	merged := defaultLocalAgentServerConfig()
	if cfg.Command != "" && !isLegacySelfCommand(cfg.Command) {
		merged.Command = cfg.Command
		merged.Args = cfg.Args
	}
	if cfg.Type != "" {
		merged.Type = cfg.Type
	}
	merged.Env = cfg.Env
	merged.Binary = cfg.Binary
	merged.DefaultConfigOptions = cfg.DefaultConfigOptions
	return merged
}

func isLegacySelfCommand(command string) bool {
	_, ok := legacySelfCommands[command]
	return ok
}

func defaultInitializeRequest() acpsdk.InitializeRequest {
	return acpsdk.InitializeRequest{
		ProtocolVersion: acpsdk.ProtocolVersionNumber,
		ClientInfo: &acpsdk.Implementation{
			Name:    "camber-helper",
			Version: version.Tag,
		},
		ClientCapabilities: acpsdk.ClientCapabilities{
			Fs: acpsdk.FileSystemCapabilities{
				ReadTextFile:  true,
				WriteTextFile: true,
			},
			Elicitation: elicitationCapabilities(),
		},
	}
}

// elicitationCapabilities is what the helper advertises on behalf of every
// surface: elicitations are helper-owned state (the approval store), so
// support does not vary by surface. Form only — surfaces do not render
// url-mode elicitations yet.
func elicitationCapabilities() *acpsdk.ElicitationCapabilities {
	return &acpsdk.ElicitationCapabilities{
		Form: &acpsdk.ElicitationFormCapabilities{},
	}
}

func buildInitializeRequest(req *acpsdk.InitializeRequest) acpsdk.InitializeRequest {
	if req == nil {
		return defaultInitializeRequest()
	}
	initReq := *req
	if initReq.ProtocolVersion == 0 {
		initReq.ProtocolVersion = acpsdk.ProtocolVersionNumber
	}
	if initReq.ClientCapabilities.Elicitation == nil {
		initReq.ClientCapabilities.Elicitation = elicitationCapabilities()
	}
	return initReq
}

// startLocked spawns the subprocess and performs the ACP handshake.
// It must be called with p.mu held.
func (p *process) startLocked(ctx context.Context, cfg startConfig, client *acpClient, initReq acpsdk.InitializeRequest) error {
	if p.isRunningLocked() {
		return nil
	}

	err := p.spawnAndInitializeLocked(ctx, cfg, client, initReq)
	var handshakeErr *initializeHandshakeError
	if err == nil || !errors.As(err, &handshakeErr) {
		return err
	}
	if ctx.Err() != nil {
		return err
	}
	if clearErr := clearNpxCacheEntry(cfg); clearErr != nil {
		slog.Debug("acpproxy: initialize failed; not retrying", "server", cfg.serverName, "reason", clearErr)
		return err
	}
	slog.Warn("acpproxy: initialize failed; cleared npx cache entry and retrying once", "server", cfg.serverName, "error", err)
	return p.spawnAndInitializeLocked(ctx, cfg, client, initReq)
}

// spawnAndInitializeLocked must be called with p.mu held.
func (p *process) spawnAndInitializeLocked(ctx context.Context, cfg startConfig, client *acpClient, initReq acpsdk.InitializeRequest) error {
	env, err := buildProcessEnv(cfg)
	if err != nil {
		return err
	}
	binary, err := resolveExecutablePath(cfg.binary, env)
	if err != nil {
		return missingRuntimeLaunchError(cfg.serverName, cfg.binary, err)
	}

	args := append([]string{binary}, cfg.extraArgs...)
	slog.Info("acpproxy: starting subprocess", "server", cfg.serverName, "cmd", args, "cwd", cfg.processDir)

	cmd := exec.Command(binary, cfg.extraArgs...)
	configureProcessCommand(cmd)
	cmd.Env = env
	if cfg.processDir != "" {
		cmd.Dir = cfg.processDir
	}

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return fmt.Errorf("acpproxy: stdin pipe: %w", err)
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("acpproxy: stdout pipe: %w", err)
	}

	stderr, err := cmd.StderrPipe()
	if err != nil {
		return fmt.Errorf("acpproxy: stderr pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("acpproxy: start: %w", err)
	}
	slog.Info("acpproxy: subprocess started", "server", cfg.serverName, "pid", cmd.Process.Pid)

	stderrTail := newLineTail(20)
	stderrDone := make(chan struct{})
	go func() {
		defer close(stderrDone)
		scanStderr(cfg.serverName, stderr, stderrTail, func(err error) {
			p.failActivePromptsFor(cmd, err)
		})
	}()

	// Tee stdout to a sniffer that forwards auth progress notifications to the
	// webview. The Go SDK only routes underscore-prefixed methods through
	// extension handlers, so we intercept this non-standard method before it
	// reaches the SDK.
	sniffPipeR, sniffPipeW := io.Pipe()
	teedStdout := io.TeeReader(stdout, sniffPipeW)
	go scanForAuthUpdates(cfg.serverName, sniffPipeR, client.notify)

	configuration := &sessionConfigurationCache{}
	conn := acpsdk.NewClientSideConnection(&configurationClient{acpClient: client, configuration: configuration}, stdin, teedStdout)

	initCtx, cancelInitialize := context.WithTimeout(ctx, initializeHandshakeTimeout)
	defer cancelInitialize()

	initResp, err := conn.Initialize(initCtx, initReq)
	if err != nil {
		stdin.Close()
		_ = killProcessTree(cmd)
		_ = cmd.Wait()
		select {
		case <-stderrDone:
		case <-time.After(100 * time.Millisecond):
		}
		return initializeError(err, stderrTail.String())
	}

	exited := make(chan struct{})
	p.serverName = cfg.serverName
	p.cmd = cmd
	p.conn = conn
	p.configuration = configuration
	p.initResp = &initResp
	initReqCopy := initReq
	p.initReq = &initReqCopy
	p.stdin = stdin
	p.exited = exited
	p.onStop = func() {
		slog.Info("acpproxy: subprocess stopped", "server", cfg.serverName)
		if cfg.onExit != nil {
			cfg.onExit(cfg.serverName, nil)
		}
	}
	p.state = processState{kind: processStateRunning}

	go p.watchExit(cfg.serverName, cmd, exited, cfg.onExit)
	go p.watchDisconnect(cfg.serverName, cmd, conn, cfg.onExit)

	slog.Info("acpproxy: connected", "server", cfg.serverName, "protocol", initResp.ProtocolVersion)
	return nil
}

// watchDisconnect handles the case where the ACP JSON-RPC stream closes but
// the wrapper process (commonly npx) stays alive. Waiting only on cmd.Wait
// leaves the process marked running and every later request reuses a dead
// connection, returning "peer disconnected before response" immediately.
func (p *process) watchDisconnect(serverName string, cmd *exec.Cmd, conn *acpsdk.ClientSideConnection, onExit func(serverName string, err error)) {
	<-conn.Done()
	if !p.markDisconnected(cmd, conn) {
		return
	}

	if cmd.Process != nil {
		_ = killProcessTree(cmd)
	}
	err := errors.New("ACP peer disconnected")
	slog.Info("acpproxy: subprocess connection closed", "server", serverName, "error", err)
	if onExit != nil {
		onExit(serverName, err)
	}
}

func (p *process) watchExit(serverName string, cmd *exec.Cmd, exited chan struct{}, onExit func(serverName string, err error)) {
	err := cmd.Wait()
	// Announce the reap before the state check: stop has already cleared the
	// state by the time it waits here, and it must still observe the exit.
	close(exited)
	if !p.markExited(cmd) {
		return
	}

	if err != nil {
		slog.Info("acpproxy: subprocess exited", "server", serverName, "error", err)
	} else {
		slog.Info("acpproxy: subprocess exited", "server", serverName)
	}
	if onExit != nil {
		onExit(serverName, err)
	}
}

func (p *process) markExited(cmd *exec.Cmd) bool {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.cmd != cmd {
		return false
	}

	p.resetLocked(processState{kind: processStateExited, exitedAt: time.Now()})
	return true
}

func (p *process) markDisconnected(cmd *exec.Cmd, conn *acpsdk.ClientSideConnection) bool {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.cmd != cmd || p.conn != conn || !p.isRunningLocked() {
		return false
	}

	p.resetLocked(processState{kind: processStateExited, exitedAt: time.Now()})
	return true
}

// newSessionLocked creates a new ACP session on an already-running process,
// replacing any existing session. Must be called with p.mu held.
func (p *process) newSessionLocked(ctx context.Context, req acpsdk.NewSessionRequest) (*acpsdk.NewSessionResponse, error) {
	if !p.isRunningLocked() {
		return nil, fmt.Errorf("acpproxy: not initialized; call initialize first")
	}

	// promptRuntimeErr latches a fatal runtime failure reported only on the
	// subprocess's stderr (e.g. the MCP connector credentials error) so the
	// next prompt can fail fast with an actionable message. Config probes
	// recur throughout a run (the client refreshes its config cache with
	// them); letting one clear the latch would silently drop that signal
	// before the real prompt waiting on it ever sees it.
	if !isConfigProbeSession(req.Meta) {
		p.promptRuntimeErr = nil
	}
	resp, err := p.conn.NewSession(ctx, req)
	if err != nil {
		return nil, preserveACPError("acpproxy: new session", err)
	}
	p.adoptSessionLocked(resp.SessionId, isConfigProbeSession(req.Meta))
	p.configuration.capture(string(resp.SessionId), resp.ConfigOptions, resp.Modes)
	slog.Info("acpproxy: session created", "session_id", string(resp.SessionId), "resp", resp)
	return &resp, nil
}

// loadSessionLocked loads an existing ACP session on an already-running process,
// replacing any existing session. Must be called with p.mu held.
func (p *process) loadSessionLocked(ctx context.Context, req acpsdk.LoadSessionRequest) (*acpsdk.LoadSessionResponse, error) {
	if !p.isRunningLocked() {
		return nil, fmt.Errorf("acpproxy: not initialized; call initialize first")
	}

	if !isConfigProbeSession(req.Meta) {
		p.promptRuntimeErr = nil
	}
	resp, err := p.conn.LoadSession(ctx, req)
	if err != nil {
		return nil, preserveACPError("acpproxy: load session", err)
	}
	// No client sends the probe marker on load today, but the marker is
	// documented as valid here too (configProbeMetaKey), so route this path
	// through the same rule and the bug cannot come back.
	p.adoptSessionLocked(req.SessionId, isConfigProbeSession(req.Meta))
	p.configuration.capture(string(req.SessionId), resp.ConfigOptions, resp.Modes)
	slog.Info("acpproxy: session loaded", "session_id", string(req.SessionId))
	return &resp, nil
}

// resumeSessionLocked resumes an existing ACP session on an already-running
// process without replaying its transcript. Must be called with p.mu held.
func (p *process) resumeSessionLocked(ctx context.Context, req acpsdk.ResumeSessionRequest) (*acpsdk.ResumeSessionResponse, error) {
	if !p.isRunningLocked() {
		return nil, fmt.Errorf("acpproxy: not initialized; call initialize first")
	}

	if !isConfigProbeSession(req.Meta) {
		p.promptRuntimeErr = nil
	}
	resp, err := p.conn.ResumeSession(ctx, req)
	if err != nil {
		return nil, preserveACPError("acpproxy: resume session", err)
	}
	// See loadSessionLocked: same latent-probe path, kept consistent.
	p.adoptSessionLocked(req.SessionId, isConfigProbeSession(req.Meta))
	p.configuration.capture(string(req.SessionId), resp.ConfigOptions, resp.Modes)
	slog.Info("acpproxy: session resumed", "session_id", string(req.SessionId))
	return &resp, nil
}

// stop closes the subprocess's stdin and lets it exit on its own before
// escalating to a signal. Agents flush state as they shut down — `pool acp`
// writes the record mapping an ACP session to its backend session — so killing
// one outright can leave a conversation that replays empty and can never be
// prompted again (PE-2460). Escalation still bounds the wait so an agent that
// ignores EOF cannot outlive the helper.
func (p *process) stop() error {
	serverName, cmd, exited, onStop, closeErr := func() (string, *exec.Cmd, chan struct{}, func(), error) {
		p.mu.Lock()
		defer p.mu.Unlock()

		if !p.isRunningLocked() {
			p.resetLocked(processState{})
			return p.serverName, nil, nil, nil, nil
		}

		var closeErr error
		if p.stdin != nil {
			closeErr = p.stdin.Close()
		}
		serverName, cmd, exited, onStop := p.serverName, p.cmd, p.exited, p.onStop
		p.resetLocked(processState{})
		return serverName, cmd, exited, onStop, closeErr
	}()

	if onStop != nil {
		onStop()
	}
	awaitProcessExit(serverName, cmd, exited)
	return closeErr
}

// awaitProcessExit waits for a stopping subprocess to exit, escalating to
// terminate and then kill. The process group is signalled rather than only the
// direct child so wrapper processes (commonly npx) cannot leave the real agent
// running.
func awaitProcessExit(serverName string, cmd *exec.Cmd, exited <-chan struct{}) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	if waitForClose(exited, processStdinExitGrace) {
		return
	}

	slog.Warn("acpproxy: subprocess still running after stdin close; terminating",
		"server", serverName, "pid", cmd.Process.Pid, "after", processStdinExitGrace)
	_ = terminateProcessTree(cmd)
	if waitForClose(exited, processSignalExitGrace) {
		return
	}

	slog.Warn("acpproxy: subprocess ignored terminate; killing",
		"server", serverName, "pid", cmd.Process.Pid, "after", processSignalExitGrace)
	_ = killProcessTree(cmd)
}

func waitForClose(done <-chan struct{}, timeout time.Duration) bool {
	if done == nil {
		return false
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-done:
		return true
	case <-timer.C:
		return false
	}
}

func (p *process) initializeResponse() (*acpsdk.InitializeResponse, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.initResp == nil {
		return nil, fmt.Errorf("acpproxy: initialize response unavailable")
	}

	resp := *p.initResp
	return &resp, nil
}

// supportsSessionClose reports whether the connected agent advertises
// session/close plus a way to reopen a closed session (session/resume or
// loadSession). Without a reopen path, closing would strand the conversation.
func (p *process) supportsSessionClose() bool {
	initResp, err := p.initializeResponse()
	if err != nil {
		return false
	}
	caps := initResp.AgentCapabilities
	if caps.SessionCapabilities.Close == nil {
		return false
	}
	return caps.SessionCapabilities.Resume != nil || caps.LoadSession
}

// ConfigFn provides dynamic access to handler configuration.
type ConfigFn func() HandlerConfig

// ensureStarted lazily initializes the subprocess on first use.
func (p *process) ensureStarted(ctx context.Context, cfgFn ConfigFn, serverName string, client *acpClient, initReq *acpsdk.InitializeRequest, onExit func(serverName string, err error)) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.isRunningLocked() {
		return nil
	}
	if err := p.waitForRestartBackoffLocked(ctx); err != nil {
		return err
	}

	cfg := cfgFn()
	agentServers := NormalizeAgentServers(cfg.AgentServers)
	serverCfg, ok := agentServers[serverName]
	if !ok {
		return fmt.Errorf("acpproxy: unknown agent server %q", serverName)
	}
	if shouldResolveBundledCamberBinary(serverName, serverCfg) {
		resolved, err := defaultCamberAgentServerConfig(ctx)
		if err != nil {
			return err
		}
		resolved.Type = serverCfg.Type
		resolved.DefaultConfigOptions = serverCfg.DefaultConfigOptions
		resolved.Env = mergeStringMaps(resolved.Env, serverCfg.Env)
		serverCfg = resolved
	}
	if cfg.AgentServerEnvProvider != nil {
		env, err := cfg.AgentServerEnvProvider(ctx, serverName)
		if err != nil {
			return fmt.Errorf("acpproxy: agent server %q environment: %w", serverName, err)
		}
		serverCfg.Env = mergeStringMaps(serverCfg.Env, env)
	}
	if serverCfg.Command == "" && len(serverCfg.Binary) == 0 {
		return fmt.Errorf("acpproxy: agent server %q command is required", serverName)
	}

	startCfg := startConfig{
		serverName: serverName,
		env:        serverCfg.Env,
		onExit:     onExit,
	}

	if len(serverCfg.Binary) > 0 {
		binary, args, env, err := PrepareRegistryBinary(ctx, serverName, serverCfg.Binary)
		if err != nil {
			return err
		}
		startCfg.binary = binary
		startCfg.extraArgs = args
		startCfg.env = mergeStringMaps(startCfg.env, env)
	} else {
		startCfg.binary = serverCfg.Command
		startCfg.extraArgs = append([]string{}, serverCfg.Args...)
	}
	startCfg.processDir = cfg.WorkingDir

	return p.startLocked(ctx, startCfg, client, buildInitializeRequest(initReq))
}

func shouldResolveBundledCamberBinary(serverName string, cfg AgentServerConfig) bool {
	if cfg.Type == "registry" || cfg.Command != "" || len(cfg.Binary) > 0 {
		return false
	}
	return serverName == DefaultAgentServerName || serverName == LocalAgentServerName
}

// waitForRestartBackoffLocked keeps repeated starts from thrashing after a
// subprocess exits. It must be called with p.mu held.
func (p *process) waitForRestartBackoffLocked(ctx context.Context) error {
	if p.state.kind != processStateExited {
		return nil
	}

	retryAt := p.state.exitedAt.Add(processRestartBackoff)
	delay := time.Until(retryAt)
	if delay <= 0 {
		return nil
	}

	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (p *process) connForSession() (*acpsdk.ClientSideConnection, acpsdk.SessionId, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	if !p.isRunningLocked() {
		return nil, "", fmt.Errorf("acpproxy: not initialized; call initialize first")
	}

	return p.conn, p.session, nil
}

func (p *process) contextForPrompt(parent context.Context, conn *acpsdk.ClientSideConnection) (context.Context, func(), error) {
	p.mu.Lock()
	if !p.isRunningLocked() || p.conn != conn {
		p.mu.Unlock()
		return nil, nil, fmt.Errorf("acpproxy: not initialized; call initialize first")
	}
	if p.promptRuntimeErr != nil {
		err := p.promptRuntimeErr
		p.mu.Unlock()
		return nil, nil, err
	}

	ctx, cancel := context.WithCancelCause(parent)
	p.nextPromptID++
	id := p.nextPromptID
	if p.promptCancels == nil {
		p.promptCancels = map[uint64]context.CancelCauseFunc{}
	}
	p.promptCancels[id] = cancel
	p.mu.Unlock()

	release := func() {
		p.mu.Lock()
		delete(p.promptCancels, id)
		p.mu.Unlock()
		cancel(nil)
	}
	return ctx, release, nil
}

// failActivePromptsFor records a subprocess runtime failure only if cmd is
// still the active subprocess. A stopped process's stderr scanner can drain
// after its replacement starts and must not poison the replacement's prompts.
func (p *process) failActivePromptsFor(cmd *exec.Cmd, err error) {
	if err == nil {
		return
	}

	p.mu.Lock()
	if !p.isRunningLocked() || p.cmd != cmd {
		p.mu.Unlock()
		return
	}
	p.promptRuntimeErr = err
	cancels := make([]context.CancelCauseFunc, 0, len(p.promptCancels))
	for _, cancel := range p.promptCancels {
		cancels = append(cancels, cancel)
	}
	p.mu.Unlock()

	for _, cancel := range cancels {
		cancel(err)
	}
}

func buildProcessEnv(cfg startConfig) ([]string, error) {
	env := os.Environ()
	env = shellenv.Merge(env, userShellEnvProvider())
	env = filterThirdPartyEnv(env)
	if shouldUseCamberNPMCache(cfg) {
		cacheDir, err := camberNPMCacheDir()
		if err != nil {
			return nil, err
		}
		if err := pruneBrokenNpxCache(cacheDir); err != nil {
			return nil, err
		}
		env = filterEnvKeys(env, npmConfigCacheEnvKey, npmConfigCacheEnvKeyUpper)
		env = append(env, npmConfigCacheEnvKey+"="+cacheDir)
	}

	for _, key := range sortedMapKeys(cfg.env) {
		env = append(env, key+"="+cfg.env[key])
	}

	// Guarantee a usable HOME. Some launch contexts (and shell-env extraction)
	// can leave HOME empty, which makes agents resolve ~/.poolside to "/.poolside"
	// and fail on the read-only root filesystem.
	env = ensureHomeEnv(env)

	return env, nil
}

// ensureHomeEnv guarantees the spawned process gets a usable HOME. Some launch
// contexts (and shell-env extraction) leave HOME blank or "/", which makes agents
// resolve ~/.poolside to "/.poolside" and fail on the read-only root filesystem.
// We only substitute when the inherited HOME is unusable, so a deliberately set
// custom HOME is preserved.
func ensureHomeEnv(env []string) []string {
	inherited := envValue(env, "HOME")
	if isUsableHomeDir(inherited) {
		return env
	}
	real := resolveRealHomeDir()
	if !isUsableHomeDir(real) {
		return env
	}
	env = filterEnvKeys(env, "HOME")
	env = append(env, "HOME="+real)
	slog.Info("acpproxy: pinned agent HOME", "from", inherited, "to", real)
	return env
}

func isUsableHomeDir(home string) bool {
	return home != "" && home != "/"
}

// resolveRealHomeDir returns the user's home directory, preferring the OS
// password database (which survives a broken $HOME) over $HOME itself.
func resolveRealHomeDir() string {
	// user.Current reads the password database, so it survives a broken $HOME.
	if u, err := user.Current(); err == nil && isUsableHomeDir(u.HomeDir) {
		return u.HomeDir
	}
	if h, err := os.UserHomeDir(); err == nil && isUsableHomeDir(h) {
		return h
	}
	return ""
}

func resolveExecutablePath(binary string, env []string) (string, error) {
	if binary == "" || hasPathSeparator(binary) {
		return binary, nil
	}

	for _, dir := range filepath.SplitList(envValue(env, "PATH")) {
		if dir == "" {
			continue
		}
		for _, name := range executableCandidateNames(binary, env) {
			candidate := filepath.Join(dir, name)
			if isExecutableFile(candidate) {
				return candidate, nil
			}
		}
	}

	resolved, err := exec.LookPath(binary)
	if err == nil {
		return resolved, nil
	}
	return "", fmt.Errorf("acpproxy: resolve executable %q: %w", binary, err)
}

func hasPathSeparator(path string) bool {
	return strings.ContainsRune(path, os.PathSeparator) ||
		(runtime.GOOS == "windows" && strings.ContainsRune(path, '/'))
}

func executableCandidateNames(binary string, env []string) []string {
	if runtime.GOOS != "windows" || filepath.Ext(binary) != "" {
		return []string{binary}
	}

	pathExt := envValue(env, "PATHEXT")
	if pathExt == "" {
		pathExt = ".COM;.EXE;.BAT;.CMD"
	}

	names := []string{binary}
	for _, ext := range strings.Split(pathExt, ";") {
		if ext == "" {
			continue
		}
		names = append(names, binary+ext)
	}
	return names
}

func isExecutableFile(path string) bool {
	stat, err := os.Stat(path)
	if err != nil || stat.IsDir() {
		return false
	}
	if runtime.GOOS == "windows" {
		return true
	}
	return stat.Mode()&0o111 != 0
}

func envValue(env []string, key string) string {
	var value string
	for _, entry := range env {
		entryKey, entryValue, ok := strings.Cut(entry, "=")
		if ok && entryKey == key {
			value = entryValue
		}
	}
	return value
}

func shouldUseCamberNPMCache(cfg startConfig) bool {
	if filepath.Base(cfg.binary) != "npx" {
		return false
	}
	return !mapHasAnyKey(cfg.env, npmConfigCacheEnvKey, npmConfigCacheEnvKeyUpper)
}

func camberNPMCacheDir() (string, error) {
	cacheDir, err := os.UserCacheDir()
	if err != nil {
		cacheDir = os.TempDir()
		if cacheDir == "" {
			return "", fmt.Errorf("acpproxy: npm cache dir: %w", err)
		}
	}
	return filepath.Join(cacheDir, "poolside", "acp", "npm"), nil
}

func pruneBrokenNpxCache(cacheDir string) error {
	npxDir := filepath.Join(cacheDir, "_npx")
	entries, err := os.ReadDir(npxDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("acpproxy: read npm npx cache: %w", err)
	}

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		installDir := filepath.Join(npxDir, entry.Name())
		if _, err := os.Stat(filepath.Join(installDir, "package.json")); err == nil {
			continue
		} else if !os.IsNotExist(err) {
			return fmt.Errorf("acpproxy: inspect npm npx cache: %w", err)
		}
		if err := os.RemoveAll(installDir); err != nil {
			return fmt.Errorf("acpproxy: prune npm npx cache: %w", err)
		}
	}
	return nil
}

// clearNpxCacheEntry removes the agent's install dir from the helper-owned npx
// cache.
func clearNpxCacheEntry(cfg startConfig) error {
	if !shouldUseCamberNPMCache(cfg) {
		return errors.New("agent does not use the helper-owned npm cache")
	}
	pkgs := npxPackageSpecs(cfg.extraArgs)
	if len(pkgs) == 0 {
		return errors.New("no npx package spec in agent args")
	}
	if len(pkgs) > 1 {
		return errors.New("multiple npx package specs; cache key not reproducible")
	}
	cacheDir, err := camberNPMCacheDir()
	if err != nil {
		return err
	}
	installDir := filepath.Join(cacheDir, "_npx", npxInstallDirName(pkgs[0]))
	if _, err := os.Stat(installDir); err != nil {
		return fmt.Errorf("no npx cache entry: %w", err)
	}
	if err := os.RemoveAll(installDir); err != nil {
		return fmt.Errorf("remove npx cache entry: %w", err)
	}
	slog.Info("acpproxy: cleared npx cache entry", "packages", pkgs, "dir", installDir)
	return nil
}

// npxInstallDirName mirrors libnpmexec's cache key for a single package spec.
func npxInstallDirName(pkg string) string {
	sum := sha512.Sum512([]byte(pkg))
	return hex.EncodeToString(sum[:])[:16]
}

var npxBooleanFlags = map[string]struct{}{
	"-y": {}, "--yes": {}, "--no": {}, "-q": {}, "--quiet": {},
}

// npxPackageSpecs returns explicit package options or the positional package.
// It returns nil when the positional package is ambiguous.
func npxPackageSpecs(args []string) []string {
	var packages []string
	var positional string
	ambiguous := false
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--package" || arg == "-p":
			if i+1 < len(args) {
				i++
				packages = append(packages, args[i])
			}
		case strings.HasPrefix(arg, "--package="):
			packages = append(packages, strings.TrimPrefix(arg, "--package="))
		case strings.HasPrefix(arg, "-p="):
			packages = append(packages, strings.TrimPrefix(arg, "-p="))
		case arg == "" || strings.Contains(arg, "="):
		case strings.HasPrefix(arg, "-"):
			if _, ok := npxBooleanFlags[arg]; !ok && positional == "" {
				ambiguous = true
			}
		case positional == "":
			positional = arg
		}
	}
	if len(packages) > 0 {
		return packages
	}
	if positional != "" && !ambiguous {
		return []string{positional}
	}
	return nil
}

func filterThirdPartyEnv(env []string) []string {
	filtered := make([]string, 0, len(env))
	for _, entry := range env {
		key, _, _ := strings.Cut(entry, "=")
		if key == "CLAUDECODE" ||
			strings.HasPrefix(key, "CLAUDE_CODE_") ||
			strings.HasPrefix(key, "CLAUDE_AGENT_SDK_") {
			continue
		}
		filtered = append(filtered, entry)
	}
	return filtered
}

func filterEnvKeys(env []string, keys ...string) []string {
	if len(keys) == 0 {
		return env
	}
	remove := make(map[string]struct{}, len(keys))
	for _, key := range keys {
		remove[key] = struct{}{}
	}

	filtered := make([]string, 0, len(env))
	for _, entry := range env {
		key, _, _ := strings.Cut(entry, "=")
		if _, ok := remove[key]; ok {
			continue
		}
		filtered = append(filtered, entry)
	}
	return filtered
}

func mapHasAnyKey[V any](m map[string]V, keys ...string) bool {
	for _, key := range keys {
		if _, ok := m[key]; ok {
			return true
		}
	}
	return false
}

type lineTail struct {
	mu    sync.Mutex
	lines []string
	limit int
}

func newLineTail(limit int) *lineTail {
	return &lineTail{limit: limit}
}

func (t *lineTail) Add(line string) {
	t.mu.Lock()
	defer t.mu.Unlock()

	if t.limit <= 0 {
		return
	}
	t.lines = append(t.lines, line)
	if len(t.lines) > t.limit {
		copy(t.lines, t.lines[len(t.lines)-t.limit:])
		t.lines = t.lines[:t.limit]
	}
}

func (t *lineTail) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()

	return strings.TrimSpace(strings.Join(t.lines, "\n"))
}

type initializeHandshakeError struct {
	err error
}

func (e *initializeHandshakeError) Error() string { return e.err.Error() }

func (e *initializeHandshakeError) Unwrap() error { return e.err }

func initializeError(err error, stderrTail string) error {
	if strings.TrimSpace(stderrTail) == "" {
		return &initializeHandshakeError{err: fmt.Errorf("acpproxy: initialize: %w", err)}
	}
	return &initializeHandshakeError{err: fmt.Errorf("acpproxy: initialize: %w; subprocess stderr:\n%s", err, stderrTail)}
}

type mcpConnectorCredentialsError struct{}

func (*mcpConnectorCredentialsError) Error() string {
	return "MCP connector credentials were rejected; reconnect the connector in Settings, then retry"
}

func scanStderr(serverName string, r io.Reader, tail *lineTail, reportRuntimeError func(error)) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if tail != nil {
			tail.Add(line)
		}
		slog.Info("acpproxy: subprocess stderr", "server", serverName, "line", line)
		if reportRuntimeError != nil {
			if err := classifyRuntimeStderr(line); err != nil {
				reportRuntimeError(err)
			}
		}
	}
	if err := scanner.Err(); err != nil {
		slog.Info("acpproxy: subprocess stderr scanner error", "server", serverName, "error", err)
	}
}

func classifyRuntimeStderr(line string) error {
	lower := strings.ToLower(line)
	if strings.Contains(lower, "rmcp::transport::worker") &&
		strings.Contains(lower, "worker quit with fatal:") &&
		strings.Contains(lower, "authrequired(authrequirederror") &&
		strings.Contains(lower, "www_authenticate_header") {
		return &mcpConnectorCredentialsError{}
	}
	return nil
}

// scanForAuthUpdates reads NDJSON from the agent's stdout (via a tee) and
// forwards auth progress notifications to the client. The Go SDK only
// dispatches underscore-prefixed methods through extension handlers, so we
// intercept this non-standard notification before the SDK rejects it.
func scanForAuthUpdates(serverName string, r io.Reader, notify notifyFn) {
	reader := bufio.NewReader(r)
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			scanAuthUpdateLine(serverName, line, notify)
		}
		if err == nil {
			continue
		}
		if !errors.Is(err, io.EOF) {
			slog.Info("acpproxy: stdout sniffer read error", "server", serverName, "error", err)
		}
		return
	}
}

func scanAuthUpdateLine(serverName string, line []byte, notify notifyFn) {
	if !bytes.Contains(line, []byte(authenticateUpdateMethod)) {
		return
	}

	line = bytes.TrimSpace(line)
	if len(line) == 0 {
		return
	}

	var msg struct {
		Method string         `json:"method"`
		ID     any            `json:"id,omitempty"`
		Params map[string]any `json:"params"`
	}
	// Best-effort parse; non-JSON or malformed lines are ignored.
	if err := json.Unmarshal(line, &msg); err != nil {
		return
	}
	// Only forward NOTIFICATIONS — requests would need a response.
	if msg.Method != authenticateUpdateMethod || msg.ID != nil {
		return
	}
	if notify == nil {
		return
	}
	params := msg.Params
	if params == nil {
		params = map[string]any{}
	}
	slog.Info("acpproxy: forwarding auth update", "server", serverName, "params", params)
	notify(context.Background(), msg.Method, params)
}

func sortedMapKeys[V any](m map[string]V) []string {
	if len(m) == 0 {
		return nil
	}
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	return keys
}
