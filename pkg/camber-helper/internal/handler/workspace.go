package handler

import (
	"context"

	"github.com/tliron/glsp"
	protocol "github.com/tliron/glsp/protocol_3_16"

	protocol3 "github.com/appleton/camber/pkg/camber-helper/gopls/pkg/protocol"
	"github.com/appleton/camber/pkg/camber-helper/internal/lsptypes"
)

func (h *CamberHandler) WorkspaceDidChangeWorkspaceFolders(ctx context.Context, params *protocol3.DidChangeWorkspaceFoldersParams, lspCtx *glsp.Context) (any, error) {
	h.applyWorkspaceFolderChange(params)
	if h.fileSearchHandler != nil {
		h.fileSearchHandler.Invalidate()
	}
	return nil, nil
}

func (h *CamberHandler) WorkspaceDidChangeWatchedFiles(ctx context.Context, params *protocol3.DidChangeWatchedFilesParams, lspCtx *glsp.Context) (any, error) {
	return nil, h.handleWorkspaceDidChangeWatchedFiles(ctx, params)
}

func (h *CamberHandler) handleWorkspaceDidChangeWatchedFiles(ctx context.Context, params *protocol3.DidChangeWatchedFilesParams) error {
	if h.fileSearchHandler != nil {
		h.fileSearchHandler.Invalidate()
	}
	return nil
}

func (h *CamberHandler) WorkspaceWillDeleteFiles(ctx context.Context, params *lsptypes.DeleteFilesParams, lspCtx *glsp.Context) (any, error) {
	h.OnWorkspaceWillDeleteFiles(ctx, *params, lspCtx.Call)
	return nil, nil
}

func (h *CamberHandler) WorkspaceDidDeleteFiles(ctx context.Context, params *lsptypes.DeleteFilesParams, lspCtx *glsp.Context) (any, error) {
	if h.fileSearchHandler != nil {
		h.fileSearchHandler.Invalidate()
	}
	return nil, nil
}

func (h *CamberHandler) WorkspaceDidCreateFiles(ctx context.Context, params *lsptypes.CreateFilesParams, lspCtx *glsp.Context) (any, error) {
	if h.fileSearchHandler != nil {
		h.fileSearchHandler.Invalidate()
	}
	h.OnWorkspaceDidCreateFiles(ctx, *params, lspCtx.Call)
	return nil, nil
}

func (h *CamberHandler) WorkspaceDidRenameFiles(ctx context.Context, params *lsptypes.RenameFilesParams, lspCtx *glsp.Context) (any, error) {
	if h.fileSearchHandler != nil {
		h.fileSearchHandler.Invalidate()
	}
	h.OnWorkspaceDidRenameFiles(ctx, *params, lspCtx.Call)
	return nil, nil
}

func (h *CamberHandler) applyWorkspaceFolderChange(params *protocol3.DidChangeWorkspaceFoldersParams) {
	if params == nil {
		return
	}
	h.mx.Lock()
	defer h.mx.Unlock()

	removed := make(map[string]struct{}, len(params.Event.Removed))
	for _, folder := range params.Event.Removed {
		removed[string(folder.URI)] = struct{}{}
	}
	capacity := max(len(h.workspaceFolders)-len(removed)+len(params.Event.Added), 0)
	next := make([]protocol.WorkspaceFolder, 0, capacity)
	for _, folder := range h.workspaceFolders {
		if _, ok := removed[string(folder.URI)]; ok {
			continue
		}
		next = append(next, folder)
	}
	for _, folder := range params.Event.Added {
		next = append(next, protocol.WorkspaceFolder{
			URI:  protocol.DocumentUri(folder.URI),
			Name: folder.Name,
		})
	}
	h.workspaceFolders = next
}
