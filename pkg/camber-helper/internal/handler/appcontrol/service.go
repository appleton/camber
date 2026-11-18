// Package appcontrol holds the desktop's conversation-management operations
// that do not need UI state, so the desktop UI (through camber/app/* helper
// methods) and the camber control CLI (through control actions) run the same
// code. Operations that do need the desktop window's own state are forwarded
// to it as helper -> desktop requests (camber/desktopApp/*).
package appcontrol

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
	pkgerrors "github.com/pkg/errors"
	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/camber-helper/internal/handler/acpnav"
	"github.com/appleton/camber/pkg/camber-helper/internal/handler/acpproxy"
	"github.com/appleton/camber/pkg/camber-helper/methods"
)

// Agent is the part of the ACP proxy every operation needs. The optional
// interfaces below (session deletion and rename, capabilities, cancelling a
// running turn) are type-asserted, so partial fakes stay usable in tests.
type Agent interface {
	CloseSession(context.Context, *methods.ACPCloseSessionParams, *glsp.Context) (*methods.ACPCloseSessionOutput, error)
}

// Service runs conversation-management operations against the navigation
// store and the agents.
type Service struct {
	nav   *acpnav.Server
	agent Agent
}

// New builds the service. It holds no state of its own.
func New(nav *acpnav.Server, agent Agent) *Service {
	return &Service{nav: nav, agent: agent}
}

// renameSessionTimeout bounds the background agent-side rename.
const renameSessionTimeout = 30 * time.Second

// desktopRequestTimeout bounds a helper -> desktop request.
const desktopRequestTimeout = 15 * time.Second

// ArchiveConversation archives a conversation as the desktop sidebar does: it
// archives the navigation row, which cascades to the sub-agents rendered
// under it (closing their sessions in the background), then closes the
// conversation's own agent session, cancelling a running turn. A failed close
// is logged, not returned: the archive itself succeeded and restoring reopens
// the session through session/resume or session/load.
func (s *Service) ArchiveConversation(ctx context.Context, params *methods.AppArchiveConversationParams, g *glsp.Context) (methods.AppArchiveConversationOutput, error) {
	state, archived, err := s.nav.ArchiveConversationWithDescendants(ctx, &methods.ACPNavArchiveConversationParams{
		WorkspacePath:  params.WorkspacePath,
		ConversationID: params.ConversationID,
		AgentServer:    params.AgentServer,
		SessionID:      params.SessionID,
	}, g)
	if err != nil {
		return methods.AppArchiveConversationOutput{}, err
	}
	if params.SessionID != "" {
		if _, err := s.agent.CloseSession(ctx, &methods.ACPCloseSessionParams{
			ACPAgentServerParams: methods.ACPAgentServerParams{AgentServer: params.AgentServer},
			CloseSessionRequest:  acpsdk.CloseSessionRequest{SessionId: acpsdk.SessionId(params.SessionID)},
			CancelInFlight:       true,
		}, g); err != nil {
			slog.WarnContext(ctx, "appcontrol: closing archived conversation's session failed", "agentServer", params.AgentServer, "sessionId", params.SessionID, "error", err)
		}
	}
	return methods.AppArchiveConversationOutput{
		State:       state,
		Archived:    nonNil(archived.Archived),
		Descendants: nonNil(archived.Descendants),
	}, nil
}

// RenameConversation renames a conversation as the desktop does: the name
// becomes the conversation's nickname, and, when the agent advertises session
// rename, also its title and the agent-side session title. The agent-side
// rename runs in the background and a failure is only logged, as in the UI.
func (s *Service) RenameConversation(ctx context.Context, params *methods.AppRenameConversationParams, g *glsp.Context) (methods.ACPNavState, error) {
	name := strings.TrimSpace(params.Name)
	if params.ConversationID == "" {
		return methods.ACPNavState{}, pkgerrors.New("conversationId is required")
	}
	if name == "" {
		return methods.ACPNavState{}, pkgerrors.New("conversation name is required")
	}
	var renameSession *methods.ACPRenameSessionParams
	if row, err := s.nav.ControlConversation(ctx, params.ConversationID); err == nil && row.SessionID != "" && s.Capabilities(row.AgentServer).Rename {
		renameSession = &methods.ACPRenameSessionParams{ACPAgentServerParams: methods.ACPAgentServerParams{AgentServer: row.AgentServer}}
		renameSession.SessionID = acpsdk.SessionId(row.SessionID)
		renameSession.Title = name
	}
	title := ""
	if renameSession != nil {
		title = name
	}
	state, err := s.nav.RenameConversation(ctx, &methods.ACPNavRenameConversationParams{ConversationID: params.ConversationID, Nickname: name, Title: title}, g)
	if err != nil {
		return methods.ACPNavState{}, err
	}
	if renamer, ok := s.agent.(sessionRenamer); ok && renameSession != nil {
		go func() {
			renameCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), renameSessionTimeout)
			defer cancel()
			if _, err := renamer.RenameSession(renameCtx, renameSession, g); err != nil {
				slog.Debug("appcontrol: ACP session rename failed", "agentServer", renameSession.AgentServer, "sessionId", renameSession.SessionID, "error", err)
			}
		}()
	}
	return state, nil
}

