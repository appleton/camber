package methods

import "encoding/json"

// Approvals: helper-owned pending-approval state. Agent-initiated permission
// prompts and elicitations are registered in the helper's approval store and
// pushed to every surface as STATE (idempotent set), instead of being raced
// as first-response-wins RPC broadcasts. Surfaces answer via the respond
// method; the first valid answer wins atomically and the shrunken set is
// pushed to everyone, so a prompt can never linger as a stale card on a
// surface that lost the race.
const (
	// ACPApprovalsDidChangeMethod notifies every surface of the full pending
	// approval set whenever it changes. Also the shape returned by list.
	ACPApprovalsDidChangeMethod = acpMethodPrefix + "approvals/didChange"
	// ACPApprovalsRespondMethod answers one pending approval. First valid
	// answer wins; later answers get OutcomeAlreadyResolved.
	ACPApprovalsRespondMethod = acpMethodPrefix + "approvals/respond"
	// ACPApprovalsListMethod returns the current pending set; surfaces pull it
	// at boot and after a reconnect, and rely on didChange pushes in between.
	ACPApprovalsListMethod = acpMethodPrefix + "approvals/list"
)

// Approval kinds.
const (
	ACPApprovalKindPermission  = "permission"
	ACPApprovalKindElicitation = "elicitation"
)

// Respond outcomes.
const (
	ACPApprovalOutcomeAccepted        = "accepted"
	ACPApprovalOutcomeAlreadyResolved = "already_resolved"
	ACPApprovalOutcomeInvalid         = "invalid"
)

// ACPApproval is one pending approval, identified across every surface by
// (agentServer, sessionId, kind, id) where id is the toolCallId for
// permissions and the elicitationId for elicitations.
type ACPApproval struct {
	AgentServer string `json:"agentServer"`
	SessionID   string `json:"sessionId"`
	Kind        string `json:"kind"`
	ID          string `json:"id"`
	// Permission payload (kind == permission): the original ACP
	// session/request_permission toolCall and options, verbatim, so surfaces
	// render exactly what the agent asked.
	Permission *ACPApprovalPermission `json:"permission,omitempty"`
	// Elicitation payload (kind == elicitation): the original request.
	Elicitation *ElicitationRequest `json:"elicitation,omitempty"`
	CreatedAt   string              `json:"createdAt,omitempty"`
}

// ACPApprovalPermission carries the ACP permission request content as raw
// JSON — the SDK types round-trip through here untouched.
type ACPApprovalPermission struct {
	ToolCall json.RawMessage `json:"toolCall"`
	Options  json.RawMessage `json:"options"`
}

// ACPApprovalsDidChangeParams is the didChange payload and the list output:
// the complete pending set. Surfaces reconcile against it (set-diff by key),
// which makes re-delivery after reconnects idempotent by construction.
type ACPApprovalsDidChangeParams struct {
	Pending []ACPApproval `json:"pending"`
}

// ACPApprovalsRespondParams answers one pending approval.
type ACPApprovalsRespondParams struct {
	AgentServer string `json:"agentServer"`
	SessionID   string `json:"sessionId"`
	Kind        string `json:"kind"`
	ID          string `json:"id"`
	// Permission answers: the selected option, with optional user-edited
	// override rules (camber/permission_override_rules).
	OptionID      string   `json:"optionId,omitempty"`
	OverrideRules []string `json:"overrideRules,omitempty"`
	// Elicitation answers: accept | decline | cancel, with accept content.
	Action  string         `json:"action,omitempty"`
	Content map[string]any `json:"content,omitempty"`
}

// ACPApprovalsRespondOutput reports whether this answer won the approval.
type ACPApprovalsRespondOutput struct {
	Outcome string `json:"outcome"`
}
