package mcp

import (
	"errors"
	"fmt"
	"net/url"
	"sync"
)

// DeepLinkOAuthRedirectURI is the OS deep-link OAuth redirect target. Clients
// that register the camber:// URL scheme (the desktop app) receive the
// browser redirect from the OS and forward the full callback URL to the helper
// via camber/mcpOAuthCallback.
const DeepLinkOAuthRedirectURI = "camber://oauth/callback"

// DeliverOAuthCallback completes a pending deep-link OAuth flow with a
// redirect callback URL forwarded by the client. It returns an error when the
// URL is malformed or no flow is waiting for its state (e.g. the flow already
// timed out).
func DeliverOAuthCallback(rawURL string) error {
	return deepLinkBroker.deliver(rawURL)
}

// oauthCallbackBroker routes OAuth redirect callbacks that arrive over
// JSON-RPC (OS deep links) to the pending flow that generated the state
// parameter, mirroring the state check the loopback callback server performs.
type oauthCallbackBroker struct {
	mu      sync.Mutex
	pending map[string]chan callbackResult
}

type callbackResult struct {
	code string
	err  error
}

var deepLinkBroker = &oauthCallbackBroker{pending: map[string]chan callbackResult{}}

// register adds a pending flow keyed by its OAuth state. The returned cancel
// must be called when the flow finishes so an abandoned flow does not leak.
func (b *oauthCallbackBroker) register(state string) (<-chan callbackResult, func()) {
	ch := make(chan callbackResult, 1)
	b.mu.Lock()
	b.pending[state] = ch
	b.mu.Unlock()
	return ch, func() {
		b.mu.Lock()
		delete(b.pending, state)
		b.mu.Unlock()
	}
}

func (b *oauthCallbackBroker) deliver(rawURL string) error {
	u, err := url.Parse(rawURL)
	if err != nil {
		return fmt.Errorf("invalid OAuth callback URL: %w", err)
	}
	// Defense in depth: only the registered redirect target may carry a
	// callback, so scheme-confused or mis-forwarded URLs are rejected at the
	// trust boundary instead of relying on the state match alone. The error
	// deliberately omits the query, which holds the authorization code.
	if target := u.Scheme + "://" + u.Host + u.Path; target != DeepLinkOAuthRedirectURI {
		return fmt.Errorf("unexpected OAuth callback URL %q", target)
	}
	query := u.Query()
	state := query.Get("state")
	if state == "" {
		return errors.New("OAuth callback is missing the state parameter")
	}

	b.mu.Lock()
	ch, ok := b.pending[state]
	delete(b.pending, state)
	b.mu.Unlock()
	if !ok {
		return errors.New("no pending OAuth flow matches the callback state")
	}

	// The channel is buffered and the entry is removed above, so exactly one
	// send can happen and it never blocks.
	if errParam := query.Get("error"); errParam != "" {
		if desc := query.Get("error_description"); desc != "" {
			ch <- callbackResult{err: fmt.Errorf("authorization failed: %s: %s", errParam, desc)}
		} else {
			ch <- callbackResult{err: fmt.Errorf("authorization failed: %s", errParam)}
		}
		return nil
	}
	code := query.Get("code")
	if code == "" {
		ch <- callbackResult{err: errors.New("no authorization code received")}
		return nil
	}
	ch <- callbackResult{code: code}
	return nil
}
