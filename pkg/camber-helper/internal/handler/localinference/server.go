package localinference

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/appleton/camber/pkg/camber-helper/methods"
	"github.com/appleton/camber/pkg/common/userconfig"
	"github.com/tliron/glsp"
)

const (
	configFilename = "local-inference.json"

	modelsDirEnv   = "CAMBER_LOCAL_INFERENCE_MODELS_DIR"
	baseURLEnv     = "CAMBER_LOCAL_INFERENCE_BASE_URL"
	apiKeyEnv      = "CAMBER_LOCAL_INFERENCE_API_KEY"
	modelEnv       = "CAMBER_LOCAL_INFERENCE_MODEL"
	sidecarPathEnv = "CAMBER_MLX_SIDECAR"

	standaloneBaseURLEnv = "POOLSIDE_STANDALONE_BASE_URL"
	standaloneAPIKeyEnv  = "POOLSIDE_API_KEY"
	standaloneModelEnv   = "POOLSIDE_STANDALONE_MODEL"

	sidecarHost                    = "127.0.0.1"
	sidecarReadyTimeout            = 45 * time.Second
	sidecarProbeTimeout            = 2 * time.Second
	sidecarReadyInterval           = 200 * time.Millisecond
	sidecarGracefulShutdownTimeout = 2 * time.Second
	// Automatic respawns after an unexpected sidecar exit: patience for the
	// replacement to come up, and a rate limit so a sidecar that dies on
	// arrival (e.g. its port was reclaimed) cannot crash-loop.
	sidecarRespawnReadyTimeout = 10 * time.Second
	sidecarRespawnLimit        = 3
	sidecarRespawnWindow       = 5 * time.Minute
	sidecarExitOnStdinCloseEnv = "CAMBER_MLX_EXIT_ON_STDIN_CLOSE"
	sidecarDisableDevBuildEnv  = "CAMBER_MLX_SIDECAR_DISABLE_DEV_BUILD"

	// sidecarOutputLineLimit caps how much of a single sidecar output line is
	// retained for logging; longer lines are logged truncated and the
	// remainder discarded (but always consumed — see drainSidecarOutput).
	sidecarOutputLineLimit = 64 * 1024

	sidecarMetallibPrimary = "mlx.metallib"
	sidecarMetallibDefault = "default.metallib"
	sidecarDevRunScript    = "scripts/dev-run.sh"

	huggingFaceBaseURL                 = "https://huggingface.co"
	huggingFaceBaseURLEnv              = "CAMBER_LOCAL_INFERENCE_HF_BASE_URL"
	huggingFaceTokenEnv                = "HF_TOKEN"
	huggingFaceTokenAltEnv             = "HUGGING_FACE_HUB_TOKEN"
	huggingFaceMetadataTimeout         = 4 * time.Second
	huggingFaceMetadataCacheTTL        = 24 * time.Hour
	huggingFaceMetadataFailureCacheTTL = 5 * time.Minute
	huggingFaceMetadataConcurrency     = 4
	downloadProgressInterval           = 250 * time.Millisecond
	downloadMarkerFilename             = ".poolside-download-in-progress"
	installedManifestFilename          = ".poolside-local-model.json"
	partFileSuffix                     = ".part"
	partETagSuffix                     = ".part.etag"
	directorySizeCacheTTL              = 10 * time.Second
)

var (
	parameterSizePattern       = regexp.MustCompile(`(?i)(?:^|[^[:alnum:]])(\d+(?:\.\d+)?)([bm])(?:[^[:alnum:]]|$)`)
	activeParameterSizePattern = regexp.MustCompile(`(?i)(?:^|[^[:alnum:]])a(\d+(?:\.\d+)?)([bm])(?:[^[:alnum:]]|$)`)
)

var (
	cachedMachineProfile     machineProfile
	cachedMachineProfileOnce sync.Once
)

