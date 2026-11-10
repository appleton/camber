import type { LocalInferenceState } from "@camber/helperapi/schemas";
import { describe, expect, it } from "vitest";
import {
  formatAutoUnload,
  formatLastPrompt,
  formatMemoryBytes,
  isExternalLocalInferenceRuntime,
  localRuntimeResidency,
  turnHasAgentOutput,
} from "./localInferenceRuntime";
import type { SessionEvent } from "./types";

const GIB = 1024 ** 3;

function stateWithRuntime(runtime: Partial<LocalInferenceState["runtime"]>): LocalInferenceState {
  return {
    modelsDirectory: "/models",
    catalog: [
      {
        id: "poolside/Laguna-XS-2.1-NVFP4-mlx",
        repoId: "poolside/Laguna-XS-2.1-NVFP4-mlx",
        name: "Laguna XS 2.1 NVFP4",
        provider: "poolside",
        downloaded: true,
      },
    ],
    runtime: {
      supported: true,
      status: "running",
      agentServer: "local",
      ...runtime,
    },
  };
}

describe("localRuntimeResidency", () => {
  it("returns the resident model with its catalog name", () => {
    const residency = localRuntimeResidency(
      stateWithRuntime({
        loadedModelId: "poolside/Laguna-XS-2.1-NVFP4-mlx",
        loadedMemoryBytes: 20 * GIB,
        lastActivityUnixMs: 1000,
        idleUnloadSeconds: 900,
      }),
    );
    expect(residency).toEqual({
      modelId: "poolside/Laguna-XS-2.1-NVFP4-mlx",
      modelName: "Laguna XS 2.1 NVFP4",
      memoryBytes: 20 * GIB,
      lastActivityUnixMs: 1000,
      idleUnloadSeconds: 900,
    });
  });

  it("falls back to the id's last segment for unknown models", () => {
    const residency = localRuntimeResidency(
      stateWithRuntime({ loadedModelId: "someone/some-model" }),
    );
    expect(residency?.modelName).toBe("some-model");
  });

  it("returns null when nothing is loaded, stopped, or state missing", () => {
    expect(localRuntimeResidency(stateWithRuntime({}))).toBeNull();
    expect(
      localRuntimeResidency(stateWithRuntime({ status: "stopped", loadedModelId: "a/b" })),
    ).toBeNull();
    expect(localRuntimeResidency(null)).toBeNull();
  });
});

describe("isExternalLocalInferenceRuntime", () => {
  it("only identifies explicitly external runtimes", () => {
    expect(isExternalLocalInferenceRuntime(stateWithRuntime({ status: "external" }))).toBe(true);
    expect(isExternalLocalInferenceRuntime(stateWithRuntime({ status: "running" }))).toBe(false);
    expect(isExternalLocalInferenceRuntime(stateWithRuntime({ status: "stopped" }))).toBe(false);
    expect(isExternalLocalInferenceRuntime(null)).toBe(false);
  });
});

describe("turnHasAgentOutput", () => {
  const user: SessionEvent = { eventKind: "user_message", messageId: null, content: [] };
  const message: SessionEvent = { eventKind: "agent_message", messageId: null, content: [] };
  const thought: SessionEvent = { eventKind: "agent_thought", messageId: null, content: [] };
  const tool: SessionEvent = { eventKind: "tool_call", toolCallId: "t1", title: "run" };
  const mode: SessionEvent = { eventKind: "mode_change", currentModeId: "default" };

  it("is false while the latest user message is still unanswered", () => {
    expect(turnHasAgentOutput([])).toBe(false);
    expect(turnHasAgentOutput([user])).toBe(false);
    expect(turnHasAgentOutput([message, user])).toBe(false);
    expect(turnHasAgentOutput([user, mode])).toBe(false);
  });

  it("is true once any agent output follows the latest user message", () => {
    expect(turnHasAgentOutput([user, message])).toBe(true);
    expect(turnHasAgentOutput([user, thought])).toBe(true);
    expect(turnHasAgentOutput([user, tool])).toBe(true);
    expect(turnHasAgentOutput([user, message, mode])).toBe(true);
  });
});

describe("formatMemoryBytes", () => {
  it("formats GB and MB scales", () => {
    expect(formatMemoryBytes(20.1 * GIB)).toBe("20 GB");
    expect(formatMemoryBytes(2.5 * GIB)).toBe("2.5 GB");
    expect(formatMemoryBytes(84 * 1024 ** 2)).toBe("84 MB");
    expect(formatMemoryBytes(0)).toBeNull();
  });
});

describe("formatLastPrompt", () => {
  it("buckets elapsed time", () => {
    const now = 10_000_000;
    expect(formatLastPrompt(now - 5_000, now)).toBe("just now");
    expect(formatLastPrompt(now - 4 * 60_000, now)).toBe("4 min ago");
    expect(formatLastPrompt(now - 2 * 3_600_000, now)).toBe("2 h ago");
    expect(formatLastPrompt(0, now)).toBeNull();
  });
});

describe("formatAutoUnload", () => {
  const base = {
    modelId: "a/b",
    modelName: "b",
    memoryBytes: GIB,
    lastActivityUnixMs: 1_000_000,
    idleUnloadSeconds: 900,
  };

  it("counts down from the last activity", () => {
    expect(formatAutoUnload(base, base.lastActivityUnixMs + 4 * 60_000)).toBe(
      "frees automatically in ~11 min",
    );
    expect(formatAutoUnload(base, base.lastActivityUnixMs + 870_000)).toBe(
      "frees automatically in under a minute",
    );
  });

  it("is silent when disabled or already due", () => {
    expect(formatAutoUnload({ ...base, idleUnloadSeconds: 0 }, base.lastActivityUnixMs)).toBeNull();
    expect(formatAutoUnload(base, base.lastActivityUnixMs + 901_000)).toBeNull();
  });
});
