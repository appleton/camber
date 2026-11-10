package mcpservers

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/appleton/camber/pkg/camber-helper/internal/mcp"
	"github.com/appleton/camber/pkg/camber-helper/methods"
)

// fakeSecrets is an in-memory mcp.SecretsServerStore keyed like the keychain.
type fakeSecrets struct {
	data map[mcp.ServerKey]*mcp.ServerSecrets
}

func (f *fakeSecrets) Load(_ context.Context, key mcp.ServerKey) (*mcp.ServerSecrets, error) {
	return f.data[key], nil
}

func (f *fakeSecrets) Save(_ context.Context, key mcp.ServerKey, data *mcp.ServerSecrets) error {
	f.data[key] = data
	return nil
}

func (f *fakeSecrets) Delete(_ context.Context, key mcp.ServerKey) error {
	delete(f.data, key)
	return nil
}

func TestServerList_AnnotatesOAuthTokenPresence(t *testing.T) {
	store := newTestStore(t)
	require.NoError(t, store.Upsert(methods.MCPServerEntry{
		Name: "signed-in", Enabled: true,
		URL: "https://signed-in.example.com/mcp", AuthMode: methods.MCPServerAuthModeOAuth,
	}))
	require.NoError(t, store.Upsert(methods.MCPServerEntry{
		Name: "signed-out", Enabled: true,
		URL: "https://signed-out.example.com/mcp", AuthMode: methods.MCPServerAuthModeOAuth,
	}))
	require.NoError(t, store.Upsert(methods.MCPServerEntry{
		Name: "bearer", Enabled: true,
		URL: "https://bearer.example.com/mcp", AuthMode: methods.MCPServerAuthMode("bearer"),
	}))
	require.NoError(t, store.Upsert(methods.MCPServerEntry{
		Name: "local", Enabled: true, Command: "npx",
	}))

	secrets := &fakeSecrets{data: map[mcp.ServerKey]*mcp.ServerSecrets{
		"https://signed-in.example.com/mcp": {OAuth: &mcp.OAuthData{AccessToken: "tok"}},
	}}
	server := &Server{store: store, secrets: secrets}

	out, err := server.List(context.Background(), &methods.MCPServersListParams{}, nil)
	require.NoError(t, err)

	byName := map[string]methods.MCPServerEntry{}
	for _, entry := range out.Servers {
		byName[entry.Name] = entry
	}
	require.Len(t, byName, 4)

	require.NotNil(t, byName["signed-in"].OAuthAuthenticated)
	assert.True(t, *byName["signed-in"].OAuthAuthenticated)
	require.NotNil(t, byName["signed-out"].OAuthAuthenticated)
	assert.False(t, *byName["signed-out"].OAuthAuthenticated)
	assert.Nil(t, byName["bearer"].OAuthAuthenticated, "non-OAuth servers stay unannotated")
	assert.Nil(t, byName["local"].OAuthAuthenticated, "stdio servers stay unannotated")
}

func TestValidateEntry_PreRegisteredOAuthClient(t *testing.T) {
	valid := methods.MCPServerEntry{
		Name:              "slack",
		URL:               "https://mcp.slack.com/mcp",
		AuthMode:          methods.MCPServerAuthModeOAuth,
		OAuthClientID:     "public-client",
		OAuthCallbackPort: 3119,
	}
	require.NoError(t, validateEntry(valid))

	missingPort := valid
	missingPort.OAuthCallbackPort = 0
	assert.ErrorContains(t, validateEntry(missingPort), "callback port")

	bearer := valid
	bearer.AuthMode = methods.MCPServerAuthMode("bearer")
	assert.ErrorContains(t, validateEntry(bearer), "requires OAuth authentication")

	// A deep-link redirect substitutes for the loopback port, alone or combined.
	deepLinkOnly := valid
	deepLinkOnly.OAuthCallbackPort = 0
	deepLinkOnly.OAuthDeepLink = true
	assert.NoError(t, validateEntry(deepLinkOnly))

	deepLinkAndPort := valid
	deepLinkAndPort.OAuthDeepLink = true
	assert.NoError(t, validateEntry(deepLinkAndPort))

	deepLinkBearer := methods.MCPServerEntry{
		Name:          "slack",
		URL:           "https://mcp.slack.com/mcp",
		AuthMode:      methods.MCPServerAuthMode("bearer"),
		OAuthDeepLink: true,
	}
	assert.ErrorContains(t, validateEntry(deepLinkBearer), "requires OAuth authentication")
}

