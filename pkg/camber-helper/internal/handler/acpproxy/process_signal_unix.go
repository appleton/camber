//go:build darwin || dragonfly || freebsd || linux || netbsd || openbsd

package acpproxy

import (
	"bytes"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

func configureProcessCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func killProcessTree(cmd *exec.Cmd) error {
	return signalProcessTree(cmd, syscall.SIGKILL)
}

// terminateProcessTree asks the subprocess tree to exit, giving agents that
// persist state on shutdown a chance to flush before killProcessTree follows.
func terminateProcessTree(cmd *exec.Cmd) error {
	return signalProcessTree(cmd, syscall.SIGTERM)
}

func signalProcessTree(cmd *exec.Cmd, sig syscall.Signal) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	pids := append([]int{cmd.Process.Pid}, descendantPIDs(cmd.Process.Pid)...)
	pgids := make(map[int]struct{}, len(pids))
	for _, pid := range pids {
		pgid, err := syscall.Getpgid(pid)
		if err != nil {
			continue
		}
		pgids[pgid] = struct{}{}
	}

	var signalErr error
	for pgid := range pgids {
		if err := syscall.Kill(-pgid, sig); err != nil && err != syscall.ESRCH {
			signalErr = err
		}
	}
	for _, pid := range pids {
		if err := syscall.Kill(pid, sig); err != nil && err != syscall.ESRCH {
			signalErr = err
		}
	}
	return signalErr
}

func descendantPIDs(rootPID int) []int {
	out, err := exec.Command("ps", "-ax", "-o", "pid=", "-o", "ppid=").Output()
	if err != nil {
		return nil
	}
	children := map[int][]int{}
	for _, line := range bytes.Split(out, []byte{'\n'}) {
		fields := strings.Fields(string(line))
		if len(fields) != 2 {
			continue
		}
		pid, err := strconv.Atoi(fields[0])
		if err != nil {
			continue
		}
		ppid, err := strconv.Atoi(fields[1])
		if err != nil {
			continue
		}
		children[ppid] = append(children[ppid], pid)
	}

	var descendants []int
	stack := append([]int(nil), children[rootPID]...)
	for len(stack) > 0 {
		pid := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		descendants = append(descendants, pid)
		stack = append(stack, children[pid]...)
	}
	return descendants
}
