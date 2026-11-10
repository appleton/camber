package voiceinput

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

// maxModelDownloadBytes caps a model download when the exact size is not being
// enforced (i.e. against a developer mirror). The largest catalog model is
// ~1.6 GB.
const maxModelDownloadBytes = 4 << 30 // 4 GiB

// modelDownloadClient bounds connection setup and how long the server may sit
// on a request before producing headers, without capping the transfer itself:
// the largest model is 1.6 GB and a slow link is not an error. The shared
// s.httpClient is deliberately left alone -- it also carries transcription
// requests, where a long wait for headers is normal.
func modelDownloadClient() *http.Client {
	return &http.Client{
		Transport: &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			DialContext:           (&net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
			TLSHandshakeTimeout:   15 * time.Second,
			ResponseHeaderTimeout: 60 * time.Second,
			IdleConnTimeout:       90 * time.Second,
			ExpectContinueTimeout: time.Second,
		},
	}
}

// verifyDownload checks a completed download against the catalog before it is
// installed. An unverified model is parsed by native Whisper code, so the
// digest is the difference between "Hugging Face served this" and "somebody on
// the path served this".
func verifyDownload(model catalogEntry, expectedSHA256 string, written int64, actualDigest []byte) error {
	if expectedSHA256 == "" {
		slog.Warn("voice input: model downloaded from mirror without digest verification",
			"model", model.id, "bytes", written)
		return nil
	}
	if written != model.downloadBytes {
		return fmt.Errorf("voice input: %s is %d bytes, expected %d", model.id, written, model.downloadBytes)
	}
	actual := hex.EncodeToString(actualDigest)
	if actual != expectedSHA256 {
		return fmt.Errorf("voice input: %s checksum mismatch: expected %s, got %s",
			model.id, expectedSHA256, actual)
	}
	return nil
}

type downloadJob struct {
	modelID string
	cancel  context.CancelFunc
	done    chan struct{}
}

func (j *downloadJob) running() bool {
	select {
	case <-j.done:
		return false
	default:
		return true
	}
}

// runDownload fetches one ggml model file to modelsDir and records progress in
// downloadState for the client's polling reads. It owns job.done.
func (s *Server) runDownload(ctx context.Context, job *downloadJob, model catalogEntry, modelsDir string) {
	defer close(job.done)
	err := s.downloadModelFile(ctx, job, model, modelsDir)

	s.mu.Lock()
	if state := s.downloadState; state != nil && state.ModelID == model.id {
		state.BytesPerSecond = 0
		state.EtaSeconds = 0
		switch {
		case err == nil:
			state.Status = methods.VoiceInputDownloadCompleted
		case errors.Is(err, context.Canceled):
			state.Status = methods.VoiceInputDownloadCancelled
		default:
			state.Status = methods.VoiceInputDownloadFailed
			state.Error = err.Error()
		}
	}
	s.mu.Unlock()
}

func (s *Server) downloadModelFile(ctx context.Context, job *downloadJob, model catalogEntry, modelsDir string) error {
	if err := os.MkdirAll(modelsDir, 0o755); err != nil {
		return fmt.Errorf("voice input: creating models directory: %w", err)
	}
	target := modelPath(modelsDir, model.id)
	partPath := target + partFileSuffix

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.modelDownloadURL(model.id), nil)
	if err != nil {
		return err
	}
	resp, err := modelDownloadClient().Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return fmt.Errorf("voice input: downloading %s: status %d", model.id, resp.StatusCode)
	}

	// The catalog knows exactly how big each model is, so anything larger is
	// refused rather than allowed to fill the disk. A mirror serves fixture
	// bytes of its own size, so it only gets the blanket cap.
	maxBytes := int64(maxModelDownloadBytes)
	if usingModelMirror() == "" {
		maxBytes = model.downloadBytes
	}
	if resp.ContentLength > maxBytes {
		return fmt.Errorf("voice input: downloading %s: server declared %d bytes, expected at most %d",
			model.id, resp.ContentLength, maxBytes)
	}

	if resp.ContentLength > 0 {
		s.updateDownloadState(model.id, func(state *methods.VoiceInputDownloadState) {
			state.BytesTotal = resp.ContentLength
		})
	}

	out, err := os.Create(partPath)
	if err != nil {
		return fmt.Errorf("voice input: creating %s: %w", partPath, err)
	}
	removePart := func() {
		_ = out.Close()
		_ = os.Remove(partPath)
	}

	var written int64
	started := time.Now()
	lastNotify := started
	// Hash while streaming so verification costs no extra pass over a file
	// that can be 1.6 GB.
	hasher := sha256.New()
	buf := make([]byte, 128<<10)
	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			if written+int64(n) > maxBytes {
				removePart()
				return fmt.Errorf("voice input: downloading %s: response exceeds expected %d bytes",
					model.id, maxBytes)
			}
			if _, writeErr := out.Write(buf[:n]); writeErr != nil {
				removePart()
				return fmt.Errorf("voice input: writing %s: %w", partPath, writeErr)
			}
			_, _ = hasher.Write(buf[:n])
			written += int64(n)
			if now := time.Now(); now.Sub(lastNotify) >= downloadProgressInterval {
				lastNotify = now
				s.reportDownloadProgress(model.id, written, resp.ContentLength, started)
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			removePart()
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return fmt.Errorf("voice input: downloading %s: %w", model.id, readErr)
		}
	}

	// Verify before the file is moved into place, so a mismatched model is
	// never visible as installed and never reaches the Whisper parser.
	if err := verifyDownload(model, s.expectedDigest(model), written, hasher.Sum(nil)); err != nil {
		removePart()
		return err
	}

	if err := out.Close(); err != nil {
		_ = os.Remove(partPath)
		return fmt.Errorf("voice input: closing %s: %w", partPath, err)
	}
	if err := os.Rename(partPath, target); err != nil {
		_ = os.Remove(partPath)
		return fmt.Errorf("voice input: installing %s: %w", filepath.Base(target), err)
	}
	s.updateDownloadState(model.id, func(state *methods.VoiceInputDownloadState) {
		state.BytesDownloaded = written
		if state.BytesTotal == 0 {
			state.BytesTotal = written
		}
	})
	return nil
}

func (s *Server) reportDownloadProgress(modelID string, written, total int64, started time.Time) {
	elapsed := time.Since(started).Seconds()
	var perSecond int64
	if elapsed > 0 {
		perSecond = int64(float64(written) / elapsed)
	}
	var eta int64
	if perSecond > 0 && total > written {
		eta = (total - written) / perSecond
	}
	s.updateDownloadState(modelID, func(state *methods.VoiceInputDownloadState) {
		state.BytesDownloaded = written
		state.BytesPerSecond = perSecond
		state.EtaSeconds = eta
	})
}

func (s *Server) updateDownloadState(modelID string, apply func(*methods.VoiceInputDownloadState)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.downloadState == nil || s.downloadState.ModelID != modelID {
		return
	}
	apply(s.downloadState)
}
