import type { AnyMessage } from "@agentclientprotocol/sdk";
import { camberAcpServerRestart } from "@camber/helperapi";
import { get } from "svelte/store";
import { describe, expect, it, vi } from "vitest";
import { ACPConnectionPool } from "./ConnectionPool";
import { ACPDebugLog } from "./debugDump";
import type { ACPSessionRepositoryWriter } from "./features/SessionRepository.svelte";
import { appState } from "./hostAdapter";
import type { HelperAPIClient } from "./hostRpc";
import { RPCTransport } from "./RPCTransport";

vi.mock("@camber/helperapi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@camber/helperapi")>();
  return { ...actual, camberAcpServerRestart: vi.fn().mockResolvedValue(undefined) };
});

describe("ACPConnectionPool", () => {
  it("initializes agents with host client info", async () => {
    const initialAppState = get(appState);
    const helperApiClient = mockHelperApiClient();
    vi.mocked(helperApiClient.jsonrpcCall).mockResolvedValue({
      protocolVersion: 1,
      authMethods: [],
      agentCapabilities: {},
    });
    const pool = new ACPConnectionPool(helperApiClient, mockSessionRepo());

    try {
      appState.update((state) => ({
        ...state,
        environment: {
          ...state.environment,
          assistantHost: "desktop",
          assistantVersion: "0.3.12",
        },
      }));

      await pool.connect("poolside");

      expect(helperApiClient.jsonrpcCall).toHaveBeenCalledWith(
        "camber/acp/initialize",
        expect.objectContaining({
          agentServer: "poolside",
          clientInfo: {
            name: "camber-desktop",
            version: "0.3.12",
          },
          clientCapabilities: expect.objectContaining({
            _meta: {
              "terminal-auth": true,
              "subagent-transcript": true,
            },
          }),
        }),
      );
    } finally {
      appState.set(initialAppState);
    }
  });

  it("drops legacy ACP task notifications instead of forwarding them", () => {
    const pool = new ACPConnectionPool(mockHelperApiClient(), mockSessionRepo());
    const transport = { receive: vi.fn(), sendRequest: vi.fn() };
    connections(pool).set("poolside", { transport });

    pool.receive({
      agentServer: "poolside",
      message: {
        jsonrpc: "2.0",
        method: "camber/acpTask/didChange",
        params: { sessionId: "s1" },
      } as AnyMessage,
    });

    expect(transport.receive).not.toHaveBeenCalled();
  });

  it("forwards normal ACP messages to the transport", () => {
    const pool = new ACPConnectionPool(mockHelperApiClient(), mockSessionRepo());
    const transport = { receive: vi.fn(), sendRequest: vi.fn() };
    connections(pool).set("poolside", { transport });
    const message = {
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s1" },
    } as AnyMessage;

    pool.receive({ agentServer: "poolside", message });

    expect(transport.receive).toHaveBeenCalledWith(message);
  });

  it("buffers early notifications until their agent transport initializes", async () => {
    let resolveInitialize!: (value: unknown) => void;
    const helperApiClient = mockHelperApiClient();
    vi.mocked(helperApiClient.jsonrpcCall).mockReturnValue(
      new Promise((resolve) => {
        resolveInitialize = resolve;
      }),
    );
    const receive = vi.spyOn(RPCTransport.prototype, "receive");
    const pool = new ACPConnectionPool(helperApiClient, mockSessionRepo());
    const message = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s-early",
        update: { sessionUpdate: "available_commands_update", availableCommands: [] },
      },
    } as AnyMessage;

    try {
      expect(() => pool.receive({ agentServer: "poolside", message })).not.toThrow();
      await vi.waitFor(() =>
        expect(helperApiClient.jsonrpcCall).toHaveBeenCalledWith(
          "camber/acp/initialize",
          expect.objectContaining({ agentServer: "poolside" }),
        ),
      );

      resolveInitialize({
        protocolVersion: 1,
        authMethods: [],
        agentCapabilities: {},
      });
      await vi.waitFor(() => expect(receive).toHaveBeenCalledWith(message));
    } finally {
      receive.mockRestore();
    }
  });
});

