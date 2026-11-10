package mcp

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/oauth2"
)

// newAuthMetaServer serves RFC 8414 authorization-server metadata for itself,
// with or without a Dynamic Client Registration endpoint.
func newAuthMetaServer(t *testing.T, withDCR bool) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	mux.HandleFunc("/.well-known/oauth-authorization-server", func(w http.ResponseWriter, _ *http.Request) {
		meta := map[string]any{
			"issuer":                           server.URL,
			"authorization_endpoint":           server.URL + "/authorize",
			"token_endpoint":                   server.URL + "/token",
			"response_types_supported":         []string{"code"},
			"code_challenge_methods_supported": []string{"S256"},
		}
		if withDCR {
			meta["registration_endpoint"] = server.URL + "/register"
		}
		w.Header().Set("Content-Type", "application/json")
		require.NoError(t, json.NewEncoder(w).Encode(meta))
	})
	return server
}

// TestResolveAuthServerMetaFollowsProtectedResourceMetadata reproduces the Coda
// / Superhuman Docs case: the MCP endpoint and its authorization server sit on
// different origins, and the resource origin itself serves authorization-server
// metadata whose issuer would fail the RFC 8414 check. Discovery must follow the
// Protected Resource Metadata to the delegated authorization server instead.
func TestResolveAuthServerMetaFollowsProtectedResourceMetadata(t *testing.T) {
	// The delegated authorization server, on its own origin (cf. id.superhuman.com).
	authMux := http.NewServeMux()
	authServer := httptest.NewTLSServer(authMux)
	t.Cleanup(authServer.Close)
	authMux.HandleFunc("/.well-known/oauth-authorization-server", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		require.NoError(t, json.NewEncoder(w).Encode(map[string]any{
			"issuer":                           authServer.URL,
			"authorization_endpoint":           authServer.URL + "/authorize",
			"token_endpoint":                   authServer.URL + "/token",
			"registration_endpoint":            authServer.URL + "/register",
			"response_types_supported":         []string{"code"},
			"code_challenge_methods_supported": []string{"S256"},
		}))
	})

	// The MCP resource origin (cf. docs.superhuman.com): its Protected Resource
	// Metadata delegates to authServer, while its own authorization-server
	// metadata advertises a mismatched issuer that must be ignored.
	resourceMux := http.NewServeMux()
	resourceServer := httptest.NewTLSServer(resourceMux)
	t.Cleanup(resourceServer.Close)
	resourceMux.HandleFunc("/.well-known/oauth-protected-resource/mcp", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		require.NoError(t, json.NewEncoder(w).Encode(map[string]any{
			"resource":              resourceServer.URL + "/mcp",
			"authorization_servers": []string{authServer.URL},
		}))
	})
	resourceMux.HandleFunc("/.well-known/oauth-authorization-server", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		require.NoError(t, json.NewEncoder(w).Encode(map[string]any{
			"issuer":                           "https://tokens.example.com",
			"authorization_endpoint":           "https://tokens.example.com/authorize",
			"token_endpoint":                   "https://tokens.example.com/token",
			"registration_endpoint":            "https://tokens.example.com/register",
			"response_types_supported":         []string{"code"},
			"code_challenge_methods_supported": []string{"S256"},
		}))
	})

	// One client that trusts both self-signed test servers.
	pool := x509.NewCertPool()
	pool.AddCert(authServer.Certificate())
	pool.AddCert(resourceServer.Certificate())
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool}}}

	baseURL := resourceServer.URL
	meta, err := resolveAuthServerMeta(context.Background(), resourceServer.URL+"/mcp", baseURL, client)

	require.NoError(t, err)
	require.NotNil(t, meta)
	assert.Equal(t, authServer.URL, meta.Issuer, "must follow PRM to the delegated authorization server")
	assert.Equal(t, authServer.URL+"/register", meta.RegistrationEndpoint)
}

