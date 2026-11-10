package mcpservers

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/appleton/camber/pkg/camber-helper/internal/mcp"
	"github.com/appleton/camber/pkg/camber-helper/methods"
)

func newStoreAtPath(path string) *Store {
	return &Store{path: path}
}

func newServerWithStore(store *Store) *Server {
	return &Server{store: store, secrets: mcp.NewKeyringSecretsServerStore()}
}

func newTestStore(t *testing.T) *Store {
	t.Helper()
	dir := t.TempDir()
	return newStoreAtPath(filepath.Join(dir, "connectors.json"))
}

func TestStore_Empty(t *testing.T) {
	s := newTestStore(t)
	servers, err := s.List()
	require.NoError(t, err)
	assert.Empty(t, servers)
}

func TestStore_UpsertAndList(t *testing.T) {
	s := newTestStore(t)

	entry := methods.MCPServerEntry{
		Name:    "github",
		Enabled: true,
		Command: "npx",
		Args:    []string{"-y", "@modelcontextprotocol/server-github"},
		Env:     map[string]string{"GITHUB_TOKEN": "ghp_test"},
	}
	require.NoError(t, s.Upsert(entry))

	servers, err := s.List()
	require.NoError(t, err)
	require.Len(t, servers, 1)
	assert.Equal(t, "github", servers[0].Name)
	assert.True(t, servers[0].Enabled)
	assert.Equal(t, "npx", servers[0].Command)
	assert.Equal(t, map[string]string{"GITHUB_TOKEN": "ghp_test"}, servers[0].Env)
}

func TestStore_Upsert_Overwrites(t *testing.T) {
	s := newTestStore(t)

	first := methods.MCPServerEntry{Name: "srv", Enabled: true, Command: "old", Args: []string{}}
	require.NoError(t, s.Upsert(first))

	second := methods.MCPServerEntry{Name: "srv", Enabled: false, Command: "new", Args: []string{}}
	require.NoError(t, s.Upsert(second))

	servers, err := s.List()
	require.NoError(t, err)
	require.Len(t, servers, 1)
	assert.Equal(t, "new", servers[0].Command)
	assert.False(t, servers[0].Enabled)
}

func TestStore_Delete(t *testing.T) {
	s := newTestStore(t)
	require.NoError(t, s.Upsert(methods.MCPServerEntry{Name: "srv", Enabled: true, Command: "cmd", Args: []string{}}))
	require.NoError(t, s.Delete("srv"))

	servers, err := s.List()
	require.NoError(t, err)
	assert.Empty(t, servers)
}

func TestStore_Delete_NotFound(t *testing.T) {
	s := newTestStore(t)
	// not-found delete is silent
	require.NoError(t, s.Delete("nonexistent"))
}

func TestStore_SetEnabled(t *testing.T) {
	s := newTestStore(t)
	require.NoError(t, s.Upsert(methods.MCPServerEntry{Name: "srv", Enabled: true, Command: "cmd", Args: []string{}}))
	require.NoError(t, s.SetEnabled("srv", false))

	entry, err := s.Get("srv")
	require.NoError(t, err)
	require.NotNil(t, entry)
	assert.False(t, entry.Enabled)
}

func TestStore_SetEnabled_NotFound(t *testing.T) {
	s := newTestStore(t)
	err := s.SetEnabled("nonexistent", true)
	assert.Error(t, err)
}

func TestStore_InvalidName(t *testing.T) {
	s := newTestStore(t)
	err := s.Upsert(methods.MCPServerEntry{Name: "has space", Command: "cmd"})
	assert.Error(t, err)
}

func TestStore_EmptyName(t *testing.T) {
	s := newTestStore(t)
	err := s.Upsert(methods.MCPServerEntry{Name: "", Command: "cmd"})
	assert.Error(t, err)
}

