package handler

import (
	"context"

	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/camber-helper/internal/handler/acpproxy"
	"github.com/appleton/camber/pkg/camber-helper/internal/handler/remoteaccess"
	"github.com/appleton/camber/pkg/camber-helper/methods"
)

// sessionEventSink adapts the remote-access hub + session log to acpproxy's
// SessionEventSink: live session/update events are stamped with per-session
// sequence numbers, buffered for cursor resume, and fanned out to every
// connected client; session/load replay traffic is delivered to only the
// loading client.
type sessionEventSink struct {
	log *remoteaccess.SessionLog
	hub *remoteaccess.Hub
}

var _ acpproxy.SessionEventSink = (*sessionEventSink)(nil)

func (s *sessionEventSink) PublishSessionUpdate(agentServer, sessionID, originDevice string, skipPrimary bool, message map[string]any) int64 {
	return s.log.Publish(agentServer, sessionID, originDevice, skipPrimary, message)
}

func (s *sessionEventSink) NotifyClient(originID string, method string, params any) {
	s.hub.NotifyClient(originID, method, params)
}

func (s *sessionEventSink) NotifyAll(method string, params any) {
	s.hub.NotifyAll(method, params)
}

func (s *sessionEventSink) BeginTurn(agentServer, sessionID string) {
	s.log.BeginTurn(agentServer, sessionID)
}

func (s *sessionEventSink) EndTurn(agentServer, sessionID string) {
	s.log.EndTurn(agentServer, sessionID)
}

func (s *sessionEventSink) Cursor(agentServer, sessionID string) acpproxy.SessionCursor {
	info := s.log.Cursor(agentServer, sessionID)
	return acpproxy.SessionCursor{Epoch: info.Epoch, Seq: info.Seq, TurnActive: info.TurnActive}
}

// remoteResume replays buffered live session events after the caller's
// cursors (allowlisted for remote clients; see methods.RemoteResumeMethod).
func (h *CamberHandler) remoteResume(ctx context.Context, params *methods.RemoteResumeParams, gCtx *glsp.Context) (methods.RemoteResumeOutput, error) {
	return h.sessionLog.Resume(methods.ClientOriginFromContext(ctx), params.Sessions), nil
}
