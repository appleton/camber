package remoteaccess

import (
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func (h *testHarness) getFile(path string) *http.Response {
	h.t.Helper()
	return h.get("/api/file?path=" + url.QueryEscape(path))
}

func TestFileRequiresAuth(t *testing.T) {
	h := newHarness(t) // not logged in
	resp := h.getFile("/etc/hosts")
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
	resp.Body.Close()
}

func TestFileServesContents(t *testing.T) {
	h := newHarness(t)
	h.pairAndLogin()

	dir := t.TempDir()
	path := filepath.Join(dir, "main.go")
	require.NoError(t, os.WriteFile(path, []byte("package main\n"), 0o600))

	resp := h.getFile(path)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	assert.Equal(t, "package main\n", string(body))
	assert.Equal(t, "no-store", resp.Header.Get("Cache-Control"))
}

func TestFileServesImageContentType(t *testing.T) {
	h := newHarness(t)
	h.pairAndLogin()

	// Minimal valid PNG header; enough for the extension-based content type.
	png := []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}
	path := filepath.Join(t.TempDir(), "shot.png")
	require.NoError(t, os.WriteFile(path, png, 0o600))

	resp := h.getFile(path)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, "image/png", resp.Header.Get("Content-Type"))
}

func TestFileHeadBacksExistenceChecks(t *testing.T) {
	h := newHarness(t)
	h.pairAndLogin()

	path := filepath.Join(t.TempDir(), "exists.txt")
	require.NoError(t, os.WriteFile(path, []byte("x"), 0o600))

	resp, err := h.client.Head(h.http.URL + "/api/file?path=" + url.QueryEscape(path))
	require.NoError(t, err)
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	resp.Body.Close()

	resp, err = h.client.Head(h.http.URL + "/api/file?path=" + url.QueryEscape(filepath.Join(t.TempDir(), "missing.txt")))
	require.NoError(t, err)
	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
	resp.Body.Close()
}

func TestFileRejectsBadPaths(t *testing.T) {
	h := newHarness(t)
	h.pairAndLogin()

	// Relative paths are rejected outright.
	resp := h.getFile("relative/path.txt")
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
	resp.Body.Close()

	// Missing files and directories both read as not found.
	resp = h.getFile(filepath.Join(t.TempDir(), "nope.txt"))
	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
	resp.Body.Close()

	resp = h.getFile(t.TempDir())
	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
	resp.Body.Close()
}

func TestFileRejectsOversizedFiles(t *testing.T) {
	h := newHarness(t)
	h.pairAndLogin()

	path := filepath.Join(t.TempDir(), "big.bin")
	f, err := os.Create(path)
	require.NoError(t, err)
	require.NoError(t, f.Truncate(maxServedFileBytes+1))
	require.NoError(t, f.Close())

	resp := h.getFile(path)
	assert.Equal(t, http.StatusRequestEntityTooLarge, resp.StatusCode)
	resp.Body.Close()
}
