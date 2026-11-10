import { camberLocalInferenceGetState } from "@camber/helperapi";
import type { LocalInferenceState } from "@camber/helperapi/schemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalInferenceRepository } from "./LocalInferenceRepository.svelte";

vi.mock("@camber/helperapi", () => ({
  camberLocalInferenceCancelDownload: vi.fn(),
  camberLocalInferenceDeleteModel: vi.fn(),
  camberLocalInferenceDownloadModel: vi.fn(),
  camberLocalInferenceGetState: vi.fn(),
  camberLocalInferenceSearchModels: vi.fn(),
  camberLocalInferenceSetDefaultModel: vi.fn(),
}));

const getState = vi.mocked(camberLocalInferenceGetState);

describe("LocalInferenceRepository", () => {
  it("notifies listeners with the new and previous state", () => {
    const repo = new LocalInferenceRepository();
    const listener = vi.fn();
    repo.onDidChange(listener);
    const first = state("model-a");
    const second = state("model-b");

    repo.applyDidChange({ state: first });
    repo.applyDidChange({ state: second });

    expect(listener).toHaveBeenNthCalledWith(1, first, null);
    expect(listener).toHaveBeenNthCalledWith(2, second, first);
  });

  it("removes listeners when disposed", () => {
    const repo = new LocalInferenceRepository();
    const listener = vi.fn();
    const dispose = repo.onDidChange(listener);

    dispose();
    repo.applyDidChange({ state: state("model-a") });

    expect(listener).not.toHaveBeenCalled();
  });

  describe("refreshIfStale", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      getState.mockReset();
      getState.mockResolvedValue(state("model-a"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("fetches when there is no state yet", async () => {
      const repo = new LocalInferenceRepository();

      await repo.refreshIfStale();

      expect(getState).toHaveBeenCalledTimes(1);
      expect(repo.state).not.toBeNull();
    });

    it("skips the fetch while the current state is fresh", async () => {
      const repo = new LocalInferenceRepository();
      await repo.refreshIfStale();

      vi.advanceTimersByTime(1_000);
      await repo.refreshIfStale();

      expect(getState).toHaveBeenCalledTimes(1);
    });

    it("fetches again once the current state has aged out", async () => {
      const repo = new LocalInferenceRepository();
      await repo.refreshIfStale();

      vi.advanceTimersByTime(10_000);
      await repo.refreshIfStale();

      expect(getState).toHaveBeenCalledTimes(2);
    });

    it("coalesces concurrent callers into one fetch", async () => {
      const repo = new LocalInferenceRepository();

      await Promise.all([repo.refreshIfStale(), repo.refreshIfStale(), repo.refreshIfStale()]);

      expect(getState).toHaveBeenCalledTimes(1);
    });

    it("retries after a failed fetch instead of holding the in-flight request", async () => {
      const repo = new LocalInferenceRepository();
      getState.mockRejectedValueOnce(new Error("helper unavailable"));

      await repo.refreshIfStale();
      await repo.refreshIfStale();

      expect(getState).toHaveBeenCalledTimes(2);
      expect(repo.state).not.toBeNull();
    });

    // Nothing on screen asked for this refresh, so a failure must not leave an
    // error banner behind in whichever surface renders the shared repository.
    it("keeps a failed background fetch off screen", async () => {
      const repo = new LocalInferenceRepository();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      getState.mockRejectedValueOnce(new Error("helper unavailable"));

      await repo.refreshIfStale();

      expect(repo.error).toBeNull();
      expect(repo.loading).toBe(false);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    // A helper state read can take seconds (it enriches from Hugging Face), so
    // a pushed update can land first; applying the older response afterwards
    // would roll live download progress backwards.
    it("drops a response that a pushed state change has superseded", async () => {
      const repo = new LocalInferenceRepository();
      getState.mockImplementationOnce(async () => {
        repo.applyDidChange({ state: state("pushed-model") });
        return state("stale-model");
      });

      await repo.refreshIfStale();

      expect(repo.state?.runtime.defaultModelId).toBe("pushed-model");
    });

    // A didChange push carries a full helper snapshot, so it resets staleness
    // the same way an explicit fetch does.
    it("treats a pushed state change as fresh", async () => {
      const repo = new LocalInferenceRepository();
      repo.applyDidChange({ state: state("model-a") });

      await repo.refreshIfStale();

      expect(getState).not.toHaveBeenCalled();
    });
  });
});

function state(modelID: string): LocalInferenceState {
  return {
    modelsDirectory: "/tmp/models",
    catalog: [
      {
        id: modelID,
        repoId: modelID,
        name: modelID,
        provider: "provider",
        downloaded: true,
      },
    ],
    runtime: {
      supported: true,
      status: "stopped",
      agentServer: "local",
      defaultModelId: modelID,
    },
  };
}
