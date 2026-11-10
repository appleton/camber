package localinference

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

var downloadFilePatterns = []string{
	"config.json",
	"tokenizer.json",
	"tokenizer.model",
	"tokenizer_config.json",
	"special_tokens_map.json",
	"generation_config.json",
	"chat_template.jinja",
	"preprocessor_config.json",
	"processor_config.json",
	"vocab.json",
	"merges.txt",
	"added_tokens.json",
	"model.safetensors.index.json",
	"*.safetensors",
}

type downloadJob struct {
	modelID              string
	cancel               context.CancelFunc
	done                 chan struct{}
	progressStartedAt    time.Time
	progressStartedBytes int64
}

func (p *downloadJob) running() bool {
	select {
	case <-p.done:
		return false
	default:
		return true
	}
}

func (s *Server) ensureDownloadMapsLocked() {
	if s.downloadJobs == nil {
		s.downloadJobs = make(map[string]*downloadJob)
	}
	if s.downloadStates == nil {
		s.downloadStates = make(map[string]*methods.LocalInferenceDownloadState)
	}
}

func (s *Server) downloadJobForModelLocked(model methods.LocalInferenceModel) *downloadJob {
	for _, job := range s.downloadJobs {
		if job == nil {
			continue
		}
		if job.modelID == model.ID || job.modelID == model.RepoID {
			return job
		}
	}
	return nil
}

func (s *Server) downloadStateSnapshots() []methods.LocalInferenceDownloadState {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.downloadStates) == 0 {
		return nil
	}
	downloads := make([]methods.LocalInferenceDownloadState, 0, len(s.downloadStates))
	for _, state := range s.downloadStates {
		if state == nil {
			continue
		}
		downloads = append(downloads, *state)
	}
	sort.Slice(downloads, func(i, j int) bool {
		leftRank := downloadStatusRank(downloads[i].Status)
		rightRank := downloadStatusRank(downloads[j].Status)
		if leftRank != rightRank {
			return leftRank < rightRank
		}
		return downloads[i].ModelID < downloads[j].ModelID
	})
	return downloads
}

func downloadStatusRank(status methods.LocalInferenceDownloadStatus) int {
	switch status {
	case methods.LocalInferenceDownloadResolving, methods.LocalInferenceDownloadDownloading:
		return 0
	case methods.LocalInferenceDownloadCancelled, methods.LocalInferenceDownloadFailed:
		return 1
	case methods.LocalInferenceDownloadCompleted:
		return 2
	default:
		return 3
	}
}

func (s *Server) runDownload(ctx context.Context, job *downloadJob, model methods.LocalInferenceModel, modelsDir string) {
	defer close(job.done)

	modelDir := modelDirectory(modelsDir, model.RepoID)
	markerPath := filepath.Join(modelDir, downloadMarkerFilename)
	if err := s.downloadModelFiles(ctx, job, model, modelDir, markerPath); err != nil {
		status := methods.LocalInferenceDownloadFailed
		if errors.Is(err, context.Canceled) {
			status = methods.LocalInferenceDownloadCancelled
		}
		s.updateDownloadState(job, func(state *methods.LocalInferenceDownloadState) {
			state.Status = status
			state.CurrentFile = ""
			state.Error = ""
			state.ErrorCode = ""
			if status == methods.LocalInferenceDownloadFailed {
				state.Error = err.Error()
				if errors.Is(err, errGatedModel) {
					state.ErrorCode = methods.LocalInferenceDownloadErrorCodeToSRequired
				}
			}
		})
		s.notifyStateBestEffort()
		return
	}

	if err := writeInstalledModelManifest(modelDir, model); err != nil {
		s.updateDownloadState(job, func(state *methods.LocalInferenceDownloadState) {
			state.Status = methods.LocalInferenceDownloadFailed
			state.CurrentFile = ""
			state.Error = err.Error()
			state.ErrorCode = ""
		})
		s.notifyStateBestEffort()
		return
	}
	_ = os.Remove(markerPath)
	s.invalidateDirectorySizes()
	s.updateDownloadState(job, func(state *methods.LocalInferenceDownloadState) {
		state.Status = methods.LocalInferenceDownloadCompleted
		state.CurrentFile = ""
		state.Error = ""
		state.ErrorCode = ""
		state.BytesDownloaded = state.BytesTotal
		state.FilesCompleted = state.FilesTotal
		state.EtaSeconds = 0
	})
	s.notifyStateBestEffort()
}

