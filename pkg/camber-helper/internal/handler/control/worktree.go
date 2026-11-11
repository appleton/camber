package control

import (
	"context"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	pkgerrors "github.com/pkg/errors"
	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/camber-helper/internal/handler/remoteterminal"
	"github.com/appleton/camber/pkg/camber-helper/methods"
)

func (s *Service) createWorktree(ctx context.Context, a Args, g *glsp.Context) (methods.ACPNavProject, error) {
	root, err := s.registeredRootProject(ctx, a.ProjectPath, g)
	if err != nil {
		return methods.ACPNavProject{}, err
	}
	a.ProjectPath = root
	p, err := s.nav.CreateWorktreeIsolated(ctx, &methods.ACPNavCreateWorktreeParams{ProjectPath: a.ProjectPath, WorktreeName: a.WorktreeName}, g)
	if err != nil {
		return p, err
	}
	settings, err := s.nav.GetProjectSettings(ctx, &methods.ACPNavGetProjectSettingsParams{Path: a.ProjectPath}, g)
	if err != nil {
		return p, err
	}
	if err = runWorktreeScript(ctx, p.Path, settings.Settings.SetupScript); err != nil {
		return p, err
	}
	return p, nil
}

// runWorktreeScript uses the same login shell, environment, PTY, bounded
// output and process cleanup as the helper's existing worktree terminal path.
func runWorktreeScript(ctx context.Context, path, script string) error {
	if strings.TrimSpace(script) == "" {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	manager := remoteterminal.NewManager(func(string, string, any) {})
	defer manager.Close()
	tab, err := manager.Create("control", methods.RemoteTerminalCreateParams{Cwd: path, Command: script})
	if err != nil {
		return err
	}
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		result := manager.Attach("control", []methods.RemoteTerminalAttachSession{{TerminalID: tab.ID}})
		if len(result) > 0 && result[0].ExitCode != nil {
			if *result[0].ExitCode != 0 {
				return pkgerrors.Errorf("worktree script failed in %s (exit %d): %s", path, *result[0].ExitCode, strings.TrimSpace(result[0].Data))
			}
			return nil
		}
		select {
		case <-ctx.Done():
			return pkgerrors.WithStack(ctx.Err())
		case <-ticker.C:
		}
	}
}
func (s *Service) removeWorktree(ctx context.Context, a Args, g *glsp.Context) (any, error) {
	path := a.WorkspacePath
	if path == "" {
		path = a.ProjectPath
	}
	if path == "" {
		return nil, pkgerrors.Errorf("workspacePath is required")
	}
	if source, ok := s.agent.(interface {
		ReserveWorkspace(context.Context, string) (func(), error)
	}); ok {
		release, reserveErr := source.ReserveWorkspace(ctx, path)
		if reserveErr != nil {
			return nil, reserveErr
		}
		defer release()
	}
	state, err := s.nav.List(ctx, &methods.ACPNavListParams{}, g)
	if err != nil {
		return nil, err
	}
	var project *methods.ACPNavProject
	for i := range state.Projects {
		if canonicalControlPath(state.Projects[i].Path) == canonicalControlPath(path) && state.Projects[i].IsWorktree {
			project = &state.Projects[i]
			path = project.Path
			break
		}
	}
	if project == nil {
		return nil, pkgerrors.Errorf("worktree %s does not exist", path)
	}
	for _, c := range state.Conversations {
		if conversationUsesWorktree(c, path) && c.SessionID != "" {
			release, reserveErr := s.reserveIdle(ctx, c.AgentServer, c.SessionID)
			if reserveErr != nil {
				return nil, reserveErr
			}
			defer release()
		}
	}
	for _, c := range state.Conversations {
		view, viewErr := s.view(ctx, c.ID, g)
		if viewErr != nil {
			return nil, viewErr
		}
		record := view.Record
		if conversationUsesWorktree(c, path) && (record.Status == "preparing" || record.Status == "running") {
			return nil, pkgerrors.Errorf("worktree has a preparing or running conversation %s", c.ID)
		}
		if conversationUsesWorktree(c, path) && (s.log.Cursor(c.AgentServer, c.SessionID).TurnActive || (c.LiveStatus != nil && c.LiveStatus.Working)) {
			return nil, pkgerrors.Errorf("worktree has a running conversation %s", c.ID)
		}
	}
	// Reject dirty/untracked work before the teardown script runs. The check
	// is isolated git (no hooks, fsmonitor or repo filter drivers), as is the
	// non-force removal below.
	if err = s.nav.CheckWorktreeClean(ctx, path); err != nil {
		return nil, err
	}
	settingsPath := path
	if project.ParentPath != nil {
		settingsPath = *project.ParentPath
	}
	settings, err := s.nav.GetProjectSettings(ctx, &methods.ACPNavGetProjectSettingsParams{Path: settingsPath}, g)
	if err != nil {
		return nil, err
	}
	if err = runWorktreeScript(ctx, path, settings.Settings.TeardownScript); err != nil {
		return nil, err
	}
	return s.nav.RemoveWorktreeSafely(ctx, path, g)
}

