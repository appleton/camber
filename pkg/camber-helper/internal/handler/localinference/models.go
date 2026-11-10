package localinference

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

type installedModelManifest struct {
	ID            string   `json:"id"`
	RepoID        string   `json:"repoId"`
	Name          string   `json:"name"`
	Provider      string   `json:"provider"`
	Source        string   `json:"source,omitempty"`
	SourceURL     string   `json:"sourceUrl,omitempty"`
	AvatarURL     string   `json:"avatarUrl,omitempty"`
	Family        string   `json:"family,omitempty"`
	Quantization  string   `json:"quantization,omitempty"`
	ParameterSize string   `json:"parameterSize,omitempty"`
	Description   string   `json:"description,omitempty"`
	ContextWindow int      `json:"contextWindow,omitempty"`
	DownloadBytes int64    `json:"downloadBytes,omitempty"`
	Tags          []string `json:"tags,omitempty"`
}

func (s *Server) decorateCatalog(ctx context.Context, modelsDir, defaultModel string, downloads []methods.LocalInferenceDownloadState, machine machineProfile, fetchRemoteMetadata bool) []methods.LocalInferenceModel {
	models := catalog()
	models = append(models, installedCustomModels(modelsDir)...)
	models = append(models, partialCustomModels(modelsDir, downloads, models)...)
	for i := range models {
		models[i].Default = models[i].ID == defaultModel ||
			models[i].RepoID == defaultModel ||
			filepath.Base(models[i].RepoID) == defaultModel
		s.decorateModelDownloadState(&models[i], modelsDir, downloadStateForModel(downloads, models[i]))
	}
	if fetchRemoteMetadata {
		s.enrichModelDownloadBytes(ctx, models)
	} else {
		s.enrichModelDownloadBytesFromCache(models)
	}
	for i := range models {
		decorateModelRunEstimate(&models[i], machine, models[i].Download)
	}
	return models
}

func partialCustomModels(modelsDir string, downloads []methods.LocalInferenceDownloadState, existing []methods.LocalInferenceModel) []methods.LocalInferenceModel {
	seen := make(map[string]bool)
	for _, model := range existing {
		if model.ID != "" {
			seen[model.ID] = true
		}
		if model.RepoID != "" {
			seen[model.RepoID] = true
		}
	}

	var models []methods.LocalInferenceModel
	add := func(rawRepoID string) {
		repoID, ok := normalizeHuggingFaceRepoID(rawRepoID)
		if !ok || seen[repoID] || catalogContains(repoID) {
			return
		}
		seen[repoID] = true
		models = append(models, inferredHuggingFaceModel(repoID))
	}

	for _, download := range downloads {
		if download.Status != methods.LocalInferenceDownloadCompleted {
			add(download.ModelID)
		}
	}
	for _, repoID := range partialModelRepoIDs(modelsDir) {
		add(repoID)
	}
	return models
}

// inferredHuggingFaceModel synthesizes a catalog entry for a model with no
// installed manifest, inferring what it can from the repo id alone.
func inferredHuggingFaceModel(repoID string) methods.LocalInferenceModel {
	owner, _, _ := strings.Cut(repoID, "/")
	name := humanModelName(filepath.Base(repoID))
	return methods.LocalInferenceModel{
		ID:            repoID,
		RepoID:        repoID,
		Name:          name,
		Provider:      owner,
		Source:        "Hugging Face",
		SourceURL:     huggingFaceModelURL(repoID),
		AvatarURL:     huggingFaceAvatarURL(repoID),
		Family:        inferModelFamily(nil, nil, name),
		Quantization:  inferQuantization(repoID, nil),
		ParameterSize: inferParameterSize(repoID, name, huggingFaceSearchResult{}),
	}
}

func partialModelRepoIDs(modelsDir string) []string {
	if modelsDir == "" {
		return nil
	}
	patterns := []string{
		filepath.Join(modelsDir, "*", downloadMarkerFilename),
		filepath.Join(modelsDir, "*", "*", downloadMarkerFilename),
	}
	seen := make(map[string]bool)
	var repoIDs []string
	for _, pattern := range patterns {
		matches, err := filepath.Glob(pattern)
		if err != nil {
			continue
		}
		for _, markerPath := range matches {
			modelPath := filepath.Dir(markerPath)
			rel, err := filepath.Rel(modelsDir, modelPath)
			if err != nil || rel == "." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
				continue
			}
			repoID := filepath.ToSlash(rel)
			repoID, ok := normalizeHuggingFaceRepoID(repoID)
			if !ok || seen[repoID] {
				continue
			}
			seen[repoID] = true
			repoIDs = append(repoIDs, repoID)
		}
	}
	sort.Strings(repoIDs)
	return repoIDs
}

