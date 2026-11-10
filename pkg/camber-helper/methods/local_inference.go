package methods

const (
	LocalAgentServerName = "local"

	localInferenceMethodPrefix = "camber/localInference/"

	LocalInferenceGetStateMethod        = localInferenceMethodPrefix + "getState"
	LocalInferenceSetDefaultModelMethod = localInferenceMethodPrefix + "setDefaultModel"
	LocalInferenceSearchModelsMethod    = localInferenceMethodPrefix + "searchModels"
	LocalInferenceDownloadModelMethod   = localInferenceMethodPrefix + "downloadModel"
	LocalInferenceCancelDownloadMethod  = localInferenceMethodPrefix + "cancelDownload"
	LocalInferenceDeleteModelMethod     = localInferenceMethodPrefix + "deleteModel"
	LocalInferenceUnloadModelMethod     = localInferenceMethodPrefix + "unloadModel"
	LocalInferenceDidChangeMethod       = localInferenceMethodPrefix + "didChange"
)

type LocalInferenceRuntimeStatus string

const (
	LocalInferenceRuntimeUnavailable LocalInferenceRuntimeStatus = "unavailable"
	LocalInferenceRuntimeExternal    LocalInferenceRuntimeStatus = "external"
	LocalInferenceRuntimeStopped     LocalInferenceRuntimeStatus = "stopped"
	LocalInferenceRuntimeRunning     LocalInferenceRuntimeStatus = "running"
)

type LocalInferenceRunConfidence string

const (
	LocalInferenceRunConfidenceLow    LocalInferenceRunConfidence = "low"
	LocalInferenceRunConfidenceMedium LocalInferenceRunConfidence = "medium"
	LocalInferenceRunConfidenceHigh   LocalInferenceRunConfidence = "high"
)

type LocalInferenceModel struct {
	ID             string                       `json:"id"`
	RepoID         string                       `json:"repoId"`
	Name           string                       `json:"name"`
	Provider       string                       `json:"provider"`
	Source         string                       `json:"source,omitempty"`
	SourceURL      string                       `json:"sourceUrl,omitempty"`
	AvatarURL      string                       `json:"avatarUrl,omitempty"`
	Family         string                       `json:"family,omitempty"`
	Quantization   string                       `json:"quantization,omitempty"`
	ParameterSize  string                       `json:"parameterSize,omitempty"`
	Description    string                       `json:"description,omitempty"`
	ContextWindow  int                          `json:"contextWindow,omitempty"`
	Recommended    bool                         `json:"recommended,omitempty"`
	Default        bool                         `json:"default,omitempty"`
	Downloaded     bool                         `json:"downloaded"`
	Gated          bool                         `json:"gated,omitempty"`
	Private        bool                         `json:"private,omitempty"`
	Disabled       bool                         `json:"disabled,omitempty"`
	LocalPath      string                       `json:"localPath,omitempty"`
	InstalledBytes int64                        `json:"installedBytes,omitempty"`
	DownloadBytes  int64                        `json:"downloadBytes,omitempty"`
	Tags           []string                     `json:"tags,omitempty"`
	Download       *LocalInferenceDownloadState `json:"download,omitempty"`
	RunEstimate    *LocalInferenceRunEstimate   `json:"runEstimate,omitempty"`
}

type LocalInferenceRunEstimate struct {
	Confidence           LocalInferenceRunConfidence `json:"confidence"`
	Summary              string                      `json:"summary"`
	EstimatedMemoryBytes int64                       `json:"estimatedMemoryBytes,omitempty"`
	MachineMemoryBytes   int64                       `json:"machineMemoryBytes,omitempty"`
	WeightBytes          int64                       `json:"weightBytes,omitempty"`
	KVCacheBytes         int64                       `json:"kvCacheBytes,omitempty"`
	OverheadBytes        int64                       `json:"overheadBytes,omitempty"`
	Details              []string                    `json:"details,omitempty"`
}

type LocalInferenceDownloadStatus string

