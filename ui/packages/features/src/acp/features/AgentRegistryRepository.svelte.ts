import { fromPromise, isSuccess, loading, type AsyncState } from "@camber/lib/async-state";
import { toError } from "@camber/lib/errors";
import { createContext } from "svelte";
import {
  ACP_AGENT_REGISTRY_URL,
  registryAgentsById,
  sortRegistryAgents,
  type ACPAgentRegistry,
  type ACPRegistryAgent,
} from "../agentRegistry";

const ACP_AGENT_REGISTRY_CACHE_KEY = "camber.acp.agentRegistry";

export class AcpAgentRegistryRepository {
  state = $state<AsyncState<ACPRegistryAgent[]>>(loading);
  readonly agents = $derived(isSuccess(this.state) ? this.state.value : []);
  readonly agentsById = $derived(registryAgentsById(this.agents));
  private inFlight: Promise<AsyncState<ACPRegistryAgent[]>> | null = null;

  constructor(private readonly registryUrl = ACP_AGENT_REGISTRY_URL) {}

  getAgent(id: string): ACPRegistryAgent | undefined {
    return this.agentsById.get(id);
  }

  load(fetcher: typeof fetch = fetch): Promise<AsyncState<ACPRegistryAgent[]>> {
    if (this.inFlight) return this.inFlight;
    const previous = this.state;
    this.inFlight = fromPromise(
      async () => {
        try {
          const response = await fetcher(this.registryUrl, { cache: "no-cache" });
          if (!response.ok) {
            throw new Error(`Registry request failed: ${response.status} ${response.statusText}`);
          }

          const registry = (await response.json()) as ACPAgentRegistry;
          writeCachedRegistry(registry);
          return sortRegistryAgents(registry.agents ?? []);
        } catch (error) {
          if (isSuccess(previous)) return previous.value;
          const cached = readCachedRegistry();
          if (cached) {
            return sortRegistryAgents(cached.agents ?? []);
          }
          throw error;
        }
      },
      (state) => {
        // Background checks must not temporarily hide agent names or update banners.
        if (state.status !== "loading" || !isSuccess(previous)) this.state = state;
      },
      { mapError: toError },
    ).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }
}

function readCachedRegistry(): ACPAgentRegistry | null {
  try {
    const storage = globalThis.localStorage;
    const raw = storage?.getItem(ACP_AGENT_REGISTRY_CACHE_KEY);
    return raw ? (JSON.parse(raw) as ACPAgentRegistry) : null;
  } catch {
    return null;
  }
}

function writeCachedRegistry(registry: ACPAgentRegistry): void {
  try {
    globalThis.localStorage?.setItem(ACP_AGENT_REGISTRY_CACHE_KEY, JSON.stringify(registry));
  } catch {
    // Best-effort cache only.
  }
}

const [getACPAgentRegistryContext, setACPAgentRegistryRepositoryContext] =
  createContext<AcpAgentRegistryRepository>();

export { getACPAgentRegistryContext };

export function setACPAgentRegistryContext(): AcpAgentRegistryRepository {
  const repo = new AcpAgentRegistryRepository();
  return setACPAgentRegistryRepositoryContext(repo);
}

export { setACPAgentRegistryRepositoryContext as _setACPAgentRegistryContextForTests };

export function getACPAgentRegistryRepo(): AcpAgentRegistryRepository {
  return getACPAgentRegistryContext();
}
