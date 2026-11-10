package methods

type GetUserConfigParams struct{}

type GetUserConfigOutput struct {
	SettingsFilePaths []string       `json:"settingsFilePaths" doc:"location of all user settings files"`
	SandboxConfig     map[string]any `json:"sandboxConfig,omitempty" doc:"the current sandbox configuration"`
}

func (p GetUserConfigParams) MethodName() string {
	return "camber/getUserConfig"
}

func (p GetUserConfigParams) Description() string {
	return "retrieves the current user configuration"
}
