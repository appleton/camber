package mcp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/oauth2"
)

// fakeSecretsStore is an in-memory SecretsServerStore for tests.
type fakeSecretsStore struct {
	data    map[ServerKey]*ServerSecrets
	loadErr error
	saveErr error
	saves   int
}

func newFakeSecretsStore() *fakeSecretsStore {
	return &fakeSecretsStore{data: map[ServerKey]*ServerSecrets{}}
}

func (f *fakeSecretsStore) Load(_ context.Context, key ServerKey) (*ServerSecrets, error) {
	if f.loadErr != nil {
		return nil, f.loadErr
	}
	return f.data[key], nil
}

func (f *fakeSecretsStore) Save(_ context.Context, key ServerKey, data *ServerSecrets) error {
	if f.saveErr != nil {
		return f.saveErr
	}
	f.saves++
	f.data[key] = data
	return nil
}

func (f *fakeSecretsStore) Delete(_ context.Context, key ServerKey) error {
	delete(f.data, key)
	return nil
}

func TestResolveAccessToken_ValidToken(t *testing.T) {
	store := newFakeSecretsStore()
	store.data["https://huggingface.co/mcp"] = &ServerSecrets{
		OAuth: &OAuthData{
			AccessToken: "tok-valid",
			TokenType:   "Bearer",
			Expiry:      time.Now().Add(time.Hour),
		},
	}

	token, err := ResolveAccessToken(context.Background(), store, "https://huggingface.co/mcp", "huggingface")
	require.NoError(t, err)
	assert.Equal(t, "tok-valid", token)
	assert.Zero(t, store.saves, "valid token should not be re-persisted")
}

func TestResolveAccessToken_NoSecretsIsNotAuthenticated(t *testing.T) {
	store := newFakeSecretsStore()

	_, err := ResolveAccessToken(context.Background(), store, "https://huggingface.co/mcp", "huggingface")
	assert.ErrorIs(t, err, ErrNotAuthenticated)
}

func TestResolveAccessToken_ExpiredWithoutRefreshTokenIsNotAuthenticated(t *testing.T) {
	store := newFakeSecretsStore()
	store.data["https://huggingface.co/mcp"] = &ServerSecrets{
		OAuth: &OAuthData{
			AccessToken: "tok-stale",
			Expiry:      time.Now().Add(-time.Hour),
		},
	}

	_, err := ResolveAccessToken(context.Background(), store, "https://huggingface.co/mcp", "huggingface")
	assert.ErrorIs(t, err, ErrNotAuthenticated)
}

func TestResolveAccessToken_RefreshesAndPersistsExpiredToken(t *testing.T) {
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, http.MethodPost, r.Method)
		w.Header().Set("Content-Type", "application/json")
		require.NoError(t, json.NewEncoder(w).Encode(map[string]any{
			"access_token":  "tok-refreshed",
			"token_type":    "Bearer",
			"refresh_token": "refresh-rotated",
			"expires_in":    3600,
		}))
	}))
	defer tokenServer.Close()

	store := newFakeSecretsStore()
	key := ServerKey("https://huggingface.co/mcp")
	store.data[key] = &ServerSecrets{
		OAuth: &OAuthData{
			AccessToken:  "tok-stale",
			RefreshToken: "refresh-old",
			Expiry:       time.Now().Add(-time.Hour),
			Config: OAuthConfig{
				ClientID: "client",
				TokenURL: tokenServer.URL + "/token",
			},
		},
	}

	token, err := ResolveAccessToken(context.Background(), store, "https://huggingface.co/mcp", "huggingface")
	require.NoError(t, err)
	assert.Equal(t, "tok-refreshed", token)
	require.Equal(t, 1, store.saves)
	require.NotNil(t, store.data[key].OAuth)
	assert.Equal(t, "tok-refreshed", store.data[key].OAuth.AccessToken)
	assert.Equal(t, "refresh-rotated", store.data[key].OAuth.RefreshToken)
}

