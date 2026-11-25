import { DEFAULT_AGENT_SERVER } from "../../../../agentServers";
import type { AcpAgentRegistryRepository } from "../../../../features/AgentRegistryRepository.svelte";
import type { ACPChatSessionScope } from "../../../../features/ChatSessionScope.svelte";
import type { ACPSessionRepository } from "../../../../features/SessionRepository.svelte";
import { agentServerIconUrl } from "../../../../localAgentIcon";

export function agentServerOptions(repo: ACPSessionRepository): string[] {
  return repo.agents.agentServerNames.length > 0
    ? repo.agents.agentServerNames
    : [DEFAULT_AGENT_SERVER];
}

export function selectedAgentServer(scope: ACPChatSessionScope): string {
  return scope.activeAgentServer || DEFAULT_AGENT_SERVER;
}

export function agentName(registry: AcpAgentRegistryRepository, agentServer: string): string {
  if (agentServer === DEFAULT_AGENT_SERVER) {
    return "Camber";
  }
  return registry.getAgent(agentServer)?.name ?? agentServer;
}

export function agentIconUrl(
  registry: AcpAgentRegistryRepository,
  agentServer: string,
): string | undefined {
  return agentServerIconUrl(agentServer, registry.getAgent(agentServer));
}

// Picker icons carry provider identity; other surfaces (notably the sidebar)
// keep inheriting their surrounding foreground colour.
export function agentPickerIconUrl(
  registry: AcpAgentRegistryRepository,
  agentServer: string,
): string | undefined {
  return agentIconUrl(registry, agentServer);
}

// Matched by both the agent-server key and the registry agent id, so aliased
// server keys pointing at the Claude registry entry still count.
export function isClaudeAgent(registry: AcpAgentRegistryRepository, agentServer: string): boolean {
  return agentServer === "claude-acp" || registry.getAgent(agentServer)?.id === "claude-acp";
}

export function agentPickerIconProps(
  registry: AcpAgentRegistryRepository,
  agentServer: string,
): { class: string } {
  if (agentServer === DEFAULT_AGENT_SERVER) {
    return { class: "text-psx-vibrant" };
  }

  if (isClaudeAgent(registry, agentServer)) {
    return { class: "text-[#d97757]" };
  }

  return { class: "" };
}

// Brand tint as a raw CSS colour, for surfaces that colour the logo through CSS
// custom properties rather than a Tailwind `text-*` class (e.g. the working
// indicator's masked, animated glyph). Mirrors agentPickerIconProps' palette.
export function agentBrandTint(
  registry: AcpAgentRegistryRepository,
  agentServer: string,
): string | undefined {
  if (agentServer === DEFAULT_AGENT_SERVER) {
    return "var(--psx-vibrant)";
  }
  if (isClaudeAgent(registry, agentServer)) {
    return "#d97757";
  }
  return undefined;
}

export function shouldResetSessionForAgentSelection(
  scope: ACPChatSessionScope,
  agentServer: string,
): boolean {
  return scope.activeAgentServer !== agentServer || scope.sessionAgentServer !== agentServer;
}
