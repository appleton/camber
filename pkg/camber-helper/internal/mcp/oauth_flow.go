package mcp

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"slices"
	"time"

	"golang.org/x/oauth2"

	"github.com/appleton/camber/pkg/camber-helper/internal/mcp/oauthex"
)

// oauthFlowTimeout is the maximum time to wait for the user to complete the
// OAuth flow in their browser.
const oauthFlowTimeout = 10 * time.Minute

// discoveryHTTPTimeout bounds each metadata-discovery HTTP request. The default
// client has no timeout, so an unreachable or DNS-filtered provider would hang
// on the OS TCP/TLS timeouts (tens of seconds) per request before failing.
// Discovery makes several requests (Protected Resource Metadata, then up to two
// well-known paths per candidate issuer), so a fully black-holed host can still
// take a few of these back to back — under a minute in the worst case — before
// the connector reports its error.
const discoveryHTTPTimeout = 15 * time.Second

// OAuthFlowParams configures a single interactive MCP OAuth flow.
type OAuthFlowParams struct {
	// ServerURL is the MCP server URL. It is used to discover the
	// authorization-server metadata (via Protected Resource Metadata, falling
	// back to its scheme+host), and (with ServerID) forms the keychain key.
	ServerURL string
	// ServerID is the keychain key id used when ServerURL is empty.
	ServerID string
	// Scopes is the optional list of OAuth scopes to request.
	Scopes []string
	// ClientID selects a pre-registered public OAuth client. When empty, the
	// provider must support Dynamic Client Registration.
	ClientID string
	// CallbackPort is the pre-registered loopback redirect port. Zero lets the
	// OS choose a port and is intended for DCR flows and tests.
	CallbackPort int
	// DeepLinkRedirectURI, when non-empty, replaces the loopback callback
	// server with an OS deep-link redirect (DeepLinkOAuthRedirectURI): the
	// client receives the redirect from the OS and forwards it back over
	// JSON-RPC (DeliverOAuthCallback). Takes precedence over CallbackPort.
	DeepLinkRedirectURI string
	// OnAuthURL is invoked with the authorization URL so the caller can forward
	// it to the client (e.g. open a browser). Best-effort; the caller owns any
	// notification errors.
	OnAuthURL func(authURL string)
	// SecretsStore overrides the OS keychain store. Tests use an in-memory store.
	SecretsStore SecretsServerStore
}

// resolveAuthServerMeta discovers the authorization-server metadata for an MCP
// resource. Following the MCP authorization spec (RFC 9728), it first reads the
// resource's Protected Resource Metadata to learn which authorization server(s)
// the resource delegates to; these may live on a different origin than the MCP
// endpoint itself. Coda / Superhuman Docs, for example, serve their MCP
// endpoint at docs.superhuman.com but delegate OAuth to id.superhuman.com, and
// the metadata document at the resource origin advertises a third issuer
// (tokens.grammarly.com) that fails the RFC 8414 issuer check.
//
// It falls back to treating the resource's own scheme+host as the authorization
// server, which is correct for the many providers that co-locate the two and do
// not publish (usable) Protected Resource Metadata.
func resolveAuthServerMeta(ctx context.Context, serverURL, originURL string, c *http.Client) (*oauthex.AuthServerMeta, error) {
	var issuers []string
	var errs []error
	if prm, err := oauthex.GetProtectedResourceMetadataFromID(ctx, serverURL, c); err == nil {
		issuers = append(issuers, prm.AuthorizationServers...)
	} else {
		// Keep going — most providers publish no Protected Resource Metadata at
		// all and rely on the origin fallback below — but record the failure so
		// that if discovery fails entirely, the error explains why the PRM
		// route was not taken.
		errs = append(errs, fmt.Errorf("protected resource metadata: %w", withNetworkErrorHint(err, serverURL)))
	}
	// Always try the resource origin last: it preserves behavior for providers
	// whose authorization server is co-located with the MCP endpoint and that
	// publish no (or an unusable) Protected Resource Metadata document.
	if !slices.Contains(issuers, originURL) {
		issuers = append(issuers, originURL)
	}

	for _, issuer := range issuers {
		meta, err := oauthex.GetAuthServerMeta(ctx, issuer, c)
		if err == nil {
			return meta, nil
		}
		errs = append(errs, fmt.Errorf("authorization server %q: %w", issuer, withNetworkErrorHint(err, issuer)))
	}
	return nil, errors.Join(errs...)
}

