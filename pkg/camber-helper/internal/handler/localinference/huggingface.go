package localinference

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

type huggingFaceFile struct {
	Path string
	Size int64
}

type huggingFaceTreeNode struct {
	Path string `json:"path"`
	Type string `json:"type"`
	Size int64  `json:"size"`
	LFS  struct {
		Size int64 `json:"size"`
	} `json:"lfs"`
}

type huggingFaceSearchResult struct {
	ID          string   `json:"id"`
	ModelID     string   `json:"modelId"`
	Author      string   `json:"author"`
	PipelineTag string   `json:"pipeline_tag"`
	Tags        []string `json:"tags"`
	Downloads   int      `json:"downloads"`
	Likes       int      `json:"likes"`
	Private     bool     `json:"private"`
	Disabled    bool     `json:"disabled"`
	Gated       any      `json:"gated"`
	Siblings    []struct {
		RFilename string `json:"rfilename"`
		Size      int64  `json:"size"`
		LFS       struct {
			Size int64 `json:"size"`
		} `json:"lfs"`
	} `json:"siblings"`
	Config      map[string]any         `json:"config"`
	Safetensors huggingFaceSafetensors `json:"safetensors"`
}

type huggingFaceSafetensors struct {
	Total      int64            `json:"total"`
	Parameters map[string]int64 `json:"parameters"`
}

type huggingFaceMetadataCacheEntry struct {
	downloadBytes int64
	expiresAt     time.Time
	available     bool
}

type huggingFaceAuthSource uint8

const (
	huggingFaceAuthNone huggingFaceAuthSource = iota
	huggingFaceAuthEnvironment
	huggingFaceAuthConnector
)

func (s *Server) searchHuggingFaceModels(ctx context.Context, query, modelsDir, defaultModel string, downloads []methods.LocalInferenceDownloadState) ([]methods.LocalInferenceModel, error) {
	searchURL, err := s.huggingFaceURL("/api/models")
	if err != nil {
		return nil, err
	}
	params := searchURL.Query()
	params.Set("search", query)
	params.Set("filter", "mlx")
	params.Set("sort", "downloads")
	params.Set("direction", "-1")
	params.Set("limit", "25")
	params.Set("full", "1")
	searchURL.RawQuery = params.Encode()

	request := func(authenticated bool) (*http.Request, huggingFaceAuthSource, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, searchURL.String(), nil)
		if err != nil {
			return nil, huggingFaceAuthNone, err
		}
		req.Header.Set("Accept", "application/json")
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
		return nil, fmt.Errorf("searching Hugging Face models: %w", err)
	}
	if resp.StatusCode == http.StatusUnauthorized && authSource != huggingFaceAuthNone {
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
			return nil, fmt.Errorf("retrying Hugging Face model search without authentication: %w", err)
		}
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, fmt.Errorf("searching Hugging Face models failed: HTTP %d", resp.StatusCode)
	}

	var results []huggingFaceSearchResult
	if err := json.NewDecoder(resp.Body).Decode(&results); err != nil {
		return nil, fmt.Errorf("decoding Hugging Face model search: %w", err)
	}

	models := make([]methods.LocalInferenceModel, 0, len(results))
	seen := make(map[string]bool)
	machine := currentMachineProfile()
	for _, result := range results {
		model, ok := modelFromHuggingFaceResult(result)
		if !ok {
			continue
		}
		if seen[model.RepoID] {
			continue
		}
		seen[model.RepoID] = true
		model.Default = model.ID == defaultModel || model.RepoID == defaultModel
		s.decorateModelDownloadState(&model, modelsDir, downloadStateForModel(downloads, model))
		models = append(models, model)
	}
	s.enrichModelDownloadBytes(ctx, models)
	for i := range models {
		decorateModelRunEstimate(&models[i], machine, models[i].Download)
	}
	return models, nil
}

