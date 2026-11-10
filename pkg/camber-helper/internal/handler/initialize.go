package handler

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"runtime/trace"
	"time"

	"github.com/tliron/glsp"
	protocol "github.com/tliron/glsp/protocol_3_16"

	protocol2 "github.com/appleton/camber/pkg/camber-helper/gopls/pkg/protocol"
	"github.com/appleton/camber/pkg/camber-helper/internal/filesystem"
	"github.com/appleton/camber/pkg/camber-helper/internal/handler/acpnav"
	"github.com/appleton/camber/pkg/camber-helper/internal/handler/acpproxy"
	"github.com/appleton/camber/pkg/camber-helper/logging"
	"github.com/appleton/camber/pkg/camber-helper/methods"
	"github.com/appleton/camber/pkg/common/goroutine"
	"github.com/appleton/camber/pkg/common/version"
)

// initialize is the first method received by the LSP server from client. Until a response has been received no
// other methods should be called. If this fails no methods will be called, and it's likely the client will either
// try a restart or give up, so the helper will not be usable.
func (h *CamberHandler) initialize(gCtx *glsp.Context, params *protocol.InitializeParams) (any, error) {
	if h.IsInitialized() {
		return nil, errors.New("server cannot be re-initialized")
	}

	err := h.criticalPathDependencies(gCtx, params)
	if err != nil {
		// hard fail - helper out of action
		return nil, err
	}

	defer slog.Info("initialized", "workspace_folders", params.WorkspaceFolders)

	/**
	 * Soft, non-blocking dependencies. Place any slow initialization processes here, as work in initialize delays the helper
	 * being responsive for API requests etc.
	 */
	if gCtx.Context != nil {
		goroutine.WithRecover(func() {
			h.startPprofNonBlocking()
		})
	}
	goroutine.WithRecover(removeLegacyEngagementState)

	ret := protocol2.InitializeResult{
		// this informs the clients which methods we support, opting in to things like text doc synchronisation
		Capabilities: protocol2.ServerCapabilities{
			TextDocumentSync: protocol2.TextDocumentSyncOptions{
				OpenClose: true,
				Change:    protocol2.Incremental,
			},
			Workspace: &protocol2.WorkspaceOptions{
				WorkspaceFolders: &protocol2.WorkspaceFolders5Gn{
					Supported:           true,
					ChangeNotifications: "workspaceFolders/changeNotifications",
				},
				// TODO: maybe the following filters could be more strict
				FileOperations: &protocol2.FileOperationOptions{
					DidRename: &protocol2.FileOperationRegistrationOptions{
						Filters: []protocol2.FileOperationFilter{
							{
								Scheme: "file",
								Pattern: protocol2.FileOperationPattern{
									Glob: "**",
									Options: &protocol2.FileOperationPatternOptions{
										IgnoreCase: true,
									},
								},
							},
						},
					},
					DidDelete: &protocol2.FileOperationRegistrationOptions{
						Filters: []protocol2.FileOperationFilter{
							{
								Scheme: "file",
								Pattern: protocol2.FileOperationPattern{
									Glob: "**",
									Options: &protocol2.FileOperationPatternOptions{
										IgnoreCase: true,
									},
								},
							},
						},
					},
					DidCreate: &protocol2.FileOperationRegistrationOptions{
						Filters: []protocol2.FileOperationFilter{
							{
								Scheme: "file",
								Pattern: protocol2.FileOperationPattern{
									Glob: "**",
									Options: &protocol2.FileOperationPatternOptions{
										IgnoreCase: true,
									},
								},
							},
						},
					},
					WillDelete: &protocol2.FileOperationRegistrationOptions{
						Filters: []protocol2.FileOperationFilter{
							{
								Scheme: "file",
								Pattern: protocol2.FileOperationPattern{
									Glob: "**",
									Options: &protocol2.FileOperationPatternOptions{
										IgnoreCase: true,
									},
								},
							},
						},
					},
				},
			},
		},
		ServerInfo: &protocol2.ServerInfo{
			Name: "camber Helper",
			// TODO pass in the cmd version for consistency
			Version: version.Human(),
		},
	}

	h.SetInitialized(true)

	// N.B. think carefully about adding places that initialize can fail - see docs at top of method
	return ret, nil
}

