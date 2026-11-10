package mcp

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"golang.org/x/oauth2"
)

// ErrNotAuthenticated is returned by ResolveAccessToken when no stored OAuth
// token exists for the server, or the stored token is expired and cannot be
// refreshed. Callers should prompt the user to (re-)authenticate.
var ErrNotAuthenticated = errors.New("mcp: server requires OAuth authentication")

// HasStoredOAuthToken reports whether any OAuth token is stored for the server,
// without validating or refreshing it. List-style callers use it as a cheap
// signed-in check; an expired token still counts because it is refreshed on
// first use.
func HasStoredOAuthToken(ctx context.Context, store SecretsServerStore, serverURL, serverID string) bool {
	key, err := NewServerKey(serverURL, serverID)
	if err != nil {
		return false
	}
	secrets, err := store.Load(ctx, key)
	if err != nil {
		return false
	}
	return secrets != nil && secrets.OAuth != nil
}

// ResolveAccessToken loads the stored OAuth token for the given server key,
// refreshing (and persisting) it if expired, and returns the access token.
//
// The load→refresh→save sequence is serialized per key so concurrent resolves
// of the same server (e.g. two sessions starting at once) can't both refresh
// and clobber each other's rotated refresh token.
func ResolveAccessToken(ctx context.Context, store SecretsServerStore, serverURL, serverID string) (string, error) {
	key, err := NewServerKey(serverURL, serverID)
	if err != nil {
		return "", fmt.Errorf("mcp: bad server key: %w", err)
	}

	unlock := tokenRefreshLocks.lock(string(key))
	defer unlock()

	secrets, err := store.Load(ctx, key)
	if err != nil {
		return "", fmt.Errorf("%w: load OAuth secrets: %w", ErrNotAuthenticated, err)
	}
	if secrets == nil || secrets.OAuth == nil {
		return "", ErrNotAuthenticated
	}

	oauthData := secrets.OAuth
	t := &oauth2.Token{
		AccessToken:  oauthData.AccessToken,
		TokenType:    oauthData.TokenType,
		RefreshToken: oauthData.RefreshToken,
		Expiry:       oauthData.Expiry,
	}
	if t.Valid() {
		return t.AccessToken, nil
	}

	// Token expired — attempt refresh.
	if t.RefreshToken == "" {
		return "", fmt.Errorf("%w: token expired and no refresh token available", ErrNotAuthenticated)
	}
	cfg := &oauth2.Config{
		ClientID:     oauthData.Config.ClientID,
		ClientSecret: oauthData.Config.ClientSecret,
		Endpoint: oauth2.Endpoint{
			AuthURL:   oauthData.Config.AuthURL,
			TokenURL:  oauthData.Config.TokenURL,
			AuthStyle: oauthData.Config.AuthStyle,
		},
	}
	// The stored token URL originally came from server-controlled metadata, so
	// refresh goes through the same guarded client as the initial exchange.
	refreshCtx := context.WithValue(ctx, oauth2.HTTPClient, newOAuthHTTPClient(discoveryHTTPTimeout))
	refreshed, refreshErr := cfg.TokenSource(refreshCtx, t).Token()
	if refreshErr != nil {
		return "", fmt.Errorf("%w: token refresh failed: %w", ErrNotAuthenticated, refreshErr)
	}

	// Persist the refreshed token with a detached context so a fired caller
	// deadline can't drop the write and lose the rotated refresh token. Persist
	// failure is logged, not fatal: the in-memory token is still usable.
	secrets.OAuth = NewOAuthData(refreshed, cfg)
	saveCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	if saveErr := store.Save(saveCtx, key, secrets); saveErr != nil {
		slog.Warn("mcp: persist refreshed OAuth token", "server_id", serverID, "error", saveErr)
	}
	return refreshed.AccessToken, nil
}

// tokenRefreshLocks serializes the per-server keychain read-modify-write in
// ResolveAccessToken.
var tokenRefreshLocks = &keyedMutex{m: map[string]*sync.Mutex{}}

// keyedMutex hands out one mutex per string key.
type keyedMutex struct {
	mu sync.Mutex
	m  map[string]*sync.Mutex
}

func (k *keyedMutex) lock(key string) func() {
	k.mu.Lock()
	lk := k.m[key]
	if lk == nil {
		lk = &sync.Mutex{}
		k.m[key] = lk
	}
	k.mu.Unlock()
	lk.Lock()
	return lk.Unlock
}
