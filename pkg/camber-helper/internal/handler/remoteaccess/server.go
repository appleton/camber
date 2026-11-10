// Package remoteaccess serves the mobile remote-control surface: an
// authenticated HTTP + WebSocket endpoint that speaks the same JSON-RPC
// protocol as the primary stdio client, minus a small method deny list
// (see denylist.go). See hub.go for how helper -> client traffic fans out
// to every connected surface.
package remoteaccess

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"net/http/httputil"
	"net/netip"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/sourcegraph/jsonrpc2"
	wsjsonrpc2 "github.com/sourcegraph/jsonrpc2/websocket"
	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/camber-helper/internal/handler/remoteaccess/webui"
	"github.com/appleton/camber/pkg/camber-helper/methods"
)

// DispatchFunc routes a permitted remote request into the main handler.
// originID identifies the remote connection for fan-out dedup.
type DispatchFunc func(originID string, req *glsp.Context) (any, bool, bool, error)

const (
	DefaultPort = 8737

	BindLoopback  = "loopback"
	BindTailscale = "tailscale"
	BindAll       = "all"

	wsWriteTimeout  = 10 * time.Second
	wsPingInterval  = 30 * time.Second
	wsReadDeadline  = 90 * time.Second
	requestBodyMax  = 1 << 20
	shutdownTimeout = 3 * time.Second
)

// Options configures the remote access server at construction time.
type Options struct {
	// StatePath is the JSON file paired-device state persists to.
	StatePath string
	// Dispatch routes permitted requests into the main handler.
	Dispatch DispatchFunc
	// IsConcurrentMethod mirrors the main server's request serialization.
	IsConcurrentMethod func(method string) bool
	// Hub fans helper->client traffic out to remote connections.
	Hub *Hub
	// OnDisconnect, when set, is called with a connection's origin ID after
	// it closes, so per-connection handler state (e.g. acpnav view-state
	// entries) does not outlive the connection.
	OnDisconnect func(originID string)
}

// Server is the remote access HTTP/WebSocket server. It is constructed once
// with the handler and started/stopped via the camber/remoteAccess/*
// JSON-RPC methods (desktop settings UI owns the lifecycle).
type Server struct {
	opts Options

	mu         sync.Mutex
	auth       *authStore
	httpServer *http.Server
	listener   net.Listener
	bind       string
	port       int
	staticDir  string
	enabled    bool
	tls        bool
	// tsDNSName is this node's MagicDNS name when a trusted Tailscale cert is
	// in use; advertised URLs use it so the cert validates.
	tsDNSName string
	// tlsWarning explains a degraded TLS mode (e.g. the Tailscale trusted-cert
	// path failed and the server fell back to the local CA).
	tlsWarning string
	// caPEM is the local CA certificate served at /ca.crt when the local-CA
	// TLS mode is active, so phones can install and trust it.
	caPEM []byte
	// live WS connection count per device, for status reporting
	connected map[string]int
	closeFns  map[string]func()

	// probe caches the Tailscale environment probe: Status is polled every
	// few seconds by the settings UI and the probe shells out to the CLI.
	probeMu sync.Mutex
	probeAt time.Time
	probe   methods.RemoteAccessTailscaleInfo
}

func NewServer(opts Options) (*Server, error) {
	auth, err := newAuthStore(opts.StatePath)
	if err != nil {
		return nil, err
	}
	if opts.IsConcurrentMethod == nil {
		opts.IsConcurrentMethod = func(string) bool { return false }
	}
	return &Server{
		opts:      opts,
		auth:      auth,
		connected: map[string]int{},
		closeFns:  map[string]func(){},
	}, nil
}

