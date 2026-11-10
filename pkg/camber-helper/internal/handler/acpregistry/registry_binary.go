package acpregistry

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func BinaryTarget(goos, goarch string) (string, error) {
	arch := map[string]string{
		"amd64": "x86_64",
		"arm64": "aarch64",
	}[goarch]
	if arch == "" {
		return "", fmt.Errorf("unsupported ACP binary architecture %q", goarch)
	}

	switch goos {
	case "darwin", "linux":
		return goos + "-" + arch, nil
	case "windows":
		return "windows-" + arch, nil
	default:
		return "", fmt.Errorf("unsupported ACP binary platform %q", goos)
	}
}

// AgentsCacheDir returns the root directory holding downloaded ACP agent
// binaries and their cached registry configs. CAMBER_ACP_AGENTS_DIR overrides
// the default (os.UserCacheDir()/camber/acp-agents); pointing it at an empty
// directory simulates a machine that has not yet downloaded an agent binary,
// which is useful for exercising the install/download flow and its failures.
func AgentsCacheDir() (string, error) {
	if dir := os.Getenv("CAMBER_ACP_AGENTS_DIR"); dir != "" {
		return dir, nil
	}
	cacheDir, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(cacheDir, "poolside", "acp-agents"), nil
}

func BinaryInstallRoot(serverName, archive, checksum string) (string, error) {
	checksum = strings.TrimSpace(checksum)
	if _, err := DecodeSHA256(checksum); err != nil {
		return "", err
	}
	root, err := AgentsCacheDir()
	if err != nil {
		return "", err
	}
	cacheKey := archive
	if checksum != "" {
		cacheKey += "\x00sha256:" + strings.ToLower(checksum)
	}
	sum := sha256.Sum256([]byte(cacheKey))
	archiveID := hex.EncodeToString(sum[:])[:16]
	return filepath.Join(root, SafePathPart(serverName), archiveID), nil
}

// DecodeSHA256 decodes a hex-encoded SHA-256 checksum, returning nil bytes for
// an empty value so callers can treat verification as optional.
func DecodeSHA256(value string) ([]byte, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, nil
	}
	decoded, err := hex.DecodeString(value)
	if err != nil || len(decoded) != sha256.Size {
		return nil, fmt.Errorf("invalid ACP binary SHA-256 checksum %q", value)
	}
	return decoded, nil
}

func SafePathPart(value string) string {
	replacer := strings.NewReplacer("/", "_", "\\", "_", ":", "_")
	return replacer.Replace(value)
}
