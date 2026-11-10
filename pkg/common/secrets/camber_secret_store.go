package secrets

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
)

const (
	camberSecretsServiceName = "ai.poolside.secrets"
	camberSecretKeyPrefix    = "ps-secret:"
	camberSecretMinValueSize = 4
	// Windows Credential Manager caps each credential blob at 2560 bytes
	// (CRED_MAX_CREDENTIAL_BLOB_SIZE / 2 for Unicode). We use that as the
	// cross-platform ceiling so secrets stay portable across OSes.
	camberSecretMaxValueSize = 2560 // 2.5 KiB
)

// Minimum length (6) enforces meaningful, discoverable names for the agent.
// The name is not used as a keyring key (a UUID is used instead), so the
// constraints here are purely for usability, not platform limitations.
var camberSecretNameRegex = regexp.MustCompile(`^[a-zA-Z0-9_./-]{6,256}$`)

type SecretSource string

const (
	SecretSourceLocal SecretSource = "local"
)

type Secret struct {
	Name        string       `json:"name"`
	Value       SecretValue  `json:"value"`
	Description string       `json:"description"`
	Source      SecretSource `json:"source,omitempty"`
}

type UpsertSecretParams struct {
	Name         string
	Value        string
	Description  string
	PreviousName string
}

// CamberSecretStore manages named secrets.
type CamberSecretStore interface {
	Upsert(ctx context.Context, params UpsertSecretParams) error
	Delete(ctx context.Context, name string) error
	Get(ctx context.Context, name string) (*Secret, error)
	// List may return partial results alongside a non-nil error (e.g. in composite
	// implementations where one backing store fails). Callers should use whatever
	// secrets are returned and handle the error accordingly.
	List(ctx context.Context) ([]Secret, error)
}

type camberSecretStoreKey string

type keyringCamberSecretStore struct {
	store      *KeyringStore[camberSecretStoreKey, string]
	indexStore *camberSecretsIndexStore
}

func NewCamberSecretStore() CamberSecretStore {
	return newCamberSecretStore(
		NewRawStringKeyringStore[camberSecretStoreKey](camberSecretsServiceName),
		newCamberSecretsIndexStore(),
	)
}

func newCamberSecretStore(
	store *KeyringStore[camberSecretStoreKey, string],
	indexStore *camberSecretsIndexStore,
) *keyringCamberSecretStore {
	return &keyringCamberSecretStore{
		store:      store,
		indexStore: indexStore,
	}
}

func (k *keyringCamberSecretStore) Upsert(ctx context.Context, params UpsertSecretParams) error {
	name := strings.TrimSpace(params.Name)
	if !camberSecretNameRegex.MatchString(name) {
		return fmt.Errorf("secret name must match %s", camberSecretNameRegex.String())
	}

	if len(params.Value) < camberSecretMinValueSize || len(params.Value) > camberSecretMaxValueSize {
		return fmt.Errorf(
			"secret value must be between %d and %d bytes",
			camberSecretMinValueSize,
			camberSecretMaxValueSize,
		)
	}

	previousName := strings.TrimSpace(params.PreviousName)

	index, err := k.indexStore.load()
	if err != nil {
		return fmt.Errorf("failed to load camber secrets index: %w", err)
	}

	resolvedName, secretID := resolveCamberSecretID(index, previousName, name)
	if secretID == "" {
		secretID = uuid.NewString()
	}

	if current, exists := index.SecretsByName[name]; exists && current.ID != secretID {
		return fmt.Errorf("secret with name %q already exists", name)
	}

	value := params.Value
	if err := k.store.Save(ctx, newCamberSecretStoreKey(secretID), &value); err != nil {
		return fmt.Errorf("failed to save camber secret value for %q: %w", name, err)
	}

	if resolvedName != "" && resolvedName != name {
		delete(index.SecretsByName, resolvedName)
	}

	index.SecretsByName[name] = camberSecretIndexItem{
		ID:          secretID,
		Description: params.Description,
		UpdatedAt:   time.Now().UTC().Format(time.RFC3339Nano),
	}

	if err := k.indexStore.save(index); err != nil {
		return fmt.Errorf("failed to save camber secrets index: %w", err)
	}

	return nil
}