func downloadStateForModel(downloads []methods.LocalInferenceDownloadState, model methods.LocalInferenceModel) *methods.LocalInferenceDownloadState {
	for i := range downloads {
		if downloads[i].ModelID == model.ID || downloads[i].ModelID == model.RepoID {
			return &downloads[i]
		}
	}
	return nil
}

func (s *Server) decorateModelDownloadState(model *methods.LocalInferenceModel, modelsDir string, download *methods.LocalInferenceDownloadState) {
	if download != nil && (download.ModelID == model.ID || download.ModelID == model.RepoID) {
		downloadSnapshot := *download
		model.Download = &downloadSnapshot
	}
	if modelsDir == "" {
		return
	}
	path, ok := downloadedModelPath(modelsDir, model.RepoID)
	if ok {
		model.Downloaded = true
		model.LocalPath = path
		model.InstalledBytes = s.cachedDirectorySize(path)
		return
	}
	if path, ok := existingModelPath(modelsDir, model.RepoID); ok {
		model.LocalPath = path
		model.InstalledBytes = s.cachedDirectorySize(path)
	}
}

func installedCustomModels(modelsDir string) []methods.LocalInferenceModel {
	if modelsDir == "" {
		return nil
	}
	paths := installedManifestPaths(modelsDir)
	models := make([]methods.LocalInferenceModel, 0, len(paths))
	seen := make(map[string]bool)
	for _, path := range paths {
		model, ok := readInstalledModelManifest(path)
		if !ok || catalogContains(model.ID) || catalogContains(model.RepoID) || seen[model.RepoID] {
			continue
		}
		// The download flow writes the manifest into the directory named for
		// its repo id, so a disagreement means the directory was copied or
		// renamed by hand and the manifest describes a model that lives
		// nowhere. Leave it to discovery below, which names the model after
		// the directory the files are actually in; keeping the manifest would
		// list an installed model whose path resolves to nothing.
		if dirRepoID, ok := directoryRepoID(modelsDir, filepath.Dir(path)); ok && dirRepoID != model.RepoID {
			continue
		}
		seen[model.RepoID] = true
		models = append(models, model)
	}
	for _, repoID := range discoveredModelRepoIDs(modelsDir, func(repoID string) bool {
		return seen[repoID] || catalogContains(repoID)
	}) {
		seen[repoID] = true
		models = append(models, inferredHuggingFaceModel(repoID))
	}
	return models
}

func (s *Server) installedModelByID(modelsDir, modelID string) (methods.LocalInferenceModel, bool) {
	trimmed := strings.TrimSpace(modelID)
	if trimmed == "" {
		return methods.LocalInferenceModel{}, false
	}
	for _, model := range installedCustomModels(modelsDir) {
		if model.ID == trimmed || model.RepoID == trimmed || filepath.Base(model.RepoID) == trimmed {
			s.decorateModelDownloadState(&model, modelsDir, nil)
			return model, true
		}
	}
	return methods.LocalInferenceModel{}, false
}

func installedManifestPaths(modelsDir string) []string {
	patterns := []string{
		filepath.Join(modelsDir, "*", installedManifestFilename),
		filepath.Join(modelsDir, "*", "*", installedManifestFilename),
	}
	var paths []string
	for _, pattern := range patterns {
		matches, err := filepath.Glob(pattern)
		if err != nil {
			continue
		}
		paths = append(paths, matches...)
	}
	return paths
}

// discoveredModelRepoIDs finds complete model directories with no installed
// manifest: models placed under modelsDir outside the app download flow (for
// example copied or cloned by hand) must still be listed and selectable.
//
// known reports the repo ids already accounted for, so the completeness check
// — several stats and a directory read per model — is skipped for them. It
// runs on every state snapshot, including each download-progress tick, and on
// an ordinary install every model is already known, leaving just the glob.
func discoveredModelRepoIDs(modelsDir string, known func(repoID string) bool) []string {
	matches, err := filepath.Glob(filepath.Join(modelsDir, "*", "*", "config.json"))
	if err != nil {
		return nil
	}
	var repoIDs []string
	for _, configPath := range matches {
		modelPath := filepath.Dir(configPath)
		repoID, ok := directoryRepoID(modelsDir, modelPath)
		if !ok || known(repoID) || !isDownloadedModel(modelPath) {
			continue
		}
		repoIDs = append(repoIDs, repoID)
	}
	sort.Strings(repoIDs)
	return repoIDs
}

// directoryRepoID reads the repo id a model directory's location spells out.
// Only an owner/name directory names a model; anything else (a flat layout, a
// path outside modelsDir) has no id to give.
func directoryRepoID(modelsDir, modelPath string) (string, bool) {
	rel, err := filepath.Rel(modelsDir, modelPath)
	if err != nil {
		return "", false
	}
	return normalizeHuggingFaceRepoID(filepath.ToSlash(rel))
}

