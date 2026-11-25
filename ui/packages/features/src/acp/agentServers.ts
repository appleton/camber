import type { ACPAgentServerConfig, ACPAgentServers } from "@camber/rpc";

export const DEFAULT_AGENT_SERVER = "poolside";
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

  for (const [name, config] of Object.entries(input)) {
    const normalizedName = normalizeAgentServerName(name);
    if (
      normalizedName === DEFAULT_AGENT_SERVER ||
      isRetiredLocalAgentServer(normalizedName, config)
    ) {
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

const RETIRED_LOCAL_AGENT_SERVER = "local";

/**
 * Whether an entry is the removed built-in local-inference agent. A helper
 * built before its removal still advertises it as `local` with type "local"
 * (or no type) and no command or binary; a custom agent the user named
 * `local` has a command and is kept.
 */
function isRetiredLocalAgentServer(
  name: string,
  config: ACPAgentServerConfig | undefined,
): boolean {
  if (name !== RETIRED_LOCAL_AGENT_SERVER || !config) return false;
  const type = (config.type as string | undefined)?.trim();
  return (
    (type === undefined || type === "" || type === RETIRED_LOCAL_AGENT_SERVER) &&
    !config.command?.trim() &&
    !config.binary
  );
}
