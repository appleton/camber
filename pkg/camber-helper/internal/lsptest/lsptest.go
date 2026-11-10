package lsptest

import (
	"context"
	"encoding/json"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sourcegraph/jsonrpc2"
	"github.com/tliron/glsp"
)

// NewDefaultGLSPTestCtx creates a new glsp.Context with default values for testing,
// will log notify/calls, set a req ID, and timeout with 30 seconds
func NewDefaultGLSPTestCtx(t *testing.T) *glsp.Context {
	// allow test with race
	requestID := reqID.Add(1)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second*30)
	t.Cleanup(cancel)
	return &glsp.Context{
		Notify: func(ctx context.Context, method string, params any) error {
			t.Logf("lsp.Notify %v: %+v", method, params)
			return nil
		},
		Call: func(ctx context.Context, method string, params any, result any) error {
			t.Logf("lsp.Call %v: %+v", method, params)
			return nil
		},
		RequestID: jsonrpc2.ID{
			Num: requestID,
		},
		Context: ctx,
	}
}

func NewGLSPTestCtxForMethod(t *testing.T, method string, params json.RawMessage) *glsp.Context {
	gCtx := NewDefaultGLSPTestCtx(t)
	gCtx.Params = params
	gCtx.Method = method
	return gCtx
}

func NewGLSPTestCtxForMethodWithRequestID(t *testing.T, method string, params json.RawMessage, reqID int) *glsp.Context {
	gCtx := NewDefaultGLSPTestCtx(t)
	gCtx.Params = params
	gCtx.Method = method
	gCtx.RequestID = jsonrpc2.ID{Num: uint64(reqID)}
	return gCtx
}

var reqID atomic.Uint64
