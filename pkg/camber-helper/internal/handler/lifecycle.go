package handler

import (
	"log/slog"
	"os"

	"github.com/tliron/glsp"
)

// The shutdown request is sent from the client to the server. It asks the server to shut down, but to not exit
// (otherwise the response might not be delivered correctly to the client).
// https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#shutdown
func (h *CamberHandler) shutdown(context *glsp.Context) error {
	h.receivedShutdown.Store(true)

	for _, closable := range h.cleanupFns {
		if err := closable(); err != nil {
			slog.Error("cleanup function errored", "err", err)
		}
	}

	return nil
}

// "A notification to ask the server to exit its process. The server should exit with success code 0
// if the shutdown request has been received before; otherwise with error code 1."
// https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#exit
func (h *CamberHandler) exit(c *glsp.Context) error {
	if !h.receivedShutdown.Load() {
		osExit(1)
		return nil
	}

	osExit(0)
	return nil
}

var osExit = os.Exit