func (s *Server) downloadModelFiles(ctx context.Context, job *downloadJob, model methods.LocalInferenceModel, modelDir, markerPath string) error {
	if err := os.MkdirAll(modelDir, 0o755); err != nil {
		return fmt.Errorf("creating model directory: %w", err)
	}
	if err := os.WriteFile(markerPath, []byte(time.Now().Format(time.RFC3339Nano)+"\n"), 0o644); err != nil {
		return fmt.Errorf("creating download marker: %w", err)
	}

	s.updateDownloadState(job, func(state *methods.LocalInferenceDownloadState) {
		state.Status = methods.LocalInferenceDownloadResolving
		state.CurrentFile = "Resolving Hugging Face files"
		state.Error = ""
		state.ErrorCode = ""
	})
	s.notifyStateBestEffort()

	files, err := s.fetchMatchingFiles(ctx, model.RepoID)
	if err != nil {
		return err
	}
	if len(files) == 0 {
		return fmt.Errorf("no MLX model files found for %q", model.RepoID)
	}

	type downloadTarget struct {
		file        huggingFaceFile
		destination string
		// retained is the number of bytes expected to be reused from a
		// partial download of this file. It is an estimate for progress
		// display; downloadFile makes the authoritative resume decision.
		retained int64
	}
	targets := make([]downloadTarget, 0, len(files))
	var totalBytes int64
	var completedBytes int64
	var completedFiles int
	var retainedBytes int64
	for _, file := range files {
		totalBytes += file.Size
		destination, err := destinationPath(modelDir, file.Path)
		if err != nil {
			return err
		}
		if existingFileSize(destination) == file.Size {
			completedBytes += file.Size
			completedFiles++
			continue
		}
		retained, _ := resumableDownloadOffset(destination, file.Size)
		retainedBytes += retained
		targets = append(targets, downloadTarget{file: file, destination: destination, retained: retained})
	}

	now := time.Now()
	job.progressStartedAt = now
	job.progressStartedBytes = completedBytes + retainedBytes
	s.updateDownloadState(job, func(state *methods.LocalInferenceDownloadState) {
		state.Status = methods.LocalInferenceDownloadDownloading
		state.FilesTotal = len(files)
		state.FilesCompleted = completedFiles
		setDownloadProgressMetrics(state, job, completedBytes+retainedBytes, totalBytes, now)
		state.CurrentFile = ""
		state.Error = ""
		state.ErrorCode = ""
	})
	s.notifyStateBestEffort()

	for _, target := range targets {
		if err := ctx.Err(); err != nil {
			return err
		}
		s.updateDownloadState(job, func(state *methods.LocalInferenceDownloadState) {
			state.CurrentFile = target.file.Path
		})
		s.notifyStateBestEffort()

		if err := os.MkdirAll(filepath.Dir(target.destination), 0o755); err != nil {
			return fmt.Errorf("creating model subdirectory: %w", err)
		}
		otherRetained := retainedBytes - target.retained
		if err := s.downloadFile(ctx, model.RepoID, target.file, target.destination, completedBytes+otherRetained, totalBytes, job); err != nil {
			return err
		}
		completedBytes += target.file.Size
		completedFiles++
		retainedBytes = otherRetained
		now := time.Now()
		s.updateDownloadState(job, func(state *methods.LocalInferenceDownloadState) {
			state.FilesCompleted = completedFiles
			setDownloadProgressMetrics(state, job, completedBytes+retainedBytes, totalBytes, now)
		})
	}
	return nil
}

func (s *Server) updateDownloadState(job *downloadJob, update func(*methods.LocalInferenceDownloadState)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	state := s.downloadStates[job.modelID]
	if s.downloadJobs[job.modelID] != job || state == nil {
		return
	}
	update(state)
}

func setDownloadProgressMetrics(state *methods.LocalInferenceDownloadState, job *downloadJob, bytesDownloaded, bytesTotal int64, now time.Time) {
	state.BytesDownloaded = bytesDownloaded
	state.BytesTotal = bytesTotal
	state.BytesPerSecond, state.EtaSeconds = downloadProgressMetrics(job, bytesDownloaded, bytesTotal, now)
}

