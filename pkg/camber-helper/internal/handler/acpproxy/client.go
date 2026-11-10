package acpproxy

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	acpsdk "github.com/coder/acp-go-sdk"

	acphelpers "github.com/appleton/camber/pkg/acp"
	"github.com/appleton/camber/pkg/camber-helper/gopls/pkg/protocol"
	"github.com/appleton/camber/pkg/camber-helper/internal/handler/acpnav"
	"github.com/appleton/camber/pkg/camber-helper/internal/handler/approvals"
	"github.com/appleton/camber/pkg/camber-helper/methods"
	"github.com/tliron/glsp"
)

// notifyFn sends an ACP notification (wrapped in a JSON-RPC 2.0 envelope)
// to the VS Code extension client via the generic jsonrpc/notify bridge.
type notifyFn func(ctx context.Context, method string, params any)

// requestFn sends an ACP request (wrapped in a JSON-RPC 2.0 envelope)
// to the VS Code extension client via the generic jsonrpc/request bridge
// and unmarshals the result.
type requestFn func(ctx context.Context, method string, params any, result any) error

// ReadFileFn reads a file by URI, returning unsaved editor content when available.
type ReadFileFn func(ctx context.Context, uri protocol.DocumentURI) ([]byte, error)

const maxReadTextFileResponseBytes = 5 * 1024 * 1024

// acpClient implements acpsdk.Client, handling callbacks from the ACP agent
// subprocess. Notifications are forwarded to the VS Code extension as raw ACP types.
// lspNotifyFn sends a raw LSP notification to the VS Code extension,
// bypassing the ACP JSON-RPC bridge.
type lspNotifyFn func(ctx context.Context, method string, params any)

// lspCallFn sends a raw LSP request to the VS Code extension and awaits the response.
type lspCallFn func(ctx context.Context, method string, params any, result any) error

type acpClient struct {
	notify        notifyFn
	request       requestFn
	readFile      ReadFileFn
	lspNotify     lspNotifyFn
	lspCall       lspCallFn
	activeSession func() acpsdk.SessionId
	liveStatus    LiveStatusSink
	agentServer   string
	gCtx          *glsp.Context
	handler       *Handler

	asyncNotifications asyncNotificationQueue
}

var _ acpsdk.Client = (*acpClient)(nil)
var _ acpsdk.ExtensionMethodHandler = (*acpClient)(nil)

// The SDK dispatches the unstable elicitation methods through runtime
// interface assertions with exactly these signatures; a mismatch would report
// method-not-found to the agent instead of failing to compile.
var _ interface {
	UnstableCreateElicitation(context.Context, acpsdk.UnstableCreateElicitationRequest) (acpsdk.UnstableCreateElicitationResponse, error)
	UnstableCompleteElicitation(context.Context, acpsdk.UnstableCompleteElicitationNotification) error
} = (*acpClient)(nil)

// HandleExtensionMethod receives ACP extension notifications from the
// pool acp subprocess and converts them to appropriate LSP notifications.
func (c *acpClient) HandleExtensionMethod(ctx context.Context, method string, params json.RawMessage) (any, error) {
	switch method {
	case acphelpers.ExtensionMethodShowMessage:
		var notif acphelpers.ShowMessageNotification
		if err := json.Unmarshal(params, &notif); err != nil {
			slog.Error("acpproxy: failed to unmarshal show_message", "error", err)
			return nil, nil
		}
		if c.lspNotify != nil {
			msgType := showMessageType(notif.Type)
			c.lspNotify(context.Background(), "window/showMessage", protocol.ShowMessageParams{
				Type:    msgType,
				Message: notif.Message,
			})
		}
		return nil, nil
	case acphelpers.ExtensionMethodElicitation:
		var req methods.ACPElicitationParams
		if err := json.Unmarshal(params, &req); err != nil {
			return nil, fmt.Errorf("acpproxy: unmarshal elicitation params: %w", err)
		}
		resp, err := c.requestElicitation(ctx, req.ElicitationRequest)
		if err != nil {
			return nil, err
		}
		return resp, nil
	case acphelpers.ExtensionMethodCompactionUpdate:
		var notif methods.ACPCompactionNotification
		if err := json.Unmarshal(params, &notif); err != nil {
			slog.Error("acpproxy: failed to unmarshal compaction_update", "error", err)
			return nil, nil
		}
		// Legacy agents omit sessionId. Keep those notifications unscoped:
		// guessing from the process's active session is both ambiguous during a
		// concurrent session/load and unsafe while that operation holds proc.mu.
		// The UI has a conservative live-prompt fallback for this legacy shape.
		c.asyncNotifications.enqueue(c.routeCompactionUpdate, methods.ACPCompactionUpdateMethod, notif)
		return nil, nil
	case methods.ACPClaudeSDKMessageMethod:
		var notif methods.ACPClaudeSDKMessageNotification
		if err := json.Unmarshal(params, &notif); err != nil {
			slog.Debug("acpproxy: ignored malformed Claude SDK message", "error", err)
			return nil, nil
		}
		if notif.SessionID == "" || !validClaudeSDKMessage(notif.Message) {
			return nil, nil
		}
		c.asyncNotifications.enqueue(c.routeClaudeSessionEvent, method, notif)
		return nil, nil
	default:
		return nil, acpsdk.NewMethodNotFound(method)
	}
}