func (k *keyringCamberSecretStore) Delete(ctx context.Context, name string) error {
	trimmedName := strings.TrimSpace(name)
	if trimmedName == "" {
		return fmt.Errorf("secret name is required")
	}

	index, err := k.indexStore.load()
	if err != nil {
		return fmt.Errorf("failed to load camber secrets index: %w", err)
	}

	indexItem, exists := index.SecretsByName[trimmedName]
	if !exists {
		return nil
	}

	if err := k.store.Delete(ctx, newCamberSecretStoreKey(indexItem.ID)); err != nil {
		return fmt.Errorf("failed to delete camber secret value for %q: %w", trimmedName, err)
	}

	delete(index.SecretsByName, trimmedName)
	if err := k.indexStore.save(index); err != nil {
		return fmt.Errorf("failed to save camber secrets index: %w", err)
	}

	return nil
}

func (k *keyringCamberSecretStore) Get(ctx context.Context, name string) (*Secret, error) {
	trimmedName := strings.TrimSpace(name)
	if trimmedName == "" {
		return nil, fmt.Errorf("secret name is required")
	}

	index, err := k.indexStore.load()
	if err != nil {
		return nil, fmt.Errorf("failed to load camber secrets index: %w", err)
	}

	indexItem, exists := index.SecretsByName[trimmedName]
	if !exists {
		return nil, nil
	}

	if strings.TrimSpace(indexItem.ID) == "" {
		delete(index.SecretsByName, trimmedName)
		if err := k.indexStore.save(index); err != nil {
			return nil, fmt.Errorf("failed to prune stale camber secrets index entries: %w", err)
		}
		return nil, nil
	}

	record, err := k.store.Load(ctx, newCamberSecretStoreKey(indexItem.ID))
	if err != nil {
		return nil, fmt.Errorf("failed to load camber secret value for %q: %w", trimmedName, err)
	}
	if record == nil {
		delete(index.SecretsByName, trimmedName)
		if err := k.indexStore.save(index); err != nil {
			return nil, fmt.Errorf("failed to prune stale camber secrets index entries: %w", err)
		}
		return nil, nil
	}

	return &Secret{
		Name:        trimmedName,
		Value:       NewSecretValue(*record),
		Description: indexItem.Description,
		Source:      SecretSourceLocal,
	}, nil
}

func (k *keyringCamberSecretStore) List(ctx context.Context) ([]Secret, error) {
	index, err := k.indexStore.load()
	if err != nil {
		return nil, fmt.Errorf("failed to load camber secrets index: %w", err)
	}

	secrets := make([]Secret, 0, len(index.SecretsByName))

	for name, indexItem := range index.SecretsByName {
		if strings.TrimSpace(indexItem.ID) == "" {
			continue
		}

		secrets = append(secrets, Secret{
			Name:        name,
			Description: indexItem.Description,
			Source:      SecretSourceLocal,
		})
	}

	sort.Slice(secrets, func(i, j int) bool {
		return secrets[i].Name < secrets[j].Name
	})

	return secrets, nil
}

func resolveCamberSecretID(index *camberSecretsIndex, previousName string, name string) (string, string) {
	if previousName != "" {
		if indexItem, exists := index.SecretsByName[previousName]; exists {
			return previousName, indexItem.ID
		}
	}

	if indexItem, exists := index.SecretsByName[name]; exists {
		return name, indexItem.ID
	}

	return "", ""
}

func newCamberSecretStoreKey(secretID string) camberSecretStoreKey {
	return camberSecretStoreKey(camberSecretKeyPrefix + secretID)
}
