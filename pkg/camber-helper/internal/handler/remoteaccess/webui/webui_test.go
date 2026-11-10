package webui

import (
	"io/fs"
	"testing"
)

// TestEmbeddedBundleServable verifies the FS helper resolves. When a real
// bundle has been embedded (via scripts/embed-webui.mjs), the app shell is
// present — as index.html.gz since the embed step gzips compressible assets
// — and FS reports built=true; a bare checkout reports built=false.
func TestEmbeddedBundleServable(t *testing.T) {
	fsys, built := FS()
	if fsys == nil {
		t.Fatal("FS() returned a nil filesystem")
	}
	if !built {
		return
	}
	for _, name := range []string{"index.html", "index.html.gz"} {
		if _, err := fs.Stat(fsys, name); err == nil {
			return
		}
	}
	t.Fatal("FS() reported built=true but no index.html or index.html.gz is present")
}
