package filesearch

import (
	"context"
	"path/filepath"
	"sync"

	protocol "github.com/appleton/camber/pkg/camber-helper/gopls/pkg/protocol"
	"github.com/appleton/camber/pkg/camber-helper/methods"
	"github.com/tliron/glsp"
)

type Server struct {
	mu        sync.Mutex
	index     *searchIndex
	indexKey  string
	openFiles map[string]struct{}

	defaultWorkspaces func(context.Context) []WorkspaceFolder
}

func NewServer(defaultWorkspaces func(context.Context) []WorkspaceFolder) *Server {
	return &Server{
		openFiles:         make(map[string]struct{}),
		defaultWorkspaces: defaultWorkspaces,
	}
}

func (s *Server) Search(ctx context.Context, params *methods.SearchFilesParams, _ *glsp.Context) (*methods.SearchFilesOutput, error) {
	workspaces := s.resolveWorkspaces(ctx, params.Workspaces)
	classified := classifyQuery(params.Query)

	direct, err := resolveDirectFilesystemPath(ctx, params.Query, workspaces)
	if err != nil {
		return nil, err
	}
	if len(direct.files) > 0 || len(direct.controls) > 0 {
		return &methods.SearchFilesOutput{
			Workspaces: workspaceNames(workspaces),
			Files:      direct.files,
			Controls:   direct.controls,
		}, nil
	}

	idx, err := s.getIndex(ctx, workspaces, !params.ExcludeOpenFilesOutsideWorkspaces)
	if err != nil {
		return nil, err
	}

	files, err := idx.search(ctx, params.Query, classified.mode, workspaces)
	if err != nil {
		return nil, err
	}
	return &methods.SearchFilesOutput{
		Workspaces: workspaceNames(workspaces),
		Files:      files,
	}, nil
}

func (s *Server) DidOpen(uri protocol.DocumentURI) {
	if uri == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.openFiles[uri.Path()] = struct{}{}
	s.index = nil
}

func (s *Server) DidClose(uri protocol.DocumentURI) {
	if uri == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.openFiles, uri.Path())
	s.index = nil
}

func (s *Server) Invalidate() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.index = nil
	s.indexKey = ""
}

func (s *Server) resolveWorkspaces(ctx context.Context, input []methods.SearchFilesWorkspaceFolder) []WorkspaceFolder {
	if len(input) > 0 {
		return input
	}
	if s.defaultWorkspaces == nil {
		return nil
	}
	return s.defaultWorkspaces(ctx)
}

func (s *Server) getIndex(ctx context.Context, workspaces []WorkspaceFolder, includeOpenFilesOutsideWorkspaces bool) (*searchIndex, error) {
	key := workspaceKey(workspaces, includeOpenFilesOutsideWorkspaces)
	var openFiles []string
	if includeOpenFilesOutsideWorkspaces {
		openFiles = s.openFilePaths()
	}

	s.mu.Lock()
	if s.index != nil && s.indexKey == key {
		idx := s.index
		s.mu.Unlock()
		return idx, nil
	}
	s.mu.Unlock()

	idx, err := buildIndex(ctx, workspaces, openFiles)
	if err != nil {
		return nil, err
	}

	s.mu.Lock()
	s.index = idx
	s.indexKey = key
	s.mu.Unlock()

	return idx, nil
}

func (s *Server) openFilePaths() []string {
	s.mu.Lock()
	defer s.mu.Unlock()

	files := make([]string, 0, len(s.openFiles))
	for path := range s.openFiles {
		files = append(files, path)
	}
	return files
}

func workspaceKey(workspaces []WorkspaceFolder, includeOpenFilesOutsideWorkspaces bool) string {
	key := "open=0\x00"
	if includeOpenFilesOutsideWorkspaces {
		key = "open=1\x00"
	}
	for _, workspace := range workspaces {
		key += filepath.Clean(workspace.Path) + "\x00" + workspace.Name + "\x00"
	}
	return key
}
