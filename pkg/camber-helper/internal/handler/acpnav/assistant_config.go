package acpnav

import (
	"context"
	"encoding/json"
	stderrors "errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"github.com/appleton/camber/pkg/camber-helper/internal/handler/acpregistry"
	"github.com/appleton/camber/pkg/camber-helper/methods"
	"github.com/appleton/camber/pkg/common/userconfig"
)

const assistantConfigFilename = "assistant.json"
const assistantConfigSchemaURL = "https://raw.githubusercontent.com/appleton/camber/main/schemas/assistant/v1.json"
const assistantRegistryInstallsFilename = "assistant-registry-installs.json"
const assistantConfigAgentServerTypeRegistry = "registry"
const assistantConfigAgentServerTypeCustom = "custom"
const assistantConfigAgentServerTypeLocal = "local"

type AgentServerStore interface {
	ListAgentServers(ctx context.Context) (methods.ACPAgentServers, error)
	GetDefaultAgentServer(ctx context.Context) (string, error)
	GetDefaultAgentServerPinned(ctx context.Context) (bool, error)
	SetAgentServers(ctx context.Context, agentServers methods.ACPAgentServers, defaultAgentServer *string, defaultAgentServerPinned *bool) error
	SeedAgentServersIfNeeded(ctx context.Context, agentServers methods.ACPAgentServers) error
}

type AssistantConfigAgentServerStore struct {
	path string
	mu   sync.Mutex
}

type AssistantRegistryAgentServerResolver func(context.Context, string) (methods.ACPAgentServerConfig, error)

type assistantConfig struct {
	AgentServers             methods.ACPAgentServers `json:"agent_servers,omitempty"`
	DefaultAgentServer       string                  `json:"default_agent_server,omitempty"`
	DefaultAgentServerPinned bool                    `json:"default_agent_server_pinned,omitempty"`
}

type assistantConfigParseError struct {
	path string
	err  error
}

func (e *assistantConfigParseError) Error() string {
	return fmt.Sprintf("assistant config: parsing %s: %v", e.path, e.err)
}

func (e *assistantConfigParseError) Unwrap() error {
	return e.err
}

func IsAssistantConfigParseError(err error) bool {
	var parseError *assistantConfigParseError
	return stderrors.As(err, &parseError)
}

type assistantRegistryInstallState struct {
	AgentServers methods.ACPAgentServers `json:"agent_servers,omitempty"`
}

type assistantRegistryRepairCandidate struct {
	name       string
	configured methods.ACPAgentServerConfig
}

func AssistantConfigPath() string {
	if path := os.Getenv("CAMBER_ASSISTANT_CONFIG_PATH"); path != "" {
		return path
	}
	return userconfig.CamberConfigFile(assistantConfigFilename)
}

func NewAssistantConfigAgentServerStore(path string) *AssistantConfigAgentServerStore {
	return &AssistantConfigAgentServerStore{path: path}
}

func (s *AssistantConfigAgentServerStore) ListAgentServers(ctx context.Context) (methods.ACPAgentServers, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	cfg, _, err := s.loadLocked()
	if err != nil {
		return nil, err
	}
	if cfg.AgentServers == nil {
		return methods.ACPAgentServers{}, nil
	}
	installedAgentServers, err := loadAssistantRegistryInstalls(s.path)
	if err != nil {
		return nil, err
	}
	resolved, err := resolveAssistantConfigAgentServers(ctx, cfg.AgentServers, installedAgentServers)
	if err != nil {
		return nil, err
	}
	return withManagedAgentServers(resolved), nil
}

func (s *AssistantConfigAgentServerStore) GetDefaultAgentServer(ctx context.Context) (string, error) {
	_ = ctx
	s.mu.Lock()
	defer s.mu.Unlock()

	cfg, _, err := s.loadLocked()
	if err != nil {
		return "", err
	}
	return normalizeAgentServerName(cfg.DefaultAgentServer), nil
}

func (s *AssistantConfigAgentServerStore) GetDefaultAgentServerPinned(ctx context.Context) (bool, error) {
	_ = ctx
	s.mu.Lock()
	defer s.mu.Unlock()

	cfg, _, err := s.loadLocked()
	if err != nil {
		return false, err
	}
	return cfg.DefaultAgentServerPinned, nil
}

