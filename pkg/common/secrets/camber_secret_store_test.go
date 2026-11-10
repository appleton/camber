package secrets

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/zalando/go-keyring"
)

func TestCamberSecretStore_AddAndList(t *testing.T) {
	store := newTestCamberSecretStore(t)
	ctx := context.Background()

	require.NoError(t, store.Upsert(ctx, UpsertSecretParams{
		Name:        "API_KEY",
		Value:       "abc123",
		Description: "Primary API key",
	}))

	secrets, err := store.List(ctx)
	require.NoError(t, err)
	require.Len(t, secrets, 1)

	assert.Equal(t, Secret{
		Name:        "API_KEY",
		Value:       SecretValue{},
		Description: "Primary API key",
		Source:      SecretSourceLocal,
	}, secrets[0])
}

func TestCamberSecretStore_OverwriteValueForExistingName(t *testing.T) {
	store := newTestCamberSecretStore(t)
	ctx := context.Background()

	require.NoError(t, store.Upsert(ctx, UpsertSecretParams{
		Name:        "API_KEY",
		Value:       "first",
		Description: "old",
	}))

	require.NoError(t, store.Upsert(ctx, UpsertSecretParams{
		Name:        "API_KEY",
		Value:       "second",
		Description: "new",
	}))

	secrets, err := store.List(ctx)
	require.NoError(t, err)
	require.Len(t, secrets, 1)

	assert.Equal(t, Secret{
		Name:        "API_KEY",
		Value:       SecretValue{},
		Description: "new",
		Source:      SecretSourceLocal,
	}, secrets[0])
}

func TestCamberSecretStore_Get(t *testing.T) {
	store := newTestCamberSecretStore(t)
	ctx := context.Background()

	require.NoError(t, store.Upsert(ctx, UpsertSecretParams{
		Name:        "API_KEY",
		Value:       "abc123",
		Description: "Primary API key",
	}))

	secret, err := store.Get(ctx, "API_KEY")
	require.NoError(t, err)
	require.NotNil(t, secret)
	assert.Equal(t, &Secret{
		Name:        "API_KEY",
		Value:       NewSecretValue("abc123"),
		Description: "Primary API key",
		Source:      SecretSourceLocal,
	}, secret)
}

func TestCamberSecretStore_GetReturnsNilForMissingSecret(t *testing.T) {
	store := newTestCamberSecretStore(t)
	ctx := context.Background()

	secret, err := store.Get(ctx, "MISSING")
	require.NoError(t, err)
	assert.Nil(t, secret)
}

func TestCamberSecretStore_RenameWithPreviousName(t *testing.T) {
	store := newTestCamberSecretStore(t)
	ctx := context.Background()

	require.NoError(t, store.Upsert(ctx, UpsertSecretParams{
		Name:        "OLD_NAME",
		Value:       "abc123",
		Description: "before",
	}))

	beforeRenameIndex, err := store.indexStore.load()
	require.NoError(t, err)
	require.Contains(t, beforeRenameIndex.SecretsByName, "OLD_NAME")
	secretID := beforeRenameIndex.SecretsByName["OLD_NAME"].ID
	require.NotEmpty(t, secretID)

	require.NoError(t, store.Upsert(ctx, UpsertSecretParams{
		Name:         "NEW_NAME",
		PreviousName: "OLD_NAME",
		Value:        "xyz789",
		Description:  "after",
	}))

	secrets, err := store.List(ctx)
	require.NoError(t, err)
	require.Len(t, secrets, 1)
	assert.Equal(t, Secret{
		Name:        "NEW_NAME",
		Value:       SecretValue{},
		Description: "after",
		Source:      SecretSourceLocal,
	}, secrets[0])

	afterRenameIndex, err := store.indexStore.load()
	require.NoError(t, err)
	assert.NotContains(t, afterRenameIndex.SecretsByName, "OLD_NAME")
	require.Contains(t, afterRenameIndex.SecretsByName, "NEW_NAME")
	assert.Equal(t, secretID, afterRenameIndex.SecretsByName["NEW_NAME"].ID)
}

func TestCamberSecretStore_DeleteOneSecret(t *testing.T) {
	store := newTestCamberSecretStore(t)
	ctx := context.Background()

	require.NoError(t, store.Upsert(ctx, UpsertSecretParams{
		Name:        "SECRET_A",
		Value:       "1111",
		Description: "one",
	}))
	require.NoError(t, store.Upsert(ctx, UpsertSecretParams{
		Name:        "SECRET_B",
		Value:       "2222",
		Description: "two",
	}))

	require.NoError(t, store.Delete(ctx, "SECRET_A"))

	secrets, err := store.List(ctx)
	require.NoError(t, err)
	require.Len(t, secrets, 1)
	assert.Equal(t, "SECRET_B", secrets[0].Name)
}

