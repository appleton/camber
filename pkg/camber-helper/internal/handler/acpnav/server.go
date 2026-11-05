package acpnav

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/camber-helper/methods"
	"github.com/appleton/camber/pkg/common/userconfig"
)

type Server struct {
	store            *Store
	agentServerStore AgentServerStore
	stateFilter      func(methods.ACPNavState) methods.ACPNavState
	mu               sync.Mutex
	liveStatuses     map[string]methods.ACPNavConversationLiveStatus
	// activeSessions tracks which conversations each client connection is
	// currently viewing, keyed by client origin (methods.ClientOriginFromContext)
	// then by live-status key. A conversation counts as watched — so a
	// completing turn does not mark it unread — while ANY origin views it, and
	// unread survives one surface closing a conversation another still shows.
	activeSessions map[string]map[string]bool
}

type InstalledRegistryAgentServerStore interface {
	RecordInstalledRegistryAgentServer(ctx context.Context, name string, cfg methods.ACPAgentServerConfig) error
}

func NewServer() *Server {
	return &Server{
		liveStatuses:   map[string]methods.ACPNavConversationLiveStatus{},
		activeSessions: map[string]map[string]bool{},
	}
}

func (s *Server) SetStore(store *Store) {
	if s.store != nil {
		_ = s.store.Close()
	}
	s.store = store
	if s.agentServerStore == nil {
		s.agentServerStore = store
	}
}

func (s *Server) CreateChat(_ context.Context, req *methods.ACPNavCreateChatParams, _ *glsp.Context) (methods.ACPNavCreateChatOutput, error) {
	sessionID := strings.TrimSpace(req.SessionID)
	if sessionID == "" {
		return methods.ACPNavCreateChatOutput{}, fmt.Errorf("sessionId is required")
	}

	path := chatStoragePath(sessionID)
	if err := os.MkdirAll(path, 0o700); err != nil {
		return methods.ACPNavCreateChatOutput{}, fmt.Errorf("creating chat working directory: %w", err)
	}
	return methods.ACPNavCreateChatOutput{Path: path}, nil
}

const chatStorageDirectoryName = "chats"

func chatStoragePath(sessionID string) string {
	return filepath.Join(userconfig.StateDirectory(), chatStorageDirectoryName, chatStorageName(sessionID))
}

func chatStorageName(sessionID string) string {
	sum := sha256.Sum256([]byte(sessionID))
	return hex.EncodeToString(sum[:])
}

func (s *Server) SetAgentServerStore(store AgentServerStore) {
	s.agentServerStore = store
}

func (s *Server) SetStateFilter(filter func(methods.ACPNavState) methods.ACPNavState) {
	s.stateFilter = filter
}

func (s *Server) HasStore() bool {
	return s.store != nil
}

func (s *Server) Close() error {
	if s.store == nil {
		return nil
	}
	return s.store.Close()
}

func (s *Server) List(ctx context.Context, _ *methods.ACPNavListParams, _ *glsp.Context) (methods.ACPNavState, error) {
	if s.store == nil {
		return methods.ACPNavState{}, sql.ErrConnDone
	}
	return s.listWithLiveStatus(ctx)
}

func (s *Server) AgentServers(ctx context.Context) (methods.ACPAgentServers, error) {
	if s.agentServerStore == nil {
		return nil, sql.ErrConnDone
	}
	return s.agentServerStore.ListAgentServers(ctx)
}

func (s *Server) SeedAgentServersIfNeeded(ctx context.Context, agentServers methods.ACPAgentServers) error {
	if s.agentServerStore == nil {
		return sql.ErrConnDone
	}
	return s.agentServerStore.SeedAgentServersIfNeeded(ctx, agentServers)
}

func (s *Server) ListAgentServers(ctx context.Context, _ *methods.ACPNavListAgentServersParams, _ *glsp.Context) (methods.ACPNavAgentServersState, error) {
	if s.agentServerStore == nil {
		return methods.ACPNavAgentServersState{}, sql.ErrConnDone
	}
	agentServers, err := s.agentServerStore.ListAgentServers(ctx)
	if err != nil {
		return methods.ACPNavAgentServersState{}, err
	}
	defaultAgentServer, err := s.agentServerStore.GetDefaultAgentServer(ctx)
	if err != nil {
		return methods.ACPNavAgentServersState{}, err
	}
	defaultAgentServerPinned, err := s.agentServerStore.GetDefaultAgentServerPinned(ctx)
	if err != nil {
		return methods.ACPNavAgentServersState{}, err
	}
	return methods.ACPNavAgentServersState{
		AgentServers:             agentServers,
		DefaultAgentServer:       defaultAgentServer,
		DefaultAgentServerPinned: defaultAgentServerPinned,
	}, nil
}

