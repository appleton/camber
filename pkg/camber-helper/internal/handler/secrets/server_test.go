package secrets

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/appleton/camber/pkg/camber-helper/methods"
	commonsecrets "github.com/appleton/camber/pkg/common/secrets"
)

func TestServerUpsertSecret(t *testing.T) {
	fakeStore := &fakeCamberSecretStore{}
	server := NewServerWithStore(fakeStore)

	previousName := "OLD_NAME"
	_, err := server.UpsertSecret(context.Background(), &methods.UpsertSecretParams{
		Name:              "NEW_NAME",
		Value:             "secret",
		SecretDescription: "updated",
		PreviousName:      &previousName,
	}, nil)
	require.NoError(t, err)
	require.Len(t, fakeStore.upsertCalls, 1)
	assert.Equal(t, commonsecrets.UpsertSecretParams{
		Name:         "NEW_NAME",
		Value:        "secret",
		Description:  "updated",
		PreviousName: "OLD_NAME",
	}, fakeStore.upsertCalls[0])
}

func TestServerUpsertSecretReturnsError(t *testing.T) {
	fakeStore := &fakeCamberSecretStore{upsertErr: errors.New("boom")}
	server := NewServerWithStore(fakeStore)

	_, err := server.UpsertSecret(context.Background(), &methods.UpsertSecretParams{
		Name:  "A",
		Value: "B",
	}, nil)
	require.Error(t, err)
	assert.ErrorContains(t, err, "failed to upsert camber secret")
}

func TestServerDeleteSecret(t *testing.T) {
	fakeStore := &fakeCamberSecretStore{}
	server := NewServerWithStore(fakeStore)

	_, err := server.DeleteSecret(context.Background(), &methods.DeleteSecretParams{Name: "SECRET"}, nil)
	require.NoError(t, err)
	assert.Equal(t, []string{"SECRET"}, fakeStore.deleteCalls)
}

func TestServerListSecrets(t *testing.T) {
	fakeStore := &fakeCamberSecretStore{
		listSecrets: []commonsecrets.Secret{
			{Name: "REQUIRED_SET", Value: commonsecrets.NewSecretValue("abc"), Description: "required"},
			{Name: "REQUIRED_EMPTY", Value: commonsecrets.NewSecretValue(""), Description: "empty"},
			{Name: "CUSTOM", Value: commonsecrets.NewSecretValue("xyz"), Description: "custom"},
		},
	}
	server := NewServerWithStore(fakeStore)

	resp, err := server.ListSecrets(context.Background(), &methods.ListSecretsParams{
		RequiredSecrets: []string{"REQUIRED_SET", "REQUIRED_MISSING", "REQUIRED_EMPTY"},
	}, nil)
	require.NoError(t, err)
	require.NotNil(t, resp)
	require.Len(t, resp.Secrets, 4)

	assert.Equal(t, "REQUIRED_SET", resp.Secrets[0].Name)
	assert.True(t, resp.Secrets[0].IsRequired)
	assert.True(t, resp.Secrets[0].IsConfigured)
	assert.Equal(t, "required", resp.Secrets[0].Description)

	assert.Equal(t, "REQUIRED_MISSING", resp.Secrets[1].Name)
	assert.True(t, resp.Secrets[1].IsRequired)
	assert.False(t, resp.Secrets[1].IsConfigured)
	assert.Empty(t, resp.Secrets[1].Description)

	assert.Equal(t, "REQUIRED_EMPTY", resp.Secrets[2].Name)
	assert.True(t, resp.Secrets[2].IsRequired)
	assert.True(t, resp.Secrets[2].IsConfigured)
	assert.Equal(t, "empty", resp.Secrets[2].Description)

	assert.Equal(t, "CUSTOM", resp.Secrets[3].Name)
	assert.False(t, resp.Secrets[3].IsRequired)
	assert.True(t, resp.Secrets[3].IsConfigured)
	assert.Equal(t, "custom", resp.Secrets[3].Description)
}

func TestServerListSecretsReturnsError(t *testing.T) {
	fakeStore := &fakeCamberSecretStore{listErr: errors.New("boom")}
	server := NewServerWithStore(fakeStore)

	_, err := server.ListSecrets(context.Background(), &methods.ListSecretsParams{}, nil)
	require.Error(t, err)
	assert.ErrorContains(t, err, "failed to list camber secrets")
}

func TestServerGetSecret(t *testing.T) {
	fakeStore := &fakeCamberSecretStore{
		secretsByName: map[string]commonsecrets.Secret{
			"API_KEY": {
				Name:        "API_KEY",
				Value:       commonsecrets.NewSecretValue("abc123"),
				Description: "Primary API key",
			},
		},
	}
	server := NewServerWithStore(fakeStore)

	resp, err := server.GetSecret(context.Background(), &methods.GetSecretParams{Name: "API_KEY"}, nil)
	require.NoError(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, "API_KEY", resp.Name)
	assert.Equal(t, "abc123", resp.Value)
	assert.Equal(t, "Primary API key", resp.Description)
}

func TestServerGetSecretReturnsError(t *testing.T) {
	fakeStore := &fakeCamberSecretStore{getErr: errors.New("boom")}
	server := NewServerWithStore(fakeStore)

	_, err := server.GetSecret(context.Background(), &methods.GetSecretParams{Name: "API_KEY"}, nil)
	require.Error(t, err)
	assert.ErrorContains(t, err, "failed to load camber secret")
}

func TestServerGetSecretReturnsNotFoundError(t *testing.T) {
	fakeStore := &fakeCamberSecretStore{}
	server := NewServerWithStore(fakeStore)

	_, err := server.GetSecret(context.Background(), &methods.GetSecretParams{Name: "MISSING"}, nil)
	require.Error(t, err)
	assert.ErrorContains(t, err, "not found")
}

type fakeCamberSecretStore struct {
	upsertCalls   []commonsecrets.UpsertSecretParams
	deleteCalls   []string
	listSecrets   []commonsecrets.Secret
	secretsByName map[string]commonsecrets.Secret
	upsertErr     error
	deleteErr     error
	listErr       error
	getErr        error
}

func (f *fakeCamberSecretStore) Upsert(_ context.Context, params commonsecrets.UpsertSecretParams) error {
	f.upsertCalls = append(f.upsertCalls, params)
	return f.upsertErr
}

func (f *fakeCamberSecretStore) Delete(_ context.Context, name string) error {
	f.deleteCalls = append(f.deleteCalls, name)
	return f.deleteErr
}

func (f *fakeCamberSecretStore) Get(_ context.Context, name string) (*commonsecrets.Secret, error) {
	if f.getErr != nil {
		return nil, f.getErr
	}

	secret, ok := f.secretsByName[name]
	if !ok {
		return nil, nil
	}

	result := secret
	return &result, nil
}

func (f *fakeCamberSecretStore) List(_ context.Context) ([]commonsecrets.Secret, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}

	return f.listSecrets, nil
}
