package localinference

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/appleton/camber/pkg/camber-helper/methods"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/tliron/glsp"
)

func TestAgentServerEnvUsesExternalBaseURL(t *testing.T) {
	s := &Server{configPath: filepath.Join(t.TempDir(), "local-inference.json")}
	t.Setenv(baseURLEnv, "http://127.0.0.1:4321/v1/")
	t.Setenv(apiKeyEnv, "secret")

	env, err := s.AgentServerEnv(context.Background(), methods.LocalAgentServerName)
	require.NoError(t, err)
	require.Equal(t, "http://127.0.0.1:4321", env[standaloneBaseURLEnv])
	require.Equal(t, "secret", env[standaloneAPIKeyEnv])
	require.Equal(t, defaultModelID, env[standaloneModelEnv])
}

func TestAgentServerEnvIgnoresOtherServers(t *testing.T) {
	s := &Server{configPath: filepath.Join(t.TempDir(), "local-inference.json")}
	t.Setenv(baseURLEnv, "http://127.0.0.1:4321")

	env, err := s.AgentServerEnv(context.Background(), "poolside")
	require.NoError(t, err)
	require.Nil(t, env)
}

func TestAgentServerReady(t *testing.T) {
	t.Run("probes external base url", func(t *testing.T) {
		probed := false
		httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			probed = true
			require.Equal(t, "/v1/models", r.URL.Path)
			require.Equal(t, "Bearer external-secret", r.Header.Get("Authorization"))
			w.WriteHeader(http.StatusOK)
		}))
		defer httpServer.Close()
		s := &Server{configPath: filepath.Join(t.TempDir(), "local-inference.json")}
		t.Setenv(baseURLEnv, httpServer.URL)
		t.Setenv(apiKeyEnv, "external-secret")

		ready, err := s.AgentServerReady(context.Background(), methods.LocalAgentServerName)

		require.NoError(t, err)
		require.True(t, ready)
		require.True(t, probed)
	})

	t.Run("reports dead external base url as not ready", func(t *testing.T) {
		httpServer := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
		httpServer.Close()
		s := &Server{configPath: filepath.Join(t.TempDir(), "local-inference.json")}
		t.Setenv(baseURLEnv, httpServer.URL)

		ready, err := s.AgentServerReady(context.Background(), methods.LocalAgentServerName)

		require.NoError(t, err)
		require.False(t, ready)
	})

	t.Run("probes managed sidecar", func(t *testing.T) {
		probed := false
		httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			probed = true
			require.Equal(t, "/v1/models", r.URL.Path)
			require.Equal(t, "Bearer secret", r.Header.Get("Authorization"))
			w.WriteHeader(http.StatusOK)
		}))
		defer httpServer.Close()
		s := &Server{
			configPath: filepath.Join(t.TempDir(), "local-inference.json"),
			sidecar: &managedSidecar{
				baseURL: httpServer.URL,
				apiKey:  "secret",
				done:    make(chan error),
			},
		}

		ready, err := s.AgentServerReady(context.Background(), methods.LocalAgentServerName)

		require.NoError(t, err)
		require.True(t, ready)
		require.True(t, probed)
		require.NotNil(t, s.sidecar)
	})

	t.Run("clears failed managed sidecar", func(t *testing.T) {
		httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		}))
		defer httpServer.Close()
		s := &Server{
			configPath: filepath.Join(t.TempDir(), "local-inference.json"),
			sidecar: &managedSidecar{
				baseURL: httpServer.URL,
				done:    make(chan error),
			},
		}

		ready, err := s.AgentServerReady(context.Background(), methods.LocalAgentServerName)

		require.NoError(t, err)
		require.False(t, ready)
		require.Nil(t, s.sidecar)
	})
}

func TestStopSidecarClosesStdinControlPipe(t *testing.T) {
	stdin := &recordingWriteCloser{}
	sidecar := &managedSidecar{
		stdin: stdin,
		done:  make(chan error),
	}
	s := &Server{sidecar: sidecar}

	s.stopSidecar(sidecar)

	require.True(t, stdin.closed)
	require.Nil(t, s.sidecar)
}

