// Package approvals owns pending agent approvals (permission prompts and
// elicitations) as helper-side state. The agent's in-flight request blocks on
// the store; every surface renders the pushed pending set and answers via
// Respond, where the first valid answer wins atomically. This replaces the
// former first-response-wins RPC broadcast, whose per-surface ghost prompts
// could not be dismissed or deduplicated across reconnects.
package approvals

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"sync"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"

	"github.com/appleton/camber/pkg/acp"
	"github.com/appleton/camber/pkg/camber-helper/methods"
)

// Notifier receives the full pending set after every change. Wired to fan out
// camber/acp/approvals/didChange to every connected surface.
type Notifier func(pending []methods.ACPApproval)

type key struct {
	agentServer string
	sessionID   string
	kind        string
	id          string
}

type entry struct {
	approval methods.ACPApproval
	// Valid option ids for kind=permission; Respond rejects unknown options
	// so a stale or corrupted answer cannot resolve the agent's request.
	validOptions map[string]struct{}
	resolve      chan methods.ACPApprovalsRespondParams
	seq          uint64
}

type Store struct {
	mu      sync.Mutex
	entries map[key]*entry
	nextSeq uint64

	notifyMu sync.Mutex
	notify   Notifier
}

func NewStore() *Store {
	return &Store{entries: map[key]*entry{}}
}

// SetNotifier installs the didChange fan-out. Safe to call once at wiring
// time, before any approvals exist.
func (s *Store) SetNotifier(notify Notifier) {
	s.notifyMu.Lock()
	defer s.notifyMu.Unlock()
	s.notify = notify
}

// Pending returns the current pending set in registration order.
func (s *Store) Pending() []methods.ACPApproval {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.pendingLocked()
}

// RequestPermission registers the agent's permission request and blocks until
// a surface answers it or ctx is cancelled (the agent abandoning the turn).
// Either way the entry is removed and the new set is pushed, so no surface
// can be left showing a dead prompt.
func (s *Store) RequestPermission(
	ctx context.Context,
	agentServer string,
	params acpsdk.RequestPermissionRequest,
) (acpsdk.RequestPermissionResponse, error) {
	cancelled := acpsdk.RequestPermissionResponse{Outcome: acpsdk.NewRequestPermissionOutcomeCancelled()}
	if params.ToolCall.ToolCallId == "" || len(params.Options) == 0 {
		return cancelled, nil
	}
	toolCall, err := json.Marshal(params.ToolCall)
	if err != nil {
		return cancelled, fmt.Errorf("approvals: marshal toolCall: %w", err)
	}
	options, err := json.Marshal(params.Options)
	if err != nil {
		return cancelled, fmt.Errorf("approvals: marshal options: %w", err)
	}
	validOptions := make(map[string]struct{}, len(params.Options))
	for _, option := range params.Options {
		validOptions[string(option.OptionId)] = struct{}{}
	}

	k := key{
		agentServer: agentServer,
		sessionID:   string(params.SessionId),
		kind:        methods.ACPApprovalKindPermission,
		id:          string(params.ToolCall.ToolCallId),
	}
	approval := methods.ACPApproval{
		AgentServer: k.agentServer,
		SessionID:   k.sessionID,
		Kind:        k.kind,
		ID:          k.id,
		Permission:  &methods.ACPApprovalPermission{ToolCall: toolCall, Options: options},
		CreatedAt:   time.Now().UTC().Format(time.RFC3339),
	}

	answer, ok := s.wait(ctx, k, approval, validOptions)
	if !ok {
		return cancelled, nil
	}
	outcome := acpsdk.NewRequestPermissionOutcomeSelected(acpsdk.PermissionOptionId(answer.OptionID))
	if meta := acp.EncodeOverrideRules(answer.OverrideRules); meta != nil {
		outcome.Selected.Meta = meta
	}
	return acpsdk.RequestPermissionResponse{Outcome: outcome}, nil
}

// RequestElicitation registers the agent's elicitation and blocks until a
// surface answers or ctx is cancelled.
func (s *Store) RequestElicitation(
	ctx context.Context,
	params methods.ACPElicitationParams,
) (methods.ACPElicitationOutput, error) {
	cancelled := methods.ACPElicitationOutput{Action: methods.ElicitationActionCancel}
	if params.ElicitationID == "" {
		return cancelled, fmt.Errorf("approvals: elicitation without elicitationId")
	}
	request := params.ElicitationRequest
	k := key{
		agentServer: params.AgentServer,
		sessionID:   params.SessionID,
		kind:        methods.ACPApprovalKindElicitation,
		id:          params.ElicitationID,
	}
	approval := methods.ACPApproval{
		AgentServer: k.agentServer,
		SessionID:   k.sessionID,
		Kind:        k.kind,
		ID:          k.id,
		Elicitation: &request,
		CreatedAt:   time.Now().UTC().Format(time.RFC3339),
	}

	answer, ok := s.wait(ctx, k, approval, nil)
	if !ok {
		return cancelled, nil
	}
	return methods.ACPElicitationOutput{
		Action:  methods.ElicitationAction(answer.Action),
		Content: answer.Content,
	}, nil
}

