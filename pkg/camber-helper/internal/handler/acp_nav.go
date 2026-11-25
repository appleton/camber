package handler

import (
	"context"

	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

func (h *CamberHandler) ACPNavList(ctx context.Context, req *methods.ACPNavListParams, gCtx *glsp.Context) (methods.ACPNavState, error) {
	return h.acpNavHandler.List(ctx, req, gCtx)
}

func (h *CamberHandler) ACPNavListAgentServers(ctx context.Context, req *methods.ACPNavListAgentServersParams, gCtx *glsp.Context) (methods.ACPNavAgentServersState, error) {
	return h.acpNavHandler.ListAgentServers(ctx, req, gCtx)
}

func (h *CamberHandler) ACPNavUpsertProject(ctx context.Context, req *methods.ACPNavUpsertProjectParams, gCtx *glsp.Context) (methods.ACPNavProject, error) {
	return h.acpNavHandler.UpsertProject(ctx, req, gCtx)
}

func (h *CamberHandler) ACPNavPrepareWorktree(ctx context.Context, req *methods.ACPNavPrepareWorktreeParams, gCtx *glsp.Context) (methods.ACPNavProject, error) {
	// Prepare reserves a name in memory only — no DB or filesystem change,
	// so the file-search cache does not need to be invalidated here.
	return h.acpNavHandler.PrepareWorktree(ctx, req, gCtx)
}

func (h *CamberHandler) ACPNavReleasePreparedWorktree(ctx context.Context, req *methods.ACPNavReleasePreparedWorktreeParams, gCtx *glsp.Context) (methods.ACPNavReleasePreparedWorktreeOutput, error) {
	return h.acpNavHandler.ReleasePreparedWorktree(ctx, req, gCtx)
}

func (h *CamberHandler) ACPNavCreateWorktree(ctx context.Context, req *methods.ACPNavCreateWorktreeParams, gCtx *glsp.Context) (methods.ACPNavProject, error) {
	return h.acpNavHandler.CreateWorktree(ctx, req, gCtx)
}

func (h *CamberHandler) ACPNavRemoveProject(ctx context.Context, req *methods.ACPNavRemoveProjectParams, gCtx *glsp.Context) (methods.ACPNavState, error) {
	return h.acpNavHandler.RemoveProject(ctx, req, gCtx)
}

func (h *CamberHandler) ACPNavRemoveWorktree(ctx context.Context, req *methods.ACPNavRemoveWorktreeParams, gCtx *glsp.Context) (methods.ACPNavState, error) {
	return h.acpNavHandler.RemoveWorktree(ctx, req, gCtx)
}

// invalidateFileSearchAfterACPNavChange is acpnav's projects-changed hook, so
// every project change (desktop, mobile or control action) refreshes search.
func (h *CamberHandler) invalidateFileSearchAfterACPNavChange() {
	if h.fileSearchHandler != nil {
		h.fileSearchHandler.Invalidate()
	}
}