func TestStateMarksDownloadedCatalogModel(t *testing.T) {
	dir := t.TempDir()
	modelDir := filepath.Join(dir, "poolside", "Laguna-XS-2.1-NVFP4-mlx")
	require.NoError(t, os.MkdirAll(modelDir, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(modelDir, "config.json"), []byte("{}"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(modelDir, "tokenizer.json"), []byte("{}"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(modelDir, "model.safetensors"), []byte("weights"), 0o644))

	s := &Server{configPath: filepath.Join(t.TempDir(), "local-inference.json")}
	t.Setenv(modelsDirEnv, dir)

	state, err := s.state(context.Background())
	require.NoError(t, err)
	require.Equal(t, dir, state.ModelsDirectory)
	require.NotEmpty(t, state.Catalog)
	require.True(t, state.Catalog[0].Downloaded)
	require.Equal(t, modelDir, state.Catalog[0].LocalPath)
	require.Positive(t, state.Catalog[0].InstalledBytes)
}

func TestStateDoesNotMarkInProgressModelDownloaded(t *testing.T) {
	dir := t.TempDir()
	modelDir := filepath.Join(dir, "poolside", "Laguna-XS-2.1-NVFP4-mlx")
	require.NoError(t, os.MkdirAll(modelDir, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(modelDir, "config.json"), []byte("{}"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(modelDir, "tokenizer.json"), []byte("{}"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(modelDir, "model.safetensors"), []byte("weights"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(modelDir, downloadMarkerFilename), []byte("downloading"), 0o644))

	s := &Server{configPath: filepath.Join(t.TempDir(), "local-inference.json")}
	t.Setenv(modelsDirEnv, dir)

	state, err := s.state(context.Background())
	require.NoError(t, err)
	require.NotEmpty(t, state.Catalog)
	require.False(t, state.Catalog[0].Downloaded)
	require.Equal(t, modelDir, state.Catalog[0].LocalPath)
	require.Positive(t, state.Catalog[0].InstalledBytes)
}

func TestStateFetchesAndCachesCatalogDownloadBytes(t *testing.T) {
	var treeRequests atomic.Int32
	hf := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.True(t, strings.HasPrefix(r.URL.Path, "/api/models/"))
		require.True(t, strings.HasSuffix(r.URL.Path, "/tree/main"))
		treeRequests.Add(1)

		w.Header().Set("Content-Type", "application/json")
		require.NoError(t, json.NewEncoder(w).Encode([]huggingFaceTreeNode{
			{
				Path: "config.json",
				Type: "file",
				Size: 128,
			},
			{
				Path: "model.safetensors",
				Type: "file",
				LFS: struct {
					Size int64 `json:"size"`
				}{Size: 4096},
			},
			{
				Path: "README.md",
				Type: "file",
				Size: 512,
			},
		}))
	}))
	defer hf.Close()

	s := &Server{
		configPath:          filepath.Join(t.TempDir(), "local-inference.json"),
		hfBaseURL:           hf.URL,
		httpClient:          hf.Client(),
		fetchRemoteMetadata: true,
	}
	t.Setenv(modelsDirEnv, t.TempDir())

	// The notify-path snapshot never fetches: download sizes stay unknown
	// until an explicit client read populates the metadata cache.
	state, err := s.state(context.Background())
	require.NoError(t, err)
	require.Zero(t, state.Catalog[0].DownloadBytes)
	require.Zero(t, treeRequests.Load())

	state, err = s.GetState(context.Background(), nil, nil)
	require.NoError(t, err)
	require.Equal(t, int64(4224), state.Catalog[0].DownloadBytes)
	require.Equal(t, int32(len(catalog())), treeRequests.Load())

	// Subsequent snapshots — notify-path and explicit — reuse the cache.
	state, err = s.state(context.Background())
	require.NoError(t, err)
	require.Equal(t, int64(4224), state.Catalog[0].DownloadBytes)
	require.Equal(t, int32(len(catalog())), treeRequests.Load())

	state, err = s.GetState(context.Background(), nil, nil)
	require.NoError(t, err)
	require.Equal(t, int64(4224), state.Catalog[0].DownloadBytes)
	require.Equal(t, int32(len(catalog())), treeRequests.Load())
}

func TestStateIncludesInstalledCustomModelAndAllowsDefault(t *testing.T) {
	dir := t.TempDir()
	modelDir := filepath.Join(dir, "custom", "Repo-4bit")
	require.NoError(t, os.MkdirAll(modelDir, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(modelDir, "config.json"), []byte("{}"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(modelDir, "tokenizer.json"), []byte("{}"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(modelDir, "model.safetensors"), []byte("weights"), 0o644))
	require.NoError(t, writeInstalledModelManifest(modelDir, methods.LocalInferenceModel{
		ID:            "custom/Repo-4bit",
		RepoID:        "custom/Repo-4bit",
		Name:          "Custom Repo 4-bit",
		Provider:      "Custom",
		Source:        "Hugging Face",
		SourceURL:     "https://huggingface.co/custom/Repo-4bit",
		AvatarURL:     "https://huggingface.co/api/avatars/custom",
		Family:        "custom",
		Quantization:  "4-bit",
		ParameterSize: "7B",
		Description:   "Custom MLX model.",
		ContextWindow: 32768,
		DownloadBytes: 4096,
	}))

	s := &Server{configPath: filepath.Join(t.TempDir(), "local-inference.json")}
	t.Setenv(modelsDirEnv, dir)

	state, err := s.state(context.Background())
	require.NoError(t, err)
	custom := findModel(t, state.Catalog, "custom/Repo-4bit")
	require.True(t, custom.Downloaded)
	require.Equal(t, modelDir, custom.LocalPath)
	require.Equal(t, "Custom Repo 4-bit", custom.Name)
	require.Equal(t, "Hugging Face", custom.Source)
	require.Equal(t, "https://huggingface.co/custom/Repo-4bit", custom.SourceURL)
	require.Equal(t, "https://huggingface.co/api/avatars/custom", custom.AvatarURL)
	require.Equal(t, "7B", custom.ParameterSize)
	require.Equal(t, int64(4096), custom.DownloadBytes)

	state, err = s.SetDefaultModel(
		context.Background(),
		&methods.LocalInferenceSetDefaultModelParams{ModelID: "custom/Repo-4bit"},
		nil,
	)
	require.NoError(t, err)
	custom = findModel(t, state.Catalog, "custom/Repo-4bit")
	require.True(t, custom.Default)
}

func TestStateDiscoversManuallyPlacedModelAndAllowsDefault(t *testing.T) {
	dir := t.TempDir()
	modelDir := filepath.Join(dir, "poolside", "Laguna-S-2.1-NVFP4-mlx")
	require.NoError(t, os.MkdirAll(modelDir, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(modelDir, "config.json"), []byte("{}"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(modelDir, "tokenizer.json"), []byte("{}"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(modelDir, "model.safetensors"), []byte("weights"), 0o644))
	incompleteDir := filepath.Join(dir, "other", "Incomplete-mlx")
	require.NoError(t, os.MkdirAll(incompleteDir, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(incompleteDir, "config.json"), []byte("{}"), 0o644))

	s := &Server{configPath: filepath.Join(t.TempDir(), "local-inference.json")}
	t.Setenv(modelsDirEnv, dir)

	state, err := s.state(context.Background())
	require.NoError(t, err)
	model := findModel(t, state.Catalog, "poolside/Laguna-S-2.1-NVFP4-mlx")
	assert.True(t, model.Downloaded)
	assert.Equal(t, modelDir, model.LocalPath)
	assert.Equal(t, "Laguna S 2.1 NVFP4 mlx", model.Name)
	assert.Equal(t, "poolside", model.Provider)
	assert.Equal(t, "Hugging Face", model.Source)
	for _, other := range state.Catalog {
		assert.NotEqual(t, "other/Incomplete-mlx", other.ID)
	}

	state, err = s.SetDefaultModel(
		context.Background(),
		&methods.LocalInferenceSetDefaultModelParams{ModelID: "poolside/Laguna-S-2.1-NVFP4-mlx"},
		nil,
	)
	require.NoError(t, err)
	model = findModel(t, state.Catalog, "poolside/Laguna-S-2.1-NVFP4-mlx")
	assert.True(t, model.Default)
}

// A hand-copied directory keeps the manifest of the model it was copied from,
// so the manifest names a repo that lives nowhere: the files on disk, not the
// stale manifest, say what the directory holds.
func TestStateIgnoresManifestThatDisagreesWithItsDirectory(t *testing.T) {
	dir := t.TempDir()
	modelDir := filepath.Join(dir, "real-owner", "Real-Model-4bit")
	writeCompleteModel(t, modelDir)
	require.NoError(t, writeInstalledModelManifest(modelDir, methods.LocalInferenceModel{
		ID:     "wrong-owner/Wrong-Name-4bit",
		RepoID: "wrong-owner/Wrong-Name-4bit",
		Name:   "Wrong Name 4-bit",
	}))

	s := &Server{configPath: filepath.Join(t.TempDir(), "local-inference.json")}
	t.Setenv(modelsDirEnv, dir)

	state, err := s.state(context.Background())
	require.NoError(t, err)
	model := findModel(t, state.Catalog, "real-owner/Real-Model-4bit")
	assert.True(t, model.Downloaded)
	assert.Equal(t, modelDir, model.LocalPath)
	// The phantom would be listed as installed while resolving to no path at
	// all, so selecting it as the default would launch the sidecar at a
	// directory that does not exist.
	for _, other := range state.Catalog {
		assert.NotEqual(t, "wrong-owner/Wrong-Name-4bit", other.ID)
	}
}

func TestStateDiscoversModelWithUnreadableManifest(t *testing.T) {
	dir := t.TempDir()
	modelDir := filepath.Join(dir, "custom", "Repo-4bit")
	writeCompleteModel(t, modelDir)
	require.NoError(t, os.WriteFile(
		filepath.Join(modelDir, installedManifestFilename),
		[]byte("{ this is not json"),
		0o644,
	))

	s := &Server{configPath: filepath.Join(t.TempDir(), "local-inference.json")}
	t.Setenv(modelsDirEnv, dir)

	state, err := s.state(context.Background())
	require.NoError(t, err)
	model := findModel(t, state.Catalog, "custom/Repo-4bit")
	assert.True(t, model.Downloaded)
	assert.Equal(t, modelDir, model.LocalPath)
}

func TestStateListsManifestModelOnceWhenAlsoDiscoverable(t *testing.T) {
	dir := t.TempDir()
	modelDir := filepath.Join(dir, "custom", "Repo-4bit")
	writeCompleteModel(t, modelDir)
	require.NoError(t, writeInstalledModelManifest(modelDir, methods.LocalInferenceModel{
		ID:     "custom/Repo-4bit",
		RepoID: "custom/Repo-4bit",
		Name:   "Custom Repo 4-bit",
	}))

	s := &Server{configPath: filepath.Join(t.TempDir(), "local-inference.json")}
	t.Setenv(modelsDirEnv, dir)

	state, err := s.state(context.Background())
	require.NoError(t, err)
	var matches int
	for _, model := range state.Catalog {
		if model.RepoID == "custom/Repo-4bit" {
			matches++
		}
	}
	assert.Equal(t, 1, matches)
	// The manifest describes the model; discovery must not overwrite it with
	// the name inferred from the directory.
	assert.Equal(t, "Custom Repo 4-bit", findModel(t, state.Catalog, "custom/Repo-4bit").Name)
}

func TestWatchModelsDirectoryNotifiesWhenModelAppearsAndDisappears(t *testing.T) {
	dir := t.TempDir()
	s := &Server{configPath: filepath.Join(t.TempDir(), "local-inference.json")}
	t.Setenv(modelsDirEnv, dir)

	var mu sync.Mutex
	var notified int
	s.rememberClient(&glsp.Context{
		Notify: func(context.Context, string, any) error {
			mu.Lock()
			defer mu.Unlock()
			notified++
			return nil
		},
	})
	notifications := func() int {
		mu.Lock()
		defer mu.Unlock()
		return notified
	}

	stop := s.watchModelsDirectory(5 * time.Millisecond)
	defer func() { require.NoError(t, stop()) }()

	modelDir := filepath.Join(dir, "custom", "Manual-4bit")
	writeCompleteModel(t, modelDir)
	require.Eventually(t, func() bool { return notifications() > 0 }, 5*time.Second, 5*time.Millisecond)

	seen := notifications()
	require.NoError(t, os.RemoveAll(modelDir))
	require.Eventually(t, func() bool { return notifications() > seen }, 5*time.Second, 5*time.Millisecond)
}

// The app's own downloads churn the tree constantly and already push state on
// every progress tick; the watcher must absorb their movement silently.
func TestWatchModelsDirectoryStaysQuietWhileDownloadRunning(t *testing.T) {
	dir := t.TempDir()
	s := &Server{configPath: filepath.Join(t.TempDir(), "local-inference.json")}
	t.Setenv(modelsDirEnv, dir)
	s.downloadJobs = map[string]*downloadJob{
		"custom/Busy-4bit": {modelID: "custom/Busy-4bit", done: make(chan struct{})},
	}

	var mu sync.Mutex
	var notified int
	s.rememberClient(&glsp.Context{
		Notify: func(context.Context, string, any) error {
			mu.Lock()
			defer mu.Unlock()
			notified++
			return nil
		},
	})

	stop := s.watchModelsDirectory(5 * time.Millisecond)
	defer func() { require.NoError(t, stop()) }()

	writeCompleteModel(t, filepath.Join(dir, "custom", "Manual-4bit"))
	time.Sleep(100 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()
	assert.Zero(t, notified)
}

func TestModelsDirStampMovesOnEntryChangesOnly(t *testing.T) {
	dir := t.TempDir()
	modelDir := filepath.Join(dir, "custom", "Manual-4bit")
	writeCompleteModel(t, modelDir)

	before := currentModelsDirStamp(dir)
	assert.Equal(t, before, currentModelsDirStamp(dir))

	require.NoError(t, os.RemoveAll(modelDir))
	after := currentModelsDirStamp(dir)
	assert.NotEqual(t, before, after)

	writeCompleteModel(t, modelDir)
	assert.NotEqual(t, after, currentModelsDirStamp(dir))
}

func writeCompleteModel(t *testing.T, modelDir string) {
	t.Helper()
	require.NoError(t, os.MkdirAll(modelDir, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(modelDir, "config.json"), []byte("{}"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(modelDir, "tokenizer.json"), []byte("{}"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(modelDir, "model.safetensors"), []byte("weights"), 0o644))
}

func TestDeleteModelRemovesModelDirectoryAndResetsDefault(t *testing.T) {
	dir := t.TempDir()
	modelDir := filepath.Join(dir, "custom", "Repo-4bit")
	require.NoError(t, os.MkdirAll(modelDir, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(modelDir, "config.json"), []byte("{}"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(modelDir, "tokenizer.json"), []byte("{}"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(modelDir, "model.safetensors"), []byte("weights"), 0o644))
	require.NoError(t, writeInstalledModelManifest(modelDir, methods.LocalInferenceModel{
		ID:     "custom/Repo-4bit",
		RepoID: "custom/Repo-4bit",
		Name:   "Custom Repo 4-bit",
	}))

	s := &Server{configPath: filepath.Join(t.TempDir(), "local-inference.json")}
	t.Setenv(modelsDirEnv, dir)
	require.NoError(t, s.saveConfig(configFile{DefaultModelID: "custom/Repo-4bit"}))
	s.downloadJobs = map[string]*downloadJob{
		"custom/Repo-4bit": {modelID: "custom/Repo-4bit", done: closedChannel()},
	}
	s.downloadStates = map[string]*methods.LocalInferenceDownloadState{
		"custom/Repo-4bit": {
			ModelID: "custom/Repo-4bit",
			Status:  methods.LocalInferenceDownloadCancelled,
		},
	}

	state, err := s.DeleteModel(
		context.Background(),
		&methods.LocalInferenceDeleteModelParams{ModelID: "custom/Repo-4bit"},
		nil,
	)
	require.NoError(t, err)
	require.NoDirExists(t, modelDir)
	require.Empty(t, state.Downloads)
	require.Equal(t, defaultModelID, state.Runtime.DefaultModelID)
	for _, model := range state.Catalog {
		require.NotEqual(t, "custom/Repo-4bit", model.ID)
	}
}

func TestStateIncludesMultipleConcurrentDownloads(t *testing.T) {
	dir := t.TempDir()
	s := &Server{configPath: filepath.Join(t.TempDir(), "local-inference.json")}
	t.Setenv(modelsDirEnv, dir)
	s.downloadStates = map[string]*methods.LocalInferenceDownloadState{
		defaultModelID: {
			ModelID:         defaultModelID,
			Status:          methods.LocalInferenceDownloadDownloading,
			FilesCompleted:  1,
			FilesTotal:      3,
			BytesDownloaded: 100,
			BytesTotal:      300,
		},
		"mlx-community/Qwen3.6-35B-A3B-OptiQ-4bit": {
			ModelID:         "mlx-community/Qwen3.6-35B-A3B-OptiQ-4bit",
			Status:          methods.LocalInferenceDownloadResolving,
			FilesCompleted:  0,
			FilesTotal:      2,
			BytesDownloaded: 0,
			BytesTotal:      200,
		},
	}

	state, err := s.state(context.Background())
	require.NoError(t, err)
	require.Len(t, state.Downloads, 2)
	laguna := findModel(t, state.Catalog, defaultModelID)
	require.NotNil(t, laguna.Download)
	require.Equal(t, defaultModelID, laguna.Download.ModelID)
	qwen := findModel(t, state.Catalog, "mlx-community/Qwen3.6-35B-A3B-OptiQ-4bit")
	require.NotNil(t, qwen.Download)
	require.Equal(
		t,
		"mlx-community/Qwen3.6-35B-A3B-OptiQ-4bit",
		qwen.Download.ModelID,
	)
}

func TestDeleteModelRemovesPartialHuggingFaceModelWithoutManifest(t *testing.T) {
	dir := t.TempDir()
	modelDir := filepath.Join(dir, "mlx-community", "Partial-4bit")
	require.NoError(t, os.MkdirAll(modelDir, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(modelDir, downloadMarkerFilename), []byte("downloading"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(modelDir, "model.safetensors.part"), []byte("partial"), 0o644))

	s := &Server{configPath: filepath.Join(t.TempDir(), "local-inference.json")}
	t.Setenv(modelsDirEnv, dir)

	_, err := s.DeleteModel(
		context.Background(),
		&methods.LocalInferenceDeleteModelParams{ModelID: "mlx-community/Partial-4bit"},
		nil,
	)
	require.NoError(t, err)
	require.NoDirExists(t, modelDir)
}

func TestStateIncludesPartialHuggingFaceModelWithoutManifest(t *testing.T) {
	dir := t.TempDir()
	modelDir := filepath.Join(dir, "mlx-community", "Partial-4bit")
	require.NoError(t, os.MkdirAll(modelDir, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(modelDir, downloadMarkerFilename), []byte("downloading"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(modelDir, "model.safetensors.part"), []byte("partial"), 0o644))

	s := &Server{configPath: filepath.Join(t.TempDir(), "local-inference.json")}
	t.Setenv(modelsDirEnv, dir)

	state, err := s.state(context.Background())
	require.NoError(t, err)
	model := findModel(t, state.Catalog, "mlx-community/Partial-4bit")
	require.False(t, model.Downloaded)
	require.Equal(t, modelDir, model.LocalPath)
	require.Positive(t, model.InstalledBytes)
	require.Equal(t, "Partial 4bit", model.Name)
	require.Equal(t, "Hugging Face", model.Source)
	require.Equal(t, "https://huggingface.co/mlx-community/Partial-4bit", model.SourceURL)
}

func TestStateIncludesFailedHuggingFaceDownloadWithoutManifest(t *testing.T) {
	dir := t.TempDir()
	s := &Server{configPath: filepath.Join(t.TempDir(), "local-inference.json")}
	t.Setenv(modelsDirEnv, dir)
	s.downloadStates = map[string]*methods.LocalInferenceDownloadState{
		"mlx-community/Failed-4bit": {
			ModelID:   "mlx-community/Failed-4bit",
			Status:    methods.LocalInferenceDownloadFailed,
			Error:     "model requires ToS acceptance",
			ErrorCode: methods.LocalInferenceDownloadErrorCodeToSRequired,
		},
	}

	state, err := s.state(context.Background())
	require.NoError(t, err)
	model := findModel(t, state.Catalog, "mlx-community/Failed-4bit")
	require.False(t, model.Downloaded)
	require.NotNil(t, model.Download)
	require.Equal(t, methods.LocalInferenceDownloadFailed, model.Download.Status)
	require.Equal(t, "model requires ToS acceptance", model.Download.Error)
	require.Equal(t, methods.LocalInferenceDownloadErrorCodeToSRequired, model.Download.ErrorCode)
	require.Equal(t, "https://huggingface.co/mlx-community/Failed-4bit", model.SourceURL)

	state, err = s.DeleteModel(
		context.Background(),
		&methods.LocalInferenceDeleteModelParams{ModelID: "mlx-community/Failed-4bit"},
		nil,
	)
	require.NoError(t, err)
	require.Empty(t, state.Downloads)
}

func closedChannel() chan struct{} {
	ch := make(chan struct{})
	close(ch)
	return ch
}

func TestSearchModelsReturnsHuggingFaceMLXResults(t *testing.T) {
	dir := t.TempDir()
	var sawSearch bool
	hf := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/api/models", r.URL.Path)
		require.Equal(t, "laguna", r.URL.Query().Get("search"))
		require.Equal(t, "mlx", r.URL.Query().Get("filter"))
		require.Equal(t, "downloads", r.URL.Query().Get("sort"))
		sawSearch = true

		w.Header().Set("Content-Type", "application/json")
		require.NoError(t, json.NewEncoder(w).Encode([]huggingFaceSearchResult{
			{
				ID:      "mlx-community/Test-4bit",
				ModelID: "mlx-community/Test-4bit",
				Author:  "mlx-community",
				Tags:    []string{"mlx", "4-bit", "text-generation", "license:apache-2.0"},
				Gated:   "auto",
				Siblings: []struct {
					RFilename string `json:"rfilename"`
					Size      int64  `json:"size"`
					LFS       struct {
						Size int64 `json:"size"`
					} `json:"lfs"`
				}{
					{RFilename: "config.json"},
					{
						RFilename: "model.safetensors",
						LFS: struct {
							Size int64 `json:"size"`
						}{Size: 2048},
					},
				},
				Config: map[string]any{
					"model_type":              "llama",
					"max_position_embeddings": 32768,
				},
				Safetensors: huggingFaceSafetensors{
					Total: 7_100_000_000,
				},
			},
			{
				ID:      "private/Hidden",
				ModelID: "private/Hidden",
				Private: true,
				Tags:    []string{"mlx"},
			},
		}))
	}))
	defer hf.Close()

	s := &Server{
		configPath: filepath.Join(t.TempDir(), "local-inference.json"),
		hfBaseURL:  hf.URL,
		httpClient: hf.Client(),
	}
	t.Setenv(modelsDirEnv, dir)

	state, err := s.SearchModels(
		context.Background(),
		&methods.LocalInferenceSearchModelsParams{Query: "laguna"},
		nil,
	)
	require.NoError(t, err)
	require.True(t, sawSearch)
	require.Len(t, state.Models, 1)
	model := state.Models[0]
	require.Equal(t, "mlx-community/Test-4bit", model.ID)
	require.Equal(t, "mlx-community/Test-4bit", model.RepoID)
	require.Equal(t, "Test 4bit", model.Name)
	require.Equal(t, "mlx-community", model.Provider)
	require.Equal(t, "Hugging Face", model.Source)
	require.Equal(t, "https://huggingface.co/mlx-community/Test-4bit", model.SourceURL)
	require.Equal(t, "https://huggingface.co/api/avatars/mlx-community", model.AvatarURL)
	require.Equal(t, "llama", model.Family)
	require.Equal(t, "4-bit", model.Quantization)
	require.Equal(t, "7.1B", model.ParameterSize)
	require.Equal(t, 32768, model.ContextWindow)
	require.True(t, model.Gated)
	require.Equal(t, int64(2048), model.DownloadBytes)
	require.False(t, model.Downloaded)
	require.NotContains(t, model.Tags, "license:apache-2.0")
}

func TestSearchModelsRetriesAnonymouslyAfterRejectedAuth(t *testing.T) {
	tests := []struct {
		name              string
		envToken          string
		connectorToken    string
		wantAuthorization string
		wantInvalidations int
	}{
		{
			name:              "connector token is invalidated",
			connectorToken:    "rejected-connector-token",
			wantAuthorization: "Bearer rejected-connector-token",
			wantInvalidations: 1,
		},
		{
			name:              "environment token does not invalidate connector",
			envToken:          "rejected-env-token",
			connectorToken:    "unused-connector-token",
			wantAuthorization: "Bearer rejected-env-token",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv(huggingFaceTokenEnv, tt.envToken)
			t.Setenv(huggingFaceTokenAltEnv, "")
			var authorizations []string
			hf := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				require.Equal(t, "/api/models", r.URL.Path)
				authorizations = append(authorizations, r.Header.Get("Authorization"))
				if len(authorizations) == 1 {
					w.WriteHeader(http.StatusUnauthorized)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				require.NoError(t, json.NewEncoder(w).Encode([]huggingFaceSearchResult{{
					ID:      "mlx-community/Recovered-4bit",
					ModelID: "mlx-community/Recovered-4bit",
					Tags:    []string{"mlx", "text-generation"},
				}}))
			}))
			defer hf.Close()

			s := &Server{
				configPath: filepath.Join(t.TempDir(), "local-inference.json"),
				hfBaseURL:  hf.URL,
				httpClient: hf.Client(),
			}
			s.SetHuggingFaceTokenSource(func(context.Context) string { return tt.connectorToken })
			invalidations := 0
			s.SetHuggingFaceTokenInvalidator(func(context.Context) error {
				invalidations++
				return nil
			})
			t.Setenv(modelsDirEnv, t.TempDir())

			state, err := s.SearchModels(
				context.Background(),
				&methods.LocalInferenceSearchModelsParams{Query: "recovered"},
				nil,
			)

			require.NoError(t, err)
			require.Len(t, state.Models, 1)
			assert.Equal(t, "mlx-community/Recovered-4bit", state.Models[0].ID)
			assert.Equal(t, []string{tt.wantAuthorization, ""}, authorizations)
			assert.Equal(t, tt.wantInvalidations, invalidations)
		})
	}
}

func TestFetchHuggingFaceModelRetriesAnonymouslyAfterRejectedAuth(t *testing.T) {
	tests := []struct {
		name              string
		envToken          string
		connectorToken    string
		wantAuthorization string
		wantInvalidations int
	}{
		{
			name:              "connector token is invalidated",
			connectorToken:    "rejected-connector-token",
			wantAuthorization: "Bearer rejected-connector-token",
			wantInvalidations: 1,
		},
		{
			name:              "environment token does not invalidate connector",
			envToken:          "rejected-env-token",
			connectorToken:    "unused-connector-token",
			wantAuthorization: "Bearer rejected-env-token",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv(huggingFaceTokenEnv, tt.envToken)
			t.Setenv(huggingFaceTokenAltEnv, "")
			const repoID = "mlx-community/Recovered-4bit"
			var authorizations []string
			hf := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				require.Equal(t, "/api/models/"+repoID, r.URL.Path)
				authorizations = append(authorizations, r.Header.Get("Authorization"))
				if len(authorizations) == 1 {
					w.WriteHeader(http.StatusForbidden)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				require.NoError(t, json.NewEncoder(w).Encode(huggingFaceSearchResult{
					ID:      repoID,
					ModelID: repoID,
					Author:  "mlx-community",
					Tags:    []string{"mlx"},
				}))
			}))
			defer hf.Close()

			s := &Server{
				configPath: filepath.Join(t.TempDir(), "local-inference.json"),
				hfBaseURL:  hf.URL,
				httpClient: hf.Client(),
			}
			s.SetHuggingFaceTokenSource(func(context.Context) string { return tt.connectorToken })
			invalidations := 0
			s.SetHuggingFaceTokenInvalidator(func(context.Context) error {
				invalidations++
				return nil
			})

			model, err := s.fetchHuggingFaceModel(context.Background(), repoID, t.TempDir(), "")

			require.NoError(t, err)
			assert.Equal(t, repoID, model.ID)
			assert.Equal(t, []string{tt.wantAuthorization, ""}, authorizations)
			assert.Equal(t, tt.wantInvalidations, invalidations)
		})
	}
}

func TestFetchMatchingFilesRetriesAnonymouslyAfterRejectedAuth(t *testing.T) {
	tests := []struct {
		name              string
		envToken          string
		connectorToken    string
		wantAuthorization string
		wantInvalidations int
	}{
		{
			name:              "connector token is invalidated",
			connectorToken:    "rejected-connector-token",
			wantAuthorization: "Bearer rejected-connector-token",
			wantInvalidations: 1,
		},
		{
			name:              "environment token does not invalidate connector",
			envToken:          "rejected-env-token",
			connectorToken:    "unused-connector-token",
			wantAuthorization: "Bearer rejected-env-token",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv(huggingFaceTokenEnv, tt.envToken)
			t.Setenv(huggingFaceTokenAltEnv, "")
			const repoID = "mlx-community/Recovered-4bit"
			var authorizations []string
			hf := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				require.Equal(t, "/api/models/"+repoID+"/tree/main", r.URL.Path)
				authorizations = append(authorizations, r.Header.Get("Authorization"))
				if len(authorizations) == 1 {
					w.WriteHeader(http.StatusUnauthorized)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				require.NoError(t, json.NewEncoder(w).Encode([]huggingFaceTreeNode{
					{Path: "config.json", Type: "file", Size: 2},
				}))
			}))
			defer hf.Close()

			s := &Server{
				configPath: filepath.Join(t.TempDir(), "local-inference.json"),
				hfBaseURL:  hf.URL,
				httpClient: hf.Client(),
			}
			s.SetHuggingFaceTokenSource(func(context.Context) string { return tt.connectorToken })
			invalidations := 0
			s.SetHuggingFaceTokenInvalidator(func(context.Context) error {
				invalidations++
				return nil
			})

			files, err := s.fetchMatchingFiles(context.Background(), repoID)

			require.NoError(t, err)
			require.Len(t, files, 1)
			assert.Equal(t, "config.json", files[0].Path)
			assert.Equal(t, []string{tt.wantAuthorization, ""}, authorizations)
			assert.Equal(t, tt.wantInvalidations, invalidations)
		})
	}
}

func TestDownloadFileRetriesAnonymouslyAfterRejectedAuth(t *testing.T) {
	tests := []struct {
		name              string
		envToken          string
		connectorToken    string
		wantAuthorization string
		wantInvalidations int
	}{
		{
			name:              "connector token is invalidated",
			connectorToken:    "rejected-connector-token",
			wantAuthorization: "Bearer rejected-connector-token",
			wantInvalidations: 1,
		},
		{
			name:              "environment token does not invalidate connector",
			envToken:          "rejected-env-token",
			connectorToken:    "unused-connector-token",
			wantAuthorization: "Bearer rejected-env-token",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv(huggingFaceTokenEnv, tt.envToken)
			t.Setenv(huggingFaceTokenAltEnv, "")
			const repoID = "mlx-community/Recovered-4bit"
			const content = "weights"
			var authorizations []string
			hf := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				require.Equal(t, "/"+repoID+"/resolve/main/model.safetensors", r.URL.Path)
				authorizations = append(authorizations, r.Header.Get("Authorization"))
				if len(authorizations) == 1 {
					w.WriteHeader(http.StatusForbidden)
					return
				}
				_, _ = w.Write([]byte(content))
			}))
			defer hf.Close()

			dir := t.TempDir()
			s := &Server{
				configPath: filepath.Join(t.TempDir(), "local-inference.json"),
				hfBaseURL:  hf.URL,
				httpClient: hf.Client(),
			}
			s.SetHuggingFaceTokenSource(func(context.Context) string { return tt.connectorToken })
			invalidations := 0
			s.SetHuggingFaceTokenInvalidator(func(context.Context) error {
				invalidations++
				return nil
			})

			destination := filepath.Join(dir, "model.safetensors")
			job := &downloadJob{modelID: repoID, done: make(chan struct{})}
			file := huggingFaceFile{Path: "model.safetensors", Size: int64(len(content))}

			err := s.downloadFile(context.Background(), repoID, file, destination, 0, file.Size, job)

			require.NoError(t, err)
			data, readErr := os.ReadFile(destination)
			require.NoError(t, readErr)
			assert.Equal(t, content, string(data))
			assert.Equal(t, []string{tt.wantAuthorization, ""}, authorizations)
			assert.Equal(t, tt.wantInvalidations, invalidations)
		})
	}
}

