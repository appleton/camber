import {
  camberLocalInferenceCancelDownload,
  camberLocalInferenceDeleteModel,
  camberLocalInferenceDownloadModel,
  camberLocalInferenceGetState,
  camberLocalInferenceSearchModels,
  camberLocalInferenceSetDefaultModel,
  camberLocalInferenceUnloadModel,
} from "@camber/helperapi";
import type {
  LocalInferenceDidChangeParams,
  LocalInferenceModel,
  LocalInferenceState,
} from "@camber/helperapi/schemas";
import { getUnknownErrorMessage } from "@camber/lib/errors";
import { createContext } from "svelte";

export type LocalInferenceStateListener = (
  state: LocalInferenceState,
  previous: LocalInferenceState | null,
) => void;

// How long a snapshot counts as fresh for refreshIfStale. The helper rescans
// the models directory on every state read, so this bounds how stale on-disk
// model discovery can be while keeping repeated UI triggers (several panes,
// re-selecting the same agent) down to one round-trip.
const FRESH_STATE_MS = 5_000;

export class LocalInferenceRepository {
  state = $state<LocalInferenceState | null>(null);
  loading = $state(false);
  error = $state<string | null>(null);
  private readonly listeners = new Set<LocalInferenceStateListener>();
  #lastStateAt = 0;
  #stateVersion = 0;
  #refreshInFlight: Promise<void> | null = null;

  async refresh(): Promise<void> {
    this.loading = true;
    this.error = null;
    try {
      this.setState(await camberLocalInferenceGetState({}));
    } catch (error) {
      this.error = getUnknownErrorMessage(error);
      throw error;
    } finally {
      this.loading = false;
    }
  }

  /**
   * Best-effort refresh for UI triggers that want current state (models added
   * to the models directory outside the app are only discovered by a helper
   * state read) but can fire repeatedly. Skips the round-trip while the
   * current snapshot is younger than `maxAgeMs`, coalesces concurrent callers
   * into one request, and never rejects. Use refresh() after a mutation, where
   * the result must be authoritative and failure belongs on screen.
   */
  refreshIfStale(maxAgeMs = FRESH_STATE_MS): Promise<void> {
    if (this.#refreshInFlight) return this.#refreshInFlight;
    if (this.state && Date.now() - this.#lastStateAt < maxAgeMs) return Promise.resolve();
    // Deliberately not refresh(): nothing on screen asked for this, so it must
    // not raise the shared loading flag or leave an error banner behind in
    // whichever surface happens to render this app-wide repository.
    const version = this.#stateVersion;
    this.#refreshInFlight = camberLocalInferenceGetState({})
      .then((state) => {
        // A didChange push that landed mid-flight is newer than this response
        // (the helper enriches state from Hugging Face, so a read can take
        // seconds); applying it would roll live download progress backwards.
        if (this.#stateVersion !== version) return;
        this.setState(state);
      })
      .catch((error: unknown) => {
        console.warn("Failed to refresh local inference state", error);
      })
      .finally(() => {
        this.#refreshInFlight = null;
      });
    return this.#refreshInFlight;
  }

  applyDidChange(params: LocalInferenceDidChangeParams): void {
    this.setState(params.state);
    this.error = null;
  }

  onDidChange(listener: LocalInferenceStateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async downloadModel(modelId: string): Promise<void> {
    await this.update(() => camberLocalInferenceDownloadModel({ modelId }));
  }

  async cancelDownload(modelId: string): Promise<void> {
    await this.update(() => camberLocalInferenceCancelDownload({ modelId }));
  }

  async deleteModel(modelId: string): Promise<void> {
    await this.update(() => camberLocalInferenceDeleteModel({ modelId }));
  }

  async setDefaultModel(modelId: string): Promise<void> {
    await this.update(() => camberLocalInferenceSetDefaultModel({ modelId }));
  }

  /** Releases the model resident in the local sidecar's memory. */
  async unloadModel(): Promise<void> {
    await this.update(() => camberLocalInferenceUnloadModel({}));
  }

  async searchModels(query: string): Promise<LocalInferenceModel[]> {
    this.error = null;
    const result = await camberLocalInferenceSearchModels({ query });
    return result.models;
  }

  private async update(operation: () => Promise<LocalInferenceState>): Promise<void> {
    this.error = null;
    try {
      this.setState(await operation());
    } catch (error) {
      this.error = getUnknownErrorMessage(error);
      throw error;
    }
  }

  private setState(state: LocalInferenceState): void {
    const previous = this.state;
    this.state = state;
    this.#lastStateAt = Date.now();
    this.#stateVersion++;
    for (const listener of this.listeners) {
      listener(state, previous);
    }
  }
}

const [getLocalInferenceContext, setLocalInferenceRepositoryContext] =
  createContext<LocalInferenceRepository>();

export { getLocalInferenceContext };

export function setLocalInferenceContext(): LocalInferenceRepository {
  return setLocalInferenceRepositoryContext(new LocalInferenceRepository());
}

export { setLocalInferenceRepositoryContext as _setLocalInferenceContextForTests };

export function getLocalInferenceRepo(): LocalInferenceRepository {
  return getLocalInferenceContext();
}
