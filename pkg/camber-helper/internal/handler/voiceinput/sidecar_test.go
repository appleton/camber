package voiceinput

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func writeExecutable(t *testing.T, dir, name string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	require.NoError(t, os.WriteFile(path, []byte("#!/bin/sh\n"), 0o755))
	return path
}

func TestWhisperServerInDirPrefersPlainName(t *testing.T) {
	dir := t.TempDir()
	writeExecutable(t, dir, "camber-whisper-server-darwin-arm64")
	want := writeExecutable(t, dir, "camber-whisper-server")

	got, ok := whisperServerInDir(dir)
	require.True(t, ok)
	assert.Equal(t, want, got)
}

func TestWhisperServerInDirFindsCurrentTargetSuffix(t *testing.T) {
	suffix := currentHelperTargetSuffix()
	require.NotEmpty(t, suffix)

	dir := t.TempDir()
	want := writeExecutable(t, dir, "camber-whisper-server-"+suffix)

	got, ok := whisperServerInDir(dir)
	require.True(t, ok)
	assert.Equal(t, want, got)
}

func TestWhisperServerInDirFindsAnySuffixedSibling(t *testing.T) {
	// Desktop dev runs the helper from src-tauri/binaries, where externalBin
	// names carry Rust target triples rather than helper release suffixes.
	dir := t.TempDir()
	want := writeExecutable(t, dir, "camber-whisper-server-aarch64-apple-darwin")

	got, ok := whisperServerInDir(dir)
	require.True(t, ok)
	assert.Equal(t, want, got)
}

func TestWhisperServerInDirSkipsPlaceholdersAndMetadata(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("relies on the unix executable bit")
	}
	dir := t.TempDir()
	// Empty executable: the placeholder copy-helper.mjs installs on
	// unsupported targets.
	require.NoError(t, os.WriteFile(filepath.Join(dir, "camber-whisper-server"), nil, 0o755))
	// Non-executable metadata written next to desktop dev binaries.
	require.NoError(t, os.WriteFile(
		filepath.Join(dir, "camber-whisper-server-aarch64-apple-darwin.version"),
		[]byte("local\n"), 0o644))

	_, ok := whisperServerInDir(dir)
	assert.False(t, ok)
}

func TestWhisperServerInDirSkipsMetadataByName(t *testing.T) {
	// The name filter must reject metadata regardless of file mode: Windows
	// has no executable bit, and a *.version file can carry one elsewhere.
	dir := t.TempDir()
	writeExecutable(t, dir, "camber-whisper-server-aarch64-apple-darwin.version")

	_, ok := whisperServerInDir(dir)
	assert.False(t, ok)
}

func TestWhisperServerInDirEmpty(t *testing.T) {
	_, ok := whisperServerInDir(t.TempDir())
	assert.False(t, ok)
}

func TestWhisperServerPathWalksToCheckoutBinaries(t *testing.T) {
	// Development runs the helper with `go run` from the repo root, so the
	// desktop app's downloaded binaries are found relative to the working
	// directory rather than the executable.
	root := t.TempDir()
	binaries := filepath.Join(root, "ui", "apps", "desktop-assistant", "src-tauri", "binaries")
	require.NoError(t, os.MkdirAll(binaries, 0o755))
	want := writeExecutable(t, binaries, "camber-whisper-server-aarch64-apple-darwin")

	nested := filepath.Join(root, "pkg", "camber-helper")
	require.NoError(t, os.MkdirAll(nested, 0o755))
	t.Chdir(nested)
	t.Setenv(whisperServerPathEnv, "")
	t.Setenv("PATH", root)

	got, ok := whisperServerPath()
	require.True(t, ok)
	assert.Equal(t, want, got)
}

func TestUnexpectedSidecarExitError(t *testing.T) {
	exitErr := errors.New("exit status 1")
	assert.ErrorIs(t, unexpectedSidecarExitError(true, exitErr), exitErr)
	assert.EqualError(t, unexpectedSidecarExitError(true, nil),
		"voice input: whisper-server exited unexpectedly with status 0")
	assert.NoError(t, unexpectedSidecarExitError(false, nil),
		"detached helper-initiated shutdowns must not be reported")
}