func TestSetHuggingFaceAuthPrefersEnvOverTokenSource(t *testing.T) {
	t.Setenv(huggingFaceTokenEnv, "env-token")
	t.Setenv(huggingFaceTokenAltEnv, "")

	s := &Server{configPath: filepath.Join(t.TempDir(), "local-inference.json")}
	s.SetHuggingFaceTokenSource(func(context.Context) string { return "connector-token" })

	req, err := http.NewRequest(http.MethodGet, "https://huggingface.co/api/models", nil)
	require.NoError(t, err)
	authSource := s.setHuggingFaceAuth(context.Background(), req)
	require.Equal(t, "Bearer env-token", req.Header.Get("Authorization"))
	require.Equal(t, huggingFaceAuthEnvironment, authSource)
}

func TestSetHuggingFaceAuthFallsBackToTokenSource(t *testing.T) {
	t.Setenv(huggingFaceTokenEnv, "")
	t.Setenv(huggingFaceTokenAltEnv, "")

	s := &Server{configPath: filepath.Join(t.TempDir(), "local-inference.json")}
	s.SetHuggingFaceTokenSource(func(context.Context) string { return "connector-token" })

	req, err := http.NewRequest(http.MethodGet, "https://huggingface.co/api/models", nil)
	require.NoError(t, err)
	authSource := s.setHuggingFaceAuth(context.Background(), req)
	require.Equal(t, "Bearer connector-token", req.Header.Get("Authorization"))
	require.Equal(t, huggingFaceAuthConnector, authSource)
}

