//go:build darwin || linux

package remoteterminal

import (
	"os"
	"syscall"
	"time"
	"unsafe"
)

// waitForRawMode blocks (bounded) until the PTY behind ptmx has left
// canonical mode — i.e. the shell's line editor (zle/readline) is active and
// a written control byte is interpreted rather than caret-echoed. A freshly
// spawned shell keeps the PTY in canonical mode with echo until its rc files
// finish, so a Ctrl+L sent during that window paints a literal `^L`. Returns
// on raw mode, on error (fd closed: terminal deleted), or on timeout; the
// timeout fallthrough degrades to the old, briefly visible behavior.
//
// Polling is the only option: nothing on the master side can be waited on for
// "the slave's termios changed", and the ioctl is cheap.
func waitForRawMode(ptmx *os.File, timeout time.Duration) {
	const pollInterval = 25 * time.Millisecond
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		canonical, err := inCanonicalMode(ptmx)
		if err != nil || !canonical {
			return
		}
		time.Sleep(pollInterval)
	}
}

// inCanonicalMode reports whether the tty's ICANON local flag is set. The
// master and slave ends of a PTY share one termios, so inspecting the master
// observes the mode the shell configured on the slave.
func inCanonicalMode(ptmx *os.File) (bool, error) {
	conn, err := ptmx.SyscallConn()
	if err != nil {
		return false, err
	}
	var termios syscall.Termios
	var errno syscall.Errno
	if err := conn.Control(func(fd uintptr) {
		_, _, errno = syscall.Syscall(
			syscall.SYS_IOCTL,
			fd,
			uintptr(ioctlReadTermios),
			uintptr(unsafe.Pointer(&termios)),
		)
	}); err != nil {
		return false, err
	}
	if errno != 0 {
		return false, errno
	}
	return termios.Lflag&syscall.ICANON != 0, nil
}
