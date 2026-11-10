//go:build darwin || dragonfly || freebsd || linux || netbsd || openbsd

package acpproxy

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestKillProcessTreeKillsDescendantProcessGroups(t *testing.T) {
	if os.Getenv("ACP_PROXY_PROCESS_TREE_HELPER") == "1" {
		processTreeHelper(t)
		return
	}

	cmd := exec.Command(os.Args[0], "-test.run=TestKillProcessTreeKillsDescendantProcessGroups")
	cmd.Env = append(os.Environ(), "ACP_PROXY_PROCESS_TREE_HELPER=1")
	configureProcessCommand(cmd)

	stdout, err := cmd.StdoutPipe()
	require.NoError(t, err)
	require.NoError(t, cmd.Start())

	scanner := bufio.NewScanner(stdout)
	require.True(t, scanner.Scan())
	childPID, err := strconv.Atoi(strings.TrimSpace(scanner.Text()))
	require.NoError(t, err)
	require.Eventually(t, func() bool {
		return processExists(childPID)
	}, time.Second, 10*time.Millisecond)

	require.NoError(t, killProcessTree(cmd))
	_ = cmd.Wait()
	require.Eventually(t, func() bool {
		return !processExists(childPID)
	}, 2*time.Second, 10*time.Millisecond)
}

// An agent that flushes state when its stdin closes must be allowed to finish
// doing so; a stop that kills immediately is what leaves a `pool acp` session
// unresumable (PE-2460).
func TestStopLetsSubprocessExitOnStdinClose(t *testing.T) {
	shortenExitGraces(t)

	proc, cmd, waited := startStoppableProcess(t, "cat")
	require.NoError(t, proc.stop())

	select {
	case err := <-waited:
		require.NoError(t, err, "subprocess should exit cleanly on stdin close, not be signalled")
	case <-time.After(2 * time.Second):
		t.Fatal("subprocess was not reaped after stop")
	}
	assert.False(t, processExists(cmd.Process.Pid))
}

func TestStopEscalatesForSubprocessThatIgnoresStdinClose(t *testing.T) {
	shortenExitGraces(t)

	// `sleep` never reads stdin, so only a signal ends it.
	proc, cmd, waited := startStoppableProcess(t, "sleep", "500")
	require.NoError(t, proc.stop())

	select {
	case err := <-waited:
		require.Error(t, err, "subprocess should have been signalled")
		var exitErr *exec.ExitError
		require.ErrorAs(t, err, &exitErr)
		status, ok := exitErr.Sys().(syscall.WaitStatus)
		require.True(t, ok)
		assert.Equal(t, syscall.SIGTERM, status.Signal(), "terminate should be enough; kill is the last resort")
	case <-time.After(2 * time.Second):
		t.Fatal("subprocess outlived stop")
	}
	assert.False(t, processExists(cmd.Process.Pid))
}

func shortenExitGraces(t *testing.T) {
	t.Helper()
	stdinGrace, signalGrace := processStdinExitGrace, processSignalExitGrace
	t.Cleanup(func() {
		processStdinExitGrace, processSignalExitGrace = stdinGrace, signalGrace
	})
	processStdinExitGrace = 150 * time.Millisecond
	processSignalExitGrace = 150 * time.Millisecond
}

// startStoppableProcess spawns a real child wired up the way
// spawnAndInitializeLocked does, so stop exercises the true shutdown ladder.
func startStoppableProcess(t *testing.T, name string, args ...string) (*process, *exec.Cmd, <-chan error) {
	t.Helper()
	cmd := exec.Command(name, args...)
	configureProcessCommand(cmd)
	stdin, err := cmd.StdinPipe()
	require.NoError(t, err)
	require.NoError(t, cmd.Start())

	exited := make(chan struct{})
	waited := make(chan error, 1)
	go func() {
		err := cmd.Wait()
		close(exited)
		waited <- err
	}()
	t.Cleanup(func() { _ = killProcessTree(cmd) })

	return &process{
		serverName: "test-agent",
		cmd:        cmd,
		stdin:      stdin,
		exited:     exited,
		state:      processState{kind: processStateRunning},
	}, cmd, waited
}

func processTreeHelper(t *testing.T) {
	child := exec.Command("sleep", "500")
	child.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	require.NoError(t, child.Start())
	fmt.Println(child.Process.Pid)
	_ = child.Wait()
}

func processExists(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
}
