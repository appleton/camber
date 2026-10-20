package acpproxy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"reflect"
	"strings"
	"sync"

	acpsdk "github.com/coder/acp-go-sdk"
	"github.com/google/uuid"

	"github.com/appleton/camber/pkg/acp"
	"github.com/appleton/camber/pkg/camber-helper/internal/gopls/gotoolsinternal/jsonrpc2"
	"github.com/appleton/camber/pkg/camber-helper/internal/handler/acpnav"
	"github.com/appleton/camber/pkg/camber-helper/internal/handler/approvals"
	"github.com/appleton/camber/pkg/camber-helper/methods"
	"github.com/tliron/glsp"
)

// preserveACPError keeps the original JSON-RPC error code (e.g. -32000
// AUTH_REQUIRED) when the agent returns one. Without this the helper's
// jsonrpc2 layer rewrites unknown errors to -32603 (Internal error) and the
// webview can't tell auth-required apart from other failures.
func preserveACPError(prefix string, err error) error {
	if err == nil {
		return nil
	}
	var reqErr *acpsdk.RequestError
	if errors.As(err, &reqErr) && reqErr != nil {
		wire := &jsonrpc2.WireError{Code: int64(reqErr.Code), Message: reqErr.Message}
		if reqErr.Data != nil {
			wire.SetError(reqErr.Data)
		}
		return wire
	}
	return fmt.Errorf("%s: %w", prefix, err)
}

// isSessionGoneError matches agent responses meaning "no such live session".
// Adapters express this inconsistently (claude-agent-acp raises a plain
// internal error with a "Session not found" detail), so match on the message.
func isSessionGoneError(err error) bool {
	var reqErr *acpsdk.RequestError
	if !errors.As(err, &reqErr) || reqErr == nil {
		return false
	}
	if strings.Contains(strings.ToLower(reqErr.Message), "session not found") {
		return true
	}
	data, marshalErr := json.Marshal(reqErr.Data)
	return marshalErr == nil && strings.Contains(strings.ToLower(string(data)), "session not found")
}

const steeringTurnBoundaryDiagnostic = "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"

// isSteeringTurnBoundaryError matches a Claude Agent SDK diagnostic emitted
// after an injected user message successfully takes over the active turn. The
// adapter has already streamed the steered response at this point, so the
// diagnostic is a turn-boundary signal rather than a failed prompt.
func isSteeringTurnBoundaryError(err error) bool {
	return err != nil && strings.Contains(err.Error(), steeringTurnBoundaryDiagnostic)
}

// Handler proxies ACP methods to one `pool acp` (or third-party) subprocess
// per configured agent server.
type Handler struct {
	mu              sync.Mutex
	procs           map[string]*process
	clients         map[string]*acpClient
	promptsInFlight map[promptSessionKey]*activeTurn
	// idleSessions excludes prompts while a control operation configures or
	// tears down a session. It shares mu with prompt turn reservations.
	idleSessions          map[promptSessionKey]struct{}
	reservedWorkspaces    map[string]struct{}
	workspaceSessionCalls map[string]int
	// finishedTurns keeps recent turnID -> result so a client that lost its
	// connection mid-turn can re-issue the same prompt and get the stored
	// outcome instead of running a duplicate turn.
	finishedTurns     map[string]*activeTurn
	finishedTurnOrder []string
	// loadScopes maps sessions with a session/load in flight to the client
	// that requested it; loadDone signals the load's completion to waiters.
	loadScopes     map[promptSessionKey]string
	loadDone       map[promptSessionKey]chan struct{}
	readFile       ReadFileFn
	configFn       ConfigFn
	liveStatusSink LiveStatusSink
	events         SessionEventSink
	// approvals holds pending permission prompts and elicitations as
	// helper-owned state; agent requests block on it and surfaces answer via
	// camber/acp/approvals/respond. Set once at wiring time.
	approvals *approvals.Store
	// closed is set by Close, before it stops the processes. A session call
	// that arrives during shutdown must not restart an agent (see
	// processReadyForSession): nothing would stop the new subprocess, leaving
	// an agent orphaned past helper exit.
	closed bool
}

// promptSessionKey identifies one conversation's turn across every connected
// surface: prompts are tracked per {agent server, session}, not per client.
type promptSessionKey struct {
	agentServer string
	sessionID   string
}

type LiveStatusSink interface {
	SetConversationLiveStatus(context.Context, *glsp.Context, string, string, acpnav.ConversationLiveStatusPatch) error
	CompletePrompt(context.Context, *glsp.Context, string, string) error
	ClearAgentServerInFlightStatus(context.Context, *glsp.Context, string) error
	// UpdateConversationTitle persists an agent-authored title in the nav store
	// so it survives even when no webview has materialized the session.
	UpdateConversationTitle(ctx context.Context, gCtx *glsp.Context, agentServer, sessionID, title string) error
	// BindConversationSession records (conversationID → sessionID) in the nav
	// store at session/new time, so live status keyed by session id is
	// attachable before any turn starts.
	BindConversationSession(ctx context.Context, gCtx *glsp.Context, conversationID, agentServer, sessionID, cwd string) error
}

type conversationHandoffSink interface {
	BindConversationSessionHandoff(ctx context.Context, gCtx *glsp.Context, conversationID, agentServer, sessionID, cwd, handoffID string) error
}

func NewHandler(cfg ConfigFn, readFile ReadFileFn, liveStatusSink LiveStatusSink) *Handler {
	return &Handler{
		configFn:        cfg,
		readFile:        readFile,
		liveStatusSink:  liveStatusSink,
		procs:           map[string]*process{},
		clients:         map[string]*acpClient{},
		promptsInFlight: map[promptSessionKey]*activeTurn{},
		finishedTurns:   map[string]*activeTurn{},
		loadScopes:      map[promptSessionKey]string{},
		loadDone:        map[promptSessionKey]chan struct{}{},
	}
}

// SetApprovals installs the helper-owned approval store. Call once at wiring
// time, before any agent can request a permission or elicitation.
func (h *Handler) SetApprovals(store *approvals.Store) {
	h.approvals = store
}

// RespondApproval answers one pending approval on behalf of a surface.
func (h *Handler) RespondApproval(ctx context.Context, params *methods.ACPApprovalsRespondParams, gCtx *glsp.Context) (methods.ACPApprovalsRespondOutput, error) {
	if h.approvals == nil {
		return methods.ACPApprovalsRespondOutput{Outcome: methods.ACPApprovalOutcomeAlreadyResolved}, nil
	}
	params.AgentServer = normalizeServerName(params.AgentServer)
	return h.approvals.Respond(*params), nil
}

// ListApprovals returns the current pending approval set; surfaces pull it at
// boot and after reconnects, relying on didChange pushes in between.
func (h *Handler) ListApprovals(ctx context.Context, params *struct{}, gCtx *glsp.Context) (methods.ACPApprovalsDidChangeParams, error) {
	if h.approvals == nil {
		return methods.ACPApprovalsDidChangeParams{Pending: []methods.ACPApproval{}}, nil
	}
	pending := h.approvals.Pending()
	if pending == nil {
		pending = []methods.ACPApproval{}
	}
	return methods.ACPApprovalsDidChangeParams{Pending: pending}, nil
}

func (h *Handler) Close() error {
	h.mu.Lock()
	h.closed = true
	procs := make([]*process, 0, len(h.procs))
	for _, proc := range h.procs {
		procs = append(procs, proc)
	}
	h.mu.Unlock()

	return stopProcesses(procs)
}

// isClosed reports whether Close has run, so lifecycle paths that would start
// a subprocess can decline once shutdown has begun.
func (h *Handler) isClosed() bool {
	h.mu.Lock()
	defer h.mu.Unlock()

	return h.closed
}

// stopProcesses stops every process concurrently. Each stop waits for its
// subprocess to exit (see process.stop), so stopping serially would add those
// waits together and delay helper shutdown by seconds per agent server.
func stopProcesses(procs []*process) error {
	var (
		mu      sync.Mutex
		stopErr error
		wg      sync.WaitGroup
	)
	for _, proc := range procs {
		wg.Go(func() {
			if err := proc.stop(); err != nil {
				mu.Lock()
				defer mu.Unlock()
				if stopErr == nil {
					stopErr = fmt.Errorf("stop %s: %w", proc.name(), err)
				}
			}
		})
	}
	wg.Wait()
	return stopErr
}

