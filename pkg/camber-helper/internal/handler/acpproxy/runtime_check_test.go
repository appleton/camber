package acpproxy

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLookupExecutable(t *testing.T) {
	t.Run("finds an executable on PATH", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "camber-test-runtime")
		require.NoError(t, os.WriteFile(path, []byte("#!/bin/sh\n"), 0o755))

		resolved, found := lookupExecutable("camber-test-runtime", []string{"PATH=" + dir})
		require.True(t, found)
		assert.Equal(t, path, resolved)
	})

	t.Run("reports a missing executable", func(t *testing.T) {
		_, found := lookupExecutable("camber-test-runtime", []string{"PATH=" + t.TempDir()})
		assert.False(t, found)
	})

	t.Run("reports an empty name as missing", func(t *testing.T) {
		_, found := lookupExecutable("", []string{"PATH=" + t.TempDir()})
		assert.False(t, found)
	})

	t.Run("converts npx launch failures into a user-facing runtime error", func(t *testing.T) {
		lookupErr := errors.New("executable file not found in $PATH")

		err := missingRuntimeLaunchError("codex-acp", "npx", lookupErr)

		var runtimeErr *MissingRuntimeError
		require.ErrorAs(t, err, &runtimeErr)
		assert.Equal(t, "codex-acp", runtimeErr.AgentServer)
		assert.Equal(t,
			"This agent runs through npx, which was not found on this machine. Install Node.js to use this agent.",
			runtimeErr.Error())
		assert.ErrorIs(t, err, lookupErr)
	})

	t.Run("names uv for uvx launch failures", func(t *testing.T) {
		err := missingRuntimeLaunchError("fast-agent", "uvx", errors.New("not found"))

		var runtimeErr *MissingRuntimeError
		require.ErrorAs(t, err, &runtimeErr)
		assert.Contains(t, runtimeErr.Error(), "Install uv to use this agent.")
	})

	t.Run("leaves other launcher failures unchanged", func(t *testing.T) {
		lookupErr := errors.New("not found")
		assert.Equal(t, lookupErr, missingRuntimeLaunchError("custom", "my-agent", lookupErr))
	})

	t.Run("uses the shell-merged environment", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("shellenv does not merge the provider environment on windows")
		}
		dir := t.TempDir()
		path := filepath.Join(dir, "camber-test-shell-runtime")
		require.NoError(t, os.WriteFile(path, []byte("#!/bin/sh\n"), 0o755))
		withUserShellEnvProvider(t, func() []string { return []string{"PATH=" + dir} })

		resolved, found := LookupExecutable("camber-test-shell-runtime")
		require.True(t, found)
		assert.Equal(t, path, resolved)
	})
}
