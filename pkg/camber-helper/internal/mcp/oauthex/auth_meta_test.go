// Copyright 2025 The Go MCP SDK Authors. All rights reserved.
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file.

package oauthex

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestAuthMetaParse(t *testing.T) {
	// Verify that we parse Google's auth server metadata.
	data, err := os.ReadFile(filepath.FromSlash("testdata/google-auth-meta.json"))
	if err != nil {
		t.Fatal(err)
	}
	var a AuthServerMeta
	if err := json.Unmarshal(data, &a); err != nil {
		t.Fatal(err)
	}
	// Spot check.
	require.Equal(t, "https://accounts.google.com", a.Issuer)
}

func TestSameRegistrableDomain(t *testing.T) {
	tests := []struct {
		name string
		url1 string
		url2 string
		want bool
	}{
		{
			name: "exact_match",
			url1: "https://mcp.atlassian.com",
			url2: "https://mcp.atlassian.com",
			want: true,
		},
		{
			name: "subdomain_match",
			url1: "https://mcp.atlassian.com",
			url2: "https://cf.mcp.atlassian.com",
			want: true,
		},
		{
			name: "different_subdomains_same_base",
			url1: "https://api.example.com",
			url2: "https://cdn.example.com",
			want: true,
		},
		{
			name: "different_domains",
			url1: "https://mcp.atlassian.com",
			url2: "https://mcp.attacker.com",
			want: false,
		},
		{
			name: "different_schemes",
			url1: "https://mcp.atlassian.com",
			url2: "http://mcp.atlassian.com",
			want: false,
		},
		{
			name: "localhost_not_supported",
			url1: "https://localhost:8080",
			url2: "https://localhost:9090",
			want: false, // localhost doesn't have a registrable domain
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := sameRegistrableDomain(tt.url1, tt.url2)
			require.Equal(t, tt.want, got)
		})
	}
}

func TestGetAuthServerMetaPKCESupport(t *testing.T) {
	ctx := context.Background()
	tests := []struct {
		name           string
		hasPKCESupport bool
		wantError      string
	}{
		{
			name:           "server_with_pkce_support",
			hasPKCESupport: true,
		},
		{
			name:           "server_without_pkce_support",
			hasPKCESupport: false,
			wantError:      "does not implement PKCE",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Start a fake OAuth 2.1 auth server
			wrapper := http.NewServeMux()
			wrapper.HandleFunc("/.well-known/oauth-authorization-server", func(w http.ResponseWriter, r *http.Request) {
				u, _ := url.Parse("https://" + r.Host)
				issuer := "https://localhost:" + u.Port()
				metadata := AuthServerMeta{
					Issuer:                            issuer,
					AuthorizationEndpoint:             issuer + "/authorize",
					TokenEndpoint:                     issuer + "/token",
					RegistrationEndpoint:              issuer + "/register",
					JWKSURI:                           issuer + "/.well-known/jwks.json",
					ScopesSupported:                   []string{"openid", "profile", "email"},
					ResponseTypesSupported:            []string{"code"},
					GrantTypesSupported:               []string{"authorization_code"},
					TokenEndpointAuthMethodsSupported: []string{"none"},
				}

				// Add PKCE support based on test case
				if tt.hasPKCESupport {
					metadata.CodeChallengeMethodsSupported = []string{"S256"}
				}
				// If hasPKCESupport is false, CodeChallengeMethodsSupported remains empty

				w.Header().Set("Content-Type", "application/json")
				json.NewEncoder(w).Encode(metadata)
			})
			ts := httptest.NewTLSServer(wrapper)
			defer ts.Close()

			// The fake server sets issuer to https://localhost:<port>, so compute that issuer.
			u, _ := url.Parse(ts.URL)
			issuer := "https://localhost:" + u.Port()

			// The fake server presents a cert for example.com; set ServerName accordingly.
			httpClient := ts.Client()
			if tr, ok := httpClient.Transport.(*http.Transport); ok {
				clone := tr.Clone()
				clone.TLSClientConfig.ServerName = "example.com"
				httpClient.Transport = clone
			}

			meta, err := GetAuthServerMeta(ctx, issuer, httpClient)
			if tt.wantError != "" {
				require.Error(t, err, "wanted error but got none")
				require.ErrorContains(t, err, tt.wantError)
			} else {
				require.NoErrorf(t, err, "unwanted error: %v", err)
				require.NotNil(t, meta, "wanted metadata but got nil")
				// Verify PKCE support is present
				require.NotEmpty(t, meta.CodeChallengeMethodsSupported, "wanted PKCE support but CodeChallengeMethodsSupported is empty")
			}
		})
	}
}
