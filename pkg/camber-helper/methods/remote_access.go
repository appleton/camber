package methods

const remoteAccessMethodPrefix = "camber/remoteAccess/"

const (
	RemoteAccessStatusMethod            = remoteAccessMethodPrefix + "status"
	RemoteAccessEnableMethod            = remoteAccessMethodPrefix + "enable"
	RemoteAccessDisableMethod           = remoteAccessMethodPrefix + "disable"
	RemoteAccessSetAutoStartMethod      = remoteAccessMethodPrefix + "setAutoStart"
	RemoteAccessCreatePairingCodeMethod = remoteAccessMethodPrefix + "createPairingCode"
	RemoteAccessConfirmPairingMethod    = remoteAccessMethodPrefix + "confirmPairing"
	RemoteAccessRevokeDeviceMethod      = remoteAccessMethodPrefix + "revokeDevice"
)

// RemoteAccessDevice describes a paired remote device.
type RemoteAccessDevice struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	CreatedAt  string `json:"createdAt"`
	LastSeenAt string `json:"lastSeenAt,omitempty"`
	Connected  bool   `json:"connected"`
}

// RemoteAccessPendingPairing describes a phone that scanned the pairing QR and
// is waiting for the desktop user to type the code shown on the phone.
type RemoteAccessPendingPairing struct {
	ID         string `json:"id"`
	DeviceName string `json:"deviceName"`
	CreatedAt  string `json:"createdAt"`
	ExpiresAt  string `json:"expiresAt"`
}

// TLS modes reported in RemoteAccessTLS.Mode.
const (
	// RemoteAccessTLSModeTrusted: a browser-trusted certificate (Tailscale /
	// Let's Encrypt). Phones connect with no extra setup.
	RemoteAccessTLSModeTrusted = "trusted"
	// RemoteAccessTLSModeLocalCA: a certificate signed by this desktop's own
	// local CA. Phones must install and trust the CA once (see CAURL).
	RemoteAccessTLSModeLocalCA = "localCA"
	// RemoteAccessTLSModePlain: no TLS. Only safe on loopback, where the
	// browser already treats the origin as secure.
	RemoteAccessTLSModePlain = "plainHttp"
)

// RemoteAccessTLS describes how the running server terminates TLS, so the
// settings UI can explain what a connecting phone will experience.
type RemoteAccessTLS struct {
	Mode string `json:"mode"`
	// Warning explains a degraded mode, e.g. the Tailscale trusted-cert path
	// failed and the server fell back to the local CA.
	Warning string `json:"warning,omitempty"`
	// CAURL is where the local CA certificate can be downloaded when Mode is
	// localCA — the phone must install and trust it once.
	CAURL string `json:"caUrl,omitempty"`
}

// RemoteAccessTailscaleInfo reports whether the Tailscale trusted-certificate
// path is available on this machine, so the settings UI can explain problems
// (and expected first-enable latency) before the user hits them.
type RemoteAccessTailscaleInfo struct {
	// CLIInstalled is whether a usable `tailscale` CLI was found (PATH or the
	// macOS app bundle).
	CLIInstalled bool `json:"cliInstalled"`
	// InterfaceUp is whether a Tailscale network interface with an IPv4
	// address is present (binding works even without the CLI).
	InterfaceUp bool `json:"interfaceUp"`
	// BackendState is tailscale's reported state, e.g. "Running", "Stopped",
	// "NeedsLogin". Empty when the CLI is unavailable.
	BackendState string `json:"backendState,omitempty"`
	// DNSName is this node's MagicDNS name.
	DNSName string `json:"dnsName,omitempty"`
	// HTTPSEnabled is whether the tailnet can issue HTTPS certificates
	// (`tailscale cert` will work).
	HTTPSEnabled bool `json:"httpsEnabled"`
	// CertCached is whether a still-valid trusted certificate is already on
	// disk; if not, the first enable blocks ~10-15s on issuance.
	CertCached bool `json:"certCached"`
	// Error is the probe failure, if any, for display.
	Error string `json:"error,omitempty"`
}