func (s *Server) fetchHuggingFaceModel(ctx context.Context, repoID, modelsDir, defaultModel string) (methods.LocalInferenceModel, error) {
	modelURL, err := s.huggingFaceURL("/api/models/" + repoID)
	if err != nil {
		return methods.LocalInferenceModel{}, err
	}
	query := modelURL.Query()
	query.Set("full", "1")
	modelURL.RawQuery = query.Encode()

	request := func(authenticated bool) (*http.Request, huggingFaceAuthSource, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, modelURL.String(), nil)
		if err != nil {
			return nil, huggingFaceAuthNone, err
		}
		req.Header.Set("Accept", "application/json")
		if !authenticated {
			return req, huggingFaceAuthNone, nil
		}
		return req, s.setHuggingFaceAuth(ctx, req), nil
	}

	req, authSource, err := request(true)
	if err != nil {
		return methods.LocalInferenceModel{}, err
	}
	resp, err := s.http().Do(req)
	if err != nil {
		return methods.LocalInferenceModel{}, fmt.Errorf("fetching Hugging Face model %q: %w", repoID, err)
	}
	if (resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden) && authSource != huggingFaceAuthNone {
		_ = resp.Body.Close()
		if authSource == huggingFaceAuthConnector {
			s.invalidateHuggingFaceConnectorToken(ctx)
		}
		req, _, err = request(false)
		if err != nil {
			return methods.LocalInferenceModel{}, err
		}
		resp, err = s.http().Do(req)
		if err != nil {
			return methods.LocalInferenceModel{}, fmt.Errorf("retrying Hugging Face model %q without authentication: %w", repoID, err)
		}
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return methods.LocalInferenceModel{}, fmt.Errorf("hugging face model %q was not found", repoID)
	}
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return methods.LocalInferenceModel{}, gatedModelError(repoID, resp.StatusCode)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return methods.LocalInferenceModel{}, fmt.Errorf("fetching Hugging Face model %q failed: HTTP %d", repoID, resp.StatusCode)
	}

	var result huggingFaceSearchResult
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return methods.LocalInferenceModel{}, fmt.Errorf("decoding Hugging Face model %q: %w", repoID, err)
	}
	if result.ID == "" && result.ModelID == "" {
		result.ID = repoID
	}
	model, ok := modelFromHuggingFaceResult(result)
	if !ok {
		return methods.LocalInferenceModel{}, fmt.Errorf("hugging face model %q is private or not a valid model repository", repoID)
	}
	model.Default = model.ID == defaultModel || model.RepoID == defaultModel
	s.decorateModelDownloadState(&model, modelsDir, nil)
	models := []methods.LocalInferenceModel{model}
	s.enrichModelDownloadBytes(ctx, models)
	model = models[0]
	decorateModelRunEstimate(&model, currentMachineProfile(), nil)
	return model, nil
}

func (s *Server) fetchMatchingFiles(ctx context.Context, repoID string) ([]huggingFaceFile, error) {
	treeURL, err := s.huggingFaceURL("/api/models/" + repoID + "/tree/main")
	if err != nil {
		return nil, err
	}
	query := treeURL.Query()
	query.Set("recursive", "1")
	treeURL.RawQuery = query.Encode()

	request := func(authenticated bool) (*http.Request, huggingFaceAuthSource, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, treeURL.String(), nil)
		if err != nil {
			return nil, huggingFaceAuthNone, err
		}
		req.Header.Set("Accept", "application/json")
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
		return nil, fmt.Errorf("listing Hugging Face files: %w", err)
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
			return nil, fmt.Errorf("retrying Hugging Face file listing without authentication: %w", err)
		}
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("hugging face model %q was not found", repoID)
	}
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return nil, gatedModelError(repoID, resp.StatusCode)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, fmt.Errorf("listing Hugging Face files failed: HTTP %d", resp.StatusCode)
	}

	var nodes []huggingFaceTreeNode
	if err := json.NewDecoder(resp.Body).Decode(&nodes); err != nil {
		return nil, fmt.Errorf("decoding Hugging Face file list: %w", err)
	}

	var files []huggingFaceFile
	for _, node := range nodes {
		if node.Type == "directory" {
			continue
		}
		safePath, ok := normalizeRemoteFilePath(node.Path)
		if !ok || !matchesDownloadFilePattern(filepath.Base(safePath)) {
			continue
		}
		size := node.Size
		if size <= 0 {
			size = node.LFS.Size
		}
		if size <= 0 {
			continue
		}
		files = append(files, huggingFaceFile{Path: safePath, Size: size})
	}
	return files, nil
}

// enrichModelDownloadBytesFromCache fills DownloadBytes from previously
// fetched metadata only, without touching the network. The hot notify path
// uses this; GetState and SearchModels populate the cache.
func (s *Server) enrichModelDownloadBytesFromCache(models []methods.LocalInferenceModel) {
	now := time.Now()
	s.metadataMu.Lock()
	defer s.metadataMu.Unlock()
	for i := range models {
		if models[i].DownloadBytes > 0 || models[i].RepoID == "" {
			continue
		}
		repoID, ok := normalizeHuggingFaceRepoID(models[i].RepoID)
		if !ok {
			continue
		}
		if entry, ok := s.metadataCache[repoID]; ok && entry.available && now.Before(entry.expiresAt) {
			models[i].DownloadBytes = entry.downloadBytes
		}
	}
}

