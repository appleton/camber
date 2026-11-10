import { describe, expect, it } from "vitest";
import type { ACPDumpEntry } from "./debugDump";
import {
  buildTrajectoryRows,
  collapseTrajectory,
  entrySessionId,
  scopeTrajectoryToConversation,
} from "./trajectory";

// --- builders ---------------------------------------------------------------

function chunk(
  text: string,
  opts: {
    sessionId?: string;
    messageId?: string | null;
    kind?: string;
    meta?: Record<string, unknown>;
  } = {},
): ACPDumpEntry {
  const { sessionId = "s1", messageId, kind = "agent_message_chunk", meta } = opts;
  return {
    _direction: "incoming",
    _type: "notification",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: kind,
        content: { type: "text", text },
        ...(messageId !== undefined ? { messageId } : {}),
        ...(meta ? { _meta: meta } : {}),
      },
    },
  } as ACPDumpEntry;
}

function toolCall(toolCallId: string, sessionId = "s1"): ACPDumpEntry {
  return {
    _direction: "incoming",
    _type: "notification",
    method: "session/update",
    params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId, title: "Edit" } },
  } as ACPDumpEntry;
}

function updateFrame(
  sessionUpdate: string,
  update: Record<string, unknown>,
  sessionId = "s1",
): ACPDumpEntry {
  return {
    _direction: "incoming",
    _type: "notification",
    method: "session/update",
    params: { sessionId, update: { sessionUpdate, ...update } },
  } as ACPDumpEntry;
}

function request(method: string, params: Record<string, unknown>, id = 1): ACPDumpEntry {
  return { _direction: "outgoing", _type: "request", id, method, params } as ACPDumpEntry;
}

function response(method: string, params: Record<string, unknown>, id = 1): ACPDumpEntry {
  return { _direction: "incoming", _type: "response", id, method, params } as ACPDumpEntry;
}

// --- entrySessionId ---------------------------------------------------------

describe("entrySessionId", () => {
  it("reads params.sessionId when present", () => {
    expect(entrySessionId(chunk("a", { sessionId: "s7" }))).toBe("s7");
  });

  it("returns null when params has no sessionId (handshake frames)", () => {
    expect(entrySessionId(request("initialize", {}))).toBeNull();
    expect(entrySessionId(request("session/new", { cwd: "/repo" }))).toBeNull();
  });
});

// --- collapseTrajectory -----------------------------------------------------

describe("collapseTrajectory", () => {
  it("merges consecutive chunks with the same messageId and concatenates text", () => {
    const rows = collapseTrajectory([
      chunk("Hel", { messageId: "m1" }),
      chunk("lo ", { messageId: "m1" }),
      chunk("world", { messageId: "m1" }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].chunkCount).toBe(3);
    expect(rows[0].kind).toBe("message");
    const detail = rows[0].detail as { content: Array<{ type: string; text: string }> };
    expect(detail.content).toEqual([{ type: "text", text: "Hello world" }]);
  });

  it("does not merge chunks with different messageIds", () => {
    const rows = collapseTrajectory([
      chunk("a", { messageId: "m1" }),
      chunk("b", { messageId: "m2" }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.chunkCount === 1)).toBe(true);
  });

  it("breaks a null-messageId run when a non-chunk frame interrupts it", () => {
    const rows = collapseTrajectory([
      chunk("a", { messageId: null }),
      chunk("b", { messageId: null }),
      toolCall("tc1"),
      chunk("c", { messageId: null }),
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[0].chunkCount).toBe(2);
    expect(rows[1].kind).toBe("tool");
    expect(rows[2].chunkCount).toBe(1);
  });

  it("does not merge across different sessionIds", () => {
    const rows = collapseTrajectory([
      chunk("a", { messageId: "m1", sessionId: "s1" }),
      chunk("b", { messageId: "m1", sessionId: "s2" }),
    ]);
    expect(rows).toHaveLength(2);
  });

  it("groups by _meta camber/step_id when messageId is absent", () => {
    const rows = collapseTrajectory([
      chunk("a", { meta: { "camber/step_id": "step-1" } }),
      chunk("b", { meta: { "camber/step_id": "step-1" } }),
      chunk("c", { meta: { "camber/step_id": "step-2" } }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0].chunkCount).toBe(2);
    expect(rows[1].chunkCount).toBe(1);
  });

  it("keeps non-text blocks separate while merging surrounding text", () => {
    const imageChunk = {
      _direction: "incoming",
      _type: "notification",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "m1",
          content: { type: "image", data: "xxx", mimeType: "image/png" },
        },
      },
    } as ACPDumpEntry;
    const rows = collapseTrajectory([
      chunk("see:", { messageId: "m1" }),
      imageChunk,
      chunk("done", { messageId: "m1" }),
    ]);
    expect(rows).toHaveLength(1);
    const detail = rows[0].detail as { content: Array<{ type: string }> };
    expect(detail.content.map((b) => b.type)).toEqual(["text", "image", "text"]);
  });

  it("passes non-chunk frames through unchanged", () => {
    const rows = collapseTrajectory([request("session/prompt", { sessionId: "s1", prompt: [] })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].chunkCount).toBe(1);
    expect(rows[0].method).toBe("session/prompt");
  });
});

// --- buildTrajectoryRows ----------------------------------------------------

describe("buildTrajectoryRows", () => {
  it("assigns sequential indices and respects the collapse flag", () => {
    const entries = [chunk("a", { messageId: "m1" }), chunk("b", { messageId: "m1" })];
    const collapsed = buildTrajectoryRows(entries, { collapse: true });
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].index).toBe(0);

    const raw = buildTrajectoryRows(entries, { collapse: false });
    expect(raw).toHaveLength(2);
    expect(raw.map((r) => r.index)).toEqual([0, 1]);
  });

  it("marks each outgoing session/prompt as a new turn", () => {
    const rows = buildTrajectoryRows(
      [
        request("initialize", {}, 1),
        request("session/prompt", { sessionId: "s1", prompt: [] }, 2),
        chunk("hi", { sessionId: "s1", messageId: "m1" }),
        request("session/prompt", { sessionId: "s1", prompt: [] }, 3),
      ],
      { collapse: true },
    );
    expect(rows.map((r) => r.turnStart)).toEqual([false, true, false, true]);
    expect(rows.map((r) => r.turnNumber)).toEqual([0, 1, 1, 2]);
  });

  it("starts a turn at a replayed user_message_chunk when a session is loaded", () => {
    // A loaded session has no outgoing session/prompt; the user prompt is
    // replayed as a user_message_chunk notification.
    const rows = buildTrajectoryRows(
      [
        request("session/load", { sessionId: "s1", cwd: "/repo" }, 1),
        updateFrame("user_message_chunk", {
          content: { type: "text", text: "hi" },
          messageId: "u1",
        }),
        chunk("hello", { messageId: "a1" }),
        updateFrame("user_message_chunk", {
          content: { type: "text", text: "more" },
          messageId: "u2",
        }),
      ],
      { collapse: true },
    );
    expect(rows.map((r) => r.turnStart)).toEqual([false, true, false, true]);
    expect(rows.map((r) => r.turnNumber)).toEqual([0, 1, 1, 2]);
  });
});

