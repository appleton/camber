// Copyright 2025 The Go MCP SDK Authors. All rights reserved.
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file.

package oauthex

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/go-cmp/cmp"
	"github.com/stretchr/testify/require"
)

func TestClientRegistrationMetadataParse(t *testing.T) {
	// Verify that we can parse a typical client metadata JSON.
	data, err := os.ReadFile(filepath.FromSlash("testdata/client-auth-meta.json"))
	if err != nil {
		t.Fatal(err)
	}
	var a ClientRegistrationMetadata
	if err := json.Unmarshal(data, &a); err != nil {
		t.Fatal(err)
	}
	// Spot check
	require.Equal(t, "My Test App", a.ClientName)
	require.Len(t, a.RedirectURIs, 2)
}

func TestRegisterClient(t *testing.T) {
	testCases := []struct {
		name         string
		handler      http.HandlerFunc
		clientMeta   *ClientRegistrationMetadata
		wantClientID string
		wantErr      string
	}{
		{
			name: "Success",
			handler: func(w http.ResponseWriter, r *http.Request) {
				require.Equal(t, "POST", r.Method)
				body, err := io.ReadAll(r.Body)
				if err != nil {
					t.Fatal(err)
				}
				var receivedMeta ClientRegistrationMetadata
				if err := json.Unmarshal(body, &receivedMeta); err != nil {
					t.Fatalf("Failed to unmarshal request body: %v", err)
				}
				require.Equal(t, "Test App", receivedMeta.ClientName)
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusCreated)
				w.Write([]byte(`{"client_id":"test-client-id","client_secret":"test-client-secret","client_name":"Test App"}`))
			},
			clientMeta:   &ClientRegistrationMetadata{ClientName: "Test App", RedirectURIs: []string{"http://localhost/cb"}},
			wantClientID: "test-client-id",
		},
		{
			name: "Success With 200 OK",
			handler: func(w http.ResponseWriter, r *http.Request) {
				// Grammarly/Superhuman (the Coda MCP connector's auth server)
				// returns 200 OK rather than the RFC 7591 201 Created.
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusOK)
				w.Write([]byte(`{"client_id":"test-client-id","client_secret":"test-client-secret","token_endpoint_auth_method":"client_secret_post"}`))
			},
			clientMeta:   &ClientRegistrationMetadata{ClientName: "Test App", RedirectURIs: []string{"http://localhost/cb"}},
			wantClientID: "test-client-id",
		},
		{
			name: "Missing ClientID in Response",
			handler: func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusCreated)
				w.Write([]byte(`{"client_secret":"test-client-secret"}`)) // No client_id
			},
			clientMeta: &ClientRegistrationMetadata{RedirectURIs: []string{"http://localhost/cb"}},
			wantErr:    "registration response is missing required 'client_id' field",
		},
		{
			name: "Standard OAuth Error",
			handler: func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusBadRequest)
				w.Write([]byte(`{"error":"invalid_redirect_uri","error_description":"Redirect URI is not valid."}`))
			},
			clientMeta: &ClientRegistrationMetadata{RedirectURIs: []string{"http://invalid/cb"}},
			wantErr:    "registration failed: invalid_redirect_uri (Redirect URI is not valid.)",
		},
		{
			name: "Non-JSON Server Error",
			handler: func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusInternalServerError)
				w.Write([]byte("Internal Server Error"))
			},
			clientMeta: &ClientRegistrationMetadata{RedirectURIs: []string{"http://localhost/cb"}},
			wantErr:    "registration failed with status 500 Internal Server Error",
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(tc.handler)
			defer server.Close()

			info, err := RegisterClient(context.Background(), server.URL, tc.clientMeta, server.Client())

			if tc.wantErr != "" {
				require.Error(t, err, "Expected an error containing '%s'", tc.wantErr)
				require.ErrorContains(t, err, tc.wantErr)
				return
			}

			require.NoError(t, err)
			require.Equal(t, tc.wantClientID, info.ClientID)
		})
	}

	t.Run("No Endpoint", func(t *testing.T) {
		_, err := RegisterClient(context.Background(), "", &ClientRegistrationMetadata{}, nil)
		if err == nil {
			t.Fatal("Expected an error for missing registration endpoint, got nil")
		}
		expectedErr := "registration_endpoint is required"
		require.EqualError(t, err, expectedErr)
	})
}

func TestClientRegistrationResponseJSON(t *testing.T) {
	testCases := []struct {
		name     string
		in       ClientRegistrationResponse
		wantJSON string
	}{
		{
			name: "full response",
			in: ClientRegistrationResponse{
				ClientID:              "test-client-id",
				ClientSecret:          "test-client-secret",
				ClientIDIssuedAt:      time.Unix(1758840047, 0),
				ClientSecretExpiresAt: time.Unix(1790376047, 0),
			},
			wantJSON: `{"client_id":"test-client-id","client_secret":"test-client-secret","client_id_issued_at":1758840047,"client_secret_expires_at":1790376047, "redirect_uris": null}`,
		},
		{
			name: "minimal response with only required fields",
			in: ClientRegistrationResponse{
				ClientID: "test-client-id-minimal",
			},
			wantJSON: `{"client_id":"test-client-id-minimal", "redirect_uris":null}`,
		},
		{
			name: "response with a secret that does not expire",
			in: ClientRegistrationResponse{
				ClientID:     "test-client-id-no-expiry",
				ClientSecret: "test-secret-no-expiry",
			},
			wantJSON: `{"client_id":"test-client-id-no-expiry","client_secret":"test-secret-no-expiry", "redirect_uris":null}`,
		},
		{
			name:     "unmarshal with zero timestamp",
			in:       ClientRegistrationResponse{ClientID: "client-id-zero"},
			wantJSON: `{"client_id":"client-id-zero", "redirect_uris":null}`,
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			// Test MarshalJSON
			t.Run("marshal", func(t *testing.T) {
				b, err := json.Marshal(&tc.in)
				require.NoError(t, err)

				var gotMap, wantMap map[string]any
				require.NoError(t, json.Unmarshal(b, &gotMap))
				require.NoError(t, json.Unmarshal([]byte(tc.wantJSON), &wantMap))

				require.Empty(t, cmp.Diff(wantMap, gotMap), "Marshal() mismatch")
			})

			// Test UnmarshalJSON
			t.Run("unmarshal", func(t *testing.T) {
				var got ClientRegistrationResponse
				require.NoError(t, json.Unmarshal([]byte(tc.wantJSON), &got))

				require.Empty(t, cmp.Diff(tc.in, got), "Unmarshal() mismatch")
			})
		})
	}
}
