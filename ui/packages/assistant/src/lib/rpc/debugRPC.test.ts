import type { ACPDebugAPI } from "@camber/features/acp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACP_DEBUG_RPC_METHODS, acpDebugRPCHandlers } from "./acpDebugRPC";
import { DEBUG_RPC_EVENTS, installDebugRPC, requestDebugRPCInWindow } from "./debugRPC";

let disposeDebugRPC: (() => void) | undefined;

afterEach(() => {
  disposeDebugRPC?.();
  disposeDebugRPC = undefined;
  vi.useRealTimers();
});

describe("Debug RPC", () => {
  it("round-trips requests through the shared event server and client", async () => {
    const echo = vi.fn(async (params) => ({ echoed: params }));
    disposeDebugRPC = installDebugRPC({ echo });

    await expect(
      requestDebugRPCInWindow({
        events: DEBUG_RPC_EVENTS,
        method: "echo",
        params: { message: "hello" },
      }),
    ).resolves.toEqual({ echoed: { message: "hello" } });

    expect(echo).toHaveBeenCalledWith({ message: "hello" });
  });

  it("uses the same ACP debug method names for dump and load", async () => {
    const debug = {
      capture: {
        state: vi.fn(() => ({
          collecting: false,
          pendingConversations: [],
          sessions: [],
        })),
        subscribe: vi.fn(() => () => {}),
        setConversationCollecting: vi.fn(),
        resetConversationCollecting: vi.fn(),
        isConversationCollecting: vi.fn(() => true),
        bindConversationSession: vi.fn(),
        setSessionCollecting: vi.fn(),
        resetSessionCollecting: vi.fn(),
        isCollecting: vi.fn(() => true),
      },
      subscribeEntries: vi.fn(() => () => {}),
      dump: vi.fn(),
      dumpJSON: vi.fn((agentServer?: string) => JSON.stringify([{ agentServer }])),
      clear: vi.fn(),
      load: vi.fn(async () => {}),
      restartServer: vi.fn(async () => {}),
    } satisfies ACPDebugAPI;
    disposeDebugRPC = installDebugRPC(acpDebugRPCHandlers(debug));

    await expect(
      requestDebugRPCInWindow<string>({
        events: DEBUG_RPC_EVENTS,
        method: ACP_DEBUG_RPC_METHODS.dumpJSON,
        params: { agentServer: "codex" },
      }),
    ).resolves.toBe('[{"agentServer":"codex"}]');
    expect(debug.dumpJSON).toHaveBeenCalledWith("codex");

    await requestDebugRPCInWindow({
      events: DEBUG_RPC_EVENTS,
      method: ACP_DEBUG_RPC_METHODS.loadDump,
      params: { entries: "[]", agentServer: "codex" },
    });
    expect(debug.load).toHaveBeenCalledWith("[]", "codex");

    await requestDebugRPCInWindow({
      events: DEBUG_RPC_EVENTS,
      method: ACP_DEBUG_RPC_METHODS.restartServer,
      params: { agentServer: "codex" },
    });
    expect(debug.restartServer).toHaveBeenCalledWith("codex");
  });

  it("rejects unknown methods and handler failures", async () => {
    disposeDebugRPC = installDebugRPC({
      fail: () => {
        throw new Error("handler failed");
      },
    });

    await expect(
      requestDebugRPCInWindow({
        events: DEBUG_RPC_EVENTS,
        method: "missing",
      }),
    ).rejects.toThrow("Unknown debug RPC method: missing");

    await expect(
      requestDebugRPCInWindow({
        events: DEBUG_RPC_EVENTS,
        method: "fail",
      }),
    ).rejects.toThrow("handler failed");
  });

  it("rejects when no bridge responds", async () => {
    vi.useFakeTimers();

    const request = requestDebugRPCInWindow({
      events: DEBUG_RPC_EVENTS,
      method: "missing",
      timeoutMs: 25,
    });
    const assertion = expect(request).rejects.toThrow("Debug RPC bridge is not available");

    await vi.advanceTimersByTimeAsync(25);

    await assertion;
  });
});
