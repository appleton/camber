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

// Note on timer setup ordering in these tests: vi.useFakeTimers must be
// enabled only AFTER the async repo setup (loadedRepoSession) has resolved.
// Faking setTimeout earlier would stall the awaited connect/load promises and
// hang the test. That is also why animation frames are stubbed separately via
// this helper rather than through vi.useFakeTimers({ toFake: [...] }).
function stubAnimationFrames(): Array<(t: number) => void> {
  const rafQueue: Array<(t: number) => void> = [];
  let nextHandle = 1;
  vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => {
    rafQueue.push(cb);
    return nextHandle++;
  });
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
    const idx = handle - 1;
    if (idx >= 0 && idx < rafQueue.length) {
      rafQueue.splice(idx, 1);
    }
  });
  return rafQueue;
}

async function loadedRepoSession() {
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
  return { repo, session: session! };
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

describe("ACP transcript visibility", () => {
  it("moves unclaimed sessions to the slow timer cadence instead of RAF", async () => {
    const rafQueue = stubAnimationFrames();
    enableAcpTranscriptBatching();
    const { repo, session } = await loadedRepoSession();

    // Some other conversation is on screen; the loaded session is hidden.
    repo.claimVisibleConversation("some-other-conversation");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const eventsBefore = session.events;
    repo.handleSessionUpdate(DEFAULT_AGENT_SERVER, streamingNotification("chunk 1"));
    repo.handleSessionUpdate(DEFAULT_AGENT_SERVER, streamingNotification(" chunk 2"));

    // Hidden sessions schedule no animation frame and stay unpublished ...
    expect(rafQueue).toHaveLength(0);
    expect(session.events).toBe(eventsBefore);

    // ... until the slow hidden-cadence timer fires.
    vi.advanceTimersByTime(1000);
    expect(session.events).toHaveLength(1);
    expect(session.events[0]).toMatchObject({ eventKind: "agent_message" });
  });

  it("flushes a pending hidden update the moment its conversation is claimed", async () => {
    stubAnimationFrames();
    enableAcpTranscriptBatching();
    const { repo, session } = await loadedRepoSession();

    repo.claimVisibleConversation("some-other-conversation");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    repo.handleSessionUpdate(DEFAULT_AGENT_SERVER, streamingNotification("while hidden"));
    expect(session.events).toHaveLength(0);

    // Opening the conversation publishes synchronously — no timer advance.
    repo.claimVisibleConversation(session.conversationId);
    expect(session.events).toHaveLength(1);
  });

  it("returns a released conversation to the hidden cadence", async () => {
    const rafQueue = stubAnimationFrames();
    enableAcpTranscriptBatching();
    const { repo, session } = await loadedRepoSession();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const release = repo.claimVisibleConversation(session.conversationId);
    repo.handleSessionUpdate(DEFAULT_AGENT_SERVER, streamingNotification("visible"));
    expect(rafQueue).toHaveLength(0);
    vi.advanceTimersByTime(32);
    expect(rafQueue).toHaveLength(1);
    rafQueue.splice(0).forEach((cb) => cb(0));

    release();
    repo.handleSessionUpdate(DEFAULT_AGENT_SERVER, streamingNotification(" hidden"));
    expect(rafQueue).toHaveLength(0);

    vi.advanceTimersByTime(1000);
    expect(session.events).toHaveLength(1);
  });

  it("reschedules a pending visible update when the surface is hidden", async () => {
    const rafQueue = stubAnimationFrames();
    enableAcpTranscriptBatching();
    const { repo, session } = await loadedRepoSession();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const release = repo.claimVisibleConversation(session.conversationId);
    const eventsBefore = session.events;
    repo.handleSessionUpdate(DEFAULT_AGENT_SERVER, streamingNotification("visible then hidden"));
    release();

    vi.advanceTimersByTime(32);
    expect(rafQueue).toHaveLength(0);
    expect(session.events).toBe(eventsBefore);

    vi.advanceTimersByTime(968);
    expect(session.events).toHaveLength(1);
  });

  it("keeps sessions on the visible cadence when no surface has ever claimed", async () => {
    const rafQueue = stubAnimationFrames();
    enableAcpTranscriptBatching();
    const { repo } = await loadedRepoSession();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    repo.handleSessionUpdate(DEFAULT_AGENT_SERVER, streamingNotification("chunk"));
    expect(rafQueue).toHaveLength(0);
    vi.advanceTimersByTime(32);
    expect(rafQueue).toHaveLength(1);
  });

  it("counts overlapping claims and keeps the pendingApprovals identity stable", async () => {
    const rafQueue = stubAnimationFrames();
    enableAcpTranscriptBatching();
    const { repo, session } = await loadedRepoSession();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const releaseA = repo.claimVisibleConversation(session.conversationId);
    const releaseB = repo.claimVisibleConversation(session.conversationId);
    releaseA();
    releaseA(); // double release is a no-op

    // Still claimed by B: streaming publishes on the visible frame-aligned cadence.
    repo.handleSessionUpdate(DEFAULT_AGENT_SERVER, streamingNotification("chunk"));
    expect(rafQueue).toHaveLength(0);
    vi.advanceTimersByTime(32);
    expect(rafQueue).toHaveLength(1);
    releaseB();

    const approvalsBefore = repo.pendingApprovals;
    repo.publishLiveStatuses();
    expect(repo.pendingApprovals).toBe(approvalsBefore);
  });
});