func TestStore_FilePermissions(t *testing.T) {
	s := newTestStore(t)
	require.NoError(t, s.Upsert(methods.MCPServerEntry{Name: "srv", Enabled: true, Command: "cmd", Args: []string{}}))

	info, err := os.Stat(s.path)
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(fileMode), info.Mode().Perm())
}

func TestStore_HTTPServer(t *testing.T) {
	s := newTestStore(t)
	entry := methods.MCPServerEntry{
		Name:     "my-http",
		Enabled:  true,
		URL:      "https://mcp.example.com",
		AuthMode: methods.MCPServerAuthMode("bearer"),
		Headers:  map[string]string{"X-Custom": "val"},
	}
	require.NoError(t, s.Upsert(entry))

	servers, err := s.List()
	require.NoError(t, err)
	require.Len(t, servers, 1)
	assert.Equal(t, "https://mcp.example.com", servers[0].URL)
}

func TestStore_PreRegisteredOAuthClient(t *testing.T) {
	s := newTestStore(t)
	entry := methods.MCPServerEntry{
		Name:              "slack",
		Enabled:           true,
		URL:               "https://mcp.slack.com/mcp",
		AuthMode:          methods.MCPServerAuthModeOAuth,
		OAuthScopes:       "search:read.public chat:write",
		OAuthClientID:     "public-client",
		OAuthCallbackPort: 3119,
	}
	require.NoError(t, s.Upsert(entry))

	servers, err := s.List()
	require.NoError(t, err)
	require.Len(t, servers, 1)
	assert.Equal(t, "public-client", servers[0].OAuthClientID)
	assert.Equal(t, 3119, servers[0].OAuthCallbackPort)
}

func TestBuildACPServer_Stdio(t *testing.T) {
	entry := methods.MCPServerEntry{
		Name:    "gh",
		Command: "npx",
		Args:    []string{"-y", "server-github"},
		Env:     map[string]string{"TOKEN": "abc"},
	}
	srv, err := BuildACPServer(entry, "")
	require.NoError(t, err)
	require.NotNil(t, srv.Stdio)
	assert.Equal(t, "gh", srv.Stdio.Name)
	assert.Equal(t, "npx", srv.Stdio.Command)
	assert.Len(t, srv.Stdio.Env, 1)
	assert.Equal(t, "TOKEN", srv.Stdio.Env[0].Name)
	assert.Equal(t, "abc", srv.Stdio.Env[0].Value)
}

func TestBuildACPServer_HTTP_StaticBearer(t *testing.T) {
	entry := methods.MCPServerEntry{
		Name:        "api",
		URL:         "https://mcp.example.com",
		BearerToken: "static-token",
	}
	srv, err := BuildACPServer(entry, "")
	require.NoError(t, err)
	require.NotNil(t, srv.Http)
	found := false
	for _, h := range srv.Http.Headers {
		if h.Name == "Authorization" {
			assert.Equal(t, "Bearer static-token", h.Value)
			found = true
		}
	}
	assert.True(t, found, "Authorization header must be set")
}

func TestBuildACPServer_HTTP_OAuthOverridesBearer(t *testing.T) {
	entry := methods.MCPServerEntry{
		Name:        "api",
		URL:         "https://mcp.example.com",
		BearerToken: "static-token",
	}
	// OAuth token takes priority
	srv, err := BuildACPServer(entry, "oauth-token")
	require.NoError(t, err)
	require.NotNil(t, srv.Http)
	for _, h := range srv.Http.Headers {
		if h.Name == "Authorization" {
			assert.Equal(t, "Bearer oauth-token", h.Value)
		}
	}
}

func TestBuildACPServer_HTTP_StripCallerAuthorization(t *testing.T) {
	entry := methods.MCPServerEntry{
		Name:    "api",
		URL:     "https://mcp.example.com",
		Headers: map[string]string{"Authorization": "Bearer bad", "X-Other": "kept"},
	}
	srv, err := BuildACPServer(entry, "good-token")
	require.NoError(t, err)
	require.NotNil(t, srv.Http)
	for _, h := range srv.Http.Headers {
		if h.Name == "Authorization" {
			assert.Equal(t, "Bearer good-token", h.Value)
		}
	}
}