func (h *Handler) StopChangedAgentServers(before, after map[string]AgentServerConfig) error {
	before = NormalizeAgentServers(before)
	after = NormalizeAgentServers(after)

	toStop := map[string]struct{}{}
	for serverName, beforeConfig := range before {
		afterConfig, ok := after[serverName]
		if !ok || !sameAgentServerRuntimeConfig(beforeConfig, afterConfig) {
			toStop[serverName] = struct{}{}
		}
	}
	if len(toStop) == 0 {
		return nil
	}

	h.mu.Lock()
	procs := make([]*process, 0, len(toStop))
	for serverName := range toStop {
		if proc := h.procs[serverName]; proc != nil {
			procs = append(procs, proc)
		}
	}
	h.mu.Unlock()

	if err := stopProcesses(procs); err != nil {
		return fmt.Errorf("stop changed agent servers: %w", err)
	}
	return nil
}

func sameAgentServerRuntimeConfig(a, b AgentServerConfig) bool {
	a = normalizeAgentServerRuntimeConfig(a)
	b = normalizeAgentServerRuntimeConfig(b)
	// AgentServerConfig is intentionally plain structured data. A unit test
	// guards against adding fields, such as funcs or floats, that would make
	// reflect.DeepEqual surprising here.
	return reflect.DeepEqual(a, b)
}

func normalizeAgentServerRuntimeConfig(cfg AgentServerConfig) AgentServerConfig {
	cfg.DefaultConfigOptions = nil
	if len(cfg.Args) == 0 {
		cfg.Args = nil
	}
	if len(cfg.Env) == 0 {
		cfg.Env = nil
	}
	if len(cfg.Binary) == 0 {
		cfg.Binary = nil
	}
	for target, binary := range cfg.Binary {
		if len(binary.Args) == 0 {
			binary.Args = nil
		}
		if len(binary.Env) == 0 {
			binary.Env = nil
		}
		cfg.Binary[target] = binary
	}
	return cfg
}

func (h *Handler) processFor(serverName string, gCtx *glsp.Context) (*process, *acpClient) {
	h.mu.Lock()
	defer h.mu.Unlock()

	proc := h.procs[serverName]
	if proc == nil {
		proc = &process{}
		h.procs[serverName] = proc
	}

	client := h.clients[serverName]
	if client == nil {
		client = &acpClient{
			readFile:    h.readFile,
			liveStatus:  h.liveStatusSink,
			agentServer: serverName,
			gCtx:        gCtx,
			handler:     h,
		}
		client.notify = func(ctx context.Context, method string, params any) {
			gCtx.Notify(ctx, methods.JSONRPCNotifyMethod, bridgeMessage(serverName, map[string]any{
				"jsonrpc": "2.0",
				"method":  method,
				"params":  params,
			}))
		}
		client.request = func(ctx context.Context, method string, params any, result any) error {
			return gCtx.Call(ctx, methods.JSONRPCRequestMethod, bridgeMessage(serverName, map[string]any{
				"jsonrpc": "2.0",
				"id":      uuid.NewString(),
				"method":  method,
				"params":  params,
			}), result)
		}
		client.lspNotify = func(ctx context.Context, method string, params any) {
			gCtx.Notify(ctx, method, params)
		}
		client.lspCall = func(ctx context.Context, method string, params any, result any) error {
			return gCtx.Call(ctx, method, params, result)
		}
		client.activeSession = func() acpsdk.SessionId {
			proc.mu.Lock()
			defer proc.mu.Unlock()
			return proc.session
		}
		h.clients[serverName] = client
	}
	// Client routing and the helper-owned status sink are fixed when the
	// connection is created. Reassigning them on unrelated RPCs races queued
	// agent notifications and would not update the closures captured above.

	return proc, client
}

func bridgeMessage(serverName string, message map[string]any) map[string]any {
	return map[string]any{
		"agentServer": serverName,
		"message":     message,
	}
}

func normalizeServerName(serverName string) string {
	return NormalizeAgentServerName(serverName)
}

func (h *Handler) validateServerName(serverName string) error {
	agentServers := NormalizeAgentServers(h.configFn().AgentServers)
	if _, ok := agentServers[serverName]; !ok {
		return fmt.Errorf("acpproxy: unknown agent server %q", serverName)
	}
	return nil
}

func (h *Handler) ensureStarted(ctx context.Context, gCtx *glsp.Context, serverName string, initReq *acpsdk.InitializeRequest) (*process, error) {
	serverName = normalizeServerName(serverName)
	if err := h.validateServerName(serverName); err != nil {
		return nil, err
	}
	proc, client := h.processFor(serverName, gCtx)
	err := proc.ensureStarted(ctx, h.configFn, serverName, client, initReq, func(serverName string, err error) {
		if h.liveStatusSink != nil {
			if statusErr := h.liveStatusSink.ClearAgentServerInFlightStatus(context.Background(), gCtx, serverName); statusErr != nil {
				slog.Debug("acpproxy: failed to clear status after server exit", "server", serverName, "error", statusErr)
			}
		}
		notifyAgentServerDidExit(gCtx, serverName, err)
	})
	return proc, agentLaunchErrorToJSONRPC(err)
}

// agentLaunchErrorToJSONRPC surfaces install and missing-runtime failures with
// a dedicated error code so the webview can show an actionable retry state
// instead of a generic agent error.
func agentLaunchErrorToJSONRPC(err error) error {
	var installErr *AgentInstallError
	if errors.As(err, &installErr) {
		return &methods.JSONRPCError{
			Code:    methods.CamberErrorCodeAgentInstallFailed,
			Message: installErr.Error(),
			Data: &methods.JSONRPCErrorData{
				AgentInstall: &methods.AgentInstallData{AgentServer: installErr.AgentServer},
			},
		}
	}
	var runtimeErr *MissingRuntimeError
	if errors.As(err, &runtimeErr) {
		return &methods.JSONRPCError{
			Code:    methods.CamberErrorCodeAgentInstallFailed,
			Message: runtimeErr.Error(),
			Data: &methods.JSONRPCErrorData{
				AgentInstall: &methods.AgentInstallData{AgentServer: runtimeErr.AgentServer},
			},
		}
	}
	return err
}

func notifyAgentServerDidExit(gCtx *glsp.Context, serverName string, err error) {
	params := methods.ACPAgentServerDidExitParams{AgentServer: serverName}
	if err != nil {
		params.Error = err.Error()
	}
	if notifyErr := gCtx.Notify(context.Background(), methods.ACPAgentServerDidExitMethod, params); notifyErr != nil {
		slog.Debug("acpproxy: failed to notify agent server exit", "server", serverName, "error", notifyErr)
	}
}

// refreshAuthAfterCallError is retained as a no-op. The helper is ACP-only and
// no longer brokers Camber backend tokens; ACP agents authenticate
// themselves, so there is nothing to refresh after an agent call error.
func (h *Handler) refreshAuthAfterCallError(_ context.Context, _ string, _ error) {}

func (h *Handler) initializedProcess(gCtx *glsp.Context, serverName string) (*process, error) {
	serverName = normalizeServerName(serverName)
	if err := h.validateServerName(serverName); err != nil {
		return nil, err
	}
	proc, _ := h.processFor(serverName, gCtx)
	return proc, nil
}

func (h *Handler) processReadyForCall(ctx context.Context, gCtx *glsp.Context, serverName string) (*process, error) {
	_ = ctx
	proc, err := h.initializedProcess(gCtx, serverName)
	if err != nil {
		return nil, err
	}
	return proc, nil
}