func (s *AssistantConfigAgentServerStore) SetAgentServers(ctx context.Context, agentServers methods.ACPAgentServers, defaultAgentServer *string, defaultAgentServerPinned *bool) error {
	_ = ctx
	normalized, err := normalizeAssistantConfigAgentServers(agentServers)
	if err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	cfg, raw, err := s.loadLocked()
	if err != nil {
		return err
	}
	cfg.AgentServers = normalized
	if defaultAgentServer != nil {
		cfg.DefaultAgentServer = strings.TrimSpace(normalizeAgentServerName(*defaultAgentServer))
	}
	if defaultAgentServerPinned != nil {
		cfg.DefaultAgentServerPinned = *defaultAgentServerPinned
	}
	return s.saveLocked(cfg, raw)
}

func (s *AssistantConfigAgentServerStore) SeedAgentServersIfNeeded(ctx context.Context, agentServers methods.ACPAgentServers) error {
	_ = ctx
	s.mu.Lock()
	defer s.mu.Unlock()

	cfg, raw, err := s.loadLocked()
	if err != nil {
		return err
	}
	if len(cfg.AgentServers) > 0 {
		return nil
	}
	normalized, err := normalizeAssistantConfigAgentServers(agentServers)
	if err != nil {
		return err
	}
	cfg.AgentServers = normalized
	return s.saveLocked(cfg, raw)
}

