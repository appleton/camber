import type { LocalInferenceState } from "@camber/helperapi/schemas";
import { LOCAL_AGENT_SERVER } from "../agentServers";
import type { LocalInferenceRepository } from "./LocalInferenceRepository.svelte";

// Structural slices of ACPAgentRepository / AcpSessionRepository so tests can
// provide lightweight fakes.
export interface LocalInferenceAgentSyncAgents {
  restart(agentServer: string): Promise<void>;
  refreshCachedConfig(
    agentServer: string,
    cwd: string,
    options?: { fresh?: boolean },
  ): Promise<void>;
  upsertLocalInferenceModelConfigOptions(
    agentServer: string,
    state: LocalInferenceState,
  ): Promise<unknown>;
}

export interface LocalInferenceAgentSyncSessions {
  agents: LocalInferenceAgentSyncAgents;
  applyCachedConfigToLocalSessionsForAgent(agentServer: string): void;
  applyLocalInferenceModelConfigToSessionsForAgent(
    agentServer: string,
    state: LocalInferenceState,
  ): void;
}

/**
 * Keeps the "local" ACP agent in sync with local-inference state: when the
 * set of downloaded models or the default model changes, the agent's cached
 * config (and any open local sessions) get the new model options; when the
 * sidecar stops, the agent subprocess is restarted so its next session is
 * launched with fresh runtime env.
 */
export class LocalInferenceAgentSync {
  #refreshQueue: Promise<void> = Promise.resolve();
  readonly #sessions: LocalInferenceAgentSyncSessions;
  readonly #unsubscribe: () => void;

  constructor(
    localInference: Pick<LocalInferenceRepository, "onDidChange">,
    sessions: LocalInferenceAgentSyncSessions,
  ) {
    this.#sessions = sessions;
    this.#unsubscribe = localInference.onDidChange((state, previous) => {
      this.handleDidChange(state, previous);
    });
  }

  dispose(): void {
    this.#unsubscribe();
  }

  private handleDidChange(state: LocalInferenceState, previous: LocalInferenceState | null): void {
    if (localInferenceRuntimeStopped(state, previous)) {
      this.applyModelConfig(state);
      void this.refreshAgentConfig({ restart: true, state }).catch((error) => {
        console.error("Failed to restart local ACP after sidecar exit", error);
      });
      return;
    }
    if (localInferenceModelSignature(state) === localInferenceModelSignature(previous)) return;
    this.applyModelConfig(state);
    void this.refreshAgentConfig({ state }).catch((error) => {
      console.error("Failed to refresh local ACP model options", error);
    });
  }

  // Pushes the new model options into the cached config and open local
  // sessions immediately, without waiting for a config probe round-trip.
  private applyModelConfig(state: LocalInferenceState): void {
    const update = this.#sessions.agents.upsertLocalInferenceModelConfigOptions(
      LOCAL_AGENT_SERVER,
      state,
    );
    this.#sessions.applyCachedConfigToLocalSessionsForAgent(LOCAL_AGENT_SERVER);
    this.#sessions.applyLocalInferenceModelConfigToSessionsForAgent(LOCAL_AGENT_SERVER, state);
    void update.catch((error) => {
      console.error("Failed to update local ACP model options from local inference state", error);
    });
  }

  // Serialized so a restart-and-refresh never interleaves with a
  // model-change refresh.
  private refreshAgentConfig(
    options: { restart?: boolean; state?: LocalInferenceState } = {},
  ): Promise<void> {
    this.#refreshQueue = this.#refreshQueue
      .catch(() => {})
      .then(async () => {
        if (options.restart) {
          await this.#sessions.agents.restart(LOCAL_AGENT_SERVER);
        }
        await this.#sessions.agents.refreshCachedConfig(LOCAL_AGENT_SERVER, "/", { fresh: true });
        if (options.state) {
          await this.#sessions.agents.upsertLocalInferenceModelConfigOptions(
            LOCAL_AGENT_SERVER,
            options.state,
          );
        }
        this.#sessions.applyCachedConfigToLocalSessionsForAgent(LOCAL_AGENT_SERVER);
        if (options.state) {
          this.#sessions.applyLocalInferenceModelConfigToSessionsForAgent(
            LOCAL_AGENT_SERVER,
            options.state,
          );
        }
      });
    return this.#refreshQueue;
  }
}

function localInferenceRuntimeStopped(
  state: LocalInferenceState,
  previous: LocalInferenceState | null,
): boolean {
  return previous?.runtime.status === "running" && state.runtime.status !== "running";
}

function localInferenceModelSignature(state: LocalInferenceState | null): string {
  if (!state) return "";
  const modelIDs = state.catalog
    .filter((model) => model.downloaded)
    .map((model) => model.id)
    .sort();
  return [state.runtime.defaultModelId ?? "", ...modelIDs].join("\0");
}
