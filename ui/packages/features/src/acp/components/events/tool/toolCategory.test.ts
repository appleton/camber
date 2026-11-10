import { describe, expect, it } from "vitest";
import type { ToolCall } from "../../../types";
import { isMcpToolCall, isSkillToolCall } from "./toolCategory";

function tool(meta: Record<string, unknown> | undefined, title = "tool"): ToolCall {
  return {
    eventKind: "tool_call",
    toolCallId: "t",
    title,
    kind: "other",
    status: "completed",
    _meta: meta,
  } as ToolCall;
}

describe("tool categorization", () => {
  it("detects MCP tools by the __ namespace separator, across agents", () => {
    // Pool agent: <server>__<tool>, NO mcp__ prefix — the real case that regressed.
    expect(isMcpToolCall(tool({ tool_name: "camber-github__get_me" }))).toBe(true);
    // Claude Code: mcp__<server>__<tool>, nested under claudeCode.
    expect(isMcpToolCall(tool({ tool_name: "mcp__github__search_issues" }))).toBe(true);
    expect(isMcpToolCall(tool({ claudeCode: { toolName: "mcp__linear__list" } }))).toBe(true);
    // Built-ins never contain "__" (single underscores don't count).
    expect(isMcpToolCall(tool({ tool_name: "list_directory" }))).toBe(false);
    expect(isMcpToolCall(tool({ tool_name: "shell" }))).toBe(false);
    expect(isMcpToolCall(tool(undefined))).toBe(false);
  });

  it("detects agent-owned MCP tools by their dotted title", () => {
    expect(isMcpToolCall(tool(undefined, "mcp.codex_apps.github.create_pull_request"))).toBe(true);
    expect(isMcpToolCall(tool(undefined, "mcp.linear.list_issues"))).toBe(true);

    // A server and tool segment are both required.
    expect(isMcpToolCall(tool(undefined, "mcp.json"))).toBe(false);
    expect(isMcpToolCall(tool(undefined, "open mcp.linear.list_issues"))).toBe(false);
  });

  it("detects skills by the canonical tool name, not the title", () => {
    expect(isSkillToolCall(tool({ tool_name: "skill" }))).toBe(true);
    expect(isSkillToolCall(tool({ claudeCode: { toolName: "Skill" } }))).toBe(true);
    // A shell command that merely mentions "skill" in its title is not a skill.
    expect(isSkillToolCall(tool(undefined, "Skill"))).toBe(false);
    expect(isSkillToolCall(tool({ tool_name: "search" }))).toBe(false);
  });
});