func (h *Handler) processReadyForSession(ctx context.Context, gCtx *glsp.Context, serverName string) (*process, error) {
	serverName = normalizeServerName(serverName)
	proc, err := h.processReadyForCall(ctx, gCtx, serverName)
	if err != nil {
		return nil, err
	}
	// A session call can land in the window between an agent exit and the
	// client's next initialize: the client's connection cache and this
	// process slot are separate views of the same lifecycle, so the client
	// cannot reliably order its calls around a crash it has not heard about
	// yet. The slot keeps the last initialize request across resets, so
	// restart the agent with it rather than failing the session call with
	// "not initialized". A server the client never initialized has no
	// retained request and still fails as before, and once Close has begun no
	// call may start an agent that nothing would then stop.
	if !proc.isRunning() && !h.isClosed() {
		if initReq := proc.initializeRequest(); initReq != nil {
			slog.Info("acpproxy: restarting agent server for session call", "server", serverName)
			if _, err := h.ensureStarted(ctx, gCtx, serverName, initReq); err != nil {
				return nil, err
			}
		}
	}
	if err := h.preflightAgentServerForSession(ctx, gCtx, serverName, proc); err != nil {
		return nil, err
	}
	return proc, nil
}

func (h *Handler) preflightAgentServerForSession(ctx context.Context, gCtx *glsp.Context, serverName string, proc *process) error {
	if !proc.isRunning() {
		return nil
	}
	readiness := h.configFn().AgentServerReady
	if readiness == nil {
		return nil
	}
	ready, err := readiness(ctx, serverName)
	if err != nil {
		return fmt.Errorf("acpproxy: agent server %q readiness: %w", serverName, err)
	}
	if ready {
		return nil
	}

	slog.Info("acpproxy: restarting agent server after failed readiness check", "server", serverName)
	initReq := proc.initializeRequest()
	if err := proc.stop(); err != nil {
		return err
	}
	_, err = h.ensureStarted(ctx, gCtx, serverName, initReq)
	return err
}

func (h *Handler) Initialize(ctx context.Context, params *methods.ACPInitializeParams, gCtx *glsp.Context) (*methods.ACPInitializeOutput, error) {
	proc, err := h.ensureStarted(ctx, gCtx, params.AgentServer, &params.InitializeRequest)
	if err != nil {
		return nil, err
	}

	return proc.initializeResponse()
}

func (h *Handler) RestartServer(_ context.Context, params *methods.ACPAgentServerParams, gCtx *glsp.Context) (*methods.ACPRestartServerOutput, error) {
	serverName := normalizeServerName(params.AgentServer)
	if err := h.validateServerName(serverName); err != nil {
		return nil, err
	}

	proc, _ := h.processFor(serverName, gCtx)
	if err := proc.stop(); err != nil {
		return nil, err
	}

	return &methods.ACPRestartServerOutput{}, nil
}

func (h *Handler) Authenticate(ctx context.Context, params *methods.ACPAuthenticateParams, gCtx *glsp.Context) (*methods.ACPAuthenticateOutput, error) {
	proc, err := h.processReadyForCall(ctx, gCtx, params.AgentServer)
	if err != nil {
		return nil, err
	}

	conn, err := proc.initializedConn()
	if err != nil {
		return nil, err
	}

	resp, err := conn.Authenticate(ctx, params.AuthenticateRequest)
	if err != nil {
		h.refreshAuthAfterCallError(ctx, params.AgentServer, err)
		return nil, preserveACPError("acpproxy: authenticate", err)
	}

	return &resp, nil
}

func (h *Handler) Logout(ctx context.Context, params *methods.ACPLogoutParams, gCtx *glsp.Context) (*methods.ACPLogoutOutput, error) {
	proc, err := h.processReadyForCall(ctx, gCtx, params.AgentServer)
	if err != nil {
		return nil, err
	}

	conn, err := proc.initializedConn()
	if err != nil {
		return nil, err
	}

	resp, err := conn.Logout(ctx, params.LogoutRequest)
	if err != nil {
		return nil, preserveACPError("acpproxy: logout", err)
	}

	return &resp, nil
}

// configProbeMetaKey marks a config-probe session in NewSession/LoadSession
// _meta. The client (AcpAgentRepository) sets it on the throwaway probe session
// so we skip user-connector injection (and its subprocess/HTTP side effects) for
// it. Keep the literal in sync with the client.
const configProbeMetaKey = "camber/configProbe"

// isConfigProbeSession reports whether a session request's _meta marks it as a
// config probe.
func isConfigProbeSession(meta any) bool {
	m, ok := meta.(map[string]any)
	if !ok {
		return false
	}
	v, _ := m[configProbeMetaKey].(bool)
	return v
}

// injectUserMCPServers appends enabled user MCP connectors to *servers for a real
// (non-probe) session and returns the entries that couldn't be injected. Config-
// probe sessions are skipped (see configProbeMetaKey) so opening Connectors
// doesn't spawn every stdio server or dial every HTTP endpoint.
func (h *Handler) injectUserMCPServers(ctx context.Context, proc *process, agentServer string, meta any, servers *[]acpsdk.McpServer) []methods.MCPServerStatus {
	injector := h.configFn().MCPServerInjector
	if injector == nil || isConfigProbeSession(meta) {
		return nil
	}
	var caps acpsdk.McpCapabilities
	if ir, err := proc.initializeResponse(); err == nil {
		caps = ir.AgentCapabilities.McpCapabilities
	}
	injected, unavailable := injector(ctx, agentServer, caps)
	*servers = append(*servers, injected...)
	return unavailable
}

func (h *Handler) NewSession(ctx context.Context, params *methods.ACPNewSessionParams, gCtx *glsp.Context) (*methods.ACPNewSessionOutput, error) {
	proc, err := h.processReadyForSession(ctx, gCtx, params.AgentServer)
	if err != nil {
		return nil, err
	}

	req := params.NewSessionRequest
	// Config/probe sessions arrive with cwd "/" (workspace-independent), but the
	// agent can't resolve ~/.poolside from "/" on a read-only root. Map it to a
	// real dir (workspace, else home) so per-server settings land where real
	// sessions read them.
	if req.Cwd == "/" || req.Cwd == "" {
		fallback := h.configFn().WorkingDir
		if fallback == "" || fallback == "/" {
			fallback = resolveRealHomeDir()
		}
		if fallback != "" && fallback != "/" {
			slog.Info("acpproxy: substituting session cwd", "from", req.Cwd, "to", fallback)
			req.Cwd = fallback
		}
	}
	releaseWorkspace, err := h.beginWorkspaceSession(req.Cwd)
	if err != nil {
		return nil, err
	}
	defer releaseWorkspace()
	unavailable := h.injectUserMCPServers(ctx, proc, params.AgentServer, req.Meta, &req.McpServers)

	// Runs concurrently with session/new below; see claude_auth_probe.go.
	claudeAuthResult := h.maybeProbeClaudeAuthStatus(ctx, proc, params.AgentServer, req.Meta)

	proc.mu.Lock()
	resp, err := proc.newSessionLocked(ctx, req)
	proc.mu.Unlock()
	if err != nil {
		h.refreshAuthAfterCallError(ctx, params.AgentServer, err)
		return nil, err
	}
	if claudeAuthResult != nil {
		if authErr := <-claudeAuthResult; authErr != nil {
			return nil, authErr
		}
	}

	// Bind the nav conversation row to the new session id before returning:
	// the helper witnesses session/new, so the binding must not depend on the
	// client echoing it back over a possibly-flaky socket. Live status is
	// keyed by session id and silently unattachable until this lands.
	h.markSessionHistory(params.AgentServer, string(resp.SessionId), true)
	if convID := acp.DecodeSessionConversationID(req.Meta); convID != "" && h.liveStatusSink != nil {
		handoffID := acp.DecodeSessionHandoffID(req.Meta)
		if handoffID != "" {
			sink, ok := h.liveStatusSink.(conversationHandoffSink)
			if !ok {
				return nil, fmt.Errorf("acpproxy: conversation history store does not support handoffs")
			}
			if bindErr := sink.BindConversationSessionHandoff(ctx, gCtx, convID, params.AgentServer, string(resp.SessionId), req.Cwd, handoffID); bindErr != nil {
				return nil, fmt.Errorf("acpproxy: commit conversation handoff: %w", bindErr)
			}
		} else if bindErr := h.liveStatusSink.BindConversationSession(ctx, gCtx, convID, params.AgentServer, string(resp.SessionId), req.Cwd); bindErr != nil {
			slog.Warn("acpproxy: failed to bind conversation session", "conversation", convID, "session", resp.SessionId, "error", bindErr)
		}
	}

	notifySessionResolved(ctx, gCtx, params.AgentServer, string(resp.SessionId), req.McpServers, unavailable)
	return resp, nil
}

