import type { LocalInferenceModel, LocalInferenceState } from "@camber/helperapi/schemas";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LocalInferenceAgentSync,
  type LocalInferenceAgentSyncSessions,
} from "./LocalInferenceAgentSync";
import type { LocalInferenceStateListener } from "./LocalInferenceRepository.svelte";

describe("LocalInferenceAgentSync", () => {
  let listener: LocalInferenceStateListener;
  let sessions: LocalInferenceAgentSyncSessions & {
    agents: {
      restart: ReturnType<typeof vi.fn>;
      refreshCachedConfig: ReturnType<typeof vi.fn>;
      upsertLocalInferenceModelConfigOptions: ReturnType<typeof vi.fn>;
    };
    applyCachedConfigToLocalSessionsForAgent: ReturnType<typeof vi.fn>;
    applyLocalInferenceModelConfigToSessionsForAgent: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    sessions = {
      agents: {
        restart: vi.fn(async () => {}),
        refreshCachedConfig: vi.fn(async () => {}),
        upsertLocalInferenceModelConfigOptions: vi.fn(async () => null),
      },
      applyCachedConfigToLocalSessionsForAgent: vi.fn(),
      applyLocalInferenceModelConfigToSessionsForAgent: vi.fn(),
    };
    new LocalInferenceAgentSync(
      {
        onDidChange: (next) => {
          listener = next;
          return () => {};
        },
      },
      sessions,
    );
  });

  it("refreshes the local agent config when a downloaded model appears", async () => {
    const previous = state([model("a", false)]);
    const next = state([model("a", true)]);

    listener(next, previous);
    await flush();

    expect(sessions.agents.upsertLocalInferenceModelConfigOptions).toHaveBeenCalledWith(
      "local",
      next,
    );
    expect(sessions.agents.refreshCachedConfig).toHaveBeenCalledWith("local", "/", {
      fresh: true,
    });
    expect(sessions.agents.restart).not.toHaveBeenCalled();
    expect(sessions.applyCachedConfigToLocalSessionsForAgent).toHaveBeenCalledWith("local");
    expect(sessions.applyLocalInferenceModelConfigToSessionsForAgent).toHaveBeenCalledWith(
      "local",
      next,
    );
  });

  it("refreshes when the default model changes", async () => {
    const previous = state([model("a", true)], "running", "a");
    const next = state([model("a", true)], "running", "b");

    listener(next, previous);
    await flush();

    expect(sessions.agents.refreshCachedConfig).toHaveBeenCalled();
  });

  it("does nothing when the downloaded set and default model are unchanged", async () => {
    const previous = state([model("a", true), model("b", false)]);
    const next = state([model("a", true), model("b", false)]);

    listener(next, previous);
    await flush();

    expect(sessions.agents.upsertLocalInferenceModelConfigOptions).not.toHaveBeenCalled();
    expect(sessions.agents.refreshCachedConfig).not.toHaveBeenCalled();
    expect(sessions.agents.restart).not.toHaveBeenCalled();
  });

  it("restarts the local agent when the sidecar stops", async () => {
    const previous = state([model("a", true)], "running");
    const next = state([model("a", true)], "stopped");

    listener(next, previous);
    await flush();

    expect(sessions.agents.restart).toHaveBeenCalledWith("local");
    expect(sessions.agents.refreshCachedConfig).toHaveBeenCalledWith("local", "/", {
      fresh: true,
    });
    // The restart happens before the config refresh.
    expect(sessions.agents.restart.mock.invocationCallOrder[0]).toBeLessThan(
      sessions.agents.refreshCachedConfig.mock.invocationCallOrder[0],
    );
  });

  it("does not restart when the runtime was not previously running", async () => {
    const previous = state([model("a", true)], "stopped");
    const next = state([model("a", true)], "stopped");

    listener(next, previous);
    await flush();

    expect(sessions.agents.restart).not.toHaveBeenCalled();
  });

  it("serializes overlapping refreshes", async () => {
    const order: string[] = [];
    let releaseFirst = () => {};
    sessions.agents.refreshCachedConfig
      .mockImplementationOnce(async () => {
        order.push("refresh-1-start");
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        order.push("refresh-1-end");
      })
      .mockImplementationOnce(async () => {
        order.push("refresh-2");
      });

    listener(state([model("a", true)]), state([model("a", false)]));
    listener(state([model("a", true), model("b", true)]), state([model("a", true)]));
    await flush();
    expect(order).toEqual(["refresh-1-start"]);

    releaseFirst();
    await flush();
    expect(order).toEqual(["refresh-1-start", "refresh-1-end", "refresh-2"]);
  });

  it("keeps refreshing after an earlier refresh fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    sessions.agents.refreshCachedConfig.mockRejectedValueOnce(new Error("boom"));

    listener(state([model("a", true)]), state([model("a", false)]));
    await flush();
    listener(state([model("a", true), model("b", true)]), state([model("a", true)]));
    await flush();

    expect(sessions.agents.refreshCachedConfig).toHaveBeenCalledTimes(2);
    expect(consoleError).toHaveBeenCalledWith(
      "Failed to refresh local ACP model options",
      expect.any(Error),
    );
    consoleError.mockRestore();
  });

  it("stops listening after dispose", async () => {
    let unsubscribed = false;
    const sync = new LocalInferenceAgentSync(
      {
        onDidChange: () => () => {
          unsubscribed = true;
        },
      },
      sessions,
    );

    sync.dispose();

    expect(unsubscribed).toBe(true);
  });
});

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

function state(
  catalog: LocalInferenceModel[],
  status = "running",
  defaultModelId = "default-model",
): LocalInferenceState {
  return {
    catalog,
    modelsDirectory: "/tmp/models",
    runtime: {
      supported: true,
      status,
      agentServer: "local",
      defaultModelId,
    },
  };
}

function model(id: string, downloaded: boolean): LocalInferenceModel {
  return {
    id,
    repoId: id,
    name: id,
    provider: "provider",
    downloaded,
  };
}
