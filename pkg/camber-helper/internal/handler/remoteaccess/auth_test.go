package remoteaccess

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newTestStore(t *testing.T) *authStore {
	t.Helper()
	store, err := newAuthStore(filepath.Join(t.TempDir(), "state.json"))
	require.NoError(t, err)
	return store
}

func TestPairingFlow(t *testing.T) {
	store := newTestStore(t)

	code, expiresAt := store.createPairingCode()
	require.NotEmpty(t, code)
	assert.True(t, expiresAt.After(time.Now()))

	pairingID, attemptToken, confirmationCode, _, err := store.beginPairing(code, "Johan's phone")
	require.NoError(t, err)
	assert.NotEmpty(t, pairingID)
	assert.NotEmpty(t, attemptToken)
	assert.NotEmpty(t, confirmationCode)

	// Scanning only creates a pending challenge; the phone does not get a token
	// until the desktop confirms the code shown on the phone.
	_, _, ok, err := store.completePairing(attemptToken)
	require.NoError(t, err)
	assert.False(t, ok)

	require.Error(t, store.confirmPairing(pairingID, "000000"))
	require.NoError(t, store.confirmPairing(pairingID, confirmationCode))

	token, device, ok, err := store.completePairing(attemptToken)
	require.NoError(t, err)
	require.True(t, ok)
	assert.NotEmpty(t, token)
	assert.Equal(t, "Johan's phone", device.Name)

	// Codes are single use.
	_, _, _, _, err = store.beginPairing(code, "again")
	require.Error(t, err)

	// The token opens sessions; garbage does not.
	sessionToken, deviceID, err := store.createSession(token)
	require.NoError(t, err)
	assert.Equal(t, device.ID, deviceID)

	gotDevice, ok := store.validateSession(sessionToken)
	require.True(t, ok)
	assert.Equal(t, device.ID, gotDevice)

	_, _, err = store.createSession("not-a-token")
	require.Error(t, err)
	_, ok = store.validateSession("not-a-session")
	assert.False(t, ok)
}

// pairDevice runs the full pairing flow on a store and returns the device token.
func pairDevice(t *testing.T, store *authStore, name string) string {
	t.Helper()
	code, _ := store.createPairingCode()
	pairingID, attemptToken, confirmationCode, _, err := store.beginPairing(code, name)
	require.NoError(t, err)
	require.NoError(t, store.confirmPairing(pairingID, confirmationCode))
	token, _, ok, err := store.completePairing(attemptToken)
	require.NoError(t, err)
	require.True(t, ok)
	return token
}

func TestSessionAcceptsDevicePairedByAnotherStore(t *testing.T) {
	// CamberQA worktree helpers share one state file: a device paired
	// through any helper must open sessions on all of them, including
	// helpers that loaded the file before the pairing happened.
	statePath := filepath.Join(t.TempDir(), "state.json")
	early, err := newAuthStore(statePath)
	require.NoError(t, err)

	other, err := newAuthStore(statePath)
	require.NoError(t, err)
	token := pairDevice(t, other, "Johan's phone")

	sessionToken, _, err := early.createSession(token)
	require.NoError(t, err)
	_, ok := early.validateSession(sessionToken)
	assert.True(t, ok)
}

func TestSessionReloadPreservesForeignDevices(t *testing.T) {
	// A helper minting a session (which persists LastSeenAt) must not clobber
	// devices another helper added to the shared file.
	statePath := filepath.Join(t.TempDir(), "state.json")
	a, err := newAuthStore(statePath)
	require.NoError(t, err)
	tokenA := pairDevice(t, a, "phone A")

	b, err := newAuthStore(statePath)
	require.NoError(t, err)
	tokenB := pairDevice(t, b, "phone B")

	// a persists through createSession; it must have re-read phone B first.
	_, _, err = a.createSession(tokenA)
	require.NoError(t, err)

	fresh, err := newAuthStore(statePath)
	require.NoError(t, err)
	_, _, err = fresh.createSession(tokenB)
	assert.NoError(t, err, "device B must survive device A's session persist")
	_, _, err = fresh.createSession(tokenA)
	assert.NoError(t, err)
}

func TestPairingCodeExpires(t *testing.T) {
	store := newTestStore(t)
	code, _ := store.createPairingCode()

	now := time.Now()
	store.now = func() time.Time { return now.Add(pairingCodeTTL + time.Second) }
	_, _, _, _, err := store.beginPairing(code, "late")
	require.Error(t, err)
}

func TestNewCodeSupersedesOld(t *testing.T) {
	store := newTestStore(t)
	first, _ := store.createPairingCode()
	_, _ = store.createPairingCode()
	_, _, _, _, err := store.beginPairing(first, "old code")
	require.Error(t, err, "an older pairing code must be invalidated by a newer one")
}

