package remoteaccess

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/tliron/glsp"
)

// A remote session grants assistant and terminal capabilities, so over TLS the
// cookie carrying it must be marked Secure. Over the loopback bind, which is
// deliberately plain HTTP, it must not be -- browsers drop Secure cookies set
// on a cleartext origin, which would break sign-in entirely.
func TestSessionCookieSecureFlagFollowsTransport(t *testing.T) {
	tests := []struct {
		name       string
		tls        bool
		wantSecure bool
	}{
		{name: "https bind marks the cookie Secure", tls: true, wantSecure: true},
		{name: "loopback http bind does not", tls: false, wantSecure: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cookie := issueSessionCookie(t, tt.tls)

			assert.Equal(t, tt.wantSecure, cookie.Secure)
			// The other flags are load-bearing too; assert them so a future
			// change to this cookie has to be deliberate.
			assert.True(t, cookie.HttpOnly)
			assert.Equal(t, http.SameSiteStrictMode, cookie.SameSite)
			assert.Equal(t, "/", cookie.Path)
		})
	}
}

func issueSessionCookie(t *testing.T, useTLS bool) *http.Cookie {
	t.Helper()

	srv, err := NewServer(Options{
		StatePath: filepath.Join(t.TempDir(), "state.json"),
		Hub:       NewHub(),
		Dispatch: func(string, *glsp.Context) (any, bool, bool, error) {
			return nil, true, true, nil
		},
	})
	require.NoError(t, err)

	handler := srv.routes("", "")
	var ts *httptest.Server
	if useTLS {
		ts = httptest.NewTLSServer(handler)
	} else {
		ts = httptest.NewServer(handler)
	}
	t.Cleanup(ts.Close)

	jar, err := cookiejar.New(nil)
	require.NoError(t, err)
	client := ts.Client()
	client.Jar = jar
	if transport, ok := client.Transport.(*http.Transport); ok && transport.TLSClientConfig != nil {
		transport.TLSClientConfig.InsecureSkipVerify = true //nolint:gosec // test server cert
		transport.TLSClientConfig.MinVersion = tls.VersionTLS12
	}

	post := func(path string, body any) *http.Response {
		data, err := json.Marshal(body)
		require.NoError(t, err)
		resp, err := client.Post(ts.URL+path, "application/json", bytes.NewReader(data))
		require.NoError(t, err)
		return resp
	}

	code, _ := srv.auth.createPairingCode()
	resp := post("/api/pair", map[string]string{"code": code, "deviceName": "test phone"})
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var pairResult struct {
		AttemptToken     string `json:"attemptToken"`
		ConfirmationCode string `json:"confirmationCode"`
		PairingID        string `json:"pairingId"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&pairResult))
	resp.Body.Close()
	require.NoError(t, srv.ConfirmPairing(pairResult.PairingID, pairResult.ConfirmationCode))

	resp = post("/api/pair/complete", map[string]string{"attemptToken": pairResult.AttemptToken})
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var completeResult struct {
		DeviceToken string `json:"deviceToken"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&completeResult))
	resp.Body.Close()

	resp = post("/api/session", map[string]string{"deviceToken": completeResult.DeviceToken})
	require.Equal(t, http.StatusOK, resp.StatusCode)
	defer resp.Body.Close()

	for _, cookie := range resp.Cookies() {
		if cookie.Name == SessionCookieName {
			return cookie
		}
	}
	t.Fatalf("no %s cookie was set", SessionCookieName)
	return nil
}