// criticalPathDependencies are all the initialization steps which must occur for the helper to be useable.
// Think carefully about what's necessary here, especially any work involving state not under our control, or slow processes (disk, config files etc).
// Ideally make this work fail-safe, so it gracefully handles error conditions rather than returning an error which
// blocks startup
func (h *CamberHandler) criticalPathDependencies(gCtx *glsp.Context, params *protocol.InitializeParams) error {
	err := initializePhase(gCtx.Context, "configuration", func() error { return h.initializeConfiguration(gCtx, params) })
	if err != nil {
		return err
	}

	if err := h.ensureACPNavStore(gCtx.Context); err != nil {
		return err
	}

	return nil
}

func clientSupportsWatchedFiles(params *protocol.InitializeParams) bool {
	if params == nil || params.Capabilities.Workspace == nil || params.Capabilities.Workspace.DidChangeWatchedFiles == nil {
		return false
	}
	dynamicRegistration := params.Capabilities.Workspace.DidChangeWatchedFiles.DynamicRegistration
	return dynamicRegistration != nil && *dynamicRegistration
}

func (h *CamberHandler) initializeConfiguration(_ *glsp.Context, params *protocol.InitializeParams) error {
	h.mx.Lock()
	defer h.mx.Unlock()

	conf, err := fromInitializationOptions(params.InitializationOptions)
	if err != nil {
		return err
	}
	h.config = conf
	h.workspaceFolders = params.WorkspaceFolders
	h.clientSupportsWatchedFiles = clientSupportsWatchedFiles(params)

	// change default level for stdout (Debug for development, Info for production)
	logging.UpdateLevelForEnvironment(methods.AssistantEnvironment(conf.AssistantEnvironment))

	return nil
}

func (h *CamberHandler) initialized(gLsp *glsp.Context, params *protocol.InitializedParams) error {
	if gLsp == nil {
		return nil
	}
	if h.clientSupportsWatchedFiles {
		gLsp.Call(context.Background(), "client/registerCapability", &protocol.RegistrationParams{
			Registrations: []protocol.Registration{
				{
					ID:     "workspace/didChangeWatchedFiles",
					Method: "workspace/didChangeWatchedFiles",
					RegisterOptions: &protocol.DidChangeWatchedFilesRegistrationOptions{
						Watchers: []protocol.FileSystemWatcher{
							{
								GlobPattern: "**",
							},
						},
					},
				},
			},
		}, nil)
	}

	return nil
}

func acpNavDB() (string, error) {
	if dbPath := os.Getenv("CAMBER_ACP_NAV_DB_PATH"); dbPath != "" {
		return dbPath, nil
	}

	camberCache, err := filesystem.CamberCacheDir()
	if err != nil {
		return "", err
	}

	return filepath.Join(camberCache, fmt.Sprintf("%s.db", acpnav.DBName)), nil
}

func (h *CamberHandler) ensureACPNavStore(ctx context.Context) error {
	var assistantConfigStore *acpnav.AssistantConfigAgentServerStore
	assistantConfigUsable := true
	if !h.acpNavHandler.HasStore() {
		acpNavDBName, err := acpNavDB()
		if err != nil {
			return err
		}
		var acpNavStore *acpnav.Store
		err = initializePhase(ctx, "navigation_database", func() error {
			var openErr error
			acpNavStore, openErr = acpnav.Open(ctx, acpNavDBName)
			return openErr
		})
		if err != nil {
			return err
		}
		h.acpNavHandler.SetStore(acpNavStore)
		assistantConfigStore = acpnav.NewAssistantConfigAgentServerStore(acpnav.AssistantConfigPath())
		h.acpNavHandler.SetAgentServerStore(assistantConfigStore)
		if err := initializePhase(ctx, "agent_config_migration", func() error { return assistantConfigStore.MigrateFromDB(ctx, acpNavStore) }); err != nil {
			if !acpnav.IsAssistantConfigParseError(err) {
				return err
			}
			assistantConfigUsable = false
			slog.Warn("assistant config is malformed; continuing with fallback agent configuration", "err", err)
		}
	}
	if assistantConfigUsable {
		if err := initializePhase(ctx, "agent_config_seed", func() error {
			return h.acpNavHandler.SeedAgentServersIfNeeded(ctx, toMethodsAgentServers(h.config.ACPAgentServers))
		}); err != nil {
			if !acpnav.IsAssistantConfigParseError(err) {
				return err
			}
			assistantConfigUsable = false
			slog.Warn("assistant config is malformed; continuing with fallback agent configuration", "err", err)
		}
	}
	if assistantConfigUsable && assistantConfigStore != nil {
		repairACPRegistryAgentServerInstalls(ctx, assistantConfigStore)
	}
	return nil
}