// Enable starts (or restarts) the listener according to params.
func (s *Server) Enable(params methods.RemoteAccessEnableParams) (methods.RemoteAccessStatus, error) {
	if err := s.Disable(); err != nil {
		return methods.RemoteAccessStatus{}, err
	}

	bind := params.Bind
	if bind == "" {
		bind = BindLoopback
	}
	port := params.Port
	if port == 0 {
		port = defaultPort()
	}

	addr, err := bindAddress(bind)
	if err != nil {
		return methods.RemoteAccessStatus{}, err
	}

	listener, err := net.Listen("tcp", fmt.Sprintf("%s:%d", addr, port))
	if err != nil {
		return methods.RemoteAccessStatus{}, fmt.Errorf("remoteaccess: listen: %w", err)
	}

	// Precedence for the served UI: explicit param, then env override (dev),
	// otherwise the bundle embedded in the helper binary. An explicit param
	// must exist; the env override is advisory (the desktop sets it for every
	// dev run, whether or not a bundle has been built there yet).
	staticDir := params.StaticDir
	if staticDir != "" {
		if info, err := os.Stat(staticDir); err != nil || !info.IsDir() {
			listener.Close()
			return methods.RemoteAccessStatus{}, fmt.Errorf("remoteaccess: staticDir %q is not a readable directory", staticDir)
		}
	} else if envDir := os.Getenv("CAMBER_REMOTE_STATIC"); envDir != "" {
		if info, err := os.Stat(envDir); err == nil && info.IsDir() {
			staticDir = envDir
		} else {
			slog.Warn("remoteaccess: CAMBER_REMOTE_STATIC is not a readable directory, serving embedded bundle", "dir", envDir)
		}
	}

	// A dev server (param, or env in dev runs) gets all non-/api traffic
	// proxied to it so UI changes apply without re-embedding or restarting.
	devServerURL := params.DevServerURL
	if devServerURL == "" {
		devServerURL = os.Getenv("CAMBER_REMOTE_DEV_SERVER")
	}
	if devServerURL != "" {
		if u, err := url.Parse(devServerURL); err != nil || u.Scheme == "" || u.Host == "" {
			listener.Close()
			return methods.RemoteAccessStatus{}, fmt.Errorf("remoteaccess: invalid dev server URL %q (want e.g. http://127.0.0.1:5179)", devServerURL)
		}
	}

	httpServer := &http.Server{
		Handler:           s.routes(staticDir, devServerURL),
		ReadHeaderTimeout: 10 * time.Second,
	}

	// Serve HTTPS whenever the surface is reachable off-box: a phone on the
	// tailnet needs a secure context (crypto.randomUUID, WebAuthn, service
	// workers) that browsers only grant over https. Loopback is already a
	// secure origin, so it stays plain HTTP. TLS uses a persisted self-signed
	// cert.
	useTLS := bind != BindLoopback
	tsDNSName := ""
	tlsWarning := ""
	var caPEM []byte
	certDir := filepath.Dir(s.opts.StatePath)
	if useTLS {
		var cert tls.Certificate

		// Prefer a genuinely-trusted Tailscale cert for the MagicDNS name so
		// wss connects with no browser warning. Fall back to the local-CA
		// cert, recording a warning the settings UI surfaces: without
		// installing the CA on the phone, the page loads after a
		// click-through but wss handshakes are silently refused.
		if bind == BindTailscale {
			if tsCert, name, tsErr := tailscaleCert(certDir); tsErr == nil {
				cert = tsCert
				tsDNSName = name
			} else {
				tlsWarning = fmt.Sprintf(
					"Couldn't get a trusted Tailscale certificate (%v). Serving with this desktop's own certificate instead — the phone must install and trust the desktop's CA certificate, or the connection will fail.",
					tsErr)
				slog.Warn("remoteaccess: no Tailscale cert, falling back to local CA", "error", tsErr)
			}
		}

		if tsDNSName == "" {
			certPEM, keyPEM, ca, err := loadOrCreateCert(certDir, tlsHosts(bind))
			if err != nil {
				listener.Close()
				return methods.RemoteAccessStatus{}, fmt.Errorf("remoteaccess: certificate: %w", err)
			}
			cert, err = tls.X509KeyPair(certPEM, keyPEM)
			if err != nil {
				listener.Close()
				return methods.RemoteAccessStatus{}, fmt.Errorf("remoteaccess: load certificate: %w", err)
			}
			caPEM = ca
		}

		httpServer.TLSConfig = &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}
	}

	s.mu.Lock()
	s.listener = listener
	s.httpServer = httpServer
	s.bind = bind
	s.port = port
	s.staticDir = staticDir
	s.enabled = true
	s.tls = useTLS
	s.tsDNSName = tsDNSName
	s.tlsWarning = tlsWarning
	s.caPEM = caPEM
	s.mu.Unlock()

	// Enabling may have just issued/cached a Tailscale cert; re-probe next time.
	s.probeMu.Lock()
	s.probeAt = time.Time{}
	s.probeMu.Unlock()

	go func() {
		var serveErr error
		if useTLS {
			serveErr = httpServer.ServeTLS(listener, "", "")
		} else {
			serveErr = httpServer.Serve(listener)
		}
		if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			slog.Error("remoteaccess: server stopped", "error", serveErr)
		}
	}()

	// A manual bind choice becomes the auto-start bind too, so a future
	// launch starts the server the way the user last ran it.
	if autoStart, _ := s.auth.autoStartConfig(); autoStart {
		if err := s.auth.setAutoStart(true, bind); err != nil {
			slog.Warn("remoteaccess: could not update auto-start bind", "error", err)
		}
	}

	slog.Info("remoteaccess: enabled", "bind", bind, "tls", useTLS, "addr", listener.Addr().String())
	return s.Status(), nil
}

// AutoStartConfig reports the persisted auto-start preference.
func (s *Server) AutoStartConfig() (enabled bool, bind string) {
	return s.auth.autoStartConfig()
}

// SetAutoStart persists whether (and on which interface) the server starts
// automatically on helper launch. It does not start or stop the server.
func (s *Server) SetAutoStart(autoStart bool, bind string) error {
	if !autoStart {
		return s.auth.setAutoStart(false, "")
	}
	switch bind {
	case BindLoopback, BindTailscale, BindAll:
	default:
		return fmt.Errorf("remoteaccess: unknown bind mode %q (want %q, %q or %q)", bind, BindLoopback, BindTailscale, BindAll)
	}
	return s.auth.setAutoStart(true, bind)
}