func (h *Handler) LoadSession(ctx context.Context, params *methods.ACPLoadSessionParams, gCtx *glsp.Context) (*methods.ACPLoadSessionOutput, error) {
	serverName := normalizeServerName(params.AgentServer)
	proc, err := h.processReadyForSession(ctx, gCtx, serverName)
	if err != nil {
		return nil, err
	}
	_, client := h.processFor(serverName, gCtx)

	req := params.LoadSessionRequest
	if response, attached, err := h.attachLiveSession(ctx, serverName, req, client); attached {
		return response, err
	}
	releaseWorkspace, err := h.beginWorkspaceSession(req.Cwd)
	if err != nil {
		return nil, err
	}
	defer releaseWorkspace()
	unavailable := h.injectUserMCPServers(ctx, proc, serverName, req.Meta, &req.McpServers)

	// Scope this session's update traffic to the requesting client for the
	// duration of the load (through the notification flush below): the agent
	// interleaves replay updates with any in-flight turn's live updates, and
	// replayed history must not be broadcast to clients that already have it.
	release, scopeErr := h.beginSessionLoad(ctx, serverName, string(req.SessionId), methods.ClientOriginFromContext(ctx))
	if scopeErr != nil {
		return nil, scopeErr
	}
	defer release()

	proc.mu.Lock()
	h.markSessionHistory(serverName, string(req.SessionId), false)
	resp, err := proc.loadSessionLocked(ctx, req)
	proc.mu.Unlock()
	if err != nil {
		h.refreshAuthAfterCallError(ctx, params.AgentServer, err)
		return resp, err
	}
	if flushErr := client.waitForSessionUpdates(ctx); flushErr != nil {
		return nil, preserveACPError("acpproxy: load session notifications", flushErr)
	}

	// Report the session's live-event cursor as of the completed replay so
	// the client can seq-gate subsequent live updates (the replay/live
	// cutover) and resume after reconnects. Live events were scoped away from
	// the log during the window, so the pre-load seq is exact.
	if h.events != nil && resp != nil {
		cursor := h.events.Cursor(serverName, string(req.SessionId))
		if resp.Meta == nil {
			resp.Meta = map[string]any{}
		}
		resp.Meta[methods.LoadSessionCursorMetaKey] = map[string]any{
			"epoch":      cursor.Epoch,
			"seq":        cursor.Seq,
			"turnActive": cursor.TurnActive,
		}
	}

	notifySessionResolved(ctx, gCtx, serverName, string(req.SessionId), req.McpServers, unavailable)
	return resp, nil
}

func (h *Handler) ResumeSession(ctx context.Context, params *methods.ACPResumeSessionParams, gCtx *glsp.Context) (*methods.ACPResumeSessionOutput, error) {
	serverName := normalizeServerName(params.AgentServer)
	proc, err := h.processReadyForSession(ctx, gCtx, serverName)
	if err != nil {
		return nil, err
	}

	req := params.ResumeSessionRequest
	releaseIdle, err := h.ReserveIdleSession(ctx, serverName, string(req.SessionId))
	if err != nil {
		return nil, err
	}
	defer releaseIdle()
	releaseWorkspace, err := h.beginWorkspaceSession(req.Cwd)
	if err != nil {
		return nil, err
	}
	defer releaseWorkspace()
	unavailable := h.injectUserMCPServers(ctx, proc, serverName, req.Meta, &req.McpServers)

	proc.mu.Lock()
	h.markSessionHistory(serverName, string(req.SessionId), false)
	resp, err := proc.resumeSessionLocked(ctx, req)
	proc.mu.Unlock()
	if err != nil {
		h.refreshAuthAfterCallError(ctx, params.AgentServer, err)
		return resp, err
	}

	notifySessionResolved(ctx, gCtx, serverName, string(req.SessionId), req.McpServers, unavailable)
	return resp, nil
}

func (h *Handler) ListSessions(ctx context.Context, params *methods.ACPListSessionsParams, gCtx *glsp.Context) (*methods.ACPListSessionsOutput, error) {
	proc, err := h.processReadyForCall(ctx, gCtx, params.AgentServer)
	if err != nil {
		return nil, err
	}

	conn, err := proc.initializedConn()
	if err != nil {
		return nil, err
	}

	resp, err := conn.ListSessions(ctx, params.ListSessionsRequest)
	if err != nil {
		h.refreshAuthAfterCallError(ctx, params.AgentServer, err)
		return nil, preserveACPError("acpproxy: list sessions", err)
	}

	return &resp, nil
}

func (h *Handler) DeleteSession(ctx context.Context, params *methods.ACPDeleteSessionParams, gCtx *glsp.Context) (*methods.ACPDeleteSessionOutput, error) {
	proc, err := h.processReadyForCall(ctx, gCtx, params.AgentServer)
	if err != nil {
		return nil, err
	}

	conn, err := proc.initializedConn()
	if err != nil {
		return nil, err
	}

	resp, err := conn.DeleteSession(ctx, params.DeleteSessionRequest)
	if err != nil {
		h.refreshAuthAfterCallError(ctx, params.AgentServer, err)
		return nil, preserveACPError("acpproxy: delete session", err)
	}

	return &resp, nil
}

// CloseSession releases an idle session's agent-side resources (e.g. a
// per-session subprocess) while keeping the session reopenable later via
// session/resume or session/load. Unlike DeleteSession it never starts the
// agent server: an unstarted server has no live sessions to close. It also
// no-ops (success) when the agent does not advertise session/close, or
// advertises no way to reopen a closed session — closing would strand the
// conversation — so callers may invoke it unconditionally.
func (h *Handler) CloseSession(ctx context.Context, params *methods.ACPCloseSessionParams, gCtx *glsp.Context) (*methods.ACPCloseSessionOutput, error) {
	releaseIdle, err := h.ReserveIdleSession(ctx, params.AgentServer, string(params.SessionId))
	if err != nil {
		return nil, err
	}
	defer releaseIdle()
	h.mu.Lock()
	proc := h.procs[normalizeServerName(params.AgentServer)]
	h.mu.Unlock()
	if proc == nil {
		return &methods.ACPCloseSessionOutput{}, nil
	}

	conn, err := proc.initializedConn()
	if err != nil {
		return &methods.ACPCloseSessionOutput{}, nil
	}

	if !proc.supportsSessionClose() {
		return &methods.ACPCloseSessionOutput{}, nil
	}

	resp, err := conn.CloseSession(ctx, params.CloseSessionRequest)
	if err != nil {
		// Close is idempotent: a session the agent no longer holds (already
		// closed by another trigger — archive then evict, or an agent restart)
		// is in the desired state.
		if isSessionGoneError(err) {
			proc.configurationForConn(conn).closeSession(string(params.SessionId))
			return &methods.ACPCloseSessionOutput{}, nil
		}
		h.refreshAuthAfterCallError(ctx, params.AgentServer, err)
		return nil, preserveACPError("acpproxy: close session", err)
	}

	proc.configurationForConn(conn).closeSession(string(params.SessionId))
	return &resp, nil
}

func (h *Handler) RenameSession(ctx context.Context, params *methods.ACPRenameSessionParams, gCtx *glsp.Context) (*methods.ACPRenameSessionOutput, error) {
	var output methods.ACPRenameSessionOutput
	err := h.callExtension(
		ctx,
		gCtx,
		params.AgentServer,
		acp.ExtensionMethodSessionRename,
		"acpproxy: rename session",
		params.SessionRenameRequest,
		&output,
	)
	if err != nil {
		return nil, err
	}
	return &output, nil
}

