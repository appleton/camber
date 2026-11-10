//go:build !(darwin || dragonfly || freebsd || linux || netbsd || openbsd)

package acpproxy

import "os/exec"

func configureProcessCommand(_ *exec.Cmd) {}

func killProcessTree(cmd *exec.Cmd) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	return cmd.Process.Kill()
}

// terminateProcessTree has no gentler equivalent on these platforms, so it
// kills. Callers still close stdin and wait first, which is what lets an agent
// shut down on its own terms.
func terminateProcessTree(cmd *exec.Cmd) error {
	return killProcessTree(cmd)
}