func TestSetHuggingFaceAuthNoTokenLeavesHeaderUnset(t *testing.T) {
	t.Setenv(huggingFaceTokenEnv, "")
	t.Setenv(huggingFaceTokenAltEnv, "")

	s := &Server{configPath: filepath.Join(t.TempDir(), "local-inference.json")}

	req, err := http.NewRequest(http.MethodGet, "https://huggingface.co/api/models", nil)
	require.NoError(t, err)
	authSource := s.setHuggingFaceAuth(context.Background(), req)
	require.Empty(t, req.Header.Get("Authorization"))
	require.Equal(t, huggingFaceAuthNone, authSource)
}

func TestFetchMatchingFilesGatedModelError(t *testing.T) {
	hf := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "Access to model google/gemma-3-4b-it is restricted.", http.StatusForbidden)
	}))
	defer hf.Close()

	s := &Server{
		configPath: filepath.Join(t.TempDir(), "local-inference.json"),
		hfBaseURL:  hf.URL,
		httpClient: hf.Client(),
	}

	_, err := s.fetchMatchingFiles(context.Background(), "google/gemma-3-4b-it")
	require.Error(t, err)
	require.EqualError(t, err, "model requires ToS acceptance")
}

func TestDownloadModelRetriesFailedGatedDownloadAfterAuth(t *testing.T) {
	dir := t.TempDir()
	const repoID = "mlx-community/Gated-4bit"
	var treeRequests atomic.Int32
	hf := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/models/" + repoID:
			require.NoError(t, json.NewEncoder(w).Encode(huggingFaceSearchResult{
				ID:      repoID,
				ModelID: repoID,
				Author:  "mlx-community",
				Tags:    []string{"mlx"},
			}))
		case "/api/models/" + repoID + "/tree/main":
			treeRequests.Add(1)
			if r.Header.Get("Authorization") != "Bearer accepted-token" {
				http.Error(w, "terms required", http.StatusForbidden)
				return
			}
			require.NoError(t, json.NewEncoder(w).Encode([]huggingFaceTreeNode{
				{Path: "config.json", Type: "file", Size: 2},
				{Path: "tokenizer.json", Type: "file", Size: 2},
				{Path: "model.safetensors", Type: "file", Size: 2},
			}))
		case "/" + repoID + "/resolve/main/config.json",
			"/" + repoID + "/resolve/main/tokenizer.json",
			"/" + repoID + "/resolve/main/model.safetensors":
			require.Equal(t, "Bearer accepted-token", r.Header.Get("Authorization"))
			_, _ = w.Write([]byte("{}"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer hf.Close()

	s := &Server{
		configPath: filepath.Join(t.TempDir(), "local-inference.json"),
		hfBaseURL:  hf.URL,
		httpClient: hf.Client(),
	}
	t.Setenv(modelsDirEnv, dir)

	_, err := s.DownloadModel(
		context.Background(),
		&methods.LocalInferenceDownloadModelParams{ModelID: repoID},
		nil,
	)
	require.NoError(t, err)
	require.Eventually(t, func() bool {
		state, stateErr := s.state(context.Background())
		if stateErr != nil || len(state.Downloads) == 0 {
			return false
		}
		return state.Downloads[0].Status == methods.LocalInferenceDownloadFailed &&
			state.Downloads[0].ErrorCode == methods.LocalInferenceDownloadErrorCodeToSRequired
	}, time.Second, 10*time.Millisecond)

	s.SetHuggingFaceTokenSource(func(context.Context) string { return "accepted-token" })
	_, err = s.DownloadModel(
		context.Background(),
		&methods.LocalInferenceDownloadModelParams{ModelID: repoID},
		nil,
	)
	require.NoError(t, err)
	require.Eventually(t, func() bool {
		state, stateErr := s.state(context.Background())
		if stateErr != nil {
			return false
		}
		for _, model := range state.Catalog {
			if (model.ID == repoID || model.RepoID == repoID) && model.Downloaded {
				return true
			}
		}
		return false
	}, time.Second, 10*time.Millisecond)
	require.Equal(t, int32(2), treeRequests.Load())
}

func TestDownloadModelResumesPausedDownload(t *testing.T) {
	dir := t.TempDir()
	const repoID = "mlx-community/Resumable-4bit"
	const weights = "helloworld"

	var safetensorsRequests atomic.Int32
	firstWeightsRequest := make(chan struct{})
	hf := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/models/" + repoID:
			w.Header().Set("Content-Type", "application/json")
			require.NoError(t, json.NewEncoder(w).Encode(huggingFaceSearchResult{
				ID:      repoID,
				ModelID: repoID,
				Author:  "mlx-community",
				Tags:    []string{"mlx"},
			}))
		case "/api/models/" + repoID + "/tree/main":
			w.Header().Set("Content-Type", "application/json")
			require.NoError(t, json.NewEncoder(w).Encode([]huggingFaceTreeNode{
				{Path: "config.json", Type: "file", Size: 2},
				{Path: "tokenizer.json", Type: "file", Size: 2},
				{Path: "model.safetensors", Type: "file", Size: int64(len(weights))},
			}))
		case "/" + repoID + "/resolve/main/config.json",
			"/" + repoID + "/resolve/main/tokenizer.json":
			_, _ = w.Write([]byte("{}"))
		case "/" + repoID + "/resolve/main/model.safetensors":
			if safetensorsRequests.Add(1) == 1 {
				w.Header().Set("ETag", `"weights-v1"`)
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte(weights[:5]))
				w.(http.Flusher).Flush()
				close(firstWeightsRequest)
				<-r.Context().Done()
				return
			}
			require.Equal(t, "bytes=5-", r.Header.Get("Range"))
			require.Equal(t, `"weights-v1"`, r.Header.Get("If-Range"))
			w.Header().Set("ETag", `"weights-v1"`)
			w.Header().Set("Content-Range", fmt.Sprintf("bytes 5-%d/%d", len(weights)-1, len(weights)))
			w.WriteHeader(http.StatusPartialContent)
			_, _ = w.Write([]byte(weights[5:]))
		default:
			http.NotFound(w, r)
		}
	}))
	defer hf.Close()

	s := &Server{
		configPath: filepath.Join(t.TempDir(), "local-inference.json"),
		hfBaseURL:  hf.URL,
		httpClient: hf.Client(),
	}
	t.Setenv(modelsDirEnv, dir)

	_, err := s.DownloadModel(
		context.Background(),
		&methods.LocalInferenceDownloadModelParams{ModelID: repoID},
		nil,
	)
	require.NoError(t, err)

	modelDir := filepath.Join(dir, "mlx-community", "Resumable-4bit")
	partPath := filepath.Join(modelDir, "model.safetensors"+partFileSuffix)
	<-firstWeightsRequest
	require.Eventually(t, func() bool {
		return existingFileSize(partPath) == 5
	}, 2*time.Second, 5*time.Millisecond)

	// The state returned by CancelDownload must already report the download
	// as cancelled: clients apply this response as authoritative state, so a
	// still-downloading status here would make the pause button appear to
	// need a second press.
	state, err := s.CancelDownload(
		context.Background(),
		&methods.LocalInferenceCancelDownloadParams{ModelID: repoID},
		nil,
	)
	require.NoError(t, err)
	require.Len(t, state.Downloads, 1)
	assert.Equal(t, methods.LocalInferenceDownloadCancelled, state.Downloads[0].Status)
	partial, err := os.ReadFile(partPath)
	require.NoError(t, err)
	assert.Equal(t, weights[:5], string(partial))

	_, err = s.DownloadModel(
		context.Background(),
		&methods.LocalInferenceDownloadModelParams{ModelID: repoID},
		nil,
	)
	require.NoError(t, err)
	require.Eventually(t, func() bool {
		if fileExists(filepath.Join(modelDir, downloadMarkerFilename)) {
			return false
		}
		data, readErr := os.ReadFile(filepath.Join(modelDir, "model.safetensors"))
		return readErr == nil && string(data) == weights
	}, 2*time.Second, 10*time.Millisecond)
	assert.NoFileExists(t, partPath)
	assert.NoFileExists(t, filepath.Join(modelDir, "model.safetensors"+partETagSuffix))
	assert.Equal(t, int32(2), safetensorsRequests.Load())
}

