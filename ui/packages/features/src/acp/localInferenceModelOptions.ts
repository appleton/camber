import type { SessionConfigOption, SessionConfigSelectOption } from "@agentclientprotocol/sdk";
import type { LocalInferenceModel, LocalInferenceState } from "@camber/helperapi/schemas";
import { LOCAL_AGENT_SERVER, normalizeAgentServerName } from "./agentServers";
import { isExternalLocalInferenceRuntime } from "./localInferenceRuntime";

// Builders for the "model" session config option of the local agent server.
// The local inference state (not the agent) is the source of truth for which
// models are installed, so the helpers here replace whatever model option the
// agent reported with one derived from the downloaded catalog.

export function mergeLocalInferenceModelConfigOptions(
  configOptions: SessionConfigOption[],
  state: LocalInferenceState,
): SessionConfigOption[] {
  const modelOption = localInferenceModelConfigOption(configOptions, state);
  const modelOptionIndex = configOptions.findIndex(isModelConfigOption);
  if (!modelOption) {
    return modelOptionIndex === -1
      ? configOptions
      : configOptions.filter((_, index) => index !== modelOptionIndex);
  }
  if (modelOptionIndex === -1) return [...configOptions, modelOption];
  return configOptions.map((option, index) => (index === modelOptionIndex ? modelOption : option));
}

/**
 * Restore the catalog-backed local model option onto a live agent response
 * while retaining the model the agent says is currently selected. The local
 * agent can advertise only its bootstrap model at session/new even though the
 * helper catalog offers every downloaded model. Reconciliation needs the full
 * option list to apply a draft's selection, but must compare it with the
 * agent's actual current value so it does not skip the wire call.
 */
export function mergeLocalInferenceModelConfigOptionDefinitions(
  configOptions: SessionConfigOption[],
  definitions: SessionConfigOption[],
): SessionConfigOption[] {
  const definition = definitions.find(isModelConfigOption);
  if (!definition || definition.type !== "select") return configOptions;

  const currentValue = currentModelConfigValue(configOptions);
  const modelOption = currentValue === null ? definition : { ...definition, currentValue };
  const modelOptionIndex = configOptions.findIndex(isModelConfigOption);
  if (modelOptionIndex === -1) return [...configOptions, modelOption];
  return configOptions.map((option, index) => (index === modelOptionIndex ? modelOption : option));
}

export function mergeLocalInferenceModelConfigOptionDefinitionsForAgent(
  agentServer: string,
  configOptions: SessionConfigOption[],
  definitions: SessionConfigOption[],
): SessionConfigOption[] {
  if (normalizeAgentServerName(agentServer) !== LOCAL_AGENT_SERVER) return configOptions;
  return mergeLocalInferenceModelConfigOptionDefinitions(configOptions, definitions);
}

/**
 * Keep the helper-backed local model option intact when a config probe reports
 * the standalone agent's bootstrap-only model option. Probe responses refresh
 * the other cached config, but the helper catalog owns both the available
 * local models and the selection staged for the next real session.
 */
export function preserveLocalInferenceModelConfigOptionForAgent(
  agentServer: string,
  configOptions: SessionConfigOption[],
  preservedConfigOptions: SessionConfigOption[],
): SessionConfigOption[] {
  if (normalizeAgentServerName(agentServer) !== LOCAL_AGENT_SERVER) return configOptions;
  const preservedModelOption = preservedConfigOptions.find(isModelConfigOption);
  if (!preservedModelOption) return configOptions;

  const modelOptionIndex = configOptions.findIndex(isModelConfigOption);
  if (modelOptionIndex === -1) return [...configOptions, preservedModelOption];
  return configOptions.map((option, index) =>
    index === modelOptionIndex ? preservedModelOption : option,
  );
}

function localInferenceModelConfigOption(
  configOptions: SessionConfigOption[],
  state: LocalInferenceState,
): SessionConfigOption | null {
  const models = selectableLocalInferenceModels(state);
  if (models.length === 0) return null;
  const options: SessionConfigSelectOption[] = models.map((model) => ({
    value: model.id,
    name: model.id,
    description: model.id,
  }));
  return {
    id: "model",
    type: "select",
    name: "Model",
    category: "model",
    options,
    currentValue: selectedLocalInferenceModel(configOptions, state, models),
  };
}

/**
 * True when the helper-managed local runtime has no model to serve: the
 * catalog is known and nothing in it is downloaded. False while state is
 * still unknown (no lockout before the first read lands) and for an external
 * server, which brings its own models. The composer disables sending to the
 * local agent on this, and the config menu shows "No model available" in
 * place of a model list.
 */
export function localInferenceModelMissing(state: LocalInferenceState | null): boolean {
  if (!state || isExternalLocalInferenceRuntime(state)) return false;
  return selectableLocalInferenceModels(state).length === 0;
}

function selectableLocalInferenceModels(state: LocalInferenceState): LocalInferenceModel[] {
  const seen = new Set<string>();
  const models: LocalInferenceModel[] = [];
  for (const model of state.catalog) {
    if (!model.downloaded || model.disabled || seen.has(model.id)) {
      continue;
    }
    seen.add(model.id);
    models.push(model);
  }
  return models;
}

function selectedLocalInferenceModel(
  configOptions: SessionConfigOption[],
  state: LocalInferenceState,
  models: LocalInferenceModel[],
): string {
  const available = new Set(models.map((model) => model.id));
  const current = currentModelConfigValue(configOptions);
  if (current && available.has(current)) return current;
  if (state.runtime.defaultModelId && available.has(state.runtime.defaultModelId)) {
    return state.runtime.defaultModelId;
  }
  return models.find((model) => model.default)?.id ?? models[0]?.id ?? "";
}

// Exported so callers can detect when merging changed the selected model
// (e.g. to push the new selection to the agent via setSessionConfigOption).
export function currentModelConfigValue(configOptions: SessionConfigOption[]): string | null {
  const modelOption = configOptions.find(isModelConfigOption);
  if (!modelOption || modelOption.type !== "select") return null;
  return modelOption.currentValue;
}

function isModelConfigOption(option: SessionConfigOption): boolean {
  return option.id === "model" || option.category === "model";
}
