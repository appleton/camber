package acpnav

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"embed"
	"encoding/hex"
	"encoding/json"
	stderrors "errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime/trace"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/appleton/camber/pkg/camber-helper/internal/dbmigrate"
	"github.com/appleton/camber/pkg/camber-helper/methods"
	"github.com/appleton/camber/pkg/common/userconfig"
	_ "github.com/mattn/go-sqlite3"
	"github.com/pkg/errors"
)

const migrationsTable = "acp_nav_migrations"
const DBName = "acp-nav-v1"
const agentServersSeededKey = "agent_servers_seeded"
const defaultAgentServerKey = "default_agent_server"
const fileOpenerKey = "file_opener"
const keybindingsKey = "keybindings"
const githubColorModeKey = "github_color_mode"
const defaultAgentServerName = "poolside"
const chatWorkspacePath = "CHAT"
const ideWorkspacePath = "IDE"

//go:embed migrations/*.sql
var migrationsFS embed.FS

type Store struct {
	db         *sql.DB
	worktreeMu sync.Mutex
	repoLocks  sync.Map
	// runGit runs git with args. A non-nil env replaces any git config
	// overrides inherited from the helper's environment and is appended to
	// it (see runGitCommand).
	runGit func(ctx context.Context, env []string, args ...string) ([]byte, error)
	// preparedWorktrees holds worktree paths reserved by PrepareWorktree but
	// not yet realized by CreateWorktree. Reservations are in-memory only so
	// that a crash between prepare and create cannot orphan DB rows; the
	// trade-off is that pending reservations are lost on process restart,
	// which is fine because the on-disk worktree does not exist yet either.
	preparedWorktrees map[string]struct{}
	// archivedSessionCloser closes sessions of descendants archived by the
	// cascade; see Server.SetArchivedSessionCloser.
	archivedSessionCloser atomic.Pointer[ArchivedSessionCloser]
	// linksMu guards parentLinks, a lazily loaded cache of control-state
	// parent/root links keyed by conversation id (nil until first load). It is
	// kept coherent by writeControlState, the only writer of control state.
	linksMu     sync.Mutex
	parentLinks map[string]controlLink
}

type controlLink struct {
	ParentID string `json:"parentId"`
	RootID   string `json:"rootId"`
}

func Open(ctx context.Context, dbPath string) (*Store, error) {
	region := trace.StartRegion(ctx, "acpnav.open")
	defer region.End()
	params := url.Values{
		"mode":          {"rwc"},
		"_busy_timeout": {"5000"},
		"_foreign_keys": {"true"},
	}
	db, err := sql.Open("sqlite3", fmt.Sprintf("file:%s?%s", dbPath, params.Encode()))
	if err != nil {
		return nil, errors.WithStack(err)
	}

	if _, err := db.ExecContext(ctx, "PRAGMA journal_mode=WAL"); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("enabling acp nav wal mode: %w", err)
	}

	migrationRegion := trace.StartRegion(ctx, "acpnav.migrations")
	_, migrationErr := dbmigrate.Migrate(dbmigrate.Config{
		DB:              db,
		MigrationsFS:    migrationsFS,
		MigrationsDir:   "migrations",
		MigrationsTable: migrationsTable,
	})
	migrationRegion.End()
	if migrationErr != nil {
		_ = db.Close()
		return nil, fmt.Errorf("migrating acp nav db: %w", migrationErr)
	}

	store := &Store{db: db, preparedWorktrees: map[string]struct{}{}, runGit: runGitCommand}
	if _, err := store.reconcileArchivedOrphans(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("reconciling archived sub-agents: %w", err)
	}
	return store, nil
}

// runGitCommand runs git. With a nil env git inherits the helper's
// environment unchanged. Otherwise env is appended to the helper's
// environment minus its command-line config (GIT_CONFIG_PARAMETERS,
// GIT_CONFIG_COUNT and its numbered keys), so the overrides in env are the
// only command-scope configuration git sees.
func runGitCommand(ctx context.Context, env []string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	if env != nil {
		cmd.Env = append(withoutGitConfigEnv(os.Environ()), env...)
	}
	return cmd.CombinedOutput()
}

func (s *Store) repoLock(parentPath string) *sync.Mutex {
	v, _ := s.repoLocks.LoadOrStore(cleanPath(parentPath), &sync.Mutex{})
	return v.(*sync.Mutex)
}

func (s *Store) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *Store) List(ctx context.Context) (methods.ACPNavState, error) {
	projects, err := s.listProjects(ctx)
	if err != nil {
		return methods.ACPNavState{}, err
	}
	conversations, err := s.listConversations(ctx)
	if err != nil {
		return methods.ACPNavState{}, err
	}
	return methods.ACPNavState{Projects: projects, Conversations: conversations}, nil
}