const (
	LocalInferenceDownloadResolving   LocalInferenceDownloadStatus = "resolving"
	LocalInferenceDownloadDownloading LocalInferenceDownloadStatus = "downloading"
	LocalInferenceDownloadCompleted   LocalInferenceDownloadStatus = "completed"
	LocalInferenceDownloadFailed      LocalInferenceDownloadStatus = "failed"
	LocalInferenceDownloadCancelled   LocalInferenceDownloadStatus = "cancelled"
)

// LocalInferenceDownloadErrorCodeToSRequired marks a download failure caused
// by a gated Hugging Face repo whose terms must be accepted before download.
const LocalInferenceDownloadErrorCodeToSRequired = "tos_required"

type LocalInferenceDownloadState struct {
	ModelID         string                       `json:"modelId"`
	Status          LocalInferenceDownloadStatus `json:"status"`
	CurrentFile     string                       `json:"currentFile,omitempty"`
	FilesCompleted  int                          `json:"filesCompleted,omitempty"`
	FilesTotal      int                          `json:"filesTotal,omitempty"`
	BytesDownloaded int64                        `json:"bytesDownloaded,omitempty"`
	BytesTotal      int64                        `json:"bytesTotal,omitempty"`
	BytesPerSecond  int64                        `json:"bytesPerSecond,omitempty"`
	EtaSeconds      int64                        `json:"etaSeconds,omitempty"`
	Error           string                       `json:"error,omitempty"`
	// ErrorCode is a stable, machine-readable cause for Error, so clients
	// never have to match on the human-readable message. See the
	// LocalInferenceDownloadErrorCode* constants.
	ErrorCode string `json:"errorCode,omitempty"`
}

type LocalInferenceRuntimeState struct {
	Supported         bool                        `json:"supported"`
	Status            LocalInferenceRuntimeStatus `json:"status"`
	AgentServer       string                      `json:"agentServer"`
	BaseURL           string                      `json:"baseUrl,omitempty"`
	DefaultModelID    string                      `json:"defaultModelId,omitempty"`
	UnavailableReason string                      `json:"unavailableReason,omitempty"`
	// LoadedModelID is the model resident in the sidecar's memory, empty when
	// nothing is loaded.
	LoadedModelID string `json:"loadedModelId,omitempty"`
	// LoadedMemoryBytes is the sidecar's physical memory footprint (the
	// figure Activity Monitor reports as "Memory"), only meaningful while a
	// model is loaded.
	LoadedMemoryBytes int64 `json:"loadedMemoryBytes,omitempty"`
	// LastActivityUnixMs is when the sidecar last started or finished serving
	// a request, for "last prompt" displays.
	LastActivityUnixMs int64 `json:"lastActivityUnixMs,omitempty"`
	// IdleUnloadSeconds is the sidecar's idle interval before it unloads the
	// resident model on its own; zero when idle unloading is disabled.
	IdleUnloadSeconds int `json:"idleUnloadSeconds,omitempty"`
}

type LocalInferenceState struct {
	ModelsDirectory string                        `json:"modelsDirectory"`
	Catalog         []LocalInferenceModel         `json:"catalog"`
	Runtime         LocalInferenceRuntimeState    `json:"runtime"`
	Downloads       []LocalInferenceDownloadState `json:"downloads,omitempty"`
}

type LocalInferenceSearchModelsState struct {
	Models []LocalInferenceModel `json:"models"`
}

type LocalInferenceGetStateParams struct{}

type LocalInferenceSetDefaultModelParams struct {
	ModelID string `json:"modelId"`
}

type LocalInferenceSearchModelsParams struct {
	Query string `json:"query"`
}

type LocalInferenceDownloadModelParams struct {
	ModelID string `json:"modelId"`
}

type LocalInferenceCancelDownloadParams struct {
	ModelID string `json:"modelId"`
}

type LocalInferenceDeleteModelParams struct {
	ModelID string `json:"modelId"`
}

// LocalInferenceUnloadModelParams requests that the sidecar release the
// model resident in memory without stopping the sidecar itself.
type LocalInferenceUnloadModelParams struct{}

type LocalInferenceDidChangeParams struct {
	State LocalInferenceState `json:"state"`
}