func TestResolveAccessToken_RefreshesPublicClientWithoutSecret(t *testing.T) {
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.NoError(t, r.ParseForm())
		assert.Equal(t, "public-client", r.Form.Get("client_id"))
		assert.Empty(t, r.Form.Get("client_secret"))
		assert.Empty(t, r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "application/json")
		require.NoError(t, json.NewEncoder(w).Encode(map[string]any{
			"access_token":  "tok-refreshed",
			"token_type":    "Bearer",
			"refresh_token": "refresh-rotated",
			"expires_in":    3600,
		}))
	}))
	defer tokenServer.Close()

	store := newFakeSecretsStore()
	key := ServerKey("https://mcp.slack.com/mcp")
	store.data[key] = &ServerSecrets{
		OAuth: &OAuthData{
			AccessToken:  "tok-stale",
			RefreshToken: "refresh-old",
			Expiry:       time.Now().Add(-time.Hour),
			Config: OAuthConfig{
				ClientID:  "public-client",
				TokenURL:  tokenServer.URL + "/token",
				AuthStyle: oauth2.AuthStyleInParams,
			},
		},
	}

	token, err := ResolveAccessToken(context.Background(), store, string(key), "slack")
	require.NoError(t, err)
	assert.Equal(t, "tok-refreshed", token)
	require.NotNil(t, store.data[key].OAuth)
	assert.Equal(t, oauth2.AuthStyleInParams, store.data[key].OAuth.Config.AuthStyle)
}

func TestResolveAccessToken_PersistFailureStillReturnsToken(t *testing.T) {
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		require.NoError(t, json.NewEncoder(w).Encode(map[string]any{
			"access_token": "tok-refreshed",
			"token_type":   "Bearer",
			"expires_in":   3600,
		}))
	}))
	defer tokenServer.Close()

	store := newFakeSecretsStore()
	store.saveErr = context.DeadlineExceeded
	store.data["https://huggingface.co/mcp"] = &ServerSecrets{
		OAuth: &OAuthData{
			AccessToken:  "tok-stale",
			RefreshToken: "refresh-old",
			Expiry:       time.Now().Add(-time.Hour),
			Config: OAuthConfig{
				ClientID: "client",
				TokenURL: tokenServer.URL + "/token",
			},
		},
	}

	token, err := ResolveAccessToken(context.Background(), store, "https://huggingface.co/mcp", "huggingface")
	require.NoError(t, err)
	assert.Equal(t, "tok-refreshed", token)
}

func TestResolveAccessToken_RefreshFailureIsNotAuthenticated(t *testing.T) {
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "invalid_grant", http.StatusBadRequest)
	}))
	defer tokenServer.Close()

	store := newFakeSecretsStore()
	store.data["https://huggingface.co/mcp"] = &ServerSecrets{
		OAuth: &OAuthData{
			AccessToken:  "tok-stale",
			RefreshToken: "refresh-bad",
			Expiry:       time.Now().Add(-time.Hour),
			Config: OAuthConfig{
				ClientID: "client",
				TokenURL: tokenServer.URL + "/token",
			},
		},
	}

	_, err := ResolveAccessToken(context.Background(), store, "https://huggingface.co/mcp", "huggingface")
	assert.ErrorIs(t, err, ErrNotAuthenticated)
}

func TestHasStoredOAuthToken(t *testing.T) {
	store := newFakeSecretsStore()
	store.data["https://mcp.linear.app/mcp"] = &ServerSecrets{
		OAuth: &OAuthData{AccessToken: "tok", Expiry: time.Now().Add(-time.Hour)},
	}
	store.data["https://no-oauth.example.com/mcp"] = &ServerSecrets{
		Metadata: map[string]string{"k": "v"},
	}

	assert.True(t, HasStoredOAuthToken(context.Background(), store, "https://mcp.linear.app/mcp", "linear"),
		"stored token counts even when expired — it refreshes on use")
	assert.False(t, HasStoredOAuthToken(context.Background(), store, "https://no-oauth.example.com/mcp", "x"),
		"secrets without OAuth data are not a sign-in")
	assert.False(t, HasStoredOAuthToken(context.Background(), store, "https://unknown.example.com/mcp", "y"))
	assert.False(t, HasStoredOAuthToken(context.Background(), store, "", ""), "bad key resolves to unauthenticated")

	store.loadErr = assert.AnError
	assert.False(t, HasStoredOAuthToken(context.Background(), store, "https://mcp.linear.app/mcp", "linear"),
		"load errors degrade to unauthenticated")
}
