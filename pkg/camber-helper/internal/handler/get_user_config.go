package handler

import (
	"context"

	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

// GetUserConfig retrieves the current user configuration
func (h *CamberHandler) GetUserConfig(
	ctx context.Context, params *methods.GetUserConfigParams, gCtx *glsp.Context,
) (*methods.GetUserConfigOutput, error) {
	return &methods.GetUserConfigOutput{
		SettingsFilePaths: []string{},
	}, nil
}
