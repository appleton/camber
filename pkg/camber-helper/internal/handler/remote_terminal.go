package handler

import (
	"context"

	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

// setupRemoteTerminal registers the remote worktree terminal methods. They are
// intended for remote (mobile) clients —
// but the primary connection may call them too (useful for debugging).
func setupRemoteTerminal(h *CamberHandler) {
	registerExtensionMethod(h, JSONRPCOperation{
		Method:      methods.RemoteTerminalCreateParams{}.MethodName(),
		Description: methods.RemoteTerminalCreateParams{}.Description(),
	}, h.remoteTerminalCreate)

	registerExtensionMethod(h, JSONRPCOperation{
		Method:      methods.RemoteTerminalWriteParams{}.MethodName(),
		Description: methods.RemoteTerminalWriteParams{}.Description(),
	}, h.remoteTerminalWrite)

	registerExtensionMethod(h, JSONRPCOperation{
		Method:      methods.RemoteTerminalResizeParams{}.MethodName(),
		Description: methods.RemoteTerminalResizeParams{}.Description(),
	}, h.remoteTerminalResize)

	registerExtensionMethod(h, JSONRPCOperation{
		Method:      methods.RemoteTerminalClearParams{}.MethodName(),
		Description: methods.RemoteTerminalClearParams{}.Description(),
	}, h.remoteTerminalClear)

	registerExtensionMethod(h, JSONRPCOperation{
		Method:      methods.RemoteTerminalDeleteParams{}.MethodName(),
		Description: methods.RemoteTerminalDeleteParams{}.Description(),
	}, h.remoteTerminalDelete)

	registerExtensionMethod(h, JSONRPCOperation{
		Method:      methods.RemoteTerminalListParams{}.MethodName(),
		Description: methods.RemoteTerminalListParams{}.Description(),
	}, h.remoteTerminalList)

	registerExtensionMethod(h, JSONRPCOperation{
		Method:      methods.RemoteTerminalCloseForPathParams{}.MethodName(),
		Description: methods.RemoteTerminalCloseForPathParams{}.Description(),
	}, h.remoteTerminalCloseForPath)

	registerExtensionMethod(h, JSONRPCOperation{
		Method:      methods.RemoteTerminalAttachParams{}.MethodName(),
		Description: methods.RemoteTerminalAttachParams{}.Description(),
	}, h.remoteTerminalAttach)
}

func (h *CamberHandler) remoteTerminalCreate(ctx context.Context, params *methods.RemoteTerminalCreateParams, gCtx *glsp.Context) (methods.RemoteTerminalCreateOutput, error) {
	tab, err := h.remoteTerminals.Create(methods.ClientOriginFromContext(ctx), *params)
	if err != nil {
		return methods.RemoteTerminalCreateOutput{}, err
	}
	return methods.RemoteTerminalCreateOutput{Tab: tab}, nil
}

func (h *CamberHandler) remoteTerminalWrite(ctx context.Context, params *methods.RemoteTerminalWriteParams, gCtx *glsp.Context) (methods.RemoteTerminalWriteOutput, error) {
	return methods.RemoteTerminalWriteOutput{}, h.remoteTerminals.Write(params.TerminalID, params.Data)
}

func (h *CamberHandler) remoteTerminalResize(ctx context.Context, params *methods.RemoteTerminalResizeParams, gCtx *glsp.Context) (methods.RemoteTerminalResizeOutput, error) {
	return methods.RemoteTerminalResizeOutput{}, h.remoteTerminals.Resize(params.TerminalID, params.Cols, params.Rows)
}

func (h *CamberHandler) remoteTerminalClear(ctx context.Context, params *methods.RemoteTerminalClearParams, gCtx *glsp.Context) (methods.RemoteTerminalClearOutput, error) {
	return methods.RemoteTerminalClearOutput{}, h.remoteTerminals.Clear(params.TerminalID)
}

func (h *CamberHandler) remoteTerminalDelete(ctx context.Context, params *methods.RemoteTerminalDeleteParams, gCtx *glsp.Context) (methods.RemoteTerminalDeleteOutput, error) {
	return methods.RemoteTerminalDeleteOutput{}, h.remoteTerminals.Delete(params.TerminalID)
}

func (h *CamberHandler) remoteTerminalList(ctx context.Context, params *methods.RemoteTerminalListParams, gCtx *glsp.Context) (methods.RemoteTerminalListOutput, error) {
	return methods.RemoteTerminalListOutput{Tabs: h.remoteTerminals.List()}, nil
}

func (h *CamberHandler) remoteTerminalCloseForPath(ctx context.Context, params *methods.RemoteTerminalCloseForPathParams, gCtx *glsp.Context) (methods.RemoteTerminalCloseForPathOutput, error) {
	h.remoteTerminals.CloseForPath(params.Path)
	return methods.RemoteTerminalCloseForPathOutput{}, nil
}

func (h *CamberHandler) remoteTerminalAttach(ctx context.Context, params *methods.RemoteTerminalAttachParams, gCtx *glsp.Context) (methods.RemoteTerminalAttachOutput, error) {
	results := h.remoteTerminals.Attach(methods.ClientOriginFromContext(ctx), params.Sessions)
	return methods.RemoteTerminalAttachOutput{Sessions: results}, nil
}