type configFile struct {
	DefaultModelID string `json:"defaultModelId,omitempty"`
}

type Server struct {
	configPath     string
	mu             sync.Mutex
	sidecar        *managedSidecar
	downloadJobs   map[string]*downloadJob
	downloadStates map[string]*methods.LocalInferenceDownloadState
	// notify holds the most recent client's notifier (last writer wins, see
	// rememberClient). This assumes one glsp client per helper process: each
	// host (VS Code extension, desktop app) runs its own helper and fans out
	// to its webviews itself. If two hosts ever share one helper, didChange
	// notifications would only reach whichever client called most recently.
	notify              localInferenceNotifier
	httpClient          *http.Client
	hfBaseURL           string
	fetchRemoteMetadata bool
	// probeTimeout overrides sidecarProbeTimeout in tests; zero means the
	// default.
	probeTimeout time.Duration
	// respawnHistory holds the times of recent automatic sidecar respawns
	// for allowRespawn's rate limit. Guarded by mu.
	respawnHistory []time.Time
	metadataMu     sync.Mutex
	metadataCache  map[string]huggingFaceMetadataCacheEntry
	dirSizeMu      sync.Mutex
	dirSizeCache   map[string]directorySizeEntry
	// hfTokenSource optionally supplies a Hugging Face access token (e.g. the
	// user's Hugging Face MCP connector OAuth token) when no HF_TOKEN /
	// HUGGING_FACE_HUB_TOKEN env var is set. Returns "" when unavailable.
	hfTokenSource      func(context.Context) string
	hfTokenInvalidator func(context.Context) error
}

type localInferenceNotifier func(context.Context, methods.LocalInferenceDidChangeParams) error

func NewServer() *Server {
	return &Server{
		configPath:          userconfig.CamberConfigFile(configFilename),
		downloadJobs:        make(map[string]*downloadJob),
		downloadStates:      make(map[string]*methods.LocalInferenceDownloadState),
		fetchRemoteMetadata: true,
	}
}

// SetHuggingFaceTokenSource registers a fallback token source for Hugging Face
// API requests. Env vars (HF_TOKEN, HUGGING_FACE_HUB_TOKEN) always win over it.
func (s *Server) SetHuggingFaceTokenSource(fn func(context.Context) string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.hfTokenSource = fn
}

// SetHuggingFaceTokenInvalidator registers a callback that removes a rejected
// Hugging Face connector token and notifies clients that sign-in is required.
func (s *Server) SetHuggingFaceTokenInvalidator(fn func(context.Context) error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.hfTokenInvalidator = fn
}

func (s *Server) Close() error {
	s.mu.Lock()
	for _, job := range s.downloadJobs {
		if job != nil && job.running() {
			job.cancel()
		}
	}
	sidecar := s.detachSidecarLocked()
	s.mu.Unlock()
	return shutdownSidecar(sidecar)
}

func (s *Server) GetState(ctx context.Context, _ *methods.LocalInferenceGetStateParams, gCtx *glsp.Context) (methods.LocalInferenceState, error) {
	s.rememberClient(gCtx)
	return s.stateWithMetadataFetch(ctx, true)
}

func (s *Server) SetDefaultModel(ctx context.Context, req *methods.LocalInferenceSetDefaultModelParams, gCtx *glsp.Context) (methods.LocalInferenceState, error) {
	modelID := strings.TrimSpace(req.ModelID)
	if modelID == "" {
		return methods.LocalInferenceState{}, fmt.Errorf("local inference model id is required")
	}
	cfg, err := s.loadConfig()
	if err != nil {
		return methods.LocalInferenceState{}, err
	}
	if !catalogContains(modelID) {
		modelsDir := s.modelsDirectory(cfg)
		if _, ok := s.installedModelByID(modelsDir, modelID); !ok {
			return methods.LocalInferenceState{}, fmt.Errorf("local inference model %q is not installed", modelID)
		}
	}
	cfg.DefaultModelID = modelID
	if err := s.saveConfig(cfg); err != nil {
		return methods.LocalInferenceState{}, err
	}
	return s.notifyState(ctx, gCtx)
}