// Disable stops the listener and disconnects all remote clients.
func (s *Server) Disable() error {
	s.mu.Lock()
	httpServer := s.httpServer
	closeFns := make([]func(), 0, len(s.closeFns))
	for _, fn := range s.closeFns {
		closeFns = append(closeFns, fn)
	}
	s.httpServer = nil
	s.listener = nil
	s.enabled = false
	s.tlsWarning = ""
	s.caPEM = nil
	s.mu.Unlock()

	for _, fn := range closeFns {
		fn()
	}
	if httpServer != nil {
		ctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		if err := httpServer.Shutdown(ctx); err != nil {
			return httpServer.Close()
		}
	}
	return nil
}

func (s *Server) Close() error {
	return s.Disable()
}

// Status reports current server state for the desktop settings UI.
func (s *Server) Status() methods.RemoteAccessStatus {
	s.mu.Lock()
	enabled := s.enabled
	bind := s.bind
	port := s.port
	secure := s.tls
	tsDNSName := s.tsDNSName
	tlsWarning := s.tlsWarning
	hasCA := len(s.caPEM) > 0
	connectedByDevice := make(map[string]int, len(s.connected))
	for k, v := range s.connected {
		connectedByDevice[k] = v
	}
	s.mu.Unlock()

	status := methods.RemoteAccessStatus{
		Enabled: enabled,
		Devices: []methods.RemoteAccessDevice{},
	}
	status.AutoStart, status.AutoStartBind = s.auth.autoStartConfig()
	if enabled {
		status.Bind = bind
		status.Port = port
		status.URLs = serviceURLs(bind, port, secure, tsDNSName)
		status.TLS = tlsInfo(secure, tsDNSName, tlsWarning, hasCA, status.URLs)
	}
	status.Tailscale = s.tailscaleInfo()
	total := 0
	for _, d := range s.auth.listDevices() {
		n := connectedByDevice[d.ID]
		total += n
		dev := methods.RemoteAccessDevice{
			ID:        d.ID,
			Name:      d.Name,
			CreatedAt: d.CreatedAt.Format(time.RFC3339),
			Connected: n > 0,
		}
		if !d.LastSeenAt.IsZero() {
			dev.LastSeenAt = d.LastSeenAt.Format(time.RFC3339)
		}
		status.Devices = append(status.Devices, dev)
	}
	for _, p := range s.auth.listPendingPairings() {
		status.PendingPairings = append(status.PendingPairings, methods.RemoteAccessPendingPairing{
			ID:         p.ID,
			DeviceName: p.DeviceName,
			CreatedAt:  p.CreatedAt.Format(time.RFC3339),
			ExpiresAt:  p.ExpiresAt.Format(time.RFC3339),
		})
	}
	status.ConnectedClients = total
	return status
}

// tlsInfo condenses the transport-security state into what the settings UI
// needs to explain the connecting phone's experience.
func tlsInfo(secure bool, tsDNSName, warning string, hasCA bool, urls []string) *methods.RemoteAccessTLS {
	info := &methods.RemoteAccessTLS{Warning: warning}
	switch {
	case !secure:
		info.Mode = methods.RemoteAccessTLSModePlain
	case tsDNSName != "":
		info.Mode = methods.RemoteAccessTLSModeTrusted
	default:
		info.Mode = methods.RemoteAccessTLSModeLocalCA
		if hasCA && len(urls) > 0 {
			info.CAURL = urls[0] + "/ca.crt"
		}
	}
	return info
}

// tailscaleInfo returns the (cached) Tailscale environment probe. The
// settings UI polls status every few seconds; the probe shells out to the
// tailscale CLI, so cache it briefly.
func (s *Server) tailscaleInfo() *methods.RemoteAccessTailscaleInfo {
	const probeTTL = 15 * time.Second
	s.probeMu.Lock()
	defer s.probeMu.Unlock()
	if time.Since(s.probeAt) > probeTTL {
		s.probe = probeTailscale(filepath.Dir(s.opts.StatePath))
		s.probeAt = time.Now()
	}
	probe := s.probe
	return &probe
}

// CreatePairingCode mints a one-time code for the desktop pairing QR.
func (s *Server) CreatePairingCode() (methods.RemoteAccessPairingCode, error) {
	s.mu.Lock()
	enabled := s.enabled
	bind := s.bind
	port := s.port
	secure := s.tls
	tsDNSName := s.tsDNSName
	s.mu.Unlock()
	if !enabled {
		return methods.RemoteAccessPairingCode{}, fmt.Errorf("remote access is not enabled")
	}
	code, expiresAt := s.auth.createPairingCode()
	return methods.RemoteAccessPairingCode{
		Code:      code,
		ExpiresAt: expiresAt.Format(time.RFC3339),
		URLs:      serviceURLs(bind, port, secure, tsDNSName),
	}, nil
}