func (s *Server) SetAgentServers(ctx context.Context, req *methods.ACPNavSetAgentServersParams, _ *glsp.Context) (methods.ACPNavAgentServersState, error) {
	if s.agentServerStore == nil {
		return methods.ACPNavAgentServersState{}, sql.ErrConnDone
	}
	if err := s.agentServerStore.SetAgentServers(ctx, req.AgentServers, req.DefaultAgentServer, req.DefaultAgentServerPinned); err != nil {
		return methods.ACPNavAgentServersState{}, err
	}
	agentServers, err := s.agentServerStore.ListAgentServers(ctx)
	if err != nil {
		return methods.ACPNavAgentServersState{}, err
	}
	defaultAgentServer, err := s.agentServerStore.GetDefaultAgentServer(ctx)
	if err != nil {
		return methods.ACPNavAgentServersState{}, err
	}
	defaultAgentServerPinned, err := s.agentServerStore.GetDefaultAgentServerPinned(ctx)
	if err != nil {
		return methods.ACPNavAgentServersState{}, err
	}
	return methods.ACPNavAgentServersState{
		AgentServers:             agentServers,
		DefaultAgentServer:       defaultAgentServer,
		DefaultAgentServerPinned: defaultAgentServerPinned,
	}, nil
}

func (s *Server) RecordInstalledRegistryAgentServer(ctx context.Context, name string, cfg methods.ACPAgentServerConfig) error {
	recorder, ok := s.agentServerStore.(InstalledRegistryAgentServerStore)
	if !ok {
		return fmt.Errorf("ACP agent server store does not support registry install state")
	}
	return recorder.RecordInstalledRegistryAgentServer(ctx, name, cfg)
}

func (s *Server) GetConfigCache(ctx context.Context, req *methods.ACPNavGetConfigCacheParams, _ *glsp.Context) (methods.ACPNavConfigCacheState, error) {
	if s.store == nil {
		return methods.ACPNavConfigCacheState{}, sql.ErrConnDone
	}
	entry, err := s.store.GetConfigCache(ctx, req.AgentServer)
	if err != nil {
		return methods.ACPNavConfigCacheState{}, err
	}
	return methods.ACPNavConfigCacheState{Entry: entry}, nil
}

func (s *Server) UpsertConfigCache(ctx context.Context, req *methods.ACPNavUpsertConfigCacheParams, _ *glsp.Context) (methods.ACPNavConfigCacheState, error) {
	if s.store == nil {
		return methods.ACPNavConfigCacheState{}, sql.ErrConnDone
	}
	entry, err := s.store.UpsertConfigCache(ctx, *req)
	if err != nil {
		return methods.ACPNavConfigCacheState{}, err
	}
	return methods.ACPNavConfigCacheState{Entry: entry}, nil
}

func (s *Server) GetFileOpener(ctx context.Context, _ *methods.ACPNavGetFileOpenerParams, _ *glsp.Context) (methods.ACPNavFileOpenerState, error) {
	if s.store == nil {
		return methods.ACPNavFileOpenerState{}, sql.ErrConnDone
	}
	fileOpener, err := s.store.GetFileOpener(ctx)
	if err != nil {
		return methods.ACPNavFileOpenerState{}, err
	}
	return methods.ACPNavFileOpenerState{FileOpener: fileOpener}, nil
}

func (s *Server) SetFileOpener(ctx context.Context, req *methods.ACPNavSetFileOpenerParams, _ *glsp.Context) (methods.ACPNavFileOpenerState, error) {
	if s.store == nil {
		return methods.ACPNavFileOpenerState{}, sql.ErrConnDone
	}
	if err := s.store.SetFileOpener(ctx, req.FileOpener); err != nil {
		return methods.ACPNavFileOpenerState{}, err
	}
	fileOpener, err := s.store.GetFileOpener(ctx)
	if err != nil {
		return methods.ACPNavFileOpenerState{}, err
	}
	return methods.ACPNavFileOpenerState{FileOpener: fileOpener}, nil
}