func writeInstalledModelManifest(modelDir string, model methods.LocalInferenceModel) error {
	manifest := installedModelManifest{
		ID:            firstNonEmpty(model.ID, model.RepoID),
		RepoID:        model.RepoID,
		Name:          model.Name,
		Provider:      model.Provider,
		Source:        model.Source,
		SourceURL:     model.SourceURL,
		AvatarURL:     model.AvatarURL,
		Family:        model.Family,
		Quantization:  model.Quantization,
		ParameterSize: model.ParameterSize,
		Description:   model.Description,
		ContextWindow: model.ContextWindow,
		DownloadBytes: model.DownloadBytes,
		Tags:          model.Tags,
	}
	if manifest.RepoID == "" {
		manifest.RepoID = manifest.ID
	}
	data, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return fmt.Errorf("encoding local model manifest: %w", err)
	}
	if err := os.WriteFile(filepath.Join(modelDir, installedManifestFilename), append(data, '\n'), 0o644); err != nil {
		return fmt.Errorf("writing local model manifest: %w", err)
	}
	return nil
}

func readInstalledModelManifest(path string) (methods.LocalInferenceModel, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return methods.LocalInferenceModel{}, false
	}
	var manifest installedModelManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return methods.LocalInferenceModel{}, false
	}
	repoID, ok := normalizeHuggingFaceRepoID(firstNonEmpty(manifest.RepoID, manifest.ID))
	if !ok {
		return methods.LocalInferenceModel{}, false
	}
	name := manifest.Name
	if name == "" {
		name = humanModelName(filepath.Base(repoID))
	}
	provider := manifest.Provider
	if provider == "" {
		provider = strings.Split(repoID, "/")[0]
	}
	return methods.LocalInferenceModel{
		ID:            firstNonEmpty(manifest.ID, repoID),
		RepoID:        repoID,
		Name:          name,
		Provider:      provider,
		Source:        firstNonEmpty(manifest.Source, "Hugging Face"),
		SourceURL:     firstNonEmpty(manifest.SourceURL, huggingFaceModelURL(repoID)),
		AvatarURL:     firstNonEmpty(manifest.AvatarURL, huggingFaceAvatarURL(repoID)),
		Family:        manifest.Family,
		Quantization:  manifest.Quantization,
		ParameterSize: manifest.ParameterSize,
		Description:   manifest.Description,
		ContextWindow: manifest.ContextWindow,
		DownloadBytes: manifest.DownloadBytes,
		Tags:          manifest.Tags,
	}, true
}

func catalogContains(modelID string) bool {
	_, ok := catalogModel(modelID)
	return ok
}

func catalogModel(modelID string) (methods.LocalInferenceModel, bool) {
	for _, model := range catalog() {
		if model.ID == modelID || model.RepoID == modelID || filepath.Base(model.RepoID) == modelID {
			return model, true
		}
	}
	return methods.LocalInferenceModel{}, false
}

func downloadedModelPath(modelsDir, repoID string) (string, bool) {
	for _, path := range candidateModelPaths(modelsDir, repoID) {
		if isDownloadedModel(path) {
			return path, true
		}
	}
	return "", false
}

func existingModelPath(modelsDir, repoID string) (string, bool) {
	for _, path := range candidateModelPaths(modelsDir, repoID) {
		if directoryExists(path) {
			return path, true
		}
	}
	return "", false
}

func candidateModelPaths(modelsDir, repoID string) []string {
	parts := strings.Split(repoID, "/")
	if len(parts) == 2 {
		return []string{
			modelDirectory(modelsDir, repoID),
			filepath.Join(modelsDir, parts[1]),
		}
	}
	return []string{filepath.Join(modelsDir, repoID)}
}

func modelDirectory(modelsDir, repoID string) string {
	parts := strings.Split(repoID, "/")
	return filepath.Join(append([]string{modelsDir}, parts...)...)
}

func isDownloadedModel(path string) bool {
	if fileExists(filepath.Join(path, downloadMarkerFilename)) {
		return false
	}
	if !fileExists(filepath.Join(path, "config.json")) {
		return false
	}
	if !hasTokenizer(path) {
		return false
	}
	return hasSafetensors(path)
}

func hasTokenizer(path string) bool {
	if fileExists(filepath.Join(path, "tokenizer.json")) || fileExists(filepath.Join(path, "tokenizer.model")) {
		return true
	}
	return fileExists(filepath.Join(path, "vocab.json")) && fileExists(filepath.Join(path, "merges.txt"))
}

func hasSafetensors(path string) bool {
	if fileExists(filepath.Join(path, "model.safetensors.index.json")) {
		return true
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return false
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		if strings.HasSuffix(entry.Name(), ".safetensors") {
			return true
		}
	}
	return false
}