func validClaudeSDKMessage(message methods.ACPClaudeSDKPromptMessage) bool {
	switch message.Type {
	case methods.ACPClaudeSDKPromptSuggestionType:
		return strings.TrimSpace(message.Suggestion) != ""
	case methods.ACPClaudeSDKActiveGoalType:
		if len(message.Value) == 0 {
			return false
		}
		if strings.TrimSpace(string(message.Value)) == "null" {
			return true
		}
		var goal methods.ACPClaudeSDKActiveGoal
		if err := json.Unmarshal(message.Value, &goal); err != nil {
			return false
		}
		return strings.TrimSpace(goal.Condition) != "" &&
			goal.Iterations != nil && *goal.Iterations >= 0 &&
			goal.SetAt != nil && *goal.SetAt >= 0 &&
			goal.TokensAtStart != nil && *goal.TokensAtStart >= 0
	default:
		return false
	}
}

func showMessageType(t string) protocol.MessageType {
	switch t {
	case "error":
		return protocol.Error
	case "warning":
		return protocol.Warning
	case "info":
		return protocol.Info
	default:
		return protocol.Info
	}
}

func (c *acpClient) SessionUpdate(_ context.Context, params acpsdk.SessionNotification) error {
	// Observe Claude's result-boundary usage update before queueing the
	// notification for UI delivery. The adapter can settle its original ACP
	// prompt immediately after an injected steer while the continuation keeps
	// streaming; prompt lifecycle bookkeeping must see the boundary in wire
	// order even if the async delivery queue is busy.
	if c.handler != nil {
		c.handler.observeSessionUpdate(c.agentServer, string(params.SessionId), params.Update)
		// Revoke a leaked caller token before the update reaches any surface
		// or the control event log.
		c.handler.observeCallerTokenLeak(c.agentServer, string(params.SessionId), params.Update)
	}
	c.asyncNotifications.enqueue(c.routeSessionUpdate, acpsdk.ClientMethodSessionUpdate, params)
	return nil
}

// routeSessionUpdate delivers one agent session/update from the async queue.
// Live updates go through the event sink: stamped with a sequence number,
// buffered for resume, and fanned out to every client. Updates emitted while
// a session/load is in flight are an unclassifiable mix of replay and live
// traffic (pool acp interleaves them, see the mid-turn load probe), so they
// go unstamped to only the loading client — replayed history must never reach
// clients that already have the transcript.
func (c *acpClient) routeSessionUpdate(ctx context.Context, method string, params any) {
	notif, ok := params.(acpsdk.SessionNotification)
	if ok {
		c.persistSessionTitle(ctx, notif)
	}
	if !ok {
		c.notify(ctx, method, params)
		return
	}
	c.routeSessionEvent(ctx, method, string(notif.SessionId), params)
}

func (c *acpClient) routeClaudeSessionEvent(ctx context.Context, method string, params any) {
	notif, ok := params.(methods.ACPClaudeSDKMessageNotification)
	if !ok {
		c.notify(ctx, method, params)
		return
	}
	c.routeSessionEvent(ctx, method, notif.SessionID, params)
}

func (c *acpClient) routeCompactionUpdate(ctx context.Context, method string, params any) {
	notif, ok := params.(methods.ACPCompactionNotification)
	if !ok {
		c.notify(ctx, method, params)
		return
	}
	if notif.SessionID == "" {
		// Legacy agents cannot identify the session. Broadcast the unscoped
		// update so the surface that owns the one live prompt can conservatively
		// claim it; notifying only the primary loses remote-origin compactions.
		if c.handler != nil && c.handler.events != nil {
			message := map[string]any{"jsonrpc": "2.0", "method": method, "params": params}
			c.handler.events.NotifyAll(
				methods.JSONRPCNotifyMethod,
				bridgeMessage(c.agentServer, message),
			)
			return
		}
		c.notify(ctx, method, params)
		return
	}
	c.routeSessionEvent(ctx, method, string(notif.SessionID), params)
}