func (h *Handler) Steer(ctx context.Context, params *methods.ACPSteerParams, gCtx *glsp.Context) (*methods.ACPSteerOutput, error) {
	serverName := normalizeServerName(params.AgentServer)
	proc, err := h.processReadyForCall(ctx, gCtx, serverName)
	if err != nil {
		return nil, err
	}
	_, client := h.processFor(serverName, gCtx)

	conn, err := proc.initializedConn()
	if err != nil {
		return nil, err
	}

	// Track the attempt before doing anything that can yield to the agent's
	// notification queue. Claude can finish the original ACP prompt immediately
	// after accepting the injected message, racing the extension response.
	// runTurn waits for this attempt to resolve before deciding whether that
	// prompt response is the real turn boundary.
	releaseControl, err := h.acquireTurnControl(serverName, string(params.SessionID), expectedTurnID(params.Meta))
	if err != nil {
		return nil, err
	}
	defer releaseControl()
	tracked := h.beginPromptSteer(serverName, string(params.SessionID))
	accepted := false
	defer func() {
		h.finishPromptSteer(serverName, string(params.SessionID), tracked, accepted)
	}()

	if h.events != nil {
		publishUserMessage(client, h.events, serverName, string(params.SessionID), methods.ClientOriginFromContext(ctx), params.Prompt, true)
	} else {
		relayUserMessageToOtherClients(gCtx, client, serverName, string(params.SessionID), params.Prompt, true)
	}

	raw, err := conn.CallExtension(ctx, methods.ACPSessionSteeringExtensionMethod, params.ACPSteerRequest)
	if err != nil {
		h.refreshAuthAfterCallError(ctx, serverName, err)
		return nil, preserveACPError("acpproxy: steer session", err)
	}

	var output methods.ACPSteerOutput
	if err := json.Unmarshal(raw, &output); err != nil {
		return nil, fmt.Errorf("acpproxy: steer session: decode response: %w", err)
	}
	accepted = output.Outcome == methods.ACPSteerOutcomeInjected
	return &output, nil
}

func (h *Handler) callExtension(ctx context.Context, gCtx *glsp.Context, agentServer, extensionMethod, prefix string, request any, output any) error {
	proc, err := h.processReadyForCall(ctx, gCtx, agentServer)
	if err != nil {
		return err
	}

	conn, err := proc.initializedConn()
	if err != nil {
		return err
	}

	raw, err := conn.CallExtension(ctx, extensionMethod, request)
	if err != nil {
		h.refreshAuthAfterCallError(ctx, agentServer, err)
		return preserveACPError(prefix, err)
	}
	if output == nil || len(raw) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, output); err != nil {
		return fmt.Errorf("%s: decode response: %w", prefix, err)
	}
	return nil
}

func (h *Handler) CodexGoalControl(ctx context.Context, params *methods.ACPCodexGoalControlParams, gCtx *glsp.Context) (*methods.ACPCodexGoalControlOutput, error) {
	if params.SessionID == "" {
		return nil, fmt.Errorf("acpproxy: codex goal control: sessionId is required")
	}
	if params.Action != methods.ACPCodexGoalControlPause && params.Action != methods.ACPCodexGoalControlClear {
		return nil, fmt.Errorf("acpproxy: codex goal control: unsupported action %q", params.Action)
	}
	serverName := normalizeServerName(params.AgentServer)

	var output methods.ACPCodexGoalControlOutput
	if err := h.callExtension(
		ctx,
		gCtx,
		serverName,
		methods.ACPCodexGoalControlExtensionMethod,
		"acpproxy: codex goal control",
		params.ACPCodexGoalControlRequest,
		&output,
	); err != nil {
		return nil, err
	}
	_, client := h.processFor(serverName, gCtx)
	if flushErr := client.waitForSessionUpdates(ctx); flushErr != nil {
		return nil, preserveACPError("acpproxy: codex goal control notifications", flushErr)
	}
	return &output, nil
}

func (h *Handler) MCPSettings(ctx context.Context, params *methods.ACPMCPSettingsParams, gCtx *glsp.Context) (*methods.ACPMCPSettingsOutput, error) {
	var output methods.ACPMCPSettingsOutput
	if err := h.callExtension(ctx, gCtx, params.AgentServer, acp.ExtensionMethodMCPSettings, "acpproxy: mcp settings", params.MCPSettingsRequest, &output); err != nil {
		return nil, err
	}
	return &output, nil
}

func (h *Handler) MCPSetServerDisabled(ctx context.Context, params *methods.ACPMCPSetServerDisabledParams, gCtx *glsp.Context) (*methods.ACPMCPSetServerDisabledOutput, error) {
	var output methods.ACPMCPSetServerDisabledOutput
	if err := h.callExtension(ctx, gCtx, params.AgentServer, acp.ExtensionMethodMCPSetServerDisabled, "acpproxy: mcp set server disabled", params.MCPSetServerDisabledRequest, &output); err != nil {
		return nil, err
	}
	return &output, nil
}

func (h *Handler) MCPDeleteSecrets(ctx context.Context, params *methods.ACPMCPDeleteSecretsParams, gCtx *glsp.Context) (*methods.ACPMCPDeleteSecretsOutput, error) {
	var output methods.ACPMCPDeleteSecretsOutput
	if err := h.callExtension(ctx, gCtx, params.AgentServer, acp.ExtensionMethodMCPDeleteSecrets, "acpproxy: mcp delete secrets", params.MCPDeleteSecretsRequest, &output); err != nil {
		return nil, err
	}
	return &output, nil
}

func (h *Handler) MCPAuthenticate(ctx context.Context, params *methods.ACPMCPAuthenticateParams, gCtx *glsp.Context) (*methods.ACPMCPAuthenticateOutput, error) {
	var output methods.ACPMCPAuthenticateOutput
	if err := h.callExtension(ctx, gCtx, params.AgentServer, acp.ExtensionMethodMCPAuthenticate, "acpproxy: mcp authenticate", params.MCPAuthenticateRequest, &output); err != nil {
		return nil, err
	}
	return &output, nil
}

func (h *Handler) MCPSetInputVariable(ctx context.Context, params *methods.ACPMCPSetInputVariableParams, gCtx *glsp.Context) (*methods.ACPMCPSetInputVariableOutput, error) {
	var output methods.ACPMCPSetInputVariableOutput
	if err := h.callExtension(ctx, gCtx, params.AgentServer, acp.ExtensionMethodMCPSetInputVariable, "acpproxy: mcp set input variable", params.MCPSetInputVariableRequest, &output); err != nil {
		return nil, err
	}
	return &output, nil
}

// notifySessionResolved emits the camber/mcpServers/sessionResolved notification
// after a session is set up. It is best-effort: failures are logged, not propagated.
func notifySessionResolved(ctx context.Context, gCtx *glsp.Context, agentServer, sessionID string, injectedServers []acpsdk.McpServer, unavailable []methods.MCPServerStatus) {
	injected := make([]methods.MCPServerStatus, 0, len(injectedServers))
	for _, srv := range injectedServers {
		name := mcpServerName(srv)
		if name != "" {
			injected = append(injected, methods.MCPServerStatus{ServerName: name})
		}
	}
	params := methods.MCPServersSessionResolvedParams{
		AgentServer: agentServer,
		SessionID:   sessionID,
		Injected:    injected,
		Unavailable: unavailable,
	}
	if err := gCtx.Notify(ctx, params.MethodName(), params); err != nil {
		slog.Debug("acpproxy: sessionResolved notify", "server", agentServer, "error", err)
	}
}

func mcpServerName(srv acpsdk.McpServer) string {
	if srv.Stdio != nil {
		return srv.Stdio.Name
	}
	if srv.Http != nil {
		return srv.Http.Name
	}
	return ""
}