func TestBuildACPServer_HTTP_PreservesCallerAuthorizationWithoutToken(t *testing.T) {
	// With no OAuth/bearer token to apply, a user-supplied Authorization header
	// (e.g. an imported config or a non-Bearer scheme) must be preserved.
	entry := methods.MCPServerEntry{
		Name:    "api",
		URL:     "https://mcp.example.com",
		Headers: map[string]string{"Authorization": "token ghp_xyz", "X-Other": "kept"},
	}
	srv, err := BuildACPServer(entry, "")
	require.NoError(t, err)
	require.NotNil(t, srv.Http)
	var auth string
	for _, h := range srv.Http.Headers {
		if h.Name == "Authorization" {
			auth = h.Value
		}
	}
	assert.Equal(t, "token ghp_xyz", auth, "user Authorization header should survive when no token overrides it")
}

func TestBuildACPServer_NeitherCommandNorURL(t *testing.T) {
	entry := methods.MCPServerEntry{Name: "bad"}
	_, err := BuildACPServer(entry, "")
	assert.Error(t, err)
}

func TestBuildACPServer_SSEEndpointUsesSseTransport(t *testing.T) {
	// A "/sse" URL (e.g. Atlassian/Jira) must use the SSE transport, not streamable HTTP.
	entry := methods.MCPServerEntry{Name: "atlassian", URL: "https://mcp.atlassian.com/v1/sse"}
	srv, err := BuildACPServer(entry, "tok")
	require.NoError(t, err)
	require.NotNil(t, srv.Sse, "an /sse URL must use the SSE transport")
	assert.Nil(t, srv.Http, "an /sse URL must not use the HTTP transport")
	assert.Equal(t, "https://mcp.atlassian.com/v1/sse", srv.Sse.Url)
	assert.Equal(t, "atlassian", srv.Sse.Name)
}

func TestBuildACPServer_StreamableHTTPEndpointUsesHTTPTransport(t *testing.T) {
	entry := methods.MCPServerEntry{Name: "linear", URL: "https://mcp.linear.app/mcp"}
	srv, err := BuildACPServer(entry, "")
	require.NoError(t, err)
	require.NotNil(t, srv.Http)
	assert.Nil(t, srv.Sse)
}

func TestStore_MultipleServers(t *testing.T) {
	s := newTestStore(t)
	for _, name := range []string{"a", "b", "c"} {
		require.NoError(t, s.Upsert(methods.MCPServerEntry{Name: name, Enabled: true, Command: "cmd", Args: []string{}}))
	}
	servers, err := s.List()
	require.NoError(t, err)
	assert.Len(t, servers, 3)
}

func TestSanitizeName(t *testing.T) {
	cases := []struct {
		input string
		ok    bool
	}{
		{"github", true},
		{"my-server", true},
		{"my_server", true},
		{"Server123", true},
		{"has space", false},
		{"has.dot", false},
		{"has/slash", false},
		{"", false},
		{"  ", false},
	}
	for _, tc := range cases {
		_, err := sanitizeName(tc.input)
		if tc.ok {
			assert.NoError(t, err, "input: %q", tc.input)
		} else {
			assert.Error(t, err, "input: %q", tc.input)
		}
	}
}

func TestValidateServerURL(t *testing.T) {
	cases := []struct {
		url string
		ok  bool
	}{
		{"https://mcp.example.com", true},
		{"https://mcp.example.com/path", true},
		{"http://localhost:8080", true},
		{"http://127.0.0.1:8080", true},
		{"http://[::1]:8080", true},
		{"http://example.com", false},
		{"ftp://example.com", false},
		{"not-a-url", false},
	}
	for _, tc := range cases {
		err := validateServerURL(tc.url)
		if tc.ok {
			assert.NoError(t, err, "url: %q", tc.url)
		} else {
			assert.Error(t, err, "url: %q", tc.url)
		}
	}
}

