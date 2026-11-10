package remoteaccess

import (
	"net/http"
	"os"
	"path/filepath"
)

// maxServedFileBytes bounds /api/file responses; the mobile viewer previews
// source files and images, it is not a download surface.
const maxServedFileBytes = 20 << 20

// handleFile serves the raw bytes of a file on this machine to an
// authenticated device, backing the mobile file viewer and image previews
// (host RPCs getFileContents/getImageFileData, which desktop and VS Code
// answer natively). A GET route also answers HEAD, which backs
// checkFileExists. Access is session-gated but not path-restricted: a paired
// device already runs terminals and agents through the WebSocket, so a file
// read grants nothing new.
func (s *Server) handleFile(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.sessionDevice(r); !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "authentication required"})
		return
	}
	path := r.URL.Query().Get("path")
	if !filepath.IsAbs(path) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "path must be absolute"})
		return
	}
	file, err := os.Open(filepath.Clean(path))
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "file not found"})
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || info.IsDir() {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "file not found"})
		return
	}
	if info.Size() > maxServedFileBytes {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "file too large to preview"})
		return
	}
	// The file can change on disk at any time; never let the browser cache it.
	w.Header().Set("Cache-Control", "no-store")
	// ServeContent resolves Content-Type from the extension, sniffing the
	// first bytes when the extension is unknown.
	http.ServeContent(w, r, info.Name(), info.ModTime(), file)
}
