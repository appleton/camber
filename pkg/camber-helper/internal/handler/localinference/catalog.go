package localinference

import "github.com/appleton/camber/pkg/camber-helper/methods"

const defaultModelID = "poolside/Laguna-XS-2.1-NVFP4-mlx"

func catalog() []methods.LocalInferenceModel {
	return []methods.LocalInferenceModel{
		{
			ID:            defaultModelID,
			RepoID:        defaultModelID,
			Name:          "Laguna XS 2.1 NVFP4",
			Provider:      "poolside",
			Source:        "Hugging Face",
			SourceURL:     huggingFaceModelURL(defaultModelID),
			AvatarURL:     huggingFaceAvatarURL(defaultModelID),
			Family:        "Laguna",
			Quantization:  "NVFP4",
			ParameterSize: "33B / 3B active",
			Description:   "Camber Laguna XS 2.1 33B/3B-active coding MoE, NVFP4 quantized.",
			ContextWindow: 262144,
			Recommended:   true,
			Default:       true,
			Tags:          []string{"coding", "moe", "agentic"},
		},
		{
			ID:            "mlx-community/gemma-4-e4b-it-qat-OptiQ-4bit",
			RepoID:        "mlx-community/gemma-4-e4b-it-qat-OptiQ-4bit",
			Name:          "Gemma 4 E4B IT QAT OptiQ 4-bit",
			Provider:      "Google",
			Source:        "Hugging Face",
			SourceURL:     huggingFaceModelURL("mlx-community/gemma-4-e4b-it-qat-OptiQ-4bit"),
			AvatarURL:     huggingFaceAvatarURL("mlx-community/gemma-4-e4b-it-qat-OptiQ-4bit"),
			Family:        "Gemma 4",
			Quantization:  "OptiQ 4-bit",
			ParameterSize: "7B",
			Description:   "MLX Community OptiQ mixed-precision quant of Gemma 4 E4B IT QAT.",
			ContextWindow: 128000,
			Recommended:   true,
			Tags:          []string{"general", "small"},
		},
	}
}
