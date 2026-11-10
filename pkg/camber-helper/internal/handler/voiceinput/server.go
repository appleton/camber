package voiceinput

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/appleton/camber/pkg/camber-helper/methods"
	"github.com/appleton/camber/pkg/common/userconfig"
	"github.com/tliron/glsp"
)

const (
	configFilename = "voice-input.json"

	whisperServerPathEnv = "CAMBER_WHISPER_SERVER"
	modelsDirEnv         = "CAMBER_VOICE_INPUT_MODELS_DIR"
	modelEnv             = "CAMBER_VOICE_INPUT_MODEL"
	modelBaseURLEnv      = "CAMBER_VOICE_INPUT_HF_BASE_URL"

	sidecarHost                    = "127.0.0.1"
	inferencePath                  = "/inference"
	sidecarReadyTimeout            = 60 * time.Second
	sidecarReadyInterval           = 200 * time.Millisecond
	sidecarGracefulShutdownTimeout = 2 * time.Second

	downloadProgressInterval = 250 * time.Millisecond
	partFileSuffix           = ".part"

	// maxAudioBytes caps decoded audio payloads. 16 kHz mono PCM16 is 32 KB/s,
	// so this allows well over 20 minutes of speech.
	maxAudioBytes = 48 << 20

	whisperServerMissingReason = "whisper-server (whisper.cpp) was not found; install it with `brew install whisper-cpp` or set CAMBER_WHISPER_SERVER to the binary"
)

type configFile struct {
	ModelID string `json:"modelId,omitempty"`
}

type Server struct {
	configPath string

	mu            sync.Mutex
	sidecar       *managedWhisperServer
	downloadJob   *downloadJob
	downloadState *methods.VoiceInputDownloadState

	httpClient *http.Client
}

func NewServer() *Server {
	return &Server{
		configPath: userconfig.CamberConfigFile(configFilename),
		httpClient: &http.Client{},
	}
}

func (s *Server) Close() error {
	s.mu.Lock()
	if s.downloadJob != nil && s.downloadJob.running() {
		s.downloadJob.cancel()
	}
	sidecar := s.detachSidecarLocked()
	s.mu.Unlock()
	return shutdownSidecar(sidecar)
}

func (s *Server) GetState(ctx context.Context, _ *methods.VoiceInputGetStateParams, gCtx *glsp.Context) (methods.VoiceInputState, error) {
	return s.state()
}

func (s *Server) SetModel(ctx context.Context, req *methods.VoiceInputSetModelParams, gCtx *glsp.Context) (methods.VoiceInputState, error) {
	modelID := strings.TrimSpace(req.ModelID)
	if _, ok := catalogModel(modelID); !ok {
		return methods.VoiceInputState{}, fmt.Errorf("voice input model %q is not known", modelID)
	}
	cfg, err := s.loadConfig()
	if err != nil {
		return methods.VoiceInputState{}, err
	}
	cfg.ModelID = modelID
	if err := s.saveConfig(cfg); err != nil {
		return methods.VoiceInputState{}, err
	}
	return s.state()
}

func (s *Server) DownloadModel(ctx context.Context, req *methods.VoiceInputDownloadModelParams, gCtx *glsp.Context) (methods.VoiceInputState, error) {
	cfg, err := s.loadConfig()
	if err != nil {
		return methods.VoiceInputState{}, err
	}
	modelID := strings.TrimSpace(req.ModelID)
	if modelID == "" {
		modelID = s.selectedModelID(cfg)
	}
	model, ok := catalogModel(modelID)
	if !ok {
		return methods.VoiceInputState{}, fmt.Errorf("voice input model %q is not known", modelID)
	}
	modelsDir := defaultModelsDirectory()
	if modelDownloaded(modelsDir, model.id) {
		return s.state()
	}

	jobCtx, cancel := context.WithCancel(context.Background())
	job := &downloadJob{
		modelID: model.id,
		cancel:  cancel,
		done:    make(chan struct{}),
	}

	s.mu.Lock()
	if existing := s.downloadJob; existing != nil && existing.running() {
		s.mu.Unlock()
		cancel()
		return s.state()
	}
	s.downloadJob = job
	s.downloadState = &methods.VoiceInputDownloadState{
		ModelID:    model.id,
		Status:     methods.VoiceInputDownloadDownloading,
		BytesTotal: model.downloadBytes,
	}
	s.mu.Unlock()

	go s.runDownload(jobCtx, job, model, modelsDir)
	return s.state()
}

