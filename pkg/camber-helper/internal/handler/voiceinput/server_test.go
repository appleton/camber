package voiceinput

import (
	"context"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

func newTestServer(t *testing.T) *Server {
	t.Helper()
	dir := t.TempDir()
	t.Setenv(modelsDirEnv, filepath.Join(dir, "models"))
	t.Setenv(whisperServerPathEnv, "")
	t.Setenv(modelEnv, "")
	// Keep PATH lookups deterministic even on machines with whisper-cpp
	// installed, and move off the source checkout so the development
	// binaries-directory walk finds nothing.
	t.Setenv("PATH", dir)
	t.Chdir(dir)
	return &Server{
		configPath: filepath.Join(dir, configFilename),
		httpClient: &http.Client{},
	}
}

func writeFakeWhisperServer(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "whisper-server")
	require.NoError(t, os.WriteFile(path, []byte("#!/bin/sh\n"), 0o755))
	return path
}

func installFakeModel(t *testing.T, modelID string) {
	t.Helper()
	modelsDir := defaultModelsDirectory()
	require.NoError(t, os.MkdirAll(modelsDir, 0o755))
	require.NoError(t, os.WriteFile(modelPath(modelsDir, modelID), []byte("ggml"), 0o644))
}

func TestStateUnavailableWithoutBinary(t *testing.T) {
	s := newTestServer(t)

	state, err := s.GetState(context.Background(), &methods.VoiceInputGetStateParams{}, nil)
	require.NoError(t, err)

	assert.False(t, state.Supported)
	assert.False(t, state.Ready)
	assert.Equal(t, methods.VoiceInputRuntimeUnavailable, state.Runtime)
	assert.Equal(t, whisperServerMissingReason, state.UnavailableReason)
	assert.Equal(t, defaultModelID, state.SelectedModelID)
	require.Len(t, state.Models, len(catalog))
	for _, model := range state.Models {
		assert.False(t, model.Downloaded, "model %s should not be downloaded", model.ID)
	}
}

func TestStateReadyWithBinaryAndModel(t *testing.T) {
	s := newTestServer(t)
	t.Setenv(whisperServerPathEnv, writeFakeWhisperServer(t))
	installFakeModel(t, defaultModelID)

	state, err := s.GetState(context.Background(), &methods.VoiceInputGetStateParams{}, nil)
	require.NoError(t, err)

	assert.True(t, state.Supported)
	assert.True(t, state.Ready)
	assert.Equal(t, methods.VoiceInputRuntimeStopped, state.Runtime)
	var base methods.VoiceInputModel
	for _, model := range state.Models {
		if model.ID == defaultModelID {
			base = model
		}
	}
	assert.True(t, base.Downloaded)
	assert.True(t, base.Selected)
	assert.NotEmpty(t, base.LocalPath)
}

func TestSetModelPersistsSelection(t *testing.T) {
	s := newTestServer(t)

	state, err := s.SetModel(context.Background(), &methods.VoiceInputSetModelParams{ModelID: "small"}, nil)
	require.NoError(t, err)
	assert.Equal(t, "small", state.SelectedModelID)

	reloaded, err := s.GetState(context.Background(), &methods.VoiceInputGetStateParams{}, nil)
	require.NoError(t, err)
	assert.Equal(t, "small", reloaded.SelectedModelID)
}

func TestSetModelRejectsUnknown(t *testing.T) {
	s := newTestServer(t)

	_, err := s.SetModel(context.Background(), &methods.VoiceInputSetModelParams{ModelID: "gpt-5"}, nil)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "not known")
}

func TestDownloadModelInstallsFile(t *testing.T) {
	payload := strings.Repeat("whisper-weights", 1024)
	fileServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/ggerganov/whisper.cpp/resolve/"+modelRepoRevision+"/ggml-tiny.bin", r.URL.Path)
		_, _ = io.WriteString(w, payload)
	}))
	defer fileServer.Close()

	s := newTestServer(t)
	t.Setenv(modelBaseURLEnv, fileServer.URL)

	state, err := s.DownloadModel(context.Background(), &methods.VoiceInputDownloadModelParams{ModelID: "tiny"}, nil)
	require.NoError(t, err)
	require.NotNil(t, state.Download)
	assert.Equal(t, "tiny", state.Download.ModelID)

	s.mu.Lock()
	job := s.downloadJob
	s.mu.Unlock()
	require.NotNil(t, job)
	select {
	case <-job.done:
	case <-time.After(10 * time.Second):
		t.Fatal("download did not finish")
	}

	final, err := s.GetState(context.Background(), &methods.VoiceInputGetStateParams{}, nil)
	require.NoError(t, err)
	require.NotNil(t, final.Download)
	assert.Equal(t, methods.VoiceInputDownloadCompleted, final.Download.Status)
	assert.Equal(t, int64(len(payload)), final.Download.BytesDownloaded)

	data, err := os.ReadFile(modelPath(defaultModelsDirectory(), "tiny"))
	require.NoError(t, err)
	assert.Equal(t, payload, string(data))
}