// enqueueTurnEnded places the helper-owned terminal boundary behind every
// agent notification already observed for the turn. This closes compaction
// state on all surfaces even when the agent omits phase=completed, and avoids
// a queued phase=started racing after the prompting surface's local finally.
func (c *acpClient) enqueueTurnEnded(sessionID acpsdk.SessionId) {
	c.asyncNotifications.enqueue(c.routeTurnEnded, methods.ACPTurnEndedMethod, methods.ACPTurnEndedNotification{
		SessionID: sessionID,
	})
}

func (c *acpClient) enqueueTurnEndedForTurn(sessionID acpsdk.SessionId, turn *activeTurn) {
	c.asyncNotifications.enqueue(func(ctx context.Context, method string, params any) {
		c.routeTurnEnded(ctx, method, params)
		cursor := c.handler.events.Cursor(c.agentServer, string(sessionID))
		c.handler.mu.Lock()
		turn.endCursor = cursor
		close(turn.eventsDone)
		c.handler.mu.Unlock()
	}, methods.ACPTurnEndedMethod, methods.ACPTurnEndedNotification{SessionID: sessionID})
}

func (c *acpClient) routeTurnEnded(ctx context.Context, method string, params any) {
	notif, ok := params.(methods.ACPTurnEndedNotification)
	if !ok {
		c.notify(ctx, method, params)
		return
	}
	if c.handler == nil || c.handler.events == nil {
		c.notify(ctx, method, params)
		return
	}
	events := c.handler.events
	defer events.EndTurn(c.agentServer, string(notif.SessionID))

	// This is always live helper traffic, never session/load replay. Broadcast
	// it even if a load begins after the prompt returns but before this queued
	// callback runs; scoping it to the loader would strand other surfaces.
	message := map[string]any{"jsonrpc": "2.0", "method": method, "params": params}
	events.PublishSessionUpdate(c.agentServer, string(notif.SessionID), "", false, message)
}

// routeSessionEvent preserves the agent connection's event order while
// delivering session-scoped extension notifications through the same
// multi-surface fan-out and load scoping as standard session/update traffic.
func (c *acpClient) routeSessionEvent(
	ctx context.Context,
	method string,
	sessionID string,
	params any,
) {
	if c.handler == nil || c.handler.events == nil {
		c.notify(ctx, method, params)
		return
	}
	events := c.handler.events
	message := map[string]any{
		"jsonrpc": "2.0",
		"method":  method,
		"params":  params,
	}
	if origin, scoped := c.handler.loadScopeFor(c.agentServer, sessionID); scoped {
		events.NotifyClient(origin, methods.JSONRPCNotifyMethod, bridgeMessage(c.agentServer, message))
		return
	}
	events.PublishSessionUpdate(c.agentServer, sessionID, "", false, message)
}

func (c *acpClient) persistSessionTitle(ctx context.Context, notif acpsdk.SessionNotification) {
	update := notif.Update.SessionInfoUpdate
	if update == nil || update.Title == nil || c.liveStatus == nil {
		return
	}
	title := sanitizeSessionTitle(*update.Title)
	if title == "" {
		return
	}
	if err := c.liveStatus.UpdateConversationTitle(ctx, c.gCtx, c.agentServer, string(notif.SessionId), title); err != nil {
		slog.Debug("acpproxy: failed to persist session title", "server", c.agentServer, "session_id", string(notif.SessionId), "error", err)
	}
}