// initializePhase makes the readiness boundary observable without changing its
// ordering. Schema/config migration and seeding are required; install repair is
// already asynchronous and must not be mistaken for blocking initialization.
func initializePhase(ctx context.Context, name string, work func() error) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if !trace.IsEnabled() && !slog.Default().Enabled(ctx, slog.LevelDebug) {
		return work()
	}
	region := trace.StartRegion(ctx, "helper.initialize."+name)
	defer region.End()
	started := time.Now()
	err := work()
	slog.DebugContext(ctx, "helper startup phase", "phase", name, "duration", time.Since(started), "success", err == nil)
	return err
}

func repairACPRegistryAgentServerInstalls(ctx context.Context, store *acpnav.AssistantConfigAgentServerStore) {
	if ctx == nil {
		ctx = context.Background()
	} else {
		ctx = context.WithoutCancel(ctx)
	}
	goroutine.WithRecover(func() {
		repairCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		if err := store.RepairInstalledRegistryAgentServers(repairCtx, resolveACPRegistryAgentServerConfig); err != nil {
			slog.Warn("failed to repair installed ACP registry agent server state", "err", err)
		}
	})
}

func (h *CamberHandler) SetACPNavAgentServers(ctx context.Context, req *methods.ACPNavSetAgentServersParams, gCtx *glsp.Context) (methods.ACPNavAgentServersState, error) {
	before := h.activeACPAgentServers(ctx)
	state, err := h.acpNavHandler.SetAgentServers(ctx, req, gCtx)
	if err != nil {
		return methods.ACPNavAgentServersState{}, err
	}
	state = h.agentServersForHost(state)
	after := toProxyAgentServers(state.AgentServers)
	if err := h.acpProxyHandler.StopChangedAgentServers(before, after); err != nil {
		slog.Warn("failed to stop changed ACP agent subprocesses after agent server update", "err", err)
	}
	return state, nil
}

// CheckACPNavAgentRuntimes reports whether the runtimes registry agent
// distributions launch through resolve on the environment agent subprocesses
// spawn with, so the marketplace can warn about a missing runtime before an
// install instead of failing on first launch.
func (h *CamberHandler) CheckACPNavAgentRuntimes(_ context.Context, _ *methods.ACPNavCheckAgentRuntimesParams, _ *glsp.Context) (methods.ACPNavAgentRuntimesState, error) {
	path, available := acpproxy.LookupExecutable("npx")
	return methods.ACPNavAgentRuntimesState{
		NPX: methods.ACPNavAgentRuntimeStatus{Available: available, Path: path},
	}, nil
}

func (h *CamberHandler) InstallACPNavAgentServer(ctx context.Context, req *methods.ACPNavInstallAgentServerParams, _ *glsp.Context) (methods.ACPNavInstallAgentServerOutput, error) {
	if len(req.Config.Binary) == 0 {
		if err := h.acpNavHandler.RecordInstalledRegistryAgentServer(ctx, req.AgentServer, req.Config); err != nil {
			return methods.ACPNavInstallAgentServerOutput{}, err
		}
		return methods.ACPNavInstallAgentServerOutput{Installed: true}, nil
	}
	if _, _, _, err := acpproxy.PrepareRegistryBinary(ctx, req.AgentServer, toProxyAgentServerBinaries(req.Config.Binary)); err != nil {
		return methods.ACPNavInstallAgentServerOutput{}, err
	}
	if err := h.acpNavHandler.RecordInstalledRegistryAgentServer(ctx, req.AgentServer, req.Config); err != nil {
		return methods.ACPNavInstallAgentServerOutput{}, err
	}
	return methods.ACPNavInstallAgentServerOutput{Installed: true}, nil
}

