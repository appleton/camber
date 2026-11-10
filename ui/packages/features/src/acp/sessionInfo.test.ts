import { describe, expect, it } from "vitest";
import { applySessionInfoUpdate, normalizeSessionInfo } from "./sessionInfo";

describe("normalizeSessionInfo", () => {
  it("recognizes conversation history sessions", () => {
    const info = normalizeSessionInfo({
      sessionId: "conversation:123",
      cwd: "/workspace",
      title: "Conversation history",
      updatedAt: "2026-03-30T09:00:00Z",
      _meta: {
        "camber/source": "conversation",
        "camber/read_only": true,
        "camber/conversation_id": "123",
        "camber/conversation_kind": "agentic",
      },
    });

    expect(info).toMatchObject({
      source: "conversation",
      readOnly: true,
      conversationId: "123",
      conversationKind: "agentic",
    });
  });

  it("parses error_message and cancellation_reason from meta", () => {
    const info = normalizeSessionInfo({
      sessionId: "session:1",
      cwd: "/workspace",
      _meta: {
        "camber/read_only": true,
        "camber/error_message": "out of memory",
        "camber/cancellation_reason": "user requested",
      },
    });

    expect(info).toMatchObject({
      readOnly: true,
      errorMessage: "out of memory",
      cancellationReason: "user requested",
    });
  });

  it("defaults errorMessage and cancellationReason to null", () => {
    const info = normalizeSessionInfo({
      sessionId: "session:1",
      cwd: "/workspace",
      _meta: {},
    });

    expect(info.errorMessage).toBeNull();
    expect(info.cancellationReason).toBeNull();
  });

  it("parses agent_id from meta", () => {
    const info = normalizeSessionInfo({
      sessionId: "session:1",
      cwd: "/workspace",
      _meta: { "camber/agent_id": "agent-123" },
    });

    expect(info.agentId).toBe("agent-123");
  });

  it("defaults agentId to null", () => {
    const info = normalizeSessionInfo({
      sessionId: "session:1",
      cwd: "/workspace",
      _meta: {},
    });

    expect(info.agentId).toBeNull();
  });

  it("falls back for unknown source values", () => {
    const info = normalizeSessionInfo({
      sessionId: "conversation:123",
      cwd: "/workspace",
      _meta: {
        "camber/source": "not_a_real_source",
      },
    });

    expect(info.source).toBe("unknown");
  });
});

describe("applySessionInfoUpdate", () => {
  it("applies read_only and error_message from session_info_update", () => {
    const current = normalizeSessionInfo({
      sessionId: "session:1",
      cwd: "/workspace",
      _meta: { "camber/source": "native_session", "camber/read_only": false },
    });

    const updated = applySessionInfoUpdate(current, "session:1", {
      _meta: {
        "camber/read_only": true,
        "camber/error_message": "out of memory",
      },
    });

    expect(updated).toMatchObject({
      readOnly: true,
      errorMessage: "out of memory",
      cancellationReason: null,
      source: "native_session",
    });
  });

  it("preserves existing fields when update has no overrides", () => {
    const current = normalizeSessionInfo({
      sessionId: "session:1",
      cwd: "/workspace",
      title: "My session",
      _meta: { "camber/source": "native_session" },
    });

    const updated = applySessionInfoUpdate(current, "session:1", {
      _meta: { "camber/read_only": true },
    });

    expect(updated.title).toBe("My session");
    expect(updated.source).toBe("native_session");
    expect(updated.readOnly).toBe(true);
  });
});
