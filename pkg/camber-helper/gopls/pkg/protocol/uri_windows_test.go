// Copyright 2020 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

//go:build windows

package protocol_test

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/appleton/camber/pkg/camber-helper/gopls/pkg/protocol"
)

// TestURIFromPath tests the conversion between URIs and filenames. The test cases
// include Windows-style URIs and filepaths, but we avoid having OS-specific
// tests by using only forward slashes, assuming that the standard library
// functions filepath.ToSlash and filepath.FromSlash do not need testing.
func TestURIFromPath(t *testing.T) {
	rootPath, err := filepath.Abs("/")
	if err != nil {
		t.Fatal(err)
	}
	if len(rootPath) < 2 || rootPath[1] != ':' {
		t.Fatalf("malformed root path %q", rootPath)
	}
	driveLetter := string(rootPath[0])
	driveLetterLower := strings.ToLower(driveLetter)

	for _, test := range []struct {
		path, wantFile string
		wantURI        protocol.DocumentURI
	}{
		{
			path:     ``,
			wantFile: ``,
			wantURI:  protocol.DocumentURI(""),
		},
		{
			path:     `C:\Windows\System32`,
			wantFile: `c:\Windows\System32`,
			wantURI:  protocol.DocumentURI("file:///c:/Windows/System32"),
		},
		{
			path:     `C:\Go\src\bob.go`,
			wantFile: `c:\Go\src\bob.go`,
			wantURI:  protocol.DocumentURI("file:///c:/Go/src/bob.go"),
		},
		{
			path:     `c:\Go\src\bob.go`,
			wantFile: `c:\Go\src\bob.go`,
			wantURI:  protocol.DocumentURI("file:///c:/Go/src/bob.go"),
		},
		{
			path:     `\path\to\dir`,
			wantFile: driveLetterLower + `:\path\to\dir`,
			wantURI:  protocol.DocumentURI("file:///" + driveLetterLower + ":/path/to/dir"),
		},
		{
			path:     `\a\b\c\src\bob.go`,
			wantFile: driveLetterLower + `:\a\b\c\src\bob.go`,
			wantURI:  protocol.DocumentURI("file:///" + driveLetterLower + ":/a/b/c/src/bob.go"),
		},
		{
			path:     `c:\Go\src\bob george\george\george.go`,
			wantFile: `c:\Go\src\bob george\george\george.go`,
			wantURI:  protocol.DocumentURI("file:///c:/Go/src/bob%20george/george/george.go"),
		},
		{
			path:     `\\server\share\path\to\file.go`,
			wantFile: `\\server\share\path\to\file.go`,
			wantURI:  protocol.DocumentURI("file:////server/share/path/to/file.go"),
		},
	} {
		got := protocol.URIFromPath(test.path)
		if got != test.wantURI {
			t.Errorf("URIFromPath(%q): got %q, expected %q", test.path, got, test.wantURI)
		}
		gotFilename := got.Path()
		if gotFilename != test.wantFile {
			t.Errorf("Filename(%q): got %q, expected %q", got, gotFilename, test.wantFile)
		}
	}
}

func TestParseDocumentURI(t *testing.T) {
	for _, test := range []struct {
		input    string
		want     string // string(DocumentURI) on success or error.Error() on failure
		wantPath string // expected DocumentURI.Path on success
	}{
		{
			input:    `file:///c:/Go/src/bob%20george/george/george.go`,
			want:     "file:///c:/Go/src/bob%20george/george/george.go",
			wantPath: `c:\Go\src\bob george\george\george.go`,
		},
		{
			input:    `file:///C%3A/Go/src/bob%20george/george/george.go`,
			want:     "file:///c:/Go/src/bob%20george/george/george.go",
			wantPath: `c:\Go\src\bob george\george\george.go`,
		},
		{
			input:    `file:///c:/path/to/%25p%25ercent%25/per%25cent.go`,
			want:     `file:///c:/path/to/%25p%25ercent%25/per%25cent.go`,
			wantPath: `c:\path\to\%p%ercent%\per%cent.go`,
		},
		{
			input:    `file:///C%3A/`,
			want:     `file:///c:/`,
			wantPath: `c:\`,
		},
		{
			input:    `file:///`,
			want:     `file:///`,
			wantPath: `\`,
		},
		{
			input:    "",
			want:     "",
			wantPath: "",
		},
		{
			input:    "file:////server/share/path/to/file.go",
			want:     "file:////server/share/path/to/file.go",
			wantPath: "\\\\server\\share\\path\\to\\file.go",
		},
		// Errors:
		{
			input: "https://go.dev/",
			want:  "DocumentURI scheme is not 'file': https://go.dev/",
		},
	} {
		uri, err := protocol.ParseDocumentURI(test.input)
		var got string
		if err != nil {
			got = err.Error()
		} else {
			got = string(uri)
		}
		if got != test.want {
			t.Errorf("ParseDocumentURI(%q): got %q, want %q", test.input, got, test.want)
		}
		if err == nil && uri.Path() != test.wantPath {
			t.Errorf("DocumentURI(%s).Path = %q, want %q", uri,
				uri.Path(), test.wantPath)
		}
	}
}

func TestUNCPathIsAbsolute(t *testing.T) {
	docURI := protocol.DocumentURI("file://server/share/path/to/file.go")
	require.Equal(t, "\\\\server\\share\\path\\to\\file.go", docURI.Path())
	require.True(t, filepath.IsAbs(docURI.Path()))
}
