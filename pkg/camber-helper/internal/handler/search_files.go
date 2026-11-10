package handler

import (
	"context"
	"path/filepath"

	"github.com/appleton/camber/pkg/camber-helper/internal/handler/filesearch"
	"github.com/appleton/camber/pkg/camber-helper/methods"
)

func (h *CamberHandler) searchFileWorkspaceFolders(ctx context.Context) []filesearch.WorkspaceFolder {
	folders := h.GetWorkspaceFolders()
	out := make([]filesearch.WorkspaceFolder, 0, len(folders))
	for i, folder := range folders {
		path := uriToPath(string(folder.URI))
		name := folder.Name
		if name == "" {
			name = filepath.Base(path)
		}
		out = append(out, filesearch.WorkspaceFolder{
			Path:  path,
			Name:  name,
			Index: i,
		})
	}
	if len(out) > 0 {
		return out
	}
	return h.searchFileACPNavWorkspaceFolders(ctx)
}

func (h *CamberHandler) searchFileACPNavWorkspaceFolders(ctx context.Context) []filesearch.WorkspaceFolder {
	if h.acpNavHandler == nil || !h.acpNavHandler.HasStore() {
		return nil
	}
	state, err := h.acpNavHandler.List(ctx, &methods.ACPNavListParams{}, nil)
	if err != nil {
		return nil
	}
	out := make([]filesearch.WorkspaceFolder, 0, len(state.Projects))
	for _, project := range state.Projects {
		if project.Path == "" {
			continue
		}
		name := project.Name
		if name == "" {
			name = filepath.Base(project.Path)
		}
		out = append(out, filesearch.WorkspaceFolder{
			Path:  project.Path,
			Name:  name,
			Index: -1,
		})
	}
	return out
}
