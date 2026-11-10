package acpproxy

import (
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/appleton/camber/pkg/camber-helper/internal/handler/acpregistry"
)

const registryConfigCacheFilename = "registry-config.json"

// cachedRegistryAgentServerConfigPath returns the on-disk location of the
// last-known-good registry config for an agent, alongside its binary installs.
func cachedRegistryAgentServerConfigPath(agentID string) (string, error) {
	root, err := acpregistry.AgentsCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, acpregistry.SafePathPart(agentID), registryConfigCacheFilename), nil
}

func loadCachedRegistryAgentServerConfig(agentID string) (AgentServerConfig, error) {
	path, err := cachedRegistryAgentServerConfigPath(agentID)
	if err != nil {
		return AgentServerConfig{}, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return AgentServerConfig{}, err
	}
	var cfg AgentServerConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return AgentServerConfig{}, err
	}
	return cfg, nil
}

func saveCachedRegistryAgentServerConfig(agentID string, cfg AgentServerConfig) error {
	path, err := cachedRegistryAgentServerConfigPath(agentID)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.Marshal(cfg)
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}