describe("ACPConnectionPool debug API", () => {
  it("loads dumps into the selected agent server and stores them in the pool log", async () => {
    const repo = mockSessionRepo();
    const pool = new ACPConnectionPool(mockHelperApiClient(), repo);
    const entries = [
      {
        _direction: "incoming" as const,
        _type: "notification" as const,
        method: "session/update",
        params: { sessionId: "s1" },
      },
    ];

    await pool.debug.load(entries, "selected-agent");

    expect(repo.loadDebugDump).toHaveBeenCalledWith(entries, "selected-agent");
    expect(pool.debug.dump("selected-agent")).toEqual(entries);
    expect(pool.debug.dumpJSON("selected-agent")).toBe(JSON.stringify(entries, null, 2));
  });

  it("defaults debug operations to the repo default agent server", async () => {
    const repo = mockSessionRepo("repo-default");
    const pool = new ACPConnectionPool(mockHelperApiClient(), repo);
    const entries = [
      {
        _direction: "outgoing" as const,
        _type: "request" as const,
        id: 1,
        method: "session/prompt",
        params: { sessionId: "s1", prompt: [] },
      },
    ];

    await pool.debug.load(JSON.stringify(entries));

    expect(repo.loadDebugDump).toHaveBeenCalledWith(entries, "repo-default");
    expect(pool.debug.dump()).toEqual(entries);

    pool.debug.clear();

    expect(pool.debug.dump()).toEqual([]);
  });
});

describe("ACPConnectionPool restart serialization", () => {
  it("discards a handshake a restart invalidated and reconnects to the restarted process", async () => {
    const helperApiClient = mockHelperApiClient();
    const initializeResolvers: Array<(value: unknown) => void> = [];
    vi.mocked(helperApiClient.jsonrpcCall).mockImplementation(
      (method: string) =>
        new Promise((resolve) => {
          if (method === "camber/acp/initialize") {
            initializeResolvers.push(resolve);
          } else {
            resolve({ ok: true });
          }
        }),
    );
    const pool = new ACPConnectionPool(helperApiClient, mockSessionRepo());

    // A connect whose handshake is still in flight when the restart lands.
    const connecting = pool.connect("poolside");
    await vi.waitFor(() => expect(initializeResolvers).toHaveLength(1));

    await pool.restart("poolside");

    // The pre-restart handshake completes against the torn-down process; the
    // pool must not cache it, and must re-initialize the restarted process.
    initializeResolvers[0]({ protocolVersion: 1, authMethods: [], agentCapabilities: {} });
    await vi.waitFor(() => expect(initializeResolvers).toHaveLength(2));
    expect(connections(pool).size).toBe(0);

    initializeResolvers[1]({ protocolVersion: 1, authMethods: [], agentCapabilities: {} });
    await connecting;
    expect(connections(pool).size).toBe(1);
  });

  it("retries a handshake that failed because a restart tore its process down", async () => {
    const helperApiClient = mockHelperApiClient();
    const initializeAttempts: Array<{
      resolve: (value: unknown) => void;
      reject: (reason: unknown) => void;
    }> = [];
    vi.mocked(helperApiClient.jsonrpcCall).mockImplementation(
      (method: string) =>
        new Promise((resolve, reject) => {
          if (method === "camber/acp/initialize") {
            initializeAttempts.push({ resolve, reject });
          } else {
            resolve({ ok: true });
          }
        }),
    );
    const pool = new ACPConnectionPool(helperApiClient, mockSessionRepo());

    const connecting = pool.connect("poolside");
    await vi.waitFor(() => expect(initializeAttempts).toHaveLength(1));

    await pool.restart("poolside");

    // The helper fails an initialize that raced its own stop ("not
    // initialized; call initialize first"). That rejection must not reach the
    // caller — the restarted process is the one to connect to.
    initializeAttempts[0].reject(new Error("acpproxy: not initialized; call initialize first"));
    await vi.waitFor(() => expect(initializeAttempts).toHaveLength(2));

    initializeAttempts[1].resolve({ protocolVersion: 1, authMethods: [], agentCapabilities: {} });
    await expect(connecting).resolves.toBeDefined();
    expect(connections(pool).size).toBe(1);
  });

  it("surfaces a handshake failure that no restart explains", async () => {
    const helperApiClient = mockHelperApiClient();
    vi.mocked(helperApiClient.jsonrpcCall).mockRejectedValue(new Error("agent binary missing"));
    const pool = new ACPConnectionPool(helperApiClient, mockSessionRepo());

    await expect(pool.connect("poolside")).rejects.toThrow("agent binary missing");
    expect(connections(pool).size).toBe(0);
  });

  it("holds new connects until an in-flight restart finishes", async () => {
    const helperApiClient = mockHelperApiClient();
    vi.mocked(helperApiClient.jsonrpcCall).mockResolvedValue({
      protocolVersion: 1,
      authMethods: [],
      agentCapabilities: {},
    });
    let releaseRestart!: () => void;
    vi.mocked(camberAcpServerRestart).mockReturnValueOnce(
      new Promise((resolve) => {
        releaseRestart = () => resolve({});
      }),
    );
    const pool = new ACPConnectionPool(helperApiClient, mockSessionRepo());

    const restarting = pool.restart("poolside");
    const connecting = pool.connect("poolside");
    // Give the gated connect a chance to (incorrectly) start its handshake.
    await Promise.resolve();
    await Promise.resolve();
    expect(helperApiClient.jsonrpcCall).not.toHaveBeenCalledWith(
      "camber/acp/initialize",
      expect.anything(),
    );

    releaseRestart();
    await restarting;
    await connecting;
    expect(helperApiClient.jsonrpcCall).toHaveBeenCalledWith(
      "camber/acp/initialize",
      expect.objectContaining({ agentServer: "poolside" }),
    );
    expect(connections(pool).size).toBe(1);
  });
});

