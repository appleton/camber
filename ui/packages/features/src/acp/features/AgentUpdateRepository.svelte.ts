import { camberAcpNavInstallAgentServer } from "@camber/helperapi";
import type { ACPAgentServerConfig, ACPAgentServers } from "@camber/rpc";
import { createContext } from "svelte";
import { get } from "svelte/store";
import {
  agentServerConfigFromRegistryAgent,
  sameAgentServerConfig,
  type ACPRegistryAgent,
} from "../agentRegistry";
import {
  DEFAULT_AGENT_SERVER,
  LEGACY_DEFAULT_AGENT_SERVER,
  normalizeAgentServerName,
  resolveAgentServers,
} from "../agentServers";
import { isOlderStableVersion, versionFromConfig } from "../agentVersions";
import { extractErrorMessage } from "../errors";
import type { AppStore } from "../hostAdapter";
import { rpc } from "../hostRpc";
import type { AcpAgentRegistryRepository } from "./AgentRegistryRepository.svelte";
import type { ACPSessionRepositoryWriter } from "./SessionRepository.svelte";

export type ACPAgentUpdateStage =
  | "downloading"
  | "unpacking"
  | "installing"
  | "enabling"
  | "restarting";
export type ACPAgentInstallMode = "binary" | "npm" | "uvx" | "command";

export interface ACPAgentUpdate {
  agentServer: string;
  agent: ACPRegistryAgent;
  kind: "install" | "update" | "restart";
  currentConfig: ACPAgentServerConfig | undefined;
  nextConfig: ACPAgentServerConfig;
}

export interface ACPAgentUpdateProgress {
  label: string;
  width: string;
}

export interface ACPAgentUpdateRepositoryOptions {
  appState: AppStore;
  registryRepo: AcpAgentRegistryRepository;
  sessionRepo: ACPSessionRepositoryWriter;
}

export class ACPAgentUpdateRepository {
  updates = $state<ACPAgentUpdate[]>([]);
  busyAgentServer = $state<string | null>(null);
  stage = $state<ACPAgentUpdateStage | null>(null);
  error = $state<string | null>(null);
  private restartRetries = new Map<string, ACPAgentUpdate>();

  constructor(private readonly options: ACPAgentUpdateRepositoryOptions) {}

  refresh(): ACPAgentUpdate[] {
    const configured = get(this.options.appState).userSettings.acpAgentServers ?? {};
    const resolved = resolveAgentServers(configured);
    const nextUpdates = this.options.registryRepo.agents.flatMap((agent) =>
      this.updateForAgent(agent, configured, resolved),
    );
    for (const retry of this.restartRetries.values()) {
      const runningVersion = this.runningVersionFor(retry.agentServer);
      if (
        !sameAgentServerConfig(resolved[retry.agentServer], retry.nextConfig) ||
        (runningVersion && !isOlderStableVersion(runningVersion, retry.agent.version))
      ) {
        this.restartRetries.delete(retry.agentServer);
      } else if (!nextUpdates.some((update) => update.agentServer === retry.agentServer)) {
        // A failed restart clears the old connection. Keep the action available
        // until a new connection confirms the installed release is running.
        nextUpdates.push(retry);
      }
    }
    this.updates = nextUpdates;
    return nextUpdates;
  }

  updateFor(agentServer: string): ACPAgentUpdate | undefined {
    const normalized = normalizeAgentServerName(agentServer);
    return this.updates.find((update) => update.agentServer === normalized);
  }

  hasUpdate(agentServer: string): boolean {
    return this.updateFor(agentServer) != null;
  }

  restartBlockedFor(agentServer: string): boolean {
    return this.options.sessionRepo.hasActiveConversationsForAgent(agentServer);
  }

  progressFor(agentServer: string): ACPAgentUpdateProgress | null {
    if (this.busyAgentServer !== normalizeAgentServerName(agentServer) || !this.stage) {
      return null;
    }

    const update = this.updateFor(agentServer);
    const agent = update?.agent;
    if (this.stage === "restarting") return { label: "Restarting agent", width: "92%" };
    if (this.stage === "downloading") return { label: "Downloading package", width: "34%" };
    if (this.stage === "unpacking") return { label: "Unpacking package", width: "68%" };
    if (this.stage === "installing") {
      const label = agent?.distribution.uvx ? "Installing uvx package" : "Installing npm package";
      return { label, width: "58%" };
    }
    return { label: "Enabling extension", width: "92%" };
  }

  busyLabel(agentServer: string): string {
    if (this.busyAgentServer !== normalizeAgentServerName(agentServer)) return "";
    if (this.stage === "downloading") return "Downloading";
    if (this.stage === "unpacking") return "Unpacking";
    if (this.stage === "installing") return "Installing";
    if (this.stage === "enabling") return "Installing";
    if (this.stage === "restarting") return "Restarting";
    return "Installing";
  }

