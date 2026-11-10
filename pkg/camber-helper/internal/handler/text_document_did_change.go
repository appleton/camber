package handler

import (
	"context"

	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/camber-helper/internal/events"
)

func (h *CamberHandler) OnTextDocumentDidChange(ctx context.Context, event events.TextDocumentDidChange, call glsp.CallFunc) {
}
