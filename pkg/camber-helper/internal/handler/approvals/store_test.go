package approvals

import (
	"context"
	"testing"

	acpsdk "github.com/coder/acp-go-sdk"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

func permissionFixture(sessionID, toolCallID string) acpsdk.RequestPermissionRequest {
	return acpsdk.RequestPermissionRequest{
		SessionId: acpsdk.SessionId(sessionID),
		ToolCall:  acpsdk.ToolCallUpdate{ToolCallId: acpsdk.ToolCallId(toolCallID)},
		Options: []acpsdk.PermissionOption{
			{OptionId: "allow", Kind: "allow_once", Name: "Allow"},
			{OptionId: "deny", Kind: "reject_once", Name: "Deny"},
		},
	}
}

func respondPermission(sessionID, toolCallID, optionID string) methods.ACPApprovalsRespondParams {
	return methods.ACPApprovalsRespondParams{
		AgentServer: "poolside",
		SessionID:   sessionID,
		Kind:        methods.ACPApprovalKindPermission,
		ID:          toolCallID,
		OptionID:    optionID,
	}
}

// startPermission registers a permission request on a goroutine and returns
// the response channel plus the first pushed pending set.
func startPermission(t *testing.T, store *Store, pushed chan []methods.ACPApproval, sessionID, toolCallID string) chan acpsdk.RequestPermissionResponse {
	t.Helper()
	done := make(chan acpsdk.RequestPermissionResponse, 1)
	go func() {
		resp, _ := store.RequestPermission(context.Background(), "poolside", permissionFixture(sessionID, toolCallID))
		done <- resp
	}()
	pending := <-pushed
	require.NotEmpty(t, pending)
	return done
}

func newPushedStore() (*Store, chan []methods.ACPApproval) {
	store := NewStore()
	pushed := make(chan []methods.ACPApproval, 16)
	store.SetNotifier(func(pending []methods.ACPApproval) { pushed <- pending })
	return store, pushed
}

func TestFirstValidAnswerWinsAndLatersGetAlreadyResolved(t *testing.T) {
	store, pushed := newPushedStore()
	done := startPermission(t, store, pushed, "s1", "tc-1")

	first := store.Respond(respondPermission("s1", "tc-1", "allow"))
	assert.Equal(t, methods.ACPApprovalOutcomeAccepted, first.Outcome)

	// Any later answer — from a slower surface — is a no-op.
	second := store.Respond(respondPermission("s1", "tc-1", "deny"))
	assert.Equal(t, methods.ACPApprovalOutcomeAlreadyResolved, second.Outcome)

	resp := <-done
	require.NotNil(t, resp.Outcome.Selected)
	assert.Equal(t, acpsdk.PermissionOptionId("allow"), resp.Outcome.Selected.OptionId)
	assert.Empty(t, <-pushed)
}

func TestInvalidOptionDoesNotResolve(t *testing.T) {
	store, pushed := newPushedStore()
	done := startPermission(t, store, pushed, "s1", "tc-1")

	out := store.Respond(respondPermission("s1", "tc-1", "nonexistent-option"))
	assert.Equal(t, methods.ACPApprovalOutcomeInvalid, out.Outcome)
	// Still pending: a corrupt answer must not kill the prompt.
	assert.Len(t, store.Pending(), 1)

	valid := store.Respond(respondPermission("s1", "tc-1", "deny"))
	assert.Equal(t, methods.ACPApprovalOutcomeAccepted, valid.Outcome)
	resp := <-done
	require.NotNil(t, resp.Outcome.Selected)
	assert.Equal(t, acpsdk.PermissionOptionId("deny"), resp.Outcome.Selected.OptionId)
}

func TestElicitationAnswerRoundTrips(t *testing.T) {
	store, pushed := newPushedStore()
	done := make(chan methods.ACPElicitationOutput, 1)
	go func() {
		out, _ := store.RequestElicitation(context.Background(), methods.ACPElicitationParams{
			ACPAgentServerParams: methods.ACPAgentServerParams{AgentServer: "poolside"},
			ElicitationRequest: methods.ElicitationRequest{
				SessionID:     "s1",
				ElicitationID: "e-1",
				Mode:          methods.ElicitationMode("form"),
			},
		})
		done <- out
	}()
	pending := <-pushed
	require.Len(t, pending, 1)
	require.NotNil(t, pending[0].Elicitation)

	badAction := store.Respond(methods.ACPApprovalsRespondParams{
		AgentServer: "poolside", SessionID: "s1",
		Kind: methods.ACPApprovalKindElicitation, ID: "e-1",
		Action: "explode",
	})
	assert.Equal(t, methods.ACPApprovalOutcomeInvalid, badAction.Outcome)

	out := store.Respond(methods.ACPApprovalsRespondParams{
		AgentServer: "poolside", SessionID: "s1",
		Kind: methods.ACPApprovalKindElicitation, ID: "e-1",
		Action:  string(methods.ElicitationActionAccept),
		Content: map[string]any{"name": "hello.txt"},
	})
	assert.Equal(t, methods.ACPApprovalOutcomeAccepted, out.Outcome)

	answer := <-done
	assert.Equal(t, methods.ElicitationActionAccept, answer.Action)
	assert.Equal(t, map[string]any{"name": "hello.txt"}, answer.Content)
}

func TestResolveElicitationAcceptsByIDAlone(t *testing.T) {
	store, pushed := newPushedStore()
	done := make(chan methods.ACPElicitationOutput, 1)
	go func() {
		out, _ := store.RequestElicitation(context.Background(), methods.ACPElicitationParams{
			ACPAgentServerParams: methods.ACPAgentServerParams{AgentServer: "poolside"},
			ElicitationRequest: methods.ElicitationRequest{
				SessionID:     "s1",
				ElicitationID: "e-1",
				Mode:          methods.ElicitationMode("url"),
			},
		})
		done <- out
	}()
	require.Len(t, <-pushed, 1)

	assert.False(t, store.ResolveElicitation("poolside", ""))
	assert.False(t, store.ResolveElicitation("poolside", "e-unknown"))
	assert.False(t, store.ResolveElicitation("other-server", "e-1"))
	assert.True(t, store.ResolveElicitation("poolside", "e-1"))

	answer := <-done
	assert.Equal(t, methods.ElicitationActionAccept, answer.Action)
	assert.Empty(t, <-pushed)
	assert.Empty(t, store.Pending())
}

func TestResolveElicitationIgnoresFormEntries(t *testing.T) {
	store, pushed := newPushedStore()
	done := make(chan methods.ACPElicitationOutput, 1)
	go func() {
		out, _ := store.RequestElicitation(context.Background(), methods.ACPElicitationParams{
			ACPAgentServerParams: methods.ACPAgentServerParams{AgentServer: "poolside"},
			ElicitationRequest: methods.ElicitationRequest{
				SessionID:     "s1",
				ElicitationID: "e-1",
				Mode:          methods.ElicitationModeForm,
			},
		})
		done <- out
	}()
	require.Len(t, <-pushed, 1)

	// An id-colliding elicitation/complete must not accept a form on the
	// user's behalf.
	assert.False(t, store.ResolveElicitation("poolside", "e-1"))
	require.Len(t, store.Pending(), 1)

	store.CancelSession("poolside", "s1")
	answer := <-done
	assert.Equal(t, methods.ElicitationActionCancel, answer.Action)
}

func TestContextCancellationRemovesEntryAndPushes(t *testing.T) {
	store, pushed := newPushedStore()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan acpsdk.RequestPermissionResponse, 1)
	go func() {
		resp, _ := store.RequestPermission(ctx, "poolside", permissionFixture("s1", "tc-1"))
		done <- resp
	}()
	require.Len(t, <-pushed, 1)

	cancel()
	resp := <-done
	require.NotNil(t, resp.Outcome.Cancelled)
	assert.Empty(t, <-pushed)
	assert.Empty(t, store.Pending())
}