func TestDownloadFileKeepsPartialFileOnCancel(t *testing.T) {
	const repoID = "mlx-community/Paused-4bit"
	const content = "helloworld"
	sentPartial := make(chan struct{})
	hf := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/"+repoID+"/resolve/main/model.safetensors", r.URL.Path)
		w.Header().Set("ETag", `"weights-v1"`)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(content[:5]))
		w.(http.Flusher).Flush()
		close(sentPartial)
		<-r.Context().Done()
	}))
	defer hf.Close()

	dir := t.TempDir()
	t.Setenv(modelsDirEnv, dir)
	s := &Server{
		configPath: filepath.Join(t.TempDir(), "local-inference.json"),
		hfBaseURL:  hf.URL,
		httpClient: hf.Client(),
	}
	destination := filepath.Join(dir, "model.safetensors")
	job := &downloadJob{modelID: repoID, done: make(chan struct{})}
	file := huggingFaceFile{Path: "model.safetensors", Size: int64(len(content))}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	errCh := make(chan error, 1)
	go func() {
		errCh <- s.downloadFile(ctx, repoID, file, destination, 0, file.Size, job)
	}()

	<-sentPartial
	require.Eventually(t, func() bool {
		return existingFileSize(destination+partFileSuffix) == 5
	}, 2*time.Second, 5*time.Millisecond)
	cancel()
	require.ErrorIs(t, <-errCh, context.Canceled)

	partial, err := os.ReadFile(destination + partFileSuffix)
	require.NoError(t, err)
	assert.Equal(t, content[:5], string(partial))
	etag, err := os.ReadFile(destination + partETagSuffix)
	require.NoError(t, err)
	assert.Equal(t, `"weights-v1"`, strings.TrimSpace(string(etag)))
}

