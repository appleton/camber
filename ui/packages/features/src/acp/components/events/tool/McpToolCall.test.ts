import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import type { ToolCall } from "../../../types";
import ToolCallHarness from "./McpToolCall.test.svelte";

function mcpTool(overrides: Partial<ToolCall>): ToolCall {
  return {
    eventKind: "tool_call",
    toolCallId: "call_1",
    title: "linear - list_issues",
    kind: "execute",
    status: "completed",
    _meta: { tool_name: "linear__list_issues" },
    ...overrides,
  } as ToolCall;
}

describe("McpToolCall", () => {
  it("labels catalog-connector tools as 'Connector: tool'", () => {
    render(ToolCallHarness, { props: { event: mcpTool({}) } });

    expect(screen.getByText("Linear:")).toBeInTheDocument();
    expect(screen.getByText("list_issues")).toBeInTheDocument();
    expect(screen.queryByText("linear - list_issues")).not.toBeInTheDocument();
  });

  it("labels Pool-injected connectors, stripping the agent namespace", () => {
    render(ToolCallHarness, {
      props: {
        event: mcpTool({
          title: "camber__agent__slack__slack_search_channels",
          _meta: { tool_name: "camber__agent__slack__slack_search_channels" },
        }),
      },
    });

    expect(screen.getByText("Slack:")).toBeInTheDocument();
    expect(screen.getByText("slack_search_channels")).toBeInTheDocument();
  });

  it("falls back to 'server: tool' for servers outside the catalog", () => {
    render(ToolCallHarness, {
      props: {
        event: mcpTool({
          title: "my-custom-server - do_thing",
          _meta: { tool_name: "my-custom-server__do_thing" },
        }),
      },
    });

    expect(screen.getByText("my-custom-server:")).toBeInTheDocument();
    expect(screen.getByText("do_thing")).toBeInTheDocument();
  });

  it("renders an agent-owned dotted MCP call with its catalog provider", () => {
    render(ToolCallHarness, {
      props: {
        event: mcpTool({
          title: "mcp.codex_apps.github.create_pull_request",
          _meta: undefined,
        }),
      },
    });

    expect(screen.getByText("GitHub:")).toBeInTheDocument();
    expect(screen.getByText("create_pull_request")).toBeInTheDocument();
    expect(screen.queryByText("Run Shell Command:")).not.toBeInTheDocument();
  });

  it("pretty-prints JSON text output when expanded", async () => {
    render(ToolCallHarness, {
      props: {
        event: mcpTool({
          content: [
            {
              type: "content",
              content: { type: "text", text: '{"issues":[{"id":"LIN-1"}]}' },
            },
          ],
        }),
      },
    });

    await fireEvent.click(screen.getByRole("button", { name: /expand tool call/i }));

    const pre = document.querySelector("pre");
    expect(pre?.textContent).toBe('{\n  "issues": [\n    {\n      "id": "LIN-1"\n    }\n  ]\n}');
  });
});