  async update(agentServer: string): Promise<void> {
    const normalized = normalizeAgentServerName(agentServer);
    if (this.busyAgentServer) return;

    this.refresh();
    const update = this.updateFor(normalized);
    if (!update) return;

    this.busyAgentServer = normalized;
    this.stage = null;
    this.error = null;

    try {
      if (update.kind === "restart") {
        if (this.restartBlockedFor(normalized)) {
          throw new Error(
            "Wait for this agent’s running conversations to finish before restarting.",
          );
        }
        this.stage = "restarting";
        this.restartRetries.set(normalized, update);
        await this.options.sessionRepo.agents.restart(normalized);
        await this.options.sessionRepo.agents.refreshCachedConfig(normalized, "/", { fresh: true });
        const runningVersion = this.runningVersionFor(normalized);
        if (!runningVersion || isOlderStableVersion(runningVersion, update.agent.version)) {
          throw new Error("The updated agent has not connected yet. Try restarting it again.");
        }
        this.restartRetries.delete(normalized);
        this.refresh();
        return;
      }
      await this.install(update.agent, update.nextConfig);
      this.stage = "enabling";
      const configured = get(this.options.appState).userSettings.acpAgentServers ?? {};
      const resolved = resolveAgentServers(configured);
      const nextAgentServers = {
        ...configured,
        [normalized]: {
          ...update.nextConfig,
          default_config_options: (normalized === DEFAULT_AGENT_SERVER
            ? resolved[normalized]
            : configured[normalized]
          )?.default_config_options,
        },
      };

      const snapshot = $state.snapshot(nextAgentServers) as ACPAgentServers;
      await rpc.setACPAgentServers(snapshot);
      this.options.appState.update((state) => ({
        ...state,
        userSettings: {
          ...state.userSettings,
          acpAgentServers: snapshot,
        },
      }));
      this.refresh();

      if (normalized === DEFAULT_AGENT_SERVER) {
        await this.options.sessionRepo.agents.restart(DEFAULT_AGENT_SERVER);
      }
      await this.options.sessionRepo.agents.refreshCachedConfig(normalized);
      this.refresh();
    } catch (error) {
      this.error = extractErrorMessage(
        error,
        `The ${update.agent.name} agent updater did not return error details`,
      );
      this.refresh();
      throw error;
    } finally {
      this.busyAgentServer = null;
      this.stage = null;
    }
  }

  private updateForAgent(
    agent: ACPRegistryAgent,
    configured: ACPAgentServers,
    resolved: ACPAgentServers,
  ): ACPAgentUpdate[] {
    const nextConfig = agentServerConfigFromRegistryAgent(agent);
    if (!nextConfig) return [];

    const agentServer = normalizeAgentServerName(agent.id);
    if (agentServer === DEFAULT_AGENT_SERVER) {
      if (resolved[DEFAULT_AGENT_SERVER]?.command) return [];
      const currentConfig =
        resolved[DEFAULT_AGENT_SERVER] ??
        configured[DEFAULT_AGENT_SERVER] ??
        configured[LEGACY_DEFAULT_AGENT_SERVER];
      // Without a registry opt-in or a local install, the helper launches the
      // bundled Camber agent automatically — nothing to install or update.
      if (currentConfig?.type !== "registry" && !hasRunnableAgentServerConfig(currentConfig)) {
        return [];
      }
      return this.updateForConfig(agent, agentServer, currentConfig, nextConfig);
    }

    const configuredConfig = configured[agentServer];
    if (!configuredConfig) return [];
    if (configuredConfig.type !== "registry") {
      // Older Assistant releases stored registry-installed npm agents without
      // provenance. The assistant.json migration conservatively marks those
      // entries as custom, so recognize the unmodified command shape as a
      // regular agent update. Customized commands remain user-managed.
      if (!isLegacyRegistryNpxConfig(agent, configuredConfig)) return [];
      return [
        {
          agentServer,
          agent,
          kind: "update",
          currentConfig: configuredConfig,
          nextConfig,
        },
      ];
    }

    const currentConfig = resolved[agentServer] ?? configuredConfig;
    return this.updateForConfig(agent, agentServer, currentConfig, nextConfig);
  }