func (s *Server) GetGithubColorMode(ctx context.Context, _ *methods.ACPNavGetGithubColorModeParams, _ *glsp.Context) (methods.ACPNavGithubColorModeState, error) {
	if s.store == nil {
		return methods.ACPNavGithubColorModeState{}, sql.ErrConnDone
	}
	mode, err := s.store.GetGithubColorMode(ctx)
	if err != nil {
		return methods.ACPNavGithubColorModeState{}, err
	}
	return methods.ACPNavGithubColorModeState{ColorMode: mode}, nil
}

func (s *Server) SetGithubColorMode(ctx context.Context, req *methods.ACPNavSetGithubColorModeParams, _ *glsp.Context) (methods.ACPNavGithubColorModeState, error) {
	if s.store == nil {
		return methods.ACPNavGithubColorModeState{}, sql.ErrConnDone
	}
	if err := s.store.SetGithubColorMode(ctx, req.ColorMode); err != nil {
		return methods.ACPNavGithubColorModeState{}, err
	}
	mode, err := s.store.GetGithubColorMode(ctx)
	if err != nil {
		return methods.ACPNavGithubColorModeState{}, err
	}
	return methods.ACPNavGithubColorModeState{ColorMode: mode}, nil
}

func (s *Server) GetKeybindings(ctx context.Context, _ *methods.ACPNavGetKeybindingsParams, _ *glsp.Context) (methods.ACPNavKeybindingsState, error) {
	if s.store == nil {
		return methods.ACPNavKeybindingsState{}, sql.ErrConnDone
	}
	keybindings, err := s.store.GetKeybindings(ctx)
	if err != nil {
		return methods.ACPNavKeybindingsState{}, err
	}
	return methods.ACPNavKeybindingsState{Keybindings: keybindings}, nil
}

func (s *Server) SetKeybindings(ctx context.Context, req *methods.ACPNavSetKeybindingsParams, _ *glsp.Context) (methods.ACPNavKeybindingsState, error) {
	if s.store == nil {
		return methods.ACPNavKeybindingsState{}, sql.ErrConnDone
	}
	if err := s.store.SetKeybindings(ctx, req.Keybindings); err != nil {
		return methods.ACPNavKeybindingsState{}, err
	}
	keybindings, err := s.store.GetKeybindings(ctx)
	if err != nil {
		return methods.ACPNavKeybindingsState{}, err
	}
	return methods.ACPNavKeybindingsState{Keybindings: keybindings}, nil
}

func (s *Server) UpsertProject(ctx context.Context, req *methods.ACPNavUpsertProjectParams, gCtx *glsp.Context) (methods.ACPNavProject, error) {
	if s.store == nil {
		return methods.ACPNavProject{}, sql.ErrConnDone
	}
	project, err := s.store.UpsertProject(ctx, *req)
	if err != nil {
		return methods.ACPNavProject{}, err
	}
	s.notifyDidChange(ctx, gCtx)
	return project, nil
}

func (s *Server) SetProjectCollapsed(ctx context.Context, req *methods.ACPNavSetProjectCollapsedParams, gCtx *glsp.Context) (methods.ACPNavState, error) {
	if s.store == nil {
		return methods.ACPNavState{}, sql.ErrConnDone
	}
	if err := s.store.SetProjectCollapsed(ctx, req.Path, req.Collapsed); err != nil {
		return methods.ACPNavState{}, err
	}
	state, err := s.listWithLiveStatus(ctx)
	if err != nil {
		return methods.ACPNavState{}, err
	}
	s.notifyState(ctx, gCtx, state)
	return state, nil
}

func (s *Server) RenameProject(ctx context.Context, req *methods.ACPNavRenameProjectParams, gCtx *glsp.Context) (methods.ACPNavState, error) {
	if s.store == nil {
		return methods.ACPNavState{}, sql.ErrConnDone
	}
	if err := s.store.RenameProject(ctx, req.Path, req.Name); err != nil {
		return methods.ACPNavState{}, err
	}
	state, err := s.listWithLiveStatus(ctx)
	if err != nil {
		return methods.ACPNavState{}, err
	}
	s.notifyState(ctx, gCtx, state)
	return state, nil
}