func downloadProgressMetrics(job *downloadJob, bytesDownloaded, bytesTotal int64, now time.Time) (int64, int64) {
	if job == nil || job.progressStartedAt.IsZero() {
		return 0, 0
	}
	transferred := bytesDownloaded - job.progressStartedBytes
	if transferred <= 0 {
		return 0, 0
	}
	elapsed := now.Sub(job.progressStartedAt).Seconds()
	if elapsed <= 0 {
		return 0, 0
	}
	bytesPerSecond := int64(float64(transferred) / elapsed)
	if bytesPerSecond <= 0 {
		return 0, 0
	}
	remaining := bytesTotal - bytesDownloaded
	if remaining <= 0 {
		return bytesPerSecond, 0
	}
	return bytesPerSecond, int64(math.Ceil(float64(remaining) / float64(bytesPerSecond)))
}

func (s *Server) resolveDownloadModel(ctx context.Context, modelID, modelsDir string) (methods.LocalInferenceModel, error) {
	if model, ok := catalogModel(modelID); ok {
		return model, nil
	}
	if model, ok := s.installedModelByID(modelsDir, modelID); ok {
		return model, nil
	}
	repoID, ok := normalizeHuggingFaceRepoID(modelID)
	if !ok {
		return methods.LocalInferenceModel{}, fmt.Errorf("local inference model %q is not a valid Hugging Face repo id", modelID)
	}
	model, err := s.fetchHuggingFaceModel(ctx, repoID, modelsDir, "")
	if err != nil {
		return methods.LocalInferenceModel{}, err
	}
	return model, nil
}