  private updateForConfig(
    agent: ACPRegistryAgent,
    agentServer: string,
    currentConfig: ACPAgentServerConfig | undefined,
    nextConfig: ACPAgentServerConfig,
  ): ACPAgentUpdate[] {
    const installedVersion = versionFromConfig(currentConfig);
    // An offline registry cache can predate an install made in another window.
    const registryIsOlder = isOlderStableVersion(versionFromConfig(nextConfig), installedVersion);
    if (!sameAgentServerConfig(currentConfig, nextConfig) && !registryIsOlder) {
      return [
        {
          agentServer,
          agent,
          kind: hasRunnableAgentServerConfig(currentConfig) ? "update" : "install",
          currentConfig,
          nextConfig,
        },
      ];
    }

    const runningVersion = this.runningVersionFor(agentServer);
    if (
      currentConfig &&
      installedVersion &&
      isOlderStableVersion(runningVersion, installedVersion)
    ) {
      return [
        {
          agentServer,
          agent: { ...agent, version: installedVersion },
          kind: "restart",
          currentConfig,
          nextConfig: currentConfig,
        },
      ];
    }
    return [];
  }

  private runningVersionFor(agentServer: string): string | null {
    return this.options.sessionRepo.agents.isConnectedTo(agentServer)
      ? (this.options.sessionRepo.agents.getInitializeResponse(agentServer)?.agentInfo?.version ??
          null)
      : null;
  }

  private async install(agent: ACPRegistryAgent, config: ACPAgentServerConfig): Promise<void> {
    const mode = installMode(agent, config);
    if (mode === "command") {
      this.stage = "enabling";
      return;
    }

    this.stage = mode === "binary" ? "downloading" : "installing";
    const timers: ReturnType<typeof setTimeout>[] = [];
    if (mode === "binary") {
      timers.push(
        setTimeout(() => {
          if (
            this.busyAgentServer === normalizeAgentServerName(agent.id) &&
            this.stage === "downloading"
          ) {
            this.stage = "unpacking";
          }
        }, 1200),
      );
    }

    try {
      await Promise.all([
        camberAcpNavInstallAgentServer({
          agentServer: agent.id,
          config: $state.snapshot(config) as ACPAgentServerConfig,
        }),
        minimumInstallProgressDelay(mode),
      ]);
    } finally {
      timers.forEach((timer) => clearTimeout(timer));
    }
  }
}

function hasRunnableAgentServerConfig(config: ACPAgentServerConfig | undefined): boolean {
  return !!config && (Boolean(config.command) || Object.keys(config.binary ?? {}).length > 0);
}

function isLegacyRegistryNpxConfig(agent: ACPRegistryAgent, config: ACPAgentServerConfig): boolean {
  if (config.type !== "custom" || config.command !== "npx" || config.binary) return false;

  const registryDistribution = agent.distribution.npx;
  if (!registryDistribution) return false;

  const [yesFlag, packageReference, ...packageArgs] = config.args ?? [];
  if (yesFlag !== "-y" || !packageReference) return false;
  if (packageReference === registryDistribution.package || packageArgs.length > 0) return false;
  if (Object.keys(config.env ?? {}).length > 0) return false;

  const configuredPackage = npmPackageName(packageReference);
  const registryPackage = npmPackageName(registryDistribution.package);
  if (configuredPackage === registryPackage) return true;

  // Scope moves (for example @zed-industries/foo -> @agentclientprotocol/foo)
  // are still the same registry agent when both package basenames match its
  // stable registry id.
  const agentServer = normalizeAgentServerName(agent.id);
  return (
    npmPackageBaseName(configuredPackage) === agentServer &&
    npmPackageBaseName(registryPackage) === agentServer
  );
}

function npmPackageName(reference: string): string {
  if (!reference.startsWith("@")) return reference.split("@", 1)[0];
  const versionSeparator = reference.indexOf("@", 1);
  return versionSeparator === -1 ? reference : reference.slice(0, versionSeparator);
}

function npmPackageBaseName(packageName: string): string {
  return packageName.split("/").at(-1) ?? packageName;
}

function installMode(agent: ACPRegistryAgent, config: ACPAgentServerConfig): ACPAgentInstallMode {
  if (Object.keys(config.binary ?? {}).length > 0) return "binary";
  if (agent.distribution.npx) return "npm";
  if (agent.distribution.uvx) return "uvx";
  return "command";
}

async function minimumInstallProgressDelay(mode: ACPAgentInstallMode): Promise<void> {
  if (mode === "command") return;
  await new Promise((resolve) => setTimeout(resolve, 500));
}

const [getACPAgentUpdateContext, setACPAgentUpdateRepositoryContext] =
  createContext<ACPAgentUpdateRepository>();

export { getACPAgentUpdateContext };

export function setACPAgentUpdateContext(
  options: ACPAgentUpdateRepositoryOptions,
): ACPAgentUpdateRepository {
  return setACPAgentUpdateRepositoryContext(new ACPAgentUpdateRepository(options));
}

export { setACPAgentUpdateRepositoryContext as _setACPAgentUpdateContextForTests };

export function getACPAgentUpdateRepo(): ACPAgentUpdateRepository {
  return getACPAgentUpdateContext();
}
