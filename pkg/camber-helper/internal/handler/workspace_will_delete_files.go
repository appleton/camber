package handler

import (
	"context"

	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/camber-helper/internal/lsptypes"
)

func (h *CamberHandler) OnWorkspaceWillDeleteFiles(ctx context.Context, params lsptypes.DeleteFilesParams, call glsp.CallFunc) {
}