func (s *Server) CancelDownload(ctx context.Context, req *methods.VoiceInputCancelDownloadParams, gCtx *glsp.Context) (methods.VoiceInputState, error) {
	var done <-chan struct{}
	s.mu.Lock()
	if job := s.downloadJob; job != nil && job.running() {
		job.cancel()
		done = job.done
	}
	s.mu.Unlock()

	// Wait for the cancelled job to record its final status so the returned
	// state does not race the didChange carrying the cancellation.
	if done != nil {
		select {
		case <-done:
		case <-ctx.Done():
			return methods.VoiceInputState{}, ctx.Err()
		}
	}
	return s.state()
}

func (s *Server) DeleteModel(ctx context.Context, req *methods.VoiceInputDeleteModelParams, gCtx *glsp.Context) (methods.VoiceInputState, error) {
	modelID := strings.TrimSpace(req.ModelID)
	if _, ok := catalogModel(modelID); !ok {
		return methods.VoiceInputState{}, fmt.Errorf("voice input model %q is not known", modelID)
	}
	modelsDir := defaultModelsDirectory()
	path := modelPath(modelsDir, modelID)

	s.mu.Lock()
	sidecar := s.sidecar
	if sidecar != nil && sidecar.modelPath == path {
		sidecar = s.detachSidecarLocked()
	} else {
		sidecar = nil
	}
	s.mu.Unlock()
	if err := shutdownSidecar(sidecar); err != nil {
		return methods.VoiceInputState{}, err
	}

	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return methods.VoiceInputState{}, fmt.Errorf("deleting voice input model %q: %w", modelID, err)
	}
	return s.state()
}

func (s *Server) Transcribe(ctx context.Context, req *methods.VoiceInputTranscribeParams, gCtx *glsp.Context) (methods.VoiceInputTranscribeResult, error) {
	audio, err := decodeAudio(req.Audio)
	if err != nil {
		return methods.VoiceInputTranscribeResult{}, err
	}

	cfg, err := s.loadConfig()
	if err != nil {
		return methods.VoiceInputTranscribeResult{}, err
	}
	modelID := s.selectedModelID(cfg)
	modelsDir := defaultModelsDirectory()
	if !modelDownloaded(modelsDir, modelID) {
		return methods.VoiceInputTranscribeResult{}, fmt.Errorf("voice input model %q is not downloaded", modelID)
	}

	sidecar, err := s.ensureSidecar(ctx, modelPath(modelsDir, modelID))
	if err != nil {
		return methods.VoiceInputTranscribeResult{}, err
	}
	text, err := transcribeRequest(ctx, s.httpClient, sidecar.baseURL, audio, req.Language)
	if err != nil {
		return methods.VoiceInputTranscribeResult{}, err
	}
	return methods.VoiceInputTranscribeResult{Text: text}, nil
}

func (s *Server) state() (methods.VoiceInputState, error) {
	cfg, err := s.loadConfig()
	if err != nil {
		return methods.VoiceInputState{}, err
	}
	modelsDir := defaultModelsDirectory()
	selected := s.selectedModelID(cfg)

	state := methods.VoiceInputState{
		ModelsDirectory: modelsDir,
		SelectedModelID: selected,
		Models:          s.models(modelsDir, selected),
		Runtime:         methods.VoiceInputRuntimeStopped,
	}
	if _, ok := whisperServerPath(); ok {
		state.Supported = true
	} else {
		state.UnavailableReason = whisperServerMissingReason
		state.Runtime = methods.VoiceInputRuntimeUnavailable
	}

	s.mu.Lock()
	if s.sidecar != nil && s.sidecar.running() {
		state.Runtime = methods.VoiceInputRuntimeRunning
	}
	if s.downloadState != nil {
		snapshot := *s.downloadState
		state.Download = &snapshot
	}
	s.mu.Unlock()

	state.Ready = state.Supported && modelDownloaded(modelsDir, selected)
	return state, nil
}

func (s *Server) selectedModelID(cfg configFile) string {
	if modelID := strings.TrimSpace(os.Getenv(modelEnv)); modelID != "" {
		return modelID
	}
	if cfg.ModelID != "" {
		return cfg.ModelID
	}
	return defaultModelID
}

func (s *Server) loadConfig() (configFile, error) {
	data, err := os.ReadFile(s.configPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return configFile{}, nil
		}
		return configFile{}, fmt.Errorf("voice input config: reading %s: %w", s.configPath, err)
	}
	var cfg configFile
	if err := json.Unmarshal(data, &cfg); err != nil {
		return configFile{}, fmt.Errorf("voice input config: parsing %s: %w", s.configPath, err)
	}
	return cfg, nil
}

func (s *Server) saveConfig(cfg configFile) error {
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("voice input config: encoding: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(s.configPath), 0o755); err != nil {
		return fmt.Errorf("voice input config: creating directory: %w", err)
	}
	if err := os.WriteFile(s.configPath, append(data, '\n'), 0o644); err != nil {
		return fmt.Errorf("voice input config: writing %s: %w", s.configPath, err)
	}
	return nil
}