func (s *AssistantConfigAgentServerStore) MigrateFromDB(ctx context.Context, dbStore *Store) error {
	if dbStore == nil {
		return nil
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	cfg, raw, err := s.loadLocked()
	if err != nil {
		return err
	}

	agentServers, err := dbStore.ListAgentServers(ctx)
	if err != nil {
		return err
	}
	if len(agentServers) == 0 {
		return nil
	}

	merged := normalizeMigratedAgentServers(agentServers)
	for name, entry := range cfg.AgentServers {
		merged[name] = cloneAgentServerConfig(entry)
	}
	cfg.AgentServers = merged
	defaultAgentServer, err := dbStore.GetDefaultAgentServer(ctx)
	if err != nil {
		return err
	}
	if strings.TrimSpace(cfg.DefaultAgentServer) == "" {
		cfg.DefaultAgentServer = defaultAgentServer
	}
	if err := s.saveLocked(cfg, raw); err != nil {
		return err
	}

	emptyDefaultAgentServer := ""
	return dbStore.SetAgentServers(ctx, methods.ACPAgentServers{}, &emptyDefaultAgentServer, nil)
}

func (s *AssistantConfigAgentServerStore) RepairInstalledRegistryAgentServers(ctx context.Context, resolve AssistantRegistryAgentServerResolver) error {
	if resolve == nil {
		return nil
	}

	candidates, err := s.installedRegistryAgentServerRepairCandidates()
	if err != nil {
		return err
	}
	if len(candidates) == 0 {
		return nil
	}

	repairs := methods.ACPAgentServers{}
	for _, candidate := range candidates {
		resolved, err := resolve(ctx, candidate.name)
		if err != nil {
			continue
		}
		resolved = cloneAgentServerConfig(resolved)
		resolved.Type = assistantConfigAgentServerTypeRegistry
		resolved.DefaultConfigOptions = cloneStringMap(candidate.configured.DefaultConfigOptions)
		resolved.PinnedConfigOptions = cloneStringSlice(candidate.configured.PinnedConfigOptions)
		if !installedAssistantRegistryConfigAvailable(candidate.name, resolved) {
			continue
		}
		repairs[candidate.name] = resolved
	}
	if len(repairs) == 0 {
		return nil
	}
	return s.recordInstalledRegistryAgentServerRepairs(repairs)
}

func (s *AssistantConfigAgentServerStore) installedRegistryAgentServerRepairCandidates() ([]assistantRegistryRepairCandidate, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	cfg, _, err := s.loadLocked()
	if err != nil {
		return nil, err
	}

	installsPath := assistantRegistryInstallsPath(s.path)
	state, err := loadAssistantRegistryInstallState(installsPath)
	if err != nil {
		return nil, err
	}
	if state.AgentServers == nil {
		state.AgentServers = methods.ACPAgentServers{}
	}

	candidates := []assistantRegistryRepairCandidate{}
	for name, configured := range cfg.AgentServers {
		name = normalizeAgentServerName(name)
		if name == "" || configured.Type != assistantConfigAgentServerTypeRegistry {
			continue
		}
		if installed, ok := state.AgentServers[name]; ok && installedAssistantRegistryConfigAvailable(name, installed) {
			continue
		}
		candidates = append(candidates, assistantRegistryRepairCandidate{
			name:       name,
			configured: cloneAgentServerConfig(configured),
		})
	}
	if _, ok := cfg.AgentServers[defaultAgentServerName]; !ok {
		if installed, ok := state.AgentServers[defaultAgentServerName]; !ok || !installedAssistantRegistryConfigAvailable(defaultAgentServerName, installed) {
			candidates = append(candidates, assistantRegistryRepairCandidate{
				name: defaultAgentServerName,
				configured: methods.ACPAgentServerConfig{
					Type: assistantConfigAgentServerTypeRegistry,
				},
			})
		}
	}
	return candidates, nil
}

func (s *AssistantConfigAgentServerStore) recordInstalledRegistryAgentServerRepairs(repairs methods.ACPAgentServers) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	cfg, _, err := s.loadLocked()
	if err != nil {
		return err
	}
	installsPath := assistantRegistryInstallsPath(s.path)
	state, err := loadAssistantRegistryInstallState(installsPath)
	if err != nil {
		return err
	}
	if state.AgentServers == nil {
		state.AgentServers = methods.ACPAgentServers{}
	}

	changed := false
	for name, resolved := range repairs {
		configured, ok := cfg.AgentServers[name]
		if !ok && name == defaultAgentServerName {
			configured = methods.ACPAgentServerConfig{Type: assistantConfigAgentServerTypeRegistry}
			ok = true
		}
		if !ok || configured.Type != assistantConfigAgentServerTypeRegistry {
			continue
		}
		if installed, ok := state.AgentServers[name]; ok && installedAssistantRegistryConfigAvailable(name, installed) {
			continue
		}
		resolved = cloneAgentServerConfig(resolved)
		resolved.Type = assistantConfigAgentServerTypeRegistry
		resolved.DefaultConfigOptions = cloneStringMap(configured.DefaultConfigOptions)
		resolved.PinnedConfigOptions = cloneStringSlice(configured.PinnedConfigOptions)
		state.AgentServers[name] = resolved
		changed = true
	}

	if !changed {
		return nil
	}
	return saveAssistantRegistryInstallState(installsPath, state)
}

func (s *AssistantConfigAgentServerStore) RecordInstalledRegistryAgentServer(ctx context.Context, name string, cfg methods.ACPAgentServerConfig) error {
	_ = ctx
	s.mu.Lock()
	defer s.mu.Unlock()

	return s.recordInstalledRegistryAgentServerLocked(name, cfg)
}

func (s *AssistantConfigAgentServerStore) loadLocked() (assistantConfig, map[string]json.RawMessage, error) {
	if s.path == "" {
		return assistantConfig{}, map[string]json.RawMessage{}, nil
	}
	data, err := os.ReadFile(s.path)
	if err != nil {
		if stderrors.Is(err, os.ErrNotExist) {
			return assistantConfig{}, map[string]json.RawMessage{}, nil
		}
		return assistantConfig{}, nil, fmt.Errorf("assistant config: reading %s: %w", s.path, err)
	}

	raw := map[string]json.RawMessage{}
	if err := json.Unmarshal(data, &raw); err != nil {
		return assistantConfig{}, nil, &assistantConfigParseError{path: s.path, err: err}
	}
	var cfg assistantConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return assistantConfig{}, nil, &assistantConfigParseError{path: s.path, err: err}
	}
	if cfg.AgentServers == nil {
		cfg.AgentServers = methods.ACPAgentServers{}
	}
	return cfg, raw, nil
}

