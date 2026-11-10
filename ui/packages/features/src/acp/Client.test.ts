import type { RequestPermissionRequest, SessionNotification } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import { ACPClient } from "./Client";
import { DEFAULT_AGENT_SERVER } from "./agentServers";
import type { ACPSessionRepositoryWriter } from "./features/SessionRepository.svelte";

function createMockRepo(): ACPSessionRepositoryWriter {
  return {
    handleSessionUpdate: vi.fn(),
    handleCompactionUpdate: vi.fn(),
    handleTurnEnded: vi.fn(),
    handlePromptSuggestion: vi.fn(),
    handleGoalUpdate: vi.fn(),
    handleRequestPermission: vi.fn().mockReturnValue({
      outcome: { outcome: "selected", optionId: "allow" },
    }),
  } as unknown as ACPSessionRepositoryWriter;
}

describe("ACPClient", () => {
  describe("requestPermission", () => {
    it("delegates to repo.handleRequestPermission", async () => {
      const repo = createMockRepo();
      const client = new ACPClient(repo);
      const params: RequestPermissionRequest = {
        sessionId: "s1",
        toolCall: { toolCallId: "tc-1" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      };

      const result = await client.requestPermission(params);

      expect(repo.handleRequestPermission).toHaveBeenCalledWith(DEFAULT_AGENT_SERVER, params);
      expect(result).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    });
  });

  describe("sessionUpdate", () => {
    it("delegates to repo.handleSessionUpdate", async () => {
      const repo = createMockRepo();
      const client = new ACPClient(repo);
      const params = { sessionId: "s1" } as SessionNotification;

      await client.sessionUpdate(params);

      expect(repo.handleSessionUpdate).toHaveBeenCalledWith(DEFAULT_AGENT_SERVER, params);
    });
  });

  describe("Camber turn lifecycle", () => {
    it("routes helper-owned turn completion to its session", async () => {
      const repo = createMockRepo();
      const client = new ACPClient(repo, "codex-acp");

      await client.extNotification("camber/acp/turn_ended", { sessionId: "s1" });

      expect(repo.handleTurnEnded).toHaveBeenCalledWith("codex-acp", { sessionId: "s1" });
    });
  });

  describe("Claude prompt suggestions", () => {
    it("routes a valid native suggestion to its session", async () => {
      const repo = createMockRepo();
      const client = new ACPClient(repo, "claude-acp");

      await client.extNotification("_claude/sdkMessage", {
        sessionId: "s1",
        message: {
          type: "prompt_suggestion",
          suggestion: "Run the focused tests",
          uuid: "suggestion-1",
          session_id: "claude-session-1",
        },
      });

      expect(repo.handlePromptSuggestion).toHaveBeenCalledWith("claude-acp", {
        id: "suggestion-1",
        sessionId: "s1",
        text: "Run the focused tests",
      });
    });

    it("ignores unrelated raw SDK messages", async () => {
      const repo = createMockRepo();
      const client = new ACPClient(repo, "claude-acp");

      await client.extNotification("_claude/sdkMessage", {
        sessionId: "s1",
        message: { type: "assistant", suggestion: "Ignore me" },
      });

      expect(repo.handlePromptSuggestion).not.toHaveBeenCalled();
    });
  });

  describe("Claude goals", () => {
    it("routes active and cleared goal notifications to their session", async () => {
      const repo = createMockRepo();
      const client = new ACPClient(repo, "claude-acp");

      await client.extNotification("_claude/sdkMessage", {
        sessionId: "s1",
        message: {
          type: "active_goal",
          value: {
            condition: "Land the release",
            iterations: 2,
            set_at: 1_722_500_000,
            tokens_at_start: 12_400,
          },
        },
      });
      await client.extNotification("_claude/sdkMessage", {
        sessionId: "s1",
        message: { type: "active_goal", value: null },
      });

      expect(repo.handleGoalUpdate).toHaveBeenNthCalledWith(1, "claude-acp", {
        sessionId: "s1",
        goal: expect.objectContaining({
          source: "claude",
          objective: "Land the release",
          status: "active",
        }),
      });
      expect(repo.handleGoalUpdate).toHaveBeenNthCalledWith(2, "claude-acp", {
        sessionId: "s1",
        goal: null,
      });
    });
  });
});