func (h *Handler) Prompt(ctx context.Context, params *methods.ACPPromptParams, gCtx *glsp.Context) (*methods.ACPPromptOutput, error) {
	serverName := normalizeServerName(params.AgentServer)
	// A client that lost its connection mid-turn re-issues the prompt with
	// the same _meta turnId; if that turn already finished, hand back the
	// stored outcome instead of running a duplicate.
	turnID, _ := params.Meta["camber/turnId"].(string)
	if turnID != "" {
		if finished := h.finishedTurn(turnID); finished != nil {
			return finished.resp, finished.err
		}
	}

	proc, err := h.processReadyForCall(ctx, gCtx, serverName)
	if err != nil {
		return nil, err
	}
	_, client := h.processFor(serverName, gCtx)

	conn, activeSession, err := proc.connForSession()
	if err != nil {
		return nil, err
	}
	sessionID := params.SessionId
	if sessionID == "" {
		sessionID = activeSession
	}
	if sessionID == "" {
		return nil, fmt.Errorf("acpproxy: no active session; call session/new first")
	}
	// Reject overlapping prompts before any side effect (live status, task
	// turn, user-message relay): a second concurrent Prompt on the same agent
	// connection would interleave two turns in one transcript, and its
	// deferred cleanups would clear the first turn's in-flight bookkeeping.
	turn, reserved := h.beginPromptInFlight(serverName, string(sessionID), turnID)
	if !reserved {
		if turn == nil {
			return nil, h.promptBusyError(serverName, string(sessionID))
		}
		// Same turnID as the running turn: this is a retry of a call whose
		// response was lost to a dropped connection. Attach to the turn
		// rather than duplicating it.
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-turn.done:
			return turn.resp, turn.err
		}
	}
	// Release the reservation via defer: a panic inside runTurn is recovered
	// by the JSON-RPC dispatcher (the process survives), and without this a
	// panicking turn would leave promptsInFlight set and turn.done never
	// closed — wedging the conversation until a helper restart.
	var resp *methods.ACPPromptOutput
	var turnErr error
	defer func() {
		if rv := recover(); rv != nil {
			panicErr := errFromTurnPanic(rv)
			h.completeTurn(serverName, string(sessionID), turn, nil, panicErr)
			panic(rv)
		}
		h.completeTurn(serverName, string(sessionID), turn, resp, turnErr)
	}()
	resp, turnErr = h.runTurn(ctx, params, gCtx, client, proc, conn, serverName, sessionID, turn)
	return resp, turnErr
}

// errFromTurnPanic records a panicking turn's failure for retries attached to
// the same turnID, which read turn.err once turn.done closes.
func errFromTurnPanic(rv any) error {
	return fmt.Errorf("prompt turn panicked: %v", rv)
}

// runTurn executes one reserved prompt turn; Prompt owns the turn
// reservation and result bookkeeping around it.
func (h *Handler) runTurn(ctx context.Context, params *methods.ACPPromptParams, gCtx *glsp.Context, client *acpClient, proc *process, conn *acpsdk.ClientSideConnection, serverName string, sessionID acpsdk.SessionId, turn *activeTurn) (*methods.ACPPromptOutput, error) {
	// A session/load in flight scopes this session's updates to the loading
	// client; starting a turn now would stream its output only there. Loads
	// finish in seconds, and the turn reservation above already rejects
	// competing prompts while we wait.
	if err := h.waitForLoadScopeClear(ctx, serverName, string(sessionID)); err != nil {
		return nil, err
	}
	if h.events != nil {
		h.events.BeginTurn(serverName, string(sessionID))
		h.mu.Lock()
		turn.eventsQueued = true
		h.mu.Unlock()
		defer client.enqueueTurnEndedForTurn(sessionID, turn)
		// Capture the boundary on the publication queue, after prior turns'
		// final events and before this turn's user message or agent output.
		client.asyncNotifications.enqueue(func(_ context.Context, _ string, _ any) {
			cursor := h.events.Cursor(serverName, string(sessionID))
			h.mu.Lock()
			turn.startCursor = cursor
			h.mu.Unlock()
		}, "", nil)
		if err := client.waitForSessionUpdates(ctx); err != nil {
			return nil, err
		}
	}
	if h.liveStatusSink != nil {
		if statusErr := h.liveStatusSink.SetConversationLiveStatus(ctx, gCtx, serverName, string(sessionID), acpnav.ConversationLiveStatusPatch{
			Working: acpnav.Bool(true),
			Unread:  acpnav.Bool(false),
		}); statusErr != nil {
			slog.Debug("acpproxy: failed to mark prompt working", "server", serverName, "session_id", string(sessionID), "error", statusErr)
		}
		defer func() {
			if statusErr := h.liveStatusSink.CompletePrompt(context.Background(), gCtx, serverName, string(sessionID)); statusErr != nil {
				slog.Debug("acpproxy: failed to complete prompt status", "server", serverName, "session_id", string(sessionID), "error", statusErr)
			}
		}()
	}

	req := params.PromptRequest
	req.SessionId = sessionID

	// A steer fallback re-delivers a message Steer already mirrored to the
	// other surfaces; mirroring it again would show it there twice.
	if !isSteerFallbackPrompt(req.Meta) {
		if h.events != nil {
			publishUserMessage(client, h.events, serverName, string(sessionID), methods.ClientOriginFromContext(ctx), req.Prompt, false)
		} else {
			relayUserMessageToOtherClients(gCtx, client, serverName, string(sessionID), req.Prompt, false)
		}
	}

	promptCtx, releasePrompt, err := proc.contextForPrompt(ctx, conn)
	if err != nil {
		return nil, err
	}
	defer releasePrompt()

	// Add caller identity only to the agent-bound request. The user-message
	// relay above keeps the user's original content and existing host context.
	initResp, _ := proc.initializeResponse()
	embeddedContext := initResp != nil && initResp.AgentCapabilities.PromptCapabilities.EmbeddedContext
	req.Prompt = withControlContext(req.Prompt, h.promptControlContext(ctx, serverName, string(sessionID)), embeddedContext)

	resp, promptErr := conn.Prompt(promptCtx, req)
	if proc.isClaudeAgent() {
		h.markPromptReturned(turn)
		steerCompletion, waitErr := h.waitForClaudeSteeredCompletion(promptCtx, turn)
		if waitErr != nil {
			var connectorErr *mcpConnectorCredentialsError
			if cause := context.Cause(promptCtx); errors.As(cause, &connectorErr) {
				return nil, cause
			}
			return nil, waitErr
		}
		if steerCompletion.cancelled {
			return &methods.ACPPromptOutput{StopReason: acpsdk.StopReasonCancelled}, nil
		}
		if steerCompletion.accepted && (promptErr == nil || isSteeringTurnBoundaryError(promptErr)) {
			// Claude currently settles the ACP request at the interrupted
			// generation's result, then streams the injected continuation outside
			// that request. The wait above extends the helper-owned turn through
			// the continuation's result boundary, so normalize the interrupted
			// response (including the SDK's user-result diagnostic) to the logical
			// turn's successful completion.
			slog.Debug("acpproxy: completed Claude prompt after steered continuation", "server", serverName, "session_id", string(sessionID))
			out := methods.ACPPromptOutput{StopReason: acpsdk.StopReasonEndTurn}
			if promptErr == nil {
				out = resp
				out.StopReason = acpsdk.StopReasonEndTurn
			}
			return &out, nil
		}
	}
	if promptErr != nil {
		var connectorErr *mcpConnectorCredentialsError
		if cause := context.Cause(promptCtx); errors.As(cause, &connectorErr) {
			return nil, cause
		}
		h.refreshAuthAfterCallError(ctx, params.AgentServer, promptErr)
		return nil, preserveACPError("acpproxy: prompt", promptErr)
	}

	return &resp, nil
}

// activeTurn tracks one running (or recently finished) prompt turn. turnID is
// the client-generated idempotency key from the prompt's _meta, or a helper
// generated identity when omitted; resp/err are set before done closes.
type activeTurn struct {
	key            promptSessionKey
	turnID         string
	done           chan struct{}
	resp           *methods.ACPPromptOutput
	err            error
	controlPending int
	eventsQueued   bool
	eventsDone     chan struct{}
	endCursor      SessionCursor
	startCursor    SessionCursor

	// Claude's adapter currently returns from session/prompt at the result
	// boundary interrupted by steering, while the injected continuation keeps
	// streaming. These fields let the helper extend its logical prompt through
	// the continuation's own terminal usage update. They are guarded by Handler.mu.
	steerPending              int
	steerAccepted             int
	terminalUserUsageUpdates  int
	promptReturnUsageBaseline int
	steerStateChanged         chan struct{}
	cancelled                 bool
}

