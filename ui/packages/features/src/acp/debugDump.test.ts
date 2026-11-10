import { describe, expect, it, vi } from "vitest";
import {
  ACPDebugLog,
  MAX_ACP_DEBUG_LOG_BYTES_PER_AGENT,
  type ACPDebugCaptureState,
} from "./debugDump";

function notification(sequence: number, payloadSize = 160) {
  return {
    jsonrpc: "2.0",
    method: "session/update",
    params: { sequence, payload: "x".repeat(payloadSize) },
  };
}

function sessionNotification(sessionId: string, sequence: number, payloadSize = 160) {
  return {
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, sequence, payload: "x".repeat(payloadSize) },
  };
}

describe("ACPDebugLog collection", () => {
  it("starts with collection off and records only after collection is enabled", () => {
    const log = new ACPDebugLog();
    log.record("agent", "incoming", sessionNotification("session", 1));
    expect(log.dump("agent")).toEqual([]);

    log.setSessionCollecting("agent", "session", true);
    log.record("agent", "incoming", sessionNotification("session", 2));
    expect(log.dump("agent")).toHaveLength(1);

    log.setSessionCollecting("agent", "session", false);
    log.record("agent", "incoming", sessionNotification("session", 3));
    expect(log.dump("agent")).toHaveLength(1);
  });

  it("collects from before the first prompt and promotes the pending conversation to its session", () => {
    const log = new ACPDebugLog();
    log.setConversationCollecting("agent", "conversation-1", null, true);

    log.record("agent", "outgoing", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    log.record("agent", "incoming", {
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: 1 },
    });
    log.record("agent", "outgoing", {
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: {
        cwd: "/repo",
        _meta: { "camber/conversation_id": "conversation-1" },
      },
    });
    log.record("agent", "incoming", {
      jsonrpc: "2.0",
      id: 2,
      result: { sessionId: "session-1" },
    });
    log.record("agent", "outgoing", {
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId: "session-1", prompt: [] },
    });

    expect(log.dump("agent").map((entry) => entry.method)).toEqual([
      "initialize",
      "initialize",
      "session/new",
      "session/new",
      "session/prompt",
    ]);
    expect(log.isConversationCollecting("agent", "conversation-1", "session-1")).toBe(true);
    expect(log.captureState()).toEqual({
      collecting: false,
      pendingConversations: [],
      sessions: [{ agentServer: "agent", sessionId: "session-1", collecting: true }],
    });
  });

  it("keeps collecting when the app explicitly binds a pending conversation to its session", () => {
    const log = new ACPDebugLog();
    log.setConversationCollecting("agent", "conversation-1", null, true);

    log.bindConversationSession("agent", "conversation-1", "session-1");
    log.record("agent", "outgoing", {
      jsonrpc: "2.0",
      id: 1,
      method: "session/prompt",
      params: { sessionId: "session-1", prompt: [] },
    });

    expect(log.isConversationCollecting("agent", "conversation-1", "session-1")).toBe(true);
    expect(log.dump("agent").map((entry) => entry.method)).toEqual(["session/prompt"]);
    expect(log.captureState()).toEqual({
      collecting: false,
      pendingConversations: [],
      sessions: [{ agentServer: "agent", sessionId: "session-1", collecting: true }],
    });
  });

  it("does not apply one pending conversation's opt-in to another conversation", () => {
    const log = new ACPDebugLog();
    log.setConversationCollecting("agent", "wanted", null, true);

    log.record("agent", "outgoing", {
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: {
        cwd: "/repo",
        _meta: { "camber/conversation_id": "other" },
      },
    });
    log.record("agent", "incoming", {
      jsonrpc: "2.0",
      id: 1,
      result: { sessionId: "other-session" },
    });

    expect(log.dump("agent")).toEqual([]);
    expect(log.isConversationCollecting("agent", "wanted", null)).toBe(true);
    expect(log.isConversationCollecting("agent", "other", "other-session")).toBe(false);
  });

  it("can stop pending collection before the first prompt", () => {
    const log = new ACPDebugLog();
    log.setConversationCollecting("agent", "conversation-1", null, true);
    log.setConversationCollecting("agent", "conversation-1", null, false);

    log.record("agent", "outgoing", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });

    expect(log.dump("agent")).toEqual([]);
    expect(log.captureState()).toEqual({
      collecting: false,
      pendingConversations: [],
      sessions: [],
    });
  });

  it("stops collecting for one session without affecting others", () => {
    const log = new ACPDebugLog();
    log.setSessionCollecting("agent", "muted", true);
    log.setSessionCollecting("agent", "other", true);
    log.setSessionCollecting("agent", "muted", false);

    log.record("agent", "incoming", sessionNotification("muted", 1));
    log.record("agent", "incoming", sessionNotification("other", 2));

    const entries = log.dump("agent");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.params).toMatchObject({ sessionId: "other" });
  });

  it("collects an enabled session while frames without a known session stay uncollected", () => {
    const log = new ACPDebugLog();
    log.setSessionCollecting("agent", "wanted", true);

    log.record("agent", "incoming", sessionNotification("wanted", 1));
    log.record("agent", "incoming", sessionNotification("other", 2));
    log.record("agent", "incoming", notification(3));

    const entries = log.dump("agent");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.params).toMatchObject({ sessionId: "wanted" });
  });

  it("drops responses correlated with a stopped session", () => {
    const log = new ACPDebugLog();
    log.setSessionCollecting("agent", "other", true);
    log.setSessionCollecting("agent", "muted", false);
    log.record("agent", "outgoing", {
      jsonrpc: "2.0",
      id: 9,
      method: "session/prompt",
      params: { sessionId: "muted" },
    });
    log.record("agent", "incoming", {
      jsonrpc: "2.0",
      id: 9,
      result: { stopReason: "end_turn" },
    });

    expect(log.dump("agent")).toEqual([]);
  });

  it("correlates responses with requests made while collection was off", () => {
    const log = new ACPDebugLog();
    log.record("agent", "outgoing", {
      jsonrpc: "2.0",
      id: 42,
      method: "session/prompt",
      params: { sessionId: "wanted" },
    });
    log.setSessionCollecting("agent", "wanted", true);
    log.record("agent", "incoming", {
      jsonrpc: "2.0",
      id: 42,
      result: { stopReason: "end_turn" },
    });

    const entries = log.dump("agent");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ _type: "response", method: "session/prompt" });
  });

  it("keeps incoming and outgoing request ID namespaces separate", () => {
    const log = new ACPDebugLog();
    log.setSessionCollecting("agent", "client-session", true);
    log.setSessionCollecting("agent", "agent-session", true);

    log.record("agent", "outgoing", {
      jsonrpc: "2.0",
      id: 7,
      method: "session/prompt",
      params: { sessionId: "client-session" },
    });
    log.record("agent", "incoming", {
      jsonrpc: "2.0",
      id: 7,
      method: "session/request_permission",
      params: { sessionId: "agent-session" },
    });
    log.record("agent", "incoming", {
      jsonrpc: "2.0",
      id: 7,
      result: { stopReason: "end_turn" },
    });
    log.record("agent", "outgoing", {
      jsonrpc: "2.0",
      id: 7,
      result: { outcome: { outcome: "selected" } },
    });

    const entries = log.dump("agent");
    expect(entries).toHaveLength(4);
    expect(entries[2]).toMatchObject({
      _direction: "incoming",
      _type: "response",
      method: "session/prompt",
    });
    expect(entries[3]).toMatchObject({
      _direction: "outgoing",
      _type: "response",
      method: "session/request_permission",
    });
  });

  it("publishes non-persistent collection state changes", () => {
    const log = new ACPDebugLog();
    const states: ACPDebugCaptureState[] = [];
    const unsubscribe = log.subscribeCapture((state) => states.push(state));

    log.setSessionCollecting("agent", "session", true);
    log.setSessionCollecting("agent", "session", true);
    log.setSessionCollecting("agent", "session", false);
    log.setSessionCollecting("agent", "other-session", true);
    unsubscribe();
    log.setSessionCollecting("agent", "session", true);

    expect(states).toEqual([
      { collecting: false, pendingConversations: [], sessions: [] },
      {
        collecting: false,
        pendingConversations: [],
        sessions: [{ agentServer: "agent", sessionId: "session", collecting: true }],
      },
      {
        collecting: false,
        pendingConversations: [],
        sessions: [{ agentServer: "agent", sessionId: "session", collecting: false }],
      },
      {
        collecting: false,
        pendingConversations: [],
        sessions: [
          { agentServer: "agent", sessionId: "session", collecting: false },
          { agentServer: "agent", sessionId: "other-session", collecting: true },
        ],
      },
    ]);
  });

  it("resets an archived session to stopped", () => {
    const log = new ACPDebugLog();
    log.setSessionCollecting("agent", "session", true);

    log.resetSessionCollecting("agent", "session");

    expect(log.isCollecting("agent", "session")).toBe(false);
    expect(log.captureState()).toEqual({
      collecting: false,
      pendingConversations: [],
      sessions: [{ agentServer: "agent", sessionId: "session", collecting: false }],
    });
  });

  it("resets all collection state when a new app instance is created", () => {
    const previousInstance = new ACPDebugLog();
    previousInstance.setSessionCollecting("agent", "session", true);

    const restartedInstance = new ACPDebugLog();
    restartedInstance.record("agent", "incoming", sessionNotification("session", 1));

    expect(restartedInstance.captureState()).toEqual({
      collecting: false,
      pendingConversations: [],
      sessions: [],
    });
    expect(restartedInstance.dump("agent")).toEqual([]);
  });

  it("notifies entry subscribers as frames are recorded", () => {
    const log = new ACPDebugLog();
    log.setSessionCollecting("agent", "session", true);
    const listener = vi.fn();
    const unsubscribe = log.subscribeEntries(listener);

    log.record("agent", "incoming", sessionNotification("session", 1));
    expect(listener).toHaveBeenCalledWith("agent");

    log.setSessionCollecting("agent", "session", false);
    log.record("agent", "incoming", sessionNotification("session", 2));
    expect(listener).toHaveBeenCalledTimes(1);

    log.setSessionCollecting("agent", "session", true);
    log.clear("agent");
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    log.record("agent", "incoming", sessionNotification("session", 3));
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("ACPDebugLog memory bounds", () => {
  it("evicts the oldest frames while retaining the newest within the per-agent budget", () => {
    const log = new ACPDebugLog(1_500);
    log.setSessionCollecting("agent", "session", true);
    for (let sequence = 0; sequence < 10; sequence++) {
      log.record("agent", "incoming", sessionNotification("session", sequence));
    }

    const entries = log.dump("agent");
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.length).toBeLessThan(10);
    expect(entries.at(-1)?.params).toMatchObject({ sequence: 9 });
    expect(entries[0]?.params).not.toMatchObject({ sequence: 0 });
  });

  it("does not retain a single frame larger than the entire budget", () => {
    const log = new ACPDebugLog(512);
    log.setSessionCollecting("agent", "session", true);
    log.record("agent", "incoming", sessionNotification("session", 1, 1_000));
    expect(log.dump("agent")).toEqual([]);
  });

  it("applies the same bound when a debug dump is loaded", () => {
    const log = new ACPDebugLog(1_500);
    const entries = Array.from({ length: 10 }, (_, sequence) => ({
      _direction: "incoming" as const,
      _type: "notification" as const,
      method: "session/update",
      params: { sequence, payload: "x".repeat(160) },
    }));

    log.replace("agent", entries);

    const retained = log.dump("agent");
    expect(retained.length).toBeLessThan(entries.length);
    expect(retained.at(-1)?.params).toMatchObject({ sequence: 9 });
  });

  it("keeps separate budgets for separate agents", () => {
    const log = new ACPDebugLog(1_500);
    log.setSessionCollecting("first", "session", true);
    log.setSessionCollecting("second", "session", true);
    for (let sequence = 0; sequence < 5; sequence++) {
      log.record("first", "incoming", sessionNotification("session", sequence));
      log.record("second", "incoming", sessionNotification("session", sequence));
    }

    expect(log.dump("first")).toEqual(log.dump("second"));
    expect(log.dump("first").length).toBeGreaterThan(0);
  });

  it("keeps the indexed eviction queue bounded across a sustained stream", () => {
    const log = new ACPDebugLog(1_500);
    log.setSessionCollecting("agent", "session", true);
    for (let sequence = 0; sequence < 3_000; sequence++) {
      log.record("agent", "incoming", sessionNotification("session", sequence));
    }

    const retained = log.dump("agent");
    expect(retained.length).toBeLessThan(10);
    expect(retained.at(-1)?.params).toMatchObject({ sequence: 2_999 });
  });
});

describe("ACPDebugLog correlation bounds", () => {
  function promptRequest(id: number, sessionId = "session") {
    return {
      jsonrpc: "2.0",
      id,
      method: "session/prompt",
      params: { sessionId },
    };
  }

  function response(id: number) {
    return { jsonrpc: "2.0", id, result: { stopReason: "end_turn" } };
  }

  it("evicts the oldest orphaned request correlation once the per-agent cap is reached", () => {
    const log = new ACPDebugLog(MAX_ACP_DEBUG_LOG_BYTES_PER_AGENT, 3);
    log.setSessionCollecting("agent", "session", true);

    // Fill the correlation cap with three orphaned outgoing requests, then
    // push a fourth: the oldest (id 1) is evicted to make room.
    log.record("agent", "outgoing", promptRequest(1));
    log.record("agent", "outgoing", promptRequest(2));
    log.record("agent", "outgoing", promptRequest(3));
    log.record("agent", "outgoing", promptRequest(4));

    log.record("agent", "incoming", response(1));
    log.record("agent", "incoming", response(4));

    const entries = log.dump("agent");
    // The response to the evicted request has no known correlated session,
    // so it is dropped rather than captured with a wrong or missing method.
    expect(entries.some((entry) => entry._type === "response" && entry.id === 1)).toBe(false);
    // The response to a request still within the cap is correlated normally.
    const retained = entries.find((entry) => entry._type === "response" && entry.id === 4);
    expect(retained).toMatchObject({ method: "session/prompt" });
  });

  it("does not evict a correlation entry once its response has already arrived", () => {
    const log = new ACPDebugLog(MAX_ACP_DEBUG_LOG_BYTES_PER_AGENT, 2);
    log.setSessionCollecting("agent", "session", true);

    log.record("agent", "outgoing", promptRequest(1));
    log.record("agent", "incoming", response(1));
    log.record("agent", "outgoing", promptRequest(2));
    log.record("agent", "outgoing", promptRequest(3));
    log.record("agent", "incoming", response(2));
    log.record("agent", "incoming", response(3));

    const entries = log.dump("agent");
    expect(entries.find((entry) => entry._type === "response" && entry.id === 2)).toMatchObject({
      method: "session/prompt",
    });
    expect(entries.find((entry) => entry._type === "response" && entry.id === 3)).toMatchObject({
      method: "session/prompt",
    });
  });
});