func conversationUsesWorktree(c methods.ACPNavConversation, root string) bool {
	root = canonicalControlPath(root)
	for _, candidate := range append([]string{c.WorkspacePath, c.Cwd}, c.WorkingDirectories...) {
		if candidate == "" {
			continue
		}
		rel, err := filepath.Rel(root, canonicalControlPath(candidate))
		if err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel) {
			return true
		}
	}
	return false
}

// cleanControlPath validates a caller-supplied path on its raw form, before
// any lexical cleaning, and returns the cleaned path to use from then on. A
// ".." segment is rejected because cleaning would drop it lexically while the
// kernel resolves it through a symlink, so "/proj/link/.." could pass the
// registration check yet name a directory outside the project.
func cleanControlPath(field, path string) (string, error) {
	if path == "" {
		return "", nil
	}
	if !filepath.IsAbs(path) {
		return "", pkgerrors.Errorf("%s must be an absolute path: %s", field, path)
	}
	for _, segment := range strings.FieldsFunc(path, func(r rune) bool { return r == '/' || r == filepath.Separator }) {
		if segment == ".." {
			return "", pkgerrors.Errorf("%s must not contain \"..\" segments: %s", field, path)
		}
	}
	return filepath.Clean(path), nil
}

func canonicalControlPath(path string) string {
	if path == "" {
		return ""
	}
	if absolute, err := filepath.Abs(path); err == nil {
		path = absolute
	}
	for parent := path; ; parent = filepath.Dir(parent) {
		if resolved, err := filepath.EvalSymlinks(parent); err == nil {
			suffix, _ := filepath.Rel(parent, path)
			path = filepath.Join(resolved, suffix)
			break
		}
		if parent == filepath.Dir(parent) {
			break
		}
	}
	path = filepath.Clean(path)
	if runtime.GOOS == "windows" {
		path = strings.ToLower(path)
	}
	return path
}

// checkRegisteredWorkspace requires a caller-supplied path to be, or lie
// inside, a registered project or worktree (symlinks resolved).
func (s *Service) checkRegisteredWorkspace(ctx context.Context, path string, g *glsp.Context) error {
	if path == "" {
		return nil
	}
	state, err := s.nav.List(ctx, &methods.ACPNavListParams{}, g)
	if err != nil {
		return err
	}
	target := canonicalControlPath(path)
	for _, p := range state.Projects {
		root := canonicalControlPath(p.Path)
		rel, relErr := filepath.Rel(root, target)
		if relErr == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel) {
			return nil
		}
	}
	return pkgerrors.Errorf("workspace %s is not a registered project or worktree (or a subdirectory of one)", path)
}

// registeredRootProject requires a path that creates worktrees to be a
// registered root project itself, not a subdirectory and not a worktree
// (symlinks resolved), and returns the registered path.
func (s *Service) registeredRootProject(ctx context.Context, path string, g *glsp.Context) (string, error) {
	if path == "" {
		return "", pkgerrors.Errorf("projectPath is required")
	}
	state, err := s.nav.List(ctx, &methods.ACPNavListParams{}, g)
	if err != nil {
		return "", err
	}
	target := canonicalControlPath(path)
	for _, p := range state.Projects {
		if !p.IsWorktree && canonicalControlPath(p.Path) == target {
			return p.Path, nil
		}
	}
	return "", pkgerrors.Errorf("project %s is not a registered root project; worktrees can only be created from a registered project root (see projects list)", path)
}