func TestDownloadFileResumesFromPartialFile(t *testing.T) {
	const repoID = "mlx-community/Resume-4bit"
	const content = "helloworld"
	var requests atomic.Int32
	hf := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		require.Equal(t, "bytes=5-", r.Header.Get("Range"))
		require.Equal(t, `"weights-v1"`, r.Header.Get("If-Range"))
		w.Header().Set("ETag", `"weights-v1"`)
		w.Header().Set("Content-Range", fmt.Sprintf("bytes 5-%d/%d", len(content)-1, len(content)))
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write([]byte(content[5:]))
	}))
	defer hf.Close()

	dir := t.TempDir()
	t.Setenv(modelsDirEnv, dir)
	s := &Server{
		configPath: filepath.Join(t.TempDir(), "local-inference.json"),
		hfBaseURL:  hf.URL,
		httpClient: hf.Client(),
	}
	destination := filepath.Join(dir, "model.safetensors")
	require.NoError(t, os.WriteFile(destination+partFileSuffix, []byte(content[:5]), 0o644))
	require.NoError(t, os.WriteFile(destination+partETagSuffix, []byte("\"weights-v1\"\n"), 0o644))
	job := &downloadJob{modelID: repoID, done: make(chan struct{})}
	file := huggingFaceFile{Path: "model.safetensors", Size: int64(len(content))}

	require.NoError(t, s.downloadFile(context.Background(), repoID, file, destination, 0, file.Size, job))

	data, err := os.ReadFile(destination)
	require.NoError(t, err)
	assert.Equal(t, content, string(data))
	assert.NoFileExists(t, destination+partFileSuffix)
	assert.NoFileExists(t, destination+partETagSuffix)
	assert.Equal(t, int32(1), requests.Load())
}

func TestDownloadFileRestartsWhenRemoteContentChanged(t *testing.T) {
	const repoID = "mlx-community/Changed-4bit"
	const content = "HELLOWORLD"
	hf := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The remote file changed since the partial bytes were fetched, so the
		// If-Range validator no longer matches and the server sends the full
		// representation with a 200.
		require.Equal(t, "bytes=5-", r.Header.Get("Range"))
		require.Equal(t, `"weights-v1"`, r.Header.Get("If-Range"))
		w.Header().Set("ETag", `"weights-v2"`)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(content))
	}))
	defer hf.Close()

	dir := t.TempDir()
	t.Setenv(modelsDirEnv, dir)
	s := &Server{
		configPath: filepath.Join(t.TempDir(), "local-inference.json"),
		hfBaseURL:  hf.URL,
		httpClient: hf.Client(),
	}
	destination := filepath.Join(dir, "model.safetensors")
	require.NoError(t, os.WriteFile(destination+partFileSuffix, []byte("hello"), 0o644))
	require.NoError(t, os.WriteFile(destination+partETagSuffix, []byte("\"weights-v1\"\n"), 0o644))
	job := &downloadJob{modelID: repoID, done: make(chan struct{})}
	file := huggingFaceFile{Path: "model.safetensors", Size: int64(len(content))}

	require.NoError(t, s.downloadFile(context.Background(), repoID, file, destination, 0, file.Size, job))

	data, err := os.ReadFile(destination)
	require.NoError(t, err)
	assert.Equal(t, content, string(data))
	assert.NoFileExists(t, destination+partFileSuffix)
	assert.NoFileExists(t, destination+partETagSuffix)
}

func TestDownloadFileRetriesFromScratchOnUnsatisfiableRange(t *testing.T) {
	const repoID = "mlx-community/Unsatisfiable-4bit"
	const content = "helloworld"
	var requests atomic.Int32
	hf := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.Header.Get("Range") != "" {
			http.Error(w, "range not satisfiable", http.StatusRequestedRangeNotSatisfiable)
			return
		}
		w.Header().Set("ETag", `"weights-v1"`)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(content))
	}))
	defer hf.Close()

	dir := t.TempDir()
	t.Setenv(modelsDirEnv, dir)
	s := &Server{
		configPath: filepath.Join(t.TempDir(), "local-inference.json"),
		hfBaseURL:  hf.URL,
		httpClient: hf.Client(),
	}
	destination := filepath.Join(dir, "model.safetensors")
	require.NoError(t, os.WriteFile(destination+partFileSuffix, []byte("hello"), 0o644))
	require.NoError(t, os.WriteFile(destination+partETagSuffix, []byte("\"weights-v1\"\n"), 0o644))
	job := &downloadJob{modelID: repoID, done: make(chan struct{})}
	file := huggingFaceFile{Path: "model.safetensors", Size: int64(len(content))}

	require.NoError(t, s.downloadFile(context.Background(), repoID, file, destination, 0, file.Size, job))

	data, err := os.ReadFile(destination)
	require.NoError(t, err)
	assert.Equal(t, content, string(data))
	assert.NoFileExists(t, destination+partFileSuffix)
	assert.Equal(t, int32(2), requests.Load())
}

func TestResumableDownloadOffset(t *testing.T) {
	dir := t.TempDir()
	destination := filepath.Join(dir, "model.safetensors")

	offset, etag := resumableDownloadOffset(destination, 10)
	assert.Zero(t, offset)
	assert.Empty(t, etag)

	require.NoError(t, os.WriteFile(destination+partFileSuffix, []byte("hello"), 0o644))
	offset, etag = resumableDownloadOffset(destination, 10)
	assert.Zero(t, offset, "partial file without a recorded validator is not resumable")
	assert.Empty(t, etag)

	require.NoError(t, os.WriteFile(destination+partETagSuffix, []byte("\"v1\"\n"), 0o644))
	offset, etag = resumableDownloadOffset(destination, 10)
	assert.Equal(t, int64(5), offset)
	assert.Equal(t, `"v1"`, etag)

	offset, etag = resumableDownloadOffset(destination, 5)
	assert.Zero(t, offset, "partial file at or beyond the expected size is not resumable")
	assert.Empty(t, etag)
}

func TestStoreDownloadValidatorIgnoresWeakETags(t *testing.T) {
	dir := t.TempDir()
	etagPath := filepath.Join(dir, "model.safetensors"+partETagSuffix)
	require.NoError(t, os.WriteFile(etagPath, []byte("\"stale\"\n"), 0o644))

	resp := &http.Response{Header: http.Header{"Etag": []string{`W/"weak"`}}}
	storeDownloadValidator(etagPath, resp)
	assert.NoFileExists(t, etagPath)

	resp = &http.Response{Header: http.Header{"Etag": []string{`"strong"`}}}
	storeDownloadValidator(etagPath, resp)
	stored, err := os.ReadFile(etagPath)
	require.NoError(t, err)
	assert.Equal(t, `"strong"`, strings.TrimSpace(string(stored)))
}

func TestEstimateRunFitConfidenceThresholds(t *testing.T) {
	model := methods.LocalInferenceModel{
		ParameterSize: "7B",
		Quantization:  "4-bit",
		ContextWindow: 32768,
	}

	high := estimateRunFit(model, machineProfile{Supported: true, OS: "darwin", Arch: "arm64", MemoryBytes: 16 * 1024 * 1024 * 1024}, nil)
	require.Equal(t, methods.LocalInferenceRunConfidenceHigh, high.Confidence)
	require.Positive(t, high.EstimatedMemoryBytes)
	require.Positive(t, high.WeightBytes)
	require.Positive(t, high.KVCacheBytes)
	require.NotEmpty(t, high.Details)

	medium := estimateRunFit(model, machineProfile{Supported: true, OS: "darwin", Arch: "arm64", MemoryBytes: 8 * 1024 * 1024 * 1024}, nil)
	require.Equal(t, methods.LocalInferenceRunConfidenceMedium, medium.Confidence)

	low := estimateRunFit(model, machineProfile{Supported: true, OS: "darwin", Arch: "arm64", MemoryBytes: 6 * 1024 * 1024 * 1024}, nil)
	require.Equal(t, methods.LocalInferenceRunConfidenceLow, low.Confidence)
}

func TestEstimateRunFitReportsUnsupportedMachine(t *testing.T) {
	estimate := estimateRunFit(methods.LocalInferenceModel{
		ParameterSize: "7B",
		Quantization:  "4-bit",
		ContextWindow: 32768,
	}, machineProfile{Supported: false, OS: "linux", Arch: "amd64", MemoryBytes: 64 * 1024 * 1024 * 1024}, nil)

	require.Equal(t, methods.LocalInferenceRunConfidenceLow, estimate.Confidence)
	require.Contains(t, estimate.Summary, "Apple Silicon")
	require.NotEmpty(t, estimate.Details)
}