// injectedTitlePatterns strip the same Camber-specific context markers that
// stripInjectedContextFromText removes from replayed user messages (see
// ui/packages/features/src/acp/features/session/hostContext.ts). Agents that
// flatten history into plain text on session/load may derive a replayed title
// from that flattened first message, gluing injected context (handoff or
// host-context resources) onto the user's text either before or after it.
// Each pattern is anchored to a Camber-specific marker so it cannot match
// genuine user text, and each tolerates a missing closing tag (truncated
// histories).
var injectedTitlePatterns = []*regexp.Regexp{
	// Cross-agent handoff resources use a session-specific URI, optionally
	// preceded by a bare copy of the same link (claude-code-acp glues the
	// link and the wrapper together when it flattens history).
	regexp.MustCompile(`(?:camber://handoff/[^\s"]+\.md\s*)?<context\s+ref="camber://handoff/[^"]+">[\s\S]*?(?:</context>|$)`),
	regexp.MustCompile(`<camber-handoff>[\s\S]*?(?:</camber-handoff>|$)`),
	// A bare handoff resource link left at either end of the flattened text
	// (e.g. a title truncated before the <context> wrapper).
	regexp.MustCompile(`^\s*camber://handoff/[^\s"]+\.md\s*|\s*camber://handoff/[^\s"]+\.md\s*$`),
	// claude-code-acp replays the host-context resource as its URI followed
	// by a <context ref="..."> wrapper around the resource text.
	regexp.MustCompile(`(?:camber://host-context\.md\s*)?<context\s+ref="camber://host-context\.md">[\s\S]*?(?:</context>|$)`),
	// Any agent that inlines the raw resource text.
	regexp.MustCompile(`<camber-system-instructions>[\s\S]*?(?:</camber-system-instructions>|$)`),
	// A bare host-context resource link left at either end of the flattened
	// text.
	regexp.MustCompile(`^\s*camber://host-context\.md\s*|\s*camber://host-context\.md\s*$`),
}

// sanitizeSessionTitle strips injected context markers (handoff and
// host-context resources) from an agent-authored title, keeping any real
// user text on either side of the marker. Agents that flatten history into
// plain text on session/load may glue the marker onto the user's text at
// the start, the end, or (for wrapped markers) both. Unlike the TypeScript
// equivalent (stripInjectedContextFromText, which only trims surrounding
// whitespace when a marker actually matched, to leave ordinary chat text
// byte-for-byte untouched), titles are always trimmed: they are short,
// display-only strings where leading/trailing whitespace is never
// meaningful. An empty result means the title was nothing but injected
// context and must not overwrite the stored title.
func sanitizeSessionTitle(title string) string {
	result := title
	for _, pattern := range injectedTitlePatterns {
		result = pattern.ReplaceAllString(result, "")
	}
	return strings.TrimSpace(result)
}

func (c *acpClient) waitForSessionUpdates(ctx context.Context) error {
	return c.asyncNotifications.wait(ctx)
}

type asyncNotification struct {
	notify notifyFn
	method string
	params any
}

type asyncNotificationQueue struct {
	once sync.Once
	mu   sync.Mutex
	cond *sync.Cond

	items   []asyncNotification
	head    int
	pending int
}

func (q *asyncNotificationQueue) init() {
	q.cond = sync.NewCond(&q.mu)
	go q.run()
}

func (q *asyncNotificationQueue) enqueue(notify notifyFn, method string, params any) {
	if notify == nil {
		return
	}
	q.once.Do(q.init)

	q.mu.Lock()
	q.items = append(q.items, asyncNotification{
		notify: notify,
		method: method,
		params: params,
	})
	q.pending++
	q.cond.Signal()
	q.mu.Unlock()
}

func (q *asyncNotificationQueue) wait(ctx context.Context) error {
	q.once.Do(q.init)

	stopWake := make(chan struct{})
	defer close(stopWake)
	go func() {
		select {
		case <-ctx.Done():
		case <-stopWake:
			return
		}
		q.mu.Lock()
		q.cond.Broadcast()
		q.mu.Unlock()
	}()

	q.mu.Lock()
	defer q.mu.Unlock()
	for q.pending > 0 {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		q.cond.Wait()
	}
	return nil
}

func (q *asyncNotificationQueue) run() {
	for {
		q.mu.Lock()
		for q.head >= len(q.items) {
			q.items = nil
			q.head = 0
			q.cond.Wait()
		}
		item := q.items[q.head]
		q.items[q.head] = asyncNotification{}
		q.head++
		if q.head > 1024 && q.head*2 >= len(q.items) {
			q.items = append([]asyncNotification(nil), q.items[q.head:]...)
			q.head = 0
		}
		q.mu.Unlock()

		item.notify(context.Background(), item.method, item.params)

		q.mu.Lock()
		q.pending--
		q.cond.Broadcast()
		q.mu.Unlock()
	}
}