func (s *Server) SearchModels(ctx context.Context, req *methods.LocalInferenceSearchModelsParams, gCtx *glsp.Context) (methods.LocalInferenceSearchModelsState, error) {
	s.rememberClient(gCtx)
	query := strings.TrimSpace(req.Query)
	if query == "" {
		return methods.LocalInferenceSearchModelsState{}, nil
	}
	cfg, err := s.loadConfig()
	if err != nil {
		return methods.LocalInferenceSearchModelsState{}, err
	}
	modelsDir := s.modelsDirectory(cfg)
	models, err := s.searchHuggingFaceModels(ctx, query, modelsDir, s.defaultModelID(cfg), s.downloadStateSnapshots())
	if err != nil {
		return methods.LocalInferenceSearchModelsState{}, err
	}
	return methods.LocalInferenceSearchModelsState{Models: models}, nil
}

func (s *Server) DownloadModel(ctx context.Context, req *methods.LocalInferenceDownloadModelParams, gCtx *glsp.Context) (methods.LocalInferenceState, error) {
	modelID := strings.TrimSpace(req.ModelID)
	if modelID == "" {
		return methods.LocalInferenceState{}, fmt.Errorf("local inference model id is required")
	}
	cfg, err := s.loadConfig()
	if err != nil {
		return methods.LocalInferenceState{}, err
	}
	modelsDir := s.modelsDirectory(cfg)
	if modelsDir == "" {
		return methods.LocalInferenceState{}, errors.New("local inference models directory is not available")
	}
	model, err := s.resolveDownloadModel(ctx, modelID, modelsDir)
	if err != nil {
		return methods.LocalInferenceState{}, err
	}
	modelDir := modelDirectory(modelsDir, model.RepoID)
	if isDownloadedModel(modelDir) {
		return s.notifyState(ctx, gCtx)
	}

	jobCtx, cancel := context.WithCancel(context.Background())
	job := &downloadJob{
		modelID: model.ID,
		cancel:  cancel,
		done:    make(chan struct{}),
	}

	s.mu.Lock()
	s.ensureDownloadMapsLocked()
	if existing := s.downloadJobs[model.ID]; existing != nil && existing.running() {
		s.mu.Unlock()
		cancel()
		return s.notifyState(ctx, gCtx)
	}
	s.downloadJobs[model.ID] = job
	s.downloadStates[model.ID] = &methods.LocalInferenceDownloadState{
		ModelID:     model.ID,
		Status:      methods.LocalInferenceDownloadResolving,
		CurrentFile: "Resolving Hugging Face files",
	}
	s.mu.Unlock()

	state, err := s.notifyState(ctx, gCtx)
	if err != nil {
		cancel()
		s.mu.Lock()
		delete(s.downloadJobs, model.ID)
		delete(s.downloadStates, model.ID)
		s.mu.Unlock()
		// Close outside the lock: other goroutines select on job.done while
		// taking s.mu, and runDownload has not started so nothing else closes
		// it.
		close(job.done)
		return methods.LocalInferenceState{}, err
	}

	go s.runDownload(jobCtx, job, model, modelsDir)
	return state, nil
}

