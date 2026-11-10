package handler

import (
	"testing"

	"github.com/stretchr/testify/require"
	protocol "github.com/tliron/glsp/protocol_3_16"

	"github.com/appleton/camber/pkg/camber-helper/internal/lsptest"
)

// newHandlerInitialized returns a New handler that is then initialized with
// an empty config.
func newHandlerInitialized(t *testing.T) *CamberHandler {
	handler := New()
	_, err := handler.Initialize(lsptest.NewDefaultGLSPTestCtx(t), &protocol.InitializeParams{})
	require.NoError(t, err)
	return handler
}
