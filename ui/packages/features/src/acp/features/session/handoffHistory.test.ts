import type { ACPNavConversationLeg } from "@camber/helperapi/schemas";
import { describe, expect, it } from "vitest";
import { materializeConversationHistory } from "./handoffHistory";

describe("materializeConversationHistory", () => {
  it("joins frozen agent legs with handoff boundaries and offsets turns", () => {
    const legs: ACPNavConversationLeg[] = [
      {
        handoffId: "handoff-a",
        ordinal: 0,
        agentServer: "poolside",
        sessionId: "session-a",
        targetAgentServer: "codex-acp",
        targetSessionId: "session-b",
        schemaVersion: 1,
        createdAt: "2026-07-16T10:02:00.000Z",
        events: [
          { eventKind: "user_message", messageId: null, content: [{ type: "text", text: "A" }] },
          {
            eventKind: "agent_message",
            messageId: null,
            content: [{ type: "text", text: "B" }],
          },
        ],
        turns: [
          {
            startedAt: "2026-07-16T10:00:00.000Z",
            endedAt: "2026-07-16T10:01:00.000Z",
            startIndex: 0,
            endIndex: 1,
          },
        ],
        plan: null,
      },
      {
        handoffId: "handoff-b",
        ordinal: 1,
        agentServer: "codex-acp",
        sessionId: "session-b",
        targetAgentServer: "claude-acp",
        targetSessionId: "session-c",
        schemaVersion: 1,
        createdAt: "2026-07-16T10:05:00.000Z",
        events: [
          {
            eventKind: "agent_message",
            messageId: null,
            content: [{ type: "text", text: "C" }],
          },
        ],
        turns: [
          {
            startedAt: "2026-07-16T10:03:00.000Z",
            endedAt: "2026-07-16T10:04:00.000Z",
            startIndex: 0,
            endIndex: 0,
          },
        ],
        plan: { entries: [{ content: "Ship it", priority: "high", status: "in_progress" }] },
      },
    ];

    const result = materializeConversationHistory({ legs });

    expect(result.events.map((event) => event.eventKind)).toEqual([
      "user_message",
      "agent_message",
      "handoff",
      "agent_message",
      "handoff",
    ]);
    expect(result.turns).toEqual([
      expect.objectContaining({ startIndex: 0, endIndex: 1 }),
      expect.objectContaining({ startIndex: 3, endIndex: 3 }),
    ]);
    expect(result.plan).toEqual(
      expect.objectContaining({ entries: [expect.objectContaining({ content: "Ship it" })] }),
    );
    expect(result.skippedLegs).toBe(0);
  });

  it("drops invalid turn metadata without losing the leg's events", () => {
    const result = materializeConversationHistory({
      legs: [
        {
          handoffId: "handoff-a",
          ordinal: 0,
          agentServer: "poolside",
          sessionId: "session-a",
          targetAgentServer: "codex-acp",
          createdAt: "2026-07-16T10:02:00.000Z",
          schemaVersion: 1,
          events: [
            { eventKind: "user_message", messageId: null, content: [{ type: "text", text: "A" }] },
          ],
          turns: [
            // A turn cancelled before any event materialized (endIndex < startIndex),
            // an out-of-range turn, and a malformed entry.
            {
              startedAt: "2026-07-16T10:00:00.000Z",
              endedAt: "2026-07-16T10:00:30.000Z",
              startIndex: 1,
              endIndex: 0,
            },
            {
              startedAt: "2026-07-16T10:00:00.000Z",
              endedAt: "2026-07-16T10:01:00.000Z",
              startIndex: 0,
              endIndex: 5,
            },
            { bogus: true },
            {
              startedAt: "2026-07-16T10:00:00.000Z",
              endedAt: "2026-07-16T10:01:00.000Z",
              startIndex: 0,
              endIndex: 0,
            },
          ],
          plan: null,
        },
      ],
    });

    expect(result.events.map((event) => event.eventKind)).toEqual(["user_message", "handoff"]);
    expect(result.turns).toEqual([expect.objectContaining({ startIndex: 0, endIndex: 0 })]);
    expect(result.skippedLegs).toBe(0);
  });

  it("skips unsupported or corrupt legs without hiding valid history", () => {
    const result = materializeConversationHistory({
      legs: [
        {
          handoffId: "old",
          ordinal: 0,
          agentServer: "poolside",
          sessionId: "a",
          targetAgentServer: "codex-acp",
          createdAt: "now",
          schemaVersion: 99,
          events: [],
          turns: [],
        },
        {
          handoffId: "valid",
          ordinal: 1,
          agentServer: "codex-acp",
          sessionId: "b",
          targetAgentServer: "claude-acp",
          createdAt: "later",
          schemaVersion: 1,
          events: [],
          turns: [],
          plan: null,
        },
      ],
    });

    expect(result.events).toEqual([
      expect.objectContaining({ eventKind: "handoff", sourceSessionId: "b" }),
    ]);
    expect(result.skippedLegs).toBe(1);
  });
});
