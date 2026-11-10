import { camberAcpNavListAgentServers } from "@camber/helperapi";
import {
  fromPromise,
  isSuccess,
  isWaiting,
  loading,
  waiting,
  type AsyncState,
} from "@camber/lib/async-state";
import type { ACPAgentServers } from "@camber/rpc";
import { createContext } from "svelte";
import { get } from "svelte/store";
import { agentServerNames, normalizeAgentServerName } from "../agentServers";
import type { AppStore } from "../hostAdapter";
import type { ACPSessionRepositoryWriter } from "./SessionRepository.svelte";

export interface ACPAgentServersRepositoryOptions {
  appState: AppStore;
  sessionRepo: ACPSessionRepositoryWriter;
}

export class ACPAgentServersRepository {
  state = $state<AsyncState<ACPAgentServers, Error>>(waiting);
  defaultAgentServer = $state<string | undefined>(undefined);
  // Mirror of the store's `default_agent_server_pinned`; undefined until the
  // first list read so configureSessionRepo never clears a pin it never saw.
  defaultAgentServerPinned = $state<boolean | undefined>(undefined);

  constructor(private readonly options: ACPAgentServersRepositoryOptions) {}

  get agentServers(): ACPAgentServers | undefined {
    return isSuccess(this.state) ? this.state.value : undefined;
  }

  configureSessionRepo(
    agentServers: ACPAgentServers | undefined = get(this.options.appState).userSettings
      .acpAgentServers,
  ): void {
    const names = agentServerNames(agentServers);
    const change = this.options.sessionRepo.agents.configureAgentServers(
      names,
      this.defaultAgentServer,
      this.defaultAgentServerPinned,
    );
    this.options.sessionRepo.reconcileAgentServerConfiguration(change);
  }

  async setDefaultAgentServer(agentServer: string): Promise<void> {
    this.defaultAgentServer = normalizeAgentServerName(agentServer);
    const res = await this.options.sessionRepo.agents.setDefaultAgentServer(agentServer);
    this.#reconcileDefaultAgentServer(res);
  }

  /**
   * Pin `agentServer` as the app-wide default agent: the default becomes this
   * agent and stops following last use until unpinned.
   */
  async setPinnedDefaultAgentServer(agentServer: string): Promise<void> {
    this.defaultAgentServer = normalizeAgentServerName(agentServer);
    this.defaultAgentServerPinned = true;
    const res = await this.options.sessionRepo.agents.setPinnedDefaultAgentServer(agentServer);
    this.#reconcileDefaultAgentServer(res);
  }

  /** Release the default-agent pin; the default agent itself is unchanged. */
  async unpinDefaultAgentServer(): Promise<void> {
    this.defaultAgentServerPinned = false;
    const res = await this.options.sessionRepo.agents.unpinDefaultAgentServer();
    this.#reconcileDefaultAgentServer(res);
  }

  #reconcileDefaultAgentServer(res: {
    agentServers: ACPAgentServers;
    defaultAgentServer?: string;
  }): void {
    this.defaultAgentServer = this.options.sessionRepo.agents.defaultAgentServer;
    this.defaultAgentServerPinned = this.options.sessionRepo.agents.defaultAgentServerPinned;
    const change = this.options.sessionRepo.agents.configureAgentServers(
      agentServerNames(res.agentServers),
      res.defaultAgentServer,
    );
    this.options.sessionRepo.reconcileAgentServerConfiguration(change);
  }

  refreshWhenReady(): void {
    if (!isWaiting(this.state)) {
      return;
    }

    void this.refresh();
  }

  async refresh({ background = false }: { background?: boolean } = {}): Promise<void> {
    const preserveSuccess = background && isSuccess(this.state);
    if (!preserveSuccess) this.state = loading;
    await this.refreshFromLocalConfig(preserveSuccess);
  }

  private async refreshFromLocalConfig(preserveSuccess: boolean): Promise<void> {
    const result = await fromPromise(
      async () => {
        const state = await camberAcpNavListAgentServers({});
        this.defaultAgentServer = state.defaultAgentServer;
        // Absent on the wire means unpinned (the store omits a false flag).
        this.defaultAgentServerPinned = state.default_agent_server_pinned === true;
        return (state.agentServers ?? {}) as ACPAgentServers;
      },
      (state) => {
        if (!preserveSuccess || isSuccess(state)) this.state = state;
      },
    );

    if (isSuccess(result)) {
      const agentServers = result.value;
      const current = get(this.options.appState);
      const next = {
        ...current,
        userSettings: {
          ...current.userSettings,
          acpAgentServers: agentServers,
        },
      };
      this.options.appState.set(next);
      this.configureSessionRepo(agentServers);
    } else if (
      result.status === "failure" &&
      !result.error.message.startsWith("assistant config: parsing ")
    ) {
      console.error("Failed to load ACP agent servers", result.error);
    }
  }
}

const [getACPAgentServersContext, setACPAgentServersRepositoryContext] =
  createContext<ACPAgentServersRepository>();

export { getACPAgentServersContext };

export function setACPAgentServersContext(
  options: ACPAgentServersRepositoryOptions,
): ACPAgentServersRepository {
  return setACPAgentServersRepositoryContext(new ACPAgentServersRepository(options));
}

export { setACPAgentServersRepositoryContext as _setACPAgentServersContextForTests };

export function getACPAgentServersRepo(): ACPAgentServersRepository {
  return getACPAgentServersContext();
}
