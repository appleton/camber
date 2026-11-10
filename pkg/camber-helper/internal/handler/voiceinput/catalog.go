package voiceinput

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/appleton/camber/pkg/camber-helper/methods"
	"github.com/appleton/camber/pkg/common/userconfig"
)

// catalogEntry describes one ggml Whisper model from the official
// ggerganov/whisper.cpp conversions on Hugging Face.
type catalogEntry struct {
	id           string
	name         string
	multilingual bool
	recommended  bool
	// downloadBytes is the model's exact size, which is also enforced during
	// download; it doubles as the pre-download display size.
	downloadBytes int64
	// sha256 is the model file's digest, verified before the download is moved
	// into place. Hugging Face stores these files in LFS, where the object ID
	// is the content's SHA-256.
	sha256 string
}

const defaultModelID = "base"

// modelRepoRevision pins the whisper.cpp model repository to a commit. The
// `main` ref is mutable: whoever controls the repository (or a compromised
// Hugging Face) could change what `main` points at, and these bytes are fed
// straight into a native Whisper parser. Update this alongside the digests
// below.
const modelRepoRevision = "5359861c739e955e79d9a303bcbc70fb988958b1"

var catalog = []catalogEntry{
	{
		id: "tiny", name: "Whisper Tiny", multilingual: true,
		downloadBytes: 77691713,
		sha256:        "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
	},
	{
		id: "base", name: "Whisper Base", multilingual: true, recommended: true,
		downloadBytes: 147951465,
		sha256:        "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
	},
	{
		id: "small", name: "Whisper Small", multilingual: true,
		downloadBytes: 487601967,
		sha256:        "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
	},
	{
		id: "large-v3-turbo", name: "Whisper Large v3 Turbo", multilingual: true,
		downloadBytes: 1624555275,
		sha256:        "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
	},
}

func catalogModel(modelID string) (catalogEntry, bool) {
	for _, entry := range catalog {
		if entry.id == modelID {
			return entry, true
		}
	}
	return catalogEntry{}, false
}

func modelFileName(modelID string) string {
	return "ggml-" + modelID + ".bin"
}

func modelPath(modelsDir, modelID string) string {
	return filepath.Join(modelsDir, modelFileName(modelID))
}

func modelDownloaded(modelsDir, modelID string) bool {
	info, err := os.Stat(modelPath(modelsDir, modelID))
	return err == nil && !info.IsDir() && info.Size() > 0
}

func (s *Server) modelDownloadURL(modelID string) string {
	return fmt.Sprintf("%s/ggerganov/whisper.cpp/resolve/%s/%s",
		s.modelBaseURL(), modelRepoRevision, modelFileName(modelID))
}

func (s *Server) modelBaseURL() string {
	if url := usingModelMirror(); url != "" {
		return url
	}
	return "https://huggingface.co"
}

// usingModelMirror returns the developer/test mirror base URL, or "" when the
// canonical Hugging Face source is in use. A mirror serves fixture bytes rather
// than the real weights, so the pinned digest cannot apply to it; the size and
// transfer limits still do.
func usingModelMirror() string {
	if url := strings.TrimSpace(os.Getenv(modelBaseURLEnv)); url != "" {
		return strings.TrimRight(url, "/")
	}
	return ""
}

// expectedDigest returns the digest to verify a freshly downloaded model
// against, or "" when downloading from a mirror.
func (s *Server) expectedDigest(model catalogEntry) string {
	if usingModelMirror() != "" {
		return ""
	}
	return model.sha256
}

func defaultModelsDirectory() string {
	if dir := strings.TrimSpace(os.Getenv(modelsDirEnv)); dir != "" {
		return cleanDirectory(dir)
	}
	return cleanDirectory(filepath.Join(userconfig.CamberDirectory(), "models", "whisper"))
}

func cleanDirectory(dir string) string {
	if abs, err := filepath.Abs(dir); err == nil {
		dir = abs
	}
	return filepath.Clean(dir)
}

func (s *Server) models(modelsDir, selectedModelID string) []methods.VoiceInputModel {
	models := make([]methods.VoiceInputModel, 0, len(catalog))
	for _, entry := range catalog {
		model := methods.VoiceInputModel{
			ID:            entry.id,
			Name:          entry.name,
			Multilingual:  entry.multilingual,
			Recommended:   entry.recommended,
			Default:       entry.id == defaultModelID,
			Selected:      entry.id == selectedModelID,
			DownloadBytes: entry.downloadBytes,
		}
		if modelsDir != "" && modelDownloaded(modelsDir, entry.id) {
			model.Downloaded = true
			model.LocalPath = modelPath(modelsDir, entry.id)
			if info, err := os.Stat(model.LocalPath); err == nil {
				model.DownloadBytes = info.Size()
			}
		}
		models = append(models, model)
	}
	return models
}