// DeleteConversation deletes a conversation as the desktop does: it removes
// the navigation row, then deletes the agent session: the one params name, or
// the conversation's recorded session when params name no agent at all (a
// conversation without a session passes only its agent), and drops the
// conversation's control record. With CancelInFlight a running
// turn is cancelled first, as the desktop does for the selected conversation.
// Clients are notified of the new navigation state.
func (s *Service) DeleteConversation(ctx context.Context, params *methods.AppDeleteConversationParams, g *glsp.Context) (methods.ACPNavState, error) {
	if params.ConversationID == "" {
		return methods.ACPNavState{}, pkgerrors.New("conversationId is required")
	}
	agentServer, sessionID := params.AgentServer, params.SessionID
	if agentServer == "" && sessionID == "" {
		if row, err := s.nav.ControlConversation(ctx, params.ConversationID); err == nil {
			agentServer, sessionID = row.AgentServer, row.SessionID
		}
	}
	if params.CancelInFlight && sessionID != "" {
		if canceller, ok := s.agent.(inFlightCanceller); ok {
			if err := canceller.CancelInFlightTurn(ctx, agentServer, sessionID, g); err != nil {
				return methods.ACPNavState{}, err
			}
		}
	}
	state, err := s.nav.DeleteConversation(ctx, &methods.ACPNavDeleteConversationParams{ConversationID: params.ConversationID}, g)
	if err != nil {
		return methods.ACPNavState{}, err
	}
	// The conversation's control record (CLI parentage, origin, last turn)
	// goes with it, so a deleted conversation leaves nothing for the CLI.
	if err := s.nav.DeleteControlState(ctx, controlConversationKey(params.ConversationID)); err != nil {
		slog.WarnContext(ctx, "appcontrol: deleting conversation control state failed", "conversationId", params.ConversationID, "error", err)
	}
	s.nav.NotifyDidChange(ctx, g)
	if sessionID == "" {
		return state, nil
	}
	deleter, ok := s.agent.(sessionDeleter)
	if !ok {
		return state, pkgerrors.New("the agent connection cannot delete sessions")
	}
	if _, err := deleter.DeleteSession(ctx, &methods.ACPDeleteSessionParams{
		ACPAgentServerParams: methods.ACPAgentServerParams{AgentServer: agentServer},
		DeleteSessionRequest: acpsdk.DeleteSessionRequest{SessionId: acpsdk.SessionId(sessionID)},
	}, g); err != nil {
		return state, err
	}
	return state, nil
}

// Capabilities reports the agent's conversation-management capabilities from
// its initialize response; Known is false before the agent has initialized.
func (s *Service) Capabilities(agentServer string) acpproxy.SessionManagementCapabilities {
	if source, ok := s.agent.(capabilitySource); ok {
		return source.SessionManagementCapabilities(agentServer)
	}
	return acpproxy.SessionManagementCapabilities{}
}

// OpenConversation asks the desktop window to show a conversation, the same
// way a clicked notification does: focus the window and select it.
func (s *Service) OpenConversation(ctx context.Context, conversationID string, g *glsp.Context) error {
	return desktopRequest(ctx, g, methods.DesktopAppOpenConversationMethod, methods.DesktopAppOpenConversationParams{ConversationID: conversationID})
}

// RemoveProject asks the desktop window to remove a project the way its
// sidebar does: unregister it (with its worktrees and their conversation
// rows) and close the project's terminals.
func (s *Service) RemoveProject(ctx context.Context, path string, g *glsp.Context) error {
	return desktopRequest(ctx, g, methods.DesktopAppRemoveProjectMethod, methods.DesktopAppRemoveProjectParams{Path: path})
}

type sessionRenamer interface {
	RenameSession(context.Context, *methods.ACPRenameSessionParams, *glsp.Context) (*methods.ACPRenameSessionOutput, error)
}

type sessionDeleter interface {
	DeleteSession(context.Context, *methods.ACPDeleteSessionParams, *glsp.Context) (*methods.ACPDeleteSessionOutput, error)
}

type capabilitySource interface {
	SessionManagementCapabilities(string) acpproxy.SessionManagementCapabilities
}

type inFlightCanceller interface {
	CancelInFlightTurn(ctx context.Context, agentServer, sessionID string, g *glsp.Context) error
}

// desktopRequest sends a request to the connected desktop client and waits,
// bounded, for its answer.
func desktopRequest(ctx context.Context, g *glsp.Context, method string, params any) error {
	if g == nil || g.Call == nil {
		return noDesktopError(method)
	}
	ctx, cancel := context.WithTimeout(ctx, desktopRequestTimeout)
	defer cancel()
	var out json.RawMessage
	if err := g.Call(ctx, method, params, &out); err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "method not found") {
			return noDesktopError(method)
		}
		if ctx.Err() != nil {
			return pkgerrors.Errorf("the Camber desktop window did not answer %s within %s; make sure a desktop window is open", method, desktopRequestTimeout)
		}
		return pkgerrors.Wrapf(err, "desktop window failed %s", method)
	}
	return nil
}

func noDesktopError(method string) error {
	return pkgerrors.Errorf("no Camber desktop window is attached to handle %s; open the Camber desktop app and retry", method)
}

// controlConversationKey is the control-state id of a conversation's record
// (metadata key control/conversation/<id>).
func controlConversationKey(conversationID string) string {
	return "conversation/" + conversationID
}

func nonNil(ids []string) []string {
	if ids == nil {
		return []string{}
	}
	return ids
}
