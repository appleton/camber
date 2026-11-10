import { describe, expect, it } from "vitest";
import type { SessionEventGroupItem } from "../../SessionEventsState.svelte";
import { summarizeLiveToolGroup, summarizeToolGroup } from "./toolGroupSummary";

describe("summarizeToolGroup", () => {
  it("summarizes duration, unique edited files, and command count", () => {
    const events: SessionEventGroupItem[] = [
      {
        index: 0,
        event: {
          eventKind: "tool_call",
          toolCallId: "edit-1",
          title: "Edit src/app.ts",
          kind: "edit",
          status: "completed",
          rawInput: { path: "/repo/src/app.ts" },
        },
      },
      {
        index: 1,
        event: {
          eventKind: "tool_call",
          toolCallId: "edit-2",
          title: "Edit src/app.ts",
          kind: "edit",
          status: "completed",
          content: [
            {
              type: "diff",
              path: "/repo/src/app.ts",
              oldText: "a",
              newText: "b",
            },
          ],
        },
      },
      {
        index: 2,
        event: {
          eventKind: "tool_call",
          toolCallId: "run-1",
          title: "exec_command",
          kind: "execute",
          status: "completed",
          rawInput: { cmd: "pnpm test" },
        },
      },
    ];

    expect(
      summarizeToolGroup(events, {
        startedAt: "2026-06-02T10:00:00.000Z",
        endedAt: "2026-06-02T10:04:30.000Z",
        startIndex: 0,
        endIndex: 2,
      }),
    ).toBe("Worked for 5 minutes, edited 1 file, ran 1 command");
  });

  it("omits duration when turn timestamps are unavailable", () => {
    expect(
      summarizeToolGroup([
        {
          index: 0,
          event: {
            eventKind: "tool_call",
            toolCallId: "run-1",
            title: "exec_command",
            kind: "execute",
            status: "completed",
            rawInput: { commands: ["pnpm lint", "pnpm test"] },
          },
        },
      ] satisfies SessionEventGroupItem[]),
    ).toBe("Ran 2 commands");
  });

  it("marks an interrupted turn", () => {
    expect(
      summarizeToolGroup(cancelledCommand(), {
        startedAt: "2026-06-02T10:00:00.000Z",
        endedAt: "2026-06-02T10:03:00.000Z",
        startIndex: 0,
        endIndex: 0,
        interrupted: true,
      }),
    ).toBe("Interrupted after 3 minutes, ran 1 command");
  });

  it("marks an interrupted turn without a duration", () => {
    expect(
      summarizeToolGroup(cancelledCommand(), {
        startedAt: "",
        endedAt: "",
        startIndex: 0,
        endIndex: 0,
        interrupted: true,
      }),
    ).toBe("Interrupted, ran 1 command");
  });

  it("falls back to a step count that ignores think filler in mixed groups", () => {
    expect(
      summarizeToolGroup([
        kindTool("read-1", "read", { path: "/repo/a.ts" }),
        kindTool("think-1", "think"),
        kindTool("think-2", "think"),
      ]),
    ).toBe("1 step");
  });

  it("falls back to counting think steps when the group has nothing else", () => {
    expect(summarizeToolGroup([kindTool("think-1", "think"), kindTool("think-2", "think")])).toBe(
      "2 steps",
    );
  });
});

