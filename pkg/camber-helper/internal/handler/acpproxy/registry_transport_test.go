package acpproxy

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/appleton/camber/pkg/camber-helper/internal/handler/acpregistry"
)

func TestCheckRegistryURL(t *testing.T) {
	tests := []struct {
		name    string
		rawURL  string
		wantErr string
	}{
		{name: "https", rawURL: "https://cdn.example.com/registry.json"},
		{name: "http loopback ip", rawURL: "http://127.0.0.1:8080/registry.json"},
		{name: "http loopback name", rawURL: "http://localhost:8080/registry.json"},
		{name: "http ipv6 loopback", rawURL: "http://[::1]:8080/registry.json"},
		{name: "http public", rawURL: "http://cdn.example.com/registry.json", wantErr: "must use https"},
		{name: "http private", rawURL: "http://10.0.0.5/registry.json", wantErr: "must use https"},
		{name: "file", rawURL: "file:///etc/passwd", wantErr: "unsupported ACP registry URL scheme"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			u, err := url.Parse(tt.rawURL)
			require.NoError(t, err)

			err = checkRegistryURL(u)
			if tt.wantErr == "" {
				assert.NoError(t, err)
				return
			}
			require.Error(t, err)
			assert.ErrorContains(t, err, tt.wantErr)
		})
	}
}

// A registry or CDN compromise must not be able to bounce the download onto a
// cleartext host, where anyone on the path can swap the bytes that get
// executed. The first hop is loopback HTTP (allowed) so that the redirect
// itself, rather than TLS trust in the test harness, is what is under test.
func TestRegistryDownloadRejectsRedirectToCleartext(t *testing.T) {
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://cdn.example.com/agent.tar.gz", http.StatusFound)
	}))
	t.Cleanup(redirect.Close)

	err := downloadAndExtractRegistryBinary(
		context.Background(),
		redirect.URL+"/agent.tar.gz",
		"",
		filepath.Join(t.TempDir(), "root"),
	)
	require.Error(t, err)
	assert.ErrorContains(t, err, "must use https")
}

func TestRegistryDownloadStopsAfterTooManyRedirects(t *testing.T) {
	var server *httptest.Server
	hops := 0
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hops++
		http.Redirect(w, r, server.URL+"/again", http.StatusFound)
	}))
	t.Cleanup(server.Close)

	err := downloadAndExtractRegistryBinary(
		context.Background(),
		server.URL+"/agent.tar.gz",
		"",
		filepath.Join(t.TempDir(), "root"),
	)
	require.Error(t, err)
	assert.ErrorContains(t, err, "too many redirects")
	assert.LessOrEqual(t, hops, registryMaxRedirects+1)
}

// The budget must reject an oversized entry before writing it, otherwise a
// bomb still costs the full limit in disk writes on the way to being refused.
func TestExtractBudgetFailsWithoutWritingWholeLimit(t *testing.T) {
	budget := newExtractBudget()
	budget.remainingBytes = 64 << 10

	var sink countingWriter
	err := budget.copy(&sink, bytes.NewReader(make([]byte, 1<<20)))

	require.Error(t, err)
	assert.ErrorContains(t, err, "expands beyond limit")
	assert.LessOrEqual(t, sink.n, int64(64<<10), "must not write past the budget")
}

func TestExtractBudgetRejectsDeclaredOversize(t *testing.T) {
	budget := newExtractBudget()
	budget.remainingBytes = 1024

	require.NoError(t, budget.declare(1024))
	assert.ErrorContains(t, budget.declare(1025), "expands beyond limit")
}

type countingWriter struct{ n int64 }

func (w *countingWriter) Write(p []byte) (int, error) {
	w.n += int64(len(p))
	return len(p), nil
}

func TestRegistryDownloadRejectsNonHTTPSArchive(t *testing.T) {
	err := downloadAndExtractRegistryBinary(
		context.Background(),
		"http://cdn.example.com/agent.tar.gz",
		"",
		filepath.Join(t.TempDir(), "root"),
	)
	require.Error(t, err)
	assert.ErrorContains(t, err, "must use https")
}

