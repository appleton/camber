package shellenv

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestExtractMarkedEnv(t *testing.T) {
	output := strings.Join([]string{
		"shell startup noise",
		markerStart,
		"PATH=/shell/bin:/usr/bin",
		"VOLTA_HOME=/Users/test/.volta",
		"PWD=/Users/test",
		"SHLVL=2",
		"VALUE_WITH_EQUALS=a=b",
		markerEnd,
		"shell shutdown noise",
	}, "\n")

	env := extractMarkedEnv(output)

	assert.Equal(t, []string{
		"PATH=/shell/bin:/usr/bin",
		"VOLTA_HOME=/Users/test/.volta",
		"VALUE_WITH_EQUALS=a=b",
	}, env)
}

func TestMerge(t *testing.T) {
	t.Run("shell PATH comes before inherited PATH", func(t *testing.T) {
		env := Merge(
			[]string{"PATH=" + pathList("/app/bin", "/usr/bin")},
			[]string{"PATH=" + pathList("/shell/bin", "/usr/bin")},
		)

		assert.Equal(t, pathList("/shell/bin", "/usr/bin", "/app/bin"), envValue(env, "PATH"))
	})

	t.Run("shell values replace inherited values", func(t *testing.T) {
		env := Merge(
			[]string{"PATH=/app/bin", "VOLTA_HOME=/app/volta"},
			[]string{"PATH=/shell/bin", "VOLTA_HOME=/shell/volta", "SHELL_ONLY=value"},
		)

		assert.Equal(t, "/shell/volta", envValue(env, "VOLTA_HOME"))
		assert.Equal(t, "value", envValue(env, "SHELL_ONLY"))
	})

	t.Run("falls back to common tool dirs without shell env", func(t *testing.T) {
		home := t.TempDir()
		localBin := filepath.Join(home, ".local", "bin")
		require.NoError(t, os.MkdirAll(localBin, 0o755))
		t.Setenv("HOME", home)

		env := Merge([]string{"PATH=/usr/bin"}, nil)

		assert.Contains(t, filepath.SplitList(envValue(env, "PATH")), localBin)
	})
}

func TestEnvUpdates(t *testing.T) {
	updates := envUpdates(
		[]string{"SAME=1", "CHANGED=old", "PATH=/usr/bin"},
		[]string{"SAME=1", "CHANGED=new", "PATH=/shell/bin:/usr/bin", "ADDED=x"},
	)

	assert.Equal(t, []string{"CHANGED=new", "PATH=/shell/bin:/usr/bin", "ADDED=x"}, updates)
}

func TestCommonUserToolDirsIncludesVersionManagers(t *testing.T) {
	home := t.TempDir()
	voltaBin := filepath.Join(home, ".volta", "bin")
	cargoBin := filepath.Join(home, ".cargo", "bin")
	require.NoError(t, os.MkdirAll(voltaBin, 0o755))
	require.NoError(t, os.MkdirAll(cargoBin, 0o755))
	t.Setenv("HOME", home)

	dirs := CommonUserToolDirs()

	assert.Contains(t, dirs, voltaBin)
	assert.Contains(t, dirs, cargoBin)
}

func TestNvmDefaultBin(t *testing.T) {
	t.Run("picks the newest installed version", func(t *testing.T) {
		nvmDir := t.TempDir()
		for _, version := range []string{"v18.20.4", "v20.9.0", "v20.11.1", "v9.11.2"} {
			require.NoError(t, os.MkdirAll(filepath.Join(nvmDir, "versions", "node", version, "bin"), 0o755))
		}

		assert.Equal(t,
			filepath.Join(nvmDir, "versions", "node", "v20.11.1", "bin"),
			nvmDefaultBin(nvmDir),
		)
	})

	t.Run("empty without an nvm install", func(t *testing.T) {
		assert.Empty(t, nvmDefaultBin(filepath.Join(t.TempDir(), ".nvm")))
	})
}

func TestPathLooksMinimal(t *testing.T) {
	assert.True(t, pathLooksMinimal("/usr/bin:/bin:/usr/sbin:/sbin"))
	assert.True(t, pathLooksMinimal(""))
	assert.False(t, pathLooksMinimal("/usr/bin:/bin:/opt/homebrew/bin"))
	assert.False(t, pathLooksMinimal("/Users/test/.local/bin:/usr/bin"))
}

func TestIsUsableShell(t *testing.T) {
	shell := filepath.Join(t.TempDir(), "shell")
	require.NoError(t, os.WriteFile(shell, []byte("#!/bin/sh\n"), 0o755))

	assert.True(t, isUsableShell(shell))
	assert.False(t, isUsableShell(""))
	assert.False(t, isUsableShell("zsh"))
	assert.False(t, isUsableShell(filepath.Join(t.TempDir(), "missing")))
	assert.False(t, isUsableShell(t.TempDir()))
}

func TestMergePathLists(t *testing.T) {
	assert.Equal(t,
		pathList("/a", "/b", "/c"),
		MergePathLists(pathList("/a", "/b"), pathList("/b", "/c"), ""),
	)
}

func pathList(dirs ...string) string {
	return strings.Join(dirs, string(os.PathListSeparator))
}
