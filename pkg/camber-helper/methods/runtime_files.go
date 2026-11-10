package methods

type RuntimeFilesParams struct{}

type RuntimeFileKey string

type RuntimeFiles struct {
	Key         RuntimeFileKey `json:"key" enum:"user_settings_yaml"`
	Path        string         `json:"path"`
	FileExists  bool           `json:"fileExists"`
	Placeholder *string        `json:"placeholder,omitempty"`
}

type RuntimeFilesOutput struct {
	Files []RuntimeFiles `json:"files"`
}

func (p RuntimeFilesParams) MethodName() string {
	return "camber/runtimeFiles"
}

func (p RuntimeFilesParams) Description() string {
	return "Method to get a list of runtime filepath"
}
