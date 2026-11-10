package handler

import (
	"context"

	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/camber-helper/methods"
	"github.com/appleton/camber/pkg/common/future"
)

func (h *CamberHandler) Abort(ctx context.Context, params *methods.AbortParams, gCtx *glsp.Context) (*methods.AbortOutput, error) {
	h.mx.Lock()
	toRun := h.abortListeners[params.OperationID]
	delete(h.abortListeners, params.OperationID)
	h.mx.Unlock()

	for _, f := range toRun {
		f()
	}

	return &methods.AbortOutput{}, nil
}

// raceFreeOnAbort can be used with async code to ensure that OnAbort calls that
// happen after aborts are still invoked.
func (h *CamberHandler) raceFreeOnAbort(alreadyAborted *future.RWFuture[struct{}]) func(id string, fn func()) {
	return func(id string, fn func()) {
		// hold the lock to ensure we can't have the abort come in between
		// checking the future and registering the handler
		h.mx.Lock()
		defer h.mx.Unlock()

		_, ok := alreadyAborted.TryGet()
		if ok {
			// always do this async, as original abort is async with listener
			go fn()
			return
		}
		h.onAbortLocked(id, fn)
	}
}

func (h *CamberHandler) onAbort(id string, f func()) {
	h.mx.Lock()
	defer h.mx.Unlock()

	h.onAbortLocked(id, f)
}

// ONLY call from routine that holds lock
func (h *CamberHandler) onAbortLocked(id string, f func()) {
	h.abortListeners[id] = append(h.abortListeners[id], f)
}