func TestAuthenticate_DeepLinkOnlyClientNeedsCapableHost(t *testing.T) {
	store := newTestStore(t)
	require.NoError(t, store.Upsert(methods.MCPServerEntry{
		Name: "slack", Enabled: true,
		URL:           "https://mcp.slack.com/mcp",
		AuthMode:      methods.MCPServerAuthModeOAuth,
		OAuthClientID: "public-client",
		OAuthDeepLink: true,
	}))
	server := newServerWithStore(store)

	// No deep-link capability registered (an IDE host) and no loopback port to
	// fall back to: the flow must fail up front with actionable guidance rather
	// than opening a browser round-trip that cannot complete.
	_, err := server.Authenticate(context.Background(), &methods.MCPServersAuthenticateParams{Name: "slack"}, nil)
	require.Error(t, err)
	assert.ErrorContains(t, err, "desktop app")

	server.SetDeepLinkOAuthCapable(func() bool { return false })
	_, err = server.Authenticate(context.Background(), &methods.MCPServersAuthenticateParams{Name: "slack"}, nil)
	require.Error(t, err)
	assert.ErrorContains(t, err, "desktop app")
}

func TestMutationsInvokeChangeNotifier(t *testing.T) {
	server := newServerWithStore(newTestStore(t))
	notified := 0
	server.SetChangeNotifier(func() { notified++ })
	ctx := context.Background()

	_, err := server.Upsert(ctx, &methods.MCPServersUpsertParams{
		Server: methods.MCPServerEntry{Name: "local", Command: "npx", Enabled: true},
	}, nil)
	require.NoError(t, err)
	assert.Equal(t, 1, notified, "upsert notifies")

	_, err = server.SetEnabled(ctx, &methods.MCPServersSetEnabledParams{Name: "local", Enabled: false}, nil)
	require.NoError(t, err)
	assert.Equal(t, 2, notified, "setEnabled notifies")

	_, err = server.Delete(ctx, &methods.MCPServersDeleteParams{Name: "local"}, nil)
	require.NoError(t, err)
	assert.Equal(t, 3, notified, "delete notifies")
}

func TestFailedMutationDoesNotNotify(t *testing.T) {
	server := newServerWithStore(newTestStore(t))
	notified := 0
	server.SetChangeNotifier(func() { notified++ })

	_, err := server.Upsert(context.Background(), &methods.MCPServersUpsertParams{
		Server: methods.MCPServerEntry{Name: ""},
	}, nil)
	require.Error(t, err)
	assert.Zero(t, notified)
}

func TestWatcherNotifiesOnExternalStoreWrites(t *testing.T) {
	store := newTestStore(t)
	server := newServerWithStore(store)
	notifications := make(chan struct{}, 16)
	server.SetChangeNotifier(func() { notifications <- struct{}{} })

	stop := server.watchStore(5 * time.Millisecond)
	defer func() { require.NoError(t, stop()) }()

	// Another helper instance sharing the file writes through its own Store.
	external := newStoreAtPath(store.Path())
	require.NoError(t, external.Upsert(methods.MCPServerEntry{Name: "remote", Command: "npx", Enabled: true}))

	select {
	case <-notifications:
	case <-time.After(5 * time.Second):
		t.Fatal("external store write did not notify")
	}
}

func TestWatcherIgnoresInProcessWrites(t *testing.T) {
	server := newServerWithStore(newTestStore(t))
	notified := make(chan struct{}, 16)
	server.SetChangeNotifier(func() { notified <- struct{}{} })

	stop := server.watchStore(5 * time.Millisecond)
	defer func() { require.NoError(t, stop()) }()

	_, err := server.Upsert(context.Background(), &methods.MCPServersUpsertParams{
		Server: methods.MCPServerEntry{Name: "local", Command: "npx", Enabled: true},
	}, nil)
	require.NoError(t, err)
	<-notified // the mutation's own notification

	// Give the poller several intervals: it must not re-fire for our write.
	time.Sleep(50 * time.Millisecond)
	select {
	case <-notified:
		t.Fatal("poller re-fired for an in-process write")
	default:
	}
}
