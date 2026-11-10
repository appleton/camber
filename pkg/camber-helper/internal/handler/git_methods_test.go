package handler

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/appleton/camber/pkg/camber-helper/internal/lsptest"
	"github.com/appleton/camber/pkg/camber-helper/methods"
)

// TestGitMethodsSchemaValidation drives the camber/git/* methods through the
// full Handle path with schema validation enabled (development env), using the
// exact JSON payloads the Changes panel sends. This is a regression test: the
// panel omits optional fields (e.g. stash "message"), and required-by-schema
// fields made those requests fail validation before reaching the handler.
func TestGitMethodsSchemaValidation(t *testing.T) {
	dir := t.TempDir()
	gitT(t, dir, "init", "--initial-branch=main")
	gitT(t, dir, "config", "user.email", "test@example.com")
	gitT(t, dir, "config", "user.name", "Test")
	require.NoError(t, os.WriteFile(filepath.Join(dir, "tracked.txt"), []byte("one\n"), 0o644))
	gitT(t, dir, "add", ".")
	gitT(t, dir, "commit", "-m", "initial")

	h := New()
	h.config = &Config{AssistantEnvironment: string(methods.DevelopmentEnv)}
	h.SetInitialized(true)

	call := func(t *testing.T, method string, params any) (any, error) {
		t.Helper()
		result, validMethod, validParams, err := h.Handle(
			lsptest.NewGLSPTestCtxForMethod(t, method, mustJSON(t, params)),
		)
		assert.True(t, validMethod)
		assert.True(t, validParams)
		return result, err
	}

	t.Run("status", func(t *testing.T) {
		_, err := call(t, methods.GitStatusMethod, map[string]any{"path": dir})
		require.NoError(t, err)
	})

	t.Run("diffFile without optional flags", func(t *testing.T) {
		require.NoError(t, os.WriteFile(filepath.Join(dir, "tracked.txt"), []byte("changed\n"), 0o644))
		_, err := call(t, methods.GitDiffFileMethod, map[string]any{
			"path": dir,
			"file": "tracked.txt",
		})
		require.NoError(t, err)
	})

	t.Run("discard with only untrackedFiles", func(t *testing.T) {
		require.NoError(t, os.WriteFile(filepath.Join(dir, "new.txt"), []byte("hello\n"), 0o644))
		// The panel omits the empty list rather than sending files: [].
		_, err := call(t, methods.GitDiscardMethod, map[string]any{
			"path":           dir,
			"untrackedFiles": []string{"new.txt"},
		})
		require.NoError(t, err)
		assert.NoFileExists(t, filepath.Join(dir, "new.txt"))
	})

	t.Run("stage and commit", func(t *testing.T) {
		_, err := call(t, methods.GitStageMethod, map[string]any{
			"path":  dir,
			"files": []string{"tracked.txt"},
		})
		require.NoError(t, err)
		_, err = call(t, methods.GitCommitMethod, map[string]any{
			"path":    dir,
			"message": "update",
		})
		require.NoError(t, err)
	})
}

func gitT(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	require.NoError(t, err, "git %v: %s", args, out)
}
