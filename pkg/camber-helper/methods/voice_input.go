package methods

const (
	voiceInputMethodPrefix = "camber/voiceInput/"

	VoiceInputGetStateMethod       = voiceInputMethodPrefix + "getState"
	VoiceInputSetModelMethod       = voiceInputMethodPrefix + "setModel"
	VoiceInputDownloadModelMethod  = voiceInputMethodPrefix + "downloadModel"
	VoiceInputCancelDownloadMethod = voiceInputMethodPrefix + "cancelDownload"
	VoiceInputDeleteModelMethod    = voiceInputMethodPrefix + "deleteModel"
	VoiceInputTranscribeMethod     = voiceInputMethodPrefix + "transcribe"
)

type VoiceInputRuntimeStatus string

const (
	VoiceInputRuntimeUnavailable VoiceInputRuntimeStatus = "unavailable"
	VoiceInputRuntimeStopped     VoiceInputRuntimeStatus = "stopped"
	VoiceInputRuntimeRunning     VoiceInputRuntimeStatus = "running"
)

type VoiceInputDownloadStatus string

const (
	VoiceInputDownloadDownloading VoiceInputDownloadStatus = "downloading"
	VoiceInputDownloadCompleted   VoiceInputDownloadStatus = "completed"
	VoiceInputDownloadFailed      VoiceInputDownloadStatus = "failed"
	VoiceInputDownloadCancelled   VoiceInputDownloadStatus = "cancelled"
)

type VoiceInputModel struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Multilingual  bool   `json:"multilingual,omitempty"`
	Recommended   bool   `json:"recommended,omitempty"`
	Default       bool   `json:"default,omitempty"`
	Selected      bool   `json:"selected,omitempty"`
	Downloaded    bool   `json:"downloaded"`
	DownloadBytes int64  `json:"downloadBytes,omitempty"`
	LocalPath     string `json:"localPath,omitempty"`
}

type VoiceInputDownloadState struct {
	ModelID         string                   `json:"modelId"`
	Status          VoiceInputDownloadStatus `json:"status"`
	BytesDownloaded int64                    `json:"bytesDownloaded,omitempty"`
	BytesTotal      int64                    `json:"bytesTotal,omitempty"`
	BytesPerSecond  int64                    `json:"bytesPerSecond,omitempty"`
	EtaSeconds      int64                    `json:"etaSeconds,omitempty"`
	Error           string                   `json:"error,omitempty"`
}

type VoiceInputState struct {
	// Supported reports whether a whisper-server binary was found on this
	// machine; UnavailableReason explains a false value.
	Supported         bool   `json:"supported"`
	UnavailableReason string `json:"unavailableReason,omitempty"`
	// Ready means transcription can be attempted right now: the runtime is
	// supported and the selected model is fully downloaded.
	Ready           bool                     `json:"ready"`
	ModelsDirectory string                   `json:"modelsDirectory"`
	SelectedModelID string                   `json:"selectedModelId"`
	Models          []VoiceInputModel        `json:"models"`
	Runtime         VoiceInputRuntimeStatus  `json:"runtime"`
	Download        *VoiceInputDownloadState `json:"download,omitempty"`
}

type VoiceInputGetStateParams struct{}

type VoiceInputSetModelParams struct {
	ModelID string `json:"modelId"`
}

type VoiceInputDownloadModelParams struct {
	// ModelID is optional; empty downloads the currently selected model.
	ModelID string `json:"modelId,omitempty"`
}

type VoiceInputCancelDownloadParams struct {
	ModelID string `json:"modelId,omitempty"`
}

type VoiceInputDeleteModelParams struct {
	ModelID string `json:"modelId"`
}

type VoiceInputTranscribeParams struct {
	// Audio is base64-encoded audio. 16 kHz mono PCM16 WAV is what
	// whisper-server consumes natively; clients are expected to resample and
	// encode before sending.
	Audio    string `json:"audio"`
	MimeType string `json:"mimeType,omitempty"`
	// Language is a two-letter hint like "en"; empty means auto-detect.
	Language string `json:"language,omitempty"`
}

type VoiceInputTranscribeResult struct {
	Text string `json:"text"`
}
