package remoteaccess

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/sourcegraph/jsonrpc2"
	wsjsonrpc2 "github.com/sourcegraph/jsonrpc2/websocket"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

type dispatchRecord struct {
	originID string
	method   string
	params   json.RawMessage
}

// testHarness runs the remote server routes on an httptest server with a
// recording dispatcher, and provides an authenticated client.
type testHarness struct {
	t        *testing.T
	server   *Server
	http     *httptest.Server
	client   *http.Client
	mu       sync.Mutex
	dispatch []dispatchRecord
}

func newHarness(t *testing.T) *testHarness {
	t.Helper()
	h := &testHarness{t: t}
	srv, err := NewServer(Options{
		StatePath: filepath.Join(t.TempDir(), "state.json"),
		Hub:       NewHub(),
		Dispatch: func(originID string, req *glsp.Context) (any, bool, bool, error) {
			h.mu.Lock()
			h.dispatch = append(h.dispatch, dispatchRecord{originID: originID, method: req.Method, params: req.Params})
			h.mu.Unlock()
			return map[string]any{"echo": req.Method}, true, true, nil
		},
	})
	require.NoError(t, err)
	h.server = srv
	h.http = httptest.NewServer(srv.routes("", ""))
	t.Cleanup(h.http.Close)

	jar, err := cookiejar.New(nil)
	require.NoError(t, err)
	h.client = &http.Client{Jar: jar}
	return h
}

func (h *testHarness) get(path string) *http.Response {
	h.t.Helper()
	resp, err := h.client.Get(h.http.URL + path)
	require.NoError(h.t, err)
	return resp
}

func (h *testHarness) postJSON(path string, body any) *http.Response {
	h.t.Helper()
	data, err := json.Marshal(body)
	require.NoError(h.t, err)
	resp, err := h.client.Post(h.http.URL+path, "application/json", bytes.NewReader(data))
	require.NoError(h.t, err)
	return resp
}

// pairAndLogin runs the full pairing + session flow, leaving the session
// cookie in the client jar.
func (h *testHarness) pairAndLogin() {
	h.t.Helper()
	code, _ := h.server.auth.createPairingCode()

	resp := h.postJSON("/api/pair", map[string]string{"code": code, "deviceName": "test phone"})
	require.Equal(h.t, http.StatusOK, resp.StatusCode)
	var pairResult struct {
		AttemptToken     string `json:"attemptToken"`
		ConfirmationCode string `json:"confirmationCode"`
		PairingID        string `json:"pairingId"`
	}
	require.NoError(h.t, json.NewDecoder(resp.Body).Decode(&pairResult))
	resp.Body.Close()
	require.NotEmpty(h.t, pairResult.AttemptToken)
	require.NotEmpty(h.t, pairResult.ConfirmationCode)
	require.NoError(h.t, h.server.ConfirmPairing(pairResult.PairingID, pairResult.ConfirmationCode))

	resp = h.postJSON("/api/pair/complete", map[string]string{"attemptToken": pairResult.AttemptToken})
	require.Equal(h.t, http.StatusOK, resp.StatusCode)
	var completeResult struct {
		DeviceToken string `json:"deviceToken"`
	}
	require.NoError(h.t, json.NewDecoder(resp.Body).Decode(&completeResult))
	resp.Body.Close()

	resp = h.postJSON("/api/session", map[string]string{"deviceToken": completeResult.DeviceToken})
	require.Equal(h.t, http.StatusOK, resp.StatusCode)
	resp.Body.Close()
}

func (h *testHarness) dialWS() (*jsonrpc2.Conn, *websocket.Conn) {
	h.t.Helper()
	wsURL := "ws" + strings.TrimPrefix(h.http.URL, "http") + "/api/ws"
	header := http.Header{}
	u, err := neturl(h.http.URL)
	require.NoError(h.t, err)
	for _, c := range h.client.Jar.Cookies(u) {
		header.Add("Cookie", c.String())
	}
	socket, resp, err := websocket.DefaultDialer.Dial(wsURL, header)
	require.NoError(h.t, err)
	if resp != nil && resp.Body != nil {
		resp.Body.Close()
	}
	conn := jsonrpc2.NewConn(context.Background(), wsjsonrpc2.NewObjectStream(socket), noopHandler{})
	h.t.Cleanup(func() { conn.Close() })
	return conn, socket
}

type noopHandler struct{}

func (noopHandler) Handle(context.Context, *jsonrpc2.Conn, *jsonrpc2.Request) {}

func TestRootServesHTMLWithoutAuth(t *testing.T) {
	h := newHarness(t)
	// The UI shell must load unauthenticated so the pairing screen can render;
	// the WebSocket and API endpoints remain gated.
	resp, err := h.client.Get(h.http.URL + "/")
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Contains(t, resp.Header.Get("Content-Type"), "text/html")
}