func TestFetchRegistryAgentServerConfigRejectsNonHTTPS(t *testing.T) {
	_, err := fetchRegistryAgentServerConfig(context.Background(), "http://cdn.example.com/registry.json", "example")
	require.Error(t, err)
	assert.ErrorContains(t, err, "must use https")
}

// A gzip stream that is tiny on the wire can unpack to an unbounded amount of
// data, so the archive size limit alone does not bound disk use.
func TestRegistryDownloadRejectsDecompressionBomb(t *testing.T) {
	bomb := tarGzDeclaringSize(t, "agent", registryExtractedMaxBytes+(1<<20))
	t.Logf("compressed bomb is %d bytes, declares %d", len(bomb), int64(registryExtractedMaxBytes)+(1<<20))

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(bomb)
	}))
	t.Cleanup(server.Close)

	err := downloadAndExtractRegistryBinary(
		context.Background(),
		server.URL+"/agent.tar.gz",
		"",
		filepath.Join(t.TempDir(), "root"),
	)
	require.Error(t, err)
	assert.ErrorContains(t, err, "expands beyond limit")
}

func TestRegistryDownloadRejectsTooManyFiles(t *testing.T) {
	archive := tarGzManyFiles(t, registryExtractedMaxFiles+1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(archive)
	}))
	t.Cleanup(server.Close)

	err := downloadAndExtractRegistryBinary(
		context.Background(),
		server.URL+"/agent.tar.gz",
		"",
		filepath.Join(t.TempDir(), "root"),
	)
	require.Error(t, err)
	assert.ErrorContains(t, err, "more than")
}

// Missing checksums stay a warning rather than a hard failure: about half the
// registry's binary agents publish none, so rejecting them would break their
// installs outright.
func TestRegistryDownloadAllowsMissingChecksum(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(tarGz(t, "agent", []byte("#!/bin/sh\n")))
	}))
	t.Cleanup(server.Close)

	target, err := acpregistry.BinaryTarget(runtime.GOOS, runtime.GOARCH)
	require.NoError(t, err)
	t.Setenv("CAMBER_ACP_AGENTS_DIR", t.TempDir())

	binary, _, _, err := PrepareRegistryBinary(context.Background(), "example", map[string]AgentServerBinaryDistribution{
		target: {Archive: server.URL + "/agent.tar.gz", Cmd: "./agent"},
	})
	require.NoError(t, err)
	assert.FileExists(t, binary)
}

// tarGzDeclaringSize writes only the tar header, which is what a decompression
// bomb's victim reads first. The entry body is never produced, so the test
// stays instant while still driving the real extract path -- extraction must
// refuse on the declared size rather than after unpacking gigabytes.
func tarGzDeclaringSize(t *testing.T, name string, size int64) []byte {
	t.Helper()

	// tar.Writer refuses to flush a header whose body was never written, so
	// take just the raw 512-byte header block it emits and stop there.
	var raw bytes.Buffer
	tarWriter := tar.NewWriter(&raw)
	require.NoError(t, tarWriter.WriteHeader(&tar.Header{Name: name, Mode: 0o755, Size: size}))
	require.GreaterOrEqual(t, raw.Len(), 512)

	var buf bytes.Buffer
	gzipWriter := gzip.NewWriter(&buf)
	_, err := gzipWriter.Write(raw.Bytes()[:512])
	require.NoError(t, err)
	require.NoError(t, gzipWriter.Close())
	return buf.Bytes()
}

func tarGzManyFiles(t *testing.T, count int) []byte {
	t.Helper()

	var buf bytes.Buffer
	gzipWriter := gzip.NewWriter(&buf)
	tarWriter := tar.NewWriter(gzipWriter)
	for i := range count {
		require.NoError(t, tarWriter.WriteHeader(&tar.Header{
			Name: fmt.Sprintf("f%d", i),
			Mode: 0o644,
			Size: 0,
		}))
	}
	require.NoError(t, tarWriter.Close())
	require.NoError(t, gzipWriter.Close())
	return buf.Bytes()
}