// ConfirmPairing accepts a scanned phone after the desktop user types the
// confirmation code displayed on that phone.
func (s *Server) ConfirmPairing(pairingID, code string) error {
	return s.auth.confirmPairing(strings.TrimSpace(pairingID), normalizeConfirmationCode(code))
}

func normalizeConfirmationCode(code string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) {
			return -1
		}
		return r
	}, code)
}

// RevokeDevice removes a paired device and closes its live connections.
func (s *Server) RevokeDevice(deviceID string) error {
	if err := s.auth.revokeDevice(deviceID); err != nil {
		return err
	}
	s.mu.Lock()
	fns := make([]func(), 0)
	for connID, fn := range s.closeFns {
		if strings.HasPrefix(connID, deviceID+"/") {
			fns = append(fns, fn)
		}
	}
	s.mu.Unlock()
	for _, fn := range fns {
		fn()
	}
	return nil
}

func (s *Server) routes(staticDir, devServerURL string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/pair", s.handlePair)
	mux.HandleFunc("POST /api/pair/complete", s.handlePairComplete)
	mux.HandleFunc("POST /api/session", s.handleSession)
	mux.HandleFunc("GET /api/me", s.handleMe)
	mux.HandleFunc("GET /api/ws-ticket", s.handleWSTicket)
	mux.HandleFunc("GET /api/ws", s.handleWS)
	mux.HandleFunc("GET /api/file", s.handleFile)
	mux.HandleFunc("GET /ca.crt", s.handleCACert)
	static := staticHandler(staticDir)
	if devServerURL != "" {
		mux.Handle("/", devServerHandler(devServerURL, static))
	} else {
		mux.Handle("/", static)
	}
	return mux
}

// devServerHandler reverse-proxies UI traffic (including the HMR WebSocket)
// to a Vite dev server, falling back to the static handler when the dev
// server is not running so remote access keeps working either way.
func devServerHandler(devServerURL string, fallback http.Handler) http.Handler {
	target, err := url.Parse(devServerURL)
	if err != nil {
		// Validated at Enable; keep the surface alive regardless.
		return fallback
	}
	proxy := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			// Vite validates the Host header (server.allowedHosts); present
			// as a local client rather than forwarding the tailnet host.
			pr.Out.Host = target.Host
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			slog.Debug("remoteaccess: dev server unreachable, serving static", "error", err)
			fallback.ServeHTTP(w, r)
		},
	}
	return proxy
}

// checkOrigin rejects cross-origin browser requests. Same-origin requests
// (the served mobile UI) and non-browser clients (no Origin header) pass.
func checkOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	return origin == "http://"+r.Host || origin == "https://"+r.Host
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// handleCACert serves the local CA certificate so a phone can install and
// trust it before pairing (LAN bind, or Tailscale bind without a trusted
// cert). It is deliberately unauthenticated — it must be reachable before the
// device is paired, and a CA *certificate* is public material. 404s when the
// server runs with a trusted cert or plain HTTP (nothing to install).
func (s *Server) handleCACert(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	caPEM := s.caPEM
	s.mu.Unlock()
	if len(caPEM) == 0 {
		http.NotFound(w, r)
		return
	}
	// The x509 MIME type makes iOS offer "install profile" instead of showing
	// the PEM as text.
	w.Header().Set("Content-Type", "application/x-x509-ca-cert")
	w.Header().Set("Content-Disposition", `attachment; filename="camber-remote-ca.crt"`)
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(caPEM)
}

func (s *Server) handlePair(w http.ResponseWriter, r *http.Request) {
	if !checkOrigin(r) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "cross-origin request rejected"})
		return
	}
	var body struct {
		Code       string `json:"code"`
		DeviceName string `json:"deviceName"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, requestBodyMax)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	id, attemptToken, confirmationCode, expiresAt, err := s.auth.beginPairing(strings.ToUpper(strings.TrimSpace(body.Code)), strings.TrimSpace(body.DeviceName))
	if err != nil {
		slog.Warn("remoteaccess: pairing attempt failed", "remote", r.RemoteAddr, "error", err)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": err.Error()})
		return
	}
	slog.Info("remoteaccess: pairing confirmation requested", "pairing", id, "deviceName", strings.TrimSpace(body.DeviceName), "remote", r.RemoteAddr)
	writeJSON(w, http.StatusOK, map[string]string{
		"pairingId":        id,
		"attemptToken":     attemptToken,
		"confirmationCode": confirmationCode,
		"expiresAt":        expiresAt.Format(time.RFC3339),
	})
}

func (s *Server) handlePairComplete(w http.ResponseWriter, r *http.Request) {
	if !checkOrigin(r) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "cross-origin request rejected"})
		return
	}
	var body struct {
		AttemptToken string `json:"attemptToken"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, requestBodyMax)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	token, device, ok, err := s.auth.completePairing(strings.TrimSpace(body.AttemptToken))
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": err.Error()})
		return
	}
	if !ok {
		writeJSON(w, http.StatusAccepted, map[string]string{"status": "pending"})
		return
	}
	slog.Info("remoteaccess: device paired", "device", device.ID, "name", device.Name, "remote", r.RemoteAddr)
	writeJSON(w, http.StatusOK, map[string]string{
		"deviceToken": token,
		"deviceId":    device.ID,
		"deviceName":  device.Name,
	})
}

