package secrets

import (
	"context"

	"github.com/appleton/camber/pkg/camber-helper/methods"
	commonsecrets "github.com/appleton/camber/pkg/common/secrets"
	pkgerrors "github.com/pkg/errors"
	"github.com/tliron/glsp"
)

type Server struct {
	store commonsecrets.CamberSecretStore
}

func NewServer() *Server {
	return NewServerWithStore(commonsecrets.NewCamberSecretStore())
}

func NewServerWithStore(store commonsecrets.CamberSecretStore) *Server {
	return &Server{store: store}
}

func (s *Server) UpsertSecret(ctx context.Context, params *methods.UpsertSecretParams, _ *glsp.Context) (*methods.UpsertSecretOutput, error) {
	request := commonsecrets.UpsertSecretParams{
		Name:        params.Name,
		Value:       params.Value,
		Description: params.SecretDescription,
	}
	if params.PreviousName != nil {
		request.PreviousName = *params.PreviousName
	}

	if err := s.store.Upsert(ctx, request); err != nil {
		return nil, pkgerrors.Wrap(err, "failed to upsert camber secret")
	}

	return &methods.UpsertSecretOutput{}, nil
}

func (s *Server) DeleteSecret(ctx context.Context, params *methods.DeleteSecretParams, _ *glsp.Context) (*methods.DeleteSecretOutput, error) {
	if err := s.store.Delete(ctx, params.Name); err != nil {
		return nil, pkgerrors.Wrap(err, "failed to delete camber secret")
	}

	return &methods.DeleteSecretOutput{}, nil
}

func (s *Server) ListSecrets(ctx context.Context, params *methods.ListSecretsParams, _ *glsp.Context) (*methods.ListSecretsOutput, error) {
	stored, err := s.store.List(ctx)
	if err != nil {
		return nil, pkgerrors.Wrap(err, "failed to list camber secrets")
	}

	requiredSet := make(map[string]struct{}, len(params.RequiredSecrets))
	for _, name := range params.RequiredSecrets {
		requiredSet[name] = struct{}{}
	}

	storedByName := make(map[string]commonsecrets.Secret)
	for _, secret := range stored {
		storedByName[secret.Name] = secret
	}

	seen := make(map[string]struct{}, len(requiredSet))
	statuses := make([]methods.SecretSummary, 0, len(params.RequiredSecrets))

	for _, name := range params.RequiredSecrets {
		status := methods.SecretSummary{
			Name:       name,
			IsRequired: true,
		}
		if secret, ok := storedByName[name]; ok {
			status.Description = secret.Description
			status.IsConfigured = true
		}
		statuses = append(statuses, status)
		seen[name] = struct{}{}
	}

	for _, secret := range stored {
		if _, ok := seen[secret.Name]; ok {
			continue
		}
		statuses = append(statuses, methods.SecretSummary{
			Name:         secret.Name,
			Description:  secret.Description,
			IsRequired:   false,
			IsConfigured: true,
		})
	}

	return &methods.ListSecretsOutput{Secrets: statuses}, nil
}

func (s *Server) GetSecret(ctx context.Context, params *methods.GetSecretParams, _ *glsp.Context) (*methods.GetSecretOutput, error) {
	secret, err := s.store.Get(ctx, params.Name)
	if err != nil {
		return nil, pkgerrors.Wrap(err, "failed to load camber secret")
	}
	if secret == nil {
		return nil, pkgerrors.Errorf("camber secret %q not found", params.Name)
	}

	return &methods.GetSecretOutput{
		Name:        secret.Name,
		Value:       secret.Value.Expose(),
		Description: secret.Description,
	}, nil
}
