// Copyright 2020 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

package fake

import (
	protocol2 "github.com/appleton/camber/pkg/camber-helper/gopls/pkg/protocol"
	"github.com/appleton/camber/pkg/camber-helper/internal/gopls/gotoolsinternal/diff"
)

// NewEdit creates an edit replacing all content between the 0-based
// (startLine, startColumn) and (endLine, endColumn) with text.
//
// Columns measure UTF-16 codes.
func NewEdit(startLine, startColumn, endLine, endColumn uint32, text string) protocol2.TextEdit {
	return protocol2.TextEdit{
		Range: protocol2.Range{
			Start: protocol2.Position{Line: startLine, Character: startColumn},
			End:   protocol2.Position{Line: endLine, Character: endColumn},
		},
		NewText: text,
	}
}

// applyEdits applies the edits to a file with the specified lines,
// and returns a new slice containing the lines of the patched file.
// It is a wrapper around diff.Apply; see that function for preconditions.
func applyEdits(mapper *protocol2.Mapper, edits []protocol2.TextEdit, windowsLineEndings bool) ([]byte, error) {
	diffEdits, err := protocol2.EditsToDiffEdits(mapper, edits)
	if err != nil {
		return nil, err
	}
	patched, err := diff.ApplyBytes(mapper.Content, diffEdits)
	if err != nil {
		return nil, err
	}
	if windowsLineEndings {
		patched = toWindowsLineEndings(patched)
	}
	return patched, nil
}