describe("ACPConnectionPool disconnect", () => {
  it("clears orphaned request correlations without discarding captured messages", () => {
    const pool = new ACPConnectionPool(mockHelperApiClient(), mockSessionRepo());
    const log = debugLog(pool);
    log.setSessionCollecting("poolside", "s1", true);

    // An outgoing request that never gets a response before the connection
    // drops (e.g. the helper restarts mid-flight).
    log.record("poolside", "outgoing", {
      jsonrpc: "2.0",
      id: 1,
      method: "session/prompt",
      params: { sessionId: "s1" },
    });
    log.record("poolside", "incoming", {
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s1", update: {} },
    });

    pool.disconnect("poolside");

    // A late response for the orphaned request arrives after disconnect; its
    // correlation entry was cleared, so it can no longer resolve a method
    // name or a known session and is dropped rather than misattributed.
    log.record("poolside", "incoming", {
      jsonrpc: "2.0",
      id: 1,
      result: { stopReason: "end_turn" },
    });

    const entries = pool.debug.dump("poolside");
    expect(entries.some((entry) => entry._type === "notification")).toBe(true);
    expect(entries.some((entry) => entry._type === "response")).toBe(false);
  });
});

function debugLog(pool: ACPConnectionPool): ACPDebugLog {
  return (pool as unknown as { debugLog: ACPDebugLog }).debugLog;
}

function connections(
  pool: ACPConnectionPool,
): Map<string, { transport: { receive: (msg: unknown) => void } }> {
  return (
    pool as unknown as {
      connections: Map<string, { transport: { receive: (msg: unknown) => void } }>;
    }
  ).connections;
}

function mockHelperApiClient(): HelperAPIClient {
  return {
    jsonrpcCall: vi.fn().mockResolvedValue({ ok: true }),
    jsonrpcNotify: vi.fn().mockResolvedValue(undefined),
  };
}

function mockSessionRepo(defaultAgentServer = "default-agent"): ACPSessionRepositoryWriter {
  return {
    agents: {
      defaultAgentServer,
    },
    handleSessionUpdate: vi.fn(),
    loadDebugDump: vi.fn().mockResolvedValue(undefined),
  } as unknown as ACPSessionRepositoryWriter;
}
