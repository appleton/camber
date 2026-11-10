package server

import (
	"github.com/tliron/glsp/server"

	"github.com/appleton/camber/pkg/camber-helper/internal/handler"
	"github.com/appleton/camber/pkg/camber-helper/internal/shellenv"
)

func NewDefault() (*server.Server, *handler.CamberHandler) {
	// GUI launch contexts (Finder on macOS) hand the helper a minimal
	// environment; repair it before handlers that shell out are constructed
	// so gh, MCP server commands, etc. resolve like they do from a terminal.
	shellenv.ApplyToProcess()
	return New(handler.New())
}

func New(h *handler.CamberHandler) (*server.Server, *handler.CamberHandler) {
	options := server.NewServerOptions(h.IsConcurrentMethod)
	return server.NewServerWithOptions(h, "camber Helper", false, options), h
}
