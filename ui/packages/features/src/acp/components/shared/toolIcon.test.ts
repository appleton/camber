import { describe, expect, it } from "vitest";
import type { ToolCall } from "../../types";
import { getToolIcon } from "./toolIcon";

function tool(kind: ToolCall["kind"], extra: Partial<ToolCall> = {}): ToolCall {
  return { eventKind: "tool_call", toolCallId: "x", title: "t", kind, ...extra };
}

describe("getToolIcon", () => {
  it("gives think tools an icon so a detail-less row is not icon-less", () => {
    expect(getToolIcon(tool("think"))).toBe("sparkles");
  });

  it("keeps the existing kind icons", () => {
    expect(getToolIcon(tool("search"))).toBe("search");
    expect(getToolIcon(tool("execute"))).toBe("terminal");
    expect(getToolIcon(tool("fetch"))).toBe("web");
  });

  it("shows a folder for a directory listing even though its ACP kind is read", () => {
    const listing = tool("read", {
      _meta: { tool_name: "list_directory" },
      rawInput: { path: "/repo/src" },
    });
    expect(getToolIcon(listing)).toBe("folder");
  });

  it("keeps a file glyph for an ordinary read", () => {
    const read = tool("read", { _meta: { tool_name: "read" }, rawInput: { path: "/repo/a.ts" } });
    expect(getToolIcon(read)).toMatchObject({ type: "file" });
  });

  it("gives MCP tools their own icon instead of the shell glyph", () => {
    // Pool MCP tool: kind "execute", server__tool name — the regressed case.
    const mcp = tool("execute", { _meta: { tool_name: "camber-github__get_me" } });
    expect(getToolIcon(mcp)).toBe("mcp");
  });

  it("gives agent-owned dotted MCP tools their own icon", () => {
    const mcp = tool("execute", { title: "mcp.codex_apps.github.create_pull_request" });
    expect(getToolIcon(mcp)).toBe("mcp");
  });

  it("gives skills their own icon instead of the shell glyph", () => {
    // Pool skill: kind "execute", tool_name "skill".
    const skill = tool("execute", { _meta: { tool_name: "skill" } });
    expect(getToolIcon(skill)).toBe("skills");
  });

  it("keeps an unrecognized other tool on the terminal icon", () => {
    expect(getToolIcon(tool("other", { title: "something" }))).toBe("terminal");
  });

  it("falls back to a sparkles glyph for tools with no kind (e.g. codex)", () => {
    // codex sends tool calls with kind null/undefined and no _meta.tool_name.
    expect(getToolIcon(tool(undefined, { title: "Tool: codex/list_mcp_resources" }))).toBe(
      "sparkles",
    );
  });
});
