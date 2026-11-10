package acpproxy

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestFetchRegistryAgentServerConfig(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{
			"version": "1.0.0",
			"agents": [
				{
					"id": "poolside",
					"distribution": {
						"binary": {
							"darwin-aarch64": {
								"archive": "https://example.com/pool.tar.gz",
								"sha256": "0123456789abcdef",
								"cmd": "./pool",
								"args": ["acp"]
							}
						}
					}
				}
			]
		}`))
	}))
	t.Cleanup(server.Close)

	cfg, err := fetchRegistryAgentServerConfig(context.Background(), server.URL, "poolside")
	require.NoError(t, err)

	assert.Equal(t, AgentServerConfig{
		Type: "registry",
		Binary: map[string]AgentServerBinaryDistribution{
			"darwin-aarch64": {
				Archive: "https://example.com/pool.tar.gz",
				SHA256:  "0123456789abcdef",
				Cmd:     "./pool",
				Args:    []string{"acp"},
			},
		},
	}, cfg)
}

func TestDefaultCamberAgentServerConfigRefreshesRegistry(t *testing.T) {
	isolateRegistryConfigCache(t)
	var requestCount int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requestCount++
		_, _ = fmt.Fprintf(w, `{
			"version": "1.0.0",
			"agents": [
				{
					"id": "poolside",
					"distribution": {
						"binary": {
							"darwin-aarch64": {
								"archive": "https://example.com/pool-v%d.tar.gz",
								"cmd": "./pool",
								"args": ["acp"]
							}
						}
					}
				}
			]
		}`, requestCount)
	}))
	t.Cleanup(server.Close)
	useRegistryURL(t, server.URL)

	first, err := defaultCamberAgentServerConfig(context.Background())
	require.NoError(t, err)
	second, err := defaultCamberAgentServerConfig(context.Background())
	require.NoError(t, err)

	assert.Equal(t, "https://example.com/pool-v1.tar.gz", first.Binary["darwin-aarch64"].Archive)
	assert.Equal(t, "https://example.com/pool-v2.tar.gz", second.Binary["darwin-aarch64"].Archive)
	assert.Equal(t, 2, requestCount)
}

func TestRegistryAgentServerConfigFallsBackToCachedConfig(t *testing.T) {
	isolateRegistryConfigCache(t)
	var failRequests bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if failRequests {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte(`{
			"version": "1.0.0",
			"agents": [
				{
					"id": "poolside",
					"distribution": {
						"binary": {
							"darwin-aarch64": {
								"archive": "https://example.com/pool.tar.gz",
								"cmd": "./pool",
								"args": ["acp"]
							}
						}
					}
				}
			]
		}`))
	}))
	t.Cleanup(server.Close)
	useRegistryURL(t, server.URL)

	fetched, err := RegistryAgentServerConfig(context.Background(), "poolside")
	require.NoError(t, err)

	failRequests = true
	cached, err := RegistryAgentServerConfig(context.Background(), "poolside")
	require.NoError(t, err)
	assert.Equal(t, fetched, cached)
}

func TestRegistryAgentServerConfigInstallErrorWithoutCache(t *testing.T) {
	isolateRegistryConfigCache(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(server.Close)
	useRegistryURL(t, server.URL)

	_, err := RegistryAgentServerConfig(context.Background(), "poolside")
	var installErr *AgentInstallError
	require.ErrorAs(t, err, &installErr)
	assert.Equal(t, "poolside", installErr.AgentServer)
}

// isolateRegistryConfigCache points os.UserCacheDir at a temp dir so tests
// neither read nor write the real per-user registry config cache.
func isolateRegistryConfigCache(t *testing.T) {
	t.Helper()
	cacheHome := t.TempDir()
	t.Setenv("HOME", cacheHome)
	t.Setenv("XDG_CACHE_HOME", cacheHome)
}

func useRegistryURL(t *testing.T, url string) {
	t.Helper()
	defaultRegistryMu.Lock()
	previousURL := defaultRegistryURL
	defaultRegistryURL = url
	defaultRegistryMu.Unlock()
	t.Cleanup(func() {
		defaultRegistryMu.Lock()
		defaultRegistryURL = previousURL
		defaultRegistryMu.Unlock()
	})
}

func TestAgentServerConfigFromRegistryDistribution(t *testing.T) {
	t.Run("converts npx distributions", func(t *testing.T) {
		cfg, ok := agentServerConfigFromRegistryDistribution(acpRegistryDistribution{
			NPX: &acpRegistryPackageDistribution{
				Package: "example-acp@1.0.0",
				Args:    []string{"--acp"},
				Env:     map[string]string{"EXAMPLE": "1"},
			},
		})

		require.True(t, ok)
		assert.Equal(t, AgentServerConfig{
			Type:    "registry",
			Command: "npx",
			Args:    []string{"-y", "example-acp@1.0.0", "--acp"},
			Env:     map[string]string{"EXAMPLE": "1"},
		}, cfg)
	})

	t.Run("converts binary distributions", func(t *testing.T) {
		cfg, ok := agentServerConfigFromRegistryDistribution(acpRegistryDistribution{
			Binary: map[string]AgentServerBinaryDistribution{
				"linux-x86_64": {
					Archive: "https://example.com/agent.tar.gz",
					SHA256:  "0123456789abcdef",
					Cmd:     "./agent",
				},
			},
		})

		require.True(t, ok)
		assert.Equal(t, AgentServerConfig{
			Type: "registry",
			Binary: map[string]AgentServerBinaryDistribution{
				"linux-x86_64": {
					Archive: "https://example.com/agent.tar.gz",
					SHA256:  "0123456789abcdef",
					Cmd:     "./agent",
				},
			},
		}, cfg)
	})
}