// RemoteAccessStatus is the current state of the remote access server.
type RemoteAccessStatus struct {
	Enabled bool   `json:"enabled"`
	Bind    string `json:"bind,omitempty"`
	Port    int    `json:"port,omitempty"`
	// AutoStart is whether the server starts automatically when the helper
	// (and therefore the app) launches.
	AutoStart bool `json:"autoStart"`
	// AutoStartBind is the bind mode a future auto-start will use.
	AutoStartBind string `json:"autoStartBind,omitempty"`
	// URLs the mobile UI is reachable at, one per bound interface.
	URLs    []string             `json:"urls,omitempty"`
	Devices []RemoteAccessDevice `json:"devices"`
	// PendingPairings are scanned phones waiting for desktop confirmation.
	PendingPairings []RemoteAccessPendingPairing `json:"pendingPairings,omitempty"`
	// ConnectedClients is the number of live remote connections.
	ConnectedClients int `json:"connectedClients"`
	// TLS describes the running server's transport security (set when enabled).
	TLS *RemoteAccessTLS `json:"tls,omitempty"`
	// Tailscale reports whether the recommended trusted-cert path is available.
	Tailscale *RemoteAccessTailscaleInfo `json:"tailscale,omitempty"`
}

type RemoteAccessStatusParams struct{}

func (RemoteAccessStatusParams) MethodName() string { return RemoteAccessStatusMethod }
func (RemoteAccessStatusParams) Description() string {
	return "Returns the state of the remote access server: enabled, bind address, paired devices, live connections."
}

type RemoteAccessEnableParams struct {
	// Bind selects the interface: "loopback" (default), "tailscale", or "all".
	Bind string `json:"bind,omitempty"`
	Port int    `json:"port,omitempty"`
	// StaticDir is an absolute path to the built mobile UI bundle to serve.
	StaticDir string `json:"staticDir,omitempty"`
	// DevServerURL, when set, reverse-proxies all non-/api traffic to a Vite
	// dev server (falling back to static serving if it is unreachable), so UI
	// changes apply without re-embedding the bundle or restarting the helper.
	DevServerURL string `json:"devServerUrl,omitempty"`
}

func (RemoteAccessEnableParams) MethodName() string { return RemoteAccessEnableMethod }
func (RemoteAccessEnableParams) Description() string {
	return "Starts the remote access HTTP/WebSocket server on the selected interface."
}

type RemoteAccessDisableParams struct{}

func (RemoteAccessDisableParams) MethodName() string { return RemoteAccessDisableMethod }
func (RemoteAccessDisableParams) Description() string {
	return "Stops the remote access server and disconnects all remote clients."
}

// RemoteAccessSetAutoStartParams persists whether (and how) the remote access
// server starts automatically on helper launch. It does not start or stop the
// running server.
type RemoteAccessSetAutoStartParams struct {
	AutoStart bool `json:"autoStart"`
	// Bind is the interface a future auto-start uses: "loopback", "tailscale",
	// or "all". Required when AutoStart is true.
	Bind string `json:"bind,omitempty"`
}

func (RemoteAccessSetAutoStartParams) MethodName() string { return RemoteAccessSetAutoStartMethod }
func (RemoteAccessSetAutoStartParams) Description() string {
	return "Persists whether the remote access server starts automatically when the helper launches."
}

type RemoteAccessCreatePairingCodeParams struct{}

func (RemoteAccessCreatePairingCodeParams) MethodName() string {
	return RemoteAccessCreatePairingCodeMethod
}
func (RemoteAccessCreatePairingCodeParams) Description() string {
	return "Creates a short-lived one-time QR secret a phone can scan to request pairing."
}

