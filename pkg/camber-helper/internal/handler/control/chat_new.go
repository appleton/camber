package control

import (
	"context"

	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

// chatWorkspacePath is the workspace of conversations in the desktop's Chats
// section (acpnav's chat workspace). chat.new accepts it as workspacePath (CLI
// `chat new --chat`) to create a chat instead of a project conversation.
const chatWorkspacePath = "CHAT"

// chatDirectory creates a new chat's working directory exactly as the
// desktop's New Chat does: acpnav's createChat keyed by the conversation id.
// The navigation store recognises that directory as a chat, so the
// conversation renders in Chats.
func (s *Service) chatDirectory(ctx context.Context, conversationID string, g *glsp.Context) (string, error) {
	out, err := s.nav.CreateChat(ctx, &methods.ACPNavCreateChatParams{SessionID: conversationID}, g)
	if err != nil {
		return "", err
	}
	return out.Path, nil
}
