package handler

import (
	"context"

	"github.com/tliron/glsp"
)

type HelloIn struct {
	// will be returned in pong
	Ping string `json:"ping" maxLength:"128"`
}
type HelloOut struct {
	Pong string `json:"pong"`
}

func (h *CamberHandler) helloHandler(ctx context.Context, req *HelloIn, req2 *glsp.Context) (*HelloOut, error) {
	return &HelloOut{
		Pong: req.Ping,
	}, nil
}