const finishedTurnCap = 32

// beginPromptInFlight reserves the session's turn. A prompt already running
// for the session — from this or any other connected surface — rejects the
// caller (reserved=false, attach=nil), UNLESS it carries the same turnID: a
// client re-issuing a prompt after its connection dropped mid-turn attaches
// to the running turn (reserved=false, attach!=nil) and receives its result
// instead of an error. The reservation is released by completeTurn when the
// agent's prompt call returns (including after a session/cancel).
func (h *Handler) beginPromptInFlight(serverName, sessionID, turnID string) (attach *activeTurn, reserved bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	key := promptSessionKey{agentServer: serverName, sessionID: sessionID}
	// Completion may race Prompt's early cache lookup. Check again under the
	// reservation lock so a retry cannot start the finished turn a second time.
	if finished := h.finishedTurns[turnID]; turnID != "" && finished != nil && finished.key == key {
		return finished, false
	}
	if _, reserved := h.idleSessions[key]; reserved {
		return nil, false
	}
	if _, loading := h.loadScopes[key]; loading {
		return nil, false
	}
	if running := h.promptsInFlight[key]; running != nil {
		if turnID != "" && running.turnID == turnID {
			return running, false
		}
		return nil, false
	}
	turn := &activeTurn{
		key:               key,
		turnID:            turnID,
		done:              make(chan struct{}),
		steerStateChanged: make(chan struct{}),
		eventsDone:        make(chan struct{}),
	}
	if turn.turnID == "" {
		turn.turnID = uuid.NewString()
	}
	h.promptsInFlight[key] = turn
	return turn, true
}

func (h *Handler) completeTurn(serverName, sessionID string, turn *activeTurn, resp *methods.ACPPromptOutput, err error) {
	turn.resp = resp
	turn.err = err
	for {
		h.mu.Lock()
		if turn.controlPending == 0 {
			break
		}
		changed := turn.steerStateChanged
		h.mu.Unlock()
		<-changed
	}
	delete(h.promptsInFlight, promptSessionKey{agentServer: serverName, sessionID: sessionID})
	if turn.turnID != "" {
		h.finishedTurns[turn.turnID] = turn
		h.finishedTurnOrder = append(h.finishedTurnOrder, turn.turnID)
		if len(h.finishedTurnOrder) > finishedTurnCap {
			delete(h.finishedTurns, h.finishedTurnOrder[0])
			h.finishedTurnOrder = h.finishedTurnOrder[1:]
		}
	}
	h.mu.Unlock()
	close(turn.done)
}

func signalSteerStateChangedLocked(turn *activeTurn) {
	close(turn.steerStateChanged)
	turn.steerStateChanged = make(chan struct{})
}

// beginPromptSteer registers an extension request against the helper-owned
// turn. It returns false when the prompt has already completed; the extension
// is still forwarded so the agent can report its own idle-race outcome.
func (h *Handler) beginPromptSteer(serverName, sessionID string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	turn := h.promptsInFlight[promptSessionKey{agentServer: serverName, sessionID: sessionID}]
	if turn == nil {
		return false
	}
	turn.steerPending++
	signalSteerStateChangedLocked(turn)
	return true
}

