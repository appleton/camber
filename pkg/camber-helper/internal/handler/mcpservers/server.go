package mcpservers

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"strings"
	"sync"

	pkgerrors "github.com/pkg/errors"
	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/camber-helper/gopls/pkg/protocol"
	"github.com/appleton/camber/pkg/camber-helper/internal/mcp"
	"github.com/appleton/camber/pkg/camber-helper/methods"
)

// Server handles camber/mcpServers/* JSON-RPC methods.
type Server struct {
	store *Store
	// secrets is the keychain-backed store consulted for OAuth token presence;
	// injectable so tests avoid the real keychain.
	secrets mcp.SecretsServerStore
	// notifyChanged runs after every successful connector mutation
	// (upsert/delete/toggle/sign-in/sign-out) — anything that changes what the
	// next session injection resolves. The owning handler wires it to the
	// camber/mcpServers/didChange broadcast; nil (e.g. in tests) disables it.
	notifyChanged func()
	// deepLinkOAuthCapable reports whether the connected client can receive
	// camber:// OAuth deep links (initialize clientCapabilities); nil means no.
	deepLinkOAuthCapable func() bool
	// stamp is the last-seen connectors-file fingerprint (see watcher.go).
	stampMu sync.Mutex
	stamp   storeStamp
}

func NewServer() *Server {
	return &Server{store: NewStore(), secrets: mcp.NewKeyringSecretsServerStore()}
}

// SetChangeNotifier registers the callback invoked after successful connector
// mutations (see Server.notifyChanged).
func (s *Server) SetChangeNotifier(notify func()) {
	s.notifyChanged = notify
}

// SetDeepLinkOAuthCapable registers the probe for whether the connected client
// can receive camber:// OAuth deep links (see Server.deepLinkOAuthCapable).
func (s *Server) SetDeepLinkOAuthCapable(capable func() bool) {
	s.deepLinkOAuthCapable = capable
}

func (s *Server) changed() {
	// Refresh the watcher's fingerprint first so our own store write does not
	// re-fire through the external-change poller.
	s.rememberStamp()
	if s.notifyChanged != nil {
		s.notifyChanged()
	}
}

func (s *Server) List(ctx context.Context, _ *methods.MCPServersListParams, _ *glsp.Context) (*methods.MCPServersListOutput, error) {
	servers, err := s.store.List()
	if err != nil {
		return nil, pkgerrors.Wrap(err, "list MCP servers")
	}
	// Annotate OAuth servers with token presence so clients can surface a
	// needs-sign-in state without probing each server.
	for i := range servers {
		entry := &servers[i]
		if entry.URL == "" || entry.AuthMode != methods.MCPServerAuthModeOAuth {
			continue
		}
		authenticated := mcp.HasStoredOAuthToken(ctx, s.secrets, entry.URL, entry.Name)
		entry.OAuthAuthenticated = &authenticated
	}
	return &methods.MCPServersListOutput{Servers: servers}, nil
}

func (s *Server) Upsert(_ context.Context, params *methods.MCPServersUpsertParams, _ *glsp.Context) (*methods.MCPServersUpsertOutput, error) {
	if err := validateEntry(params.Server); err != nil {
		return nil, err
	}
	if err := s.store.Upsert(params.Server); err != nil {
		return nil, pkgerrors.Wrap(err, "upsert MCP server")
	}
	s.changed()
	return &methods.MCPServersUpsertOutput{}, nil
}

func (s *Server) Delete(ctx context.Context, params *methods.MCPServersDeleteParams, _ *glsp.Context) (*methods.MCPServersDeleteOutput, error) {
	entry, err := s.store.Get(params.Name)
	if err != nil {
		return nil, pkgerrors.Wrap(err, "delete MCP server: load entry")
	}
	// Clean up any keychain secrets if the server has a URL.
	if entry != nil && entry.URL != "" {
		if delErr := mcp.DeleteMCPServerSecrets(ctx, entry.URL, entry.Name); delErr != nil {
			slog.Warn("mcpservers: delete OAuth secrets", "name", entry.Name, "error", delErr)
		}
	}
	if err := s.store.Delete(params.Name); err != nil {
		return nil, pkgerrors.Wrap(err, "delete MCP server")
	}
	s.changed()
	return &methods.MCPServersDeleteOutput{}, nil
}

func (s *Server) SetEnabled(_ context.Context, params *methods.MCPServersSetEnabledParams, _ *glsp.Context) (*methods.MCPServersSetEnabledOutput, error) {
	if err := s.store.SetEnabled(params.Name, params.Enabled); err != nil {
		return nil, pkgerrors.Wrap(err, "set MCP server enabled")
	}
	s.changed()
	return &methods.MCPServersSetEnabledOutput{}, nil
}

