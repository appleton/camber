package voiceinput

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"regexp"
	"strings"
)

// decodeAudio accepts raw base64 or a data URI and returns the audio bytes.
func decodeAudio(audio string) ([]byte, error) {
	payload := strings.TrimSpace(audio)
	if payload == "" {
		return nil, errors.New("voice input: audio payload is empty")
	}
	if strings.HasPrefix(payload, "data:") {
		_, encoded, ok := strings.Cut(payload, ",")
		if !ok {
			return nil, errors.New("voice input: malformed audio data URI")
		}
		payload = encoded
	}
	decoded, err := base64.StdEncoding.DecodeString(payload)
	if err != nil {
		return nil, fmt.Errorf("voice input: decoding audio: %w", err)
	}
	if len(decoded) == 0 {
		return nil, errors.New("voice input: audio payload is empty")
	}
	if len(decoded) > maxAudioBytes {
		return nil, fmt.Errorf("voice input: audio payload exceeds %d bytes", maxAudioBytes)
	}
	return decoded, nil
}

// transcribeRequest posts audio to a whisper-server /inference endpoint and
// returns the transcribed text.
func transcribeRequest(ctx context.Context, client *http.Client, baseURL string, audio []byte, language string) (string, error) {
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	file, err := form.CreateFormFile("file", "audio.wav")
	if err != nil {
		return "", err
	}
	if _, err := file.Write(audio); err != nil {
		return "", err
	}
	fields := map[string]string{
		"response_format": "json",
		"temperature":     "0.0",
		"language":        strings.TrimSpace(language),
	}
	if fields["language"] == "" {
		fields["language"] = "auto"
	}
	for key, value := range fields {
		if err := form.WriteField(key, value); err != nil {
			return "", err
		}
	}
	if err := form.Close(); err != nil {
		return "", err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+inferencePath, &body)
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", form.FormDataContentType())
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("voice input: transcription request: %w", err)
	}
	defer resp.Body.Close()

	payload, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return "", fmt.Errorf("voice input: reading transcription response: %w", err)
	}
	var parsed struct {
		Text  string `json:"text"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal(payload, &parsed); err != nil {
		if resp.StatusCode < 200 || resp.StatusCode > 299 {
			return "", fmt.Errorf("voice input: transcription failed with status %d", resp.StatusCode)
		}
		return "", fmt.Errorf("voice input: parsing transcription response: %w", err)
	}
	if parsed.Error != "" {
		return "", fmt.Errorf("voice input: transcription failed: %s", parsed.Error)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return "", fmt.Errorf("voice input: transcription failed with status %d", resp.StatusCode)
	}
	return normalizeTranscript(parsed.Text), nil
}

// noiseAnnotationPattern matches whisper's non-speech annotations such as
// [BLANK_AUDIO], [MUSIC], (door slams), or ♪ so silence and background noise
// never turn into prompt text.
var noiseAnnotationPattern = regexp.MustCompile(`\[[^\]]*\]|\([^)]*\)|♪`)

// normalizeTranscript strips whisper's noise annotations and collapses
// per-segment line breaks and padding into a single prompt-friendly line.
func normalizeTranscript(text string) string {
	text = noiseAnnotationPattern.ReplaceAllString(text, " ")
	return strings.Join(strings.Fields(text), " ")
}
