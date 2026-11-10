import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { getToolIcon } from "./components/shared/toolIcon";
import {
  getToolName,
  getToolNameLabel,
  getWrittenFileContents,
  getWrittenFileDiff,
  isDirectoryListing,
  isFileWrite,
} from "./components/shared/toolPaths";
import { hostContextBlock } from "./features/session/hostContext";
import {
  USER_MESSAGE_END_BOUNDARY,
  USER_MESSAGE_START_BOUNDARY,
} from "./features/session/userMessageBoundary";
import {
  MAX_AGENT_THOUGHT_CONTENT_BYTES,
  MAX_AGENT_THOUGHT_TEXT_CHARS,
  TurnMaterializer,
  type SessionEvent,
} from "./TurnMaterializer";

function textChunk(
  sessionUpdate: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk",
  text: string,
  messageId?: string | null,
  meta?: Record<string, unknown>,
): SessionUpdate {
  return {
    sessionUpdate,
    content: { type: "text", text },
    ...(messageId !== undefined ? { messageId } : {}),
    ...(meta !== undefined ? { _meta: meta } : {}),
  } as SessionUpdate;
}

function imageChunk(
  sessionUpdate: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk",
  data: string,
  messageId?: string | null,
): SessionUpdate {
  return {
    sessionUpdate,
    content: { type: "image", data, mimeType: "image/png" },
    ...(messageId !== undefined ? { messageId } : {}),
  } as SessionUpdate;
}

function toolCall(toolCallId: string, title: string): SessionUpdate {
  return { sessionUpdate: "tool_call", toolCallId, title } as SessionUpdate;
}

function toolCallUpdate(toolCallId: string, fields: Record<string, unknown>): SessionUpdate {
  return { sessionUpdate: "tool_call_update", toolCallId, ...fields } as SessionUpdate;
}

function plan(
  entries: Array<{ content: string; priority: string; status: string }>,
): SessionUpdate {
  return { sessionUpdate: "plan", entries } as SessionUpdate;
}

function modeUpdate(currentModeId: string): SessionUpdate {
  return { sessionUpdate: "current_mode_update", currentModeId } as SessionUpdate;
}

function applyAll(updates: SessionUpdate[]): readonly SessionEvent[] {
  const m = new TurnMaterializer();
  for (const u of updates) m.apply(u);
  return m.events;
}

function firstTool(updates: SessionUpdate[]): Extract<SessionEvent, { eventKind: "tool_call" }> {
  const event = applyAll(updates)[0];
  expect(event.eventKind).toBe("tool_call");
  if (event.eventKind !== "tool_call") throw new Error("expected tool_call");
  return event;
}

function acpTool(fields: Record<string, unknown>): SessionUpdate {
  return {
    sessionUpdate: "tool_call",
    toolCallId: "tool-1",
    title: "Tool",
    ...fields,
  } as SessionUpdate;
}

function acpToolUpdate(toolCallId: string, fields: Record<string, unknown>): SessionUpdate {
  return { sessionUpdate: "tool_call_update", toolCallId, ...fields } as SessionUpdate;
}