func TestDownloadProgressMetricsExcludesAlreadyDownloadedBytes(t *testing.T) {
	startedAt := time.Unix(100, 0)
	job := &downloadJob{
		progressStartedAt:    startedAt,
		progressStartedBytes: 1_000,
	}

	speed, eta := downloadProgressMetrics(job, 3_000, 7_000, startedAt.Add(2*time.Second))
	require.Equal(t, int64(1_000), speed)
	require.Equal(t, int64(4), eta)
}

func TestDefaultModelsDirectoryUsesCamberConfigDirectory(t *testing.T) {
	configHome := t.TempDir()
	t.Setenv(modelsDirEnv, "")
	t.Setenv("OSU_MODELS_DIR", "")
	t.Setenv("XDG_CONFIG_HOME", configHome)

	require.Equal(t, filepath.Join(configHome, "poolside", "models"), defaultModelsDirectory())
}

func TestDefaultModelsDirectoryHonorsEnvironmentOverride(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(modelsDirEnv, dir)
	t.Setenv("OSU_MODELS_DIR", filepath.Join(t.TempDir(), "legacy"))

	require.Equal(t, dir, defaultModelsDirectory())
}

func TestNotifyStateBestEffortUsesRememberedClient(t *testing.T) {
	s := &Server{configPath: filepath.Join(t.TempDir(), "local-inference.json")}
	t.Setenv(modelsDirEnv, t.TempDir())

	var notifications []methods.LocalInferenceDidChangeParams
	gCtx := &glsp.Context{
		Notify: func(ctx context.Context, method string, params any) error {
			require.NoError(t, ctx.Err())
			require.Equal(t, methods.LocalInferenceDidChangeMethod, method)
			change, ok := params.(methods.LocalInferenceDidChangeParams)
			require.True(t, ok)
			notifications = append(notifications, change)
			return nil
		},
	}

	cancelledCtx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := s.notifyState(cancelledCtx, gCtx)
	require.NoError(t, err)
	require.Len(t, notifications, 1)

	notifications = nil
	s.notifyStateBestEffort()
	require.Len(t, notifications, 1)
	require.NotEmpty(t, notifications[0].State.Catalog)
}

func TestDestinationPathRejectsUnsafeRemotePaths(t *testing.T) {
	dir := t.TempDir()
	for _, remotePath := range []string{
		"../config.json",
		"weights/../config.json",
		"/absolute/config.json",
		`windows\path`,
		"empty//segment",
	} {
		_, err := destinationPath(dir, remotePath)
		require.Error(t, err, remotePath)
	}

	destination, err := destinationPath(dir, "nested/model.safetensors")
	require.NoError(t, err)
	require.Equal(t, filepath.Join(dir, "nested", "model.safetensors"), destination)
}

func TestMatchesDownloadFilePattern(t *testing.T) {
	require.True(t, matchesDownloadFilePattern("config.json"))
	require.True(t, matchesDownloadFilePattern("tokenizer.model"))
	require.True(t, matchesDownloadFilePattern("model-00001-of-00002.safetensors"))
	require.True(t, matchesDownloadFilePattern("model.safetensors.index.json"))
	require.False(t, matchesDownloadFilePattern("README.md"))
	require.False(t, matchesDownloadFilePattern(".gitattributes"))
}

func TestFirstExecutablePathSkipsPlaceholders(t *testing.T) {
	dir := t.TempDir()
	placeholder := filepath.Join(dir, "camber-mlx-sidecar")
	realBinary := filepath.Join(dir, "camber-mlx-sidecar-aarch64-apple-darwin")
	require.NoError(t, os.WriteFile(placeholder, nil, 0o755))
	require.NoError(t, os.WriteFile(realBinary, []byte("binary"), 0o755))

	require.Equal(t, realBinary, firstExecutablePath([]string{placeholder, realBinary}))
}

func TestDevelopmentSidecarCandidatesFindSwiftPMProduct(t *testing.T) {
	root := t.TempDir()
	cwd := filepath.Join(root, "ui", "apps", "vscode-assistant")
	sidecar := filepath.Join(
		root,
		"cmd",
		"camber-mlx-sidecar",
		".build",
		"arm64-apple-macosx",
		"release",
		"camber-mlx-sidecar",
	)
	require.NoError(t, os.MkdirAll(filepath.Dir(sidecar), 0o755))
	require.NoError(t, os.MkdirAll(cwd, 0o755))
	require.NoError(t, os.WriteFile(sidecar, []byte("binary"), 0o755))

	require.Equal(t, sidecar, firstExecutablePath(developmentSidecarCandidates(cwd)))
}

func TestDevelopmentDesktopSidecarCandidatesFindDownloadedBinary(t *testing.T) {
	root := t.TempDir()
	cwd := filepath.Join(root, "ui", "apps", "desktop-assistant")
	sidecar := filepath.Join(
		root,
		"ui",
		"apps",
		"desktop-assistant",
		"src-tauri",
		"binaries",
		"camber-mlx-sidecar-aarch64-apple-darwin",
	)
	require.NoError(t, os.MkdirAll(filepath.Dir(sidecar), 0o755))
	require.NoError(t, os.MkdirAll(cwd, 0o755))
	require.NoError(t, os.WriteFile(sidecar, []byte("binary"), 0o755))

	require.Equal(t, sidecar, firstExecutablePath(developmentDesktopSidecarCandidates(cwd)))
}

func TestDevelopmentSidecarLauncherCandidatesFindDevRunScript(t *testing.T) {
	root := t.TempDir()
	cwd := filepath.Join(root, "ui", "apps", "vscode-assistant")
	devRun := filepath.Join(root, "cmd", "camber-mlx-sidecar", sidecarDevRunScript)
	require.NoError(t, os.MkdirAll(filepath.Dir(devRun), 0o755))
	require.NoError(t, os.MkdirAll(cwd, 0o755))
	require.NoError(t, os.WriteFile(devRun, []byte("#!/usr/bin/env bash\n"), 0o755))

	require.Equal(t, devRun, firstExecutablePath(developmentSidecarLauncherCandidates(cwd)))
}

func TestSidecarExecutablePathSkipsDevelopmentBuildWhenDisabled(t *testing.T) {
	root := t.TempDir()
	cwd := filepath.Join(root, "ui", "apps", "desktop-assistant")
	devRun := filepath.Join(root, "cmd", "camber-mlx-sidecar", sidecarDevRunScript)
	require.NoError(t, os.MkdirAll(filepath.Dir(devRun), 0o755))
	require.NoError(t, os.MkdirAll(cwd, 0o755))
	require.NoError(t, os.WriteFile(devRun, []byte("#!/usr/bin/env bash\n"), 0o755))

	t.Chdir(cwd)
	t.Setenv("PATH", "")
	t.Setenv(sidecarPathEnv, "")
	t.Setenv(sidecarDisableDevBuildEnv, "1")

	_, ok := sidecarExecutablePath()
	require.False(t, ok)
}

func TestSwiftBuildProductInfo(t *testing.T) {
	packageDir := filepath.Join(t.TempDir(), "cmd", "camber-mlx-sidecar")

	parsedPackageDir, triple, configuration, ok := swiftBuildProductInfo(filepath.Join(
		packageDir,
		".build",
		"arm64-apple-macosx",
		"release",
		"camber-mlx-sidecar",
	))
	require.True(t, ok)
	require.Equal(t, packageDir, parsedPackageDir)
	require.Equal(t, "arm64-apple-macosx", triple)
	require.Equal(t, "release", configuration)

	parsedPackageDir, triple, configuration, ok = swiftBuildProductInfo(filepath.Join(
		packageDir,
		".build",
		"debug",
		"camber-mlx-sidecar",
	))
	require.True(t, ok)
	require.Equal(t, packageDir, parsedPackageDir)
	require.Empty(t, triple)
	require.Equal(t, "debug", configuration)
}

func TestFirstSidecarMetallibDirRequiresDefaultLibrary(t *testing.T) {
	// mlx.metallib alone is not enough: the sidecar's Metal loader only ever
	// reads default.metallib, and the app bundle ships just that file.
	primaryOnly := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(primaryOnly, sidecarMetallibPrimary), []byte("metal"), 0o644))

	defaultOnly := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(defaultOnly, sidecarMetallibDefault), []byte("metal"), 0o644))

	require.Equal(t, defaultOnly, firstSidecarMetallibDir([]string{primaryOnly, defaultOnly}))
}

func findModel(t *testing.T, models []methods.LocalInferenceModel, id string) methods.LocalInferenceModel {
	t.Helper()
	for _, model := range models {
		if model.ID == id || model.RepoID == id {
			return model
		}
	}
	require.Failf(t, "missing model", "expected model %q in catalog", id)
	return methods.LocalInferenceModel{}
}

type recordingWriteCloser struct {
	closed bool
}

func (w *recordingWriteCloser) Write(p []byte) (int, error) {
	return len(p), nil
}

func (w *recordingWriteCloser) Close() error {
	w.closed = true
	return nil
}

// A sidecar that prints a single line larger than the drain's buffer (MLXPress
// emits >64KB one-line load diagnostics) must still have its output consumed
// to EOF: if the drain stops early, pipe backpressure wedges the sidecar
// mid-write and model loading hangs forever.
func TestDrainSidecarOutputConsumesOverlongLines(t *testing.T) {
	longLine := strings.Repeat("x", 200*1024)
	input := strings.NewReader("before\n" + longLine + "\nafter\n")

	done := make(chan struct{})
	go func() {
		defer close(done)
		drainSidecarOutput("stdout", input)
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		require.Fail(t, "drainSidecarOutput did not finish draining")
	}
	assert.Zero(t, input.Len(), "sidecar output must be fully consumed")
}