func (s *Server) ReorderProjects(ctx context.Context, req *methods.ACPNavReorderProjectsParams, gCtx *glsp.Context) (methods.ACPNavState, error) {
	if s.store == nil {
		return methods.ACPNavState{}, sql.ErrConnDone
	}
	if err := s.store.ReorderProjects(ctx, req.Paths); err != nil {
		return methods.ACPNavState{}, err
	}
	state, err := s.listWithLiveStatus(ctx)
	if err != nil {
		return methods.ACPNavState{}, err
	}
	s.notifyState(ctx, gCtx, state)
	return state, nil
}

func (s *Server) ReorderWorktrees(ctx context.Context, req *methods.ACPNavReorderWorktreesParams, gCtx *glsp.Context) (methods.ACPNavState, error) {
	if s.store == nil {
		return methods.ACPNavState{}, sql.ErrConnDone
	}
	if err := s.store.ReorderWorktrees(ctx, req.ParentPath, req.Paths); err != nil {
		return methods.ACPNavState{}, err
	}
	state, err := s.listWithLiveStatus(ctx)
	if err != nil {
		return methods.ACPNavState{}, err
	}
	s.notifyState(ctx, gCtx, state)
	return state, nil
}

func (s *Server) GetProjectSettings(ctx context.Context, req *methods.ACPNavGetProjectSettingsParams, _ *glsp.Context) (methods.ACPNavProjectSettingsState, error) {
	if s.store == nil {
		return methods.ACPNavProjectSettingsState{}, sql.ErrConnDone
	}
	settings, err := s.store.GetProjectSettings(ctx, req.Path)
	if err != nil {
		return methods.ACPNavProjectSettingsState{}, err
	}
	return methods.ACPNavProjectSettingsState{Settings: settings}, nil
}

func (s *Server) SetProjectSettings(ctx context.Context, req *methods.ACPNavSetProjectSettingsParams, gCtx *glsp.Context) (methods.ACPNavProjectSettingsState, error) {
	if s.store == nil {
		return methods.ACPNavProjectSettingsState{}, sql.ErrConnDone
	}
	settings, err := s.store.SetProjectSettings(ctx, *req)
	if err != nil {
		return methods.ACPNavProjectSettingsState{}, err
	}
	s.notifyDidChange(ctx, gCtx)
	return methods.ACPNavProjectSettingsState{Settings: settings}, nil
}

func (s *Server) PrepareWorktree(ctx context.Context, req *methods.ACPNavPrepareWorktreeParams, _ *glsp.Context) (methods.ACPNavProject, error) {
	if s.store == nil {
		return methods.ACPNavProject{}, sql.ErrConnDone
	}
	return s.store.PrepareWorktree(ctx, req.ProjectPath)
}

func (s *Server) ReleasePreparedWorktree(_ context.Context, req *methods.ACPNavReleasePreparedWorktreeParams, _ *glsp.Context) (methods.ACPNavReleasePreparedWorktreeOutput, error) {
	if s.store == nil {
		return methods.ACPNavReleasePreparedWorktreeOutput{}, sql.ErrConnDone
	}
	s.store.ReleasePreparedWorktree(req.Path)
	return methods.ACPNavReleasePreparedWorktreeOutput{}, nil
}

func (s *Server) CreateWorktree(ctx context.Context, req *methods.ACPNavCreateWorktreeParams, gCtx *glsp.Context) (methods.ACPNavProject, error) {
	if s.store == nil {
		return methods.ACPNavProject{}, sql.ErrConnDone
	}
	project, err := s.store.CreateWorktree(ctx, req.ProjectPath, req.WorktreeName)
	if err != nil {
		return methods.ACPNavProject{}, err
	}
	if !pathExists(project.Path) {
		return methods.ACPNavProject{}, fmt.Errorf("created worktree path does not exist: %s", project.Path)
	}
	s.notifyDidChange(ctx, gCtx)
	return project, nil
}

