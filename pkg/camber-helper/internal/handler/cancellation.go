package handler

import (
	"context"
	"errors"
	"log/slog"

	"github.com/sourcegraph/jsonrpc2"
	"github.com/tliron/glsp"
	protocol "github.com/tliron/glsp/protocol_3_16"
)

// if in flight, cancelInFlight will be non-nil
type cancelState struct {
	cancelInFlight context.CancelFunc
	// requested is set to true when a $/cancelRequest is received
	requested bool
}

// implements request cancellation:
//   - for in-flight requests: we cancel the context of the request from cancelFn stored in map
//   - for unstarted requests: we store that cancellation was requested, and if request comes in later we'll return
//     immediately before invoking the method handler
func (h *CamberHandler) cancelRequest(c *glsp.Context, params *protocol.CancelParams) error {
	// annoyingly, glsp decides to use a slightly different type for ID and CancelParams.ID. Use same type here for clarity
	reqID, err := cancelToRequestID(params)
	if err != nil {
		return err
	}

	rid := reqID.String()
	h.mx.Lock()
	defer h.mx.Unlock()

	state, ok := h.requestCancelByID[rid]
	// would only be present if in flight
	if ok {
		// only reason we need this guard is if we receive dupe cancels,
		// and the branch below has run before we get back here
		if state.cancelInFlight != nil {
			state.cancelInFlight()
		}
		delete(h.requestCancelByID, rid)
	} else {
		h.requestCancelByID[rid] = cancelState{
			requested: true,
		}
	}

	slog.Info("$/cancelRequest received", "jsonrpc_request_id", reqID.String(),
		"cancelled_in_flight", ok && state.cancelInFlight != nil)

	return nil
}

func cancelToRequestID(params *protocol.CancelParams) (jsonrpc2.ID, error) {
	switch v := (params.ID.Value).(type) {
	case string:
		return jsonrpc2.ID{
			Str:      v,
			IsString: true,
		}, nil
	case protocol.Integer:
		return jsonrpc2.ID{
			// fits, v is a uint32
			Num: uint64(v),
		}, nil
	default:
		return jsonrpc2.ID{}, errors.New("invalid id type")
	}
}

// called in request handlers, ensuring concurrent cancellation works
func (h *CamberHandler) addInFlightRequest(ID jsonrpc2.ID, cancelFn context.CancelFunc) (cleanup func(), alreadyCancelled bool) {
	h.mx.Lock()
	defer h.mx.Unlock()

	st := h.requestCancelByID[ID.String()]
	if st.requested {
		// handle case earlier or concurrent $/cancelRequest
		cancelFn()
	} else {
		// prepare the cancellation for later calls
		h.requestCancelByID[ID.String()] = cancelState{
			cancelInFlight: cancelFn,
		}
	}

	return func() {
		h.mx.Lock()
		delete(h.requestCancelByID, ID.String())
		h.mx.Unlock()
	}, st.requested
}