func TestCancelSessionResolvesOnlyThatSession(t *testing.T) {
	store, pushed := newPushedStore()
	doneA := startPermission(t, store, pushed, "s1", "tc-1")
	doneB := startPermission(t, store, pushed, "s2", "tc-2")

	store.CancelSession("poolside", "s1")

	respA := <-doneA
	require.NotNil(t, respA.Outcome.Cancelled)
	pending := <-pushed
	require.Len(t, pending, 1)
	assert.Equal(t, "s2", pending[0].SessionID)

	store.Respond(respondPermission("s2", "tc-2", "allow"))
	respB := <-doneB
	require.NotNil(t, respB.Outcome.Selected)
}

func TestPendingKeepsRegistrationOrder(t *testing.T) {
	store, pushed := newPushedStore()
	startPermission(t, store, pushed, "s1", "tc-1")
	startPermission(t, store, pushed, "s1", "tc-2")
	startPermission(t, store, pushed, "s2", "tc-3")

	pending := store.Pending()
	require.Len(t, pending, 3)
	assert.Equal(t, []string{"tc-1", "tc-2", "tc-3"}, []string{pending[0].ID, pending[1].ID, pending[2].ID})
}

func TestUnkeyablePermissionIsCancelledImmediately(t *testing.T) {
	store, _ := newPushedStore()
	resp, err := store.RequestPermission(context.Background(), "poolside", acpsdk.RequestPermissionRequest{
		SessionId: "s1",
		// No toolCallId — cannot be identified across surfaces.
	})
	require.NoError(t, err)
	require.NotNil(t, resp.Outcome.Cancelled)
	assert.Empty(t, store.Pending())
}
