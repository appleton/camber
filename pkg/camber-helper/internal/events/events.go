package events

import (
	"github.com/appleton/camber/pkg/camber-helper/gopls/pkg/protocol"
)

type TextDocumentDidChange struct {
	URI        protocol.DocumentURI
	NewContent []byte
	OldContent []byte
}