// withNetworkErrorHint prefixes err with the networkErrorHint for rawURL's
// host, when one applies. Discovery can fail against a delegated authorization
// server on a different origin than the MCP endpoint, so the hint must name the
// host that actually failed, not the endpoint the user configured.
func withNetworkErrorHint(err error, rawURL string) error {
	host := rawURL
	if u, parseErr := url.Parse(rawURL); parseErr == nil && u.Host != "" {
		host = u.Host
	}
	if hint := networkErrorHint(err, host); hint != "" {
		return fmt.Errorf("%s: %w", hint, err)
	}
	return err
}

// networkErrorHint translates low-level connectivity failures during metadata
// discovery into a short, user-actionable explanation, or "" for errors that
// are already self-explanatory (HTTP statuses, malformed metadata, …). DNS
// filtering products are a real cause: they sinkhole whole hosting domains
// (e.g. *.netlify.app), so the browser — often on its own DoH resolver — loads
// the site fine while the helper's system-resolver connection hangs, resets, or
// hits the sinkhole's untrusted certificate.
func networkErrorHint(err error, host string) string {
	if _, ok := errors.AsType[*tls.CertificateVerificationError](err); ok {
		return fmt.Sprintf("%s presented an untrusted TLS certificate — a DNS filter or proxy on this network may be intercepting it", host)
	}
	if _, ok := errors.AsType[x509.UnknownAuthorityError](err); ok {
		return fmt.Sprintf("%s presented an untrusted TLS certificate — a DNS filter or proxy on this network may be intercepting it", host)
	}
	if _, ok := errors.AsType[*net.DNSError](err); ok {
		return fmt.Sprintf("could not look up %s — check this network's DNS", host)
	}
	if netErr, ok := errors.AsType[net.Error](err); ok && netErr.Timeout() {
		return fmt.Sprintf("%s did not respond — it may be down, or blocked by a DNS filter or firewall on this network", host)
	}
	if _, ok := errors.AsType[*net.OpError](err); ok {
		return fmt.Sprintf("could not connect to %s — it may be blocked by a DNS filter or firewall on this network", host)
	}
	return ""
}