// TestResolveAuthServerMetaFallsBackToOrigin covers providers that publish no
// Protected Resource Metadata and co-locate the authorization server with the
// MCP endpoint — the path every existing connector relies on.
func TestResolveAuthServerMetaFallsBackToOrigin(t *testing.T) {
	server := newAuthMetaServer(t, true)
	client := server.Client()

	meta, err := resolveAuthServerMeta(context.Background(), server.URL+"/mcp", server.URL, client)

	require.NoError(t, err)
	require.NotNil(t, meta)
	assert.Equal(t, server.URL, meta.Issuer)
}

// TestResolveAuthServerMetaHintNamesFailingIssuer asserts the connectivity
// hint names the host that actually failed — the delegated authorization
// server from the Protected Resource Metadata — not the MCP endpoint the user
// configured, which may be perfectly reachable.
func TestResolveAuthServerMetaHintNamesFailingIssuer(t *testing.T) {
	// A delegated authorization server that is no longer listening.
	dead := httptest.NewTLSServer(http.NotFoundHandler())
	deadURL := dead.URL
	dead.Close()
	parsedDead, err := url.Parse(deadURL)
	require.NoError(t, err)

	resourceMux := http.NewServeMux()
	resourceServer := httptest.NewTLSServer(resourceMux)
	t.Cleanup(resourceServer.Close)
	resourceMux.HandleFunc("/.well-known/oauth-protected-resource/mcp", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		require.NoError(t, json.NewEncoder(w).Encode(map[string]any{
			"resource":              resourceServer.URL + "/mcp",
			"authorization_servers": []string{deadURL},
		}))
	})

	pool := x509.NewCertPool()
	pool.AddCert(resourceServer.Certificate())
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool}}}

	_, err = resolveAuthServerMeta(context.Background(), resourceServer.URL+"/mcp", resourceServer.URL, client)

	require.Error(t, err)
	assert.Contains(t, err.Error(), fmt.Sprintf("could not connect to %s", parsedDead.Host))
}

// TestNetworkErrorHint exercises the classifier with errors produced by real
// network failures, since the exact wrapping (url.Error → net.OpError → …)
// is what production code sees.
func TestNetworkErrorHint(t *testing.T) {
	t.Run("untrusted certificate", func(t *testing.T) {
		server := httptest.NewTLSServer(http.NotFoundHandler())
		t.Cleanup(server.Close)
		// Default transport does not trust httptest's self-signed cert.
		_, err := (&http.Client{}).Get(server.URL)
		require.Error(t, err)
		assert.Contains(t, networkErrorHint(err, "example.com"), "untrusted TLS certificate")
	})

	t.Run("dns failure", func(t *testing.T) {
		_, err := (&http.Client{}).Get("https://poolside-test-does-not-exist.invalid/")
		require.Error(t, err)
		assert.Contains(t, networkErrorHint(err, "camber-test-does-not-exist.invalid"), "could not look up")
	})

	t.Run("timeout", func(t *testing.T) {
		// The handler returns when the timed-out client abandons the request,
		// so server.Close (which waits on in-flight handlers) cannot hang.
		server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
			<-r.Context().Done()
		}))
		t.Cleanup(server.Close)
		_, err := (&http.Client{Timeout: 50 * time.Millisecond}).Get(server.URL)
		require.Error(t, err)
		assert.Contains(t, networkErrorHint(err, "example.com"), "did not respond")
	})

	t.Run("connection refused", func(t *testing.T) {
		server := httptest.NewServer(http.NotFoundHandler())
		addr := server.URL
		server.Close()
		_, err := (&http.Client{}).Get(addr)
		require.Error(t, err)
		assert.Contains(t, networkErrorHint(err, "example.com"), "could not connect")
	})

	t.Run("non-network errors get no hint", func(t *testing.T) {
		assert.Empty(t, networkErrorHint(fmt.Errorf("metadata issuer %q does not match", "x"), "example.com"))
	})
}

