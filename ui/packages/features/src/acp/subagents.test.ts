import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { TurnMaterializer } from "./TurnMaterializer";
import {
  buildSubagentTranscriptIndex,
  subagentProvidesTranscript,
  subagentStatusLabel,
  subagentTranscriptRevision,
} from "./subagents";

function materialize(updates: SessionUpdate[]) {
  const materializer = new TurnMaterializer();
  for (const update of updates) materializer.apply(update);
  return materializer.events;
}

describe("buildSubagentTranscriptIndex", () => {
  it("moves direct Claude children out of the parent and keeps nested agents separate", () => {
    const events = materialize([
      {
        sessionUpdate: "tool_call",
        toolCallId: "task-a",
        title: "Research auth",
        kind: "think",
        rawInput: { prompt: "Investigate auth", description: "Auth researcher" },
        _meta: { claudeCode: { toolName: "Task", subagent: true } },
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Looking at auth." },
        _meta: { claudeCode: { parentToolUseId: "task-a" } },
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "task-b",
        title: "Check tests",
        _meta: {
          claudeCode: { toolName: "Task", subagent: true, parentToolUseId: "task-a" },
        },
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Nested result" },
        _meta: { claudeCode: { parentToolUseId: "task-b" } },
      },
    ] as SessionUpdate[]);

    const index = buildSubagentTranscriptIndex(events);

    expect(index.topLevelEvents.map((event) => event.eventKind)).toEqual(["tool_call"]);
    expect(index.claudeEvents("claude:task-a")).toHaveLength(2);
    expect(index.claudeEvents("claude:task-b")).toHaveLength(1);
    expect(index.referenceForKey("claude:task-a")).toMatchObject({
      title: "Auth researcher",
      prompt: "Investigate auth",
    });
  });

  it("leaves orphaned Claude children visible", () => {
    const events = materialize([
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "orphan" },
        _meta: { claudeCode: { parentToolUseId: "missing" } },
      },
    ] as SessionUpdate[]);

    expect(buildSubagentTranscriptIndex(events).topLevelEvents).toHaveLength(1);
  });

  it("remaps the active turn start past a hidden Claude child event", () => {
    const events = materialize([
      {
        sessionUpdate: "tool_call",
        toolCallId: "task-a",
        title: "Research auth",
        _meta: { claudeCode: { subagent: true } },
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Child reply" },
        _meta: { claudeCode: { parentToolUseId: "task-a" } },
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Starting the next prompt" },
      },
    ]);

    const index = buildSubagentTranscriptIndex(events, [], { activeTurnStartIndex: 2 });
    expect(index.topLevelEvents).toEqual([events[0], events[2]]);
    expect(index.topLevelActiveTurnStartIndex).toBe(1);
  });

  it("changes transcript revision when an earlier child tool updates after a later message", () => {
    const materializer = new TurnMaterializer();
    for (const update of [
      {
        sessionUpdate: "tool_call",
        toolCallId: "task-a",
        title: "Research auth",
        rawInput: { description: "Auth researcher" },
        _meta: { claudeCode: { subagent: true } },
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "child-tool",
        title: "Read config",
        status: "in_progress",
        _meta: { claudeCode: { parentToolUseId: "task-a" } },
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "I found the config." },
        _meta: { claudeCode: { parentToolUseId: "task-a" } },
      },
    ] as SessionUpdate[]) {
      materializer.apply(update);
    }
    const before = subagentTranscriptRevision(
      buildSubagentTranscriptIndex(materializer.events),
      "claude:task-a",
    );

    materializer.apply({
      sessionUpdate: "tool_call_update",
      toolCallId: "child-tool",
      status: "completed",
      _meta: { claudeCode: { parentToolUseId: "task-a" } },
    } as SessionUpdate);

    const after = subagentTranscriptRevision(
      buildSubagentTranscriptIndex(materializer.events),
      "claude:task-a",
    );
    expect(after).not.toBe(before);
  });

  it("keeps cyclic Claude roots reachable from the parent transcript", () => {
    const events = materialize([
      {
        sessionUpdate: "tool_call",
        toolCallId: "task-a",
        title: "Task A",
        _meta: {
          claudeCode: { subagent: true, parentToolUseId: "task-b" },
        },
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "task-b",
        title: "Task B",
        _meta: {
          claudeCode: { subagent: true, parentToolUseId: "task-a" },
        },
      },
    ] as SessionUpdate[]);

    expect(buildSubagentTranscriptIndex(events).topLevelEvents).toHaveLength(2);
  });

  it("indexes a Pool subagent tool call and reports it as running while pending", () => {
    const materializer = new TurnMaterializer();
    materializer.apply({
      sessionUpdate: "tool_call",
      toolCallId: "pool-1",
      title: "Subagent: Review the plan",
      kind: "other",
      status: "pending",
      rawInput: { task: "Review the implementation   plan in PLAN.md\nand report gaps." },
      _meta: { tool_name: "subagent" },
    } as SessionUpdate);

    const running = buildSubagentTranscriptIndex(materializer.events);
    expect(running.referenceForKey("pool:pool-1")).toMatchObject({
      provider: "pool",
      // Whitespace collapsed so the row title stays a single readable line.
      title: "Review the implementation plan in PLAN.md and report gaps.",
      status: "running",
    });
    expect(subagentStatusLabel(running.referenceForKey("pool:pool-1")?.status)).toBe("Running");
    // Pool exposes no child transcript, so the row must not offer a tab.
    expect(subagentProvidesTranscript(running.referenceForKey("pool:pool-1")!)).toBe(false);
    expect(running.topLevelEvents).toHaveLength(1);

    materializer.apply({
      sessionUpdate: "tool_call_update",
      toolCallId: "pool-1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "Found three gaps." } }],
    } as SessionUpdate);

    const completed = buildSubagentTranscriptIndex(materializer.events);
    expect(completed.referenceForKey("pool:pool-1")).toMatchObject({ status: "completed" });
  });

  it("truncates a long Pool task title but keeps the full task as the prompt", () => {
    const task = `Investigate ${"the authentication middleware ".repeat(10)}and report back.`;
    const events = materialize([
      {
        sessionUpdate: "tool_call",
        toolCallId: "pool-long",
        title: "Subagent: Investigate…",
        status: "pending",
        rawInput: { task },
        _meta: { tool_name: "subagent" },
      },
    ] as SessionUpdate[]);

    const reference = buildSubagentTranscriptIndex(events).referenceForKey("pool:pool-long");
    expect(reference?.title).toHaveLength(121);
    expect(reference?.title.endsWith("…")).toBe(true);
    expect(reference?.prompt).toBe(task);
  });

  it("ignores non-subagent Pool tool calls", () => {
    const events = materialize([
      {
        sessionUpdate: "tool_call",
        toolCallId: "read-1",
        title: "Read main.go",
        status: "completed",
        rawInput: { path: "main.go" },
        _meta: { tool_name: "read" },
      },
    ] as SessionUpdate[]);

    expect(buildSubagentTranscriptIndex(events).references.size).toBe(0);
  });

  it("aggregates Codex collaboration and activity by receiver thread", () => {
    const materializer = new TurnMaterializer();
    const updates = [
      {
        sessionUpdate: "tool_call",
        toolCallId: "spawn-1",
        title: "spawnAgent",
        rawInput: {
          prompt: "Inspect persistence",
          receiverThreadIds: ["thread-1"],
          model: "gpt-5",
          reasoningEffort: "high",
          agentsStates: { "thread-1": { status: "running", message: null } },
        },
        _meta: {
          codex: {
            collaboration: {
              tool: "spawnAgent",
              senderThreadId: "root",
              receiverThreadIds: ["thread-1"],
            },
          },
        },
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "activity-1",
        title: "Started persistence researcher",
        rawInput: { agentThreadId: "thread-1", agentPath: ["root", "persistence"] },
        _meta: {
          codex: {
            subagent: {
              threadId: "thread-1",
              path: ["root", "persistence"],
              activity: "started",
            },
          },
        },
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "activity-2",
        title: "Interrupted persistence researcher",
        rawInput: { agentThreadId: "thread-1", agentPath: ["root", "persistence"] },
        _meta: {
          codex: {
            subagent: {
              threadId: "thread-1",
              path: ["root", "persistence"],
              activity: "interrupted",
            },
          },
        },
      },
    ] as SessionUpdate[];
    for (const update of updates) materializer.apply(update);

    // codex-acp completes the original collaboration item in place. Its
    // reported terminal state must beat the already appended started event.
    materializer.apply({
      sessionUpdate: "tool_call_update",
      toolCallId: "spawn-1",
      title: "spawnAgent",
      status: "completed",
      rawInput: {
        prompt: "Inspect persistence",
        receiverThreadIds: ["thread-1"],
        model: "gpt-5",
        reasoningEffort: "high",
        agentsStates: { "thread-1": { status: "completed", message: "Use layout storage." } },
      },
      _meta: {
        codex: {
          collaboration: { tool: "spawnAgent", receiverThreadIds: ["thread-1"] },
        },
      },
    } as SessionUpdate);

    const events = materializer.events;
    const index = buildSubagentTranscriptIndex(events);

    expect(index.referenceForKey("codex:thread-1")).toMatchObject({
      title: "persistence",
      prompt: "Inspect persistence",
      model: "gpt-5",
      reasoningEffort: "high",
      status: "completed",
    });
    expect(index.codexEntries("codex:thread-1")).toHaveLength(3);
    expect(subagentProvidesTranscript(index.referenceForKey("codex:thread-1")!)).toBe(false);
    expect(subagentStatusLabel(index.referenceForKey("codex:thread-1")?.status)).toBe("Completed");
    expect(index.referencesForTool(events[0] as never)).toHaveLength(1);
    expect(index.topLevelEvents).toHaveLength(3);
  });

  it("settles a started-only Codex subagent with its parent turn", () => {
    const events = materialize([
      {
        sessionUpdate: "tool_call",
        toolCallId: "activity-1",
        title: "Start subagent cwd_check",
        status: "completed",
        rawInput: {
          activityKind: "started",
          agentPath: "/root/cwd_check",
          agentThreadId: "thread-1",
        },
        _meta: {
          codex: {
            subagent: {
              activity: "started",
              path: "/root/cwd_check",
              threadId: "thread-1",
            },
          },
        },
      },
    ] as SessionUpdate[]);
    const completedTurn = {
      startedAt: "2026-08-02T12:00:00.000Z",
      endedAt: "2026-08-02T12:00:01.000Z",
      startIndex: 0,
      endIndex: 0,
    };

    expect(
      buildSubagentTranscriptIndex(events, [], {
        codexTurnActive: true,
        codexActiveTurnStartIndex: 0,
      }).referenceForKey("codex:thread-1")?.status,
    ).toBe("running");
    expect(
      buildSubagentTranscriptIndex(events, [completedTurn], {
        codexTurnActive: false,
      }).referenceForKey("codex:thread-1")?.status,
    ).toBe("completed");
    expect(
      buildSubagentTranscriptIndex(events, [{ ...completedTurn, interrupted: true }], {
        codexTurnActive: false,
      }).referenceForKey("codex:thread-1")?.status,
    ).toBe("interrupted");
    expect(
      buildSubagentTranscriptIndex(events, [], {
        codexTurnActive: true,
        codexActiveTurnStartIndex: events.length,
      }).referenceForKey("codex:thread-1")?.status,
    ).toBe("completed");
  });

  it("keeps an explicitly reported running Codex subagent running after its parent turn", () => {
    const events = materialize([
      {
        sessionUpdate: "tool_call",
        toolCallId: "spawn-1",
        title: "spawnAgent",
        status: "completed",
        rawInput: {
          receiverThreadIds: ["thread-1"],
          agentsStates: { "thread-1": { status: "running" } },
        },
        _meta: {
          codex: {
            collaboration: { tool: "spawnAgent", receiverThreadIds: ["thread-1"] },
          },
        },
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "activity-1",
        title: "Started subagent reviewer",
        status: "completed",
        rawInput: { agentThreadId: "thread-1", agentPath: "/root/reviewer" },
        _meta: {
          codex: {
            subagent: {
              threadId: "thread-1",
              path: "/root/reviewer",
              activity: "started",
            },
          },
        },
      },
    ] as SessionUpdate[]);

    expect(
      buildSubagentTranscriptIndex(
        events,
        [
          {
            startedAt: "2026-08-02T12:00:00.000Z",
            endedAt: "2026-08-02T12:00:01.000Z",
            startIndex: 0,
            endIndex: 1,
          },
        ],
        { codexTurnActive: false },
      ).referenceForKey("codex:thread-1")?.status,
    ).toBe("running");
  });

  it.each([
    ["failed", "resumeAgent"],
    ["failed", "closeAgent"],
    ["cancelled", "resumeAgent"],
    ["cancelled", "closeAgent"],
  ] as const)(
    "uses a %s tool status for %s when no child state was reported",
    (toolStatus, action) => {
      const events = materialize([
        {
          sessionUpdate: "tool_call",
          toolCallId: "collaboration-1",
          title: action,
          status: toolStatus,
          rawInput: { receiverThreadIds: ["thread-1"] },
          _meta: {
            codex: {
              collaboration: { tool: action, receiverThreadIds: ["thread-1"] },
            },
          },
        },
      ] as SessionUpdate[]);

      expect(buildSubagentTranscriptIndex(events).referenceForKey("codex:thread-1")?.status).toBe(
        toolStatus,
      );
    },
  );

  it("uses the latest Codex status event's turn when an old subagent is resumed", () => {
    const events = materialize([
      {
        sessionUpdate: "tool_call",
        toolCallId: "activity-1",
        title: "Start subagent reviewer",
        rawInput: { agentThreadId: "thread-1", agentPath: "/root/reviewer" },
        _meta: {
          codex: {
            subagent: {
              threadId: "thread-1",
              path: "/root/reviewer",
              activity: "started",
            },
          },
        },
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "First turn done." },
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "resume-1",
        title: "resumeAgent",
        rawInput: { receiverThreadIds: ["thread-1"] },
        _meta: {
          codex: {
            collaboration: { tool: "resumeAgent", receiverThreadIds: ["thread-1"] },
          },
        },
      },
    ] as SessionUpdate[]);
    const firstTurn = {
      startedAt: "2026-08-02T12:00:00.000Z",
      endedAt: "2026-08-02T12:00:01.000Z",
      startIndex: 0,
      endIndex: 1,
    };

    expect(
      buildSubagentTranscriptIndex(events, [firstTurn], {
        codexTurnActive: true,
        codexActiveTurnStartIndex: 2,
      }).referenceForKey("codex:thread-1")?.status,
    ).toBe("running");
    expect(
      buildSubagentTranscriptIndex(
        events,
        [
          firstTurn,
          {
            startedAt: "2026-08-02T12:01:00.000Z",
            endedAt: "2026-08-02T12:01:01.000Z",
            startIndex: 2,
            endIndex: 2,
          },
        ],
        { codexTurnActive: false },
      ).referenceForKey("codex:thread-1")?.status,
    ).toBe("completed");
  });
});