func (s *Server) RemoveProject(ctx context.Context, req *methods.ACPNavRemoveProjectParams, gCtx *glsp.Context) (methods.ACPNavState, error) {
	if s.store == nil {
		return methods.ACPNavState{}, sql.ErrConnDone
	}
	if err := s.store.RemoveProject(ctx, req.Path); err != nil {
		return methods.ACPNavState{}, err
	}
	state, err := s.listWithLiveStatus(ctx)
	if err != nil {
		return methods.ACPNavState{}, err
	}
	s.notifyState(ctx, gCtx, state)
	return state, nil
}

func (s *Server) RemoveWorktree(ctx context.Context, req *methods.ACPNavRemoveWorktreeParams, gCtx *glsp.Context) (methods.ACPNavState, error) {
	if s.store == nil {
		return methods.ACPNavState{}, sql.ErrConnDone
	}
	if err := s.store.RemoveWorktree(ctx, req.Path); err != nil {
		return methods.ACPNavState{}, err
	}
	state, err := s.listWithLiveStatus(ctx)
	if err != nil {
		return methods.ACPNavState{}, err
	}
	s.notifyState(ctx, gCtx, state)
	return state, nil
}

func (s *Server) UpsertConversation(ctx context.Context, req *methods.ACPNavUpsertConversationParams, gCtx *glsp.Context) (methods.ACPNavState, error) {
	if s.store == nil {
		return methods.ACPNavState{}, sql.ErrConnDone
	}
	if err := s.store.UpsertConversation(ctx, req.Conversation); err != nil {
		return methods.ACPNavState{}, err
	}
	state, err := s.listWithLiveStatus(ctx)
	if err != nil {
		return methods.ACPNavState{}, err
	}
	s.notifyState(ctx, gCtx, state)
	return state, nil
}

func (s *Server) PrepareConversationHandoff(ctx context.Context, req *methods.ACPNavPrepareConversationHandoffParams, _ *glsp.Context) (methods.ACPNavConversationHandoffOutput, error) {
	if s.store == nil {
		return methods.ACPNavConversationHandoffOutput{}, sql.ErrConnDone
	}
	if err := s.store.PrepareConversationHandoff(ctx, *req); err != nil {
		return methods.ACPNavConversationHandoffOutput{}, err
	}
	return methods.ACPNavConversationHandoffOutput{}, nil
}

func (s *Server) AbortConversationHandoff(ctx context.Context, req *methods.ACPNavAbortConversationHandoffParams, _ *glsp.Context) (methods.ACPNavConversationHandoffOutput, error) {
	if s.store == nil {
		return methods.ACPNavConversationHandoffOutput{}, sql.ErrConnDone
	}
	if err := s.store.AbortConversationHandoff(ctx, req.HandoffID); err != nil {
		return methods.ACPNavConversationHandoffOutput{}, err
	}
	return methods.ACPNavConversationHandoffOutput{}, nil
}

func (s *Server) GetConversationHistory(ctx context.Context, req *methods.ACPNavGetConversationHistoryParams, _ *glsp.Context) (methods.ACPNavConversationHistory, error) {
	if s.store == nil {
		return methods.ACPNavConversationHistory{}, sql.ErrConnDone
	}
	return s.store.ConversationHistory(ctx, req.ConversationID)
}

// BindConversationSession writes the session id created for a conversation
// and pushes the refreshed nav state to every surface. Invoked helper-side at
// session/new time so conversation live status (keyed by session id) is
// attachable before any turn can start.
func (s *Server) BindConversationSession(ctx context.Context, gCtx *glsp.Context, conversationID, agentServer, sessionID, cwd string) error {
	if s.store == nil {
		return sql.ErrConnDone
	}
	if err := s.store.BindConversationSession(ctx, conversationID, agentServer, sessionID, cwd); err != nil {
		return err
	}
	state, err := s.listWithLiveStatus(ctx)
	if err != nil {
		return err
	}
	s.notifyState(ctx, gCtx, state)
	return nil
}

// UpdateConversationTitle persists an agent-generated title without changing
// the conversation's active/archive state or its user-authored nickname.
func (s *Server) UpdateConversationTitle(ctx context.Context, gCtx *glsp.Context, agentServer, sessionID, title string) error {
	if s.store == nil {
		return sql.ErrConnDone
	}
	changed, err := s.store.UpdateConversationTitle(ctx, agentServer, sessionID, title)
	if err != nil || !changed {
		return err
	}
	state, err := s.listWithLiveStatus(ctx)
	if err != nil {
		return err
	}
	s.notifyState(ctx, gCtx, state)
	return nil
}