func (s *AssistantConfigAgentServerStore) saveLocked(cfg assistantConfig, raw map[string]json.RawMessage) error {
	if s.path == "" {
		return nil
	}
	if raw == nil {
		raw = map[string]json.RawMessage{}
	}
	if _, ok := raw["$schema"]; !ok {
		schemaJSON, err := json.Marshal(assistantConfigSchemaURL)
		if err != nil {
			return fmt.Errorf("assistant config: encoding $schema: %w", err)
		}
		raw["$schema"] = schemaJSON
	}

	agentServersJSON, err := json.Marshal(compactAssistantConfigAgentServers(cfg.AgentServers))
	if err != nil {
		return fmt.Errorf("assistant config: encoding agent_servers: %w", err)
	}
	raw["agent_servers"] = agentServersJSON

	defaultAgentServer := strings.TrimSpace(cfg.DefaultAgentServer)
	if defaultAgentServer == "" {
		delete(raw, "default_agent_server")
	} else {
		defaultAgentServer = normalizeAgentServerName(defaultAgentServer)
		defaultJSON, err := json.Marshal(defaultAgentServer)
		if err != nil {
			return fmt.Errorf("assistant config: encoding default_agent_server: %w", err)
		}
		raw["default_agent_server"] = defaultJSON
	}

	if cfg.DefaultAgentServerPinned {
		raw["default_agent_server_pinned"] = json.RawMessage("true")
	} else {
		delete(raw, "default_agent_server_pinned")
	}

	data, err := json.MarshalIndent(raw, "", "  ")
	if err != nil {
		return fmt.Errorf("assistant config: encoding %s: %w", s.path, err)
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return fmt.Errorf("assistant config: creating directory: %w", err)
	}
	if err := os.WriteFile(s.path, append(data, '\n'), 0o644); err != nil {
		return fmt.Errorf("assistant config: writing %s: %w", s.path, err)
	}
	return nil
}

func (s *AssistantConfigAgentServerStore) recordInstalledRegistryAgentServerLocked(name string, cfg methods.ACPAgentServerConfig) error {
	name = normalizeAgentServerName(name)
	if name == "" {
		return fmt.Errorf("assistant config: installed agent server name is required")
	}
	cfg = cloneAgentServerConfig(cfg)
	cfg.Type = assistantConfigAgentServerTypeRegistry

	path := assistantRegistryInstallsPath(s.path)
	state, err := loadAssistantRegistryInstallState(path)
	if err != nil {
		return err
	}
	if state.AgentServers == nil {
		state.AgentServers = methods.ACPAgentServers{}
	}
	state.AgentServers[name] = cfg
	return saveAssistantRegistryInstallState(path, state)
}

func loadAssistantRegistryInstalls(configPath string) (methods.ACPAgentServers, error) {
	state, err := loadAssistantRegistryInstallState(assistantRegistryInstallsPath(configPath))
	if err != nil {
		return nil, err
	}
	if state.AgentServers == nil {
		return methods.ACPAgentServers{}, nil
	}
	return cloneAgentServers(state.AgentServers), nil
}

func assistantRegistryInstallsPath(configPath string) string {
	if configPath == "" {
		return ""
	}
	return filepath.Join(filepath.Dir(configPath), assistantRegistryInstallsFilename)
}

func loadAssistantRegistryInstallState(path string) (assistantRegistryInstallState, error) {
	if path == "" {
		return assistantRegistryInstallState{AgentServers: methods.ACPAgentServers{}}, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if stderrors.Is(err, os.ErrNotExist) {
			return assistantRegistryInstallState{AgentServers: methods.ACPAgentServers{}}, nil
		}
		return assistantRegistryInstallState{}, fmt.Errorf("assistant config: reading registry installs %s: %w", path, err)
	}
	var state assistantRegistryInstallState
	if err := json.Unmarshal(data, &state); err != nil {
		return assistantRegistryInstallState{}, fmt.Errorf("assistant config: parsing registry installs %s: %w", path, err)
	}
	if state.AgentServers == nil {
		state.AgentServers = methods.ACPAgentServers{}
	}
	return state, nil
}