// RemoteAccessPairingCode is a one-time QR enrollment secret. It opens the
// pairing page only; device pairing still requires desktop confirmation.
type RemoteAccessPairingCode struct {
	Code      string   `json:"code"`
	ExpiresAt string   `json:"expiresAt"`
	URLs      []string `json:"urls,omitempty"`
}

type RemoteAccessConfirmPairingParams struct {
	PairingID string `json:"pairingId"`
	Code      string `json:"code"`
}

func (RemoteAccessConfirmPairingParams) MethodName() string {
	return RemoteAccessConfirmPairingMethod
}
func (RemoteAccessConfirmPairingParams) Description() string {
	return "Confirms a scanned phone by matching the code displayed on that phone."
}

type RemoteAccessRevokeDeviceParams struct {
	DeviceID string `json:"deviceId"`
}

func (RemoteAccessRevokeDeviceParams) MethodName() string { return RemoteAccessRevokeDeviceMethod }
func (RemoteAccessRevokeDeviceParams) Description() string {
	return "Revokes a paired device token and disconnects its live sessions."
}

// Keys stamped onto the {agentServer, message} bridge envelope of
// session/update notifications so clients can deduplicate and resume the
// stream. Only live events get stamps; session/load replay traffic is scoped
// to the loading client and never stamped.
const (
	BridgeSessionSeqKey   = "sessionSeq"
	BridgeSessionEpochKey = "sessionEpoch"
	// BridgeOriginDeviceKey tags an event mirrored from one device's own
	// action (its prompt's user message). Every remote receives every stamped
	// event so the seq stream stays gapless; the tagged device's transport
	// drops the content (it rendered the prompt locally) and just advances
	// its cursor.
	BridgeOriginDeviceKey = "originDevice"
)

// LoadSessionCursorMetaKey is the _meta key on a session/load response
// carrying the session's live-event cursor at replay time (see
// RemoteResumeCursor): {"epoch": string, "seq": number, "turnActive": bool}.
const LoadSessionCursorMetaKey = "camber/sessionCursor"

// RemoteResumeMethod lets a reconnecting remote client catch up on live
// session/update events it missed while its socket was down, instead of
// re-loading whole conversations.
const RemoteResumeMethod = "camber/remote/resume"

// RemoteResumeCursor names the last stamped event a client has applied for
// one session. Epoch pins the helper run the seq belongs to.
type RemoteResumeCursor struct {
	AgentServer string `json:"agentServer"`
	SessionID   string `json:"sessionId"`
	Epoch       string `json:"epoch"`
	Seq         int64  `json:"seq"`
}

type RemoteResumeParams struct {
	Sessions []RemoteResumeCursor `json:"sessions"`
}

func (RemoteResumeParams) MethodName() string { return RemoteResumeMethod }
func (RemoteResumeParams) Description() string {
	return "Replays buffered live session events after a cursor to the calling remote client; sessions it cannot resume must be reloaded."
}

// RemoteResumeResult reports, per requested session, whether buffered events
// after the cursor were replayed to the caller. Resumed=false (epoch change,
// cursor evicted from the buffer, or unknown session) means the client's copy
// can no longer be patched and must be re-loaded.
type RemoteResumeResult struct {
	AgentServer string `json:"agentServer"`
	SessionID   string `json:"sessionId"`
	Resumed     bool   `json:"resumed"`
}

type RemoteResumeOutput struct {
	Sessions []RemoteResumeResult `json:"sessions"`
}

// NotifyOthersMethod is an internal routing sentinel, not a real client
// method: the remote-access hub intercepts it in WrapNotify and relays the
// wrapped notification to every connected client EXCEPT the originating one,
// which already rendered the action locally. It never reaches a client
// verbatim.
const NotifyOthersMethod = "camber/hub/notifyOthers"

// NotifyOthersParams wraps the notification to relay via NotifyOthersMethod.
type NotifyOthersParams struct {
	Method string `json:"method"`
	Params any    `json:"params"`
}