// TestRunMCPOAuthFlowReportsNetworkHint asserts the flow surfaces the
// connectivity hint end to end: discovery against a server presenting an
// untrusted certificate (as DNS-filter sinkholes do) must name the problem
// rather than only the raw x509 error.
func TestRunMCPOAuthFlowReportsNetworkHint(t *testing.T) {
	server := httptest.NewTLSServer(http.NotFoundHandler())
	t.Cleanup(server.Close)

	err := RunMCPOAuthFlow(context.Background(), OAuthFlowParams{
		ServerURL: server.URL + "/mcp",
		ServerID:  "test",
	})

	require.Error(t, err)
	assert.Contains(t, err.Error(), "untrusted TLS certificate")
}

func TestRunMCPOAuthFlowWithoutDCR(t *testing.T) {
	server := newAuthMetaServer(t, false)

	var authURLs []string
	err := RunMCPOAuthFlow(context.Background(), OAuthFlowParams{
		ServerURL: server.URL + "/mcp",
		ServerID:  "test",
		OnAuthURL: func(authURL string) { authURLs = append(authURLs, authURL) },
	})

	require.Error(t, err)
	assert.Contains(t, err.Error(), "Dynamic Client Registration")
	assert.Contains(t, err.Error(), "bearer token")
	assert.Empty(t, authURLs, "browser sign-in must not start when the flow cannot complete")
}

func TestRunMCPOAuthFlowWithDCRProceedsToRegistration(t *testing.T) {
	server := newAuthMetaServer(t, true)

	err := RunMCPOAuthFlow(context.Background(), OAuthFlowParams{
		ServerURL: server.URL + "/mcp",
		ServerID:  "test",
	})

	// The fake /register endpoint 404s, so the flow still fails — the point is
	// it got past the DCR-support check and failed at registration instead.
	require.Error(t, err)
	assert.NotContains(t, err.Error(), "does not support Dynamic Client Registration")
	assert.Contains(t, err.Error(), "register OAuth client")
}

func TestRunMCPOAuthFlowWithDeepLinkRedirect(t *testing.T) {
	var server *httptest.Server
	mux := http.NewServeMux()
	server = httptest.NewServer(mux)
	t.Cleanup(server.Close)

	mux.HandleFunc("/.well-known/oauth-authorization-server", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		require.NoError(t, json.NewEncoder(w).Encode(map[string]any{
			"issuer":                                server.URL,
			"authorization_endpoint":                server.URL + "/authorize",
			"token_endpoint":                        server.URL + "/token",
			"response_types_supported":              []string{"code"},
			"code_challenge_methods_supported":      []string{"S256"},
			"token_endpoint_auth_methods_supported": []string{"none"},
		}))
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		require.NoError(t, r.ParseForm())
		assert.Equal(t, DeepLinkOAuthRedirectURI, r.Form.Get("redirect_uri"))
		assert.NotEmpty(t, r.Form.Get("code_verifier"))
		w.Header().Set("Content-Type", "application/json")
		require.NoError(t, json.NewEncoder(w).Encode(map[string]any{
			"access_token": "xoxp-deeplink",
			"token_type":   "Bearer",
			"expires_in":   3600,
		}))
	})

	store := newFakeSecretsStore()
	err := RunMCPOAuthFlow(context.Background(), OAuthFlowParams{
		ServerURL:           server.URL + "/mcp",
		ServerID:            "slack",
		ClientID:            "public-client",
		DeepLinkRedirectURI: DeepLinkOAuthRedirectURI,
		SecretsStore:        store,
		OnAuthURL: func(authURL string) {
			parsed, parseErr := url.Parse(authURL)
			require.NoError(t, parseErr)
			assert.Equal(t, DeepLinkOAuthRedirectURI, parsed.Query().Get("redirect_uri"))
			// Simulate the desktop app forwarding the OS deep link.
			callback := DeepLinkOAuthRedirectURI +
				"?code=authorization-code&state=" + url.QueryEscape(parsed.Query().Get("state"))
			require.NoError(t, DeliverOAuthCallback(callback))
		},
	})

	require.NoError(t, err)
	stored := store.data[ServerKey(server.URL+"/mcp")]
	require.NotNil(t, stored)
	require.NotNil(t, stored.OAuth)
	assert.Equal(t, "xoxp-deeplink", stored.OAuth.AccessToken)
}