func (s *Server) enrichModelDownloadBytes(ctx context.Context, models []methods.LocalInferenceModel) {
	if !s.fetchRemoteMetadata {
		return
	}

	missing := make([]int, 0, len(models))
	for i := range models {
		if models[i].DownloadBytes > 0 || models[i].RepoID == "" {
			continue
		}
		if _, ok := normalizeHuggingFaceRepoID(models[i].RepoID); ok {
			missing = append(missing, i)
		}
	}
	if len(missing) == 0 {
		return
	}

	metadataCtx, cancel := context.WithTimeout(ctx, huggingFaceMetadataTimeout)
	defer cancel()

	type result struct {
		index int
		bytes int64
		ok    bool
	}
	results := make(chan result, len(missing))
	sem := make(chan struct{}, huggingFaceMetadataConcurrency)
	var wg sync.WaitGroup
	for _, index := range missing {
		index := index
		wg.Add(1)
		go func() {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-metadataCtx.Done():
				return
			}

			bytes, ok := s.cachedDownloadBytes(metadataCtx, models[index].RepoID)
			select {
			case results <- result{index: index, bytes: bytes, ok: ok}:
			case <-metadataCtx.Done():
			}
		}()
	}
	wg.Wait()
	close(results)

	for result := range results {
		if result.ok {
			models[result.index].DownloadBytes = result.bytes
		}
	}
}

func (s *Server) cachedDownloadBytes(ctx context.Context, repoID string) (int64, bool) {
	normalizedRepoID, ok := normalizeHuggingFaceRepoID(repoID)
	if !ok {
		return 0, false
	}

	now := time.Now()
	s.metadataMu.Lock()
	if entry, ok := s.metadataCache[normalizedRepoID]; ok && now.Before(entry.expiresAt) {
		s.metadataMu.Unlock()
		return entry.downloadBytes, entry.available
	}
	s.metadataMu.Unlock()

	files, err := s.fetchMatchingFiles(ctx, normalizedRepoID)
	entry := huggingFaceMetadataCacheEntry{
		expiresAt: now.Add(huggingFaceMetadataFailureCacheTTL),
	}
	if err != nil {
		slog.Debug("local inference: failed to fetch Hugging Face model metadata", "repo_id", normalizedRepoID, "error", err)
	} else if totalBytes := totalHuggingFaceFileBytes(files); totalBytes > 0 {
		entry.downloadBytes = totalBytes
		entry.expiresAt = now.Add(huggingFaceMetadataCacheTTL)
		entry.available = true
	}

	s.metadataMu.Lock()
	if s.metadataCache == nil {
		s.metadataCache = make(map[string]huggingFaceMetadataCacheEntry)
	}
	s.metadataCache[normalizedRepoID] = entry
	s.metadataMu.Unlock()

	return entry.downloadBytes, entry.available
}

func totalHuggingFaceFileBytes(files []huggingFaceFile) int64 {
	var total int64
	for _, file := range files {
		total += file.Size
	}
	return total
}

