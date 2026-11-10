package mcp

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestDeliverOAuthCallbackWithoutPendingFlow(t *testing.T) {
	err := DeliverOAuthCallback(DeepLinkOAuthRedirectURI + "?code=abc&state=unknown")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "no pending OAuth flow")
}

func TestDeliverOAuthCallbackMissingState(t *testing.T) {
	err := DeliverOAuthCallback(DeepLinkOAuthRedirectURI + "?code=abc")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "state")
}

func TestDeliverOAuthCallbackCode(t *testing.T) {
	ch, cancel := deepLinkBroker.register("state-1")
	defer cancel()

	require.NoError(t, DeliverOAuthCallback(DeepLinkOAuthRedirectURI+"?code=the-code&state=state-1"))

	result := <-ch
	require.NoError(t, result.err)
	assert.Equal(t, "the-code", result.code)

	// A state is single-use: a replay of the same callback must not match.
	err := DeliverOAuthCallback(DeepLinkOAuthRedirectURI + "?code=the-code&state=state-1")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "no pending OAuth flow")
}

func TestDeliverOAuthCallbackProviderError(t *testing.T) {
	ch, cancel := deepLinkBroker.register("state-2")
	defer cancel()

	require.NoError(t, DeliverOAuthCallback(
		DeepLinkOAuthRedirectURI+"?error=access_denied&error_description=user+cancelled&state=state-2"))

	result := <-ch
	require.Error(t, result.err)
	assert.Contains(t, result.err.Error(), "access_denied")
	assert.Contains(t, result.err.Error(), "user cancelled")
	assert.Empty(t, result.code)
}

func TestDeliverOAuthCallbackWithoutCode(t *testing.T) {
	ch, cancel := deepLinkBroker.register("state-3")
	defer cancel()

	require.NoError(t, DeliverOAuthCallback(DeepLinkOAuthRedirectURI+"?state=state-3"))

	result := <-ch
	require.Error(t, result.err)
	assert.Contains(t, result.err.Error(), "no authorization code")
}

func TestDeliverOAuthCallbackRejectsWrongTarget(t *testing.T) {
	ch, cancel := deepLinkBroker.register("state-4")
	defer cancel()

	// A URL that is not the registered redirect target must be rejected before
	// the state lookup, leaving the pending flow intact for the real callback.
	for _, bad := range []string{
		"camber://oauth/callbackfoo?code=abc&state=state-4",
		"camber://evil/callback?code=abc&state=state-4",
		"https://oauth/callback?code=abc&state=state-4",
	} {
		err := DeliverOAuthCallback(bad)
		require.Error(t, err, bad)
		assert.Contains(t, err.Error(), "unexpected OAuth callback URL", bad)
		assert.NotContains(t, err.Error(), "code=abc", bad)
	}

	require.NoError(t, DeliverOAuthCallback(DeepLinkOAuthRedirectURI+"?code=still-works&state=state-4"))
	result := <-ch
	require.NoError(t, result.err)
	assert.Equal(t, "still-works", result.code)
}