func TestStore_Get(t *testing.T) {
	s := newTestStore(t)
	entry := methods.MCPServerEntry{Name: "srv", Enabled: true, Command: "cmd", Args: []string{}}
	require.NoError(t, s.Upsert(entry))

	got, err := s.Get("srv")
	require.NoError(t, err)
	require.NotNil(t, got)
	assert.Equal(t, "srv", got.Name)
}

func TestStore_Get_NotFound(t *testing.T) {
	s := newTestStore(t)
	got, err := s.Get("nonexistent")
	require.NoError(t, err)
	assert.Nil(t, got)
}

func TestStore_Persistence(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "connectors.json")

	s1 := newStoreAtPath(path)
	require.NoError(t, s1.Upsert(methods.MCPServerEntry{Name: "srv", Enabled: true, Command: "cmd", Args: []string{}}))

	// new store instance at same path reads back the data
	s2 := newStoreAtPath(path)
	servers, err := s2.List()
	require.NoError(t, err)
	require.Len(t, servers, 1)
	assert.Equal(t, "srv", servers[0].Name)
}

func TestStore_FileIsStandardMCPServersShape(t *testing.T) {
	s := newTestStore(t)
	require.NoError(t, s.Upsert(methods.MCPServerEntry{
		Name:    "github",
		Enabled: true,
		Command: "npx",
		Args:    []string{"-y", "@modelcontextprotocol/server-github"},
		Env:     map[string]string{"GITHUB_TOKEN": "ghp_test"},
	}))

	data, err := os.ReadFile(s.path)
	require.NoError(t, err)

	// The file must contain the standard "mcpServers" top-level key.
	assert.Contains(t, string(data), `"mcpServers"`)
	assert.Contains(t, string(data), `"github"`)
	assert.Contains(t, string(data), `"command"`)
}

func TestStore_MigratesStaleSlackLoopbackEntryToDeepLink(t *testing.T) {
	s := newTestStore(t)

	// A catalog Slack install persisted before the deep-link redirect existed:
	// loopback port, no deep-link opt-in. Slack's OAuth app no longer has the
	// loopback redirect registered, so this shape can never complete a flow.
	require.NoError(t, s.Upsert(methods.MCPServerEntry{
		Name:              "slack",
		Enabled:           true,
		URL:               "https://mcp.slack.com/mcp",
		AuthMode:          methods.MCPServerAuthModeOAuth,
		OAuthClientID:     "5293330736241.11587027503268",
		OAuthCallbackPort: 3119,
		BuiltinID:         "slack",
	}))

	got, err := s.Get("slack")
	require.NoError(t, err)
	require.NotNil(t, got)
	assert.True(t, got.OAuthDeepLink)
	assert.Zero(t, got.OAuthCallbackPort)

	listed, err := s.List()
	require.NoError(t, err)
	require.Len(t, listed, 1)
	assert.True(t, listed[0].OAuthDeepLink)
	assert.Zero(t, listed[0].OAuthCallbackPort)
}

func TestStore_KeepsLoopbackForNonSlackBuiltins(t *testing.T) {
	s := newTestStore(t)

	require.NoError(t, s.Upsert(methods.MCPServerEntry{
		Name:              "linear",
		Enabled:           true,
		URL:               "https://mcp.linear.app/mcp",
		AuthMode:          methods.MCPServerAuthModeOAuth,
		OAuthClientID:     "linear-client",
		OAuthCallbackPort: 3200,
		BuiltinID:         "linear",
	}))

	got, err := s.Get("linear")
	require.NoError(t, err)
	require.NotNil(t, got)
	assert.False(t, got.OAuthDeepLink)
	assert.Equal(t, 3200, got.OAuthCallbackPort)
}