func (s *Server) huggingFaceURL(path string) (*url.URL, error) {
	base := strings.TrimSpace(s.hfBaseURL)
	if base == "" {
		base = strings.TrimSpace(os.Getenv(huggingFaceBaseURLEnv))
	}
	if base == "" {
		base = huggingFaceBaseURL
	}
	parsed, err := url.Parse(base)
	if err != nil {
		return nil, fmt.Errorf("invalid Hugging Face base URL: %w", err)
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/") + path
	return parsed, nil
}

func (s *Server) http() *http.Client {
	if s.httpClient != nil {
		return s.httpClient
	}
	return http.DefaultClient
}

// setHuggingFaceAuth attaches a bearer token to a Hugging Face API request and
// returns where that credential came from, so callers can recover differently
// from rejected user environment variables and rejected connector OAuth.
// Env vars take precedence; otherwise the optional token source (the user's
// Hugging Face MCP connector OAuth token) is consulted. Authenticated requests
// unlock gated models (e.g. official Google Gemma) once the user has accepted
// the model's terms on huggingface.co.
func (s *Server) setHuggingFaceAuth(ctx context.Context, req *http.Request) huggingFaceAuthSource {
	token := strings.TrimSpace(os.Getenv(huggingFaceTokenEnv))
	if token == "" {
		token = strings.TrimSpace(os.Getenv(huggingFaceTokenAltEnv))
	}
	authSource := huggingFaceAuthEnvironment
	if token == "" {
		authSource = huggingFaceAuthNone
		s.mu.Lock()
		tokenSource := s.hfTokenSource
		s.mu.Unlock()
		if tokenSource != nil {
			token = strings.TrimSpace(tokenSource(ctx))
			if token != "" {
				authSource = huggingFaceAuthConnector
			}
		}
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	return authSource
}

func (s *Server) invalidateHuggingFaceConnectorToken(ctx context.Context) {
	s.mu.Lock()
	invalidate := s.hfTokenInvalidator
	s.mu.Unlock()
	if invalidate == nil {
		return
	}
	if err := invalidate(context.WithoutCancel(ctx)); err != nil {
		slog.Warn("local inference: invalidate rejected Hugging Face connector token", "error", err)
	}
}

func modelFromHuggingFaceResult(result huggingFaceSearchResult) (methods.LocalInferenceModel, bool) {
	repoID, ok := normalizeHuggingFaceRepoID(firstNonEmpty(result.ModelID, result.ID))
	if !ok || result.Private {
		return methods.LocalInferenceModel{}, false
	}
	provider := result.Author
	if provider == "" {
		provider = strings.Split(repoID, "/")[0]
	}
	tags := compactSearchTags(result.Tags)
	name := humanModelName(filepath.Base(repoID))
	return methods.LocalInferenceModel{
		ID:            repoID,
		RepoID:        repoID,
		Name:          name,
		Provider:      provider,
		Source:        "Hugging Face",
		SourceURL:     huggingFaceModelURL(repoID),
		AvatarURL:     huggingFaceAvatarURL(repoID),
		Family:        inferModelFamily(result.Config, tags, name),
		Quantization:  inferQuantization(repoID, tags),
		ParameterSize: inferParameterSize(repoID, name, result),
		ContextWindow: inferContextWindow(result.Config),
		DownloadBytes: inferDownloadBytes(result),
		Tags:          tags,
		Gated:         huggingFaceGated(result.Gated),
		Private:       result.Private,
		Disabled:      result.Disabled,
	}, true
}

func huggingFaceGated(value any) bool {
	switch typed := value.(type) {
	case nil:
		return false
	case bool:
		return typed
	case string:
		normalized := strings.ToLower(strings.TrimSpace(typed))
		return normalized != "" && normalized != "false" && normalized != "none"
	default:
		return true
	}
}

func huggingFaceModelURL(repoID string) string {
	owner, name, ok := strings.Cut(repoID, "/")
	if !ok || owner == "" || name == "" {
		return ""
	}
	return "https://huggingface.co/" + url.PathEscape(owner) + "/" + url.PathEscape(name)
}

func huggingFaceAvatarURL(repoID string) string {
	owner, _, ok := strings.Cut(repoID, "/")
	if !ok || owner == "" {
		return ""
	}
	return "https://huggingface.co/api/avatars/" + url.PathEscape(owner)
}

func normalizeHuggingFaceRepoID(raw string) (string, bool) {
	repoID := strings.TrimSpace(raw)
	if repoID == "" {
		return "", false
	}
	if strings.HasPrefix(repoID, "http://") || strings.HasPrefix(repoID, "https://") {
		parsed, err := url.Parse(repoID)
		if err != nil {
			return "", false
		}
		repoID = strings.Trim(parsed.Path, "/")
	}
	repoID = strings.TrimPrefix(repoID, "models/")
	if before, _, ok := strings.Cut(repoID, "/tree/"); ok {
		repoID = before
	}
	if before, _, ok := strings.Cut(repoID, "/resolve/"); ok {
		repoID = before
	}
	parts := strings.Split(repoID, "/")
	if len(parts) != 2 {
		return "", false
	}
	for _, part := range parts {
		if part == "" || part == "." || part == ".." || strings.ContainsAny(part, "\\:?# \t\r\n") {
			return "", false
		}
	}
	return strings.Join(parts, "/"), true
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func humanModelName(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return "Hugging Face model"
	}
	replacer := strings.NewReplacer("-", " ", "_", " ")
	return strings.Join(strings.Fields(replacer.Replace(name)), " ")
}

func compactSearchTags(tags []string) []string {
	out := make([]string, 0, min(len(tags), 8))
	seen := make(map[string]bool)
	for _, tag := range tags {
		tag = strings.TrimSpace(tag)
		if tag == "" || strings.Contains(tag, ":") {
			continue
		}
		key := strings.ToLower(tag)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, tag)
		if len(out) == 8 {
			break
		}
	}
	return out
}

func inferModelFamily(config map[string]any, tags []string, name string) string {
	for _, key := range []string{"model_type", "architectures"} {
		value, ok := config[key]
		if !ok {
			continue
		}
		switch typed := value.(type) {
		case string:
			if typed != "" {
				return typed
			}
		case []any:
			if len(typed) > 0 {
				if first, ok := typed[0].(string); ok && first != "" {
					return first
				}
			}
		}
	}
	for _, tag := range tags {
		if strings.EqualFold(tag, "mlx") || strings.EqualFold(tag, "safetensors") {
			continue
		}
		return tag
	}
	fields := strings.Fields(name)
	if len(fields) > 0 {
		return fields[0]
	}
	return ""
}

func inferQuantization(repoID string, tags []string) string {
	haystack := strings.ToLower(repoID + " " + strings.Join(tags, " "))
	switch {
	case strings.Contains(haystack, "nvfp4"):
		return "NVFP4"
	case strings.Contains(haystack, "mxfp4"):
		return "MXFP4"
	case strings.Contains(haystack, "4bit") || strings.Contains(haystack, "4-bit"):
		return "4-bit"
	case strings.Contains(haystack, "8bit") || strings.Contains(haystack, "8-bit"):
		return "8-bit"
	case strings.Contains(haystack, "fp16"):
		return "FP16"
	default:
		return ""
	}
}

func inferParameterSize(repoID, name string, result huggingFaceSearchResult) string {
	if result.Safetensors.Total > 0 {
		return formatParameterCount(result.Safetensors.Total)
	}
	var total int64
	for _, count := range result.Safetensors.Parameters {
		total += count
	}
	if total > 0 {
		return formatParameterCount(total)
	}
	return inferParameterSizeFromText(repoID + " " + name)
}

func inferParameterSizeFromText(text string) string {
	match := parameterSizePattern.FindStringSubmatch(text)
	if len(match) != 3 {
		return ""
	}
	parameterSize := strings.ToUpper(match[1] + match[2])
	activeMatch := activeParameterSizePattern.FindStringSubmatch(text)
	if len(activeMatch) == 3 {
		activeSize := strings.ToUpper(activeMatch[1] + activeMatch[2])
		if activeSize != parameterSize {
			return parameterSize + " / " + activeSize + " active"
		}
	}
	return parameterSize
}

func formatParameterCount(count int64) string {
	if count >= 1_000_000_000 {
		return formatCount(float64(count)/1_000_000_000, "B")
	}
	if count >= 1_000_000 {
		return formatCount(float64(count)/1_000_000, "M")
	}
	return strconv.FormatInt(count, 10)
}

func formatCount(value float64, suffix string) string {
	if value >= 10 {
		return strconv.FormatFloat(value, 'f', 0, 64) + suffix
	}
	return strings.TrimRight(strings.TrimRight(strconv.FormatFloat(value, 'f', 1, 64), "0"), ".") + suffix
}

func inferDownloadBytes(result huggingFaceSearchResult) int64 {
	var total int64
	for _, sibling := range result.Siblings {
		if !matchesDownloadFilePattern(filepath.Base(sibling.RFilename)) {
			continue
		}
		size := sibling.Size
		if size <= 0 {
			size = sibling.LFS.Size
		}
		if size > 0 {
			total += size
		}
	}
	return total
}

func inferContextWindow(config map[string]any) int {
	for _, key := range []string{"max_position_embeddings", "max_sequence_length", "seq_length", "context_length"} {
		if value, ok := intFromJSONValue(config[key]); ok && value > 0 {
			return value
		}
	}
	return 0
}

func intFromJSONValue(value any) (int, bool) {
	switch typed := value.(type) {
	case float64:
		return int(typed), true
	case int:
		return typed, true
	case string:
		parsed, err := strconv.Atoi(typed)
		return parsed, err == nil
	default:
		return 0, false
	}
}

// gatedModelError reports a Hugging Face 401/403 for a model repo whose terms
// need to be accepted before download. Download states carry it to clients as
// methods.LocalInferenceDownloadErrorCodeToSRequired.
func gatedModelError(_ string, _ int) error {
	return errGatedModel
}

type gatedModelErr struct{}

func (gatedModelErr) Error() string { return "model requires ToS acceptance" }

var errGatedModel error = gatedModelErr{}
