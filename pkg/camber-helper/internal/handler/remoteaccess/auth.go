package remoteaccess

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/google/uuid"
)

const (
	pairingCodeTTL   = 5 * time.Minute
	sessionTTL       = 12 * time.Hour
	maxPairAttempts  = 10
	pairLockoutAfter = 5 * time.Minute
	// SessionCookieName carries the remote session token.
	SessionCookieName = "camber_remote_session"
)

// pairedDevice is the persisted record of a phone that completed pairing.
// Only a SHA-256 of the device token is stored.
type pairedDevice struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	TokenHash  string    `json:"tokenHash"`
	CreatedAt  time.Time `json:"createdAt"`
	LastSeenAt time.Time `json:"lastSeenAt"`
}

type persistedState struct {
	Devices []pairedDevice `json:"devices"`
	// AutoStart records whether the server should start automatically when
	// the helper launches, and AutoStartBind which interface it binds then.
	AutoStart     bool   `json:"autoStart,omitempty"`
	AutoStartBind string `json:"autoStartBind,omitempty"`
}

type pairingCode struct {
	code      string
	expiresAt time.Time
}

type pendingPairing struct {
	id               string
	attemptToken     string
	confirmationCode string
	deviceName       string
	createdAt        time.Time
	expiresAt        time.Time
	confirmed        *confirmedPairing
}

type confirmedPairing struct {
	deviceToken string
	device      pairedDevice
}

type pendingPairingInfo struct {
	ID         string
	DeviceName string
	CreatedAt  time.Time
	ExpiresAt  time.Time
}

type session struct {
	deviceID  string
	expiresAt time.Time
}

// wsTicketTTL bounds how long a WebSocket ticket is valid. It is single-use and
// only needs to survive the round-trip from /api/ws-ticket to the WS upgrade.
const wsTicketTTL = 30 * time.Second

type wsTicket struct {
	deviceID  string
	expiresAt time.Time
}

// authStore owns paired devices (persisted to a JSON state file), pending
// pairing codes, and live sessions (in memory only).
type authStore struct {
	mu            sync.Mutex
	path          string
	devices       []pairedDevice
	autoStart     bool
	autoStartBind string
	pending       []pairingCode
	pairings      []pendingPairing
	sessions      map[string]session
	wsTickets     map[string]wsTicket
	now           func() time.Time
	failures      int
	lockedTil     time.Time
}

func newAuthStore(path string) (*authStore, error) {
	s := &authStore{
		path:      path,
		sessions:  map[string]session{},
		wsTickets: map[string]wsTicket{},
		now:       time.Now,
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return s, nil
		}
		return nil, fmt.Errorf("remoteaccess: reading state file: %w", err)
	}
	var state persistedState
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, fmt.Errorf("remoteaccess: parsing state file: %w", err)
	}
	s.devices = state.Devices
	s.autoStart = state.AutoStart
	s.autoStartBind = state.AutoStartBind
	return s, nil
}

