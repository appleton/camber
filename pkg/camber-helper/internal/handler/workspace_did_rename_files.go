package handler

import (
	"context"

	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/camber-helper/internal/lsptypes"
)

func (h *CamberHandler) OnWorkspaceDidRenameFiles(ctx context.Context, params lsptypes.RenameFilesParams, call glsp.CallFunc) {
}
