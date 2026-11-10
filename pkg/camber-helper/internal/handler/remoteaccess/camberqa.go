package remoteaccess

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
)

// CamberQA worktree development support: when this helper is spawned by a
// `camberqa worktree up` instance, /api/me advertises which worktree slot
// serves this app and which other slots are live, so the mobile app can offer
// jumping straight to another worktree's mobile surface. Constants mirror
// ui/packages/camberqa/src/worktree/shared.ts (portsForSlot, SLOT_COLORS)
// and slot.ts (SLOT_DIR, lock file shape).

const camberqaSlotDir = "/tmp/camber-worktree-slots"

// camberqaSlotColors mirrors SLOT_COLORS in camberqa's worktree/shared.ts.
var camberqaSlotColors = []string{
	"#2563eb",
	"#16a34a",
	"#7c3aed",
	"#db2777",
	"#ea580c",
	"#ca8a04",
	"#0891b2",
	"#dc2626",
}

// camberqaInstance is the /api/me payload describing this helper's camberqa
// worktree identity and the other live worktree slots on this machine.
type camberqaInstance struct {
	Slot int `json:"slot"`
	// WorktreeName is empty for the main workspace (slot 0).
	WorktreeName string         `json:"worktreeName,omitempty"`
	Color        string         `json:"color,omitempty"`
	Slots        []camberqaSlot `json:"slots"`
}

type camberqaSlot struct {
	Slot int    `json:"slot"`
	ID   string `json:"id"`
	// RemotePort is the slot's remote-access port (portsForSlot().remote).
	RemotePort int `json:"remotePort"`
}

type slotLock struct {
	ID  string `json:"id"`
	PID int    `json:"pid"`
}

// camberqaRemotePort mirrors portsForSlot().remote in worktree/shared.ts.
func camberqaRemotePort(slot int) int {
	return DefaultPort + slot*10
}

// camberqaSlotColor mirrors slotColor in worktree/shared.ts.
func camberqaSlotColor(slot int) string {
	if slot < 1 {
		slot = 1
	}
	return camberqaSlotColors[(slot-1)%len(camberqaSlotColors)]
}

// detectCamberQAInstance reports this helper's camberqa worktree identity,
// or nil when the helper was not launched by `camberqa worktree up` (the
// CAMBER_WORKTREE_ID env is the launch marker; production helpers never
// have it).
func detectCamberQAInstance() *camberqaInstance {
	id := os.Getenv("CAMBER_WORKTREE_ID")
	if id == "" {
		return nil
	}
	slot, _ := strconv.Atoi(os.Getenv("CAMBER_WORKTREE_SLOT"))
	info := &camberqaInstance{
		Slot:  slot,
		Slots: listLiveSlots(camberqaSlotDir),
	}
	if slot >= 1 {
		info.WorktreeName = id
		color := os.Getenv("CAMBERQA_DESKTOP_COLOR")
		if color == "" {
			color = os.Getenv("VITE_CAMBERQA_COLOR")
		}
		if color == "" {
			color = camberqaSlotColor(slot)
		}
		info.Color = color
	}
	return info
}

// listLiveSlots reads the camberqa slot-lock dir and returns slots whose
// owning process is still alive. A missing dir (non-camberqa machine, or no
// worktrees yet) yields an empty list.
func listLiveSlots(dir string) []camberqaSlot {
	slots := []camberqaSlot{}
	for slot := 1; slot <= 8; slot++ {
		data, err := os.ReadFile(filepath.Join(dir, "slot-"+strconv.Itoa(slot)+".lock"))
		if err != nil {
			continue
		}
		var lock slotLock
		if err := json.Unmarshal(data, &lock); err != nil || lock.ID == "" {
			continue
		}
		if !processAlive(lock.PID) {
			continue
		}
		slots = append(slots, camberqaSlot{
			Slot:       slot,
			ID:         lock.ID,
			RemotePort: camberqaRemotePort(slot),
		})
	}
	return slots
}

// processAlive checks pid liveness with signal 0. The slot dir is /tmp, so
// this path only runs on Unix-like systems where signal 0 is supported.
// EPERM means the process exists but belongs to another user — still alive.
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	err = proc.Signal(syscall.Signal(0))
	return err == nil || errors.Is(err, syscall.EPERM)
}