func TestDownloadModelReportsFailure(t *testing.T) {
	fileServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", http.StatusForbidden)
	}))
	defer fileServer.Close()

	s := newTestServer(t)
	t.Setenv(modelBaseURLEnv, fileServer.URL)

	_, err := s.DownloadModel(context.Background(), &methods.VoiceInputDownloadModelParams{ModelID: "tiny"}, nil)
	require.NoError(t, err)

	s.mu.Lock()
	job := s.downloadJob
	s.mu.Unlock()
	require.NotNil(t, job)
	<-job.done

	state, err := s.GetState(context.Background(), &methods.VoiceInputGetStateParams{}, nil)
	require.NoError(t, err)
	require.NotNil(t, state.Download)
	assert.Equal(t, methods.VoiceInputDownloadFailed, state.Download.Status)
	assert.Contains(t, state.Download.Error, "status 403")
	assert.NoFileExists(t, modelPath(defaultModelsDirectory(), "tiny")+partFileSuffix)
}

func TestTranscribeRequiresDownloadedModel(t *testing.T) {
	s := newTestServer(t)
	t.Setenv(whisperServerPathEnv, writeFakeWhisperServer(t))

	audio := base64.StdEncoding.EncodeToString([]byte("RIFFdata"))
	_, err := s.Transcribe(context.Background(), &methods.VoiceInputTranscribeParams{Audio: audio}, nil)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "not downloaded")
}

func TestDecodeAudio(t *testing.T) {
	raw := []byte("RIFF fake wav bytes")
	encoded := base64.StdEncoding.EncodeToString(raw)

	decoded, err := decodeAudio(encoded)
	require.NoError(t, err)
	assert.Equal(t, raw, decoded)

	decoded, err = decodeAudio("data:audio/wav;base64," + encoded)
	require.NoError(t, err)
	assert.Equal(t, raw, decoded)

	_, err = decodeAudio("")
	assert.Error(t, err)

	_, err = decodeAudio("not-base64!!!")
	assert.Error(t, err)
}

func TestTranscribeRequestParsesResponse(t *testing.T) {
	whisper := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, inferencePath, r.URL.Path)
		require.NoError(t, r.ParseMultipartForm(1<<20))
		assert.Equal(t, "json", r.FormValue("response_format"))
		assert.Equal(t, "auto", r.FormValue("language"))
		file, _, err := r.FormFile("file")
		require.NoError(t, err)
		defer file.Close()
		contents, err := io.ReadAll(file)
		require.NoError(t, err)
		assert.Equal(t, "RIFFaudio", string(contents))
		_, _ = io.WriteString(w, `{"text":" Hello there.\n General Kenobi. "}`)
	}))
	defer whisper.Close()

	text, err := transcribeRequest(context.Background(), whisper.Client(), whisper.URL, []byte("RIFFaudio"), "")
	require.NoError(t, err)
	assert.Equal(t, "Hello there. General Kenobi.", text)
}

func TestTranscribeRequestSurfacesServerError(t *testing.T) {
	whisper := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = io.WriteString(w, `{"error":"failed to decode audio"}`)
	}))
	defer whisper.Close()

	_, err := transcribeRequest(context.Background(), whisper.Client(), whisper.URL, []byte("junk"), "en")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "failed to decode audio")
}

func TestNormalizeTranscript(t *testing.T) {
	assert.Equal(t, "one two three", normalizeTranscript("  one\n two\n\tthree \n"))
	assert.Equal(t, "", normalizeTranscript("   \n "))
	assert.Equal(t, "", normalizeTranscript(" [BLANK_AUDIO]\n"))
	assert.Equal(t, "hello there", normalizeTranscript("[MUSIC] hello (door slams) there ♪"))
}
