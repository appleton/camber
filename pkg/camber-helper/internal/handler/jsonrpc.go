package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	pkgerrors "github.com/pkg/errors"
	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/camber-helper/internal/gopls/gotoolsinternal/jsonrpc2"
	"github.com/appleton/camber/pkg/camber-helper/methods"
)

// JSONRPCOperation captures metadata for a single JSONRPC method.
type JSONRPCOperation struct {
	// Summary is a short summary of what the operation does.
	Summary string
	// Description is a verbose explanation of the operation behavior. CommonMark
	// syntax MAY be used for rich text representation.
	Description string
	// The JSON-RPC method, e.g. "camber/foo"
	Method string
}

// registers an LSP method. This is instead of the glsp built in handlers,
// as we don't want to use glsp's protocol types (they don't
// handle VSCode's weird encoding. gopls's types do)
func registerLSPMethod[In any, Out any](
	h *CamberHandler,
	operation JSONRPCOperation,
	handler func(ctx context.Context, req *In, lspReq *glsp.Context) (Out, error),
) {
	registerJSONRPCMethod(h, operation, handler)
}

// Registers a concurrent RPC method. This method will not be blocked by LSP requests.
func registerExtensionMethod[In any, Out any](
	h *CamberHandler,
	operation JSONRPCOperation,
	handler func(ctx context.Context, req *In, lspReq *glsp.Context) (Out, error),
) {
	registerJSONRPCMethod(h, operation, handler)
	h.concurrentMethods[operation.Method] = struct{}{}
}

func registerExtensionMethodNoDeadline[In any, Out any](
	h *CamberHandler,
	operation JSONRPCOperation,
	handler func(ctx context.Context, req *In, lspReq *glsp.Context) (Out, error),
) {
	registerJSONRPCMethod(h, operation, handler)
	h.concurrentMethods[operation.Method] = struct{}{}
	h.noDeadlineMethods[operation.Method] = struct{}{}
}

// Like registerExtensionMethod but skips huma schema registration/validation.
func registerExtensionMethodUntyped[In any, Out any](
	h *CamberHandler,
	operation JSONRPCOperation,
	handler func(ctx context.Context, req *In, lspReq *glsp.Context) (Out, error),
) {
	registerSerializedJSONRPCUnvalidated(h, operation, handler)
}

// Like registerExtensionMethodUntyped but marks the method as safe to run concurrently.
func registerUnserializedExtensionMethodUntyped[In any, Out any](
	h *CamberHandler,
	operation JSONRPCOperation,
	handler func(ctx context.Context, req *In, lspReq *glsp.Context) (Out, error),
) {
	registerSerializedJSONRPCUnvalidated(h, operation, handler)
	h.concurrentMethods[operation.Method] = struct{}{}
}

// Like registerUnserializedExtensionMethodUntyped, but leaves the request uncapped so long-running operations can
// manage their own lifetime and still be cancelled explicitly by the client.
func registerUnserializedExtensionMethodUntypedNoDeadline[In any, Out any](
	h *CamberHandler,
	operation JSONRPCOperation,
	handler func(ctx context.Context, req *In, lspReq *glsp.Context) (Out, error),
) {
	registerSerializedJSONRPCUnvalidated(h, operation, handler)
	h.concurrentMethods[operation.Method] = struct{}{}
	h.noDeadlineMethods[operation.Method] = struct{}{}
}

// publishClientSideTypes is used to publish the types for client-side jsonrpc methods
// and notifications over openapi, so we can generate bindings for them.
func publishClientSideTypes[In any](
	handler *CamberHandler,
	method string,
	_ In,
	description string,
) {
	registerJSONRPCMethod(handler, JSONRPCOperation{
		Summary:     fmt.Sprintf("%s (client side)", method),
		Description: description,
		Method:      method,
	}, func(ctx context.Context, req *In, lspReq *glsp.Context) (any, error) {
		return nil, errors.New("invalid - client called a server -> client method or notification")
	})
}