// Respond answers one pending approval. The first valid answer removes the
// entry, unblocks the agent's request, and pushes the shrunken set; anything
// later (or unknown) reports already_resolved so the answering surface just
// drops its card. Invalid permission options are rejected without resolving.
func (s *Store) Respond(params methods.ACPApprovalsRespondParams) methods.ACPApprovalsRespondOutput {
	k := key{
		agentServer: params.AgentServer,
		sessionID:   params.SessionID,
		kind:        params.Kind,
		id:          params.ID,
	}

	s.mu.Lock()
	e, exists := s.entries[k]
	if !exists {
		s.mu.Unlock()
		return methods.ACPApprovalsRespondOutput{Outcome: methods.ACPApprovalOutcomeAlreadyResolved}
	}
	if !validAnswer(e, params) {
		s.mu.Unlock()
		return methods.ACPApprovalsRespondOutput{Outcome: methods.ACPApprovalOutcomeInvalid}
	}
	delete(s.entries, k)
	pending := s.pendingLocked()
	s.mu.Unlock()

	// Buffered(1): the waiter may have already left on ctx cancellation; the
	// send must not block Respond in that race.
	e.resolve <- params
	s.push(pending)
	return methods.ACPApprovalsRespondOutput{Outcome: methods.ACPApprovalOutcomeAccepted}
}

// ResolveElicitation answers a pending URL elicitation as accepted,
// identified by its id alone: URL elicitations complete out-of-band via the
// agent's elicitation/complete notification, which carries no session. Only
// url-mode entries qualify — form ids are helper-synthesized and never leave
// the helper, so an id collision from a buggy agent must not accept a form on
// the user's behalf. Returns false when no such elicitation is pending.
func (s *Store) ResolveElicitation(agentServer, elicitationID string) bool {
	if elicitationID == "" {
		return false
	}
	s.mu.Lock()
	var resolved *entry
	var resolvedKey key
	for k, e := range s.entries {
		if k.agentServer == agentServer && k.kind == methods.ACPApprovalKindElicitation && k.id == elicitationID &&
			e.approval.Elicitation != nil && e.approval.Elicitation.Mode == methods.ElicitationModeURL {
			resolved, resolvedKey = e, k
			break
		}
	}
	if resolved == nil {
		s.mu.Unlock()
		return false
	}
	delete(s.entries, resolvedKey)
	pending := s.pendingLocked()
	s.mu.Unlock()

	resolved.resolve <- methods.ACPApprovalsRespondParams{
		AgentServer: resolvedKey.agentServer,
		SessionID:   resolvedKey.sessionID,
		Kind:        resolvedKey.kind,
		ID:          resolvedKey.id,
		Action:      string(methods.ElicitationActionAccept),
	}
	s.push(pending)
	return true
}

// CancelSession resolves every pending approval for a session as abandoned.
// Used when the session's turn is torn down outside the per-request ctx path.
func (s *Store) CancelSession(agentServer, sessionID string) {
	s.mu.Lock()
	var cancelled []*entry
	for k, e := range s.entries {
		if k.agentServer == agentServer && k.sessionID == sessionID {
			delete(s.entries, k)
			cancelled = append(cancelled, e)
		}
	}
	pending := s.pendingLocked()
	s.mu.Unlock()

	if len(cancelled) == 0 {
		return
	}
	for _, e := range cancelled {
		close(e.resolve)
	}
	s.push(pending)
}

// wait registers the entry, pushes the grown set, and blocks until an answer
// arrives or ctx cancels. Returns ok=false for cancellation/abandonment.
func (s *Store) wait(
	ctx context.Context,
	k key,
	approval methods.ACPApproval,
	validOptions map[string]struct{},
) (methods.ACPApprovalsRespondParams, bool) {
	e := &entry{
		approval:     approval,
		validOptions: validOptions,
		resolve:      make(chan methods.ACPApprovalsRespondParams, 1),
	}

	s.mu.Lock()
	// A re-registered key (agent retrying the same tool call) supersedes the
	// old entry; the superseded waiter unblocks as cancelled.
	if old, exists := s.entries[k]; exists {
		close(old.resolve)
	}
	s.nextSeq++
	e.seq = s.nextSeq
	s.entries[k] = e
	pending := s.pendingLocked()
	s.mu.Unlock()
	s.push(pending)

	select {
	case answer, ok := <-e.resolve:
		if !ok {
			// Superseded or session-cancelled: entry removal (and its push)
			// happened wherever the channel was closed.
			return methods.ACPApprovalsRespondParams{}, false
		}
		return answer, true
	case <-ctx.Done():
		s.mu.Lock()
		// Respond may have won this race and already removed the entry — the
		// buffered answer exists but the agent is gone; drop it.
		if current, exists := s.entries[k]; exists && current == e {
			delete(s.entries, k)
		}
		pending := s.pendingLocked()
		s.mu.Unlock()
		s.push(pending)
		return methods.ACPApprovalsRespondParams{}, false
	}
}

func (s *Store) pendingLocked() []methods.ACPApproval {
	entries := make([]*entry, 0, len(s.entries))
	for _, e := range s.entries {
		entries = append(entries, e)
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].seq < entries[j].seq })
	pending := make([]methods.ACPApproval, len(entries))
	for i, e := range entries {
		pending[i] = e.approval
	}
	return pending
}

func (s *Store) push(pending []methods.ACPApproval) {
	s.notifyMu.Lock()
	notify := s.notify
	s.notifyMu.Unlock()
	if notify != nil {
		notify(pending)
	}
}

func validAnswer(e *entry, params methods.ACPApprovalsRespondParams) bool {
	switch params.Kind {
	case methods.ACPApprovalKindPermission:
		_, ok := e.validOptions[params.OptionID]
		return ok
	case methods.ACPApprovalKindElicitation:
		switch methods.ElicitationAction(params.Action) {
		case methods.ElicitationActionAccept, methods.ElicitationActionDecline, methods.ElicitationActionCancel:
			return true
		}
		return false
	default:
		return false
	}
}
