package mcpservers

import (
	"context"
	"log/slog"
	"net/url"
	"strings"

	"github.com/appleton/camber/pkg/camber-helper/internal/mcp"
	"github.com/appleton/camber/pkg/camber-helper/methods"
)

const (
	huggingFaceHost           = "huggingface.co"
	huggingFaceReadReposScope = "read-repos"
)

// HuggingFaceTokenSource returns a function that resolves the OAuth access
// token of the user's Hugging Face connector — an enabled OAuth HTTP server
// whose URL host is huggingface.co (any connector name works). It returns ""
// when no such connector exists or its token cannot be resolved, so callers
// (e.g. gated local-inference model downloads) can treat it as best-effort.
func (s *Server) HuggingFaceTokenSource() func(context.Context) string {
	return func(ctx context.Context) string {
		entry := s.findHuggingFaceConnector()
		if entry == nil {
			return ""
		}
		secrets := s.secrets
		if secrets == nil {
			secrets = mcp.NewKeyringSecretsServerStore()
		}
		token, err := mcp.ResolveAccessToken(ctx, secrets, entry.URL, entry.Name)
		if err != nil {
			slog.Debug("mcpservers: resolve Hugging Face connector token", "name", entry.Name, "error", err)
			return ""
		}
		return token
	}
}

// InvalidateHuggingFaceToken removes the enabled Hugging Face connector's
// rejected OAuth credential and broadcasts the authentication-state change.
func (s *Server) InvalidateHuggingFaceToken(ctx context.Context) error {
	entry := s.findHuggingFaceConnector()
	if entry == nil {
		return nil
	}
	key, err := mcp.NewServerKey(entry.URL, entry.Name)
	if err != nil {
		return err
	}
	secrets := s.secrets
	if secrets == nil {
		secrets = mcp.NewKeyringSecretsServerStore()
	}
	if err := secrets.Delete(ctx, key); err != nil {
		return err
	}
	slog.Info("mcpservers: invalidated rejected Hugging Face OAuth token", "name", entry.Name)
	s.changed()
	return nil
}

func (s *Server) findHuggingFaceConnector() *methods.MCPServerEntry {
	entries, err := s.store.List()
	if err != nil {
		slog.Warn("mcpservers: list servers for Hugging Face token", "error", err)
		return nil
	}
	for _, e := range entries {
		if !e.Enabled || e.URL == "" || e.AuthMode != methods.MCPServerAuthModeOAuth {
			continue
		}
		if isHuggingFaceURL(e.URL) && hasOAuthScope(e.OAuthScopes, huggingFaceReadReposScope) {
			return &e
		}
	}
	return nil
}

func isHuggingFaceURL(rawURL string) bool {
	u, err := url.Parse(rawURL)
	if err != nil {
		return false
	}
	host := strings.ToLower(u.Hostname())
	return host == huggingFaceHost || strings.HasSuffix(host, "."+huggingFaceHost)
}

func hasOAuthScope(scopes, required string) bool {
	required = strings.ToLower(strings.TrimSpace(required))
	for _, scope := range strings.Fields(scopes) {
		if strings.ToLower(scope) == required {
			return true
		}
	}
	return false
}