func (c *acpClient) RequestPermission(ctx context.Context, params acpsdk.RequestPermissionRequest) (acpsdk.RequestPermissionResponse, error) {
	sessionID := string(params.SessionId)
	if sessionID != "" && c.liveStatus != nil {
		if err := c.liveStatus.SetConversationLiveStatus(ctx, c.gCtx, c.agentServer, sessionID, acpnav.ConversationLiveStatusPatch{
			WaitingForUser: acpnav.Bool(true),
			Unread:         acpnav.Bool(false),
		}); err != nil {
			slog.Debug("acpproxy: failed to mark permission pending", "server", c.agentServer, "session_id", sessionID, "error", err)
		}
		defer func() {
			if err := c.liveStatus.SetConversationLiveStatus(context.Background(), c.gCtx, c.agentServer, sessionID, acpnav.ConversationLiveStatusPatch{
				WaitingForUser: acpnav.Bool(false),
			}); err != nil {
				slog.Debug("acpproxy: failed to clear permission pending", "server", c.agentServer, "session_id", sessionID, "error", err)
			}
		}()
	}
	// The prompt is helper-owned state: register it in the approval store,
	// which pushes the pending set to every surface and blocks until the first
	// valid answer (or ctx cancellation) — no per-surface RPC race, no ghost
	// prompts to dismiss.
	store := c.approvalStore()
	if store == nil {
		return acpsdk.RequestPermissionResponse{
			Outcome: acpsdk.NewRequestPermissionOutcomeCancelled(),
		}, nil
	}
	return store.RequestPermission(ctx, c.agentServer, params)
}

// UnstableCreateElicitation handles the standard (unstable) ACP
// elicitation/create request, routing it through the same approval store as
// the pool extension elicitation so every surface renders and answers it the
// same way.
func (c *acpClient) UnstableCreateElicitation(ctx context.Context, params acpsdk.UnstableCreateElicitationRequest) (acpsdk.UnstableCreateElicitationResponse, error) {
	request, err := elicitationRequestFromStandard(params)
	if err != nil {
		return acpsdk.UnstableCreateElicitationResponse{}, err
	}
	resp, err := c.requestElicitation(ctx, request)
	if err != nil {
		return acpsdk.UnstableCreateElicitationResponse{}, err
	}
	return standardElicitationResponse(resp), nil
}

// UnstableCompleteElicitation resolves a pending URL elicitation once the
// agent reports its out-of-band flow finished: the blocked elicitation/create
// request unblocks as accepted and the prompt drops from every surface.
func (c *acpClient) UnstableCompleteElicitation(_ context.Context, params acpsdk.UnstableCompleteElicitationNotification) error {
	store := c.approvalStore()
	if store == nil {
		return nil
	}
	if !store.ResolveElicitation(c.agentServer, string(params.ElicitationId)) {
		slog.Debug("acpproxy: elicitation/complete for unknown elicitation", "server", c.agentServer, "elicitation_id", string(params.ElicitationId))
	}
	return nil
}

// requestElicitation registers an elicitation as helper-owned state, same as
// permissions: register and block on the approval store instead of racing an
// RPC across surfaces. Shared by the pool extension method and the standard
// (unstable) elicitation/create request.
func (c *acpClient) requestElicitation(ctx context.Context, request methods.ElicitationRequest) (methods.ACPElicitationOutput, error) {
	if request.SessionID == "" {
		// Attribute untagged elicitations to the connection's active
		// session so surfaces can route the prompt to the right chat.
		request.SessionID = c.currentSessionID()
	}
	sessionID := request.SessionID
	if sessionID != "" && c.liveStatus != nil {
		if err := c.liveStatus.SetConversationLiveStatus(ctx, c.gCtx, c.agentServer, sessionID, acpnav.ConversationLiveStatusPatch{
			WaitingForUser: acpnav.Bool(true),
			Unread:         acpnav.Bool(false),
		}); err != nil {
			slog.Debug("acpproxy: failed to mark elicitation pending", "server", c.agentServer, "session_id", sessionID, "error", err)
		}
		defer func() {
			if err := c.liveStatus.SetConversationLiveStatus(context.Background(), c.gCtx, c.agentServer, sessionID, acpnav.ConversationLiveStatusPatch{
				WaitingForUser: acpnav.Bool(false),
			}); err != nil {
				slog.Debug("acpproxy: failed to clear elicitation pending", "server", c.agentServer, "session_id", sessionID, "error", err)
			}
		}()
	}
	store := c.approvalStore()
	if store == nil {
		return methods.ACPElicitationOutput{}, fmt.Errorf("acpproxy: approval store not configured for elicitation")
	}
	resp, err := store.RequestElicitation(ctx, methods.ACPElicitationParams{
		ACPAgentServerParams: methods.ACPAgentServerParams{AgentServer: c.agentServer},
		ElicitationRequest:   request,
	})
	if err != nil {
		return methods.ACPElicitationOutput{}, fmt.Errorf("acpproxy: elicitation request failed: %w", err)
	}
	return resp, nil
}