func saveAssistantRegistryInstallState(path string, state assistantRegistryInstallState) error {
	if path == "" {
		return nil
	}
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return fmt.Errorf("assistant config: encoding registry installs %s: %w", path, err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("assistant config: creating registry installs directory: %w", err)
	}
	if err := os.WriteFile(path, append(data, '\n'), 0o644); err != nil {
		return fmt.Errorf("assistant config: writing registry installs %s: %w", path, err)
	}
	return nil
}

func cloneAgentServers(input methods.ACPAgentServers) methods.ACPAgentServers {
	if len(input) == 0 {
		return methods.ACPAgentServers{}
	}
	out := make(methods.ACPAgentServers, len(input))
	for name, cfg := range input {
		out[name] = cloneAgentServerConfig(cfg)
	}
	return out
}

func cloneAgentServerConfig(cfg methods.ACPAgentServerConfig) methods.ACPAgentServerConfig {
	cloned := cfg
	if cfg.Args != nil {
		cloned.Args = append([]string{}, cfg.Args...)
	}
	if cfg.Env != nil {
		cloned.Env = cloneStringMap(cfg.Env)
	}
	if cfg.Binary != nil {
		cloned.Binary = make(map[string]methods.ACPAgentServerBinaryDistribution, len(cfg.Binary))
		for target, binary := range cfg.Binary {
			if binary.Args != nil {
				binary.Args = append([]string{}, binary.Args...)
			}
			if binary.Env != nil {
				binary.Env = cloneStringMap(binary.Env)
			}
			cloned.Binary[target] = binary
		}
	}
	if cfg.DefaultConfigOptions != nil {
		cloned.DefaultConfigOptions = cloneStringMap(cfg.DefaultConfigOptions)
	}
	if cfg.PinnedConfigOptions != nil {
		cloned.PinnedConfigOptions = cloneStringSlice(cfg.PinnedConfigOptions)
	}
	return cloned
}

func normalizeAssistantConfigAgentServers(agentServers methods.ACPAgentServers) (methods.ACPAgentServers, error) {
	normalized := methods.ACPAgentServers{}
	for name, cfg := range agentServers {
		name = normalizeAgentServerName(name)
		if name == "" {
			return nil, fmt.Errorf("agent server name is required")
		}
		cfg.Type = strings.TrimSpace(cfg.Type)
		cfg.Command = strings.TrimSpace(cfg.Command)
		if cfg.Type == assistantConfigAgentServerTypeRegistry {
			normalized[name] = cfg
			continue
		}
		if name == methods.LocalAgentServerName {
			if cfg.Type == "" {
				cfg.Type = assistantConfigAgentServerTypeLocal
			}
			normalized[name] = cfg
			continue
		}
		cfg.Type = assistantConfigAgentServerTypeCustom
		if cfg.Command == "" && len(cfg.Binary) == 0 && name != defaultAgentServerName {
			return nil, fmt.Errorf("agent server %q command is required", name)
		}
		normalized[name] = cfg
	}
	return normalized, nil
}

func normalizeMigratedAgentServers(agentServers methods.ACPAgentServers) methods.ACPAgentServers {
	normalized := methods.ACPAgentServers{}
	for name, cfg := range agentServers {
		name = normalizeAgentServerName(name)
		if name == "" {
			continue
		}
		if cfg.Type == assistantConfigAgentServerTypeRegistry || len(cfg.Binary) > 0 {
			cfg = methods.ACPAgentServerConfig{
				Type:                 assistantConfigAgentServerTypeRegistry,
				DefaultConfigOptions: cfg.DefaultConfigOptions,
				PinnedConfigOptions:  cfg.PinnedConfigOptions,
			}
		} else {
			cfg.Type = assistantConfigAgentServerTypeCustom
		}
		normalized[name] = cfg
	}
	return normalized
}

