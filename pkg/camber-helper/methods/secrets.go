package methods

type UpsertSecretParams struct {
	Name              string  `json:"name"`
	Value             string  `json:"value"`
	SecretDescription string  `json:"description"`
	PreviousName      *string `json:"previousName,omitempty"`
}

func (p UpsertSecretParams) MethodName() string {
	return "camber/upsertSecret"
}

func (p UpsertSecretParams) Description() string {
	return "Add or update a camber secret"
}

type UpsertSecretOutput struct{}

type DeleteSecretParams struct {
	Name string `json:"name"`
}

func (p DeleteSecretParams) MethodName() string {
	return "camber/deleteSecret"
}

func (p DeleteSecretParams) Description() string {
	return "Delete a camber secret"
}

type DeleteSecretOutput struct{}

type ListSecretsParams struct {
	RequiredSecrets []string `json:"requiredSecrets"`
}

func (p ListSecretsParams) MethodName() string {
	return "camber/listSecrets"
}

func (p ListSecretsParams) Description() string {
	return "List camber secrets"
}

type SecretSummary struct {
	Name         string `json:"name"`
	Description  string `json:"description"`
	IsRequired   bool   `json:"isRequired"`
	IsConfigured bool   `json:"isConfigured"`
}

type ListSecretsOutput struct {
	Secrets []SecretSummary `json:"secrets"`
}

type GetSecretParams struct {
	Name string `json:"name"`
}

func (p GetSecretParams) MethodName() string {
	return "camber/getSecret"
}

func (p GetSecretParams) Description() string {
	return "Get a single camber secret"
}

type GetSecretOutput struct {
	Name        string `json:"name"`
	Value       string `json:"value"`
	Description string `json:"description"`
}