describe("summarizeLiveToolGroup", () => {
  it("joins per-kind counts in a stable order", () => {
    const events: SessionEventGroupItem[] = [
      kindTool("run-1", "execute", { cmd: "pnpm test" }),
      kindTool("read-1", "read", { path: "/repo/a.ts" }),
      kindTool("read-2", "read", { path: "/repo/b.ts" }),
      kindTool("search-1", "search"),
    ];

    expect(summarizeLiveToolGroup(events)).toBe("Read 2 files, searched once, ran 1 command");
  });

  it("reads as a single phrase when only one kind is present", () => {
    const events: SessionEventGroupItem[] = [
      kindTool("read-1", "read", { path: "/repo/a.ts" }),
      kindTool("read-2", "read", { path: "/repo/b.ts" }),
    ];

    expect(summarizeLiveToolGroup(events)).toBe("Read 2 files");
  });

  it("counts distinct files for reads and ignores re-reads of the same path", () => {
    const events: SessionEventGroupItem[] = [
      kindTool("read-1", "read", { path: "/repo/src/app.ts" }),
      kindTool("read-2", "read", { path: "/repo/src/app.ts" }),
      kindTool("read-3", "read", { path: "/repo/src/other.ts" }),
    ];

    expect(summarizeLiveToolGroup(events)).toBe("Read 2 files");
  });

  it("counts pathless reads individually", () => {
    const events: SessionEventGroupItem[] = [
      kindTool("read-1", "read"),
      kindTool("read-2", "read"),
    ];

    expect(summarizeLiveToolGroup(events)).toBe("Read 2 files");
  });

  it("counts command invocations across batched executes", () => {
    const events: SessionEventGroupItem[] = [
      kindTool("run-1", "execute", { commands: ["pnpm lint", "pnpm test"] }),
      kindTool("run-2", "execute", { cmd: "pnpm build" }),
    ];

    expect(summarizeLiveToolGroup(events)).toBe("Ran 3 commands");
  });

  it("labels search runs by occurrence", () => {
    const events: SessionEventGroupItem[] = [
      kindTool("search-1", "search"),
      kindTool("search-2", "search"),
      kindTool("search-3", "search"),
    ];

    expect(summarizeLiveToolGroup(events)).toBe("Searched 3 times");
  });

  it("labels edits with distinct file counts", () => {
    const events: SessionEventGroupItem[] = [
      kindTool("edit-1", "edit", { path: "/repo/a.ts" }),
      kindTool("edit-2", "edit", { path: "/repo/b.ts" }),
    ];

    expect(summarizeLiveToolGroup(events)).toBe("Edited 2 files");
  });

  it("counts unknown kinds as other steps and ignores think steps", () => {
    const events: SessionEventGroupItem[] = [
      kindTool("read-1", "read", { path: "/repo/a.ts" }),
      kindTool("read-2", "read", { path: "/repo/b.ts" }),
      kindTool("mcp-1", "other"),
      kindTool("mcp-2", "other"),
      kindTool("think-1", "think"),
    ];

    expect(summarizeLiveToolGroup(events)).toBe("Read 2 files, 2 other steps");
  });

  it("falls back to a plain step count for think-only groups", () => {
    const events: SessionEventGroupItem[] = [
      kindTool("think-1", "think"),
      kindTool("think-2", "think"),
    ];

    expect(summarizeLiveToolGroup(events)).toBe("2 steps");
  });
});

describe("MCP and skill breakdown", () => {
  it("labels an MCP group and a skill group", () => {
    expect(
      summarizeLiveToolGroup([
        metaTool("m1", "camber-github__get_me"),
        metaTool("m2", "camber-github__list_issues"),
      ]),
    ).toBe("Used 2 MCP tools");
    expect(summarizeLiveToolGroup([metaTool("s1", "skill")])).toBe("Used 1 skill");
  });

  it("breaks MCP and skill out of the settled summary instead of counting them as commands", () => {
    const events: SessionEventGroupItem[] = [
      metaTool("m1", "camber-github__get_me"),
      metaTool("s1", "skill"),
      kindTool("run-1", "execute", { cmd: "pnpm test" }),
    ];
    expect(summarizeToolGroup(events)).toBe("Ran 1 command, used 1 MCP tool, used 1 skill");
  });

  it("breaks MCP tools out of the compact live summary", () => {
    const events: SessionEventGroupItem[] = [
      kindTool("read-1", "read", { path: "/repo/a.ts" }),
      metaTool("m1", "camber-github__get_me"),
      metaTool("m2", "camber-github__list_issues"),
    ];
    expect(summarizeLiveToolGroup(events)).toBe("Read 1 file, used 2 MCP tools");
  });

  it("counts an edit-kind MCP tool once, as an edit rather than also an MCP tool", () => {
    const events: SessionEventGroupItem[] = [
      {
        index: 0,
        event: {
          eventKind: "tool_call",
          toolCallId: "mcp-edit",
          title: "filesystem__edit_file",
          // Some agents (e.g. Claude Code MCP file tools) tag an MCP call with
          // an edit-family kind; it must land in exactly one summary category.
          kind: "edit",
          status: "completed",
          _meta: { tool_name: "filesystem__edit_file" }, // "__" => isMcpToolCall true
          rawInput: { path: "/repo/a.ts" },
        },
      },
    ];
    expect(summarizeToolGroup(events)).toBe("Edited 1 file");
  });
});

function kindTool(
  toolCallId: string,
  kind: "read" | "edit" | "search" | "execute" | "other" | "think",
  rawInput?: Record<string, unknown>,
): SessionEventGroupItem {
  return {
    index: 0,
    event: {
      eventKind: "tool_call",
      toolCallId,
      title: toolCallId,
      kind,
      status: "completed",
      rawInput,
    },
  };
}

function metaTool(toolCallId: string, toolName: string): SessionEventGroupItem {
  // Pool skills/MCP tools arrive as kind "execute", categorized via _meta.tool_name.
  return {
    index: 0,
    event: {
      eventKind: "tool_call",
      toolCallId,
      title: toolCallId,
      kind: "execute",
      status: "completed",
      _meta: { tool_name: toolName },
    },
  };
}

function cancelledCommand(): SessionEventGroupItem[] {
  return [
    {
      index: 0,
      event: {
        eventKind: "tool_call",
        toolCallId: "run-1",
        title: "exec_command",
        kind: "execute",
        status: "cancelled",
        rawInput: { cmd: "pnpm test" },
      },
    },
  ];
}
