package handler

import (
	"context"
	"fmt"
	"log/slog"

	pkgerrors "github.com/pkg/errors"
	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/camber-helper/gopls/pkg/protocol"
	"github.com/appleton/camber/pkg/camber-helper/internal/mcp"
	"github.com/appleton/camber/pkg/camber-helper/methods"
)

func (h *CamberHandler) InitiateMCPOAuth(ctx context.Context, params *methods.InitiateMCPOAuthParams, gCtx *glsp.Context) (*methods.InitiateMCPOAuthOutput, error) {
	log := slog.With("server_id", params.ServerID, "server_name", params.ServerName, "server_url", params.ServerURL)
	log.Info("Initiating MCP OAuth flow")

	if params.ServerURL == "" {
		return nil, pkgerrors.New("server URL is required")
	}
	if params.ServerID == "" {
		return nil, pkgerrors.New("server ID is required")
	}

	err := mcp.RunMCPOAuthFlow(ctx, mcp.OAuthFlowParams{
		ServerURL: params.ServerURL,
		ServerID:  params.ServerID,
		OnAuthURL: func(authURL string) {
			log.Info("Notifying client to open OAuth URL", "auth_url", authURL)
			if notifyErr := gCtx.Notify(ctx, methods.MCPOAuthURLParams{}.MethodName(), &methods.MCPOAuthURLParams{
				ServerID: params.ServerID,
				AuthURL:  authURL,
			}); notifyErr != nil {
				log.Warn("Failed to notify client of OAuth URL", "error", notifyErr)
			}
		},
	})
	if err != nil {
		return nil, pkgerrors.Wrap(err, "MCP OAuth flow")
	}

	log.Info("Successfully completed MCP OAuth flow and stored token")

	// The flow may have outlived the request ctx; use a detached ctx so the
	// success toast still reaches the client.
	if err := gCtx.Notify(context.WithoutCancel(ctx), "window/showMessage", protocol.ShowMessageParams{
		Type:    protocol.Info,
		Message: fmt.Sprintf("camber: Successfully signed in to %s MCP", params.ServerName),
	}); err != nil {
		log.Warn("Failed to notify client of OAuth completion", "error", err)
	}

	return &methods.InitiateMCPOAuthOutput{}, nil
}

// MCPOAuthCallback completes a pending deep-link OAuth flow with the redirect
// URL the client received from the OS (camber://oauth/callback?…). Flows
// wait on this only when they were started with a deep-link redirect.
func (h *CamberHandler) MCPOAuthCallback(_ context.Context, params *methods.MCPOAuthCallbackParams, _ *glsp.Context) (*methods.MCPOAuthCallbackOutput, error) {
	if err := mcp.DeliverOAuthCallback(params.URL); err != nil {
		return nil, pkgerrors.Wrap(err, "MCP OAuth callback")
	}
	return &methods.MCPOAuthCallbackOutput{}, nil
}

func (h *CamberHandler) DeleteMCPSecrets(ctx context.Context, params *methods.DeleteMCPSecretsParams, _ *glsp.Context) (*methods.DeleteMCPSecretsOutput, error) {
	log := slog.With("server_id", params.ServerID, "server_url", params.ServerURL)

	if err := mcp.DeleteMCPServerSecrets(ctx, params.ServerURL, params.ServerID); err != nil {
		return nil, pkgerrors.Wrap(err, "failed to delete MCP secrets")
	}

	log.Info("Successfully deleted MCP server secrets")
	return &methods.DeleteMCPSecretsOutput{}, nil
}