func (s *authStore) persistLocked() error {
	data, err := json.MarshalIndent(persistedState{
		Devices:       s.devices,
		AutoStart:     s.autoStart,
		AutoStartBind: s.autoStartBind,
	}, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// autoStartConfig reports the persisted auto-start preference.
func (s *authStore) autoStartConfig() (enabled bool, bind string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.autoStart, s.autoStartBind
}

// setAutoStart persists the auto-start preference.
func (s *authStore) setAutoStart(enabled bool, bind string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	prevEnabled, prevBind := s.autoStart, s.autoStartBind
	s.autoStart = enabled
	s.autoStartBind = bind
	if err := s.persistLocked(); err != nil {
		s.autoStart, s.autoStartBind = prevEnabled, prevBind
		return fmt.Errorf("persisting auto-start preference: %w", err)
	}
	return nil
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func randomToken(bytes int) string {
	buf := make([]byte, bytes)
	if _, err := rand.Read(buf); err != nil {
		panic(fmt.Sprintf("remoteaccess: crypto/rand failed: %v", err))
	}
	return base64.RawURLEncoding.EncodeToString(buf)
}

func randomDigits(length int) string {
	out := make([]byte, length)
	for i := range out {
		n, err := rand.Int(rand.Reader, big.NewInt(10))
		if err != nil {
			panic(fmt.Sprintf("remoteaccess: crypto/rand failed: %v", err))
		}
		out[i] = byte('0' + n.Int64())
	}
	return string(out)
}

// createPairingCode mints a short one-time code the desktop shows as a QR.
func (s *authStore) createPairingCode() (code string, expiresAt time.Time) {
	buf := make([]byte, 5)
	if _, err := rand.Read(buf); err != nil {
		panic(fmt.Sprintf("remoteaccess: crypto/rand failed: %v", err))
	}
	code = base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(buf)
	expiresAt = s.now().Add(pairingCodeTTL)

	s.mu.Lock()
	defer s.mu.Unlock()
	s.prunePendingLocked()
	// A new code supersedes older ones: exactly one valid code at a time
	// keeps the attack surface minimal.
	s.pending = []pairingCode{{code: code, expiresAt: expiresAt}}
	s.pairings = nil
	return code, expiresAt
}

func (s *authStore) prunePendingLocked() {
	now := s.now()
	kept := s.pending[:0]
	for _, p := range s.pending {
		if now.Before(p.expiresAt) {
			kept = append(kept, p)
		}
	}
	s.pending = kept
}

func (s *authStore) prunePairingsLocked() {
	now := s.now()
	kept := s.pairings[:0]
	for _, p := range s.pairings {
		if now.Before(p.expiresAt) {
			kept = append(kept, p)
		}
	}
	s.pairings = kept
}

// beginPairing consumes a QR enrollment secret and creates a pending phone
// challenge. The returned confirmation code is shown on the phone and must be
// typed on the desktop before a device token is created.
func (s *authStore) beginPairing(code, deviceName string) (id, attemptToken, confirmationCode string, expiresAt time.Time, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.now()
	if now.Before(s.lockedTil) {
		return "", "", "", time.Time{}, fmt.Errorf("pairing locked, retry after %s", s.lockedTil.Sub(now).Round(time.Second))
	}

	s.prunePendingLocked()
	s.prunePairingsLocked()
	matched := -1
	for i, p := range s.pending {
		if subtle.ConstantTimeCompare([]byte(p.code), []byte(code)) == 1 {
			matched = i
			break
		}
	}
	if matched < 0 {
		s.failures++
		if s.failures >= maxPairAttempts {
			s.lockedTil = now.Add(pairLockoutAfter)
			s.failures = 0
		}
		return "", "", "", time.Time{}, fmt.Errorf("invalid or expired pairing code")
	}

	// One-time use.
	s.pending = append(s.pending[:matched], s.pending[matched+1:]...)
	s.failures = 0

	if deviceName == "" {
		deviceName = "Remote device"
	}
	id = uuid.NewString()
	attemptToken = randomToken(32)
	confirmationCode = randomDigits(6)
	expiresAt = now.Add(pairingCodeTTL)
	s.pairings = []pendingPairing{{
		id:               id,
		attemptToken:     attemptToken,
		confirmationCode: confirmationCode,
		deviceName:       deviceName,
		createdAt:        now,
		expiresAt:        expiresAt,
	}}
	return id, attemptToken, confirmationCode, expiresAt, nil
}

// confirmPairing accepts a scanned phone only when the desktop user types the
// exact confirmation code displayed on that phone.
func (s *authStore) confirmPairing(pairingID, confirmationCode string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.now()
	if now.Before(s.lockedTil) {
		return fmt.Errorf("pairing locked, retry after %s", s.lockedTil.Sub(now).Round(time.Second))
	}

	s.prunePairingsLocked()
	matched := -1
	for i, p := range s.pairings {
		if p.id == pairingID {
			matched = i
			break
		}
	}
	if matched < 0 {
		return fmt.Errorf("unknown or expired pairing request")
	}
	p := &s.pairings[matched]
	if p.confirmed != nil {
		return nil
	}
	if subtle.ConstantTimeCompare([]byte(p.confirmationCode), []byte(confirmationCode)) != 1 {
		s.failures++
		if s.failures >= maxPairAttempts {
			s.lockedTil = now.Add(pairLockoutAfter)
			s.failures = 0
		}
		return fmt.Errorf("invalid confirmation code")
	}
	s.failures = 0

	deviceToken := randomToken(32)
	device := pairedDevice{
		ID:         uuid.NewString(),
		Name:       p.deviceName,
		TokenHash:  hashToken(deviceToken),
		CreatedAt:  now,
		LastSeenAt: now,
	}
	s.devices = append(s.devices, device)
	if err := s.persistLocked(); err != nil {
		s.devices = s.devices[:len(s.devices)-1]
		return fmt.Errorf("persisting paired device: %w", err)
	}
	p.confirmed = &confirmedPairing{deviceToken: deviceToken, device: device}
	return nil
}

// completePairing lets the phone retrieve its device token once the desktop has
// confirmed the code. Pending attempts return ok=false with no error.
func (s *authStore) completePairing(attemptToken string) (deviceToken string, device pairedDevice, ok bool, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.prunePairingsLocked()
	for i, p := range s.pairings {
		if subtle.ConstantTimeCompare([]byte(p.attemptToken), []byte(attemptToken)) != 1 {
			continue
		}
		if p.confirmed == nil {
			return "", pairedDevice{}, false, nil
		}
		confirmed := p.confirmed
		s.pairings = append(s.pairings[:i], s.pairings[i+1:]...)
		return confirmed.deviceToken, confirmed.device, true, nil
	}
	return "", pairedDevice{}, false, fmt.Errorf("unknown or expired pairing request")
}

func (s *authStore) listPendingPairings() []pendingPairingInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.prunePairingsLocked()
	out := make([]pendingPairingInfo, 0, len(s.pairings))
	for _, p := range s.pairings {
		if p.confirmed != nil {
			continue
		}
		out = append(out, pendingPairingInfo{
			ID:         p.id,
			DeviceName: p.deviceName,
			CreatedAt:  p.createdAt,
			ExpiresAt:  p.expiresAt,
		})
	}
	return out
}

// createSession exchanges a device token for a short-lived session token.
func (s *authStore) createSession(deviceToken string) (sessionToken string, deviceID string, err error) {
	tokenHash := hashToken(deviceToken)

	s.mu.Lock()
	defer s.mu.Unlock()
	// Another helper sharing this state file (camberqa worktree helpers all
	// default to the same path) may have paired or revoked devices since we
	// loaded it. Refresh from disk before matching — both so a phone paired
	// on any worktree is accepted by every worktree, and so the LastSeenAt
	// persist below does not clobber devices this helper never saw.
	s.reloadDevicesLocked()
	return s.createSessionLocked(tokenHash)
}

func (s *authStore) createSessionLocked(tokenHash string) (sessionToken string, deviceID string, err error) {
	for i := range s.devices {
		if subtle.ConstantTimeCompare([]byte(s.devices[i].TokenHash), []byte(tokenHash)) == 1 {
			s.devices[i].LastSeenAt = s.now()
			_ = s.persistLocked()
			sessionToken = randomToken(32)
			s.sessions[sessionToken] = session{
				deviceID:  s.devices[i].ID,
				expiresAt: s.now().Add(sessionTTL),
			}
			return sessionToken, s.devices[i].ID, nil
		}
	}
	return "", "", fmt.Errorf("unknown device token")
}

// reloadDevicesLocked re-reads the persisted device list from disk, keeping
// the in-memory copy on read or parse errors (the file may be mid-rewrite by
// another helper). Auto-start preferences are left alone: they are per-helper
// runtime knobs, while the device list is the shared credential set.
func (s *authStore) reloadDevicesLocked() {
	data, err := os.ReadFile(s.path)
	if err != nil {
		return
	}
	var state persistedState
	if err := json.Unmarshal(data, &state); err != nil {
		return
	}
	s.devices = state.Devices
}

// validateSession returns the device ID for a live session token.
func (s *authStore) validateSession(sessionToken string) (deviceID string, ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, found := s.sessions[sessionToken]
	if !found {
		return "", false
	}
	if s.now().After(sess.expiresAt) {
		delete(s.sessions, sessionToken)
		return "", false
	}
	return sess.deviceID, true
}

// createWSTicket mints a short-lived, single-use ticket for a WebSocket
// upgrade. Browsers (notably iOS Safari) do not reliably send SameSite cookies
// on script-initiated WebSocket handshakes, so the client fetches a ticket over
// HTTP (where the cookie IS sent) and passes it in the WS URL instead.
func (s *authStore) createWSTicket(deviceID string) string {
	ticket := randomToken(24)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneWSTicketsLocked()
	s.wsTickets[ticket] = wsTicket{deviceID: deviceID, expiresAt: s.now().Add(wsTicketTTL)}
	return ticket
}

// redeemWSTicket consumes a ticket (single use) and returns its device ID.
func (s *authStore) redeemWSTicket(ticket string) (deviceID string, ok bool) {
	if ticket == "" {
		return "", false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	t, found := s.wsTickets[ticket]
	if !found {
		return "", false
	}
	delete(s.wsTickets, ticket)
	if s.now().After(t.expiresAt) {
		return "", false
	}
	return t.deviceID, true
}

func (s *authStore) pruneWSTicketsLocked() {
	now := s.now()
	for k, t := range s.wsTickets {
		if now.After(t.expiresAt) {
			delete(s.wsTickets, k)
		}
	}
}

// revokeDevice removes a paired device and kills its live sessions.
func (s *authStore) revokeDevice(deviceID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	kept := make([]pairedDevice, 0, len(s.devices))
	found := false
	for _, d := range s.devices {
		if d.ID == deviceID {
			found = true
			continue
		}
		kept = append(kept, d)
	}
	if !found {
		return fmt.Errorf("unknown device %q", deviceID)
	}
	previous := s.devices
	s.devices = kept
	if err := s.persistLocked(); err != nil {
		// Roll back like pairingConfirm/setAutoStart: without this a failed
		// persist leaves the device gone from memory (and the settings list)
		// but still valid on disk, so the "revoked" token would silently work
		// again after the next helper restart.
		s.devices = previous
		return err
	}
	for token, sess := range s.sessions {
		if sess.deviceID == deviceID {
			delete(s.sessions, token)
		}
	}
	return nil
}

func (s *authStore) listDevices() []pairedDevice {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]pairedDevice, len(s.devices))
	copy(out, s.devices)
	return out
}