// Authenticate initiates an OAuth flow for the named HTTP MCP server, using the
// shared PKCE + pre-registered-client-or-DCR loopback flow.
func (s *Server) Authenticate(ctx context.Context, params *methods.MCPServersAuthenticateParams, gCtx *glsp.Context) (*methods.MCPServersAuthenticateOutput, error) {
	log := slog.With("name", params.Name)
	log.Info("mcpservers: initiating OAuth")

	entry, err := s.store.Get(params.Name)
	if err != nil {
		return nil, pkgerrors.Wrap(err, "mcpservers: load server for OAuth")
	}
	if entry == nil {
		return nil, pkgerrors.Errorf("mcpservers: server %q not found", params.Name)
	}
	if entry.URL == "" {
		return nil, pkgerrors.Errorf("mcpservers: server %q is a stdio server — OAuth is for HTTP servers only", params.Name)
	}

	// Prefer the camber:// deep-link redirect when the connector opts in and
	// the client can receive it; otherwise fall back to the loopback callback.
	// A pre-registered client with no loopback port has no fallback: only the
	// deep-link redirect is registered with its provider.
	useDeepLink := entry.OAuthDeepLink && s.deepLinkOAuthCapable != nil && s.deepLinkOAuthCapable()
	if entry.OAuthDeepLink && !useDeepLink && entry.OAuthClientID != "" && entry.OAuthCallbackPort == 0 {
		return nil, pkgerrors.Errorf("mcpservers: server %q signs in via a camber:// redirect, which this app cannot receive — sign in from the Camber desktop app", params.Name)
	}
	flowParams := mcp.OAuthFlowParams{
		ServerURL:    entry.URL,
		ServerID:     entry.Name,
		Scopes:       strings.Fields(entry.OAuthScopes),
		ClientID:     entry.OAuthClientID,
		CallbackPort: entry.OAuthCallbackPort,
	}
	if useDeepLink {
		flowParams.DeepLinkRedirectURI = mcp.DeepLinkOAuthRedirectURI
	}
	flowParams.OnAuthURL = func(authURL string) {
		log.Info("mcpservers: sending OAuth URL to client", "auth_url", authURL)
		if notifyErr := gCtx.Notify(ctx, methods.MCPOAuthURLParams{}.MethodName(), &methods.MCPOAuthURLParams{
			ServerID: entry.Name,
			AuthURL:  authURL,
		}); notifyErr != nil {
			log.Warn("mcpservers: failed to notify client of OAuth URL", "error", notifyErr)
		}
	}

	err = mcp.RunMCPOAuthFlow(ctx, flowParams)
	if err != nil {
		return nil, pkgerrors.Wrap(err, "mcpservers: OAuth flow")
	}

	log.Info("mcpservers: OAuth complete")
	// A fresh token flips the server from needs_auth to injectable.
	s.changed()
	if notifyErr := gCtx.Notify(context.WithoutCancel(ctx), "window/showMessage", protocol.ShowMessageParams{
		Type:    protocol.Info,
		Message: fmt.Sprintf("camber: signed in to %s MCP server", entry.Name),
	}); notifyErr != nil {
		log.Warn("mcpservers: failed to notify OAuth success", "error", notifyErr)
	}

	return &methods.MCPServersAuthenticateOutput{}, nil
}

// SignOut removes stored OAuth tokens for the named server from the keychain.
func (s *Server) SignOut(ctx context.Context, params *methods.MCPServersSignOutParams, _ *glsp.Context) (*methods.MCPServersSignOutOutput, error) {
	entry, err := s.store.Get(params.Name)
	if err != nil {
		return nil, pkgerrors.Wrap(err, "mcpservers: load server for sign-out")
	}
	if entry == nil {
		return nil, pkgerrors.Errorf("mcpservers: server %q not found", params.Name)
	}
	if entry.URL == "" {
		return nil, pkgerrors.Errorf("mcpservers: server %q has no URL — nothing to sign out of", params.Name)
	}

	if err := mcp.DeleteMCPServerSecrets(ctx, entry.URL, entry.Name); err != nil {
		return nil, pkgerrors.Wrap(err, "mcpservers: delete OAuth secrets")
	}

	slog.Info("mcpservers: signed out", "name", params.Name)
	s.changed()
	return &methods.MCPServersSignOutOutput{}, nil
}

