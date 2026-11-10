import { describe, expect, it } from "vitest";
import type { ToolCall } from "../../../types";
import { getMcpToolInfo, isMcpToolCallOverride, prettyPrintJson } from "./mcpTool";

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

describe("getMcpToolInfo", () => {
  it("splits Pool-format names into server and tool", () => {
    const info = getMcpToolInfo(tool({ tool_name: "camber-github__get_me" }));
    expect(info).toMatchObject({ serverName: "camber-github", toolName: "get_me" });
    // Pool built-in servers are not catalog connectors.
    expect(info?.connector).toBeUndefined();
  });

  it("strips Claude Code's mcp__ prefix", () => {
    const info = getMcpToolInfo(tool({ claudeCode: { toolName: "mcp__linear__list_issues" } }));
    expect(info).toMatchObject({ serverName: "linear", toolName: "list_issues" });
  });

  it("strips the Pool agent's namespace for client-injected connectors", () => {
    const info = getMcpToolInfo(tool({ tool_name: "camber__agent__slack__slack_search_channels" }));
    expect(info).toMatchObject({ serverName: "slack", toolName: "slack_search_channels" });
    expect(info?.connector?.label).toBe("Slack");
  });

  it("resolves an agent-owned dotted MCP provider against the connector catalog", () => {
    const info = getMcpToolInfo(tool(undefined, "mcp.codex_apps.github.create_pull_request"));
    expect(info).toMatchObject({
      serverName: "codex_apps.github",
      toolName: "create_pull_request",
      connector: { id: "github", label: "GitHub" },
    });
  });

  it("matches tool-safe underscores to hyphenated connector ids", () => {
    const info = getMcpToolInfo(tool(undefined, "mcp.codex_apps.new_relic.list_issues"));
    expect(info).toMatchObject({
      serverName: "codex_apps.new_relic",
      toolName: "list_issues",
      connector: { id: "new-relic", label: "New Relic" },
    });
  });

  it("keeps the generic MCP treatment for unknown dotted providers", () => {
    const info = getMcpToolInfo(tool(undefined, "mcp.agent.unknown_provider.do_thing"));
    expect(info).toMatchObject({
      serverName: "agent.unknown_provider",
      toolName: "do_thing",
    });
    expect(info?.connector).toBeUndefined();
  });

  it("keeps later separators inside the tool name", () => {
    const info = getMcpToolInfo(tool({ tool_name: "mcp__slack__slack__send" }));
    expect(info).toMatchObject({ serverName: "slack", toolName: "slack__send" });
  });

  it("resolves catalog connectors by server name", () => {
    expect(getMcpToolInfo(tool({ tool_name: "linear__list_issues" }))?.connector?.label).toBe(
      "Linear",
    );
    expect(
      getMcpToolInfo(tool({ claudeCode: { toolName: "mcp__slack__slack_send_message" } }))
        ?.connector?.label,
    ).toBe("Slack");
    expect(getMcpToolInfo(tool({ tool_name: "my-custom-server__do" }))?.connector).toBeUndefined();
  });

  it("returns undefined for non-MCP tools", () => {
    expect(getMcpToolInfo(tool({ tool_name: "shell" }))).toBeUndefined();
    expect(getMcpToolInfo(tool({ tool_name: "list_directory" }))).toBeUndefined();
    expect(getMcpToolInfo(tool(undefined, "mcp.json"))).toBeUndefined();
    expect(getMcpToolInfo(tool(undefined))).toBeUndefined();
  });
});

describe("isMcpToolCallOverride", () => {
  it("matches MCP tools but leaves permission denials to the generic renderer", () => {
    expect(isMcpToolCallOverride(tool({ tool_name: "linear__list_issues" }))).toBe(true);
    expect(isMcpToolCallOverride(tool({ tool_name: "shell" }))).toBe(false);

    const denied = tool({ tool_name: "linear__list_issues" });
    denied.rawOutput = { observation: "user denied permission to run the tool" };
    denied.status = "failed";
    expect(isMcpToolCallOverride(denied)).toBe(false);
  });
});

describe("prettyPrintJson", () => {
  it("indents objects and serialized JSON strings", () => {
    expect(prettyPrintJson({ ok: true })).toBe('{\n  "ok": true\n}');
    expect(prettyPrintJson('{"ok":true}')).toBe('{\n  "ok": true\n}');
    expect(prettyPrintJson("  [1,2]  ")).toBe("[\n  1,\n  2\n]");
  });

  it("returns undefined for non-JSON values", () => {
    expect(prettyPrintJson("plain text output")).toBeUndefined();
    expect(prettyPrintJson('{"truncated": ')).toBeUndefined();
    expect(prettyPrintJson(null)).toBeUndefined();
    expect(prettyPrintJson(undefined)).toBeUndefined();
  });
});