func (s *Server) CancelDownload(ctx context.Context, req *methods.LocalInferenceCancelDownloadParams, gCtx *glsp.Context) (methods.LocalInferenceState, error) {
	modelID := strings.TrimSpace(req.ModelID)
	if modelID == "" {
		return methods.LocalInferenceState{}, fmt.Errorf("local inference model id is required")
	}

	var cancelled []<-chan struct{}
	s.mu.Lock()
	for _, job := range s.downloadJobs {
		if job != nil && job.running() && job.modelID == modelID {
			job.cancel()
			cancelled = append(cancelled, job.done)
		}
	}
	s.mu.Unlock()

	// Wait for the cancelled jobs to record their final status before
	// computing the returned state. The download goroutine flips the status to
	// cancelled asynchronously; responding before that happens would report
	// the download as still running, and clients that apply the response as
	// authoritative state would show the download as unpaused even though it
	// was cancelled (the didChange carrying the cancelled status loses the
	// race with the response).
	for _, done := range cancelled {
		select {
		case <-done:
		case <-ctx.Done():
			return methods.LocalInferenceState{}, ctx.Err()
		}
	}

	return s.notifyState(ctx, gCtx)
}

func (s *Server) DeleteModel(ctx context.Context, req *methods.LocalInferenceDeleteModelParams, gCtx *glsp.Context) (methods.LocalInferenceState, error) {
	modelID := strings.TrimSpace(req.ModelID)
	if modelID == "" {
		return methods.LocalInferenceState{}, fmt.Errorf("local inference model id is required")
	}

	cfg, err := s.loadConfig()
	if err != nil {
		return methods.LocalInferenceState{}, err
	}
	modelsDir := s.modelsDirectory(cfg)
	if modelsDir == "" {
		return methods.LocalInferenceState{}, errors.New("local inference models directory is not available")
	}
	model, ok := catalogModel(modelID)
	if !ok {
		model, ok = s.installedModelByID(modelsDir, modelID)
	}
	if !ok {
		if repoID, repoOK := normalizeHuggingFaceRepoID(modelID); repoOK {
			model = methods.LocalInferenceModel{ID: repoID, RepoID: repoID}
			ok = true
		}
	}
	if !ok {
		return methods.LocalInferenceState{}, fmt.Errorf("local inference model %q is not known", modelID)
	}

	modelPath, ok := existingModelPath(modelsDir, model.RepoID)
	if !ok {
		s.clearDownloadStateForModel(model)
		return s.notifyState(ctx, gCtx)
	}
	if !pathContained(modelPath, modelsDir) {
		return methods.LocalInferenceState{}, fmt.Errorf("refusing to delete model outside models directory: %s", modelPath)
	}
	if err := existingParentChainIsSafe(modelsDir, filepath.Dir(modelPath)); err != nil {
		return methods.LocalInferenceState{}, err
	}

	var waitForDownload <-chan struct{}
	s.mu.Lock()
	if job := s.downloadJobForModelLocked(model); job != nil && job.running() {
		job.cancel()
		waitForDownload = job.done
	}
	sidecar := s.detachSidecarLocked()
	s.mu.Unlock()
	if err := shutdownSidecar(sidecar); err != nil {
		return methods.LocalInferenceState{}, err
	}

	if waitForDownload != nil {
		select {
		case <-waitForDownload:
		case <-ctx.Done():
			return methods.LocalInferenceState{}, ctx.Err()
		}
	}
	if err := os.RemoveAll(modelPath); err != nil {
		return methods.LocalInferenceState{}, fmt.Errorf("deleting local inference model %q: %w", model.ID, err)
	}
	s.invalidateDirectorySizes()
	s.clearDownloadStateForModel(model)

	if cfg.DefaultModelID == model.ID || cfg.DefaultModelID == model.RepoID || cfg.DefaultModelID == filepath.Base(model.RepoID) {
		cfg.DefaultModelID = defaultModelID
		if err := s.saveConfig(cfg); err != nil {
			return methods.LocalInferenceState{}, err
		}
	}

	return s.notifyState(ctx, gCtx)
}

func (s *Server) clearDownloadStateForModel(model methods.LocalInferenceModel) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for key, job := range s.downloadJobs {
		if job == nil {
			delete(s.downloadJobs, key)
			continue
		}
		if job.modelID != model.ID && job.modelID != model.RepoID {
			continue
		}
		if job.running() {
			return
		}
		delete(s.downloadJobs, key)
	}
	for key, state := range s.downloadStates {
		if state == nil || state.ModelID == model.ID || state.ModelID == model.RepoID {
			delete(s.downloadStates, key)
		}
	}
}