// BindConversationSessionHandoff atomically commits the frozen source leg and
// points the stable conversation id at the target agent session. A handoff is
// never visible durably in only one of those two states.
func (s *Server) BindConversationSessionHandoff(ctx context.Context, gCtx *glsp.Context, conversationID, agentServer, sessionID, cwd, handoffID string) error {
	if s.store == nil {
		return sql.ErrConnDone
	}
	if err := s.store.BindConversationSessionHandoff(ctx, conversationID, agentServer, sessionID, cwd, handoffID); err != nil {
		return err
	}
	state, err := s.listWithLiveStatus(ctx)
	if err != nil {
		// The leg and target binding are already committed atomically. Treat a
		// refresh failure as best-effort so session/new can still return the
		// target session id and the client does not incorrectly restore source.
		slog.Warn("acpnav: handoff committed but nav refresh failed", "conversation", conversationID, "error", err)
		return nil
	}
	s.notifyState(ctx, gCtx, state)
	return nil
}

func (s *Server) RestoreConversation(ctx context.Context, req *methods.ACPNavRestoreConversationParams, gCtx *glsp.Context) (methods.ACPNavState, error) {
	if s.store == nil {
		return methods.ACPNavState{}, sql.ErrConnDone
	}
	if err := s.store.RestoreConversation(ctx, req.Conversation); err != nil {
		return methods.ACPNavState{}, err
	}
	state, err := s.listWithLiveStatus(ctx)
	if err != nil {
		return methods.ACPNavState{}, err
	}
	s.notifyState(ctx, gCtx, state)
	return state, nil
}

func (s *Server) ArchiveConversation(ctx context.Context, req *methods.ACPNavArchiveConversationParams, gCtx *glsp.Context) (methods.ACPNavState, error) {
	if s.store == nil {
		return methods.ACPNavState{}, sql.ErrConnDone
	}
	if err := s.store.ArchiveConversation(ctx, req.WorkspacePath, req.ConversationID, req.AgentServer, req.SessionID); err != nil {
		return methods.ACPNavState{}, err
	}
	state, err := s.listWithLiveStatus(ctx)
	if err != nil {
		return methods.ACPNavState{}, err
	}
	s.notifyState(ctx, gCtx, state)
	return state, nil
}

func (s *Server) RenameConversation(ctx context.Context, req *methods.ACPNavRenameConversationParams, gCtx *glsp.Context) (methods.ACPNavState, error) {
	if s.store == nil {
		return methods.ACPNavState{}, sql.ErrConnDone
	}
	if err := s.store.RenameConversation(ctx, req.ConversationID, req.Nickname, req.Title); err != nil {
		return methods.ACPNavState{}, err
	}
	state, err := s.listWithLiveStatus(ctx)
	if err != nil {
		return methods.ACPNavState{}, err
	}
	s.notifyState(ctx, gCtx, state)
	return state, nil
}

func (s *Server) SetConversationViewState(ctx context.Context, req *methods.ACPNavSetConversationViewStateParams, gCtx *glsp.Context) (methods.ACPNavState, error) {
	if s.store == nil {
		return methods.ACPNavState{}, sql.ErrConnDone
	}
	origin := methods.ClientOriginFromContext(ctx)
	key, hasKey := liveStatusKey(req.AgentServer, req.SessionID)
	if !hasKey && !req.Reset {
		return s.listWithLiveStatus(ctx)
	}

	// Resolved before taking s.mu: it reads the database. Best-effort: a
	// failed lookup must not stop the conversation itself being marked viewed.
	var descendantKeys []string
	if hasKey && req.Active {
		var err error
		if descendantKeys, err = s.descendantLiveStatusKeys(ctx, key); err != nil {
			slog.WarnContext(ctx, "acpnav: resolving descendant conversations failed", "error", err)
		}
	}

	statusChanged := false
	s.mu.Lock()
	if req.Reset {
		delete(s.activeSessions, origin)
	}
	if hasKey {
		if req.Active {
			if s.activeSessions[origin] == nil {
				s.activeSessions[origin] = map[string]bool{}
			}
			s.activeSessions[origin][key] = true
			status := s.liveStatuses[key]
			if status.Unread {
				status.Unread = false
				statusChanged = true
				s.setLiveStatusLocked(key, status)
			}
			// Viewing a parent also reads its spawned descendants' completed
			// turns. Ones still needing input keep their state.
			for _, descendantKey := range descendantKeys {
				status, ok := s.liveStatuses[descendantKey]
				if !ok || !status.Unread || status.WaitingForUser {
					continue
				}
				status.Unread = false
				statusChanged = true
				s.setLiveStatusLocked(descendantKey, status)
			}
		} else {
			delete(s.activeSessions[origin], key)
			if len(s.activeSessions[origin]) == 0 {
				delete(s.activeSessions, origin)
			}
		}
	}
	s.mu.Unlock()

	state, err := s.listWithLiveStatus(ctx)
	if err != nil {
		return methods.ACPNavState{}, err
	}
	if statusChanged {
		s.notifyState(ctx, gCtx, state)
	}
	return state, nil
}