// RunMCPOAuthFlow runs a PKCE OAuth flow against an MCP server and stores the
// resulting token in the keychain. The authorization code arrives on a
// loopback callback server, or via an OS deep link when
// DeepLinkRedirectURI is set. It uses a supplied
// pre-registered public client or falls back to Dynamic Client Registration.
// It blocks until the user completes (or cancels) the browser sign-in, or
// oauthFlowTimeout elapses.
//
// Callers supply OnAuthURL and handle their own success messaging.
func RunMCPOAuthFlow(ctx context.Context, p OAuthFlowParams) error {
	parsedURL, err := url.ParseRequestURI(p.ServerURL)
	if err != nil {
		return fmt.Errorf("invalid server URL: %w", err)
	}
	baseURL := parsedURL.Scheme + "://" + parsedURL.Host

	httpClient := newOAuthHTTPClient(discoveryHTTPTimeout)
	authMeta, err := resolveAuthServerMeta(ctx, p.ServerURL, baseURL, httpClient)
	if err != nil {
		return fmt.Errorf("resolve auth server metadata: %w", err)
	}
	// Discovery began at a URL the user supplied; these three come out of the
	// metadata document the server controls, so they are checked before the
	// helper fetches them or hands one to the browser.
	for _, endpoint := range []struct{ role, rawURL string }{
		{"authorization endpoint", authMeta.AuthorizationEndpoint},
		{"token endpoint", authMeta.TokenEndpoint},
		{"registration endpoint", authMeta.RegistrationEndpoint},
	} {
		if err := checkOAuthEndpointURLString(endpoint.rawURL, endpoint.role); err != nil {
			return err
		}
	}
	// Without either a pre-registered client or Dynamic Client Registration
	// (RFC 7591), there is no way to obtain a client ID. Fail before opening the
	// browser rather than surfacing a generic registration error mid-flow.
	if p.ClientID == "" && authMeta.RegistrationEndpoint == "" {
		return fmt.Errorf("the OAuth provider for %s does not support Dynamic Client Registration, so Camber cannot sign in to it: connect with a bearer token instead", parsedURL.Host)
	}

	state := oauth2.GenerateVerifier()
	var redirectURI string
	var waitForCode func(context.Context) (string, error)
	if p.DeepLinkRedirectURI != "" {
		callbackChan, cancel := deepLinkBroker.register(state)
		defer cancel()
		redirectURI = p.DeepLinkRedirectURI
		waitForCode = func(ctx context.Context) (string, error) {
			select {
			case result := <-callbackChan:
				return result.code, result.err
			case <-ctx.Done():
				return "", ctx.Err()
			}
		}
	} else {
		callbackServer, err := NewOAuthCallbackServerOnPort(state, p.CallbackPort)
		if err != nil {
			return fmt.Errorf("start callback server: %w", err)
		}
		defer callbackServer.Shutdown(ctx)
		redirectURI = callbackServer.CallbackURI()
		waitForCode = callbackServer.GetCodeAndShutdown
	}

	authMethod := "none"
	clientID := p.ClientID
	clientSecret := ""
	if clientID == "" {
		var regResponse *oauthex.ClientRegistrationResponse
		authMethod, regResponse, err = registerOAuthClientWithHTTPClient(ctx, authMeta.RegistrationEndpoint, redirectURI, authMeta.TokenEndpointAuthMethodsSupported, p.Scopes, httpClient)
		if err != nil {
			return fmt.Errorf("register OAuth client: %w", err)
		}
		clientID = regResponse.ClientID
		clientSecret = regResponse.ClientSecret
	}

	endpoint := oauth2.Endpoint{
		AuthURL:  authMeta.AuthorizationEndpoint,
		TokenURL: authMeta.TokenEndpoint,
	}
	// Public clients (no secret) must send client_id in the request body rather
	// than the Authorization header.
	if authMethod == "none" {
		endpoint.AuthStyle = oauth2.AuthStyleInParams
	}

	config := &oauth2.Config{
		ClientID:     clientID,
		ClientSecret: clientSecret,
		RedirectURL:  redirectURI,
		Scopes:       p.Scopes,
		Endpoint:     endpoint,
	}

	codeVerifier := oauth2.GenerateVerifier()
	authURL := config.AuthCodeURL(state,
		oauth2.AccessTypeOffline,
		oauth2.S256ChallengeOption(codeVerifier),
	)
	if p.OnAuthURL != nil {
		p.OnAuthURL(authURL)
	}

	// The browser round-trip can outlive the request ctx; use a detached ctx with
	// its own timeout so callback/exchange/store aren't cancelled mid-flight.
	oauthCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), oauthFlowTimeout)
	defer cancel()
	// The token endpoint also comes from server-controlled metadata, so the
	// exchange must go through the guarded client rather than oauth2's default.
	oauthCtx = context.WithValue(oauthCtx, oauth2.HTTPClient, httpClient)

	authCode, err := waitForCode(oauthCtx)
	if err != nil {
		return fmt.Errorf("OAuth callback: %w", err)
	}

	token, err := config.Exchange(oauthCtx, authCode, oauth2.VerifierOption(codeVerifier))
	if err != nil {
		return fmt.Errorf("token exchange: %w", err)
	}

	key, err := NewServerKey(p.ServerURL, p.ServerID)
	if err != nil {
		return fmt.Errorf("server key: %w", err)
	}
	store := p.SecretsStore
	if store == nil {
		store = NewKeyringSecretsServerStore()
	}
	secrets, err := store.Load(oauthCtx, key)
	if err != nil {
		return fmt.Errorf("load existing secrets: %w", err)
	}
	if secrets == nil {
		secrets = &ServerSecrets{}
	}
	secrets.OAuth = NewOAuthData(token, config)
	if err := store.Save(oauthCtx, key, secrets); err != nil {
		return fmt.Errorf("store token: %w", err)
	}
	return nil
}

// DeleteMCPServerSecrets removes any stored secrets (OAuth tokens, metadata) for
// the given MCP server from the keychain.
func DeleteMCPServerSecrets(ctx context.Context, serverURL, serverID string) error {
	key, err := NewServerKey(serverURL, serverID)
	if err != nil {
		return fmt.Errorf("server key: %w", err)
	}
	return NewKeyringSecretsServerStore().Delete(ctx, key)
}
