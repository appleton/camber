package secrets

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/appleton/camber/pkg/common/userconfig"
)

const (
	camberSecretsIndexVersion = 1
	camberIndexDirectoryMode  = 0o700
	camberIndexFileMode       = 0o600
)

type camberSecretsIndex struct {
	Version       int                              `json:"version"`
	SecretsByName map[string]camberSecretIndexItem `json:"secretsByName"`
}

type camberSecretIndexItem struct {
	ID          string `json:"id"`
	Description string `json:"description"`
	UpdatedAt   string `json:"updatedAt"`
}

type camberSecretsIndexStore struct {
	path string
}

func newCamberSecretsIndexStore() *camberSecretsIndexStore {
	return &camberSecretsIndexStore{
		path: filepath.Join(userconfig.StateDirectory(), "helper", "secrets-index.json"),
	}
}

func (s *camberSecretsIndexStore) load() (*camberSecretsIndex, error) {
	data, err := os.ReadFile(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			return newCamberSecretsIndex(), nil
		}
		return nil, fmt.Errorf("%s: failed to read secrets index: %w", errorCodeReadingIndex, err)
	}

	index := &camberSecretsIndex{}
	if err := json.Unmarshal(data, index); err != nil {
		return nil, fmt.Errorf("%s: failed to parse secrets index: %w", errorCodeParsingIndex, err)
	}

	if err := validateCamberSecretsIndex(index); err != nil {
		return nil, err
	}

	return index, nil
}

func (s *camberSecretsIndexStore) save(index *camberSecretsIndex) error {
	if err := validateCamberSecretsIndex(index); err != nil {
		return err
	}

	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, camberIndexDirectoryMode); err != nil {
		return fmt.Errorf("failed to create secrets index directory: %w", err)
	}

	if err := os.Chmod(dir, camberIndexDirectoryMode); err != nil {
		return fmt.Errorf("failed to set secrets index directory permissions: %w", err)
	}

	data, err := json.Marshal(index)
	if err != nil {
		return fmt.Errorf("failed to serialize secrets index: %w", err)
	}

	tempFile, err := os.CreateTemp(dir, ".secrets-index-*.tmp")
	if err != nil {
		return fmt.Errorf("failed to create temporary secrets index file: %w", err)
	}

	tempPath := tempFile.Name()
	success := false
	defer func() {
		if !success {
			_ = os.Remove(tempPath)
		}
	}()

	if err := tempFile.Chmod(camberIndexFileMode); err != nil {
		_ = tempFile.Close()
		return fmt.Errorf("failed to set temporary secrets index permissions: %w", err)
	}

	if _, err := tempFile.Write(data); err != nil {
		_ = tempFile.Close()
		return fmt.Errorf("failed to write temporary secrets index: %w", err)
	}

	if err := tempFile.Sync(); err != nil {
		_ = tempFile.Close()
		return fmt.Errorf("failed to sync temporary secrets index: %w", err)
	}

	if err := tempFile.Close(); err != nil {
		return fmt.Errorf("failed to close temporary secrets index: %w", err)
	}

	if err := os.Rename(tempPath, s.path); err != nil {
		return fmt.Errorf("failed to replace secrets index: %w", err)
	}

	if err := os.Chmod(s.path, camberIndexFileMode); err != nil {
		return fmt.Errorf("failed to set secrets index permissions: %w", err)
	}

	success = true
	return nil
}

func newCamberSecretsIndex() *camberSecretsIndex {
	return &camberSecretsIndex{
		Version:       camberSecretsIndexVersion,
		SecretsByName: map[string]camberSecretIndexItem{},
	}
}

func validateCamberSecretsIndex(index *camberSecretsIndex) error {
	if index == nil {
		return fmt.Errorf("%s: secrets index is nil", errorCodeParsingIndex)
	}

	if index.Version != camberSecretsIndexVersion {
		return fmt.Errorf("%s: unsupported secrets index version %d", errorCodeParsingIndex, index.Version)
	}

	if index.SecretsByName == nil {
		index.SecretsByName = map[string]camberSecretIndexItem{}
	}

	return nil
}
