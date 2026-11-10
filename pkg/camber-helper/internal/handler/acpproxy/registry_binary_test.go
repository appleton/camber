package acpproxy

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/appleton/camber/pkg/camber-helper/internal/handler/acpregistry"
)

func TestPrepareRegistryBinary(t *testing.T) {
	tests := []struct {
		name        string
		archivePath string
		archive     []byte
	}{
		{
			name:        "tar gzip",
			archivePath: "/agent.tar.gz",
			archive:     tarGz(t, "agent", []byte("#!/bin/sh\n")),
		},
		{
			name:        "tar bzip2",
			archivePath: "/agent.tar.bz2",
			archive:     tarBz2(t),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write(tt.archive)
			}))
			t.Cleanup(server.Close)

			target, err := acpregistry.BinaryTarget(runtime.GOOS, runtime.GOARCH)
			require.NoError(t, err)

			cacheHome := t.TempDir()
			t.Setenv("HOME", cacheHome)
			t.Setenv("XDG_CACHE_HOME", cacheHome)
			binary, args, env, err := PrepareRegistryBinary(context.Background(), "example", map[string]AgentServerBinaryDistribution{
				target: {
					Archive: server.URL + tt.archivePath,
					SHA256:  sha256Hex(tt.archive),
					Cmd:     "./agent",
					Args:    []string{"acp"},
					Env:     map[string]string{"EXAMPLE": "1"},
				},
			})
			require.NoError(t, err)

			assert.FileExists(t, binary)
			assert.Equal(t, []string{"acp"}, args)
			assert.Equal(t, map[string]string{"EXAMPLE": "1"}, env)
			assert.NotContains(t, binary, "..")
		})
	}
}

func TestPrepareRegistryBinaryRejectsChecksumMismatch(t *testing.T) {
	archive := tarGz(t, "agent", []byte("#!/bin/sh\n"))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(archive)
	}))
	t.Cleanup(server.Close)

	target, err := acpregistry.BinaryTarget(runtime.GOOS, runtime.GOARCH)
	require.NoError(t, err)
	t.Setenv("CAMBER_ACP_AGENTS_DIR", t.TempDir())
	expected := sha256Hex([]byte("different archive"))
	archiveURL := server.URL + "/agent.tar.gz"

	_, _, _, err = PrepareRegistryBinary(context.Background(), "example", map[string]AgentServerBinaryDistribution{
		target: {
			Archive: archiveURL,
			SHA256:  expected,
			Cmd:     "./agent",
		},
	})
	require.Error(t, err)
	assert.ErrorContains(t, err, "ACP binary checksum mismatch")

	root, rootErr := acpregistry.BinaryInstallRoot("example", archiveURL, expected)
	require.NoError(t, rootErr)
	_, statErr := os.Stat(root)
	assert.True(t, os.IsNotExist(statErr), "mismatched archive must not be extracted")
}

func TestPrepareRegistryBinaryRejectsInvalidChecksumBeforeDownload(t *testing.T) {
	requestCount := 0
	archive := tarGz(t, "agent", []byte("#!/bin/sh\n"))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requestCount++
		_, _ = w.Write(archive)
	}))
	t.Cleanup(server.Close)

	target, err := acpregistry.BinaryTarget(runtime.GOOS, runtime.GOARCH)
	require.NoError(t, err)
	t.Setenv("CAMBER_ACP_AGENTS_DIR", t.TempDir())

	_, _, _, err = PrepareRegistryBinary(context.Background(), "example", map[string]AgentServerBinaryDistribution{
		target: {
			Archive: server.URL + "/agent.tar.gz",
			SHA256:  "not-a-sha256",
			Cmd:     "./agent",
		},
	})
	require.Error(t, err)
	assert.ErrorContains(t, err, "invalid ACP binary SHA-256 checksum")
	assert.Zero(t, requestCount)
}

func TestSafeExtractPathRejectsTraversal(t *testing.T) {
	_, err := safeExtractPath(filepath.Join(os.TempDir(), "dest"), "../escape")
	require.Error(t, err)
}

func tarGz(t *testing.T, name string, body []byte) []byte {
	t.Helper()

	var buf bytes.Buffer
	gzipWriter := gzip.NewWriter(&buf)
	tarWriter := tar.NewWriter(gzipWriter)
	require.NoError(t, tarWriter.WriteHeader(&tar.Header{
		Name: name,
		Mode: 0o755,
		Size: int64(len(body)),
	}))
	_, err := tarWriter.Write(body)
	require.NoError(t, err)
	require.NoError(t, tarWriter.Close())
	require.NoError(t, gzipWriter.Close())
	return buf.Bytes()
}

func tarBz2(t *testing.T) []byte {
	t.Helper()

	// Archive contains one executable file named "agent" with body "#!/bin/sh\n".
	// Generated with Python's tarfile module, then compressed with bz2.compress.
	data, err := base64.StdEncoding.DecodeString("QlpoOTFBWSZTWVsW8EsAAG/7gMqQAEBoAPOAAAhy4R4ACAggAFQ0poyDTQZPITT0gkohiDRoAGmlJ4DUIH1oQjH2UCq6DkCGB20ypKebxOYIIwgzsz5QNc3AGaWqtlXJ15Z33IiA/F3JFOFCQWxbwSw=")
	require.NoError(t, err)
	return data
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
