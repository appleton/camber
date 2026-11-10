// Package webui embeds the built mobile-remote UI bundle so camber-helper can
// serve it directly (a phone has no dev server to proxy through).
//
// The real bundle is produced by `ui/apps/mobile-remote` and copied into
// ./dist by scripts/embed-webui.mjs; only a .gitkeep placeholder is committed,
// so a plain checkout compiles and serves the fallback page until a bundle is
// built in.
package webui

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var embedded embed.FS

// FS returns the embedded bundle rooted at dist, and whether a real build (not
// just the placeholder) is present. Compressible assets are embedded as
// pre-gzipped `<name>.gz` files (scripts/embed-webui.mjs), so the shell may
// exist under either name.
func FS() (fs.FS, bool) {
	sub, err := fs.Sub(embedded, "dist")
	if err != nil {
		return nil, false
	}
	for _, name := range []string{"index.html", "index.html.gz"} {
		if _, err := fs.Stat(sub, name); err == nil {
			return sub, true
		}
	}
	return sub, false
}