func (c *acpClient) approvalStore() *approvals.Store {
	if c.handler == nil {
		return nil
	}
	return c.handler.approvals
}

func (c *acpClient) currentSessionID() string {
	if c.activeSession == nil {
		return ""
	}
	return string(c.activeSession())
}

func (c *acpClient) ReadTextFile(ctx context.Context, params acpsdk.ReadTextFileRequest) (acpsdk.ReadTextFileResponse, error) {
	if !filepath.IsAbs(params.Path) {
		return acpsdk.ReadTextFileResponse{}, fmt.Errorf("path must be absolute: %s", params.Path)
	}

	uri := protocol.URIFromPath(params.Path)
	b, err := c.readFile(ctx, uri)
	if err != nil {
		return acpsdk.ReadTextFileResponse{}, fmt.Errorf("read %s: %w", params.Path, err)
	}

	if params.Line == nil && params.Limit == nil && len(b) > maxReadTextFileResponseBytes {
		return acpsdk.ReadTextFileResponse{}, fmt.Errorf("file is too large to read without a line range: %s is %d bytes, max is %d bytes", params.Path, len(b), maxReadTextFileResponseBytes)
	}

	content := string(b)

	if params.Line != nil || params.Limit != nil {
		lines := strings.Split(content, "\n")
		start := 0
		if params.Line != nil && *params.Line > 0 {
			if *params.Line > len(lines) {
				return acpsdk.ReadTextFileResponse{}, fmt.Errorf("line is out of range (%d > %d)", *params.Line, len(lines))
			}
			start = *params.Line - 1
		}
		end := len(lines)
		if params.Limit != nil && *params.Limit > 0 {
			if start+*params.Limit < end {
				end = start + *params.Limit
			}
		}
		content = strings.Join(lines[start:end], "\n")
	}

	if len(content) > maxReadTextFileResponseBytes {
		return acpsdk.ReadTextFileResponse{}, fmt.Errorf("read_text_file response is too large: %s would return %d bytes, max is %d bytes", params.Path, len(content), maxReadTextFileResponseBytes)
	}

	return acpsdk.ReadTextFileResponse{Content: content}, nil
}

func (c *acpClient) WriteTextFile(ctx context.Context, params acpsdk.WriteTextFileRequest) (acpsdk.WriteTextFileResponse, error) {
	if !filepath.IsAbs(params.Path) {
		return acpsdk.WriteTextFileResponse{}, fmt.Errorf("path must be absolute: %s", params.Path)
	}

	dir := filepath.Dir(params.Path)
	if dir != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return acpsdk.WriteTextFileResponse{}, fmt.Errorf("mkdir %s: %w", dir, err)
		}
	}

	if err := os.WriteFile(params.Path, []byte(params.Content), 0o644); err != nil {
		return acpsdk.WriteTextFileResponse{}, fmt.Errorf("write %s: %w", params.Path, err)
	}

	return acpsdk.WriteTextFileResponse{}, nil
}

func (c *acpClient) CreateTerminal(_ context.Context, params acpsdk.CreateTerminalRequest) (acpsdk.CreateTerminalResponse, error) {
	slog.Debug("acpproxy: CreateTerminal (stub)")
	return acpsdk.CreateTerminalResponse{TerminalId: "term-stub-1"}, nil
}

func (c *acpClient) TerminalOutput(_ context.Context, _ acpsdk.TerminalOutputRequest) (acpsdk.TerminalOutputResponse, error) {
	return acpsdk.TerminalOutputResponse{}, nil
}

func (c *acpClient) ReleaseTerminal(_ context.Context, _ acpsdk.ReleaseTerminalRequest) (acpsdk.ReleaseTerminalResponse, error) {
	return acpsdk.ReleaseTerminalResponse{}, nil
}

func (c *acpClient) WaitForTerminalExit(_ context.Context, _ acpsdk.WaitForTerminalExitRequest) (acpsdk.WaitForTerminalExitResponse, error) {
	return acpsdk.WaitForTerminalExitResponse{}, nil
}

func (c *acpClient) KillTerminal(_ context.Context, _ acpsdk.KillTerminalRequest) (acpsdk.KillTerminalResponse, error) {
	return acpsdk.KillTerminalResponse{}, nil
}
