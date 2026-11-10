import { describe, expect, it } from "vitest";
import {
  parseClaudePromptSuggestion,
  withClaudeAppendSystemPrompt,
  withClaudeSessionFeatures,
} from "./claudePromptSuggestions";

describe("parseClaudePromptSuggestion", () => {
  it("parses Claude's native prompt suggestion", () => {
    expect(
      parseClaudePromptSuggestion({
        sessionId: "s1",
        message: {
          type: "prompt_suggestion",
          suggestion: "Run the focused tests",
          uuid: "suggestion-1",
          session_id: "claude-session-1",
        },
      }),
    ).toEqual({
      id: "suggestion-1",
      sessionId: "s1",
      text: "Run the focused tests",
    });
  });

  it.each([
    {},
    { sessionId: "s1", message: { type: "assistant", suggestion: "Ignore me" } },
    { sessionId: "s1", message: { type: "prompt_suggestion", suggestion: "  " } },
  ])("rejects unrelated or malformed SDK messages", (params) => {
    expect(parseClaudePromptSuggestion(params)).toBeNull();
  });
});

describe("withClaudeSessionFeatures", () => {
  it("selectively enables Claude's suggestions and supported raw messages", () => {
    expect(
      withClaudeSessionFeatures("claude-acp", {
        claudeCode: {
          options: { effort: "high" },
          emitRawSDKMessages: [{ type: "result" }],
        },
        other: true,
      }),
    ).toEqual({
      claudeCode: {
        options: { effort: "high", promptSuggestions: true },
        emitRawSDKMessages: [
          { type: "result" },
          { type: "prompt_suggestion" },
          { type: "active_goal" },
        ],
      },
      other: true,
    });
  });

  it("does not change another agent's metadata", () => {
    const meta = { other: true };
    expect(withClaudeSessionFeatures("codex-acp", meta)).toBe(meta);
  });

  it("can enable an aliased Claude registry agent", () => {
    expect(withClaudeSessionFeatures("my-claude", undefined, true)).toEqual({
      claudeCode: {
        options: { promptSuggestions: true },
        emitRawSDKMessages: [{ type: "prompt_suggestion" }, { type: "active_goal" }],
      },
    });
  });

  it("does not duplicate an existing goal filter", () => {
    expect(
      withClaudeSessionFeatures("claude-acp", {
        claudeCode: {
          emitRawSDKMessages: [{ type: "active_goal" }, { type: "prompt_suggestion" }],
        },
      }),
    ).toMatchObject({
      claudeCode: {
        emitRawSDKMessages: [{ type: "active_goal" }, { type: "prompt_suggestion" }],
      },
    });
  });
});

describe("withClaudeAppendSystemPrompt", () => {
  it("adds context without replacing existing Claude options", () => {
    expect(
      withClaudeAppendSystemPrompt(
        {
          claudeCode: {
            options: { effort: "high", appendSystemPrompt: "Existing context" },
          },
          other: true,
        },
        "Camber context",
      ),
    ).toEqual({
      claudeCode: {
        options: {
          effort: "high",
          appendSystemPrompt: "Existing context\n\nCamber context",
        },
      },
      other: true,
    });
  });

  it("ignores empty context", () => {
    const meta = { other: true };
    expect(withClaudeAppendSystemPrompt(meta, "  ")).toBe(meta);
  });
});