func TestMeReportsHostName(t *testing.T) {
	homeDirectory := t.TempDir()
	t.Setenv("HOME", homeDirectory)
	t.Setenv("USERPROFILE", homeDirectory)

	h := newHarness(t)
	h.pairAndLogin()

	resp := h.get("/api/me")
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var body struct {
		Authenticated bool   `json:"authenticated"`
		HostName      string `json:"hostName"`
		HomeDirectory string `json:"homeDirectory"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
	assert.True(t, body.Authenticated)
	assert.Equal(t, displayHostName(), body.HostName)
	assert.Equal(t, homeDirectory, body.HomeDirectory)
	// The ".local" mDNS suffix is trimmed. HasSuffix (not Contains) so a host
	// legitimately named e.g. "foo.localdomain" doesn't false-fail.
	assert.False(t, strings.HasSuffix(body.HostName, ".local"))
}

func TestWebManifestServedWithManifestMIME(t *testing.T) {
	// Go's mime table has no .webmanifest entry; without the explicit header
	// the file server sniffs text/plain, which browsers ignore for PWA installs.
	staticDir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(staticDir, "index.html"), []byte("<!doctype html>"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(staticDir, "manifest.webmanifest"), []byte(`{"name":"x"}`), 0o644))

	srv, err := NewServer(Options{StatePath: filepath.Join(t.TempDir(), "state.json"), Hub: NewHub()})
	require.NoError(t, err)
	ts := httptest.NewServer(srv.routes(staticDir, ""))
	t.Cleanup(ts.Close)

	resp, err := http.Get(ts.URL + "/manifest.webmanifest")
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, "application/manifest+json", resp.Header.Get("Content-Type"))
}

func TestSPAFallbackServesIndexForUnknownPath(t *testing.T) {
	h := newHarness(t)
	// Client-side routes (no matching file) fall back to index, not 404.
	resp, err := h.client.Get(h.http.URL + "/some/deep/route")
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusOK, resp.StatusCode)
}

func TestWSTicketAuthConnects(t *testing.T) {
	h := newHarness(t)
	h.pairAndLogin()

	// Fetch a ticket over HTTP (cookie is sent here), then dial the WS with it
	// — no cookie on the WS request, mirroring iOS Safari.
	resp := h.get("/api/ws-ticket")
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var body struct {
		Ticket string `json:"ticket"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
	resp.Body.Close()
	require.NotEmpty(t, body.Ticket)

	wsURL := "ws" + strings.TrimPrefix(h.http.URL, "http") + "/api/ws?ticket=" + body.Ticket
	socket, wsResp, err := websocket.DefaultDialer.Dial(wsURL, nil) // no cookie header
	require.NoError(t, err)
	if wsResp != nil && wsResp.Body != nil {
		wsResp.Body.Close()
	}
	conn := jsonrpc2.NewConn(context.Background(), wsjsonrpc2.NewObjectStream(socket), noopHandler{})
	defer conn.Close()

	var result map[string]any
	require.NoError(t, conn.Call(context.Background(), methods.ACPNavListMethod, map[string]any{}, &result))
	assert.Equal(t, methods.ACPNavListMethod, result["echo"])
}

func TestWSTicketIsSingleUse(t *testing.T) {
	h := newHarness(t)
	h.pairAndLogin()
	resp := h.get("/api/ws-ticket")
	var body struct {
		Ticket string `json:"ticket"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
	resp.Body.Close()

	wsURL := "ws" + strings.TrimPrefix(h.http.URL, "http") + "/api/ws?ticket=" + body.Ticket
	s1, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	require.NoError(t, err)
	s1.Close()

	// The same ticket cannot open a second socket.
	_, r2, err := websocket.DefaultDialer.Dial(wsURL, nil)
	require.Error(t, err)
	if r2 != nil {
		assert.Equal(t, http.StatusUnauthorized, r2.StatusCode)
		r2.Body.Close()
	}
}

func TestWSTicketRequiresAuth(t *testing.T) {
	h := newHarness(t) // not logged in
	resp := h.get("/api/ws-ticket")
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
	resp.Body.Close()
}

func TestUnauthenticatedRequestsRejected(t *testing.T) {
	h := newHarness(t)

	resp, err := h.client.Get(h.http.URL + "/api/me")
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
	resp.Body.Close()

	resp, err = h.client.Get(h.http.URL + "/api/ws")
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
	resp.Body.Close()
}

func TestPairingRejectsBadCode(t *testing.T) {
	h := newHarness(t)
	resp := h.postJSON("/api/pair", map[string]string{"code": "NOTVALID"})
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
	resp.Body.Close()
}

func TestPairingRequiresDesktopConfirmation(t *testing.T) {
	h := newHarness(t)
	code, _ := h.server.auth.createPairingCode()

	resp := h.postJSON("/api/pair", map[string]string{"code": code, "deviceName": "test phone"})
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var pairResult struct {
		AttemptToken     string `json:"attemptToken"`
		ConfirmationCode string `json:"confirmationCode"`
		PairingID        string `json:"pairingId"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&pairResult))
	resp.Body.Close()

	status := h.server.Status()
	require.Len(t, status.PendingPairings, 1)
	assert.Equal(t, "test phone", status.PendingPairings[0].DeviceName)

	resp = h.postJSON("/api/pair/complete", map[string]string{"attemptToken": pairResult.AttemptToken})
	assert.Equal(t, http.StatusAccepted, resp.StatusCode)
	resp.Body.Close()

	require.Error(t, h.server.ConfirmPairing(pairResult.PairingID, "000000"))
	spacedCode := pairResult.ConfirmationCode[:3] + " " + pairResult.ConfirmationCode[3:]
	require.NoError(t, h.server.ConfirmPairing(pairResult.PairingID, spacedCode))

	resp = h.postJSON("/api/pair/complete", map[string]string{"attemptToken": pairResult.AttemptToken})
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var completeResult struct {
		DeviceToken string `json:"deviceToken"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&completeResult))
	resp.Body.Close()
	assert.NotEmpty(t, completeResult.DeviceToken)
}

func TestCrossOriginRejected(t *testing.T) {
	h := newHarness(t)
	code, _ := h.server.auth.createPairingCode()
	body, _ := json.Marshal(map[string]string{"code": code})
	req, err := http.NewRequest(http.MethodPost, h.http.URL+"/api/pair", bytes.NewReader(body))
	require.NoError(t, err)
	req.Header.Set("Origin", "https://evil.example.com")
	resp, err := h.client.Do(req)
	require.NoError(t, err)
	assert.Equal(t, http.StatusForbidden, resp.StatusCode)
	resp.Body.Close()
}

func TestAllowedMethodDispatches(t *testing.T) {
	h := newHarness(t)
	h.pairAndLogin()
	conn, _ := h.dialWS()

	// Default-open: methods with no deny entry dispatch, including ones the
	// mobile UI does not use today — a new desktop method must never break
	// the phone because nobody remembered to list it.
	for _, method := range []string{
		methods.ACPNavListMethod,
		"camber/taskApplyEdits",
		"camber/someFutureMethod",
	} {
		var result map[string]any
		err := conn.Call(context.Background(), method, map[string]any{}, &result)
		require.NoError(t, err)
		assert.Equal(t, method, result["echo"])
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	require.Len(t, h.dispatch, 3)
	assert.True(t, strings.HasPrefix(h.dispatch[0].originID, "remote:"))
}

func TestDeniedMethodNeverReachesDispatch(t *testing.T) {
	h := newHarness(t)
	h.pairAndLogin()
	conn, _ := h.dialWS()

	// The deny list is deliberately small (protocol lifecycle + remote-access
	// administration); everything else — including desktop-shaped methods like
	// secrets or task edits — dispatches, because method-level blocking is not
	// a boundary against a device that already has agent + terminal access.
	denied := []string{
		"initialize",
		"initialized",
		"shutdown",
		"exit",
		methods.RemoteAccessEnableMethod,
		methods.RemoteAccessDisableMethod,
		methods.RemoteAccessCreatePairingCodeMethod,
		methods.RemoteAccessConfirmPairingMethod,
		methods.RemoteAccessRevokeDeviceMethod,
		methods.RemoteAccessSetAutoStartMethod,
		methods.RemoteAccessStatusMethod,
	}
	for _, method := range denied {
		var result any
		err := conn.Call(context.Background(), method, map[string]any{}, &result)
		require.Error(t, err, "method %s must be denied", method)
		var rpcErr *jsonrpc2.Error
		require.ErrorAs(t, err, &rpcErr, "method %s", method)
		assert.Equal(t, int64(jsonrpc2.CodeMethodNotFound), rpcErr.Code, "method %s", method)
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	assert.Empty(t, h.dispatch, "denied methods must never reach dispatch")
}

func TestNotificationFanOutReachesWSClient(t *testing.T) {
	h := newHarness(t)
	h.pairAndLogin()

	received := make(chan *jsonrpc2.Request, 1)
	wsURL := "ws" + strings.TrimPrefix(h.http.URL, "http") + "/api/ws"
	header := http.Header{}
	u, err := neturl(h.http.URL)
	require.NoError(t, err)
	for _, c := range h.client.Jar.Cookies(u) {
		header.Add("Cookie", c.String())
	}
	socket, resp, err := websocket.DefaultDialer.Dial(wsURL, header)
	require.NoError(t, err)
	if resp != nil && resp.Body != nil {
		resp.Body.Close()
	}
	conn := jsonrpc2.NewConn(context.Background(), wsjsonrpc2.NewObjectStream(socket),
		jsonrpc2.HandlerWithError(func(ctx context.Context, c *jsonrpc2.Conn, req *jsonrpc2.Request) (any, error) {
			received <- req
			return nil, nil
		}))
	defer conn.Close()

	// Wait for the connection to register with the hub.
	require.Eventually(t, func() bool { return h.server.opts.Hub.RemoteCount() == 1 },
		2*time.Second, 10*time.Millisecond)

	// Simulate helper->client traffic from the primary connection.
	wrapped := h.server.opts.Hub.WrapNotify(PrimaryOrigin, func(context.Context, string, any) error { return nil })
	require.NoError(t, wrapped(context.Background(), methods.JSONRPCNotifyMethod, map[string]any{
		"agentServer": "poolside",
		"message":     map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{}},
	}))

	select {
	case req := <-received:
		assert.Equal(t, methods.JSONRPCNotifyMethod, req.Method)
	case <-time.After(2 * time.Second):
		t.Fatal("fan-out notification never reached the websocket client")
	}
}

func TestEnableDisableLifecycle(t *testing.T) {
	t.Setenv("CAMBER_REMOTE_ACCESS_STATE", filepath.Join(t.TempDir(), "state.json"))
	srv, err := NewServer(Options{
		StatePath: filepath.Join(t.TempDir(), "state.json"),
		Hub:       NewHub(),
		Dispatch: func(string, *glsp.Context) (any, bool, bool, error) {
			return nil, true, true, nil
		},
	})
	require.NoError(t, err)

	port := freePort(t)
	status, err := srv.Enable(methods.RemoteAccessEnableParams{Bind: BindLoopback, Port: port})
	require.NoError(t, err)
	assert.True(t, status.Enabled)
	require.Len(t, status.URLs, 1)
	assert.Equal(t, fmt.Sprintf("http://127.0.0.1:%d", port), status.URLs[0])

	// Pairing codes only mint while enabled.
	_, err = srv.CreatePairingCode()
	require.NoError(t, err)

	resp, err := http.Get(status.URLs[0] + "/api/me")
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
	resp.Body.Close()

	require.NoError(t, srv.Disable())
	assert.False(t, srv.Status().Enabled)
	_, err = srv.CreatePairingCode()
	require.Error(t, err)

	_, err = http.Get(status.URLs[0] + "/api/me")
	require.Error(t, err, "server must stop listening after disable")
}

func TestStatusListsPairedDevices(t *testing.T) {
	h := newHarness(t)
	h.pairAndLogin()
	status := h.server.Status()
	require.Len(t, status.Devices, 1)
	assert.Equal(t, "test phone", status.Devices[0].Name)
}

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	port := l.Addr().(*net.TCPAddr).Port
	require.NoError(t, l.Close())
	return port
}

func neturl(raw string) (*url.URL, error) { return url.Parse(raw) }

func TestSetAutoStart(t *testing.T) {
	srv, err := NewServer(Options{
		StatePath: filepath.Join(t.TempDir(), "state.json"),
		Hub:       NewHub(),
		Dispatch: func(string, *glsp.Context) (any, bool, bool, error) {
			return nil, true, true, nil
		},
	})
	require.NoError(t, err)

	status := srv.Status()
	assert.False(t, status.AutoStart)
	assert.Empty(t, status.AutoStartBind)

	// Auto-start needs a valid bind mode to start with later.
	require.Error(t, srv.SetAutoStart(true, ""))
	require.Error(t, srv.SetAutoStart(true, "wat"))

	require.NoError(t, srv.SetAutoStart(true, BindLoopback))
	status = srv.Status()
	assert.True(t, status.AutoStart)
	assert.Equal(t, BindLoopback, status.AutoStartBind)

	// A manual enable on a different interface re-points auto-start at it.
	port := freePort(t)
	_, err = srv.Enable(methods.RemoteAccessEnableParams{Bind: BindAll, Port: port})
	require.NoError(t, err)
	t.Cleanup(func() { _ = srv.Disable() })
	status = srv.Status()
	assert.True(t, status.AutoStart)
	assert.Equal(t, BindAll, status.AutoStartBind)

	require.NoError(t, srv.SetAutoStart(false, ""))
	status = srv.Status()
	assert.False(t, status.AutoStart)
	assert.Empty(t, status.AutoStartBind)
}
