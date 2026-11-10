package handler

import (
	"context"

	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/camber-helper/internal/lsptypes"
)

func (h *CamberHandler) OnWorkspaceDidCreateFiles(ctx context.Context, params lsptypes.CreateFilesParams, call glsp.CallFunc) {
}