func (s *Server) AgentServerEnv(ctx context.Context, agentServer string) (map[string]string, error) {
	if agentServer != methods.LocalAgentServerName {
		return nil, nil
	}
	cfg, err := s.loadConfig()
	if err != nil {
		return nil, err
	}

	baseURL := normalizeStandaloneBaseURL(os.Getenv(baseURLEnv))
	apiKey := strings.TrimSpace(os.Getenv(apiKeyEnv))
	if baseURL == "" {
		sidecar, err := s.ensureSidecar(ctx, cfg)
		if err != nil {
			return nil, err
		}
		baseURL = sidecar.baseURL
		apiKey = sidecar.apiKey
	}

	modelID := strings.TrimSpace(os.Getenv(modelEnv))
	if modelID == "" {
		modelID = s.defaultModelID(cfg)
	}
	if apiKey == "" {
		apiKey = "camber-local"
	}
	env := map[string]string{
		standaloneBaseURLEnv: baseURL,
		standaloneAPIKeyEnv:  apiKey,
	}
	if modelID != "" {
		env[standaloneModelEnv] = modelID
	}
	return env, nil
}

func (s *Server) AgentServerReady(ctx context.Context, agentServer string) (bool, error) {
	if agentServer != methods.LocalAgentServerName {
		return true, nil
	}
	if baseURL := normalizeStandaloneBaseURL(os.Getenv(baseURLEnv)); baseURL != "" {
		// An external OpenAI-compatible server is user-managed, but a dead one
		// should be reported the same way as a dead sidecar rather than
		// letting the ACP subprocess fail opaquely. /v1/models is standard
		// across OpenAI-compatible servers.
		probeCtx, cancel := context.WithTimeout(ctx, s.sidecarProbeTimeout())
		defer cancel()
		if err := probeSidecar(probeCtx, baseURL, strings.TrimSpace(os.Getenv(apiKeyEnv))); err != nil {
			if ctxErr := ctx.Err(); ctxErr != nil {
				return false, ctxErr
			}
			if errors.Is(err, context.DeadlineExceeded) {
				// Slow, not dead: the server is likely busy serving a request
				// (e.g. loading model weights). Restarting the agent would
				// not help.
				slog.Info("local inference: external server readiness probe timed out; treating as busy", "base_url", baseURL)
				return true, nil
			}
			slog.Info("local inference: external server failed readiness probe", "base_url", baseURL, "error", err)
			return false, nil
		}
		return true, nil
	}

	s.mu.Lock()
	sidecar := s.sidecar
	s.mu.Unlock()
	if sidecar == nil {
		return false, nil
	}
	if !sidecar.running() {
		s.stopSidecar(sidecar)
		return false, nil
	}

	probeCtx, cancel := context.WithTimeout(ctx, s.sidecarProbeTimeout())
	defer cancel()
	if err := probeSidecar(probeCtx, sidecar.baseURL, sidecar.apiKey); err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return false, ctxErr
		}
		if errors.Is(err, context.DeadlineExceeded) && sidecar.running() {
			// A slow /v1/models means the sidecar is busy (e.g. loading model
			// weights takes minutes for large models), not dead. Killing it
			// here would discard the load progress and doom the next load to
			// the same fate at the next session boundary.
			slog.Info("local MLX sidecar readiness probe timed out; treating busy sidecar as ready", "base_url", sidecar.baseURL)
			return true, nil
		}
		slog.Info("local MLX sidecar failed readiness probe", "base_url", sidecar.baseURL, "error", err)
		s.stopSidecar(sidecar)
		return false, nil
	}
	return true, nil
}

func (s *Server) sidecarProbeTimeout() time.Duration {
	if s.probeTimeout > 0 {
		return s.probeTimeout
	}
	return sidecarProbeTimeout
}