func TestPairingRateLimitLocksOut(t *testing.T) {
	store := newTestStore(t)
	_, _ = store.createPairingCode()

	for i := 0; i < maxPairAttempts; i++ {
		_, _, _, _, err := store.beginPairing("WRONG", "attacker")
		require.Error(t, err)
	}
	// Locked out now: even the real code is rejected.
	code, _ := store.createPairingCode()
	_, _, _, _, err := store.beginPairing(code, "victim")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "locked")

	// After the lockout window, pairing works again.
	now := time.Now()
	store.now = func() time.Time { return now.Add(pairLockoutAfter + time.Second) }
	code2, _ := store.createPairingCode()
	_, _, _, _, err = store.beginPairing(code2, "victim")
	require.NoError(t, err)
}

func TestDevicesPersistAcrossRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	store, err := newAuthStore(path)
	require.NoError(t, err)

	code, _ := store.createPairingCode()
	pairingID, attemptToken, confirmationCode, _, err := store.beginPairing(code, "phone")
	require.NoError(t, err)
	require.NoError(t, store.confirmPairing(pairingID, confirmationCode))
	token, device, ok, err := store.completePairing(attemptToken)
	require.NoError(t, err)
	require.True(t, ok)

	// Simulate helper restart.
	store2, err := newAuthStore(path)
	require.NoError(t, err)
	_, deviceID, err := store2.createSession(token)
	require.NoError(t, err)
	assert.Equal(t, device.ID, deviceID)

	// Sessions are in-memory only and do not survive restarts.
	devices := store2.listDevices()
	require.Len(t, devices, 1)
	assert.Equal(t, "phone", devices[0].Name)
}

func TestRevokeDeviceKillsSessions(t *testing.T) {
	store := newTestStore(t)
	code, _ := store.createPairingCode()
	pairingID, attemptToken, confirmationCode, _, err := store.beginPairing(code, "phone")
	require.NoError(t, err)
	require.NoError(t, store.confirmPairing(pairingID, confirmationCode))
	token, device, ok, err := store.completePairing(attemptToken)
	require.NoError(t, err)
	require.True(t, ok)
	require.NoError(t, err)
	sessionToken, _, err := store.createSession(token)
	require.NoError(t, err)

	require.NoError(t, store.revokeDevice(device.ID))

	_, ok = store.validateSession(sessionToken)
	assert.False(t, ok, "sessions of a revoked device must be invalid")
	_, _, err = store.createSession(token)
	require.Error(t, err, "revoked device token must not open new sessions")
	require.Error(t, store.revokeDevice(device.ID), "revoking twice errors")
}

func TestWSTicketSingleUseAndExpiry(t *testing.T) {
	store := newTestStore(t)

	ticket := store.createWSTicket("device-1")
	require.NotEmpty(t, ticket)

	deviceID, ok := store.redeemWSTicket(ticket)
	require.True(t, ok)
	assert.Equal(t, "device-1", deviceID)

	// Single use: a redeemed ticket can't be reused.
	_, ok = store.redeemWSTicket(ticket)
	assert.False(t, ok)

	// Empty and unknown tickets are rejected.
	_, ok = store.redeemWSTicket("")
	assert.False(t, ok)
	_, ok = store.redeemWSTicket("bogus")
	assert.False(t, ok)

	// Expiry.
	t2 := store.createWSTicket("device-2")
	now := time.Now()
	store.now = func() time.Time { return now.Add(wsTicketTTL + time.Second) }
	_, ok = store.redeemWSTicket(t2)
	assert.False(t, ok)
}

func TestSessionExpiry(t *testing.T) {
	store := newTestStore(t)
	code, _ := store.createPairingCode()
	pairingID, attemptToken, confirmationCode, _, err := store.beginPairing(code, "phone")
	require.NoError(t, err)
	require.NoError(t, store.confirmPairing(pairingID, confirmationCode))
	token, _, ok, err := store.completePairing(attemptToken)
	require.NoError(t, err)
	require.True(t, ok)
	require.NoError(t, err)
	sessionToken, _, err := store.createSession(token)
	require.NoError(t, err)

	now := time.Now()
	store.now = func() time.Time { return now.Add(sessionTTL + time.Minute) }
	_, ok = store.validateSession(sessionToken)
	assert.False(t, ok)
}

func TestAutoStartPersistsAcrossRestarts(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	store, err := newAuthStore(path)
	require.NoError(t, err)

	enabled, bind := store.autoStartConfig()
	assert.False(t, enabled)
	assert.Empty(t, bind)

	require.NoError(t, store.setAutoStart(true, "tailscale"))

	reopened, err := newAuthStore(path)
	require.NoError(t, err)
	enabled, bind = reopened.autoStartConfig()
	assert.True(t, enabled)
	assert.Equal(t, "tailscale", bind)

	// Turning auto-start off clears the stored bind too.
	require.NoError(t, reopened.setAutoStart(false, ""))
	reopened2, err := newAuthStore(path)
	require.NoError(t, err)
	enabled, bind = reopened2.autoStartConfig()
	assert.False(t, enabled)
	assert.Empty(t, bind)
}
