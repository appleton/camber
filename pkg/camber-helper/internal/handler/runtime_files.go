package handler

import (
	"context"

	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

func (h *CamberHandler) runtimeFiles(ctx context.Context, req *methods.RuntimeFilesParams, gCtx *glsp.Context) (*methods.RuntimeFilesOutput, error) {
	return &methods.RuntimeFilesOutput{
		Files: []methods.RuntimeFiles{},
	}, nil
}
