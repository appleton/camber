package mcp

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestMain relaxes the OAuth transport guard for the package's tests, which
// point discovery, registration and token endpoints at httptest servers -- all
// of them on loopback, most of them plain HTTP. Tests that exercise the guard
// re-enable the half they are testing for their own duration.
func TestMain(m *testing.M) {
	allowCleartextOAuthEndpoints.Store(true)
	allowNonPublicOAuthAddresses.Store(true)
	os.Exit(m.Run())
}

// enforceSchemeGuard re-enables the https requirement, leaving the
// resolved-address check relaxed so loopback fixtures still work.
func enforceSchemeGuard(t *testing.T) {
	t.Helper()
	allowCleartextOAuthEndpoints.Store(false)
	t.Cleanup(func() { allowCleartextOAuthEndpoints.Store(true) })
}

// enforceAddressGuard re-enables the resolved-address check.
func enforceAddressGuard(t *testing.T) {
	t.Helper()
	allowNonPublicOAuthAddresses.Store(false)
	t.Cleanup(func() { allowNonPublicOAuthAddresses.Store(true) })
}

func TestIsPublicAddr(t *testing.T) {
	tests := []struct {
		addr   string
		public bool
	}{
		{addr: "8.8.8.8", public: true},
		{addr: "2606:4700:4700::1111", public: true},
		{addr: "127.0.0.1"},
		{addr: "::1"},
		{addr: "0.0.0.0"},
		{addr: "10.1.2.3"},
		{addr: "172.16.0.1"},
		{addr: "192.168.1.1"},
		{addr: "169.254.169.254"}, // cloud instance metadata
		{addr: "fe80::1"},
		{addr: "fd00::1"},
		{addr: "100.64.0.1"}, // CGNAT / tailnet
		{addr: "224.0.0.1"},
		{addr: "240.0.0.1"},
		{addr: "198.18.0.1"},
		{addr: "::ffff:10.0.0.1"}, // IPv4-mapped private address
		{addr: "::ffff:127.0.0.1"},
	}

	for _, tt := range tests {
		t.Run(tt.addr, func(t *testing.T) {
			ip, err := netip.ParseAddr(tt.addr)
			require.NoError(t, err)
			assert.Equal(t, tt.public, isPublicAddr(ip))
		})
	}
}

func TestCheckOAuthEndpointURL(t *testing.T) {
	enforceSchemeGuard(t)

	require.NoError(t, checkOAuthEndpointURLString("https://auth.example.com/token", "token endpoint"))
	require.NoError(t, checkOAuthEndpointURLString("", "token endpoint"))

	err := checkOAuthEndpointURLString("http://auth.example.com/token", "token endpoint")
	require.Error(t, err)
	assert.ErrorContains(t, err, "must use https")
	assert.ErrorContains(t, err, "token endpoint")
}

func TestCheckResolvedAddressRejectsNonPublic(t *testing.T) {
	enforceAddressGuard(t)

	require.NoError(t, checkResolvedAddress("8.8.8.8:443"))

	err := checkResolvedAddress("169.254.169.254:80")
	require.Error(t, err)
	assert.ErrorContains(t, err, "non-public address")
}

// The dialer's Control hook sees the address after DNS resolution, so a
// hostname that resolves inward is refused even though its name looks ordinary.
func TestOAuthHTTPClientRefusesLoopbackTarget(t *testing.T) {
	enforceAddressGuard(t)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(server.Close)

	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, server.URL, nil)
	require.NoError(t, err)

	_, err = newOAuthHTTPClient(discoveryHTTPTimeout).Do(req)
	require.Error(t, err)
	assert.ErrorContains(t, err, "non-public address")
}

// A metadata document that advertises a cleartext endpoint must be refused
// before the helper sends anything to it.
func TestRunMCPOAuthFlowRejectsCleartextAdvertisedEndpoints(t *testing.T) {
	mux := http.NewServeMux()
	var server *httptest.Server
	mux.HandleFunc("/.well-known/oauth-authorization-server", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"issuer": "` + server.URL + `",
			"authorization_endpoint": "http://evil.example.com/authorize",
			"token_endpoint": "https://auth.example.com/token",
			"registration_endpoint": "https://auth.example.com/register",
			"code_challenge_methods_supported": ["S256"]
		}`))
	})
	server = httptest.NewServer(mux)
	t.Cleanup(server.Close)

	// Only the advertised-endpoint check is under test here; discovery itself
	// still runs against the loopback fixture, so only the scheme half of the
	// guard is enabled.
	enforceSchemeGuard(t)

	err := RunMCPOAuthFlow(context.Background(), OAuthFlowParams{
		ServerURL:    server.URL + "/mcp",
		ServerID:     "test",
		ClientID:     "preregistered",
		SecretsStore: newFakeSecretsStore(),
	})

	require.Error(t, err)
	assert.ErrorContains(t, err, "authorization endpoint")
	assert.ErrorContains(t, err, "must use https")
}