func (s *Store) ListAgentServers(ctx context.Context) (methods.ACPAgentServers, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT name, command, args_json, env_json, binary_json, default_config_options_json
FROM agent_servers
ORDER BY name COLLATE NOCASE ASC
`)
	if err != nil {
		return nil, fmt.Errorf("listing agent servers: %w", err)
	}
	defer rows.Close()

	agentServers := methods.ACPAgentServers{}
	for rows.Next() {
		var name, argsJSON, envJSON, binaryJSON, defaultConfigOptionsJSON string
		var cfg methods.ACPAgentServerConfig
		if err := rows.Scan(&name, &cfg.Command, &argsJSON, &envJSON, &binaryJSON, &defaultConfigOptionsJSON); err != nil {
			return nil, fmt.Errorf("scanning agent server: %w", err)
		}
		if err := decodeJSONField(argsJSON, &cfg.Args); err != nil {
			return nil, fmt.Errorf("decoding args for agent server %q: %w", name, err)
		}
		if err := decodeJSONField(envJSON, &cfg.Env); err != nil {
			return nil, fmt.Errorf("decoding env for agent server %q: %w", name, err)
		}
		if err := decodeJSONField(binaryJSON, &cfg.Binary); err != nil {
			return nil, fmt.Errorf("decoding binary config for agent server %q: %w", name, err)
		}
		if err := decodeJSONField(defaultConfigOptionsJSON, &cfg.DefaultConfigOptions); err != nil {
			return nil, fmt.Errorf("decoding default config options for agent server %q: %w", name, err)
		}
		if len(cfg.Args) == 0 {
			cfg.Args = nil
		}
		if len(cfg.Env) == 0 {
			cfg.Env = nil
		}
		if len(cfg.Binary) == 0 {
			cfg.Binary = nil
		}
		if len(cfg.DefaultConfigOptions) == 0 {
			cfg.DefaultConfigOptions = nil
		}
		agentServers[name] = cfg
	}
	return agentServers, rows.Err()
}

func (s *Store) GetDefaultAgentServer(ctx context.Context) (string, error) {
	var agentServer string
	err := s.db.QueryRowContext(ctx, `SELECT value FROM metadata WHERE key = ?`, defaultAgentServerKey).Scan(&agentServer)
	if stderrors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("getting default agent server: %w", err)
	}
	return normalizeAgentServerName(agentServer), nil
}

// GetDefaultAgentServerPinned reports whether the default agent server choice
// was explicitly pinned. The legacy SQLite store predates pinned defaults and
// never persists the flag, so migrated configurations start unpinned.
func (s *Store) GetDefaultAgentServerPinned(ctx context.Context) (bool, error) {
	_ = ctx
	return false, nil
}

func (s *Store) SetDefaultAgentServer(ctx context.Context, agentServer string) error {
	agentServer = strings.TrimSpace(normalizeAgentServerName(agentServer))
	if agentServer == "" {
		_, err := s.db.ExecContext(ctx, `DELETE FROM metadata WHERE key = ?`, defaultAgentServerKey)
		if err != nil {
			return fmt.Errorf("clearing default agent server: %w", err)
		}
		return nil
	}
	_, err := s.db.ExecContext(ctx, `
INSERT INTO metadata(key, value)
VALUES (?, ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value
`, defaultAgentServerKey, agentServer)
	if err != nil {
		return fmt.Errorf("setting default agent server: %w", err)
	}
	return nil
}

// GetFileOpener returns the user's preferred desktop file opener id, or an empty
// string when no explicit choice has been persisted.
func (s *Store) GetFileOpener(ctx context.Context) (string, error) {
	var fileOpener string
	err := s.db.QueryRowContext(ctx, `SELECT value FROM metadata WHERE key = ?`, fileOpenerKey).Scan(&fileOpener)
	if stderrors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("getting file opener: %w", err)
	}
	return strings.TrimSpace(fileOpener), nil
}

// SetFileOpener persists the user's preferred desktop file opener id. An empty
// id clears the preference so the client falls back to its platform default.
func (s *Store) SetFileOpener(ctx context.Context, fileOpener string) error {
	fileOpener = strings.TrimSpace(fileOpener)
	if fileOpener == "" {
		if _, err := s.db.ExecContext(ctx, `DELETE FROM metadata WHERE key = ?`, fileOpenerKey); err != nil {
			return fmt.Errorf("clearing file opener: %w", err)
		}
		return nil
	}
	_, err := s.db.ExecContext(ctx, `
INSERT INTO metadata(key, value)
VALUES (?, ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value
`, fileOpenerKey, fileOpener)
	if err != nil {
		return fmt.Errorf("setting file opener: %w", err)
	}
	return nil
}

// GetGithubColorMode returns the user's worktree status color mode, or an empty
// string when no explicit choice has been persisted (the client defaults it).
func (s *Store) GetGithubColorMode(ctx context.Context) (string, error) {
	var mode string
	err := s.db.QueryRowContext(ctx, `SELECT value FROM metadata WHERE key = ?`, githubColorModeKey).Scan(&mode)
	if stderrors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("getting github color mode: %w", err)
	}
	return strings.TrimSpace(mode), nil
}

// SetGithubColorMode persists the user's worktree status color mode. An empty
// value clears the preference.
func (s *Store) SetGithubColorMode(ctx context.Context, mode string) error {
	mode = strings.TrimSpace(mode)
	if mode == "" {
		if _, err := s.db.ExecContext(ctx, `DELETE FROM metadata WHERE key = ?`, githubColorModeKey); err != nil {
			return fmt.Errorf("clearing github color mode: %w", err)
		}
		return nil
	}
	_, err := s.db.ExecContext(ctx, `
INSERT INTO metadata(key, value)
VALUES (?, ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value
`, githubColorModeKey, mode)
	if err != nil {
		return fmt.Errorf("setting github color mode: %w", err)
	}
	return nil
}

// GetKeybindings returns the user's desktop keyboard-shortcut overrides, or an
// empty map when none have been persisted.
func (s *Store) GetKeybindings(ctx context.Context) (methods.ACPNavKeybindings, error) {
	var raw string
	err := s.db.QueryRowContext(ctx, `SELECT value FROM metadata WHERE key = ?`, keybindingsKey).Scan(&raw)
	if stderrors.Is(err, sql.ErrNoRows) {
		return methods.ACPNavKeybindings{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("getting keybindings: %w", err)
	}
	if strings.TrimSpace(raw) == "" {
		return methods.ACPNavKeybindings{}, nil
	}
	var keybindings methods.ACPNavKeybindings
	if err := json.Unmarshal([]byte(raw), &keybindings); err != nil {
		return nil, fmt.Errorf("decoding keybindings: %w", err)
	}
	if keybindings == nil {
		keybindings = methods.ACPNavKeybindings{}
	}
	return keybindings, nil
}

// SetKeybindings replaces the persisted desktop keyboard-shortcut overrides. An
// empty map clears the preference so every command falls back to its default.
func (s *Store) SetKeybindings(ctx context.Context, keybindings methods.ACPNavKeybindings) error {
	if len(keybindings) == 0 {
		if _, err := s.db.ExecContext(ctx, `DELETE FROM metadata WHERE key = ?`, keybindingsKey); err != nil {
			return fmt.Errorf("clearing keybindings: %w", err)
		}
		return nil
	}
	blob, err := json.Marshal(keybindings)
	if err != nil {
		return fmt.Errorf("encoding keybindings: %w", err)
	}
	_, err = s.db.ExecContext(ctx, `
INSERT INTO metadata(key, value)
VALUES (?, ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value
`, keybindingsKey, string(blob))
	if err != nil {
		return fmt.Errorf("setting keybindings: %w", err)
	}
	return nil
}

func (s *Store) SetAgentServers(ctx context.Context, agentServers methods.ACPAgentServers, defaultAgentServer *string, defaultAgentServerPinned *bool) error {
	// The legacy SQLite store predates pinned defaults and never persists them;
	// the assistant config store owns the pinned flag.
	_ = defaultAgentServerPinned
	normalized, err := normalizeAgentServers(agentServers)
	if err != nil {
		return err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("starting tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx, `DELETE FROM agent_servers`); err != nil {
		return fmt.Errorf("clearing agent servers: %w", err)
	}
	if err := insertAgentServers(ctx, tx, normalized); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO metadata(key, value)
VALUES (?, 'true')
ON CONFLICT(key) DO UPDATE SET value = excluded.value
`, agentServersSeededKey); err != nil {
		return fmt.Errorf("recording agent server seed marker: %w", err)
	}
	if defaultAgentServer != nil {
		agentServer := strings.TrimSpace(normalizeAgentServerName(*defaultAgentServer))
		if agentServer == "" {
			if _, err := tx.ExecContext(ctx, `DELETE FROM metadata WHERE key = ?`, defaultAgentServerKey); err != nil {
				return fmt.Errorf("clearing default agent server: %w", err)
			}
		} else if _, err := tx.ExecContext(ctx, `
INSERT INTO metadata(key, value)
VALUES (?, ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value
`, defaultAgentServerKey, agentServer); err != nil {
			return fmt.Errorf("recording default agent server: %w", err)
		}
	}
	return tx.Commit()
}

func (s *Store) GetConfigCache(ctx context.Context, agentServer string) (*methods.ACPNavConfigCacheEntry, error) {
	agentServer = strings.TrimSpace(normalizeAgentServerName(agentServer))
	if agentServer == "" {
		return nil, fmt.Errorf("agentServer is required")
	}

	var entry methods.ACPNavConfigCacheEntry
	var configOptionsJSON, modesJSON, availableCommandsJSON, promptCapabilitiesJSON, agentInfoJSON string
	err := s.db.QueryRowContext(ctx, `
SELECT agent_server, config_options_json, modes_json, available_commands_json, prompt_capabilities_json, agent_info_json, cached_at
FROM acp_config_cache
WHERE agent_server = ?
`, agentServer).Scan(
		&entry.AgentServer,
		&configOptionsJSON,
		&modesJSON,
		&availableCommandsJSON,
		&promptCapabilitiesJSON,
		&agentInfoJSON,
		&entry.CachedAt,
	)
	if stderrors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("getting ACP config cache for %q: %w", agentServer, err)
	}
	entry.ConfigOptions = json.RawMessage(configOptionsJSON)
	entry.Modes = json.RawMessage(modesJSON)
	entry.AvailableCommands = json.RawMessage(availableCommandsJSON)
	entry.PromptCapabilities = json.RawMessage(promptCapabilitiesJSON)
	entry.AgentInfo = json.RawMessage(agentInfoJSON)
	return &entry, nil
}

func (s *Store) UpsertConfigCache(ctx context.Context, entry methods.ACPNavUpsertConfigCacheParams) (*methods.ACPNavConfigCacheEntry, error) {
	agentServer := strings.TrimSpace(normalizeAgentServerName(entry.AgentServer))
	if agentServer == "" {
		return nil, fmt.Errorf("agentServer is required")
	}
	configOptionsJSON := rawJSONOrDefault(entry.ConfigOptions, "[]")
	modesJSON := rawJSONOrDefault(entry.Modes, "null")
	availableCommandsJSON := rawJSONOrDefault(entry.AvailableCommands, "[]")
	promptCapabilitiesJSON := rawJSONOrDefault(entry.PromptCapabilities, "null")
	agentInfoJSON := rawJSONOrDefault(entry.AgentInfo, "null")
	cachedAt := nowString()

	_, err := s.db.ExecContext(ctx, `
INSERT INTO acp_config_cache(agent_server, config_options_json, modes_json, available_commands_json, prompt_capabilities_json, agent_info_json, cached_at)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(agent_server) DO UPDATE SET
  config_options_json = excluded.config_options_json,
  modes_json = excluded.modes_json,
  available_commands_json = excluded.available_commands_json,
  prompt_capabilities_json = excluded.prompt_capabilities_json,
  agent_info_json = excluded.agent_info_json,
  cached_at = excluded.cached_at
`, agentServer, configOptionsJSON, modesJSON, availableCommandsJSON, promptCapabilitiesJSON, agentInfoJSON, cachedAt)
	if err != nil {
		return nil, fmt.Errorf("upserting ACP config cache for %q: %w", agentServer, err)
	}

	return &methods.ACPNavConfigCacheEntry{
		AgentServer:        agentServer,
		ConfigOptions:      json.RawMessage(configOptionsJSON),
		Modes:              json.RawMessage(modesJSON),
		AvailableCommands:  json.RawMessage(availableCommandsJSON),
		PromptCapabilities: json.RawMessage(promptCapabilitiesJSON),
		AgentInfo:          json.RawMessage(agentInfoJSON),
		CachedAt:           cachedAt,
	}, nil
}

func (s *Store) SeedAgentServersIfNeeded(ctx context.Context, agentServers methods.ACPAgentServers) error {
	var seeded string
	err := s.db.QueryRowContext(ctx, `SELECT value FROM metadata WHERE key = ?`, agentServersSeededKey).Scan(&seeded)
	if err == nil {
		return nil
	}
	if !stderrors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("checking agent server seed marker: %w", err)
	}

	normalized, err := normalizeAgentServers(agentServers)
	if err != nil {
		return err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("starting tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if err := insertAgentServers(ctx, tx, normalized); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO metadata(key, value) VALUES (?, 'true')`, agentServersSeededKey); err != nil {
		return fmt.Errorf("recording agent server seed marker: %w", err)
	}
	return tx.Commit()
}

func (s *Store) UpsertProject(ctx context.Context, p methods.ACPNavUpsertProjectParams) (methods.ACPNavProject, error) {
	p, parent := normalizeProjectForNav(p)
	if p.Path == "" {
		return methods.ACPNavProject{}, fmt.Errorf("project path is required")
	}
	now := nowString()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return methods.ACPNavProject{}, fmt.Errorf("starting tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if parent != nil {
		if err := s.upsertProjectTx(ctx, tx, *parent, now); err != nil {
			return methods.ACPNavProject{}, err
		}
	}
	if err := s.upsertProjectTx(ctx, tx, p, now); err != nil {
		return methods.ACPNavProject{}, err
	}
	if err := tx.Commit(); err != nil {
		return methods.ACPNavProject{}, fmt.Errorf("committing project upsert: %w", err)
	}
	return methods.ACPNavProject{
		Path:         p.Path,
		Name:         p.Name,
		IsWorktree:   p.IsWorktree,
		ParentPath:   p.ParentPath,
		Collapsed:    false,
		DisplayOrder: 0,
		CreatedAt:    now,
		UpdatedAt:    now,
	}, nil
}

type dbExecutor interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func (s *Store) upsertProjectTx(ctx context.Context, db dbExecutor, p methods.ACPNavUpsertProjectParams, now string) error {
	// New root projects land last (MAX+1); new worktrees land first (MIN-1)
	// within their parent. display_order is preserved on conflict so existing
	// rows keep their persisted order.
	_, err := db.ExecContext(ctx, `
INSERT INTO projects(path, name, is_worktree, parent_path, collapsed, display_order, created_at, updated_at)
VALUES (?, ?, ?, ?, 0, CASE
  WHEN ? = 0 THEN (SELECT COALESCE(MAX(display_order), -1) + 1 FROM projects WHERE is_worktree = 0)
  ELSE (SELECT COALESCE(MIN(display_order), 0) - 1 FROM projects WHERE is_worktree = 1 AND parent_path = ?)
END, ?, ?)
ON CONFLICT(path) DO UPDATE SET
  name = excluded.name,
  is_worktree = excluded.is_worktree,
  parent_path = excluded.parent_path,
  updated_at = excluded.updated_at
`, p.Path, p.Name, boolInt(p.IsWorktree), p.ParentPath, boolInt(p.IsWorktree), p.ParentPath, now, now)
	if err != nil {
		return fmt.Errorf("upserting project: %w", err)
	}
	return nil
}

func (s *Store) SetProjectCollapsed(ctx context.Context, path string, collapsed bool) error {
	path = cleanPath(path)
	if path == "" {
		return fmt.Errorf("project path is required")
	}
	_, err := s.db.ExecContext(ctx, `
UPDATE projects
SET collapsed = ?, updated_at = ?
WHERE path = ?
`, boolInt(collapsed), nowString(), path)
	if err != nil {
		return fmt.Errorf("setting project collapsed: %w", err)
	}
	return nil
}

func (s *Store) RenameProject(ctx context.Context, path, name string) error {
	path = cleanPath(path)
	name = strings.TrimSpace(name)
	if path == "" {
		return fmt.Errorf("project path is required")
	}
	if name == "" {
		return fmt.Errorf("project name is required")
	}

	result, err := s.db.ExecContext(ctx, `
UPDATE projects
SET name = CASE WHEN is_worktree = 0 THEN ? ELSE name END,
    nickname = ?,
    updated_at = ?
WHERE path = ?
`, name, name, nowString(), path)
	if err != nil {
		return fmt.Errorf("renaming project: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("checking project rename: %w", err)
	}
	if affected == 0 {
		return fmt.Errorf("project not found: %s", path)
	}
	return nil
}

func (s *Store) ReorderProjects(ctx context.Context, paths []string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("starting project reorder: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	now := nowString()
	for index, path := range paths {
		path = cleanPath(path)
		if path == "" {
			return fmt.Errorf("project path is required")
		}
		result, err := tx.ExecContext(ctx, `
UPDATE projects
SET display_order = ?, updated_at = ?
WHERE path = ? AND is_worktree = 0
`, index, now, path)
		if err != nil {
			return fmt.Errorf("reordering project: %w", err)
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return fmt.Errorf("checking project reorder: %w", err)
		}
		if affected == 0 {
			return fmt.Errorf("root project not found: %s", path)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("committing project reorder: %w", err)
	}
	return nil
}

func (s *Store) ReorderWorktrees(ctx context.Context, parentPath string, paths []string) error {
	parentPath = cleanPath(parentPath)
	if parentPath == "" {
		return fmt.Errorf("parent path is required")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("starting worktree reorder: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	now := nowString()
	for index, path := range paths {
		path = cleanPath(path)
		if path == "" {
			return fmt.Errorf("worktree path is required")
		}
		result, err := tx.ExecContext(ctx, `
UPDATE projects
SET display_order = ?, updated_at = ?
WHERE path = ? AND is_worktree = 1 AND parent_path = ?
`, index, now, path, parentPath)
		if err != nil {
			return fmt.Errorf("reordering worktree: %w", err)
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return fmt.Errorf("checking worktree reorder: %w", err)
		}
		if affected == 0 {
			return fmt.Errorf("worktree not found: %s", path)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("committing worktree reorder: %w", err)
	}
	return nil
}

func (s *Store) GetProjectSettings(ctx context.Context, path string) (methods.ACPNavProjectSettings, error) {
	path = cleanPath(path)
	if path == "" {
		return methods.ACPNavProjectSettings{}, fmt.Errorf("project path is required")
	}
	var settings methods.ACPNavProjectSettings
	err := s.db.QueryRowContext(ctx, `
SELECT path, setup_script, teardown_script, user_prompt
FROM projects
WHERE path = ?
`, path).Scan(&settings.Path, &settings.SetupScript, &settings.TeardownScript, &settings.UserPrompt)
	if stderrors.Is(err, sql.ErrNoRows) {
		return methods.ACPNavProjectSettings{}, fmt.Errorf("project not found: %s", path)
	}
	if err != nil {
		return methods.ACPNavProjectSettings{}, fmt.Errorf("getting project settings: %w", err)
	}
	return settings, nil
}

func (s *Store) SetProjectSettings(ctx context.Context, settings methods.ACPNavSetProjectSettingsParams) (methods.ACPNavProjectSettings, error) {
	path := cleanPath(settings.Path)
	if path == "" {
		return methods.ACPNavProjectSettings{}, fmt.Errorf("project path is required")
	}
	setupScript := strings.TrimSpace(settings.SetupScript)
	teardownScript := strings.TrimSpace(settings.TeardownScript)
	userPrompt := strings.TrimSpace(settings.UserPrompt)
	result, err := s.db.ExecContext(ctx, `
UPDATE projects
SET setup_script = ?, teardown_script = ?, user_prompt = ?, updated_at = ?
WHERE path = ?
`, setupScript, teardownScript, userPrompt, nowString(), path)
	if err != nil {
		return methods.ACPNavProjectSettings{}, fmt.Errorf("setting project settings: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return methods.ACPNavProjectSettings{}, fmt.Errorf("checking project settings update: %w", err)
	}
	if rows == 0 {
		return methods.ACPNavProjectSettings{}, fmt.Errorf("project not found: %s", path)
	}
	return methods.ACPNavProjectSettings{
		Path:           path,
		SetupScript:    setupScript,
		TeardownScript: teardownScript,
		UserPrompt:     userPrompt,
	}, nil
}

// PrepareWorktree reserves a worktree name for a project. The reservation
// is held in memory (see Store.preparedWorktrees) and freed by either
// CreateWorktree or ReleasePreparedWorktree. No DB row is written here, so a
// process crash before CreateWorktree cannot leave behind an orphan project.
func (s *Store) PrepareWorktree(ctx context.Context, projectPath string) (methods.ACPNavProject, error) {
	s.worktreeMu.Lock()
	defer s.worktreeMu.Unlock()

	projectPath = cleanPath(projectPath)
	if projectPath == "" {
		return methods.ACPNavProject{}, fmt.Errorf("project path is required")
	}
	parent := worktreeStorageDir(projectPath)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return methods.ACPNavProject{}, fmt.Errorf("creating worktree storage dir: %w", err)
	}
	worktreeName, err := s.generateAvailableWorktreeName(ctx, projectPath, parent)
	if err != nil {
		return methods.ACPNavProject{}, fmt.Errorf("generating worktree name: %w", err)
	}
	worktreePath := filepath.Join(parent, worktreeName)
	s.preparedWorktrees[worktreePath] = struct{}{}

	parentPath := projectPath
	now := nowString()
	return methods.ACPNavProject{
		Path:       worktreePath,
		Name:       worktreeName,
		IsWorktree: true,
		ParentPath: &parentPath,
		CreatedAt:  now,
		UpdatedAt:  now,
	}, nil
}

// ReleasePreparedWorktree frees a reservation created by PrepareWorktree.
// Idempotent: releasing an unknown path is not an error.
func (s *Store) ReleasePreparedWorktree(path string) {
	s.worktreeMu.Lock()
	defer s.worktreeMu.Unlock()
	delete(s.preparedWorktrees, cleanPath(path))
}

func (s *Store) CreateWorktree(ctx context.Context, projectPath, worktreeName string) (methods.ACPNavProject, error) {
	return s.createWorktree(ctx, projectPath, worktreeName, false)
}

// CreateWorktreeIsolated is CreateWorktree for automation: git runs with repo
// hooks and fsmonitor disabled so repo-controlled code is not executed.
func (s *Store) CreateWorktreeIsolated(ctx context.Context, projectPath, worktreeName string) (methods.ACPNavProject, error) {
	return s.createWorktree(ctx, projectPath, worktreeName, true)
}

func (s *Store) createWorktree(ctx context.Context, projectPath, worktreeName string, isolated bool) (methods.ACPNavProject, error) {
	projectPath = cleanPath(projectPath)
	if projectPath == "" {
		return methods.ACPNavProject{}, fmt.Errorf("project path is required")
	}
	worktreeName = strings.TrimSpace(worktreeName)
	if worktreeName != "" && worktreeName != filepath.Base(worktreeName) {
		return methods.ACPNavProject{}, fmt.Errorf("worktree name must not contain path separators")
	}
	parent := worktreeStorageDir(projectPath)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return methods.ACPNavProject{}, fmt.Errorf("creating worktree storage dir: %w", err)
	}

	s.worktreeMu.Lock()
	if worktreeName == "" {
		var err error
		worktreeName, err = s.generateAvailableWorktreeName(ctx, projectPath, parent)
		if err != nil {
			s.worktreeMu.Unlock()
			return methods.ACPNavProject{}, fmt.Errorf("generating worktree name: %w", err)
		}
		worktreePath := filepath.Join(parent, worktreeName)
		s.preparedWorktrees[worktreePath] = struct{}{}
	}
	worktreePath := filepath.Join(parent, worktreeName)
	_, owned := s.preparedWorktrees[worktreePath]
	s.worktreeMu.Unlock()

	branch := worktreeBranch(worktreeName)

	rl := s.repoLock(projectPath)
	rl.Lock()
	var err error
	if isolated {
		err = s.addWorktreeIsolated(ctx, projectPath, branch, worktreePath)
	} else {
		var out []byte
		if out, err = s.runGit(ctx, nil, "-C", projectPath, "worktree", "add", "-b", branch, worktreePath); err != nil {
			err = fmt.Errorf("git worktree add failed: %w: %s", err, strings.TrimSpace(string(out)))
		}
	}
	rl.Unlock()
	if err != nil {
		s.worktreeMu.Lock()
		delete(s.preparedWorktrees, worktreePath)
		s.worktreeMu.Unlock()
		if owned {
			_ = os.RemoveAll(worktreePath)
		}
		return methods.ACPNavProject{}, err
	}

	s.worktreeMu.Lock()
	delete(s.preparedWorktrees, worktreePath)
	s.worktreeMu.Unlock()

	parentPath := projectPath
	return s.UpsertProject(ctx, methods.ACPNavUpsertProjectParams{
		Path:       worktreePath,
		Name:       worktreeName,
		IsWorktree: true,
		ParentPath: &parentPath,
	})
}

// generateAvailableWorktreeName picks an unused alliterative name, rejecting
// any candidate that collides with an on-disk path, a local git branch, an
// existing project row, or an in-flight PrepareWorktree reservation.
//
// Must be called with worktreeMu held.
func (s *Store) generateAvailableWorktreeName(ctx context.Context, projectPath, parentPath string) (string, error) {
	name, err := randomAlliterativeWorktreeName()
	if err != nil {
		return "", err
	}
	var collisionErr error
	chosen := uniqueWorktreeName(name, func(candidate string) bool {
		candidatePath := filepath.Join(parentPath, candidate)
		if _, reserved := s.preparedWorktrees[candidatePath]; reserved {
			return true
		}
		if pathExists(candidatePath) {
			return true
		}
		if localBranchExists(ctx, projectPath, worktreeBranch(candidate)) {
			return true
		}
		exists, err := s.projectExists(ctx, candidatePath)
		if err != nil && collisionErr == nil {
			collisionErr = err
		}
		return exists
	})
	if collisionErr != nil {
		return "", collisionErr
	}
	return chosen, nil
}

func (s *Store) projectExists(ctx context.Context, path string) (bool, error) {
	var exists int
	err := s.db.QueryRowContext(ctx, `SELECT 1 FROM projects WHERE path = ?`, cleanPath(path)).Scan(&exists)
	if stderrors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("checking project path: %w", err)
	}
	return true, nil
}

func worktreeStorageDir(projectPath string) string {
	return filepath.Join(userconfig.StateDirectory(), "worktrees", projectStorageName(projectPath))
}

func projectStorageName(projectPath string) string {
	sum := sha256.Sum256([]byte(projectPath))
	return fmt.Sprintf("%s-%s", filepath.Base(projectPath), hex.EncodeToString(sum[:])[:12])
}

func (s *Store) UpsertConversation(ctx context.Context, c methods.ACPNavConversation) error {
	c.ID = strings.TrimSpace(c.ID)
	c.WorkspacePath = cleanWorkspacePath(c.WorkspacePath)
	c.Cwd = cleanPath(c.Cwd)
	c.AgentServer = strings.TrimSpace(c.AgentServer)
	c.SessionID = strings.TrimSpace(c.SessionID)
	if c.WorkspacePath == "" || c.AgentServer == "" {
		return fmt.Errorf("workspacePath and agentServer are required")
	}
	if c.Cwd == "" {
		c.Cwd = c.WorkspacePath
	}
	c.WorkingDirectories = normalizeWorkingDirectories(c.WorkingDirectories, c.Cwd)
	if c.ID == "" && c.SessionID != "" {
		id, err := s.conversationIDForSession(ctx, c.WorkspacePath, c.AgentServer, c.SessionID)
		if err != nil {
			return err
		}
		c.ID = id
	}
	if c.ID == "" {
		id, err := newConversationID()
		if err != nil {
			return err
		}
		c.ID = id
	}
	insertedArchived, err := s.upsertConversationTx(ctx, s.db, c, nowString())
	if err != nil {
		return err
	}
	if insertedArchived && c.SessionID != "" {
		s.closeArchivedSessions(ctx, []archivedSession{{AgentServer: c.AgentServer, SessionID: c.SessionID}})
	}
	return nil
}

// UpdateConversationTitle updates every nav record bound to the agent session.
// It deliberately leaves nickname and archive state untouched: nicknames keep
// display precedence, while the latest agent title remains available beneath
// them and after an archive/restore cycle.
func (s *Store) UpdateConversationTitle(ctx context.Context, agentServer, sessionID, title string) (bool, error) {
	agentServer = strings.TrimSpace(agentServer)
	sessionID = strings.TrimSpace(sessionID)
	title = strings.TrimSpace(title)
	if agentServer == "" || sessionID == "" || title == "" {
		return false, nil
	}
	result, err := s.db.ExecContext(ctx, `
UPDATE conversations
SET title = ?, touched_at = ?
WHERE agent_server = ? AND session_id = ? AND title != ?
`, title, nowString(), agentServer, sessionID, title)
	if err != nil {
		return false, fmt.Errorf("updating conversation title: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("checking updated conversation title count: %w", err)
	}
	return affected > 0, nil
}

// upsertConversationTx creates pending rows and enriches existing rows. Once a
// row has a session, only the helper's BindConversationSession methods may
// change its agent/session binding; client upserts can arrive late after a
// handoff and therefore cannot be authoritative for those two fields. An
// archived sub-agent stays archived: late saves from its still-finishing turn
// (control turn records, client metadata) must not revive it after the parent
// cascade archived it. RestoreConversation unarchives explicitly.
//
// A NEW row whose control parent link points at an archived conversation is
// inserted archived (the spawn can race the parent's archive cascade); the
// returned bool reports that so the caller can close its session.
func (s *Store) upsertConversationTx(ctx context.Context, db dbExecutor, c methods.ACPNavConversation, now string) (bool, error) {
	workingDirectoriesJSON, err := marshalJSONField(c.WorkingDirectories, []string{})
	if err != nil {
		return false, fmt.Errorf("encoding conversation working directories: %w", err)
	}
	metadataJSON := strings.TrimSpace(rawJSONOrDefault(c.Metadata, ""))
	var existing int
	existed := true
	if err := db.QueryRowContext(ctx, `SELECT 1 FROM conversations WHERE id = ?`, c.ID).Scan(&existing); err != nil {
		if !stderrors.Is(err, sql.ErrNoRows) {
			return false, fmt.Errorf("checking conversation: %w", err)
		}
		existed = false
	}
	_, err = db.ExecContext(ctx, `
INSERT INTO conversations(id, workspace_path, agent_server, session_id, cwd, title, nickname, updated_at, active, archived, working_directories_json, metadata_json, created_at, touched_at)
VALUES (?, ?, ?, NULLIF(?, ''), ?, ?, ?, ?, 1, `+parentArchivedSQL+`, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  workspace_path = excluded.workspace_path,
  agent_server = CASE
    WHEN conversations.session_id IS NOT NULL THEN conversations.agent_server
    ELSE excluded.agent_server
  END,
  session_id = COALESCE(conversations.session_id, excluded.session_id),
  cwd = excluded.cwd,
  working_directories_json = excluded.working_directories_json,
  metadata_json = CASE WHEN excluded.metadata_json != '' THEN excluded.metadata_json ELSE conversations.metadata_json END,
  title = CASE WHEN excluded.title != '' THEN excluded.title ELSE conversations.title END,
  nickname = CASE WHEN excluded.nickname != '' THEN excluded.nickname ELSE conversations.nickname END,
  updated_at = CASE WHEN excluded.updated_at != '' THEN excluded.updated_at ELSE conversations.updated_at END,
  active = 1,
  archived = CASE
    WHEN conversations.archived != 0 AND EXISTS (
      SELECT 1 FROM metadata
      WHERE metadata.key = 'control/conversation/' || conversations.id
        AND COALESCE(json_extract(metadata.value, '$.parentId'), '') != ''
    ) THEN 1
    ELSE 0
  END,
  touched_at = CASE
    WHEN excluded.session_id IS NULL AND excluded.updated_at = '' THEN conversations.touched_at
    ELSE excluded.touched_at
  END
`, c.ID, c.WorkspacePath, c.AgentServer, c.SessionID, c.Cwd, c.Title, c.Nickname, c.UpdatedAt, c.ID, workingDirectoriesJSON, metadataJSON, now, now)
	if err != nil {
		return false, fmt.Errorf("upserting conversation: %w", err)
	}
	if existed {
		return false, nil
	}
	var archived int
	if err := db.QueryRowContext(ctx, `SELECT archived FROM conversations WHERE id = ?`, c.ID).Scan(&archived); err != nil {
		return false, fmt.Errorf("reading inserted conversation: %w", err)
	}
	return archived != 0, nil
}

// parentArchivedSQL evaluates to 1 when the (bound) conversation id's control
// state names a parent that is archived, else 0.
const parentArchivedSQL = `CASE WHEN EXISTS (
  SELECT 1 FROM conversations parent
  WHERE parent.archived != 0
    AND parent.id = (SELECT COALESCE(json_extract(m.value, '$.parentId'), '') FROM metadata m WHERE m.key = 'control/conversation/' || ?)
) THEN 1 ELSE 0 END`

// BindConversationSession records the session id the agent created for a
// conversation. Called by the helper itself at session/new time (it proxies
// the call), so the nav row carries a bindable session key before any live
// status for that session can exist — the client's later metadata upsert is
// enrichment, not the load-bearing binding. Touches nothing but the session
// id on an existing row; inserts a minimal active row if the conversation's
// pending upsert has not landed (e.g. lost on a flaky remote socket).
func (s *Store) BindConversationSession(ctx context.Context, conversationID, agentServer, sessionID, cwd string) error {
	return bindConversationSession(ctx, s.db, conversationID, agentServer, sessionID, cwd)
}

func bindConversationSession(ctx context.Context, db dbExecutor, conversationID, agentServer, sessionID, cwd string) error {
	conversationID = strings.TrimSpace(conversationID)
	agentServer = strings.TrimSpace(agentServer)
	sessionID = strings.TrimSpace(sessionID)
	cwd = cleanPath(cwd)
	if conversationID == "" || agentServer == "" || sessionID == "" {
		return fmt.Errorf("conversationID, agentServer and sessionID are required")
	}
	workspacePath := cleanWorkspacePath(cwd)
	if cwd == cleanPath(chatStoragePath(conversationID)) {
		workspacePath = chatWorkspacePath
	}
	if workspacePath == "" {
		workspacePath = "/"
	}
	workingDirectoriesJSON, err := marshalJSONField(normalizeWorkingDirectories(nil, cwd), []string{})
	if err != nil {
		return fmt.Errorf("encoding conversation working directories: %w", err)
	}
	now := nowString()
	_, err = db.ExecContext(ctx, `
INSERT INTO conversations(id, workspace_path, agent_server, session_id, cwd, title, nickname, updated_at, active, archived, working_directories_json, metadata_json, created_at, touched_at)
VALUES (?, ?, ?, ?, ?, '', '', '', 1, 0, ?, '', ?, ?)
ON CONFLICT(id) DO UPDATE SET
  session_id = excluded.session_id,
  agent_server = excluded.agent_server,
  touched_at = excluded.touched_at
`, conversationID, workspacePath, agentServer, sessionID, cwd, workingDirectoriesJSON, now, now)
	if err != nil {
		return fmt.Errorf("binding conversation session: %w", err)
	}
	return nil
}

func (s *Store) PrepareConversationHandoff(ctx context.Context, params methods.ACPNavPrepareConversationHandoffParams) error {
	params.HandoffID = strings.TrimSpace(params.HandoffID)
	params.ConversationID = strings.TrimSpace(params.ConversationID)
	params.SourceAgentServer = strings.TrimSpace(params.SourceAgentServer)
	params.SourceSessionID = strings.TrimSpace(params.SourceSessionID)
	params.TargetAgentServer = strings.TrimSpace(params.TargetAgentServer)
	params.CreatedAt = strings.TrimSpace(params.CreatedAt)
	if params.HandoffID == "" || params.ConversationID == "" || params.SourceAgentServer == "" || params.SourceSessionID == "" || params.TargetAgentServer == "" {
		return fmt.Errorf("handoffId, conversationId, source agent/session, and target agent are required")
	}
	if params.SourceAgentServer == params.TargetAgentServer {
		return fmt.Errorf("source and target agent servers must differ")
	}
	if len(params.Events) == 0 || !json.Valid(params.Events) {
		return fmt.Errorf("handoff events must be valid JSON")
	}
	if len(params.Turns) == 0 || !json.Valid(params.Turns) {
		return fmt.Errorf("handoff turns must be valid JSON")
	}
	if len(params.Plan) == 0 || !json.Valid(params.Plan) {
		return fmt.Errorf("handoff plan must be valid JSON")
	}
	if params.CreatedAt == "" {
		params.CreatedAt = nowString()
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("starting conversation handoff: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var existingConversationID, existingSourceAgentServer, existingSourceSessionID, existingTargetAgentServer string
	var existingCommitted int
	err = tx.QueryRowContext(ctx, `
SELECT conversation_id, agent_server, session_id, target_agent_server, committed
FROM conversation_legs
WHERE handoff_id = ?
`, params.HandoffID).Scan(
		&existingConversationID,
		&existingSourceAgentServer,
		&existingSourceSessionID,
		&existingTargetAgentServer,
		&existingCommitted,
	)
	if err == nil {
		if existingConversationID != params.ConversationID ||
			existingSourceAgentServer != params.SourceAgentServer ||
			existingSourceSessionID != params.SourceSessionID ||
			existingTargetAgentServer != params.TargetAgentServer {
			return fmt.Errorf("handoffId is already used by a different conversation handoff")
		}
		// session/new commits the handoff before returning its response. If that
		// response is lost, the client retries prepare with the same id after the
		// conversation has already moved to the target. Treat that as success.
		if existingCommitted == 1 {
			return nil
		}
	} else if !stderrors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("loading existing conversation handoff: %w", err)
	}

	var active int
	err = tx.QueryRowContext(ctx, `
SELECT COUNT(*)
FROM conversations
WHERE id = ? AND agent_server = ? AND session_id = ?
`, params.ConversationID, params.SourceAgentServer, params.SourceSessionID).Scan(&active)
	if err != nil {
		return fmt.Errorf("checking handoff source: %w", err)
	}
	if active != 1 {
		return fmt.Errorf("conversation is no longer bound to the handoff source session")
	}

	_, err = tx.ExecContext(ctx, `
INSERT INTO conversation_legs(
  handoff_id, conversation_id, ordinal, agent_server, session_id,
  target_agent_server, schema_version, events_json, turns_json, plan_json, created_at, committed
)
VALUES (
  ?, ?,
  (SELECT COALESCE(MAX(ordinal), -1) + 1 FROM conversation_legs WHERE conversation_id = ?),
  ?, ?, ?, 1, ?, ?, ?, ?, 0
)
ON CONFLICT(handoff_id) DO UPDATE SET
  events_json = excluded.events_json,
  turns_json = excluded.turns_json,
  plan_json = excluded.plan_json,
  created_at = excluded.created_at
WHERE conversation_legs.committed = 0
`, params.HandoffID, params.ConversationID, params.ConversationID, params.SourceAgentServer, params.SourceSessionID, params.TargetAgentServer, string(params.Events), string(params.Turns), string(params.Plan), params.CreatedAt)
	if err != nil {
		return fmt.Errorf("preparing conversation handoff: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("committing prepared conversation handoff: %w", err)
	}
	return nil
}

func (s *Store) AbortConversationHandoff(ctx context.Context, handoffID string) error {
	handoffID = strings.TrimSpace(handoffID)
	if handoffID == "" {
		return nil
	}
	_, err := s.db.ExecContext(ctx, `
DELETE FROM conversation_legs
WHERE handoff_id = ? AND committed = 0
`, handoffID)
	if err != nil {
		return fmt.Errorf("aborting conversation handoff: %w", err)
	}
	return nil
}

func (s *Store) BindConversationSessionHandoff(ctx context.Context, conversationID, agentServer, sessionID, cwd, handoffID string) error {
	conversationID = strings.TrimSpace(conversationID)
	agentServer = strings.TrimSpace(agentServer)
	sessionID = strings.TrimSpace(sessionID)
	handoffID = strings.TrimSpace(handoffID)
	if conversationID == "" || agentServer == "" || sessionID == "" || handoffID == "" {
		return fmt.Errorf("conversationID, agentServer, sessionID, and handoffID are required")
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("starting handoff binding: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var sourceAgentServer, sourceSessionID, targetAgentServer, targetSessionID string
	var committed int
	err = tx.QueryRowContext(ctx, `
SELECT agent_server, session_id, target_agent_server, COALESCE(target_session_id, ''), committed
FROM conversation_legs
WHERE handoff_id = ? AND conversation_id = ?
`, handoffID, conversationID).Scan(
		&sourceAgentServer,
		&sourceSessionID,
		&targetAgentServer,
		&targetSessionID,
		&committed,
	)
	if stderrors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("prepared conversation handoff not found")
	}
	if err != nil {
		return fmt.Errorf("loading prepared conversation handoff: %w", err)
	}
	if targetAgentServer != agentServer {
		return fmt.Errorf("handoff target agent does not match the new session agent")
	}
	if committed == 1 {
		// A lost session/new response can cause the client to create a replacement
		// target session with the same handoff id. Adopt that session atomically so
		// the durable leg, navigation binding, and returned session id stay aligned.
		var activeTarget int
		err = tx.QueryRowContext(ctx, `
SELECT COUNT(*)
FROM conversations
WHERE id = ? AND agent_server = ? AND session_id = ?
`, conversationID, targetAgentServer, targetSessionID).Scan(&activeTarget)
		if err != nil {
			return fmt.Errorf("checking committed handoff target: %w", err)
		}
		if activeTarget != 1 {
			return fmt.Errorf("conversation changed after the handoff was committed")
		}
		if targetSessionID != sessionID {
			if _, err := tx.ExecContext(ctx, `
UPDATE conversation_legs
SET target_session_id = ?
WHERE handoff_id = ? AND conversation_id = ? AND committed = 1
`, sessionID, handoffID, conversationID); err != nil {
				return fmt.Errorf("rebinding committed conversation handoff: %w", err)
			}
		}
		if err := bindConversationSession(ctx, tx, conversationID, agentServer, sessionID, cwd); err != nil {
			return err
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("committing retried handoff session binding: %w", err)
		}
		return nil
	}

	var active int
	err = tx.QueryRowContext(ctx, `
SELECT COUNT(*)
FROM conversations
WHERE id = ? AND agent_server = ? AND session_id = ?
`, conversationID, sourceAgentServer, sourceSessionID).Scan(&active)
	if err != nil {
		return fmt.Errorf("checking active handoff source: %w", err)
	}
	if active != 1 {
		return fmt.Errorf("conversation changed before the handoff could be committed")
	}

	result, err := tx.ExecContext(ctx, `
UPDATE conversation_legs
SET target_session_id = ?, committed = 1
WHERE handoff_id = ? AND conversation_id = ? AND committed = 0
`, sessionID, handoffID, conversationID)
	if err != nil {
		return fmt.Errorf("committing frozen conversation leg: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("checking committed conversation leg: %w", err)
	}
	if affected != 1 {
		return fmt.Errorf("prepared conversation handoff was already resolved")
	}
	if err := bindConversationSession(ctx, tx, conversationID, agentServer, sessionID, cwd); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("committing handoff session binding: %w", err)
	}
	return nil
}

func (s *Store) ConversationHistory(ctx context.Context, conversationID string) (methods.ACPNavConversationHistory, error) {
	conversationID = strings.TrimSpace(conversationID)
	history := methods.ACPNavConversationHistory{Legs: []methods.ACPNavConversationLeg{}}
	if conversationID == "" {
		return history, nil
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT handoff_id, ordinal, agent_server, session_id, target_agent_server,
       COALESCE(target_session_id, ''), schema_version, events_json, turns_json, plan_json, created_at
FROM conversation_legs
WHERE conversation_id = ? AND committed = 1
ORDER BY ordinal ASC
`, conversationID)
	if err != nil {
		return history, fmt.Errorf("listing conversation history: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var leg methods.ACPNavConversationLeg
		var eventsJSON, turnsJSON, planJSON string
		if err := rows.Scan(
			&leg.HandoffID,
			&leg.Ordinal,
			&leg.AgentServer,
			&leg.SessionID,
			&leg.TargetAgentServer,
			&leg.TargetSessionID,
			&leg.SchemaVersion,
			&eventsJSON,
			&turnsJSON,
			&planJSON,
			&leg.CreatedAt,
		); err != nil {
			return history, fmt.Errorf("scanning conversation history: %w", err)
		}
		leg.Events = json.RawMessage(eventsJSON)
		leg.Turns = json.RawMessage(turnsJSON)
		leg.Plan = json.RawMessage(planJSON)
		history.Legs = append(history.Legs, leg)
	}
	if err := rows.Err(); err != nil {
		return history, fmt.Errorf("listing conversation history: %w", err)
	}
	return history, nil
}

func (s *Store) RestoreConversation(ctx context.Context, c methods.ACPNavConversation) error {
	c.ID = strings.TrimSpace(c.ID)
	c.WorkspacePath = cleanWorkspacePath(c.WorkspacePath)
	c.Cwd = cleanPath(c.Cwd)
	c.AgentServer = strings.TrimSpace(c.AgentServer)
	c.SessionID = strings.TrimSpace(c.SessionID)
	if c.WorkspacePath == "" {
		c.WorkspacePath = c.Cwd
	}
	if c.Cwd == "" {
		c.Cwd = c.WorkspacePath
	}
	c.WorkingDirectories = normalizeWorkingDirectories(c.WorkingDirectories, c.Cwd)
	if c.WorkspacePath == "" || c.AgentServer == "" {
		return fmt.Errorf("workspacePath and agentServer are required")
	}
	pathToRestore := c.WorkspacePath
	if c.WorkspacePath == chatWorkspacePath {
		pathToRestore = c.Cwd
	}
	if pathToRestore != ideWorkspacePath && !pathExists(pathToRestore) {
		return fmt.Errorf("workspace path does not exist: %s", c.WorkspacePath)
	}
	if c.SessionID != "" {
		id, found, err := s.existingConversationIDForSession(ctx, c.WorkspacePath, c.AgentServer, c.SessionID)
		if err != nil {
			return err
		}
		if found {
			c.ID = id
		}
	}
	if c.ID == "" {
		id, err := newConversationID()
		if err != nil {
			return err
		}
		c.ID = id
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("starting tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	now := nowString()
	if c.WorkspacePath != ideWorkspacePath && c.WorkspacePath != chatWorkspacePath {
		originalWorkspacePath := c.WorkspacePath
		project, parent := normalizeProjectForNav(methods.ACPNavUpsertProjectParams{
			Path: c.WorkspacePath,
			Name: filepath.Base(c.WorkspacePath),
		})
		c.WorkspacePath = project.Path
		if c.Cwd == "" || c.Cwd == originalWorkspacePath {
			c.Cwd = c.WorkspacePath
		}
		if parent != nil {
			if err := s.upsertProjectTx(ctx, tx, *parent, now); err != nil {
				return err
			}
		}
		if err := s.upsertProjectTx(ctx, tx, project, now); err != nil {
			return err
		}
	}
	if _, err := s.upsertConversationTx(ctx, tx, c, now); err != nil {
		return err
	}
	// Upserts keep an archived sub-agent archived; restoring is explicit.
	if _, err := tx.ExecContext(ctx, `UPDATE conversations SET archived = 0 WHERE id = ?`, c.ID); err != nil {
		return fmt.Errorf("restoring conversation: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, restoredKey(c.ID), "1"); err != nil {
		return fmt.Errorf("recording restore marker: %w", err)
	}
	return tx.Commit()
}

func (s *Store) existingConversationIDForSession(ctx context.Context, workspacePath, agentServer, sessionID string) (string, bool, error) {
	var id string
	err := s.db.QueryRowContext(ctx, `
SELECT id
FROM conversations
WHERE workspace_path = ? AND agent_server = ? AND session_id = ?
`, workspacePath, agentServer, sessionID).Scan(&id)
	if err == nil {
		return id, true, nil
	}
	if !stderrors.Is(err, sql.ErrNoRows) {
		return "", false, fmt.Errorf("looking up conversation for session: %w", err)
	}
	return "", false, nil
}

func (s *Store) conversationIDForSession(ctx context.Context, workspacePath, agentServer, sessionID string) (string, error) {
	var id string
	err := s.db.QueryRowContext(ctx, `
SELECT id
FROM conversations
WHERE workspace_path = ? AND agent_server = ? AND session_id = ?
`, workspacePath, agentServer, sessionID).Scan(&id)
	if err == nil {
		return id, nil
	}
	if !stderrors.Is(err, sql.ErrNoRows) {
		return "", fmt.Errorf("looking up conversation for session: %w", err)
	}
	return newConversationID()
}

func (s *Store) RemoveProject(ctx context.Context, path string) error {
	path = cleanPath(path)
	if path == "" {
		return fmt.Errorf("project path is required")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("starting tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx, `
DELETE FROM conversations
WHERE workspace_path = ?
   OR workspace_path IN (SELECT path FROM projects WHERE parent_path = ?)
`, path, path); err != nil {
		return fmt.Errorf("deleting conversations for project: %w", err)
	}

	if _, err := tx.ExecContext(ctx, `DELETE FROM projects WHERE parent_path = ?`, path); err != nil {
		return fmt.Errorf("deleting worktrees for project: %w", err)
	}

	if _, err := tx.ExecContext(ctx, `DELETE FROM projects WHERE path = ?`, path); err != nil {
		return fmt.Errorf("deleting project: %w", err)
	}

	return tx.Commit()
}

func (s *Store) RemoveWorktree(ctx context.Context, path string) error {
	return s.removeWorktree(ctx, path, true)
}

// RemoveWorktreeSafely preserves Git failures and never forces removal.
// It is reached only from control automation, so git runs isolated: repo
// hooks and fsmonitor are disabled, the repo-configured filter drivers
// visible inside the worktree are neutralised, and repositories whose config
// sets command-running keys are refused (see isolatedWorktreeEnv).
func (s *Store) RemoveWorktreeSafely(ctx context.Context, path string) error {
	return s.removeWorktree(ctx, path, false)
}

func (s *Store) removeWorktree(ctx context.Context, path string, force bool) error {
	path = cleanPath(path)
	if path == "" {
		return fmt.Errorf("worktree path is required")
	}
	var parent sql.NullString
	if err := s.db.QueryRowContext(ctx, `SELECT parent_path FROM projects WHERE path = ? AND is_worktree = 1`, path).Scan(&parent); err != nil {
		if stderrors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("worktree not found: %s", path)
		}
		return fmt.Errorf("looking up worktree: %w", err)
	}

	if parent.Valid && parent.String != "" {
		parentPath := cleanPath(parent.String)
		var env []string
		if !force {
			var err error
			if env, _, err = s.isolatedWorktreeEnv(ctx, path); err != nil {
				return err
			}
		}
		rl := s.repoLock(parentPath)
		rl.Lock()
		args := []string{"-C", parentPath, "worktree", "remove"}
		if force {
			args = append(args, "--force")
		}
		args = append(args, path)
		output, removeErr := s.runGit(ctx, env, args...)
		rl.Unlock()
		if !force && removeErr != nil {
			return fmt.Errorf("removing worktree: %w: %s", removeErr, strings.TrimSpace(string(output)))
		}
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("starting tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	// Conversations with an agent-side session survive worktree removal:
	// archive them under the parent project so they stay reachable from the
	// archive pane after the worktree directory is gone. Session-less drafts
	// have nothing to reopen, so they are deleted with the worktree. Rows
	// whose session already exists under the parent would violate the
	// (workspace_path, agent_server, session_id) unique index, so they are
	// left behind for the DELETE below.
	var archivedRoots []string
	if parent.Valid && cleanPath(parent.String) != "" {
		archivedRoots, err = queryIDs(ctx, tx, `
SELECT id FROM conversations
WHERE workspace_path = ?1 AND session_id != ''
  AND NOT EXISTS (
    SELECT 1 FROM conversations other
    WHERE other.workspace_path = ?2
      AND other.agent_server = conversations.agent_server
      AND other.session_id = conversations.session_id
  )
`, path, cleanPath(parent.String))
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
UPDATE conversations
SET workspace_path = ?1, active = 0, archived = 1, touched_at = ?2
WHERE workspace_path = ?3 AND session_id != ''
  AND NOT EXISTS (
    SELECT 1 FROM conversations other
    WHERE other.workspace_path = ?1
      AND other.agent_server = conversations.agent_server
      AND other.session_id = conversations.session_id
  )
`, cleanPath(parent.String), nowString(), path); err != nil {
			return fmt.Errorf("archiving worktree conversations: %w", err)
		}
	}
	for _, id := range archivedRoots {
		if err := clearRestoredTx(ctx, tx, id); err != nil {
			return err
		}
	}
	cascaded, _, err := archiveDescendantsTx(ctx, tx, archivedRoots, false)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM conversations WHERE workspace_path = ?`, path); err != nil {
		return fmt.Errorf("deleting worktree conversations: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM projects WHERE path = ?`, path); err != nil {
		return fmt.Errorf("deleting worktree: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.closeArchivedSessions(ctx, cascaded)
	return nil
}

func (s *Store) ArchiveConversation(ctx context.Context, workspacePath, conversationID, agentServer, sessionID string) error {
	workspacePath = cleanWorkspacePath(workspacePath)
	conversationID = strings.TrimSpace(conversationID)

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("starting tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	// Archiving is idempotent: an already-archived conversation succeeds, so
	// racing archive callers (UI cascade vs. helper cascade) never error.
	var roots []string
	archive := func(where string, args ...any) error {
		ids, err := queryIDs(ctx, tx, `SELECT id FROM conversations WHERE `+where, args...)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE conversations SET active = 0, archived = 1, touched_at = ? WHERE `+where, append([]any{nowString()}, args...)...); err != nil {
			return fmt.Errorf("archiving conversation: %w", err)
		}
		for _, id := range ids {
			if err := clearRestoredTx(ctx, tx, id); err != nil {
				return err
			}
		}
		roots = append(roots, ids...)
		return nil
	}
	switch {
	case conversationID != "":
		err = archive(`id = ?`, conversationID)
	default:
		err = archive(`agent_server = ? AND session_id = ? AND (workspace_path = ? OR cwd = ?)`, agentServer, sessionID, workspacePath, workspacePath)
		if err == nil && len(roots) == 0 && sessionID != "" {
			err = archive(`agent_server = ? AND session_id = ?`, agentServer, sessionID)
		}
	}
	if err != nil {
		return err
	}
	cascaded, _, err := archiveDescendantsTx(ctx, tx, roots, false)
	if err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.closeArchivedSessions(ctx, cascaded)
	return nil
}

func (s *Store) RenameConversation(ctx context.Context, conversationID, nickname, title string) error {
	conversationID = strings.TrimSpace(conversationID)
	nickname = strings.TrimSpace(nickname)
	title = strings.TrimSpace(title)
	if conversationID == "" {
		return fmt.Errorf("conversation id is required")
	}
	if nickname == "" {
		return fmt.Errorf("conversation name is required")
	}

	result, err := s.db.ExecContext(ctx, `
UPDATE conversations
SET nickname = ?,
    title = CASE WHEN ? != '' THEN ? ELSE title END,
    touched_at = ?
WHERE id = ?
`, nickname, title, title, nowString(), conversationID)
	if err != nil {
		return fmt.Errorf("renaming conversation: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("checking conversation rename: %w", err)
	}
	if affected == 0 {
		return fmt.Errorf("conversation not found: %s", conversationID)
	}
	return nil
}

func (s *Store) DeleteConversationByID(ctx context.Context, conversationID string) error {
	conversationID = strings.TrimSpace(conversationID)
	if conversationID == "" {
		return nil
	}
	return s.deleteConversations(ctx, "id = ?", conversationID)
}

func (s *Store) DeleteConversationBySession(ctx context.Context, agentServer, sessionID string) error {
	agentServer = strings.TrimSpace(agentServer)
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return nil
	}
	return s.deleteConversations(
		ctx,
		"agent_server = ? AND session_id = ?",
		agentServer,
		sessionID,
	)
}

func (s *Store) deleteConversations(ctx context.Context, where string, args ...any) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("starting conversation deletion: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	rows, err := tx.QueryContext(ctx, `
SELECT id, workspace_path, cwd
FROM conversations
WHERE `+where, args...)
	if err != nil {
		return fmt.Errorf("listing conversations to delete: %w", err)
	}
	var conversations []conversationToDelete
	for rows.Next() {
		var conversation conversationToDelete
		if err := rows.Scan(&conversation.id, &conversation.workspacePath, &conversation.cwd); err != nil {
			_ = rows.Close()
			return fmt.Errorf("scanning conversation to delete: %w", err)
		}
		conversations = append(conversations, conversation)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return fmt.Errorf("listing conversations to delete: %w", err)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("closing conversations to delete: %w", err)
	}

	if _, err := tx.ExecContext(ctx, `
DELETE FROM conversations
	WHERE `+where, args...); err != nil {
		return fmt.Errorf("deleting conversations: %w", err)
	}

	for _, conversation := range conversations {
		if conversation.workspacePath != chatWorkspacePath {
			continue
		}
		expectedCwd := cleanPath(chatStoragePath(conversation.id))
		if cleanPath(conversation.cwd) != expectedCwd {
			return fmt.Errorf(
				"refusing to delete unexpected chat working directory %q (expected %q)",
				conversation.cwd,
				expectedCwd,
			)
		}
		if err := os.RemoveAll(expectedCwd); err != nil {
			return fmt.Errorf("deleting chat working directory %q: %w", expectedCwd, err)
		}
	}

	return tx.Commit()
}

type conversationToDelete struct {
	id            string
	workspacePath string
	cwd           string
}

func (s *Store) listProjects(ctx context.Context) ([]methods.ACPNavProject, error) {
	// Root projects and each parent's worktrees use their persisted
	// display_order (ascending). created_at DESC is a stable tiebreak so freshly
	// inserted rows that briefly share an order still render newest-first.
	rows, err := s.db.QueryContext(ctx, `
SELECT path, name, nickname, is_worktree, parent_path, collapsed, display_order, created_at, updated_at, setup_script, teardown_script, user_prompt
FROM projects
ORDER BY
  is_worktree ASC,
  display_order ASC,
  created_at DESC,
  name COLLATE NOCASE ASC,
  path ASC
`)
	if err != nil {
		return nil, fmt.Errorf("listing projects: %w", err)
	}
	defer rows.Close()

	var projects []methods.ACPNavProject
	for rows.Next() {
		var p methods.ACPNavProject
		var isWorktree, collapsed int
		var parent sql.NullString
		if err := rows.Scan(
			&p.Path,
			&p.Name,
			&p.Nickname,
			&isWorktree,
			&parent,
			&collapsed,
			&p.DisplayOrder,
			&p.CreatedAt,
			&p.UpdatedAt,
			&p.SetupScript,
			&p.TeardownScript,
			&p.UserPrompt,
		); err != nil {
			return nil, fmt.Errorf("scanning project: %w", err)
		}
		p.IsWorktree = isWorktree != 0
		p.Collapsed = collapsed != 0
		if parent.Valid {
			p.ParentPath = &parent.String
		}
		projects = append(projects, p)
	}
	return projects, rows.Err()
}

func (s *Store) listConversations(ctx context.Context) ([]methods.ACPNavConversation, error) {
	return s.queryConversations(ctx, "")
}

func (s *Store) queryConversations(ctx context.Context, id string) ([]methods.ACPNavConversation, error) {
	query := `
SELECT id, workspace_path, agent_server, COALESCE(session_id, ''), cwd, title, nickname, updated_at, active, archived, working_directories_json, metadata_json
FROM conversations
`
	var args []any
	if id != "" {
		query += "WHERE id = ?\n"
		args = append(args, id)
	}
	query += `ORDER BY
  CASE WHEN updated_at = '' THEN touched_at ELSE updated_at END DESC,
  touched_at DESC
`
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("listing conversations: %w", err)
	}
	defer rows.Close()

	var conversations []methods.ACPNavConversation
	for rows.Next() {
		var c methods.ACPNavConversation
		var active, archived int
		var workingDirectoriesJSON string
		var metadataJSON string
		if err := rows.Scan(
			&c.ID,
			&c.WorkspacePath,
			&c.AgentServer,
			&c.SessionID,
			&c.Cwd,
			&c.Title,
			&c.Nickname,
			&c.UpdatedAt,
			&active,
			&archived,
			&workingDirectoriesJSON,
			&metadataJSON,
		); err != nil {
			return nil, fmt.Errorf("scanning conversation: %w", err)
		}
		if err := decodeJSONField(workingDirectoriesJSON, &c.WorkingDirectories); err != nil {
			return nil, fmt.Errorf("decoding conversation working directories: %w", err)
		}
		if strings.TrimSpace(metadataJSON) != "" {
			c.Metadata = json.RawMessage(metadataJSON)
		}
		c.WorkingDirectories = normalizeWorkingDirectories(c.WorkingDirectories, c.Cwd)
		c.Active = active != 0
		c.Archived = archived != 0
		conversations = append(conversations, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	return conversations, s.attachControlParents(ctx, conversations)
}

// attachControlParents fills ParentID/RootID from the cached control-state
// links. The control package owns the record shape; only the link fields are
// decoded, and only once per record write (not per list).
func (s *Store) attachControlParents(ctx context.Context, conversations []methods.ACPNavConversation) error {
	if len(conversations) == 0 {
		return nil
	}
	s.linksMu.Lock()
	defer s.linksMu.Unlock()
	if err := s.loadParentLinksLocked(ctx); err != nil {
		return err
	}
	for i := range conversations {
		l := s.parentLinks[conversations[i].ID]
		conversations[i].ParentID, conversations[i].RootID = l.ParentID, l.RootID
	}
	return nil
}

func (s *Store) loadParentLinksLocked(ctx context.Context) error {
	if s.parentLinks != nil {
		return nil
	}
	// A key range (not LIKE, which cannot use the BINARY primary key index)
	// keeps this off the never-pruned control/turn/ records.
	rows, err := s.db.QueryContext(ctx, `SELECT key, value FROM metadata WHERE key >= ? AND key < ?`, "control/conversation/", "control/conversation0")
	if err != nil {
		return fmt.Errorf("listing control state: %w", err)
	}
	defer rows.Close()
	links := map[string]controlLink{}
	for rows.Next() {
		var key, raw string
		if err := rows.Scan(&key, &raw); err != nil {
			return fmt.Errorf("scanning control state: %w", err)
		}
		if l, ok := decodeControlLink(raw); ok {
			links[strings.TrimPrefix(key, "control/conversation/")] = l
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	s.parentLinks = links
	return nil
}

func decodeControlLink(raw string) (controlLink, bool) {
	var l controlLink
	ok := json.Unmarshal([]byte(raw), &l) == nil && (l.ParentID != "" || l.RootID != "")
	return l, ok
}

// writeControlState upserts a control-state record and keeps the parent-link
// cache coherent. The lock spans the write so concurrent writers to one key
// cannot leave the cache disagreeing with the row.
func (s *Store) writeControlState(ctx context.Context, id, raw string) error {
	s.linksMu.Lock()
	defer s.linksMu.Unlock()
	if _, err := s.db.ExecContext(ctx, `INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, "control/"+id, raw); err != nil {
		return err
	}
	convID, ok := strings.CutPrefix(id, "conversation/")
	if !ok || s.parentLinks == nil {
		return nil
	}
	if l, ok := decodeControlLink(raw); ok {
		s.parentLinks[convID] = l
	} else {
		delete(s.parentLinks, convID)
	}
	return nil
}

func normalizeAgentServers(agentServers methods.ACPAgentServers) (methods.ACPAgentServers, error) {
	normalized := methods.ACPAgentServers{}
	for name, cfg := range agentServers {
		name = normalizeAgentServerName(name)
		if name == "" {
			return nil, fmt.Errorf("agent server name is required")
		}
		cfg.Command = strings.TrimSpace(cfg.Command)
		// The built-in camber agent may have no command; acpproxy
		// resolves it at process start. Its entry still needs to be
		// storable so per-agent settings (e.g. default config options)
		// persist.
		if cfg.Command == "" && len(cfg.Binary) == 0 && name != defaultAgentServerName {
			return nil, fmt.Errorf("agent server %q command is required", name)
		}
		normalized[name] = cfg
	}
	return normalized, nil
}

func insertAgentServers(ctx context.Context, tx *sql.Tx, agentServers methods.ACPAgentServers) error {
	now := nowString()
	for name, cfg := range agentServers {
		argsJSON, err := marshalJSONField(cfg.Args, []string{})
		if err != nil {
			return fmt.Errorf("encoding args for agent server %q: %w", name, err)
		}
		envJSON, err := marshalJSONField(cfg.Env, map[string]string{})
		if err != nil {
			return fmt.Errorf("encoding env for agent server %q: %w", name, err)
		}
		binaryJSON, err := marshalJSONField(cfg.Binary, map[string]methods.ACPAgentServerBinaryDistribution{})
		if err != nil {
			return fmt.Errorf("encoding binary config for agent server %q: %w", name, err)
		}
		defaultConfigOptionsJSON, err := marshalJSONField(cfg.DefaultConfigOptions, map[string]string{})
		if err != nil {
			return fmt.Errorf("encoding default config options for agent server %q: %w", name, err)
		}
		if _, err := tx.ExecContext(ctx, `
INSERT INTO agent_servers(name, command, args_json, env_json, binary_json, default_config_options_json, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`, name, cfg.Command, argsJSON, envJSON, binaryJSON, defaultConfigOptionsJSON, now, now); err != nil {
			return fmt.Errorf("inserting agent server %q: %w", name, err)
		}
	}
	return nil
}

func marshalJSONField[T any](value T, fallback T) (string, error) {
	out, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	if string(out) == "null" {
		out, err = json.Marshal(fallback)
		if err != nil {
			return "", err
		}
	}
	return string(out), nil
}

func decodeJSONField[T any](value string, target *T) error {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return json.Unmarshal([]byte(value), target)
}

func rawJSONOrDefault(value json.RawMessage, fallback string) string {
	if len(value) == 0 || strings.TrimSpace(string(value)) == "" {
		return fallback
	}
	return string(value)
}

func normalizeWorkingDirectories(paths []string, fallback string) []string {
	out := make([]string, 0, len(paths))
	seen := map[string]struct{}{}
	for _, path := range paths {
		path = cleanPath(path)
		if path == "" {
			continue
		}
		if _, ok := seen[path]; ok {
			continue
		}
		seen[path] = struct{}{}
		out = append(out, path)
	}
	if len(out) == 0 && fallback != "" {
		out = append(out, fallback)
	}
	return out
}

func normalizeProjectForNav(p methods.ACPNavUpsertProjectParams) (methods.ACPNavUpsertProjectParams, *methods.ACPNavUpsertProjectParams) {
	p.Path = cleanPath(p.Path)
	p.Name = strings.TrimSpace(p.Name)
	if p.Path == "" {
		return p, nil
	}

	if !p.IsWorktree {
		if info, ok := detectLinkedGitWorktreeFromMetadata(p.Path); ok {
			parentPath := info.parentPath
			p.Path = info.worktreePath
			p.Name = filepath.Base(info.worktreePath)
			p.IsWorktree = true
			p.ParentPath = &parentPath
			parent := methods.ACPNavUpsertProjectParams{
				Path: info.parentPath,
				Name: filepath.Base(info.parentPath),
			}
			return p, &parent
		}
	}

	if p.Name == "" {
		p.Name = filepath.Base(p.Path)
	}
	return p, nil
}

type linkedGitWorktreeInfo struct {
	worktreePath string
	parentPath   string
}

func detectLinkedGitWorktreeFromMetadata(path string) (linkedGitWorktreeInfo, bool) {
	current := cleanPath(path)
	for current != "" {
		dotGit := filepath.Join(current, ".git")
		info, err := os.Stat(dotGit)
		if err == nil {
			if info.IsDir() {
				return linkedGitWorktreeInfo{}, false
			}
			return parseLinkedGitWorktreeFile(current, dotGit)
		}
		if !os.IsNotExist(err) {
			return linkedGitWorktreeInfo{}, false
		}
		parent := filepath.Dir(current)
		if parent == current {
			return linkedGitWorktreeInfo{}, false
		}
		current = parent
	}
	return linkedGitWorktreeInfo{}, false
}

func parseLinkedGitWorktreeFile(worktreePath, dotGitPath string) (linkedGitWorktreeInfo, bool) {
	content, err := os.ReadFile(dotGitPath)
	if err != nil {
		return linkedGitWorktreeInfo{}, false
	}
	const gitDirPrefix = "gitdir: "
	gitDirLine := strings.TrimSpace(string(content))
	if !strings.HasPrefix(gitDirLine, gitDirPrefix) {
		return linkedGitWorktreeInfo{}, false
	}

	gitDir := strings.TrimSpace(strings.Split(strings.TrimPrefix(gitDirLine, gitDirPrefix), "\n")[0])
	if gitDir == "" {
		return linkedGitWorktreeInfo{}, false
	}
	if !filepath.IsAbs(gitDir) {
		gitDir = filepath.Join(worktreePath, gitDir)
	}
	gitDir = cleanPath(gitDir)
	if filepath.Base(filepath.Dir(gitDir)) != "worktrees" {
		return linkedGitWorktreeInfo{}, false
	}
	fallbackParentPath := parentPathFromWorktreeGitDir(gitDir)

	commonDirContent, err := os.ReadFile(filepath.Join(gitDir, "commondir"))
	if err != nil {
		if fallbackParentPath == "" {
			return linkedGitWorktreeInfo{}, false
		}
		worktreePath = cleanPath(worktreePath)
		if worktreePath == "" || fallbackParentPath == worktreePath {
			return linkedGitWorktreeInfo{}, false
		}
		return linkedGitWorktreeInfo{worktreePath: worktreePath, parentPath: fallbackParentPath}, true
	}
	commonDir := strings.TrimSpace(string(commonDirContent))
	if commonDir == "" {
		return linkedGitWorktreeInfo{}, false
	}
	if !filepath.IsAbs(commonDir) {
		commonDir = filepath.Join(gitDir, commonDir)
	}
	commonDir = cleanPath(commonDir)
	if filepath.Base(commonDir) != ".git" {
		return linkedGitWorktreeInfo{}, false
	}

	parentPath := cleanPath(filepath.Dir(commonDir))
	worktreePath = cleanPath(worktreePath)
	if parentPath == "" || worktreePath == "" || parentPath == worktreePath {
		return linkedGitWorktreeInfo{}, false
	}
	return linkedGitWorktreeInfo{worktreePath: worktreePath, parentPath: parentPath}, true
}

func parentPathFromWorktreeGitDir(gitDir string) string {
	commonGitDir := cleanPath(filepath.Dir(filepath.Dir(gitDir)))
	if filepath.Base(commonGitDir) != ".git" {
		return ""
	}
	return cleanPath(filepath.Dir(commonGitDir))
}

func normalizeAgentServerName(name string) string {
	name = strings.TrimSpace(name)
	if name == "" || name == "default" {
		return defaultAgentServerName
	}
	return name
}

func cleanPath(path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return ""
	}
	if abs, err := filepath.Abs(path); err == nil {
		path = abs
	}
	if evaluated, err := filepath.EvalSymlinks(path); err == nil {
		path = evaluated
	}
	return filepath.Clean(path)
}

func cleanWorkspacePath(path string) string {
	path = strings.TrimSpace(path)
	if path == ideWorkspacePath || path == chatWorkspacePath {
		return path
	}
	return cleanPath(path)
}

func boolInt(v bool) int {
	if v {
		return 1
	}
	return 0
}

func nowString() string {
	return time.Now().UTC().Format(time.RFC3339)
}

func newConversationID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("generating conversation id: %w", err)
	}
	return "conv_" + hex.EncodeToString(b[:]), nil
}

func pathExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