// state builds a snapshot without any Hugging Face requests: it runs on every
// notify, including each download-progress tick, so it must stay cheap.
// Explicit client reads through GetState go through
// stateWithMetadataFetch to populate missing download sizes.
func (s *Server) state(ctx context.Context) (methods.LocalInferenceState, error) {
	return s.stateWithMetadataFetch(ctx, false)
}

func (s *Server) stateWithMetadataFetch(ctx context.Context, fetchRemote bool) (methods.LocalInferenceState, error) {
	cfg, err := s.loadConfig()
	if err != nil {
		return methods.LocalInferenceState{}, err
	}
	modelsDir := s.modelsDirectory(cfg)
	defaultModel := s.defaultModelID(cfg)
	downloads := s.downloadStateSnapshots()
	models := s.decorateCatalog(ctx, modelsDir, defaultModel, downloads, currentMachineProfile(), fetchRemote)
	return methods.LocalInferenceState{
		ModelsDirectory: modelsDir,
		Catalog:         models,
		Runtime:         s.runtimeState(defaultModel),
		Downloads:       downloads,
	}, nil
}

func (s *Server) notifyState(ctx context.Context, gCtx *glsp.Context) (methods.LocalInferenceState, error) {
	s.rememberClient(gCtx)
	state, err := s.state(ctx)
	if err != nil {
		return methods.LocalInferenceState{}, err
	}
	if err := s.notifyDidChange(ctx, state); err != nil {
		return methods.LocalInferenceState{}, err
	}
	return state, nil
}

func (s *Server) notifyStateBestEffort() {
	if _, err := s.notifyState(context.Background(), nil); err != nil {
		slog.Warn("local inference: failed to notify state change", "error", err)
	}
}

func (s *Server) rememberClient(gCtx *glsp.Context) {
	if gCtx == nil || gCtx.Notify == nil {
		return
	}
	notify := gCtx.Notify

	s.mu.Lock()
	s.notify = func(ctx context.Context, params methods.LocalInferenceDidChangeParams) error {
		notifyCtx := context.Background()
		if ctx != nil {
			notifyCtx = context.WithoutCancel(ctx)
		}
		return notify(notifyCtx, methods.LocalInferenceDidChangeMethod, params)
	}
	s.mu.Unlock()
}

func (s *Server) notifyDidChange(ctx context.Context, state methods.LocalInferenceState) error {
	notify := s.clientNotifier()
	if notify == nil {
		slog.Warn("local inference: no client notifier registered for state change", localInferenceDownloadsLogAttrs(state.Downloads)...)
		return nil
	}
	if err := notify(ctx, methods.LocalInferenceDidChangeParams{State: state}); err != nil {
		return err
	}
	slog.Debug("local inference: notified state change", localInferenceDownloadsLogAttrs(state.Downloads)...)
	return nil
}

func localInferenceDownloadsLogAttrs(downloads []methods.LocalInferenceDownloadState) []any {
	if len(downloads) == 0 {
		return []any{"download_status", "none"}
	}
	download := downloads[0]
	return []any{
		"downloads", len(downloads),
		"model_id", download.ModelID,
		"download_status", string(download.Status),
		"current_file", download.CurrentFile,
		"files_completed", download.FilesCompleted,
		"files_total", download.FilesTotal,
		"bytes_downloaded", download.BytesDownloaded,
		"bytes_total", download.BytesTotal,
		"bytes_per_second", download.BytesPerSecond,
		"eta_seconds", download.EtaSeconds,
	}
}

func (s *Server) clientNotifier() localInferenceNotifier {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.notify
}

