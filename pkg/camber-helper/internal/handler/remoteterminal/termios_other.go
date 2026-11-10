//go:build !darwin && !linux

package remoteterminal

import (
	"os"
	"time"
)

// waitForRawMode is a no-op where PTY termios cannot be inspected; the
// clear byte is sent immediately, matching the previous behavior.
func waitForRawMode(_ *os.File, _ time.Duration) {}