// descendantLiveStatusKeys returns the live status keys of every conversation
// descended (via ParentID) from the conversation bound to key. Cycle-safe.
func (s *Server) descendantLiveStatusKeys(ctx context.Context, key string) ([]string, error) {
	state, err := s.store.List(ctx)
	if err != nil {
		return nil, err
	}
	children := map[string][]methods.ACPNavConversation{}
	var queue []string
	seen := map[string]bool{}
	for _, conversation := range state.Conversations {
		if conversationKey, ok := liveStatusKey(conversation.AgentServer, conversation.SessionID); ok && conversationKey == key && !seen[conversation.ID] {
			seen[conversation.ID] = true
			queue = append(queue, conversation.ID)
		}
		if conversation.ParentID != "" && conversation.ParentID != conversation.ID {
			children[conversation.ParentID] = append(children[conversation.ParentID], conversation)
		}
	}
	var keys []string
	for len(queue) > 0 {
		id := queue[0]
		queue = queue[1:]
		for _, child := range children[id] {
			if seen[child.ID] {
				continue
			}
			seen[child.ID] = true
			queue = append(queue, child.ID)
			if childKey, ok := liveStatusKey(child.AgentServer, child.SessionID); ok && childKey != key {
				keys = append(keys, childKey)
			}
		}
	}
	return keys, nil
}

type ConversationLiveStatusPatch struct {
	Working        *bool
	WaitingForUser *bool
	Unread         *bool
}

func Bool(value bool) *bool {
	return &value
}

func (s *Server) SetConversationLiveStatus(
	ctx context.Context,
	gCtx *glsp.Context,
	agentServer string,
	sessionID string,
	patch ConversationLiveStatusPatch,
) error {
	if s.store == nil {
		return sql.ErrConnDone
	}
	changed := s.applyConversationLiveStatus(agentServer, sessionID, patch)
	if changed {
		s.notifyDidChange(ctx, gCtx)
	}
	return nil
}

func (s *Server) CompletePrompt(ctx context.Context, gCtx *glsp.Context, agentServer string, sessionID string) error {
	key, ok := liveStatusKey(agentServer, sessionID)
	if !ok {
		return nil
	}
	s.mu.Lock()
	active := s.sessionActiveLocked(key)
	s.mu.Unlock()
	return s.SetConversationLiveStatus(ctx, gCtx, agentServer, sessionID, ConversationLiveStatusPatch{
		Working: Bool(false),
		Unread:  Bool(!active),
	})
}

// ClearClientViewState forgets every conversation a client connection reported
// as viewed. Called when a remote client disconnects so its view-state entries
// stop suppressing unread marks. Purely bookkeeping: no visible status changes,
// so nothing is notified.
func (s *Server) ClearClientViewState(originID string) {
	s.mu.Lock()
	delete(s.activeSessions, originID)
	s.mu.Unlock()
}

// sessionActiveLocked reports whether any client connection is viewing the
// conversation. Callers must hold s.mu.
func (s *Server) sessionActiveLocked(key string) bool {
	for _, sessions := range s.activeSessions {
		if sessions[key] {
			return true
		}
	}
	return false
}

