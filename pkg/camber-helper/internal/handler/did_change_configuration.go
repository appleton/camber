package handler

import (
	pkgerrors "github.com/pkg/errors"
	"github.com/tliron/glsp"
	protocol "github.com/tliron/glsp/protocol_3_16"
)

// WorkspaceDidChangeConfiguration is how we hear about configuration changes. Avoid putting
// work that can cause errors or blocking in this method, as it could lead to configurations
// becoming desynchronized between client and server.
func (h *CamberHandler) WorkspaceDidChangeConfiguration(c *glsp.Context, params *protocol.DidChangeConfigurationParams) error {
	if h.config == nil {
		return pkgerrors.New("config not present, should have been set in initialize LSP call")
	}

	h.mx.Lock()
	defer h.mx.Unlock()

	err := updateConfig(params.Settings, h.config)
	if err != nil {
		return err
	}
	if err := h.ensureACPNavStore(c.Context); err != nil {
		return err
	}

	return nil
}