// --- row model (titles / summaries / proto) ---------------------------------

describe("trajectory row model", () => {
  it("gives message and thought chunks human titles with plain-text summaries", () => {
    const rows = buildTrajectoryRows(
      [
        chunk("hi there", { kind: "agent_message_chunk" }),
        chunk("hmm", { kind: "agent_thought_chunk", messageId: "t1" }),
        chunk("do it", { kind: "user_message_chunk", messageId: "u1" }),
      ],
      { collapse: false },
    );
    expect(rows.map((r) => r.title)).toEqual(["Assistant", "Thinking", "User"]);
    expect(rows[0].summary).toBe("hi there");
    expect(rows[0].proto).toBe("agent_message_chunk");
  });

  it("derives a human tool title and associates the later update as its result", () => {
    const rows = buildTrajectoryRows(
      [
        updateFrame("tool_call", {
          toolCallId: "tc1",
          kind: "execute",
          rawInput: { cmd: "npm test", description: "Run tests" },
        }),
        updateFrame("tool_call_update", {
          toolCallId: "tc1",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: "ok" } }],
        }),
      ],
      { collapse: false },
    );
    expect(rows[0].title).toBe("Run npm test");
    expect(rows[0].summary).toBe("Run tests");
    // the update inherits the originating call's title instead of a generic label
    expect(rows[1].title).toBe("Run npm test");
    expect(rows[1].summary).toBe("ok");
    expect(rows[1].proto).toBe("tool_call_update");
  });

  it("prefers the agent-provided tool title over a synthesized one", () => {
    const rows = buildTrajectoryRows(
      [
        updateFrame("tool_call", {
          toolCallId: "r1",
          kind: "read",
          title: "Read ui/README.md",
          rawInput: { file_path: "/repo/ui/README.md" },
        }),
        updateFrame("tool_call", {
          toolCallId: "w1",
          kind: "edit",
          title: "Write `fb/index.html`",
          content: [{ type: "diff", path: "/repo/fb/index.html", newText: "x" }],
        }),
        updateFrame("tool_call", {
          toolCallId: "e1",
          title: "Edit a.ts, b.ts, c.ts",
          content: [{ type: "diff", path: "/repo/a.ts", newText: "x" }],
        }),
      ],
      { collapse: false },
    );
    // keeps the agent's title verbatim (dir path, multi-file list) instead of a basename
    expect(rows[0].title).toBe("Read ui/README.md");
    expect(rows[1].title).toBe("Write `fb/index.html`");
    expect(rows[2].title).toBe("Edit a.ts, b.ts, c.ts");
  });

  it("infers tool kind for agents that omit it (Codex apply_patch / exec_command)", () => {
    const rows = buildTrajectoryRows(
      [
        updateFrame("tool_call", {
          toolCallId: "c1",
          title: "exec_command",
          rawInput: { cmd: "ls" },
        }),
        updateFrame("tool_call", {
          toolCallId: "c2",
          title: "apply_patch",
          content: [{ type: "diff", path: "/repo/index.html", newText: "<html>" }],
        }),
      ],
      { collapse: false },
    );
    expect(rows[0].title).toBe("Run ls");
    expect(rows[1].title).toBe("Create index.html");
  });

  it("summarizes usage and meta updates as plain text, never JSON", () => {
    const rows = buildTrajectoryRows(
      [
        updateFrame("usage_update", { used: 10940, size: 262144 }),
        updateFrame("session_info_update", {}),
      ],
      { collapse: false },
    );
    expect(rows[0].title).toBe("Context window");
    expect(rows[0].summary).toBe("10,940 / 262,144 tokens · 4%");
    expect(rows[1].title).toBe("Session info");
    expect(rows[1].summary).toBe("");
    rows.forEach((r) => expect(r.summary).not.toContain("{"));
  });

  it("labels handshake/lifecycle frames without dumping JSON params", () => {
    const rows = buildTrajectoryRows(
      [
        request("initialize", { clientInfo: { name: "camber-desktop", version: "0.3.12" } }),
        response("initialize", { agentInfo: { title: "Camber", version: "1.0.7" } }),
        request("session/load", { sessionId: "s1", cwd: "/repo" }, 2),
      ],
      { collapse: false },
    );
    expect(rows[0].title).toBe("Initialize");
    expect(rows[0].summary).toBe("client camber-desktop v0.3.12");
    expect(rows[1].summary).toBe("agent Camber v1.0.7");
    expect(rows[2].title).toBe("Load session");
    expect(rows[2].summary).toBe("/repo");
    rows.forEach((r) => expect(r.summary).not.toContain("{"));
  });
});