func (s *Server) ClearAgentServerInFlightStatus(ctx context.Context, gCtx *glsp.Context, agentServer string) error {
	if s.store == nil {
		return sql.ErrConnDone
	}
	agentServer = normalizeAgentServerName(agentServer)
	prefix := agentServer + "\x00"
	changed := false

	s.mu.Lock()
	for key, status := range s.liveStatuses {
		if !strings.HasPrefix(key, prefix) {
			continue
		}
		if status.Working || status.WaitingForUser {
			status.Working = false
			status.WaitingForUser = false
			s.setLiveStatusLocked(key, status)
			changed = true
		}
	}
	s.mu.Unlock()

	if changed {
		s.notifyDidChange(ctx, gCtx)
	}
	return nil
}

func (s *Server) applyConversationLiveStatus(agentServer, sessionID string, patch ConversationLiveStatusPatch) bool {
	key, ok := liveStatusKey(agentServer, sessionID)
	if !ok {
		return false
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	previous := s.liveStatuses[key]
	next := previous
	if patch.Working != nil {
		next.Working = *patch.Working
	}
	if patch.WaitingForUser != nil {
		next.WaitingForUser = *patch.WaitingForUser
	}
	if patch.Unread != nil {
		next.Unread = *patch.Unread
	}
	if next == previous {
		return false
	}
	s.setLiveStatusLocked(key, next)
	return true
}

func (s *Server) setLiveStatusLocked(key string, status methods.ACPNavConversationLiveStatus) {
	if liveStatusIsEmpty(status) {
		delete(s.liveStatuses, key)
		return
	}
	s.liveStatuses[key] = status
}

func (s *Server) listWithLiveStatus(ctx context.Context) (methods.ACPNavState, error) {
	state, err := s.store.List(ctx)
	if err != nil {
		return methods.ACPNavState{}, err
	}
	state = s.overlayLiveStatus(state)
	if s.stateFilter != nil {
		state = s.stateFilter(state)
	}
	return state, nil
}

func (s *Server) overlayLiveStatus(state methods.ACPNavState) methods.ACPNavState {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range state.Conversations {
		key, ok := liveStatusKey(state.Conversations[i].AgentServer, state.Conversations[i].SessionID)
		if !ok {
			continue
		}
		status, ok := s.liveStatuses[key]
		if !ok || liveStatusIsEmpty(status) {
			state.Conversations[i].LiveStatus = nil
			continue
		}
		statusCopy := status
		state.Conversations[i].LiveStatus = &statusCopy
	}
	return state
}

func (s *Server) notifyDidChange(ctx context.Context, gCtx *glsp.Context) {
	if gCtx == nil {
		return
	}
	state, err := s.listWithLiveStatus(ctx)
	if err != nil {
		slog.Debug("acpnav: failed to list state for didChange notification", "error", err)
		return
	}
	s.notifyState(ctx, gCtx, state)
}

func (s *Server) notifyState(ctx context.Context, gCtx *glsp.Context, state methods.ACPNavState) {
	if gCtx == nil {
		return
	}
	params := methods.ACPNavDidChangeParams{State: state}
	if err := gCtx.Notify(ctx, params.MethodName(), &params); err != nil {
		slog.Debug("acpnav: failed to notify state change", "error", err)
	}
}

func liveStatusKey(agentServer, sessionID string) (string, bool) {
	agentServer = normalizeAgentServerName(agentServer)
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return "", false
	}
	return agentServer + "\x00" + sessionID, true
}

func liveStatusIsEmpty(status methods.ACPNavConversationLiveStatus) bool {
	return !status.Working && !status.WaitingForUser && !status.Unread
}

func (s *Server) DeleteConversation(ctx context.Context, req *methods.ACPNavDeleteConversationParams, _ *glsp.Context) (methods.ACPNavState, error) {
	if s.store == nil {
		return methods.ACPNavState{}, sql.ErrConnDone
	}
	var err error
	if req.ConversationID != "" {
		err = s.store.DeleteConversationByID(ctx, req.ConversationID)
	} else {
		err = s.store.DeleteConversationBySession(ctx, req.AgentServer, req.SessionID)
	}
	if err != nil {
		return methods.ACPNavState{}, err
	}
	return s.store.List(ctx)
}