func (h *Handler) finishPromptSteer(serverName, sessionID string, tracked, accepted bool) {
	if !tracked {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	turn := h.promptsInFlight[promptSessionKey{agentServer: serverName, sessionID: sessionID}]
	if turn == nil {
		return
	}
	if turn.steerPending > 0 {
		turn.steerPending--
	}
	if accepted {
		turn.steerAccepted++
	}
	signalSteerStateChangedLocked(turn)
}

// observeSessionUpdate counts only Claude's user-result usage trailers: the
// adapter attaches cost at result boundaries, whereas streaming usage updates
// omit it. Autonomous result trailers use one of the same origin kinds the
// Claude adapter excludes from its user-turn lifecycle; other tagged origins
// (including a steered user continuation) still belong to the prompt.
func (h *Handler) observeSessionUpdate(serverName, sessionID string, update acpsdk.SessionUpdate) {
	usage := update.UsageUpdate
	if usage == nil || usage.Cost == nil {
		return
	}
	if isClaudeAutonomousUsageUpdate(usage) {
		return
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	turn := h.promptsInFlight[promptSessionKey{agentServer: normalizeServerName(serverName), sessionID: sessionID}]
	if turn == nil {
		return
	}
	turn.terminalUserUsageUpdates++
	signalSteerStateChangedLocked(turn)
}

func isClaudeAutonomousUsageUpdate(usage *acpsdk.SessionUsageUpdate) bool {
	origin, ok := usage.Meta["_claude/origin"].(map[string]any)
	if !ok {
		return false
	}
	kind, _ := origin["kind"].(string)
	switch kind {
	case "task-notification", "peer", "coordinator", "observer", "observer-activity":
		return true
	default:
		return false
	}
}

func (h *Handler) markPromptReturned(turn *activeTurn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	turn.promptReturnUsageBaseline = turn.terminalUserUsageUpdates
	signalSteerStateChangedLocked(turn)
}

type claudeSteerCompletion struct {
	accepted  bool
	cancelled bool
}

func (h *Handler) waitForClaudeSteeredCompletion(ctx context.Context, turn *activeTurn) (claudeSteerCompletion, error) {
	for {
		h.mu.Lock()
		pending := turn.steerPending
		accepted := turn.steerAccepted
		cancelled := turn.cancelled
		terminalUpdates := turn.terminalUserUsageUpdates
		target := turn.promptReturnUsageBaseline + accepted
		changed := turn.steerStateChanged
		h.mu.Unlock()

		if cancelled {
			return claudeSteerCompletion{accepted: accepted > 0, cancelled: true}, nil
		}
		if pending == 0 {
			if accepted == 0 {
				return claudeSteerCompletion{}, nil
			}
			if terminalUpdates >= target {
				return claudeSteerCompletion{accepted: true}, nil
			}
		}

		select {
		case <-ctx.Done():
			return claudeSteerCompletion{}, context.Cause(ctx)
		case <-changed:
		}
	}
}

func (h *Handler) cancelPromptWait(serverName, sessionID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	turn := h.promptsInFlight[promptSessionKey{agentServer: normalizeServerName(serverName), sessionID: sessionID}]
	if turn == nil {
		return
	}
	turn.cancelled = true
	signalSteerStateChangedLocked(turn)
}

func (h *Handler) finishedTurn(turnID string) *activeTurn {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.finishedTurns[turnID]
}

func relayedUserMessageUpdate(messageID string, block acpsdk.ContentBlock, steer bool) map[string]any {
	update := map[string]any{
		"sessionUpdate": "user_message_chunk",
		"messageId":     messageID,
		"content":       block,
	}
	if steer {
		update["_meta"] = map[string]any{methods.ACPUserMessageSteerMetaKey: true}
	}
	return update
}

// isSteerFallbackPrompt reports whether a prompt's _meta marks it as
// re-delivering a steer message the agent declined to inject; Steer mirrored
// that user message to the other surfaces already.
func isSteerFallbackPrompt(meta map[string]any) bool {
	return meta[methods.ACPSteerFallbackMetaKey] == true
}

// publishUserMessage mirrors a prompt's user message to the other connected
// surfaces through the event sink, replacing relayUserMessageToOtherClients
// when the sink is installed. The stamped events land in the session log so a
// reconnecting surface replays them too. The prompting surface rendered the
// message locally already: the primary is simply skipped, while a remote
// origin still receives its stamped copy — tagged with its device so its
// transport drops the content — keeping the seq stream gapless for every
// remote. The publishes go through the client's async notification queue so
// they cannot be reordered against agent updates.
func publishUserMessage(client *acpClient, events SessionEventSink, serverName, sessionID, originID string, blocks []acpsdk.ContentBlock, steer bool) {
	originDevice := methods.ClientOriginDevice(originID)
	skipPrimary := originID == methods.PrimaryClientOrigin
	messageID := uuid.NewString()
	for _, block := range blocks {
		message := map[string]any{
			"jsonrpc": "2.0",
			"method":  acpsdk.ClientMethodSessionUpdate,
			"params": map[string]any{
				"sessionId": sessionID,
				"update":    relayedUserMessageUpdate(messageID, block, steer),
			},
		}
		client.asyncNotifications.enqueue(func(ctx context.Context, method string, params any) {
			events.PublishSessionUpdate(serverName, sessionID, originDevice, skipPrimary, message)
		}, methods.JSONRPCNotifyMethod, message)
	}
}

// relayUserMessageToOtherClients mirrors a prompt's user message to every
// OTHER connected surface (desktop watching while a phone replies, or vice
// versa) as the same user_message_chunk session updates a session/load replay
// would produce. Without this only the originating client — which renders its
// user message locally — ever sees the prompt: agents do not echo it, so on
// other surfaces the turn's agent chunks glue onto the previous message. The
// updates go through the client's async notification queue so they cannot
// overtake or be overtaken by agent session updates, and through the
// NotifyOthers hub sentinel so the origin gets no duplicate.
func relayUserMessageToOtherClients(gCtx *glsp.Context, client *acpClient, serverName, sessionID string, blocks []acpsdk.ContentBlock, steer bool) {
	notify := func(ctx context.Context, method string, params any) {
		if err := gCtx.Notify(ctx, method, params); err != nil {
			slog.Debug("acpproxy: relay user message to other clients", "server", serverName, "error", err)
		}
	}
	messageID := uuid.NewString()
	for _, block := range blocks {
		client.asyncNotifications.enqueue(notify, methods.NotifyOthersMethod, methods.NotifyOthersParams{
			Method: methods.JSONRPCNotifyMethod,
			Params: bridgeMessage(serverName, map[string]any{
				"jsonrpc": "2.0",
				"method":  acpsdk.ClientMethodSessionUpdate,
				"params": map[string]any{
					"sessionId": sessionID,
					"update":    relayedUserMessageUpdate(messageID, block, steer),
				},
			}),
		})
	}
}

func (h *Handler) Cancel(ctx context.Context, params *methods.ACPCancelParams, gCtx *glsp.Context) (*methods.ACPCancelOutput, error) {
	proc, err := h.processReadyForCall(ctx, gCtx, params.AgentServer)
	if err != nil {
		return nil, err
	}

	conn, activeSession, err := proc.connForSession()
	if err != nil {
		return nil, err
	}
	sessionID := params.SessionId
	if sessionID == "" {
		sessionID = activeSession
	}
	if sessionID == "" {
		return nil, fmt.Errorf("acpproxy: no active session; call session/new first")
	}
	releaseControl, err := h.acquireTurnControl(params.AgentServer, string(sessionID), expectedTurnID(params.Meta))
	if err != nil {
		return nil, err
	}
	defer releaseControl()
	if h.liveStatusSink != nil {
		defer func() {
			if statusErr := h.liveStatusSink.CompletePrompt(context.Background(), gCtx, params.AgentServer, string(sessionID)); statusErr != nil {
				slog.Debug("acpproxy: failed to complete prompt status after cancel", "server", params.AgentServer, "session_id", string(sessionID), "error", statusErr)
			}
			if statusErr := h.liveStatusSink.SetConversationLiveStatus(context.Background(), gCtx, params.AgentServer, string(sessionID), acpnav.ConversationLiveStatusPatch{
				WaitingForUser: acpnav.Bool(false),
			}); statusErr != nil {
				slog.Debug("acpproxy: failed to clear pending status after cancel", "server", params.AgentServer, "session_id", string(sessionID), "error", statusErr)
			}
		}()
	}
	// Belt-and-braces: a well-behaved agent cancels its own in-flight
	// permission/elicitation requests when the turn is cancelled (which
	// resolves the store entries via ctx); this covers agents that don't, so
	// no surface is left showing approvals for a dead turn.
	if h.approvals != nil {
		h.approvals.CancelSession(normalizeServerName(params.AgentServer), string(sessionID))
	}
	if err := conn.Cancel(ctx, acpsdk.CancelNotification{
		SessionId: sessionID,
	}); err != nil {
		h.refreshAuthAfterCallError(ctx, params.AgentServer, err)
		return nil, preserveACPError("acpproxy: cancel", err)
	}
	h.cancelPromptWait(params.AgentServer, string(sessionID))

	return &methods.ACPCancelOutput{}, nil
}

func (h *Handler) SetMode(ctx context.Context, params *methods.ACPSetModeParams, gCtx *glsp.Context) (*methods.ACPSetModeOutput, error) {
	proc, err := h.processReadyForCall(ctx, gCtx, params.AgentServer)
	if err != nil {
		return nil, err
	}

	conn, activeSession, err := proc.connForSession()
	if err != nil {
		return nil, err
	}
	sessionID := params.SessionId
	if sessionID == "" {
		sessionID = activeSession
	}
	if sessionID == "" {
		return nil, fmt.Errorf("acpproxy: no active session; call session/new first")
	}
	resp, err := conn.SetSessionMode(ctx, acpsdk.SetSessionModeRequest{
		SessionId: sessionID,
		ModeId:    params.ModeId,
	})
	if err != nil {
		h.refreshAuthAfterCallError(ctx, params.AgentServer, err)
		return nil, preserveACPError("acpproxy: set mode", err)
	}
	proc.configurationForConn(conn).setMode(string(sessionID), params.ModeId)
	if err := h.publishControlConfiguration(ctx, params.AgentServer, sessionID, acpsdk.SessionUpdate{
		CurrentModeUpdate: &acpsdk.SessionCurrentModeUpdate{CurrentModeId: params.ModeId, SessionUpdate: "current_mode_update"},
	}, gCtx); err != nil {
		return nil, err
	}

	return &resp, nil
}

func (h *Handler) SetConfigOption(ctx context.Context, params *methods.ACPSetConfigOptionParams, gCtx *glsp.Context) (*methods.ACPSetConfigOptionOutput, error) {
	proc, err := h.processReadyForCall(ctx, gCtx, params.AgentServer)
	if err != nil {
		return nil, err
	}

	conn, activeSession, err := proc.connForSession()
	if err != nil {
		return nil, err
	}
	req, sessionID, err := setConfigOptionRequestSessionID(params.SetSessionConfigOptionRequest, activeSession)
	if err != nil {
		return nil, err
	}

	resp, err := conn.SetSessionConfigOption(ctx, req)
	if err != nil {
		h.refreshAuthAfterCallError(ctx, params.AgentServer, err)
		return nil, preserveACPError("acpproxy: set config option", err)
	}
	proc.configurationForConn(conn).capture(string(sessionID), resp.ConfigOptions, nil)
	if err := h.publishControlConfiguration(ctx, params.AgentServer, sessionID, acpsdk.SessionUpdate{
		ConfigOptionUpdate: &acpsdk.SessionConfigOptionUpdate{ConfigOptions: resp.ConfigOptions, SessionUpdate: "config_option_update"},
	}, gCtx); err != nil {
		return nil, err
	}

	return &resp, nil
}

func setConfigOptionRequestSessionID(req acpsdk.SetSessionConfigOptionRequest, fallback acpsdk.SessionId) (acpsdk.SetSessionConfigOptionRequest, acpsdk.SessionId, error) {
	switch {
	case req.ValueId != nil:
		v := *req.ValueId
		sessionID := v.SessionId
		if sessionID == "" {
			sessionID = fallback
		}
		if sessionID == "" {
			return req, "", fmt.Errorf("acpproxy: no active session; call session/new first")
		}
		v.SessionId = sessionID
		req.ValueId = &v
		return req, sessionID, nil
	case req.Boolean != nil:
		v := *req.Boolean
		sessionID := v.SessionId
		if sessionID == "" {
			sessionID = fallback
		}
		if sessionID == "" {
			return req, "", fmt.Errorf("acpproxy: no active session; call session/new first")
		}
		v.SessionId = sessionID
		req.Boolean = &v
		return req, sessionID, nil
	default:
		if fallback == "" {
			return req, "", fmt.Errorf("acpproxy: no active session; call session/new first")
		}
		return req, "", fmt.Errorf("acpproxy: set config option: unsupported request variant (expected ValueId or Boolean, got %+v)", req)
	}
}
