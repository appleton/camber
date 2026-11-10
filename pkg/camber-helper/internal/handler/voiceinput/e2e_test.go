package voiceinput

import (
	"context"
	"encoding/base64"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

// TestEndToEndTranscription drives the real pipeline: downloads the tiny ggml
// model from Hugging Face, spawns whisper-server, and transcribes a WAV file.
// It needs a whisper-server binary, network access, and an audio fixture, so
// it only runs when CAMBER_VOICE_INPUT_E2E_AUDIO points at a 16 kHz mono
// PCM16 WAV (e.g. produced by `say -o f.wav --file-format=WAVE
// --data-format=LEI16@16000 "hello"`).
func TestEndToEndTranscription(t *testing.T) {
	audioPath := os.Getenv("CAMBER_VOICE_INPUT_E2E_AUDIO")
	if audioPath == "" {
		t.Skip("set CAMBER_VOICE_INPUT_E2E_AUDIO to a 16 kHz mono WAV to run")
	}
	if _, ok := whisperServerPath(); !ok {
		t.Skip("whisper-server binary not found")
	}

	dir := t.TempDir()
	t.Setenv(modelsDirEnv, filepath.Join(dir, "models"))
	t.Setenv(modelEnv, "tiny")
	s := &Server{
		configPath: filepath.Join(dir, configFilename),
		httpClient: &http.Client{},
	}
	t.Cleanup(func() { _ = s.Close() })

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	_, err := s.DownloadModel(ctx, &methods.VoiceInputDownloadModelParams{}, nil)
	require.NoError(t, err)
	s.mu.Lock()
	job := s.downloadJob
	s.mu.Unlock()
	require.NotNil(t, job)
	select {
	case <-job.done:
	case <-ctx.Done():
		t.Fatal("model download timed out")
	}
	state, err := s.GetState(ctx, &methods.VoiceInputGetStateParams{}, nil)
	require.NoError(t, err)
	require.NotNil(t, state.Download)
	require.Equal(t, methods.VoiceInputDownloadCompleted, state.Download.Status, state.Download.Error)
	require.True(t, state.Ready)

	audio, err := os.ReadFile(audioPath)
	require.NoError(t, err)

	result, err := s.Transcribe(ctx, &methods.VoiceInputTranscribeParams{
		Audio: base64.StdEncoding.EncodeToString(audio),
	}, nil)
	require.NoError(t, err)

	t.Logf("transcript: %q", result.Text)
	assert.NotEmpty(t, result.Text)
	assert.Contains(t, strings.ToLower(result.Text), "login button")
}
