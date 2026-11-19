package acpproxy

import (
	"context"

	acpsdk "github.com/coder/acp-go-sdk"
	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

// SessionManagementCapabilities reports which conversation-management calls
// an agent server advertised in its initialize response, the same response
// the desktop reads its capabilities from. Known is false until the agent has
// initialized in this helper.
type SessionManagementCapabilities struct {
	Known bool
	// Rename is the poolside `_meta.rename_session` capability the desktop
	// checks before renaming the agent-side session.
	Rename bool
	// Delete is sessionCapabilities.delete, which the desktop requires before
	// it offers to delete a conversation with an agent session.
	Delete bool
}

// SessionManagementCapabilities returns the conversation-management
// capabilities of agentServer's running process.
func (h *Handler) SessionManagementCapabilities(agentServer string) SessionManagementCapabilities {
	h.mu.Lock()
	proc := h.procs[normalizeServerName(agentServer)]
	h.mu.Unlock()
	if proc == nil {
		return SessionManagementCapabilities{}
	}
	initResp, err := proc.initializeResponse()
	if err != nil {
		return SessionManagementCapabilities{}
	}
	return sessionManagementCapabilities(initResp.AgentCapabilities)
}

// CancelInFlightTurn cancels a running prompt in the session and waits,
// bounded, for it to stop, exactly as CloseSession does with CancelInFlight.
// It is a no-op when no prompt is running.
func (h *Handler) CancelInFlightTurn(ctx context.Context, agentServer, sessionID string, gCtx *glsp.Context) error {
	return h.cancelInFlightForClose(ctx, &methods.ACPCloseSessionParams{
		ACPAgentServerParams: methods.ACPAgentServerParams{AgentServer: agentServer},
		CloseSessionRequest:  acpsdk.CloseSessionRequest{SessionId: acpsdk.SessionId(sessionID)},
	}, gCtx)
}

func sessionManagementCapabilities(caps acpsdk.AgentCapabilities) SessionManagementCapabilities {
	rename, _ := caps.Meta["rename_session"].(bool)
	return SessionManagementCapabilities{
		Known:  true,
		Rename: rename,
		Delete: caps.SessionCapabilities.Delete != nil,
	}
}
