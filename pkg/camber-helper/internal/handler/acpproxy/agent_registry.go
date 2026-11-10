package acpproxy

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sync"
)

const acpAgentRegistryURL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json"

var (
	defaultRegistryMu  sync.Mutex
	defaultRegistryURL = acpAgentRegistryURL
)

type acpAgentRegistry struct {
	Agents []acpRegistryAgent `json:"agents"`
}

type acpRegistryAgent struct {
	ID           string                  `json:"id"`
	Distribution acpRegistryDistribution `json:"distribution"`
}

type acpRegistryDistribution struct {
	Binary map[string]AgentServerBinaryDistribution `json:"binary,omitempty"`
	NPX    *acpRegistryPackageDistribution          `json:"npx,omitempty"`
	UVX    *acpRegistryPackageDistribution          `json:"uvx,omitempty"`
}

type acpRegistryPackageDistribution struct {
	Package string            `json:"package"`
	Args    []string          `json:"args,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
}

// AgentInstallError marks a failure to resolve or download an ACP agent's
// distribution (registry fetch, binary download), so callers can surface an
// actionable "check your connection and retry" state instead of a generic
// agent error.
type AgentInstallError struct {
	AgentServer string
	Err         error
}

func (e *AgentInstallError) Error() string {
	return fmt.Sprintf("acpproxy: install agent server %q: %v", e.AgentServer, e.Err)
}

func (e *AgentInstallError) Unwrap() error {
	return e.Err
}

func defaultCamberAgentServerConfig(ctx context.Context) (AgentServerConfig, error) {
	return RegistryAgentServerConfig(ctx, DefaultAgentServerName)
}

// RegistryAgentServerConfig resolves an agent's config from the ACP registry.
// Every call fetches so config stays fresh; the last successful resolution is
// persisted and used as a fallback when the fetch fails (e.g. offline), so an
// already-downloaded agent keeps working without the registry.
func RegistryAgentServerConfig(ctx context.Context, agentID string) (AgentServerConfig, error) {
	defaultRegistryMu.Lock()
	registryURL := defaultRegistryURL
	defaultRegistryMu.Unlock()

	cfg, err := fetchRegistryAgentServerConfig(ctx, registryURL, agentID)
	if err != nil {
		if cached, cacheErr := loadCachedRegistryAgentServerConfig(agentID); cacheErr == nil {
			slog.Warn("acpproxy: using cached ACP registry config after fetch failure", "agent", agentID, "err", err)
			return cached, nil
		}
		return AgentServerConfig{}, &AgentInstallError{AgentServer: agentID, Err: err}
	}
	if saveErr := saveCachedRegistryAgentServerConfig(agentID, cfg); saveErr != nil {
		slog.Debug("acpproxy: failed to cache ACP registry config", "agent", agentID, "err", saveErr)
	}
	return cloneAgentServerConfig(cfg), nil
}

func fetchRegistryAgentServerConfig(ctx context.Context, registryURL, agentID string) (AgentServerConfig, error) {
	if err := checkRegistryURLString(registryURL); err != nil {
		return AgentServerConfig{}, fmt.Errorf("acpproxy: fetch ACP registry: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, registryURL, nil)
	if err != nil {
		return AgentServerConfig{}, err
	}
	resp, err := registryHTTPClient(registryFetchTimeout).Do(req)
	if err != nil {
		return AgentServerConfig{}, fmt.Errorf("acpproxy: fetch ACP registry: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return AgentServerConfig{}, fmt.Errorf("acpproxy: fetch ACP registry: HTTP %d", resp.StatusCode)
	}

	var registry acpAgentRegistry
	if err := json.NewDecoder(io.LimitReader(resp.Body, registryMetadataMaxBytes)).Decode(&registry); err != nil {
		return AgentServerConfig{}, fmt.Errorf("acpproxy: decode ACP registry: %w", err)
	}
	for _, agent := range registry.Agents {
		if agent.ID != agentID {
			continue
		}
		cfg, ok := agentServerConfigFromRegistryDistribution(agent.Distribution)
		if !ok {
			return AgentServerConfig{}, fmt.Errorf("acpproxy: ACP registry agent %q has no supported distribution", agentID)
		}
		return cfg, nil
	}
	return AgentServerConfig{}, fmt.Errorf("acpproxy: ACP registry agent %q not found", agentID)
}

func agentServerConfigFromRegistryDistribution(distribution acpRegistryDistribution) (AgentServerConfig, bool) {
	if distribution.NPX != nil && distribution.NPX.Package != "" {
		return AgentServerConfig{
			Type:    "registry",
			Command: "npx",
			Args:    append([]string{"-y", distribution.NPX.Package}, distribution.NPX.Args...),
			Env:     distribution.NPX.Env,
		}, true
	}
	if distribution.UVX != nil && distribution.UVX.Package != "" {
		return AgentServerConfig{
			Type:    "registry",
			Command: "uvx",
			Args:    append([]string{distribution.UVX.Package}, distribution.UVX.Args...),
			Env:     distribution.UVX.Env,
		}, true
	}
	if len(distribution.Binary) > 0 {
		return AgentServerConfig{
			Type:   "registry",
			Binary: distribution.Binary,
		}, true
	}
	return AgentServerConfig{}, false
}

func cloneAgentServerConfig(cfg AgentServerConfig) AgentServerConfig {
	return AgentServerConfig{
		Type:                 cfg.Type,
		Command:              cfg.Command,
		Args:                 append([]string(nil), cfg.Args...),
		Env:                  cloneStringMap(cfg.Env),
		Binary:               cloneBinaryDistributionMap(cfg.Binary),
		DefaultConfigOptions: cloneStringMap(cfg.DefaultConfigOptions),
	}
}

func cloneBinaryDistributionMap(input map[string]AgentServerBinaryDistribution) map[string]AgentServerBinaryDistribution {
	if len(input) == 0 {
		return nil
	}
	cloned := make(map[string]AgentServerBinaryDistribution, len(input))
	for key, value := range input {
		value.Args = append([]string(nil), value.Args...)
		value.Env = cloneStringMap(value.Env)
		cloned[key] = value
	}
	return cloned
}

func cloneStringMap(input map[string]string) map[string]string {
	if len(input) == 0 {
		return nil
	}
	cloned := make(map[string]string, len(input))
	for key, value := range input {
		cloned[key] = value
	}
	return cloned
}