func (h *CamberHandler) activeACPAgentServers(ctx context.Context) map[string]acpproxy.AgentServerConfig {
	if h.acpNavHandler != nil && h.acpNavHandler.HasStore() {
		agentServers, err := h.acpNavHandler.AgentServers(ctx)
		if err == nil {
			state := h.agentServersForHost(methods.ACPNavAgentServersState{AgentServers: agentServers})
			return toProxyAgentServers(state.AgentServers)
		}
		slog.Warn("failed to load ACP agent servers from assistant config; falling back to config", "err", err)
	}
	state := h.agentServersForHost(methods.ACPNavAgentServersState{
		AgentServers: toMethodsAgentServers(h.config.ACPAgentServers),
	})
	return toProxyAgentServers(state.AgentServers)
}

func toMethodsAgentServers(agentServers map[string]acpproxy.AgentServerConfig) methods.ACPAgentServers {
	converted := methods.ACPAgentServers{}
	for name, cfg := range agentServers {
		converted[name] = toMethodsAgentServerConfig(cfg)
	}
	return converted
}

func resolveACPRegistryAgentServerConfig(ctx context.Context, agentServer string) (methods.ACPAgentServerConfig, error) {
	cfg, err := acpproxy.RegistryAgentServerConfig(ctx, agentServer)
	if err != nil {
		return methods.ACPAgentServerConfig{}, err
	}
	return toMethodsAgentServerConfig(cfg), nil
}

func toMethodsAgentServerConfig(cfg acpproxy.AgentServerConfig) methods.ACPAgentServerConfig {
	return methods.ACPAgentServerConfig{
		Type:                 cfg.Type,
		Command:              cfg.Command,
		Args:                 cfg.Args,
		Env:                  cfg.Env,
		Binary:               toMethodsAgentServerBinaries(cfg.Binary),
		DefaultConfigOptions: cfg.DefaultConfigOptions,
	}
}

func toProxyAgentServers(agentServers methods.ACPAgentServers) map[string]acpproxy.AgentServerConfig {
	converted := map[string]acpproxy.AgentServerConfig{}
	for name, cfg := range agentServers {
		converted[name] = acpproxy.AgentServerConfig{
			Type:                 cfg.Type,
			Command:              cfg.Command,
			Args:                 cfg.Args,
			Env:                  cfg.Env,
			Binary:               toProxyAgentServerBinaries(cfg.Binary),
			DefaultConfigOptions: cfg.DefaultConfigOptions,
		}
	}
	return converted
}

func toMethodsAgentServerBinaries(binaries map[string]acpproxy.AgentServerBinaryDistribution) map[string]methods.ACPAgentServerBinaryDistribution {
	if len(binaries) == 0 {
		return nil
	}
	converted := map[string]methods.ACPAgentServerBinaryDistribution{}
	for target, binary := range binaries {
		converted[target] = methods.ACPAgentServerBinaryDistribution{
			Archive: binary.Archive,
			SHA256:  binary.SHA256,
			Cmd:     binary.Cmd,
			Args:    binary.Args,
			Env:     binary.Env,
		}
	}
	return converted
}

func toProxyAgentServerBinaries(binaries map[string]methods.ACPAgentServerBinaryDistribution) map[string]acpproxy.AgentServerBinaryDistribution {
	if len(binaries) == 0 {
		return nil
	}
	converted := map[string]acpproxy.AgentServerBinaryDistribution{}
	for target, binary := range binaries {
		converted[target] = acpproxy.AgentServerBinaryDistribution{
			Archive: binary.Archive,
			SHA256:  binary.SHA256,
			Cmd:     binary.Cmd,
			Args:    binary.Args,
			Env:     binary.Env,
		}
	}
	return converted
}
