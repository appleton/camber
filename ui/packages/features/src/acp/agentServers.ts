import type { ACPAgentServers } from "@camber/rpc";

export const DEFAULT_AGENT_SERVER = "poolside";
export const LOCAL_AGENT_SERVER = "local";
export const LEGACY_DEFAULT_AGENT_SERVER = "default";
const LEGACY_SELF_PLACEHOLDERS = new Set(["{{SELF}}", "{{$SELF}}"]);

export function resolveAgentServers(agentServers?: ACPAgentServers | null): ACPAgentServers {
  const input = agentServers ?? {};
  const configuredCamber = input[DEFAULT_AGENT_SERVER] ?? input[LEGACY_DEFAULT_AGENT_SERVER];
  const shouldUseConfiguredCamber =
    configuredCamber?.command && !LEGACY_SELF_PLACEHOLDERS.has(configuredCamber.command);
  const resolved: ACPAgentServers = {
    [DEFAULT_AGENT_SERVER]: shouldUseConfiguredCamber
      ? configuredCamber
      : {
          ...configuredCamber,
          command: "",
          args: undefined,
        },
  };

  if (input[LOCAL_AGENT_SERVER]) {
    resolved[LOCAL_AGENT_SERVER] = {
      ...input[LOCAL_AGENT_SERVER],
      type: input[LOCAL_AGENT_SERVER].type ?? "local",
      command: input[LOCAL_AGENT_SERVER].command ?? "",
      args: input[LOCAL_AGENT_SERVER].args,
    };
  }

  for (const [name, config] of Object.entries(input)) {
    const normalizedName = normalizeAgentServerName(name);
    if (normalizedName === DEFAULT_AGENT_SERVER || normalizedName === LOCAL_AGENT_SERVER) {
      continue;
    }
    resolved[normalizedName] = config;
  }

  return resolved;
}

export function agentServerNames(agentServers?: ACPAgentServers | null): string[] {
  return orderAgentServerNames(Object.keys(resolveAgentServers(agentServers)));
}

export function orderAgentServerNames(names: Iterable<string>): string[] {
  return Array.from(new Set(Array.from(names, normalizeAgentServerName))).sort((a, b) => {
    if (a === DEFAULT_AGENT_SERVER) return -1;
    if (b === DEFAULT_AGENT_SERVER) return 1;
    if (a === LOCAL_AGENT_SERVER) return -1;
    if (b === LOCAL_AGENT_SERVER) return 1;
    return a.localeCompare(b);
  });
}

export function preferredAgentServer(names: string[], preferred = DEFAULT_AGENT_SERVER): string {
  const normalizedPreferred = normalizeAgentServerName(preferred);
  if (names.includes(normalizedPreferred)) {
    return normalizedPreferred;
  }
  return names[0] ?? DEFAULT_AGENT_SERVER;
}

export function normalizeAgentServerName(name?: string | null): string {
  if (!name || name === LEGACY_DEFAULT_AGENT_SERVER) {
    return DEFAULT_AGENT_SERVER;
  }
  return name;
}
