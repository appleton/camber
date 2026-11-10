package secrets

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newCamberSecretsIndexStoreAtPath(path string) *camberSecretsIndexStore {
	return &camberSecretsIndexStore{path: path}
}

func TestCamberSecretsIndexStore_LoadMissingFile(t *testing.T) {
	store := newCamberSecretsIndexStoreAtPath(filepath.Join(t.TempDir(), "helper", "secrets-index.json"))

	index, err := store.load()
	require.NoError(t, err)
	require.NotNil(t, index)

	assert.Equal(t, camberSecretsIndexVersion, index.Version)
	assert.Empty(t, index.SecretsByName)
}

func TestCamberSecretsIndexStore_SaveAndLoad(t *testing.T) {
	path := filepath.Join(t.TempDir(), "helper", "secrets-index.json")
	store := newCamberSecretsIndexStoreAtPath(path)

	expected := newCamberSecretsIndex()
	expected.SecretsByName["API_KEY"] = camberSecretIndexItem{
		ID:          "f4af8ecf-69ac-4a0b-ae81-c5f4057e3ab4",
		Description: "Primary API key",
		UpdatedAt:   "2026-01-02T03:04:05.000000000Z",
	}

	require.NoError(t, store.save(expected))

	fileInfo, err := os.Stat(path)
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(camberIndexFileMode), fileInfo.Mode().Perm())

	dirInfo, err := os.Stat(filepath.Dir(path))
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(camberIndexDirectoryMode), dirInfo.Mode().Perm())

	actual, err := store.load()
	require.NoError(t, err)
	assert.Equal(t, expected, actual)
}

func TestCamberSecretsIndexStore_LoadInvalidVersion(t *testing.T) {
	path := filepath.Join(t.TempDir(), "helper", "secrets-index.json")
	require.NoError(t, os.MkdirAll(filepath.Dir(path), camberIndexDirectoryMode))

	raw, err := json.Marshal(camberSecretsIndex{
		Version:       99,
		SecretsByName: map[string]camberSecretIndexItem{},
	})
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(path, raw, camberIndexFileMode))

	store := newCamberSecretsIndexStoreAtPath(path)

	_, err = store.load()
	require.Error(t, err)
	assert.ErrorContains(t, err, errorCodeParsingIndex)
	assert.ErrorContains(t, err, "unsupported secrets index version")
}

func TestCamberSecretsIndexStore_LoadReadError(t *testing.T) {
	path := filepath.Join(t.TempDir(), "helper", "secrets-index.json")
	require.NoError(t, os.MkdirAll(path, camberIndexDirectoryMode))

	store := newCamberSecretsIndexStoreAtPath(path)
	_, err := store.load()
	require.Error(t, err)
	assert.ErrorContains(t, err, errorCodeReadingIndex)
}

func TestCamberSecretsIndexStore_LoadMalformedJSON(t *testing.T) {
	path := filepath.Join(t.TempDir(), "helper", "secrets-index.json")
	require.NoError(t, os.MkdirAll(filepath.Dir(path), camberIndexDirectoryMode))
	require.NoError(t, os.WriteFile(path, []byte("{not-json"), camberIndexFileMode))

	store := newCamberSecretsIndexStoreAtPath(path)
	_, err := store.load()
	require.Error(t, err)
	assert.ErrorContains(t, err, errorCodeParsingIndex)
}
