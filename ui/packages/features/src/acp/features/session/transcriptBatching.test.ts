import type {
  ClientSideConnection,
  InitializeResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import { initializeStatefulModule as initializeHelperApi } from "@camber/helperapi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ACPConnectionPool } from "../../ConnectionPool";
import { DEFAULT_AGENT_SERVER } from "../../agentServers";
import { ACPSessionRepositoryWriter } from "../SessionRepository.svelte";
import { enableAcpTranscriptBatching } from "./transcriptBatching";

function mockConnection(overrides: Partial<ClientSideConnection> = {}): ClientSideConnection {
  return {
    initialize: vi.fn().mockResolvedValue({}),
    newSession: vi.fn().mockResolvedValue({ sessionId: "s-new" }),
    loadSession: vi.fn().mockResolvedValue({}),
    prompt: vi.fn().mockResolvedValue({}),
    cancel: vi.fn().mockResolvedValue({}),
    setSessionMode: vi.fn().mockResolvedValue({}),
    setSessionConfigOption: vi.fn().mockResolvedValue({}),
    ...overrides,
  } as unknown as ClientSideConnection;
}

async function connectRepo(
  repo: ACPSessionRepositoryWriter,
  conn: ClientSideConnection = mockConnection(),
  initializeResponse: InitializeResponse = {
    protocolVersion: 1,
    authMethods: [],
    agentCapabilities: { loadSession: true },
  } as InitializeResponse,
): Promise<ClientSideConnection> {
  repo.agents.setConnectionPool({
    connect: vi.fn().mockResolvedValue({ conn, initializeResponse, transport: {} }),
  } as unknown as ACPConnectionPool);
  await repo.agents.connect();
  return conn;
}

function streamingNotification(text: string, sessionId = "s-loaded"): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    },
  } as SessionNotification;
}

beforeEach(() => {
  initializeHelperApi({
    jsonrpcCall: vi.fn().mockResolvedValue({ entry: null }),
    jsonrpcNotify: vi.fn().mockResolvedValue(undefined),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("ACP transcript batching", () => {
  it("publishes session.events synchronously when batching is disabled (default)", async () => {
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo);
    const session = await repo.loadSessionRecord(
      "s-loaded",
      "/repo",
      [],
      undefined,
      DEFAULT_AGENT_SERVER,
    );
    expect(session).not.toBeNull();

    repo.handleSessionUpdate(DEFAULT_AGENT_SERVER, streamingNotification("hello"));

    // Without batching, events are visible immediately — no RAF needed
    expect(session!.events).toHaveLength(1);
    expect(session!.events[0]).toMatchObject({ eventKind: "agent_message" });
  });

  it("coalesces streaming chunks into one frame-aligned 32ms flush", async () => {
    // Stub requestAnimationFrame / cancelAnimationFrame before enabling batching
    const rafQueue: Array<(t: number) => void> = [];
    let nextHandle = 1;
    vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => {
      rafQueue.push(cb);
      return nextHandle++;
    });
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
      // Remove the callback at index handle-1 (handles start at 1)
      const idx = handle - 1;
      if (idx >= 0 && idx < rafQueue.length) {
        rafQueue.splice(idx, 1);
      }
    });

    enableAcpTranscriptBatching();

    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo);
    const session = await repo.loadSessionRecord(
      "s-loaded",
      "/repo",
      [],
      undefined,
      DEFAULT_AGENT_SERVER,
    );
    expect(session).not.toBeNull();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    // Snapshot of events before the burst
    const eventsBefore = session!.events;

    // Drive a large arrival burst. Materialization may process every protocol
    // update, but reactive transcript state (and therefore the DOM) publishes
    // only once on the next animation frame.
    for (let index = 0; index < 1_000; index++) {
      repo.handleSessionUpdate(DEFAULT_AGENT_SERVER, streamingNotification(`chunk ${index}`));
    }

    // Events stay deferred throughout the visible cadence and the entire burst
    // shares one timer rather than scheduling one publication per chunk.
    expect(session!.events).toBe(eventsBefore);
    expect(vi.getTimerCount()).toBe(1);
    expect(rafQueue).toHaveLength(0);
    vi.advanceTimersByTime(31);
    expect(rafQueue).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(rafQueue).toHaveLength(1);

    // Flush the queued RAF callback
    const flushAll = () => {
      const callbacks = rafQueue.splice(0);
      for (const cb of callbacks) cb(performance.now());
    };
    flushAll();
    expect(vi.getTimerCount()).toBe(0);

    // Now events should reflect the full burst (materializer has every chunk).
    expect(session!.events).toHaveLength(1); // one agent_message event composed of chunks
    expect(session!.events[0]).toMatchObject({ eventKind: "agent_message" });
  });

  it("caps sustained visible streaming at one transcript publication per 32ms", async () => {
    const rafQueue: Array<(t: number) => void> = [];
    let nextHandle = 1;
    vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => {
      rafQueue.push(cb);
      return nextHandle++;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    enableAcpTranscriptBatching();
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo);
    const session = await repo.loadSessionRecord(
      "s-loaded",
      "/repo",
      [],
      undefined,
      DEFAULT_AGENT_SERVER,
    );
    expect(session).not.toBeNull();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const publishedSnapshots = new Set<unknown>();
    for (let window = 0; window < 10; window++) {
      for (let chunk = 0; chunk < 100; chunk++) {
        repo.handleSessionUpdate(DEFAULT_AGENT_SERVER, streamingNotification(`${window}:${chunk}`));
      }

      vi.advanceTimersByTime(32);
      expect(rafQueue).toHaveLength(1);
      rafQueue.shift()!(performance.now());
      publishedSnapshots.add(session!.events);
    }

    expect(publishedSnapshots.size).toBe(10);
  });

  it("immediate (non-streaming) publish flushes synchronously and cancels any pending RAF", async () => {
    const rafQueue: Array<(t: number) => void> = [];
    let nextHandle = 1;
    vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => {
      rafQueue.push(cb);
      return nextHandle++;
    });
    vi.stubGlobal("cancelAnimationFrame", (_handle: number) => {
      rafQueue.length = 0;
    });

    enableAcpTranscriptBatching();

    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo);
    const session = await repo.loadSessionRecord(
      "s-loaded",
      "/repo",
      [],
      undefined,
      DEFAULT_AGENT_SERVER,
    );
    expect(session).not.toBeNull();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    // Queue a streaming chunk, then advance to the frame-aligned stage.
    repo.handleSessionUpdate(DEFAULT_AGENT_SERVER, streamingNotification("streaming"));
    expect(vi.getTimerCount()).toBe(1);
    expect(rafQueue).toHaveLength(0);
    vi.advanceTimersByTime(32);
    expect(rafQueue).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1); // rAF fallback

    // Trigger an immediate (non-streaming) publish via addUserMessage
    session!.addUserMessage("user says something");

    // The pending RAF and fallback timer are cancelled and state is current.
    expect(rafQueue).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(session!.events.length).toBeGreaterThan(0);

    // No stale double-publish if the RAF were somehow to fire now
    // (queue is empty, so nothing would fire)
  });
});
