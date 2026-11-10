import type { LocalInferenceModel, LocalInferenceState } from "@camber/helperapi/schemas";
import { describe, expect, it } from "vitest";
import {
  localInferenceModelMissing,
  mergeLocalInferenceModelConfigOptionDefinitions,
  preserveLocalInferenceModelConfigOptionForAgent,
} from "./localInferenceModelOptions";

function stateWithCatalog(
  catalog: Array<Partial<LocalInferenceModel>>,
  runtime?: Partial<LocalInferenceState["runtime"]>,
): LocalInferenceState {
  return {
    modelsDirectory: "/models",
    catalog: catalog.map((model, index) => ({
      id: `owner/model-${index}`,
      repoId: `owner/model-${index}`,
      name: `Model ${index}`,
      provider: "owner",
      downloaded: false,
      ...model,
    })),
    runtime: {
      supported: true,
      status: "stopped",
      agentServer: "local",
      ...runtime,
    },
  };
}

describe("localInferenceModelMissing", () => {
  it("is true when nothing in the catalog is downloaded", () => {
    expect(localInferenceModelMissing(stateWithCatalog([{ downloaded: false }, {}]))).toBe(true);
  });

  it("counts a disabled model as unavailable", () => {
    expect(
      localInferenceModelMissing(stateWithCatalog([{ downloaded: true, disabled: true }])),
    ).toBe(true);
  });

  it("is false once a model is downloaded", () => {
    expect(
      localInferenceModelMissing(stateWithCatalog([{ downloaded: false }, { downloaded: true }])),
    ).toBe(false);
  });

  // Before the first state read there is nothing to judge; locking the
  // composer on ignorance would flash it disabled on every new conversation.
  it("is false while state is unknown", () => {
    expect(localInferenceModelMissing(null)).toBe(false);
  });

  // An external OpenAI-compatible server brings its own models; the local
  // catalog says nothing about what it can serve.
  it("is false for an external runtime", () => {
    expect(localInferenceModelMissing(stateWithCatalog([], { status: "external" }))).toBe(false);
  });
});

describe("mergeLocalInferenceModelConfigOptionDefinitions", () => {
  it("keeps catalog models while retaining the agent's current model", () => {
    const gemma = "mlx-community/gemma-4-e4b-it-qat-OptiQ-4bit";
    const laguna = "poolside/Laguna-S-2.1-NVFP4-mlx";
    const modelOption = (currentValue: string, values: string[]) => ({
      id: "model",
      type: "select" as const,
      name: "Model",
      category: "model" as const,
      currentValue,
      options: values.map((value) => ({ name: value, value })),
    });

    expect(
      mergeLocalInferenceModelConfigOptionDefinitions(
        [modelOption(gemma, [gemma])],
        [modelOption(laguna, [gemma, laguna])],
      ),
    ).toEqual([modelOption(gemma, [gemma, laguna])]);
  });
});

describe("preserveLocalInferenceModelConfigOptionForAgent", () => {
  it("keeps the helper-backed local model selection and definitions", () => {
    const gemma = "mlx-community/gemma-4-e4b-it-qat-OptiQ-4bit";
    const laguna = "poolside/Laguna-S-2.1-NVFP4-mlx";
    const modelOption = (currentValue: string, values: string[]) => ({
      id: "model",
      type: "select" as const,
      name: "Model",
      category: "model" as const,
      currentValue,
      options: values.map((value) => ({ name: value, value })),
    });

    expect(
      preserveLocalInferenceModelConfigOptionForAgent(
        "local",
        [modelOption(gemma, [gemma])],
        [modelOption(laguna, [gemma, laguna])],
      ),
    ).toEqual([modelOption(laguna, [gemma, laguna])]);
  });

  it("does not change another agent's model option", () => {
    const reported = [
      {
        id: "model",
        type: "select" as const,
        name: "Model",
        options: [{ name: "Reported", value: "reported" }],
        currentValue: "reported",
      },
    ];
    const preserved = [
      {
        id: "model",
        type: "select" as const,
        name: "Model",
        options: [{ name: "Preserved", value: "preserved" }],
        currentValue: "preserved",
      },
    ];

    expect(preserveLocalInferenceModelConfigOptionForAgent("poolside", reported, preserved)).toBe(
      reported,
    );
  });
});