func registerSerializedJSONRPCUnvalidated[In any, Out any](
	h *CamberHandler,
	operation JSONRPCOperation,
	handler func(ctx context.Context, req *In, lspReq *glsp.Context) (Out, error),
) {
	h.extensionHandlers[operation.Method] = func(ctx context.Context, lspReq *glsp.Context) (any, error) {
		typed, err := decodeJSONRPCInput[In](lspReq.Params)
		if err != nil {
			return nil, err
		}

		result, err := handler(ctx, typed, lspReq)
		return result, errorToWire(err)
	}
}

// registers a JSON-RPC extension method. This can be invoked via JSONRPC calls,
// and will show up in openapi generation.
func registerJSONRPCMethod[In any, Out any](
	h *CamberHandler,
	operation JSONRPCOperation,
	handler func(ctx context.Context, req *In, lspReq *glsp.Context) (Out, error),
) {
	_, ok := h.extensionHandlers[operation.Method]
	if ok {
		panic(pkgerrors.Errorf("attempting register duplicate method %q", operation.Method))
	}

	h.registerSchema(func(api huma.API) {
		huma.Register[wrapJSONRPCBody[*In], wrapJSONRPCBody[Out]](api, huma.Operation{
			OperationID: operation.Method,
			Method:      http.MethodPost,
			Path:        "/" + operation.Method,
			Summary:     operation.Summary,
			Description: operation.Description,
			// N.B. We can't use Hidden, as then we can't reflect the schema
			//Hidden: false
			// we don't use huma as the actual handler, that's handled by the glsp server.
		}, nil)
	})

	h.extensionHandlers[operation.Method] = func(ctx context.Context, lspReq *glsp.Context) (any, error) {
		if h.shouldValidate() {
			var decoded any
			if err := json.Unmarshal(lspReq.Params, &decoded); err != nil {
				return nil, errors.Join(fmt.Errorf("could not parse input as json: %w", err), ErrInvalidParams)
			}
			openapi := h.OpenAPI().OpenAPI()
			schema := openapi.Paths["/"+operation.Method].Post.RequestBody.Content["application/json"].Schema
			validationRes := huma.ValidateResult{}
			pb := huma.PathBuffer{}
			huma.Validate(openapi.Components.Schemas, schema, &pb, huma.ModeWriteToServer, decoded, &validationRes)
			if len(validationRes.Errors) > 0 {
				return nil, errors.Join(append([]error{ErrInvalidParams}, validationRes.Errors...)...)
			}
		}

		typed, err := decodeJSONRPCInput[In](lspReq.Params)
		if err != nil {
			return nil, err
		}

		result, err := handler(ctx, typed, lspReq)
		return result, errorToWire(err)
	}
}

// Keep invalid-JSON and invalid-type errors distinct without allocating an
// untyped object graph on every successful production request.
func decodeJSONRPCInput[In any](params json.RawMessage) (*In, error) {
	typed := new(In)
	if err := json.Unmarshal(params, &typed); err != nil {
		if !json.Valid(params) {
			return nil, errors.Join(fmt.Errorf("could not parse input as json: %w", err), ErrInvalidParams)
		}
		return nil, errors.Join(fmt.Errorf("could not decode input as %T: %w", typed, err), ErrInvalidParams)
	}
	return typed, nil
}

func errorToWire(err error) error {
	if err == nil {
		return nil
	}
	var rpcErr *methods.JSONRPCError
	if errors.As(err, &rpcErr) {
		wire := &jsonrpc2.WireError{
			Code:    int64(rpcErr.Code),
			Message: rpcErr.Message,
		}
		if rpcErr.Data != nil {
			if data, marshalErr := json.Marshal(rpcErr.Data); marshalErr == nil {
				wire.Data = new(json.RawMessage(data))
			} else {
				slog.Warn("failed to marshal JSONRPCError.Data", "error", marshalErr)
			}
		}
		return wire
	}
	var wireErr *jsonrpc2.WireError
	if errors.As(err, &wireErr) {
		return wireErr
	}
	return &jsonrpc2.WireError{
		Code:    jsonrpc2.CodeInternalError,
		Message: err.Error(),
	}
}

// type to have our JSONRPC bodies rendered as bodies in OpenAPI spec. The HTTP fields
// are irrelevant to our JSONRPC use-case.
type wrapJSONRPCBody[T any] struct {
	Body T
}
