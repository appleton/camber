import { describe, expect, it } from "vitest";
import type { ToolCall } from "../../../types";
import { formatFetchUrl, getFetchUrl, isFetchToolCall } from "./fetchTool";

describe("fetch ACP tool override", () => {
  // Shape captured live from the Camber agent via camberqa.
  it("matches Camber web_fetch (kind execute, rawInput.url)", () => {
    const tool = {
      eventKind: "tool_call",
      toolCallId: "chatcmpl-tool-815a00fa7da849c0",
      title: "web_fetch",
      kind: "execute",
      status: "completed",
      rawInput: {
        objective: "Get the content of the ACP llms.txt file for a summary",
        url: "https://agentclientprotocol.com/llms.txt",
      },
    } satisfies ToolCall;

    expect(isFetchToolCall(tool)).toBe(true);
    expect(getFetchUrl(tool)).toBe("https://agentclientprotocol.com/llms.txt");
  });

  // Shape captured live from the Codex agent via camberqa (merged tool_call +
  // tool_call_update): kind "fetch", URL nested under action.
  it("matches Codex open_page (kind fetch, rawInput.action.url)", () => {
    const tool = {
      eventKind: "tool_call",
      toolCallId: "ws_03c67dff913208b4",
      title: "Opening: https://agentclientprotocol.com/llms.txt",
      kind: "fetch",
      status: "in_progress",
      rawInput: {
        action: { type: "open_page", url: "https://agentclientprotocol.com/llms.txt" },
        query: "https://agentclientprotocol.com/llms.txt",
      },
    } satisfies ToolCall;

    expect(isFetchToolCall(tool)).toBe(true);
    expect(getFetchUrl(tool)).toBe("https://agentclientprotocol.com/llms.txt");
  });

  it("does not match a Codex web search with no URL (leaves it generic)", () => {
    const tool = {
      eventKind: "tool_call",
      toolCallId: "ws_search",
      title: "Searching the Web",
      kind: "fetch",
      status: "in_progress",
      rawInput: { action: { type: "search" }, query: "agent client protocol" },
    } satisfies ToolCall;

    expect(isFetchToolCall(tool)).toBe(false);
    expect(getFetchUrl(tool)).toBeUndefined();
  });

  it("extracts the first url from a urls array and from a raw string", () => {
    expect(
      getFetchUrl({
        eventKind: "tool_call",
        toolCallId: "call_3",
        title: "Fetch",
        kind: "fetch",
        rawInput: { urls: ["https://a.test", "https://b.test"] },
      } satisfies ToolCall),
    ).toBe("https://a.test");

    expect(
      getFetchUrl({
        eventKind: "tool_call",
        toolCallId: "call_4",
        title: "Fetch",
        kind: "fetch",
        rawInput: "https://raw.test/path",
      } satisfies ToolCall),
    ).toBe("https://raw.test/path");
  });

  it("does not hijack an unrelated execute tool that lacks a fetch title", () => {
    const tool = {
      eventKind: "tool_call",
      toolCallId: "call_run",
      title: "Run",
      kind: "execute",
      rawInput: { command: "curl https://example.com" },
    } satisfies ToolCall;

    expect(isFetchToolCall(tool)).toBe(false);
  });

  it("strips the scheme and trailing slash for display", () => {
    expect(formatFetchUrl("https://example.com/")).toBe("example.com");
    expect(formatFetchUrl("http://example.com/docs/")).toBe("example.com/docs");
  });
});