func TestAgentServerReadyKeepsBusySidecarOnProbeTimeout(t *testing.T) {
	release := make(chan struct{})
	httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		<-release
		w.WriteHeader(http.StatusOK)
	}))
	defer httpServer.Close()
	defer close(release)
	s := &Server{
		configPath:   filepath.Join(t.TempDir(), "local-inference.json"),
		probeTimeout: 50 * time.Millisecond,
		sidecar: &managedSidecar{
			baseURL: httpServer.URL,
			apiKey:  "secret",
			done:    make(chan error),
		},
	}

	ready, err := s.AgentServerReady(context.Background(), methods.LocalAgentServerName)

	require.NoError(t, err)
	assert.True(t, ready, "busy sidecar must be treated as ready, not killed")
	assert.NotNil(t, s.sidecar)
}

func TestDefaultModelIDIgnoresStalePersistedDefault(t *testing.T) {
	s := &Server{configPath: filepath.Join(t.TempDir(), "local-inference.json")}
	t.Setenv(modelsDirEnv, t.TempDir())
	require.NoError(t, s.saveConfig(configFile{DefaultModelID: "mlx-community/Laguna-XS.2-mxfp4"}))

	state, err := s.state(context.Background())
	require.NoError(t, err)
	assert.Equal(t, defaultModelID, state.Runtime.DefaultModelID,
		"a persisted default that is neither in the catalog nor installed must fall back")
}

func TestDefaultModelIDKeepsInstalledPersistedDefault(t *testing.T) {
	dir := t.TempDir()
	modelDir := filepath.Join(dir, "custom", "Repo-4bit")
	require.NoError(t, os.MkdirAll(modelDir, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(modelDir, "config.json"), []byte("{}"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(modelDir, "tokenizer.json"), []byte("{}"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(modelDir, "model.safetensors"), []byte("weights"), 0o644))
	require.NoError(t, writeInstalledModelManifest(modelDir, methods.LocalInferenceModel{
		ID:     "custom/Repo-4bit",
		RepoID: "custom/Repo-4bit",
	}))

	s := &Server{configPath: filepath.Join(t.TempDir(), "local-inference.json")}
	t.Setenv(modelsDirEnv, dir)
	require.NoError(t, s.saveConfig(configFile{DefaultModelID: "custom/Repo-4bit"}))

	state, err := s.state(context.Background())
	require.NoError(t, err)
	assert.Equal(t, "custom/Repo-4bit", state.Runtime.DefaultModelID)
}

func TestUnloadModelReleasesSidecarModel(t *testing.T) {
	unloadCalls := 0
	loaded := "poolside/Laguna-XS-2.1-NVFP4-mlx"
	httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "Bearer secret", r.Header.Get("Authorization"))
		switch r.URL.Path {
		case "/admin/unload":
			require.Equal(t, http.MethodPost, r.Method)
			unloadCalls++
			loaded = ""
			_, _ = w.Write([]byte(`{"unloaded":true}`))
		case "/health":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"loadedModel":            loaded,
				"idleSeconds":            12,
				"idleUnloadAfterSeconds": 900,
				"memoryBytes":            int64(20 << 30),
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer httpServer.Close()
	sidecar := &managedSidecar{
		baseURL: httpServer.URL,
		apiKey:  "secret",
		done:    make(chan error),
	}
	s := &Server{
		configPath: filepath.Join(t.TempDir(), "local-inference.json"),
		sidecar:    sidecar,
	}
	t.Setenv(modelsDirEnv, t.TempDir())

	state, err := s.UnloadModel(context.Background(), nil, nil)
	require.NoError(t, err)
	assert.Equal(t, 1, unloadCalls)
	assert.Empty(t, state.Runtime.LoadedModelID)
	assert.Equal(t, 900, state.Runtime.IdleUnloadSeconds)
}

func TestRuntimeStateIncludesResidency(t *testing.T) {
	sidecar := &managedSidecar{
		baseURL: "http://127.0.0.1:1",
		done:    make(chan error),
		residency: &sidecarResidency{
			loadedModelID:     "poolside/Laguna-XS-2.1-NVFP4-mlx",
			memoryBytes:       20 << 30,
			lastActivity:      time.Now().Add(-90 * time.Second),
			idleUnloadSeconds: 900,
		},
	}
	s := &Server{
		configPath: filepath.Join(t.TempDir(), "local-inference.json"),
		sidecar:    sidecar,
	}
	t.Setenv(modelsDirEnv, t.TempDir())

	state, err := s.state(context.Background())
	require.NoError(t, err)
	require.Equal(t, methods.LocalInferenceRuntimeRunning, state.Runtime.Status)
	assert.Equal(t, "poolside/Laguna-XS-2.1-NVFP4-mlx", state.Runtime.LoadedModelID)
	assert.Equal(t, int64(20<<30), state.Runtime.LoadedMemoryBytes)
	assert.Equal(t, 900, state.Runtime.IdleUnloadSeconds)
	assert.InDelta(t, time.Now().Add(-90*time.Second).UnixMilli(), state.Runtime.LastActivityUnixMs, 2000)
}

func TestResidencyChanged(t *testing.T) {
	base := &sidecarResidency{
		loadedModelID: "a/b",
		memoryBytes:   20 << 30,
		lastActivity:  time.Now(),
	}
	assert.True(t, residencyChanged(nil, base), "first observation of a loaded model notifies")
	assert.False(t, residencyChanged(nil, &sidecarResidency{}), "first observation of an idle sidecar stays quiet")
	assert.False(t, residencyChanged(base, &sidecarResidency{
		loadedModelID: "a/b",
		memoryBytes:   base.memoryBytes + 1024,
		lastActivity:  base.lastActivity.Add(time.Second),
	}), "jitter-scale movement stays quiet")
	assert.True(t, residencyChanged(base, &sidecarResidency{
		loadedModelID: "",
		memoryBytes:   100 << 20,
		lastActivity:  base.lastActivity,
	}), "unload notifies")
	assert.True(t, residencyChanged(base, &sidecarResidency{
		loadedModelID: "a/b",
		memoryBytes:   base.memoryBytes,
		lastActivity:  base.lastActivity.Add(30 * time.Second),
	}), "new activity notifies")
}

func TestShutdownSidecarMarksExpectedExit(t *testing.T) {
	sidecar := &managedSidecar{
		stdin: &recordingWriteCloser{},
		done:  make(chan error),
	}

	require.NoError(t, shutdownSidecar(sidecar))

	assert.True(t, sidecar.expectedExit.Load(),
		"helper-initiated shutdowns must not look like crashes to waitSidecar")
}

func TestUnexpectedSidecarExitError(t *testing.T) {
	exitErr := errors.New("exit status 1")
	assert.ErrorIs(t, unexpectedSidecarExitError(false, exitErr), exitErr)
	assert.EqualError(t, unexpectedSidecarExitError(false, nil),
		"local MLX sidecar exited unexpectedly with status 0")
	assert.NoError(t, unexpectedSidecarExitError(true, nil),
		"helper-initiated shutdowns must not be reported")
}

func TestAllowRespawnRateLimits(t *testing.T) {
	s := &Server{}
	start := time.Now()

	for i := 0; i < sidecarRespawnLimit; i++ {
		assert.True(t, s.allowRespawn(start.Add(time.Duration(i)*time.Second)), "respawn %d", i)
	}
	assert.False(t, s.allowRespawn(start.Add(10*time.Second)),
		"respawns beyond the limit inside the window are refused")
	assert.True(t, s.allowRespawn(start.Add(sidecarRespawnWindow+11*time.Second)),
		"the window expiring frees up respawns again")
}

// Integration: kill the real sidecar binary and verify the helper respawns it
// on the same port with the same API key, so a running agent's baked env
// stays valid. Skips when the dev sidecar build is absent.
func TestSidecarRespawnsAfterUnexpectedExit(t *testing.T) {
	if runtime.GOOS != "darwin" || runtime.GOARCH != "arm64" {
		t.Skip("local MLX sidecar requires Apple Silicon")
	}
	binary, err := filepath.Abs(filepath.Join("..", "..", "..", "..", "..",
		"cmd", "camber-mlx-sidecar", ".build", "dev-run", "camber-mlx-sidecar"))
	require.NoError(t, err)
	if !executableFileExists(binary) {
		t.Skipf("dev sidecar binary not built at %s", binary)
	}
	t.Setenv(sidecarPathEnv, binary)
	t.Setenv(modelsDirEnv, t.TempDir())
	s := &Server{configPath: filepath.Join(t.TempDir(), "local-inference.json")}
	defer func() { require.NoError(t, s.Close()) }()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	sidecar, err := s.ensureSidecar(ctx, configFile{})
	require.NoError(t, err)

	require.NoError(t, sidecar.cmd.Process.Kill())

	require.Eventually(t, func() bool {
		s.mu.Lock()
		current := s.sidecar
		s.mu.Unlock()
		if current == nil || current == sidecar || !current.running() {
			return false
		}
		probeCtx, probeCancel := context.WithTimeout(context.Background(), time.Second)
		defer probeCancel()
		return probeSidecar(probeCtx, current.baseURL, current.apiKey) == nil
	}, 20*time.Second, 200*time.Millisecond, "killed sidecar was not respawned")

	s.mu.Lock()
	replacement := s.sidecar
	s.mu.Unlock()
	require.NotNil(t, replacement)
	assert.Equal(t, sidecar.port, replacement.port,
		"the respawn must reuse the port baked into the running agent's env")
	assert.Equal(t, sidecar.apiKey, replacement.apiKey,
		"the respawn must reuse the API key baked into the running agent's env")
}