func compactAssistantConfigAgentServers(agentServers methods.ACPAgentServers) methods.ACPAgentServers {
	compacted := methods.ACPAgentServers{}
	for name, cfg := range agentServers {
		cfg = cloneAgentServerConfig(cfg)
		name = normalizeAgentServerName(name)
		if name == methods.LocalAgentServerName && cfg.Command == "" && len(cfg.Binary) == 0 {
			compacted[name] = methods.ACPAgentServerConfig{
				Type:                 assistantConfigAgentServerTypeLocal,
				DefaultConfigOptions: cfg.DefaultConfigOptions,
				PinnedConfigOptions:  cfg.PinnedConfigOptions,
			}
			continue
		}
		if cfg.Type == assistantConfigAgentServerTypeRegistry || len(cfg.Binary) > 0 {
			compacted[name] = methods.ACPAgentServerConfig{
				Type:                 assistantConfigAgentServerTypeRegistry,
				DefaultConfigOptions: cfg.DefaultConfigOptions,
				PinnedConfigOptions:  cfg.PinnedConfigOptions,
			}
			continue
		}
		if cfg.Type == "" {
			cfg.Type = assistantConfigAgentServerTypeCustom
		}
		cfg.Binary = nil
		compacted[name] = cfg
	}
	return compacted
}

func resolveAssistantConfigAgentServers(ctx context.Context, agentServers methods.ACPAgentServers, installedAgentServers methods.ACPAgentServers) (methods.ACPAgentServers, error) {
	_ = ctx
	resolved := methods.ACPAgentServers{}
	for name, cfg := range agentServers {
		name = normalizeAgentServerName(name)
		if cfg.Type != assistantConfigAgentServerTypeRegistry {
			resolved[name] = cloneAgentServerConfig(cfg)
			continue
		}
		installed, ok := installedAgentServers[name]
		if !ok || !installedAssistantRegistryConfigAvailable(name, installed) {
			unresolved := cloneAgentServerConfig(cfg)
			unresolved.Type = assistantConfigAgentServerTypeRegistry
			resolved[name] = unresolved
			continue
		}
		installed = cloneAgentServerConfig(installed)
		installed.Type = assistantConfigAgentServerTypeRegistry
		installed.DefaultConfigOptions = cloneStringMap(cfg.DefaultConfigOptions)
		installed.PinnedConfigOptions = cloneStringSlice(cfg.PinnedConfigOptions)
		resolved[name] = installed
	}
	return resolved, nil
}

func withManagedAgentServers(agentServers methods.ACPAgentServers) methods.ACPAgentServers {
	out := methods.ACPAgentServers{}
	for name, cfg := range agentServers {
		out[normalizeAgentServerName(name)] = cloneAgentServerConfig(cfg)
	}
	if _, ok := out[defaultAgentServerName]; !ok {
		out[defaultAgentServerName] = methods.ACPAgentServerConfig{
			Type: assistantConfigAgentServerTypeCustom,
		}
	}
	if _, ok := out[methods.LocalAgentServerName]; !ok {
		out[methods.LocalAgentServerName] = methods.ACPAgentServerConfig{
			Type: assistantConfigAgentServerTypeLocal,
		}
	}
	return out
}

func installedAssistantRegistryConfigAvailable(name string, cfg methods.ACPAgentServerConfig) bool {
	if cfg.Command != "" {
		return true
	}
	if len(cfg.Binary) == 0 {
		return false
	}
	return installedAssistantRegistryBinaryAvailable(name, cfg.Binary)
}

func installedAssistantRegistryBinaryAvailable(name string, binaries map[string]methods.ACPAgentServerBinaryDistribution) bool {
	target, err := acpregistry.BinaryTarget(runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return false
	}
	binary, ok := binaries[target]
	if !ok || binary.Archive == "" || binary.Cmd == "" {
		return false
	}
	root, err := acpregistry.BinaryInstallRoot(name, binary.Archive, binary.SHA256)
	if err != nil {
		return false
	}
	command := filepath.Clean(filepath.Join(root, binary.Cmd))
	if !strings.HasPrefix(command, root+string(os.PathSeparator)) && command != root {
		return false
	}
	if _, err := os.Stat(command); err != nil {
		return false
	}
	return true
}

func cloneStringSlice(input []string) []string {
	if len(input) == 0 {
		return nil
	}
	return append([]string{}, input...)
}

func cloneStringMap(input map[string]string) map[string]string {
	if len(input) == 0 {
		return nil
	}
	out := make(map[string]string, len(input))
	for key, value := range input {
		out[key] = value
	}
	return out
}