func (s *Server) handleSession(w http.ResponseWriter, r *http.Request) {
	if !checkOrigin(r) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "cross-origin request rejected"})
		return
	}
	var body struct {
		DeviceToken string `json:"deviceToken"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, requestBodyMax)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	sessionToken, deviceID, err := s.auth.createSession(body.DeviceToken)
	if err != nil {
		slog.Warn("remoteaccess: session attempt with unknown device token", "remote", r.RemoteAddr)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unknown device token"})
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookieName,
		Value:    sessionToken,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		// A remote session grants the assistant and terminal capabilities, so
		// the browser must never put this token on the wire in cleartext.
		// Taken from the request rather than the server's TLS mode so it
		// reflects the connection the cookie was actually issued on: the
		// loopback bind is deliberately plain HTTP (a secure origin already),
		// and marking it Secure there would make browsers drop the cookie.
		Secure: r.TLS != nil,
		MaxAge: int(sessionTTL.Seconds()),
	})
	writeJSON(w, http.StatusOK, map[string]string{"deviceId": deviceID})
}

func (s *Server) sessionDevice(r *http.Request) (string, bool) {
	cookie, err := r.Cookie(SessionCookieName)
	if err != nil {
		return "", false
	}
	return s.auth.validateSession(cookie.Value)
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	deviceID, ok := s.sessionDevice(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]bool{"authenticated": false})
		return
	}
	body := map[string]any{
		"authenticated": true,
		"deviceId":      deviceID,
		"hostName":      displayHostName(),
	}
	if homeDirectory, err := os.UserHomeDir(); err == nil && homeDirectory != "" {
		body["homeDirectory"] = homeDirectory
	}
	// CamberQA worktree development only: advertise this helper's worktree
	// identity and the other live slots so the mobile app can offer jumping
	// to another worktree's mobile surface.
	if camberqa := detectCamberQAInstance(); camberqa != nil {
		body["camberqa"] = camberqa
	}
	writeJSON(w, http.StatusOK, body)
}

// displayHostName names this computer for remote surfaces (the phone shows it
// as the conversation-list title). The mDNS ".local" suffix is noise there.
func displayHostName() string {
	name, err := os.Hostname()
	if err != nil {
		return ""
	}
	return strings.TrimSuffix(name, ".local")
}

// handleWSTicket issues a short-lived, single-use ticket for the WebSocket
// upgrade, authenticated by the session cookie (which fetch sends reliably,
// unlike a script-initiated WebSocket handshake on some browsers).
func (s *Server) handleWSTicket(w http.ResponseWriter, r *http.Request) {
	deviceID, ok := s.sessionDevice(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "authentication required"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"ticket": s.auth.createWSTicket(deviceID)})
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	// Prefer a ticket (works cross-browser); fall back to the session cookie
	// for non-browser clients.
	deviceID, ok := s.auth.redeemWSTicket(r.URL.Query().Get("ticket"))
	if !ok {
		deviceID, ok = s.sessionDevice(r)
	}
	if !ok {
		slog.Warn("remoteaccess: websocket auth failed", "remote", r.RemoteAddr)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "authentication required"})
		return
	}
	upgrader := websocket.Upgrader{CheckOrigin: checkOrigin}
	socket, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		slog.Warn("remoteaccess: websocket upgrade failed", "error", err)
		return
	}
	s.serveConn(socket, deviceID)
}

// serveConn runs one authenticated remote JSON-RPC connection to completion.
func (s *Server) serveConn(socket *websocket.Conn, deviceID string) {
	connID := deviceID + "/" + uuid.NewString()
	originID := "remote:" + connID

	adapter := &connHandler{
		connID:       originID,
		dispatch:     s.opts.Dispatch,
		isConcurrent: s.opts.IsConcurrentMethod,
		head:         closedChan(),
	}
	conn := jsonrpc2.NewConn(
		context.Background(),
		wsjsonrpc2.NewObjectStream(socket),
		adapter,
	)

	// Keepalive: ping on an interval, extend the read deadline on pong.
	_ = socket.SetReadDeadline(time.Now().Add(wsReadDeadline))
	socket.SetPongHandler(func(string) error {
		return socket.SetReadDeadline(time.Now().Add(wsReadDeadline))
	})
	stopPing := make(chan struct{})
	go func() {
		ticker := time.NewTicker(wsPingInterval)
		defer ticker.Stop()
		for {
			select {
			case <-stopPing:
				return
			case <-ticker.C:
				_ = socket.WriteControl(websocket.PingMessage, nil, time.Now().Add(wsWriteTimeout))
			}
		}
	}()

	notify := func(ctx context.Context, method string, params any) error {
		return conn.Notify(ctx, method, params)
	}
	unregister := s.opts.Hub.RegisterRemote(originID, notify, func() { _ = conn.Close() })

	s.mu.Lock()
	s.connected[deviceID]++
	s.closeFns[connID] = func() { _ = conn.Close() }
	s.mu.Unlock()

	slog.Info("remoteaccess: client connected", "device", deviceID, "conn", connID)
	<-conn.DisconnectNotify()
	close(stopPing)
	unregister()

	s.mu.Lock()
	s.connected[deviceID]--
	if s.connected[deviceID] <= 0 {
		delete(s.connected, deviceID)
	}
	delete(s.closeFns, connID)
	s.mu.Unlock()
	if s.opts.OnDisconnect != nil {
		// Drain in-flight handlers first so a request racing the disconnect
		// cannot re-register per-connection state after cleanup. Bounded so a
		// still-streaming prompt does not pin this goroutine; the only
		// handlers that write per-connection state finish in milliseconds.
		adapter.drain(2 * time.Second)
		s.opts.OnDisconnect(originID)
	}
	slog.Info("remoteaccess: client disconnected", "device", deviceID, "conn", connID)
}

func closedChan() chan struct{} {
	ch := make(chan struct{})
	close(ch)
	return ch
}

// connHandler adapts jsonrpc2 requests from one remote connection into the
// main handler, enforcing the method deny list and preserving the primary
// server's FIFO-with-concurrent-methods ordering semantics.
type connHandler struct {
	connID       string
	dispatch     DispatchFunc
	isConcurrent func(string) bool

	// inflight counts running request goroutines so disconnect cleanup can
	// drain them: a handler racing the disconnect (e.g. an acpnav view-state
	// write) must not re-register per-connection state after OnDisconnect
	// already cleared it.
	inflight sync.WaitGroup

	mx   sync.Mutex
	head chan struct{}
}

func (h *connHandler) Handle(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	h.inflight.Add(1)
	if req.Method == "$/cancelRequest" || h.isConcurrent(req.Method) {
		go func() {
			defer h.inflight.Done()
			h.handleOne(ctx, conn, req)
		}()
		return
	}
	h.mx.Lock()
	previous := h.head
	thisReq := make(chan struct{})
	h.head = thisReq
	h.mx.Unlock()
	go func() {
		defer h.inflight.Done()
		defer close(thisReq)
		<-previous
		h.handleOne(ctx, conn, req)
	}()
}

// drain waits for in-flight request goroutines, giving up after timeout so a
// long-running handler (a streaming prompt) cannot pin the cleanup goroutine.
func (h *connHandler) drain(timeout time.Duration) {
	done := make(chan struct{})
	go func() {
		h.inflight.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(timeout):
	}
}

func (h *connHandler) handleOne(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	result, rpcErr := h.process(ctx, conn, req)
	if req.Notif {
		return
	}
	if rpcErr != nil {
		if err := conn.ReplyWithError(ctx, req.ID, rpcErr); err != nil {
			slog.Debug("remoteaccess: reply error failed", "error", err)
		}
		return
	}
	if err := conn.Reply(ctx, req.ID, result); err != nil {
		slog.Debug("remoteaccess: reply failed", "error", err)
	}
}

func (h *connHandler) process(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) (any, *jsonrpc2.Error) {
	if !MethodAllowed(req.Method) {
		slog.Warn("remoteaccess: denied method", "method", req.Method, "conn", h.connID)
		return nil, &jsonrpc2.Error{
			Code:    jsonrpc2.CodeMethodNotFound,
			Message: fmt.Sprintf("method not available over remote access: %s", req.Method),
		}
	}

	glspCtx := glsp.Context{
		Method:    req.Method,
		RequestID: h.namespacedID(req.ID),
		Context:   ctx,
		Notify: func(ctx context.Context, method string, params any) error {
			return conn.Notify(ctx, method, params)
		},
		Call: func(ctx context.Context, method string, params any, result any) error {
			return conn.Call(ctx, method, params, result)
		},
	}
	if req.Params != nil {
		glspCtx.Params = *req.Params
	}
	if req.Method == "$/cancelRequest" {
		params, err := h.namespaceCancelParams(glspCtx.Params)
		if err != nil {
			return nil, &jsonrpc2.Error{Code: jsonrpc2.CodeInvalidParams, Message: err.Error()}
		}
		glspCtx.Params = params
	}

	result, validMethod, validParams, err := h.dispatch(h.connID, &glspCtx)
	switch {
	case !validMethod:
		return nil, &jsonrpc2.Error{
			Code:    jsonrpc2.CodeMethodNotFound,
			Message: fmt.Sprintf("method not supported: %s", req.Method),
		}
	case !validParams:
		msg := ""
		if err != nil {
			msg = err.Error()
		}
		return nil, &jsonrpc2.Error{Code: jsonrpc2.CodeInvalidParams, Message: msg}
	case err != nil:
		var jsonRPCErr *jsonrpc2.Error
		if errors.As(err, &jsonRPCErr) {
			return nil, jsonRPCErr
		}
		return nil, &jsonrpc2.Error{Code: jsonrpc2.CodeInvalidRequest, Message: err.Error()}
	default:
		return result, nil
	}
}

// namespacedID prefixes request IDs with the connection ID so in-flight
// cancellation bookkeeping cannot collide across connections.
func (h *connHandler) namespacedID(id jsonrpc2.ID) jsonrpc2.ID {
	return jsonrpc2.ID{Str: h.connID + ":" + id.String(), IsString: true}
}

// namespaceCancelParams rewrites $/cancelRequest params so the ID matches the
// namespaced form used when the request was registered.
func (h *connHandler) namespaceCancelParams(raw json.RawMessage) (json.RawMessage, error) {
	var params struct {
		ID any `json:"id"`
	}
	if err := json.Unmarshal(raw, &params); err != nil {
		return nil, fmt.Errorf("invalid $/cancelRequest params: %w", err)
	}
	var id jsonrpc2.ID
	switch v := params.ID.(type) {
	case string:
		id = jsonrpc2.ID{Str: v, IsString: true}
	case float64:
		id = jsonrpc2.ID{Num: uint64(v)}
	default:
		return nil, fmt.Errorf("invalid $/cancelRequest id type %T", params.ID)
	}
	return json.Marshal(map[string]any{"id": h.namespacedID(id).Str})
}

// defaultPort resolves the port used when enable passes none. CamberQA
// worktree instances each get their own port so several desktops can enable
// remote access at once: CAMBER_REMOTE_PORT wins, else the port derives
// from CAMBER_WORKTREE_SLOT the same way portsForSlot does in
// ui/packages/camberqa/src/worktree/shared.ts (base + slot*10). Packaged
// builds have neither variable and keep DefaultPort.
func defaultPort() int {
	if v := os.Getenv("CAMBER_REMOTE_PORT"); v != "" {
		if p, err := strconv.Atoi(v); err == nil && p > 0 && p < 65536 {
			return p
		}
		slog.Warn("remoteaccess: ignoring invalid CAMBER_REMOTE_PORT", "value", v)
	}
	if v := os.Getenv("CAMBER_WORKTREE_SLOT"); v != "" {
		if slot, err := strconv.Atoi(v); err == nil && slot > 0 && slot <= 64 {
			return DefaultPort + slot*10
		}
	}
	return DefaultPort
}

// bindAddress resolves a bind mode to a listen IP.
func bindAddress(bind string) (string, error) {
	switch bind {
	case BindLoopback:
		return "127.0.0.1", nil
	case BindAll:
		return "0.0.0.0", nil
	case BindTailscale:
		ip, err := tailscaleIP()
		if err != nil {
			return "", err
		}
		return ip, nil
	default:
		return "", fmt.Errorf("remoteaccess: unknown bind mode %q (want %q, %q or %q)", bind, BindLoopback, BindTailscale, BindAll)
	}
}

// tailscaleCGNAT is the Tailscale IPv4 range (100.64.0.0/10).
var tailscaleCGNAT = netip.MustParsePrefix("100.64.0.0/10")

func tailscaleIP() (string, error) {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return "", err
	}
	for _, addr := range addrs {
		ipNet, ok := addr.(*net.IPNet)
		if !ok {
			continue
		}
		ip, ok := netip.AddrFromSlice(ipNet.IP.To4())
		if !ok {
			continue
		}
		if tailscaleCGNAT.Contains(ip) {
			return ip.String(), nil
		}
	}
	return "", fmt.Errorf("remoteaccess: no Tailscale interface found (no IPv4 in 100.64.0.0/10)")
}

func serviceURLs(bind string, port int, secure bool, tsDNSName string) []string {
	scheme := "http"
	if secure {
		scheme = "https"
	}
	switch bind {
	case BindLoopback:
		return []string{fmt.Sprintf("%s://127.0.0.1:%d", scheme, port)}
	case BindTailscale:
		// With a trusted Tailscale cert the URL must use the MagicDNS name so
		// the cert validates; otherwise fall back to the tailnet IP.
		if tsDNSName != "" {
			return []string{fmt.Sprintf("%s://%s:%d", scheme, tsDNSName, port)}
		}
		ip, err := tailscaleIP()
		if err != nil {
			return nil
		}
		return []string{fmt.Sprintf("%s://%s:%d", scheme, ip, port)}
	case BindAll:
		var urls []string
		addrs, _ := net.InterfaceAddrs()
		for _, addr := range addrs {
			ipNet, ok := addr.(*net.IPNet)
			if !ok || ipNet.IP.To4() == nil || ipNet.IP.IsLoopback() {
				continue
			}
			urls = append(urls, fmt.Sprintf("%s://%s:%d", scheme, ipNet.IP.String(), port))
		}
		return urls
	default:
		return nil
	}
}

// staticHandler serves the built mobile UI bundle with an SPA fallback to
// index.html. A staticDir override wins (dev); otherwise the bundle embedded
// in the helper binary is served; if neither is available, a plain explainer
// page is served.
func staticHandler(staticDir string) http.Handler {
	if staticDir != "" {
		return spaFileHandler(os.DirFS(staticDir))
	}
	if embeddedFS, ok := webui.FS(); ok {
		return spaFileHandler(embeddedFS)
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, "<!doctype html><title>Camber Remote</title><p>Remote access is running, but no mobile UI bundle is built into this helper. Build it with <code>pnpm -F @camber/mobile-remote embed</code> and rebuild the helper.</p>")
	})
}

// spaFileHandler serves files from fsys, falling back to index.html for paths
// that do not resolve to a file (client-side routing).
//
// Compressible assets may exist only as pre-gzipped `<name>.gz` variants: the
// embedded bundle stores them that way (scripts/embed-webui.mjs) because the
// uncompressed UI was ~36MB of the helper binary. A request for `<name>`
// transparently serves the .gz bytes with Content-Encoding: gzip, or
// decompressed for clients that do not accept it.
func spaFileHandler(fsys fs.FS) http.Handler {
	fileServer := http.FileServer(http.FS(fsys))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cleaned := path.Clean(strings.TrimPrefix(r.URL.Path, "/"))
		if cleaned == "." || cleaned == "" {
			serveIndex(w, r, fsys)
			return
		}
		raw := false
		if info, err := fs.Stat(fsys, cleaned); err == nil && !info.IsDir() {
			raw = true
		}
		gzipped := false
		if !raw {
			if info, err := fs.Stat(fsys, cleaned+gzipSuffix); err == nil && !info.IsDir() {
				gzipped = true
			}
		}
		if !raw && !gzipped {
			serveIndex(w, r, fsys)
			return
		}
		// Vite emits content-hashed filenames under assets/, so they are safe to
		// cache forever. Everything else is revalidated to avoid a stale shell.
		if strings.HasPrefix(cleaned, "assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		// Go's mime table has no entry for .webmanifest, so the file server
		// would sniff it to text/plain and browsers would ignore the PWA
		// manifest.
		if strings.HasSuffix(cleaned, ".webmanifest") {
			w.Header().Set("Content-Type", "application/manifest+json")
		}
		if gzipped {
			serveGzipped(w, r, fsys, cleaned)
			return
		}
		fileServer.ServeHTTP(w, r)
	})
}

const gzipSuffix = ".gz"

// serveGzipped answers a request for `cleaned` from the stored
// `cleaned + ".gz"`: verbatim with Content-Encoding: gzip for clients that
// accept it (every real browser), decompressed in memory otherwise.
func serveGzipped(w http.ResponseWriter, r *http.Request, fsys fs.FS, cleaned string) {
	data, err := fs.ReadFile(fsys, cleaned+gzipSuffix)
	if err != nil {
		http.Error(w, "asset unavailable", http.StatusInternalServerError)
		return
	}
	if w.Header().Get("Content-Type") == "" {
		if ctype := mime.TypeByExtension(path.Ext(cleaned)); ctype != "" {
			w.Header().Set("Content-Type", ctype)
		}
	}
	w.Header().Set("Vary", "Accept-Encoding")
	if acceptsGzip(r) {
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		_, _ = w.Write(data)
		return
	}
	reader, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		http.Error(w, "asset corrupt", http.StatusInternalServerError)
		return
	}
	defer func() { _ = reader.Close() }()
	_, _ = io.Copy(w, reader)
}

// acceptsGzip honours RFC 9110 §12.5.3 as far as this handler needs: an
// explicit gzip entry decides via its q-value, and a wildcard only covers
// codings not explicitly listed (so `gzip;q=0, *` stays a refusal). Coding
// tokens and parameter names are case-insensitive. Anything unparsable
// counts as refusal — the fallback (serving identity) is always correct,
// just slower.
func acceptsGzip(r *http.Request) bool {
	wildcardAllows := false
	for enc := range strings.SplitSeq(r.Header.Get("Accept-Encoding"), ",") {
		name, params, _ := strings.Cut(strings.TrimSpace(enc), ";")
		switch strings.ToLower(strings.TrimSpace(name)) {
		case "gzip":
			return encodingQAllows(params)
		case "*":
			wildcardAllows = encodingQAllows(params)
		}
	}
	return wildcardAllows
}

func encodingQAllows(params string) bool {
	for param := range strings.SplitSeq(params, ";") {
		param = strings.ToLower(strings.TrimSpace(param))
		if value, ok := strings.CutPrefix(param, "q="); ok {
			parsed, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
			return err == nil && parsed > 0
		}
	}
	return true
}

func serveIndex(w http.ResponseWriter, r *http.Request, fsys fs.FS) {
	// Never cache the app shell: it references content-hashed bundles, so a
	// stale index.html would pin the browser to an old build (e.g. one using
	// cookie-only WebSocket auth that fails on Safari).
	w.Header().Set("Cache-Control", "no-store, must-revalidate")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if data, err := fs.ReadFile(fsys, "index.html"); err == nil {
		_, _ = w.Write(data)
		return
	}
	if _, err := fs.Stat(fsys, "index.html"+gzipSuffix); err == nil {
		serveGzipped(w, r, fsys, "index.html")
		return
	}
	http.Error(w, "index.html not found", http.StatusInternalServerError)
}
