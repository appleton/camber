package remoteaccess

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func writeSlotLock(t *testing.T, dir string, slot int, id string, pid int) {
	t.Helper()
	data, err := json.Marshal(map[string]any{"id": id, "pid": pid})
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(dir, "slot-"+strconv.Itoa(slot)+".lock"), data, 0o600))
}

func TestListLiveSlots(t *testing.T) {
	dir := t.TempDir()
	// Live: our own pid. Dead: a pid that cannot exist.
	writeSlotLock(t, dir, 1, "orderly-orbit", os.Getpid())
	writeSlotLock(t, dir, 2, "stale-tree", 1<<30)
	// Garbage lock files are skipped.
	require.NoError(t, os.WriteFile(filepath.Join(dir, "slot-3.lock"), []byte("not json"), 0o600))

	slots := listLiveSlots(dir)
	require.Len(t, slots, 1)
	assert.Equal(t, 1, slots[0].Slot)
	assert.Equal(t, "orderly-orbit", slots[0].ID)
	assert.Equal(t, DefaultPort+10, slots[0].RemotePort)
}

func TestListLiveSlotsMissingDir(t *testing.T) {
	assert.Empty(t, listLiveSlots(filepath.Join(t.TempDir(), "nope")))
}

func TestDetectCamberQAInstance(t *testing.T) {
	t.Setenv("CAMBER_WORKTREE_ID", "")
	assert.Nil(t, detectCamberQAInstance(), "production helpers (no worktree env) advertise nothing")

	t.Setenv("CAMBER_WORKTREE_ID", "orderly-orbit")
	t.Setenv("CAMBER_WORKTREE_SLOT", "2")
	t.Setenv("CAMBERQA_DESKTOP_COLOR", "")
	t.Setenv("VITE_CAMBERQA_COLOR", "")
	info := detectCamberQAInstance()
	require.NotNil(t, info)
	assert.Equal(t, 2, info.Slot)
	assert.Equal(t, "orderly-orbit", info.WorktreeName)
	assert.Equal(t, camberqaSlotColor(2), info.Color)

	// Main workspace (slot 0) has no worktree name or colour of its own.
	t.Setenv("CAMBER_WORKTREE_ID", "main")
	t.Setenv("CAMBER_WORKTREE_SLOT", "0")
	info = detectCamberQAInstance()
	require.NotNil(t, info)
	assert.Equal(t, 0, info.Slot)
	assert.Empty(t, info.WorktreeName)
	assert.Empty(t, info.Color)
}