func TestCamberSecretStore_GetPrunesStaleIndexEntries(t *testing.T) {
	store := newTestCamberSecretStore(t)
	ctx := context.Background()

	require.NoError(t, store.Upsert(ctx, UpsertSecretParams{
		Name:        "STALE_1",
		Value:       "secret",
		Description: "to be removed",
	}))

	index, err := store.indexStore.load()
	require.NoError(t, err)
	require.Contains(t, index.SecretsByName, "STALE_1")

	secretID := index.SecretsByName["STALE_1"].ID
	require.NoError(t, store.store.Delete(ctx, newCamberSecretStoreKey(secretID)))

	secret, err := store.Get(ctx, "STALE_1")
	require.NoError(t, err)
	assert.Nil(t, secret)

	prunedIndex, err := store.indexStore.load()
	require.NoError(t, err)
	assert.NotContains(t, prunedIndex.SecretsByName, "STALE_1")
}

func TestCamberSecretStore_RenameConflictFails(t *testing.T) {
	store := newTestCamberSecretStore(t)
	ctx := context.Background()

	require.NoError(t, store.Upsert(ctx, UpsertSecretParams{
		Name:        "FIRST_1",
		Value:       "one1",
		Description: "first",
	}))
	require.NoError(t, store.Upsert(ctx, UpsertSecretParams{
		Name:        "SECOND_1",
		Value:       "two2",
		Description: "second",
	}))

	err := store.Upsert(ctx, UpsertSecretParams{
		Name:         "SECOND_1",
		PreviousName: "FIRST_1",
		Value:        "updated",
		Description:  "conflict",
	})
	require.Error(t, err)
	assert.ErrorContains(t, err, "already exists")

	secrets, listErr := store.List(ctx)
	require.NoError(t, listErr)
	require.Len(t, secrets, 2)

	assert.Equal(t, "FIRST_1", secrets[0].Name)
	assert.Equal(t, "SECOND_1", secrets[1].Name)
}

func TestCamberSecretStore_UpsertRejectsInvalidName(t *testing.T) {
	store := newTestCamberSecretStore(t)
	ctx := context.Background()

	err := store.Upsert(ctx, UpsertSecretParams{
		Name:        "bad?",
		Value:       "abc123",
		Description: "invalid name",
	})
	require.Error(t, err)
	assert.ErrorContains(t, err, "secret name must match")
}

func TestCamberSecretStore_UpsertRejectsOutOfRangeValueLength(t *testing.T) {
	store := newTestCamberSecretStore(t)
	ctx := context.Background()

	err := store.Upsert(ctx, UpsertSecretParams{
		Name:        "API_KEY",
		Value:       "abc",
		Description: "too short value",
	})
	require.Error(t, err)
	assert.ErrorContains(t, err, "secret value must be between 4 and 2560 bytes")

	err = store.Upsert(ctx, UpsertSecretParams{
		Name:        "API_KEY",
		Value:       string(make([]byte, 2561)),
		Description: "too long value",
	})
	require.Error(t, err)
	assert.ErrorContains(t, err, "secret value must be between 4 and 2560 bytes")
}

func TestCamberSecretStore_StoresValueAsRawString(t *testing.T) {
	store := newTestCamberSecretStore(t)
	ctx := context.Background()

	require.NoError(t, store.Upsert(ctx, UpsertSecretParams{
		Name:        "API_KEY",
		Value:       "abc123",
		Description: "Primary API key",
	}))

	index, err := store.indexStore.load()
	require.NoError(t, err)
	secretID := index.SecretsByName["API_KEY"].ID

	storedRaw, err := keyring.Get("test.poolside.secrets", string(newCamberSecretStoreKey(secretID)))
	require.NoError(t, err)
	assert.Equal(t, "abc123", storedRaw)
}

func TestCamberSecretStore_GetLegacyObjectValue(t *testing.T) {
	store := newTestCamberSecretStore(t)
	ctx := context.Background()

	require.NoError(t, store.Upsert(ctx, UpsertSecretParams{
		Name:        "API_KEY",
		Value:       "abc123",
		Description: "Primary API key",
	}))

	index, err := store.indexStore.load()
	require.NoError(t, err)
	secretID := index.SecretsByName["API_KEY"].ID

	require.NoError(t, keyring.Set("test.poolside.secrets", string(newCamberSecretStoreKey(secretID)), `{"value":"legacy"}`))

	secret, err := store.Get(ctx, "API_KEY")
	require.NoError(t, err)
	require.NotNil(t, secret)
	assert.Equal(t, `{"value":"legacy"}`, secret.Value.Expose())
}

func newTestCamberSecretStore(t *testing.T) *keyringCamberSecretStore {
	t.Helper()

	keyring.MockInit()
	indexPath := filepath.Join(t.TempDir(), "helper", "secrets-index.json")

	return newCamberSecretStore(
		NewRawStringKeyringStore[camberSecretStoreKey]("test.poolside.secrets"),
		newCamberSecretsIndexStoreAtPath(indexPath),
	)
}
