package control

import (
	"context"
	"encoding/json"
	"strings"

	pkgerrors "github.com/pkg/errors"
	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

// Local model actions. They call the camber/localInference/* handlers the
// desktop's Local models settings use (LocalInferenceRepository). Each
// mutation pushes camber/localInference/didChange to the desktop, which
// updates the settings view and runs its own follow-ups (for example
// restarting the local agent after the default model changes).
func init() {
	model := objectSchema(map[string]any{"modelId": map[string]any{"type": "string", "description": "Model id (see models list or models search)"}}, "modelId")
	registerAction("models.list", RegisteredAction{
		Summary: "List local models (catalog, installed and downloading) and the local runtime's state.",
		Run: func(ctx context.Context, s *Service, raw json.RawMessage, _ string, g *glsp.Context) (any, error) {
			if err := decodeActionArgs(raw, &struct{}{}); err != nil {
				return nil, err
			}
			return s.localModelState(ctx, func(t LocalInferenceTools) (methods.LocalInferenceState, error) {
				return t.GetState(ctx, &methods.LocalInferenceGetStateParams{}, g)
			})
		},
	})
	registerAction("models.search", RegisteredAction{
		Summary:     "Search Hugging Face for installable local models.",
		InputSchema: objectSchema(map[string]any{"query": map[string]any{"type": "string"}}, "query"),
		Run: func(ctx context.Context, s *Service, raw json.RawMessage, _ string, g *glsp.Context) (any, error) {
			var a struct {
				Query string `json:"query"`
			}
			if err := decodeActionArgs(raw, &a); err != nil {
				return nil, err
			}
			if strings.TrimSpace(a.Query) == "" {
				return nil, pkgerrors.Errorf("query is required")
			}
			tools, err := s.localInferenceTools()
			if err != nil {
				return nil, err
			}
			result, err := tools.SearchModels(ctx, &methods.LocalInferenceSearchModelsParams{Query: a.Query}, g)
			if err != nil {
				return nil, err
			}
			models := []localModelSummary{}
			for _, m := range result.Models {
				models = append(models, summarizeLocalModel(m))
			}
			return map[string]any{"models": models}, nil
		},
	})
	modelActions := map[string]struct {
		summary string
		run     func(context.Context, LocalInferenceTools, string, *glsp.Context) (methods.LocalInferenceState, error)
	}{
		"models.download": {"Start downloading a local model; progress shows in models list.", func(ctx context.Context, t LocalInferenceTools, id string, g *glsp.Context) (methods.LocalInferenceState, error) {
			return t.DownloadModel(ctx, &methods.LocalInferenceDownloadModelParams{ModelID: id}, g)
		}},
		"models.cancel": {"Cancel a local model download.", func(ctx context.Context, t LocalInferenceTools, id string, g *glsp.Context) (methods.LocalInferenceState, error) {
			return t.CancelDownload(ctx, &methods.LocalInferenceCancelDownloadParams{ModelID: id}, g)
		}},
		"models.delete": {"Delete a downloaded local model from disk.", func(ctx context.Context, t LocalInferenceTools, id string, g *glsp.Context) (methods.LocalInferenceState, error) {
			return t.DeleteModel(ctx, &methods.LocalInferenceDeleteModelParams{ModelID: id}, g)
		}},
		"models.default": {"Make a downloaded model the local agent's default.", func(ctx context.Context, t LocalInferenceTools, id string, g *glsp.Context) (methods.LocalInferenceState, error) {
			return t.SetDefaultModel(ctx, &methods.LocalInferenceSetDefaultModelParams{ModelID: id}, g)
		}},
	}
	for name, action := range modelActions {
		registerAction(name, RegisteredAction{
			Summary:     action.summary,
			InputSchema: model,
			Run: func(ctx context.Context, s *Service, raw json.RawMessage, _ string, g *glsp.Context) (any, error) {
				var a struct {
					ModelID string `json:"modelId"`
				}
				if err := decodeActionArgs(raw, &a); err != nil {
					return nil, err
				}
				if strings.TrimSpace(a.ModelID) == "" {
					return nil, pkgerrors.Errorf("modelId is required")
				}
				return s.localModelState(ctx, func(t LocalInferenceTools) (methods.LocalInferenceState, error) {
					return action.run(ctx, t, a.ModelID, g)
				})
			},
		})
	}
	registerAction("models.unload", RegisteredAction{
		Summary: "Release the model resident in the local runtime's memory.",
		Run: func(ctx context.Context, s *Service, raw json.RawMessage, _ string, g *glsp.Context) (any, error) {
			if err := decodeActionArgs(raw, &struct{}{}); err != nil {
				return nil, err
			}
			return s.localModelState(ctx, func(t LocalInferenceTools) (methods.LocalInferenceState, error) {
				return t.UnloadModel(ctx, &methods.LocalInferenceUnloadModelParams{}, g)
			})
		},
	})
}

// localModelSummary keeps a catalog entry's identifying and status fields;
// descriptions, avatars and estimate details stay in the desktop view.
type localModelSummary struct {
	ID             string                               `json:"id"`
	Name           string                               `json:"name"`
	Provider       string                               `json:"provider,omitempty"`
	ParameterSize  string                               `json:"parameterSize,omitempty"`
	Quantization   string                               `json:"quantization,omitempty"`
	ContextWindow  int                                  `json:"contextWindow,omitempty"`
	Recommended    bool                                 `json:"recommended,omitempty"`
	Default        bool                                 `json:"default,omitempty"`
	Downloaded     bool                                 `json:"downloaded"`
	Gated          bool                                 `json:"gated,omitempty"`
	Disabled       bool                                 `json:"disabled,omitempty"`
	InstalledBytes int64                                `json:"installedBytes,omitempty"`
	DownloadBytes  int64                                `json:"downloadBytes,omitempty"`
	Download       *methods.LocalInferenceDownloadState `json:"download,omitempty"`
	RunConfidence  methods.LocalInferenceRunConfidence  `json:"runConfidence,omitempty"`
	RunSummary     string                               `json:"runSummary,omitempty"`
	SourceURL      string                               `json:"sourceUrl,omitempty"`
}

func (s *Service) localModelState(ctx context.Context, run func(LocalInferenceTools) (methods.LocalInferenceState, error)) (any, error) {
	tools, err := s.localInferenceTools()
	if err != nil {
		return nil, err
	}
	state, err := run(tools)
	if err != nil {
		return nil, err
	}
	models := []localModelSummary{}
	for _, m := range state.Catalog {
		models = append(models, summarizeLocalModel(m))
	}
	return map[string]any{"runtime": state.Runtime, "modelsDirectory": state.ModelsDirectory, "models": models, "downloads": state.Downloads}, nil
}

func (s *Service) localInferenceTools() (LocalInferenceTools, error) {
	tools := s.currentTools().LocalInference
	if tools == nil {
		return nil, unavailableTool("local model management")
	}
	return tools, nil
}

func summarizeLocalModel(m methods.LocalInferenceModel) localModelSummary {
	summary := localModelSummary{
		ID:             m.ID,
		Name:           m.Name,
		Provider:       m.Provider,
		ParameterSize:  m.ParameterSize,
		Quantization:   m.Quantization,
		ContextWindow:  m.ContextWindow,
		Recommended:    m.Recommended,
		Default:        m.Default,
		Downloaded:     m.Downloaded,
		Gated:          m.Gated,
		Disabled:       m.Disabled,
		InstalledBytes: m.InstalledBytes,
		DownloadBytes:  m.DownloadBytes,
		Download:       m.Download,
		SourceURL:      m.SourceURL,
	}
	if m.RunEstimate != nil {
		summary.RunConfidence = m.RunEstimate.Confidence
		summary.RunSummary = m.RunEstimate.Summary
	}
	return summary
}