func (s *Server) runtimeState(defaultModel string) methods.LocalInferenceRuntimeState {
	baseURL := normalizeStandaloneBaseURL(os.Getenv(baseURLEnv))
	state := methods.LocalInferenceRuntimeState{
		Supported:      localRuntimeSupported(),
		Status:         methods.LocalInferenceRuntimeStopped,
		AgentServer:    methods.LocalAgentServerName,
		BaseURL:        baseURL,
		DefaultModelID: defaultModel,
	}
	if baseURL != "" {
		state.Status = methods.LocalInferenceRuntimeExternal
		return state
	}
	s.mu.Lock()
	sidecar := s.sidecar
	if sidecar != nil && sidecar.running() {
		state.Status = methods.LocalInferenceRuntimeRunning
		state.BaseURL = sidecar.baseURL
		if residency := sidecar.residency; residency != nil {
			state.LoadedModelID = residency.loadedModelID
			state.IdleUnloadSeconds = residency.idleUnloadSeconds
			if residency.loadedModelID != "" {
				state.LoadedMemoryBytes = residency.memoryBytes
				state.LastActivityUnixMs = residency.lastActivity.UnixMilli()
			}
		}
		s.mu.Unlock()
		return state
	}
	s.mu.Unlock()
	if !state.Supported {
		state.Status = methods.LocalInferenceRuntimeUnavailable
		state.UnavailableReason = "local MLX inference requires an Apple Silicon Mac"
		return state
	}
	if _, ok := sidecarExecutablePath(); !ok {
		state.Status = methods.LocalInferenceRuntimeUnavailable
		state.UnavailableReason = fmt.Sprintf("local MLX sidecar is not installed; %s, or set %s to a running OpenAI-compatible MLX server", sidecarInstallHint(), baseURLEnv)
		return state
	}
	return state
}

func (s *Server) loadConfig() (configFile, error) {
	data, err := os.ReadFile(s.configPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return configFile{}, nil
		}
		return configFile{}, fmt.Errorf("local inference config: reading %s: %w", s.configPath, err)
	}
	var cfg configFile
	if err := json.Unmarshal(data, &cfg); err != nil {
		return configFile{}, fmt.Errorf("local inference config: parsing %s: %w", s.configPath, err)
	}
	return cfg, nil
}

func (s *Server) saveConfig(cfg configFile) error {
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("local inference config: encoding: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(s.configPath), 0o755); err != nil {
		return fmt.Errorf("local inference config: creating directory: %w", err)
	}
	if err := os.WriteFile(s.configPath, append(data, '\n'), 0o644); err != nil {
		return fmt.Errorf("local inference config: writing %s: %w", s.configPath, err)
	}
	return nil
}

func (s *Server) modelsDirectory(_ configFile) string {
	return defaultModelsDirectory()
}

func (s *Server) defaultModelID(cfg configFile) string {
	if modelID := strings.TrimSpace(os.Getenv(modelEnv)); modelID != "" {
		return modelID
	}
	if modelID := cfg.DefaultModelID; modelID != "" {
		if catalogContains(modelID) {
			return modelID
		}
		// A persisted default can go stale when the built-in catalog renames
		// its ids (the config file is not migrated). Keep it only if it still
		// matches an installed model; otherwise fall back to the catalog
		// default so the sidecar and agent are not launched targeting a model
		// that exists nowhere.
		if _, ok := s.installedModelByID(s.modelsDirectory(cfg), modelID); ok {
			return modelID
		}
	}
	return defaultModelID
}

func defaultModelsDirectory() string {
	if dir := strings.TrimSpace(os.Getenv(modelsDirEnv)); dir != "" {
		return cleanModelsDirectory(dir)
	}
	if dir := strings.TrimSpace(os.Getenv("OSU_MODELS_DIR")); dir != "" {
		return cleanModelsDirectory(dir)
	}
	return cleanModelsDirectory(filepath.Join(userconfig.CamberDirectory(), "models"))
}

func cleanModelsDirectory(dir string) string {
	if abs, err := filepath.Abs(dir); err == nil {
		dir = abs
	}
	return filepath.Clean(dir)
}