func TestRunMCPOAuthFlowWithPreRegisteredPublicClient(t *testing.T) {
	var server *httptest.Server
	mux := http.NewServeMux()
	server = httptest.NewServer(mux)
	t.Cleanup(server.Close)

	mux.HandleFunc("/.well-known/oauth-authorization-server", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		require.NoError(t, json.NewEncoder(w).Encode(map[string]any{
			"issuer":                                server.URL,
			"authorization_endpoint":                server.URL + "/authorize",
			"token_endpoint":                        server.URL + "/token",
			"response_types_supported":              []string{"code"},
			"code_challenge_methods_supported":      []string{"S256"},
			"token_endpoint_auth_methods_supported": []string{"none"},
		}))
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		require.NoError(t, r.ParseForm())
		assert.Equal(t, "public-client", r.Form.Get("client_id"))
		assert.Equal(t, "authorization_code", r.Form.Get("grant_type"))
		assert.NotEmpty(t, r.Form.Get("code_verifier"))
		assert.Empty(t, r.Form.Get("client_secret"))
		assert.Empty(t, r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "application/json")
		require.NoError(t, json.NewEncoder(w).Encode(map[string]any{
			"access_token":  "xoxp-test",
			"token_type":    "Bearer",
			"refresh_token": "xoxe-test",
			"expires_in":    3600,
		}))
	})

	store := newFakeSecretsStore()
	var openedAuthURL *url.URL
	err := RunMCPOAuthFlow(context.Background(), OAuthFlowParams{
		ServerURL:    server.URL + "/mcp",
		ServerID:     "slack",
		Scopes:       []string{"search:read.public", "chat:write"},
		ClientID:     "public-client",
		SecretsStore: store,
		OnAuthURL: func(authURL string) {
			var parseErr error
			openedAuthURL, parseErr = url.Parse(authURL)
			require.NoError(t, parseErr)
			callbackURL := openedAuthURL.Query().Get("redirect_uri")
			callback, parseErr := url.Parse(callbackURL)
			require.NoError(t, parseErr)
			query := callback.Query()
			query.Set("code", "authorization-code")
			query.Set("state", openedAuthURL.Query().Get("state"))
			callback.RawQuery = query.Encode()
			response, getErr := http.Get(callback.String())
			require.NoError(t, getErr)
			require.NoError(t, response.Body.Close())
		},
	})

	require.NoError(t, err)
	require.NotNil(t, openedAuthURL)
	assert.Equal(t, "public-client", openedAuthURL.Query().Get("client_id"))
	assert.Equal(t, "search:read.public chat:write", openedAuthURL.Query().Get("scope"))
	assert.Equal(t, "S256", openedAuthURL.Query().Get("code_challenge_method"))
	assert.NotEmpty(t, openedAuthURL.Query().Get("code_challenge"))
	require.Equal(t, 1, store.saves)
	stored := store.data[ServerKey(server.URL+"/mcp")]
	require.NotNil(t, stored)
	require.NotNil(t, stored.OAuth)
	assert.Equal(t, "xoxp-test", stored.OAuth.AccessToken)
	assert.Equal(t, "public-client", stored.OAuth.Config.ClientID)
	assert.Empty(t, stored.OAuth.Config.ClientSecret)
	assert.Equal(t, oauth2.AuthStyleInParams, stored.OAuth.Config.AuthStyle)
}
