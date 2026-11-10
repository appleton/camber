import { initializeStatefulModule as initializeHelperApi } from "@camber/helperapi";
import { render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { get } from "svelte/store";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_AGENT_SERVER } from "../../agentServers";
import { ACPSessionRepositoryWriter } from "../../features/SessionRepository.svelte";
import { appState } from "../../hostAdapter";
import type { ACPConversationSummary } from "../../navTypes";
import { buildSessionInfo } from "../../sessionInfo";
import SidebarControllerAgentHarness from "./SidebarControllerAgent.test.svelte";

describe("AcpSidebarController", () => {
  it("uses the routed live session agent while the persisted summary catches up", async () => {
    initializeHelperApi({
      jsonrpcCall: vi.fn().mockResolvedValue({ entry: null }),
      jsonrpcNotify: vi.fn().mockResolvedValue(undefined),
    });
    const previous = get(appState);
    appState.set({
      ...previous,
      environment: { ...previous.environment, assistantHost: "desktop" },
    });

    try {
      const repo = new ACPSessionRepositoryWriter();
      repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conversation-1");
      const { sessionId: _sessionId, ...sessionInfo } = buildSessionInfo(
        "source-session",
        "/repo",
        "native_session",
      );
      const summary: ACPConversationSummary = {
        ...sessionInfo,
        id: "conversation-1",
        sessionId: "source-session",
        agentServer: DEFAULT_AGENT_SERVER,
        title: "Handed off conversation",
        workingDirectories: ["/repo"],
      };

      render(SidebarControllerAgentHarness, {
        props: { repo: repo.publicAPI(), summary },
      });
      expect(screen.getByTestId("sidebar-agent")).toHaveTextContent(DEFAULT_AGENT_SERVER);

      repo.createSession("/repo", "codex-acp", "conversation-1");
      await tick();

      expect(screen.getByTestId("sidebar-agent")).toHaveTextContent("codex-acp");
    } finally {
      appState.set(previous);
    }
  });
});
