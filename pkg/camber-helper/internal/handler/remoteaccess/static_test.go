package remoteaccess

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http/httptest"
	"testing"
	"testing/fstest"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func gzipBytes(t *testing.T, data string) []byte {
	t.Helper()
	var buf bytes.Buffer
	writer := gzip.NewWriter(&buf)
	_, err := writer.Write([]byte(data))
	require.NoError(t, err)
	require.NoError(t, writer.Close())
	return buf.Bytes()
}

// The embedded bundle stores compressible assets gzip-only; a request for the
// plain name must serve them transparently.
func TestSPAFileHandlerServesGzipOnlyAssets(t *testing.T) {
	fsys := fstest.MapFS{
		"index.html.gz":     {Data: gzipBytes(t, "<!doctype html><p>shell")},
		"assets/app.js.gz":  {Data: gzipBytes(t, "console.log('app')")},
		"assets/logo.woff2": {Data: []byte("raw-font-bytes")},
	}
	handler := spaFileHandler(fsys)

	t.Run("gzip-accepting client gets encoded bytes", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/assets/app.js", nil)
		req.Header.Set("Accept-Encoding", "gzip, deflate, br")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		require.Equal(t, 200, rec.Code)
		assert.Equal(t, "gzip", rec.Header().Get("Content-Encoding"))
		assert.Contains(t, rec.Header().Get("Content-Type"), "javascript")
		assert.Equal(t, "Accept-Encoding", rec.Header().Get("Vary"))
		reader, err := gzip.NewReader(rec.Body)
		require.NoError(t, err)
		body, err := io.ReadAll(reader)
		require.NoError(t, err)
		assert.Equal(t, "console.log('app')", string(body))
	})

	t.Run("non-gzip client gets decompressed bytes", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/assets/app.js", nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		require.Equal(t, 200, rec.Code)
		assert.Empty(t, rec.Header().Get("Content-Encoding"))
		assert.Equal(t, "console.log('app')", rec.Body.String())
	})

	t.Run("raw files serve as before", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/assets/logo.woff2", nil)
		req.Header.Set("Accept-Encoding", "gzip")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		require.Equal(t, 200, rec.Code)
		assert.Empty(t, rec.Header().Get("Content-Encoding"))
		assert.Equal(t, "raw-font-bytes", rec.Body.String())
	})

	t.Run("SPA fallback serves gzipped index shell", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/conversations/123", nil)
		req.Header.Set("Accept-Encoding", "gzip")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		require.Equal(t, 200, rec.Code)
		assert.Equal(t, "no-store, must-revalidate", rec.Header().Get("Cache-Control"))
		assert.Contains(t, rec.Header().Get("Content-Type"), "text/html")
		reader, err := gzip.NewReader(rec.Body)
		require.NoError(t, err)
		body, err := io.ReadAll(reader)
		require.NoError(t, err)
		assert.Equal(t, "<!doctype html><p>shell", string(body))
	})

	t.Run("gzip;q=0 is a refusal and gets decompressed bytes", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/assets/app.js", nil)
		req.Header.Set("Accept-Encoding", "gzip;q=0, identity")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		require.Equal(t, 200, rec.Code)
		assert.Empty(t, rec.Header().Get("Content-Encoding"))
		assert.Equal(t, "console.log('app')", rec.Body.String())
	})

	t.Run("wildcard accepts gzip", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/assets/app.js", nil)
		req.Header.Set("Accept-Encoding", "*")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		require.Equal(t, 200, rec.Code)
		assert.Equal(t, "gzip", rec.Header().Get("Content-Encoding"))
	})

	t.Run("explicit gzip refusal beats a wildcard", func(t *testing.T) {
		// RFC 9110: * only matches codings not explicitly listed.
		for _, header := range []string{"gzip;q=0, *", "*;q=0.5, gzip;q=0", "gzip;Q=0"} {
			req := httptest.NewRequest("GET", "/assets/app.js", nil)
			req.Header.Set("Accept-Encoding", header)
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			require.Equal(t, 200, rec.Code, header)
			assert.Empty(t, rec.Header().Get("Content-Encoding"), header)
			assert.Equal(t, "console.log('app')", rec.Body.String(), header)
		}
	})

	t.Run("coding token is case-insensitive", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/assets/app.js", nil)
		req.Header.Set("Accept-Encoding", "GZIP")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		require.Equal(t, 200, rec.Code)
		assert.Equal(t, "gzip", rec.Header().Get("Content-Encoding"))
	})

	t.Run("hashed assets keep immutable caching", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/assets/app.js", nil)
		req.Header.Set("Accept-Encoding", "gzip")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		assert.Equal(t, "public, max-age=31536000, immutable", rec.Header().Get("Cache-Control"))
	})
}
