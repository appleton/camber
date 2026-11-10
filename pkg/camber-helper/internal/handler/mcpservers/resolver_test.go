package mcpservers

import (
	"context"
	"path/filepath"
	"testing"

	acpsdk "github.com/coder/acp-go-sdk"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

func resolverTestServer(t *testing.T, entries ...methods.MCPServerEntry) *Server {
	t.Helper()
	store := newStoreAtPath(filepath.Join(t.TempDir(), connectorsFileName))
	for _, e := range entries {
		require.NoError(t, store.Upsert(e))
	}
	return newServerWithStore(store)
}

func injectedNames(r ResolveResult) []string {
	names := make([]string, 0, len(r.Injected))
	for _, s := range r.Injected {
		names = append(names, s.ServerName)
	}
	return names
}

func unavailableByName(r ResolveResult) map[string]methods.MCPServerStatus {
	out := map[string]methods.MCPServerStatus{}
	for _, s := range r.Unavailable {
		out[s.ServerName] = s
	}
	return out
}

func TestResolve_SkipsDisabled(t *testing.T) {
	s := resolverTestServer(t,
		methods.MCPServerEntry{Name: "on", Enabled: true, Command: "echo"},
		methods.MCPServerEntry{Name: "off", Enabled: false, Command: "echo"},
	)
	res := s.Resolve(context.Background(), ResolveParams{})
	assert.Equal(t, []string{"on"}, injectedNames(res))
	assert.Empty(t, res.Unavailable)
}

func TestResolve_NoEnabledServers(t *testing.T) {
	s := resolverTestServer(t, methods.MCPServerEntry{Name: "off", Enabled: false, Command: "echo"})
	res := s.Resolve(context.Background(), ResolveParams{})
	assert.Empty(t, res.Servers)
	assert.Empty(t, res.Injected)
	assert.Empty(t, res.Unavailable)
}

func TestResolve_StdioAlwaysInjected(t *testing.T) {
	s := resolverTestServer(t, methods.MCPServerEntry{
		Name: "std", Enabled: true, Command: "echo", Args: []string{"hi"},
	})
	// Agent advertises no HTTP capability; stdio is unconditionally allowed.
	res := s.Resolve(context.Background(), ResolveParams{MCPCapabilities: acpsdk.McpCapabilities{Http: false}})
	require.Len(t, res.Servers, 1)
	require.NotNil(t, res.Servers[0].Stdio)
	assert.Equal(t, "std", res.Servers[0].Stdio.Name)
	assert.Equal(t, []string{"std"}, injectedNames(res))
}

func TestResolve_HTTPGatedOnCapabilities(t *testing.T) {
	entry := methods.MCPServerEntry{
		Name: "remote", Enabled: true, URL: "https://mcp.example.com", AuthMode: methods.MCPServerAuthMode("none"),
	}

	// Agent without HTTP support: dropped as unsupported_transport.
	noHTTP := resolverTestServer(t, entry).
		Resolve(context.Background(), ResolveParams{MCPCapabilities: acpsdk.McpCapabilities{Http: false}})
	assert.Empty(t, noHTTP.Servers)
	unavail := unavailableByName(noHTTP)
	require.Contains(t, unavail, "remote")
	assert.Equal(t, "unsupported_transport", unavail["remote"].Reason)

	// Agent with HTTP support: injected.
	withHTTP := resolverTestServer(t, entry).
		Resolve(context.Background(), ResolveParams{MCPCapabilities: acpsdk.McpCapabilities{Http: true}})
	require.Len(t, withHTTP.Servers, 1)
	require.NotNil(t, withHTTP.Servers[0].Http)
	assert.Equal(t, "remote", withHTTP.Servers[0].Http.Name)
}

func TestResolve_PoolAgentTreatedAsHTTPCapable(t *testing.T) {
	entry := methods.MCPServerEntry{
		Name: "remote", Enabled: true, URL: "https://mcp.example.com", AuthMode: methods.MCPServerAuthMode("none"),
	}
	// The pool agent advertises no HTTP capability, but the resolver treats it as
	// transport-capable, so the HTTP connector is still injected.
	res := resolverTestServer(t, entry).Resolve(context.Background(), ResolveParams{
		IsPoolAgent:     true,
		MCPCapabilities: acpsdk.McpCapabilities{Http: false},
	})
	require.Len(t, res.Servers, 1)
	require.NotNil(t, res.Servers[0].Http)
	assert.Empty(t, res.Unavailable)
}