// --- scopeTrajectoryToConversation ------------------------------------------

describe("scopeTrajectoryToConversation", () => {
  it("includes the handshake and session/new request preceding the tagged frames", () => {
    const entries = [
      request("initialize", {}, 1),
      response("initialize", { protocolVersion: 1 }, 1),
      request("session/new", { cwd: "/repo" }, 2),
      response("session/new", { sessionId: "s1" }, 2),
      request("session/prompt", { sessionId: "s1", prompt: [] }, 3),
      chunk("hi", { sessionId: "s1", messageId: "m1" }),
    ];
    const scoped = scopeTrajectoryToConversation(entries, "s1");
    // all six frames belong to this conversation (handshake has no sessionId but precedes it)
    expect(scoped).toHaveLength(6);
    expect(scoped[0].method).toBe("initialize");
  });

  it("excludes frames tagged with a different session", () => {
    const entries = [
      request("session/new", { cwd: "/repo" }, 1),
      response("session/new", { sessionId: "s1" }, 1),
      chunk("a", { sessionId: "s1", messageId: "m1" }),
      chunk("other", { sessionId: "s2", messageId: "m9" }),
      chunk("b", { sessionId: "s1", messageId: "m1" }),
    ];
    const scoped = scopeTrajectoryToConversation(entries, "s1");
    // only the s2 frame is dropped; the other four are kept
    expect(scoped).toHaveLength(4);
    expect(scoped.some((e) => entrySessionId(e) === "s2")).toBe(false);
  });

  it("stops walking back at the previous conversation's tagged frames", () => {
    const entries = [
      chunk("prev", { sessionId: "s0", messageId: "m0" }),
      request("session/new", { cwd: "/repo" }, 2),
      response("session/new", { sessionId: "s1" }, 2),
      chunk("cur", { sessionId: "s1", messageId: "m1" }),
    ];
    const scoped = scopeTrajectoryToConversation(entries, "s1");
    expect(scoped.some((e) => entrySessionId(e) === "s0")).toBe(false);
    expect(scoped[0].method).toBe("session/new");
  });

  it("returns the tail since the last boundary for a pending (null) session", () => {
    const entries = [
      chunk("old", { sessionId: "s0", messageId: "m0" }),
      request("session/new", { cwd: "/repo" }, 2),
      request("session/prompt", { prompt: [] }, 3),
    ];
    const scoped = scopeTrajectoryToConversation(entries, null);
    expect(scoped).toHaveLength(2);
    expect(scoped[0].method).toBe("session/new");
  });

  it("returns an empty list when nothing matches the session", () => {
    expect(scopeTrajectoryToConversation([chunk("a", { sessionId: "s9" })], "sX")).toEqual([]);
    expect(scopeTrajectoryToConversation([], "s1")).toEqual([]);
  });
});
