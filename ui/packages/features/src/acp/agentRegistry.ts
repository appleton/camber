import type { ACPAgentServerConfig } from "@camber/rpc";

export const ACP_AGENT_REGISTRY_URL =
  "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

export interface ACPAgentRegistry {
  version: string;
  agents: ACPRegistryAgent[];
}

export interface ACPRegistryAgent {
  id: string;
  name: string;
  version: string;
  description: string;
  repository?: string;
  website?: string;
  authors?: string[];
  license?: string;
  icon?: string;
  distribution: ACPRegistryDistribution;
}

export type ACPRegistryAgentCategory = "tested" | "third-party";

export const TESTED_REGISTRY_AGENT_IDS = new Set(["claude-acp", "codex-acp"]);

export interface ACPRegistryDistribution {
  binary?: Record<string, ACPRegistryBinaryDistribution>;
  npx?: ACPRegistryPackageDistribution;
  uvx?: ACPRegistryPackageDistribution;
}

export interface ACPRegistryPackageDistribution {
  package: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface ACPRegistryBinaryDistribution {
  archive: string;
  sha256?: string;
  cmd: string;
  args?: string[];
  env?: Record<string, string>;
}

export function registryIconUrl(agent: Pick<ACPRegistryAgent, "icon">): string | undefined {
  if (!agent.icon) return undefined;
  try {
    return new URL(agent.icon, ACP_AGENT_REGISTRY_URL).toString();
  } catch {
    return undefined;
  }
}

export function agentServerConfigFromRegistryAgent(
  agent: Pick<ACPRegistryAgent, "distribution">,
): ACPAgentServerConfig | null {
  if (agent.distribution.npx) {
    return {
      type: "registry",
      command: "npx",
      args: ["-y", agent.distribution.npx.package, ...(agent.distribution.npx.args ?? [])],
      env: agent.distribution.npx.env,
    };
  }

  if (agent.distribution.uvx) {
    return {
      type: "registry",
      command: "uvx",
      args: [agent.distribution.uvx.package, ...(agent.distribution.uvx.args ?? [])],
      env: agent.distribution.uvx.env,
    };
  }

  if (agent.distribution.binary) {
    return {
      type: "registry",
      command: "",
      binary: agent.distribution.binary,
    };
  }

  return null;
}

export function registryAgentCategory(
  agent: Pick<ACPRegistryAgent, "id">,
): ACPRegistryAgentCategory {
  return TESTED_REGISTRY_AGENT_IDS.has(agent.id) ? "tested" : "third-party";
}

export function registryAgentDistributionLabel(
  agent: Pick<ACPRegistryAgent, "distribution">,
): string {
  if (agent.distribution.npx) return "npm";
  if (agent.distribution.uvx) return "uvx";
  if (agent.distribution.binary) return "binary";
  return "manual";
}

export function registryAgentReleaseUrl(
  agent: Pick<ACPRegistryAgent, "distribution" | "repository" | "website">,
): string | undefined {
  const npxPackage = agent.distribution.npx?.package;
  if (npxPackage) {
    const packageName = packageNameWithoutVersion(npxPackage);
    if (packageName) return `https://www.npmjs.com/package/${encodePackagePath(packageName)}`;
  }

  const uvxPackage = agent.distribution.uvx?.package;
  if (uvxPackage) {
    const packageName = packageNameWithoutVersion(uvxPackage);
    if (packageName) return `https://pypi.org/project/${encodeURIComponent(packageName)}/`;
  }

  const archive = firstBinaryArchive(agent.distribution.binary);
  const githubReleaseUrl = archive ? githubReleasesUrl(archive) : undefined;
  if (githubReleaseUrl) return githubReleaseUrl;

  if (agent.repository) {
    return githubReleasesUrl(agent.repository) ?? agent.repository;
  }
  return agent.website;
}

function packageNameWithoutVersion(value: string): string {
  if (value.startsWith("@")) {
    const secondAt = value.indexOf("@", 1);
    return secondAt === -1 ? value : value.slice(0, secondAt);
  }
  return value.split("@")[0].split("==")[0];
}

function encodePackagePath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

function firstBinaryArchive(
  binary: Record<string, ACPRegistryBinaryDistribution> | undefined,
): string | undefined {
  if (!binary) return undefined;
  return Object.values(binary)[0]?.archive;
}

function githubReleasesUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.hostname !== "github.com") return undefined;

    const [, owner, repo] = url.pathname.split("/");
    if (!owner || !repo) return undefined;
    return `https://github.com/${owner}/${repo.replace(/\.git$/, "")}/releases`;
  } catch {
    return undefined;
  }
}

export function sameAgentServerConfig(
  left: ACPAgentServerConfig | undefined,
  right: ACPAgentServerConfig | null,
): boolean {
  return (
    stableStringify(normalizeAgentServerConfig(left)) ===
    stableStringify(normalizeAgentServerConfig(right))
  );
}

function normalizeAgentServerConfig(
  config: ACPAgentServerConfig | null | undefined,
): ACPAgentServerConfig | null {
  if (!config) return null;
  return {
    command: config.command || undefined,
    type: config.type ?? undefined,
    args: nonEmptyArray(config.args),
    env: nonEmptyRecord(config.env),
    binary: config.binary ?? undefined,
  };
}

function nonEmptyArray<T>(value: T[] | undefined): T[] | undefined {
  return value && value.length > 0 ? value : undefined;
}

function nonEmptyRecord<T>(value: Record<string, T> | undefined): Record<string, T> | undefined {
  return value && Object.keys(value).length > 0 ? value : undefined;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortObjectKeys(value));
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortObjectKeys(child)]),
    );
  }
  return value;
}

export function registryAgentsById(agents: ACPRegistryAgent[]): Map<string, ACPRegistryAgent> {
  return new Map(agents.map((agent) => [agent.id, agent]));
}

export function sortRegistryAgents(agents: ACPRegistryAgent[]): ACPRegistryAgent[] {
  return [...agents].sort((left, right) => left.name.localeCompare(right.name));
}
