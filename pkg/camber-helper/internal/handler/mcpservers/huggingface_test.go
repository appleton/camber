package mcpservers

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/appleton/camber/pkg/camber-helper/internal/mcp"
	"github.com/appleton/camber/pkg/camber-helper/methods"
)

func TestIsHuggingFaceURL(t *testing.T) {
	assert.True(t, isHuggingFaceURL("https://huggingface.co/mcp"))
	assert.True(t, isHuggingFaceURL("https://HUGGINGFACE.CO/mcp"))
	assert.True(t, isHuggingFaceURL("https://sub.huggingface.co/mcp"))
	assert.False(t, isHuggingFaceURL("https://nothuggingface.co/mcp"))
	assert.False(t, isHuggingFaceURL("https://example.com/mcp"))
	assert.False(t, isHuggingFaceURL("://bad"))
}

func TestFindHuggingFaceConnector(t *testing.T) {
	store := newStoreAtPath(filepath.Join(t.TempDir(), connectorsFileName))
	require.NoError(t, store.Upsert(methods.MCPServerEntry{
		Name: "linear", Enabled: true, URL: "https://mcp.linear.app/mcp",
		AuthMode: methods.MCPServerAuthModeOAuth,
	}))
	require.NoError(t, store.Upsert(methods.MCPServerEntry{
		Name: "hf-disabled", Enabled: false, URL: "https://huggingface.co/mcp",
		AuthMode: methods.MCPServerAuthModeOAuth,
	}))
	require.NoError(t, store.Upsert(methods.MCPServerEntry{
		Name: "my-hf", Enabled: true, URL: "https://huggingface.co/mcp",
		AuthMode:    methods.MCPServerAuthModeOAuth,
		OAuthScopes: "openid profile read-mcp read-repos",
	}))
	s := newServerWithStore(store)

	entry := s.findHuggingFaceConnector()
	require.NotNil(t, entry)
	// Name-independent: found by URL host, not by the connector's name.
	assert.Equal(t, "my-hf", entry.Name)
}

func TestFindHuggingFaceConnectorRequiresReadReposScope(t *testing.T) {
	store := newStoreAtPath(filepath.Join(t.TempDir(), connectorsFileName))
	require.NoError(t, store.Upsert(methods.MCPServerEntry{
		Name: "old-hf", Enabled: true, URL: "https://huggingface.co/mcp",
		AuthMode:    methods.MCPServerAuthModeOAuth,
		OAuthScopes: "openid profile read-mcp",
	}))
	s := newServerWithStore(store)
	assert.Nil(t, s.findHuggingFaceConnector())
}

func TestFindHuggingFaceConnectorNone(t *testing.T) {
	store := newStoreAtPath(filepath.Join(t.TempDir(), connectorsFileName))
	require.NoError(t, store.Upsert(methods.MCPServerEntry{
		Name: "hf-bearer", Enabled: true, URL: "https://huggingface.co/mcp",
		AuthMode: methods.MCPServerAuthMode("bearer"),
	}))
	s := newServerWithStore(store)
	assert.Nil(t, s.findHuggingFaceConnector())
}

func TestInvalidateHuggingFaceTokenDeletesCredentialAndNotifies(t *testing.T) {
	store := newStoreAtPath(filepath.Join(t.TempDir(), connectorsFileName))
	const serverURL = "https://huggingface.co/mcp"
	require.NoError(t, store.Upsert(methods.MCPServerEntry{
		Name: "huggingface", Enabled: true, URL: serverURL,
		AuthMode:    methods.MCPServerAuthModeOAuth,
		OAuthScopes: "openid profile read-mcp read-repos",
	}))
	key, err := mcp.NewServerKey(serverURL, "huggingface")
	require.NoError(t, err)
	secrets := &fakeSecrets{data: map[mcp.ServerKey]*mcp.ServerSecrets{
		key: {OAuth: &mcp.OAuthData{AccessToken: "rejected-token"}},
	}}
	s := &Server{store: store, secrets: secrets}
	notified := 0
	s.SetChangeNotifier(func() { notified++ })

	assert.Equal(t, "rejected-token", s.HuggingFaceTokenSource()(context.Background()))
	require.NoError(t, s.InvalidateHuggingFaceToken(context.Background()))

	assert.NotContains(t, secrets.data, key)
	assert.Equal(t, 1, notified)
	out, err := s.List(context.Background(), &methods.MCPServersListParams{}, nil)
	require.NoError(t, err)
	require.Len(t, out.Servers, 1)
	require.NotNil(t, out.Servers[0].OAuthAuthenticated)
	assert.False(t, *out.Servers[0].OAuthAuthenticated)
}