// TestConnection runs a transient probe against the named server and returns
// the cached result. The probe is on-demand (runs only on explicit user request).
func (s *Server) TestConnection(ctx context.Context, params *methods.MCPServersTestConnectionParams, _ *glsp.Context) (*methods.MCPServersTestConnectionOutput, error) {
	entry, err := s.store.Get(params.Name)
	if err != nil {
		return nil, pkgerrors.Wrap(err, "mcpservers: load server for test")
	}
	if entry == nil {
		return nil, pkgerrors.Errorf("mcpservers: server %q not found", params.Name)
	}

	// Resolve OAuth token if needed.
	bearerToken := entry.BearerToken
	if entry.URL != "" && entry.AuthMode == methods.MCPServerAuthModeOAuth {
		token, _, _ := resolveOAuthToken(ctx, *entry)
		bearerToken = token
	}

	probe := mcpProbeEntry{
		Name:        entry.Name,
		Command:     entry.Command,
		Args:        entry.Args,
		Env:         entry.Env,
		URL:         entry.URL,
		Headers:     entry.Headers,
		BearerToken: bearerToken,
	}
	result := ProbeServer(ctx, probe)

	out := &methods.MCPServersTestConnectionOutput{
		OK:        result.OK,
		ToolCount: result.ToolCount,
		ToolNames: result.ToolNames,
		Error:     result.Error,
	}
	return out, nil
}

// TestConfig runs a transient probe against an inline (unsaved) server config.
// The UI uses this to validate a connector before adding it. OAuth servers
// cannot be fully probed before authentication, so callers should treat an
// auth-required failure as "addable, authenticate after".
func (s *Server) TestConfig(ctx context.Context, params *methods.MCPServersTestConfigParams, _ *glsp.Context) (*methods.MCPServersTestConfigOutput, error) {
	if err := validateEntry(params.Server); err != nil {
		return &methods.MCPServersTestConfigOutput{OK: false, Error: err.Error()}, nil
	}

	entry := params.Server
	probe := mcpProbeEntry{
		Name:        entry.Name,
		Command:     entry.Command,
		Args:        entry.Args,
		Env:         entry.Env,
		URL:         entry.URL,
		Headers:     entry.Headers,
		BearerToken: entry.BearerToken,
	}
	result := ProbeServer(ctx, probe)

	return &methods.MCPServersTestConfigOutput{
		OK:        result.OK,
		ToolCount: result.ToolCount,
		ToolNames: result.ToolNames,
		Error:     result.Error,
	}, nil
}

func validateServerURL(rawURL string) error {
	u, err := url.ParseRequestURI(rawURL)
	if err != nil {
		return pkgerrors.Wrap(err, "invalid MCP server URL")
	}
	if u.Scheme == "https" {
		return nil
	}
	if u.Scheme == "http" {
		host := u.Hostname()
		if host == "localhost" {
			return nil
		}
		ip := net.ParseIP(host)
		if ip != nil && ip.IsLoopback() {
			return nil
		}
		return pkgerrors.New("MCP server URL must use https for non-loopback hosts")
	}
	return pkgerrors.Errorf("MCP server URL scheme %q is not supported (use https or http://localhost)", u.Scheme)
}

// isSSEURL reports whether a remote MCP URL uses the legacy HTTP+SSE transport,
// identified by convention by a path ending in "/sse" (e.g. Atlassian's
// https://mcp.atlassian.com/v1/sse). Streamable-HTTP endpoints conventionally
// end in "/mcp". We route by this so the agent connects with the matching
// transport — sending an SSE endpoint as streamable HTTP does not reliably work.
func isSSEURL(rawURL string) bool {
	u, err := url.Parse(rawURL)
	if err != nil {
		return false
	}
	return strings.HasSuffix(strings.TrimSuffix(u.Path, "/"), "/sse")
}

func validateEntry(e methods.MCPServerEntry) error {
	if e.Name == "" {
		return pkgerrors.New("MCP server name is required")
	}
	hasStdio := e.Command != ""
	hasHTTP := e.URL != ""
	if !hasStdio && !hasHTTP {
		return pkgerrors.New("MCP server must have either command (stdio) or url (http)")
	}
	if hasStdio && hasHTTP {
		return pkgerrors.New("MCP server must not have both command and url")
	}
	if hasHTTP {
		if err := validateServerURL(e.URL); err != nil {
			return err
		}
	}
	if e.OAuthDeepLink && e.AuthMode != methods.MCPServerAuthModeOAuth {
		return pkgerrors.New("deep-link OAuth redirect requires OAuth authentication")
	}
	if e.OAuthClientID != "" {
		if e.AuthMode != methods.MCPServerAuthModeOAuth {
			return pkgerrors.New("OAuth client ID requires OAuth authentication")
		}
		// A pre-registered client needs at least one redirect the provider knows:
		// a fixed loopback port, a deep-link redirect, or both (deep link on the
		// desktop app, loopback fallback elsewhere).
		if e.OAuthCallbackPort == 0 && !e.OAuthDeepLink {
			return pkgerrors.New("OAuth client ID requires a callback port or a deep-link redirect")
		}
		if e.OAuthCallbackPort != 0 && (e.OAuthCallbackPort < 1 || e.OAuthCallbackPort > 65535) {
			return pkgerrors.New("OAuth callback port must be between 1 and 65535")
		}
	} else if e.OAuthCallbackPort != 0 {
		return pkgerrors.New("OAuth callback port requires an OAuth client ID")
	}
	return nil
}