func (s *Server) downloadFile(ctx context.Context, repoID string, file huggingFaceFile, destination string, completedBefore, totalBytes int64, job *downloadJob) error {
	downloadURL, err := s.huggingFaceURL("/" + repoID + "/resolve/main/" + file.Path)
	if err != nil {
		return err
	}
	partPath := destination + partFileSuffix
	etagPath := destination + partETagSuffix
	resumeFrom, resumeETag := resumableDownloadOffset(destination, file.Size)

	resp, resumedFrom, err := s.openFileDownload(ctx, downloadURL.String(), resumeFrom, resumeETag)
	if err != nil {
		return fmt.Errorf("downloading %s: %w", file.Path, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return gatedModelError(repoID, resp.StatusCode)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return fmt.Errorf("downloading %s failed: HTTP %d", file.Path, resp.StatusCode)
	}
	if resumedFrom == 0 {
		// Fresh download: remember this response's validator so a paused
		// download can resume. On a 206 the previously recorded validator
		// already matches the partial bytes; keep it.
		storeDownloadValidator(etagPath, resp)
	}

	flags := os.O_CREATE | os.O_WRONLY
	if resumedFrom > 0 {
		flags |= os.O_APPEND
	} else {
		flags |= os.O_TRUNC
	}
	out, err := os.OpenFile(partPath, flags, 0o644)
	if err != nil {
		return fmt.Errorf("creating %s: %w", partPath, err)
	}
	// The partial file is kept on cancellation and transient failures so a
	// later download attempt can resume from where this one stopped.
	defer func() {
		_ = out.Close()
	}()

	buffer := make([]byte, 1024*1024)
	written := resumedFrom
	lastNotify := time.Now()
	for {
		n, readErr := resp.Body.Read(buffer)
		if n > 0 {
			if _, err := out.Write(buffer[:n]); err != nil {
				return fmt.Errorf("writing %s: %w", file.Path, err)
			}
			written += int64(n)
			if time.Since(lastNotify) >= downloadProgressInterval || written == file.Size {
				lastNotify = time.Now()
				now := lastNotify
				s.updateDownloadState(job, func(state *methods.LocalInferenceDownloadState) {
					setDownloadProgressMetrics(state, job, completedBefore+written, totalBytes, now)
					state.CurrentFile = file.Path
				})
				s.notifyStateBestEffort()
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				break
			}
			return fmt.Errorf("reading %s: %w", file.Path, readErr)
		}
		if err := ctx.Err(); err != nil {
			return err
		}
	}
	if err := out.Close(); err != nil {
		return fmt.Errorf("closing %s: %w", file.Path, err)
	}
	if written != file.Size {
		_ = os.Remove(partPath)
		_ = os.Remove(etagPath)
		return fmt.Errorf("downloaded %s size mismatch: expected %d, got %d", file.Path, file.Size, written)
	}
	if err := os.Rename(partPath, destination); err != nil {
		return fmt.Errorf("installing %s: %w", file.Path, err)
	}
	_ = os.Remove(etagPath)
	return nil
}

// openFileDownload issues the download request, attempting an HTTP range
// request when a resumable partial file exists. It returns the response and
// the byte offset the response continues from (0 when the whole file is being
// sent, e.g. because the range was ignored or the remote content changed).
func (s *Server) openFileDownload(ctx context.Context, rawURL string, resumeFrom int64, resumeETag string) (*http.Response, int64, error) {
	if resumeFrom > 0 && resumeETag != "" {
		resp, err := s.requestFileDownload(ctx, rawURL, resumeFrom, resumeETag)
		if err != nil {
			return nil, 0, err
		}
		switch resp.StatusCode {
		case http.StatusPartialContent:
			return resp, resumeFrom, nil
		case http.StatusRequestedRangeNotSatisfiable:
			// Stale or oversized partial file; retry from scratch.
			_ = resp.Body.Close()
		default:
			// 200 (range ignored or If-Range validator mismatch) and error
			// statuses are handled by the caller as a fresh download.
			return resp, 0, nil
		}
	}
	resp, err := s.requestFileDownload(ctx, rawURL, 0, "")
	return resp, 0, err
}

func (s *Server) requestFileDownload(ctx context.Context, rawURL string, resumeFrom int64, resumeETag string) (*http.Response, error) {
	request := func(authenticated bool) (*http.Request, huggingFaceAuthSource, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
		if err != nil {
			return nil, huggingFaceAuthNone, err
		}
		if resumeFrom > 0 && resumeETag != "" {
			req.Header.Set("Range", fmt.Sprintf("bytes=%d-", resumeFrom))
			req.Header.Set("If-Range", resumeETag)
		}
		if !authenticated {
			return req, huggingFaceAuthNone, nil
		}
		return req, s.setHuggingFaceAuth(ctx, req), nil
	}

	req, authSource, err := request(true)
	if err != nil {
		return nil, err
	}
	resp, err := s.http().Do(req)
	if err != nil {
		return nil, err
	}
	if (resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden) && authSource != huggingFaceAuthNone {
		_ = resp.Body.Close()
		if authSource == huggingFaceAuthConnector {
			s.invalidateHuggingFaceConnectorToken(ctx)
		}
		req, _, err = request(false)
		if err != nil {
			return nil, err
		}
		resp, err = s.http().Do(req)
		if err != nil {
			return nil, err
		}
	}
	return resp, nil
}

// resumableDownloadOffset reports how many bytes of a partial download can be
// reused for the given destination, along with the strong ETag validator
// recorded when those bytes were fetched. It returns 0 and an empty string
// when the download must start from scratch.
func resumableDownloadOffset(destination string, fileSize int64) (int64, string) {
	partSize := existingFileSize(destination + partFileSuffix)
	if partSize <= 0 || partSize >= fileSize {
		return 0, ""
	}
	etag, err := os.ReadFile(destination + partETagSuffix)
	if err != nil {
		return 0, ""
	}
	validator := strings.TrimSpace(string(etag))
	if validator == "" {
		return 0, ""
	}
	return partSize, validator
}

// storeDownloadValidator records the response's strong ETag next to the
// partial file so a future attempt can resume with If-Range. Weak validators
// cannot be used with If-Range (RFC 9110), so they disable resumption.
func storeDownloadValidator(etagPath string, resp *http.Response) {
	etag := strings.TrimSpace(resp.Header.Get("ETag"))
	if etag == "" || strings.HasPrefix(etag, "W/") {
		_ = os.Remove(etagPath)
		return
	}
	_ = os.WriteFile(etagPath, []byte(etag+"\n"), 0o644)
}

func matchesDownloadFilePattern(name string) bool {
	for _, pattern := range downloadFilePatterns {
		if ok, err := filepath.Match(pattern, name); err == nil && ok {
			return true
		}
	}
	return false
}