describe("TurnMaterializer", () => {
  it("starts with empty items", () => {
    const m = new TurnMaterializer();
    expect(m.events).toEqual([]);
  });

  it("materializes a single text chunk into one message", () => {
    const items = applyAll([textChunk("agent_message_chunk", "hello")]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      eventKind: "agent_message",
      content: [{ type: "text", text: "hello" }],
    });
  });

  it("preserves message metadata and keeps parallel Claude subagent streams separate", () => {
    const items = applyAll([
      textChunk("agent_message_chunk", "alpha ", null, {
        claudeCode: { parentToolUseId: "task-a" },
      }),
      textChunk("agent_message_chunk", "bravo", null, {
        claudeCode: { parentToolUseId: "task-b" },
      }),
      textChunk("agent_message_chunk", "done", null, {
        claudeCode: { parentToolUseId: "task-a", phase: "complete" },
      }),
    ]);

    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      content: [{ type: "text", text: "alpha " }],
      _meta: { claudeCode: { parentToolUseId: "task-a" } },
    });
    expect(items[1]).toMatchObject({
      content: [{ type: "text", text: "bravo" }],
      _meta: { claudeCode: { parentToolUseId: "task-b" } },
    });
    expect(items[2]).toMatchObject({
      content: [{ type: "text", text: "done" }],
      _meta: { claudeCode: { parentToolUseId: "task-a", phase: "complete" } },
    });
  });

  it("merges metadata on chunks from the same Claude subagent message", () => {
    const items = applyAll([
      textChunk("agent_message_chunk", "alpha ", "message-a", {
        claudeCode: { parentToolUseId: "task-a", phase: "running" },
      }),
      textChunk("agent_message_chunk", "done", "message-a", {
        claudeCode: { parentToolUseId: "task-a", phase: "complete" },
      }),
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      content: [{ type: "text", text: "alpha done" }],
      _meta: { claudeCode: { parentToolUseId: "task-a", phase: "complete" } },
    });
  });

  it("keeps an explicit message attached when later chunks omit metadata", () => {
    const items = applyAll([
      textChunk("agent_message_chunk", "alpha ", "message-a", {
        claudeCode: { parentToolUseId: "task-a" },
      }),
      textChunk("agent_message_chunk", "done", "message-a"),
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      content: [{ type: "text", text: "alpha done" }],
      _meta: { claudeCode: { parentToolUseId: "task-a" } },
    });
  });

  it("marks steering user chunks without marking ordinary user messages", () => {
    const items = applyAll([
      textChunk("user_message_chunk", "initial prompt", "u1"),
      textChunk("user_message_chunk", "focus on tests", "u2", {
        "camber/steer": true,
      }),
    ]);

    expect(items[0]).toMatchObject({
      eventKind: "user_message",
      messageId: "u1",
    });
    expect(items[0]).not.toHaveProperty("steer");
    expect(items[1]).toMatchObject({
      eventKind: "user_message",
      messageId: "u2",
      steer: true,
    });
  });

  it("drops Camber host context user chunks replayed as resource blocks", () => {
    const m = new TurnMaterializer();
    const context = hostContextBlock({
      assistantVersion: "4.3.8",
      userPrompt: "Always reply like a pirate.",
    });
    m.apply(textChunk("user_message_chunk", "hello", "m1"));
    m.apply({
      sessionUpdate: "user_message_chunk",
      messageId: "m1",
      content: context,
    } as SessionUpdate);

    expect(m.events).toHaveLength(1);
    expect(m.events[0]).toMatchObject({
      eventKind: "user_message",
      messageId: "m1",
      content: [{ type: "text", text: "hello" }],
    });
  });

  it("drops Camber host context user chunks replayed as resource links", () => {
    const m = new TurnMaterializer();
    m.apply(textChunk("user_message_chunk", "hello"));
    m.apply({
      sessionUpdate: "user_message_chunk",
      content: {
        type: "resource_link",
        name: "camber://host-context.md",
        uri: "camber://host-context.md",
      },
    } as SessionUpdate);

    expect(m.events).toHaveLength(1);
    expect(m.events[0]).toMatchObject({
      eventKind: "user_message",
      content: [{ type: "text", text: "hello" }],
    });
  });

  it("drops replayed handoff context user chunks", () => {
    const m = new TurnMaterializer();
    m.apply(textChunk("user_message_chunk", "hello", "m1"));
    m.apply({
      sessionUpdate: "user_message_chunk",
      messageId: "m1",
      content: {
        type: "resource",
        resource: {
          uri: "camber://handoff/source-session.md",
          mimeType: "text/markdown",
          text: "<camber-handoff>\nprior transcript\n</camber-handoff>",
        },
      },
    } as SessionUpdate);

    expect(m.events).toHaveLength(1);
    expect(m.events[0]).toMatchObject({
      eventKind: "user_message",
      messageId: "m1",
      content: [{ type: "text", text: "hello" }],
    });
  });

  it("strips flattened host context from loaded user chunks", () => {
    const context = hostContextBlock({
      assistantVersion: "4.3.8",
      userPrompt: "Always reply like a pirate.",
    });
    const resourceText =
      context.type === "resource" && "text" in context.resource ? context.resource.text : "";
    const items = applyAll([
      textChunk(
        "user_message_chunk",
        [
          "What is 2 plus 2?camber://host-context.md",
          '<context ref="camber://host-context.md">',
          resourceText,
          "</context>",
        ].join("\n"),
      ),
    ]);

    expect(items).toEqual([
      expect.objectContaining({
        eventKind: "user_message",
        content: [{ type: "text", text: "What is 2 plus 2?" }],
      }),
    ]);
  });

  it("strips host context replayed as separate trailing user chunks", () => {
    // claude-agent-acp replays the prompt as one chunk per block: the user
    // text, the bare resource URI, then the <context>-wrapped resource text.
    const context = hostContextBlock({
      assistantVersion: "4.3.8",
      userPrompt: "Always reply like a pirate.",
    });
    const resourceText =
      context.type === "resource" && "text" in context.resource ? context.resource.text : "";
    const items = applyAll([
      textChunk("user_message_chunk", "What is 2 plus 2?"),
      textChunk("user_message_chunk", "camber://host-context.md"),
      textChunk(
        "user_message_chunk",
        `\n<context ref="camber://host-context.md">\n${resourceText}\n</context>`,
      ),
    ]);

    expect(items).toEqual([
      expect.objectContaining({
        eventKind: "user_message",
        content: [{ type: "text", text: "What is 2 plus 2?" }],
      }),
    ]);
  });

  it("strips a raw inlined system instructions tag from loaded user chunks", () => {
    const context = hostContextBlock({ assistantVersion: "4.3.8" });
    const resourceText =
      context.type === "resource" && "text" in context.resource ? context.resource.text : "";
    const items = applyAll([textChunk("user_message_chunk", `What is 2 plus 2?\n${resourceText}`)]);

    expect(items).toEqual([
      expect.objectContaining({
        eventKind: "user_message",
        content: [{ type: "text", text: "What is 2 plus 2?" }],
      }),
    ]);
  });

  it("unwraps loaded user chunks and discards text outside the client boundary", () => {
    const items = applyAll([
      textChunk(
        "user_message_chunk",
        [
          `raw prefix ${USER_MESSAGE_START_BOUNDARY}What is 2 plus 2?${USER_MESSAGE_END_BOUNDARY}camber://host-context.md`,
          '<context ref="camber://host-context.md">',
          "# Camber Host Context",
          "",
          "You are running within Camber Assistant via the Agent Client Protocol (ACP).",
          "",
          "## Project Guidelines for Agent",
          "",
          "Always reply like a pirate.",
          "",
          "</context>",
        ].join("\n"),
      ),
    ]);

    expect(items).toEqual([
      expect.objectContaining({
        eventKind: "user_message",
        content: [{ type: "text", text: "What is 2 plus 2?" }],
      }),
    ]);
  });

  it("keeps loaded user chunks unchanged when there is no client boundary pair", () => {
    const text = "What is 2 plus 2?\ncamber://host-context.md\n<context>raw</context>";
    const items = applyAll([textChunk("user_message_chunk", text)]);

    expect(items).toEqual([
      expect.objectContaining({
        eventKind: "user_message",
        content: [{ type: "text", text }],
      }),
    ]);
  });

  it("keeps loaded user chunks unchanged when only one client boundary is present", () => {
    const text = `${USER_MESSAGE_START_BOUNDARY}What is 2 plus 2?`;
    const items = applyAll([textChunk("user_message_chunk", text)]);

    expect(items).toEqual([
      expect.objectContaining({
        eventKind: "user_message",
        content: [{ type: "text", text }],
      }),
    ]);
  });

  it("concatenates two text chunks with the same messageId", () => {
    const items = applyAll([
      textChunk("agent_message_chunk", "hel", "m1"),
      textChunk("agent_message_chunk", "lo", "m1"),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      eventKind: "agent_message",
      messageId: "m1",
      content: [{ type: "text", text: "hello" }],
    });
  });

  it("keeps text and image as separate content blocks in same message", () => {
    const items = applyAll([
      textChunk("agent_message_chunk", "see image:", "m1"),
      imageChunk("agent_message_chunk", "abc123", "m1"),
    ]);
    expect(items).toHaveLength(1);
    const msg = items[0] as SessionEvent & { eventKind: "agent_message" };
    expect(msg.content).toHaveLength(2);
    expect(msg.content[0]).toMatchObject({ type: "text", text: "see image:" });
    expect(msg.content[1]).toMatchObject({ type: "image", data: "abc123" });
  });

  it("creates separate messages for different messageIds", () => {
    const items = applyAll([
      textChunk("agent_message_chunk", "first", "m1"),
      textChunk("agent_message_chunk", "second", "m2"),
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ messageId: "m1", content: [{ text: "first" }] });
    expect(items[1]).toMatchObject({ messageId: "m2", content: [{ text: "second" }] });
  });

  it("uses camber/step_id as the message identity when messageId is absent", () => {
    const items = applyAll([
      textChunk("agent_message_chunk", "hel", undefined, { "camber/step_id": "step-1" }),
      textChunk("agent_message_chunk", "lo", undefined, { "camber/step_id": "step-1" }),
      textChunk("agent_message_chunk", "new", undefined, { "camber/step_id": "step-2" }),
    ]);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      eventKind: "agent_message",
      messageId: "step-1",
      content: [{ type: "text", text: "hello" }],
    });
    expect(items[1]).toMatchObject({
      eventKind: "agent_message",
      messageId: "step-2",
      content: [{ type: "text", text: "new" }],
    });
  });

  it("groups null messageId chunks when contiguous, breaks on tool call", () => {
    const items = applyAll([
      textChunk("agent_message_chunk", "a"),
      textChunk("agent_message_chunk", "b"),
      toolCall("tc1", "Run test"),
      textChunk("agent_message_chunk", "c"),
    ]);
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      eventKind: "agent_message",
      messageId: null,
      content: [{ type: "text", text: "ab" }],
    });
    expect(items[1]).toMatchObject({ eventKind: "tool_call" });
    expect(items[2]).toMatchObject({
      eventKind: "agent_message",
      messageId: null,
      content: [{ type: "text", text: "c" }],
    });
  });

  it("merges tool_call_update into existing tool call", () => {
    const items = applyAll([
      toolCall("tc1", "Read file"),
      toolCallUpdate("tc1", { status: "completed", title: "Read file (done)" }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      eventKind: "tool_call",
      toolCallId: "tc1",
      title: "Read file (done)",
      status: "completed",
    });
  });

  it("normalizes loaded sed shell calls to read tools", () => {
    const items = applyAll([
      {
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "exec_command",
        kind: "execute",
        rawInput: { command: "sed -n '1,120p' ui/packages/features/src/acp/TurnMaterializer.ts" },
      } as SessionUpdate,
    ]);

    expect(items[0]).toMatchObject({
      eventKind: "tool_call",
      kind: "read",
      title: "Read TurnMaterializer.ts",
      locations: [{ path: "ui/packages/features/src/acp/TurnMaterializer.ts" }],
    });
  });

  it("normalizes loaded rg shell calls to search tools", () => {
    const items = applyAll([
      {
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "shell",
        kind: "execute",
        rawInput: { command: ["bash", "-lc", 'rg -n "tool_call" ui/packages/features/src/acp'] },
      } as SessionUpdate,
    ]);

    expect(items[0]).toMatchObject({
      eventKind: "tool_call",
      kind: "search",
      title: "Search tool_call in ui/packages/features/src/acp",
    });
  });

  it("normalizes loaded find shell calls to search tools", () => {
    const items = applyAll([
      {
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "container.exec",
        kind: "execute",
        rawInput: { command: ["find", "ui/packages/features/src/acp", "-name", "*.ts"] },
      } as SessionUpdate,
    ]);

    expect(items[0]).toMatchObject({
      eventKind: "tool_call",
      kind: "search",
      title: "List ui/packages/features/src/acp",
      locations: [{ path: "ui/packages/features/src/acp" }],
    });
  });

  it("leaves non-read/search shell calls unchanged", () => {
    const items = applyAll([
      {
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "exec_command",
        kind: "execute",
        rawInput: { command: "pnpm test" },
      } as SessionUpdate,
    ]);

    expect(items[0]).toMatchObject({
      eventKind: "tool_call",
      kind: "execute",
      title: "exec_command",
    });
  });

  it("completes open tool calls when a turn is finalized", () => {
    const m = new TurnMaterializer();
    m.apply(toolCall("tc1", "Generate image"));
    m.apply(toolCallUpdate("tc1", { status: "in_progress" }));
    m.apply(toolCall("tc2", "Read file"));
    m.apply(toolCallUpdate("tc2", { status: "failed" }));

    m.completeOpenToolCalls();

    expect(m.events[0]).toMatchObject({ toolCallId: "tc1", status: "completed" });
    expect(m.events[1]).toMatchObject({ toolCallId: "tc2", status: "failed" });
  });

  it("tracks turn ranges from prompt lifecycle metadata", () => {
    const m = new TurnMaterializer();
    m.startTurn("2026-06-02T10:00:00.000Z");
    expect(m.currentTurnStartIndex).toBe(0);
    m.apply(toolCall("tc1", "Read file"));
    m.apply(textChunk("agent_message_chunk", "done"));

    m.completeOpenToolCalls("2026-06-02T10:03:00.000Z");
    expect(m.currentTurnStartIndex).toBeNull();

    expect(m.events[0]).toMatchObject({
      eventKind: "tool_call",
    });
    expect(m.turns).toEqual([
      {
        startedAt: "2026-06-02T10:00:00.000Z",
        endedAt: "2026-06-02T10:03:00.000Z",
        startIndex: 0,
        endIndex: 1,
      },
    ]);
    expect(m.events[1]).toEqual({
      eventKind: "agent_message",
      messageId: null,
      content: [{ type: "text", text: "done" }],
    });
  });

  it("cancels open tool calls when a turn is cancelled", () => {
    const m = new TurnMaterializer();
    m.apply(toolCall("tc1", "Generate image"));
    m.apply(toolCallUpdate("tc1", { status: "in_progress" }));
    m.apply(toolCall("tc2", "Read file"));
    m.apply(toolCallUpdate("tc2", { status: "failed" }));

    m.cancelOpenToolCalls();

    expect(m.events[0]).toMatchObject({ toolCallId: "tc1", status: "cancelled" });
    expect(m.events[1]).toMatchObject({ toolCallId: "tc2", status: "failed" });
  });

  it("marks the turn as interrupted when cancelled", () => {
    const m = new TurnMaterializer();
    m.startTurn("2026-06-02T10:00:00.000Z");
    m.apply(toolCall("tc1", "Read file"));

    m.cancelOpenToolCalls("2026-06-02T10:03:00.000Z");

    expect(m.turns).toEqual([
      {
        startedAt: "2026-06-02T10:00:00.000Z",
        endedAt: "2026-06-02T10:03:00.000Z",
        startIndex: 0,
        endIndex: 0,
        interrupted: true,
      },
    ]);
  });

  it("ignores tool_call_update for unknown toolCallId", () => {
    const items = applyAll([toolCallUpdate("unknown", { status: "completed" })]);
    expect(items).toHaveLength(0);
  });

  it("tracks plan separately from events", () => {
    const m = new TurnMaterializer();
    expect(m.plan).toBeNull();

    m.apply(plan([{ content: "step 1", priority: "high", status: "pending" }]));
    expect(m.events).toHaveLength(0);
    expect(m.plan).toMatchObject({
      entries: [{ content: "step 1", status: "pending" }],
    });

    m.apply(
      plan([
        { content: "step 1", priority: "high", status: "completed" },
        { content: "step 2", priority: "medium", status: "in_progress" },
      ]),
    );
    expect(m.events).toHaveLength(0);
    expect(m.plan).toMatchObject({
      entries: [
        { content: "step 1", status: "completed" },
        { content: "step 2", status: "in_progress" },
      ],
    });
  });

  describe("plan entry reconciliation", () => {
    it("keeps entries at their first-seen position when an update reorders them", () => {
      const m = new TurnMaterializer();
      m.apply(
        plan([
          { content: "gather ingredients", priority: "medium", status: "completed" },
          { content: "boil water", priority: "medium", status: "in_progress" },
          { content: "cut guanciale", priority: "medium", status: "pending" },
          { content: "whisk eggs", priority: "medium", status: "pending" },
        ]),
      );
      m.apply(
        plan([
          { content: "cut guanciale", priority: "medium", status: "completed" },
          { content: "whisk eggs", priority: "medium", status: "in_progress" },
          { content: "gather ingredients", priority: "medium", status: "completed" },
          { content: "boil water", priority: "medium", status: "completed" },
        ]),
      );
      expect(m.plan?.entries.map((e) => e.content)).toEqual([
        "gather ingredients",
        "boil water",
        "cut guanciale",
        "whisk eggs",
      ]);
      expect(m.plan?.entries.map((e) => e.status)).toEqual([
        "completed",
        "completed",
        "completed",
        "in_progress",
      ]);
    });

    it("appends new entries at the end in update order", () => {
      const m = new TurnMaterializer();
      m.apply(plan([{ content: "step 1", priority: "medium", status: "in_progress" }]));
      m.apply(
        plan([
          { content: "step 3", priority: "medium", status: "pending" },
          { content: "step 1", priority: "medium", status: "completed" },
          { content: "step 2", priority: "medium", status: "pending" },
        ]),
      );
      expect(m.plan?.entries.map((e) => e.content)).toEqual(["step 1", "step 3", "step 2"]);
    });

    it("drops entries missing from an update", () => {
      const m = new TurnMaterializer();
      m.apply(
        plan([
          { content: "keep", priority: "medium", status: "pending" },
          { content: "remove", priority: "medium", status: "pending" },
        ]),
      );
      m.apply(plan([{ content: "keep", priority: "medium", status: "completed" }]));
      expect(m.plan?.entries).toEqual([
        { content: "keep", priority: "medium", status: "completed" },
      ]);
    });

    it("replaces the plan when an update shares no entries", () => {
      const m = new TurnMaterializer();
      m.apply(
        plan([
          { content: "old a", priority: "medium", status: "completed" },
          { content: "old b", priority: "medium", status: "completed" },
        ]),
      );
      m.apply(
        plan([
          { content: "new b", priority: "medium", status: "pending" },
          { content: "new a", priority: "medium", status: "pending" },
        ]),
      );
      expect(m.plan?.entries.map((e) => e.content)).toEqual(["new b", "new a"]);
    });

    it("takes the first plan after reset verbatim", () => {
      const m = new TurnMaterializer();
      m.apply(
        plan([
          { content: "a", priority: "medium", status: "pending" },
          { content: "b", priority: "medium", status: "pending" },
        ]),
      );
      m.reset();
      m.apply(
        plan([
          { content: "b", priority: "medium", status: "pending" },
          { content: "a", priority: "medium", status: "pending" },
        ]),
      );
      expect(m.plan?.entries.map((e) => e.content)).toEqual(["b", "a"]);
    });
  });

  it("appends mode_change event for current_mode_update", () => {
    const items = applyAll([modeUpdate("code")]);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({ eventKind: "mode_change", currentModeId: "code" });
  });

  it("appends multiple mode_change events (not replace)", () => {
    const items = applyAll([modeUpdate("code"), modeUpdate("debug"), modeUpdate("chat")]);
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({ eventKind: "mode_change", currentModeId: "code" });
    expect(items[1]).toEqual({ eventKind: "mode_change", currentModeId: "debug" });
    expect(items[2]).toEqual({ eventKind: "mode_change", currentModeId: "chat" });
  });

  it("excludes session-level updates from output", () => {
    const items = applyAll([
      { sessionUpdate: "config_option_update", configOptions: [] } as SessionUpdate,
      { sessionUpdate: "usage_update", size: 100, used: 50 } as SessionUpdate,
      { sessionUpdate: "session_info_update", title: "test" } as SessionUpdate,
      { sessionUpdate: "available_commands_update", availableCommands: [] } as SessionUpdate,
    ]);
    expect(items).toHaveLength(0);
  });

  it("maintains first-appearance order for interleaved items", () => {
    const items = applyAll([
      textChunk("user_message_chunk", "hello", "m1"),
      textChunk("agent_message_chunk", "thinking...", "m2"),
      toolCall("tc1", "Search"),
      toolCallUpdate("tc1", { status: "completed" }),
      textChunk("agent_message_chunk", "done", "m3"),
    ]);
    expect(items.map((i) => i.eventKind)).toEqual([
      "user_message",
      "agent_message",
      "tool_call",
      "agent_message",
    ]);
    expect(items[0]).toMatchObject({ eventKind: "user_message" });
    expect(items[1]).toMatchObject({
      eventKind: "agent_message",
      content: [{ text: "thinking..." }],
    });
    expect(items[2]).toMatchObject({ eventKind: "tool_call", status: "completed" });
    expect(items[3]).toMatchObject({ eventKind: "agent_message", content: [{ text: "done" }] });
  });

  it("handles thought chunks with correct eventKind", () => {
    const items = applyAll([textChunk("agent_thought_chunk", "hmm", "t1")]);
    expect(items[0]).toMatchObject({ eventKind: "agent_thought", messageId: "t1" });
  });

  it("keeps only the newest bounded tail of an oversized thought", () => {
    const items = applyAll([
      textChunk("agent_thought_chunk", "a".repeat(MAX_AGENT_THOUGHT_TEXT_CHARS), "t1"),
      textChunk("agent_thought_chunk", "latest", "t1"),
    ]);
    const thought = items[0];
    expect(thought.eventKind).toBe("agent_thought");
    if (thought.eventKind !== "agent_thought") throw new Error("expected agent_thought");

    const text = thought.content[0];
    expect(text?.type).toBe("text");
    if (text?.type !== "text") throw new Error("expected text");
    expect(text.text).toHaveLength(MAX_AGENT_THOUGHT_TEXT_CHARS);
    expect(text.text.endsWith("latest")).toBe(true);
    expect(thought.truncated).toBe(true);
  });

  it("caps a single oversized thought chunk without affecting assistant messages", () => {
    const oversized = "x".repeat(MAX_AGENT_THOUGHT_TEXT_CHARS + 100);
    const items = applyAll([
      textChunk("agent_thought_chunk", oversized, "t1"),
      textChunk("agent_message_chunk", oversized, "m1"),
    ]);
    const thought = items[0];
    const message = items[1];
    expect(thought).toMatchObject({ eventKind: "agent_thought", truncated: true });
    if (thought.eventKind !== "agent_thought") throw new Error("expected agent_thought");
    expect(thought.content[0]).toMatchObject({ text: "x".repeat(MAX_AGENT_THOUGHT_TEXT_CHARS) });
    expect(message).toMatchObject({
      eventKind: "agent_message",
      content: [{ text: oversized }],
    });
  });

  it("bounds non-text thought blocks without affecting assistant content", () => {
    const imageData = "x".repeat(MAX_AGENT_THOUGHT_CONTENT_BYTES / 4);
    const thoughtChunks = Array.from({ length: 8 }, (_, index) =>
      imageChunk("agent_thought_chunk", `${index}${imageData}`, "t1"),
    );
    const items = applyAll([...thoughtChunks, imageChunk("agent_message_chunk", imageData, "m1")]);
    const thought = items[0];
    const message = items[1];
    expect(thought.eventKind).toBe("agent_thought");
    if (thought.eventKind !== "agent_thought") throw new Error("expected agent_thought");

    expect(thought.truncated).toBe(true);
    expect(thought.content.length).toBeGreaterThan(0);
    expect(thought.content.length).toBeLessThan(thoughtChunks.length);
    expect(thought.content.at(-1)).toMatchObject({ type: "image", data: `7${imageData}` });
    expect(message).toMatchObject({
      eventKind: "agent_message",
      content: [{ type: "image", data: imageData }],
    });
  });

  it("drops an individual non-text thought block larger than the whole budget", () => {
    const items = applyAll([
      imageChunk("agent_thought_chunk", "x".repeat(MAX_AGENT_THOUGHT_CONTENT_BYTES), "t1"),
    ]);

    expect(items[0]).toMatchObject({
      eventKind: "agent_thought",
      content: [],
      truncated: true,
    });
  });

  describe("reset", () => {
    it("clears all state", () => {
      const m = new TurnMaterializer();
      m.apply(textChunk("agent_message_chunk", "hello", "m1"));
      m.apply(toolCall("tc1", "Run"));
      m.apply(plan([{ content: "step", priority: "high", status: "pending" }]));
      expect(m.events).toHaveLength(2);
      expect(m.plan).not.toBeNull();

      m.reset();
      expect(m.events).toHaveLength(0);
      expect(m.plan).toBeNull();

      m.apply(textChunk("agent_message_chunk", "fresh", "m2"));
      expect(m.events).toHaveLength(1);
      expect(m.events[0]).toMatchObject({ content: [{ text: "fresh" }] });
    });

    it("does not merge with pre-reset messages", () => {
      const m = new TurnMaterializer();
      m.apply(textChunk("agent_message_chunk", "old", "m1"));
      m.reset();
      m.apply(textChunk("agent_message_chunk", "new", "m1"));
      expect(m.events).toHaveLength(1);
      expect(m.events[0]).toMatchObject({ content: [{ text: "new" }] });
    });
  });

  describe("tool_name-driven rendering", () => {
    it("detects directory listings by Pool and Claude tool names", () => {
      for (const meta of [{ tool_name: "list_directory" }, { claudeCode: { toolName: "LS" } }]) {
        const event = firstTool([
          acpTool({ kind: "read", rawInput: { path: "/repo" }, _meta: meta }),
        ]);

        expect(getToolName(event)).toBe("list_directory");
        expect(isDirectoryListing(event)).toBe(true);
        expect(getToolIcon(event)).toBe("folder");
      }
    });

    it("leaves ordinary reads as file reads", () => {
      for (const fields of [
        { rawInput: { path: "/repo/a.ts" }, _meta: { tool_name: "read" } },
        { title: "List `.`", rawInput: { path: "/repo" } },
      ]) {
        const event = firstTool([acpTool({ kind: "read", ...fields })]);

        expect(isDirectoryListing(event)).toBe(false);
        expect(getToolIcon(event)).toMatchObject({ type: "file" });
      }
    });

    it("labels Pool and Claude writes as creates", () => {
      for (const meta of [{ tool_name: "write" }, { claudeCode: { toolName: "Write" } }]) {
        const event = firstTool([acpTool({ kind: "edit", _meta: meta })]);

        expect(getToolName(event)).toBe("write");
        expect(getToolNameLabel(event)).toBe("Create");
        expect(isFileWrite(event)).toBe(true);
      }
    });

    it("keeps tool names across partial metadata updates", () => {
      const event = firstTool([
        acpTool({
          toolCallId: "w1",
          kind: "edit",
          _meta: { "camber/step_id": "step-1", tool_name: "write" },
        }),
        acpToolUpdate("w1", {
          status: "completed",
          _meta: { "camber/step_id": "step-1" },
        }),
      ]);

      expect(event.status).toBe("completed");
      expect(getToolName(event)).toBe("write");
      expect(getToolNameLabel(event)).toBe("Create");
    });

    it("keeps nested Claude tool names across partial metadata updates", () => {
      const event = firstTool([
        acpTool({
          toolCallId: "claude-w1",
          kind: "edit",
          _meta: { claudeCode: { toolName: "Write", id: "1" } },
        }),
        acpToolUpdate("claude-w1", {
          status: "completed",
          _meta: { claudeCode: { id: "1" } },
        }),
      ]);

      expect(getToolName(event)).toBe("write");
      expect(getToolNameLabel(event)).toBe("Create");
    });

    it("leaves real edits without a label override", () => {
      const event = firstTool([acpTool({ kind: "edit", _meta: { tool_name: "edit" } })]);

      expect(getToolNameLabel(event)).toBeUndefined();
    });

    it("recovers write contents and synthetic diff from raw input after completion", () => {
      const event = firstTool([
        acpTool({
          toolCallId: "w1",
          kind: "edit",
          rawInput: { path: "/repo/fb8/index.html", contents: "<!doctype html>\n<html></html>" },
          _meta: { "camber/step_id": "s1", tool_name: "write" },
        }),
        acpToolUpdate("w1", {
          status: "completed",
          content: [
            { type: "content", content: { type: "text", text: "Created file index.html" } },
          ],
          _meta: { "camber/step_id": "s1" },
        }),
      ]);

      expect(getWrittenFileContents(event)).toBe("<!doctype html>\n<html></html>");
      expect(getWrittenFileDiff(event)).toEqual({
        type: "diff",
        path: "/repo/fb8/index.html",
        oldText: "",
        newText: "<!doctype html>\n<html></html>",
      });
    });

    it("resolves a Claude write's synthetic diff from file_path/content without locations", () => {
      const event = firstTool([
        acpTool({
          toolCallId: "claude-w1",
          kind: "edit",
          rawInput: { file_path: "/repo/fb/index.html", content: "<!doctype html>" },
          _meta: { claudeCode: { toolName: "Write" } },
        }),
      ]);

      expect(getWrittenFileContents(event)).toBe("<!doctype html>");
      expect(getWrittenFileDiff(event)).toEqual({
        type: "diff",
        path: "/repo/fb/index.html",
        oldText: "",
        newText: "<!doctype html>",
      });
    });

    it("does not treat reads as file writes", () => {
      const event = firstTool([acpTool({ kind: "read", _meta: { tool_name: "read" } })]);

      expect(isFileWrite(event)).toBe(false);
      expect(getWrittenFileContents(event)).toBeUndefined();
      expect(getWrittenFileDiff(event)).toBeUndefined();
    });
  });
});
