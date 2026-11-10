import { describe, expect, it } from "vitest";
import type { AcpAgentRegistryRepository } from "../../../../features/AgentRegistryRepository.svelte";
import type { ACPChatSessionScope } from "../../../../features/ChatSessionScope.svelte";
import type { ACPSessionRepository } from "../../../../features/SessionRepository.svelte";
import {
  agentIconUrl,
  agentName,
  agentPickerIconProps,
  agentPickerIconUrl,
  agentPickerOverlayIconUrl,
  agentServerOptions,
  isClaudeAgent,
  selectedAgentServer,
  shouldResetSessionForAgentSelection,
} from "./agentConfig";

function repo(overrides: Record<string, any> = {}): ACPSessionRepository {
  return {
    agents: {
      agentServerNames: ["poolside", "codex"],
    },
    sessionAgentServer: "poolside",
    ...overrides,
  } as unknown as ACPSessionRepository;
}

function scope(overrides: Partial<ACPChatSessionScope> = {}): ACPChatSessionScope {
  return {
    activeAgentServer: "poolside",
    sessionAgentServer: "poolside",
    ...overrides,
  } as ACPChatSessionScope;
}

function registry(
  agents: Record<string, { id?: string; name: string } | string>,
): AcpAgentRegistryRepository {
  return {
    getAgent: (id: string) => {
      const agent = agents[id];
      return typeof agent === "string" ? { name: agent } : agent;
    },
  } as AcpAgentRegistryRepository;
}

describe("agent config menu helpers", () => {
  it("falls back to the default Camber agent when no agent servers are configured", () => {
    expect(agentServerOptions(repo({ agents: { agentServerNames: [] } }))).toEqual(["poolside"]);
    expect(selectedAgentServer(scope({ activeAgentServer: "" }))).toBe("poolside");
  });

  it("uses Camber and registry display names for agent labels", () => {
    const agents = registry({ codex: "Codex CLI" });

    expect(agentName(agents, "poolside")).toBe("Camber");
    expect(agentName(agents, "local")).toBe("Camber Local");
    expect(agentName(agents, "codex")).toBe("Codex CLI");
    expect(agentName(agents, "unknown")).toBe("unknown");
  });

  it("returns picker-only brand colours for Camber and Anthropic agent icons", () => {
    const agents = registry({
      aliasedClaude: { id: "claude-acp", name: "Claude Agent" },
      codex: { id: "codex-acp", name: "Codex" },
    });

    expect(agentPickerIconProps(agents, "poolside")).toEqual({ class: "text-psx-vibrant" });
    expect(agentPickerIconProps(agents, "local")).toMatchObject({
      class: "text-psx-vibrant",
      overlayClass: "text-psx-foreground-tertiary",
    });
    expect(agentPickerIconProps(agents, "claude-acp")).toEqual({ class: "text-[#d97757]" });
    expect(agentPickerIconProps(agents, "aliasedClaude")).toEqual({
      class: "text-[#d97757]",
    });
    expect(agentPickerIconProps(agents, "codex")).toEqual({ class: "" });
    expect(agentPickerIconUrl(agents, "local")).not.toBe(agentIconUrl(agents, "local"));
  });

  it("exposes the local agent's badge overlay for native menu rasterization", () => {
    const agents = registry({ codex: { id: "codex-acp", name: "Codex" } });

    // The same overlay the DOM picker stacks over the roundel, so the native
    // menu composites an identical icon.
    expect(agentPickerOverlayIconUrl("local")).toBe(
      agentPickerIconProps(agents, "local").overlayIconUrl,
    );
    expect(agentPickerOverlayIconUrl("local")).toMatch(/^data:image\/svg\+xml,/);
    expect(agentPickerOverlayIconUrl("poolside")).toBeUndefined();
    expect(agentPickerOverlayIconUrl("codex")).toBeUndefined();
  });

  it("identifies Claude by server key or registry agent id", () => {
    const agents = registry({
      aliasedClaude: { id: "claude-acp", name: "Claude Agent" },
      codex: { id: "codex-acp", name: "Codex" },
    });

    expect(isClaudeAgent(agents, "claude-acp")).toBe(true);
    expect(isClaudeAgent(agents, "aliasedClaude")).toBe(true);
    expect(isClaudeAgent(agents, "codex")).toBe(false);
    expect(isClaudeAgent(agents, "unknown")).toBe(false);
  });

  it("resets the current draft when switching away from the selected session agent", () => {
    expect(shouldResetSessionForAgentSelection(scope(), "poolside")).toBe(false);
    expect(shouldResetSessionForAgentSelection(scope(), "codex")).toBe(true);
    expect(
      shouldResetSessionForAgentSelection(scope({ activeAgentServer: "codex" }), "codex"),
    ).toBe(true);
  });
});
