import type { AgentSettingsOutput, MCPServerInputs } from "@camber/helperapi/schemas";
import { extractErrorMessage, isMethodNotFoundError } from "../errors";
import { rpc as acpHostRpc } from "../hostRpc";
import { getACPActiveAgentServer } from "./activeAgent.svelte";
import type { ACPSessionRepository } from "./SessionRepository.svelte";

type NoSetters<T> = { readonly [K in keyof T]: T[K] };

const ACP_BUNDLED_POOL_AGENT_SERVER = "poolside";
const ACP_MCP_SETTINGS_CAPABILITY = "camber/mcp_settings";
const ACP_MCP_SETTINGS_METHOD = "camber/acp/_poolside/mcp/settings";
const ACP_MCP_SET_SERVER_DISABLED_METHOD = "camber/acp/_poolside/mcp/set_server_disabled";
// Helper-side global toggle: writes ~/.config/camber/settings.yaml so a pool
// connector is disabled across all workspaces, not just the active one (which is
// all the agent's own set_server_disabled does).
const MCP_SET_POOL_SERVER_DISABLED_METHOD = "camber/mcpServers/setPoolServerDisabled";
const ACP_MCP_DELETE_SECRETS_METHOD = "camber/acp/_poolside/mcp/delete_secrets";
const ACP_MCP_AUTHENTICATE_METHOD = "camber/acp/_poolside/mcp/authenticate";
const ACP_MCP_SET_INPUT_VARIABLE_METHOD = "camber/acp/_poolside/mcp/set_input_variable";
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

const rawACPHostRpc = acpHostRpc as unknown as {
  jsonrpc(method: string, params: Record<string, unknown>): Promise<unknown>;
};

export type MCPServerStatus = "ready" | "needs_setup";
export type MCPGlobalStatus = "ready" | "needs_setup" | "loading" | "error" | "idle";

export type ACPMCPSettingsRepository = NoSetters<ACPMCPSettingsRepositoryWriter>;

type ACPMCPSettingsOutput = AgentSettingsOutput & {
  mcpServers?: MCPServerInputs[];
};

interface ACPMCPParams {
  agentServer: string;
  sessionId: string;
}

export interface ACPMCPActiveSession {
  agentServer: string;
  sessionId: string | null;
}

export class ACPMCPSettingsRepositoryWriter {
  readonly #acp: ACPSessionRepository;
  #activeSessionResolver: () => ACPMCPActiveSession | null = () => null;

  isLoading = $state(false);
  error = $state<string | null>(null);
  servers = $state<MCPServerInputs[]>([]);
  variableValues = $state<Record<string, Record<string, string>>>({});
  oauthState = $state<Record<string, boolean>>({});
  disabledState = $state<Record<string, boolean>>({});
  allowCustomMCPServers = $state(true);
  hasLocalMCPServers = $state(false);
  localMCPServerNames = $state<string[]>([]);
  selectedServerName = $state<string | null>(null);

  // Consecutive fetchSettings failures per agent. Used to recover from a stale
  // config-probe session exactly once (then stop, to avoid a retry loop).
  #fetchFailures = new Map<string, number>();

  constructor(
    acp: ACPSessionRepository,
    options: { getActiveSession?: () => ACPMCPActiveSession | null } = {},
  ) {
    this.#acp = acp;
    this.#activeSessionResolver = options.getActiveSession ?? this.#activeSessionResolver;
  }

  readonly globalStatus: MCPGlobalStatus = $derived.by(() => {
    return this.isLoading
      ? "loading"
      : this.error
        ? "error"
        : this.servers.length === 0
          ? "idle"
          : this.servers.some(
                (server) =>
                  !this.isServerDisabled(server) && this.getServerStatus(server) !== "ready",
              )
            ? "needs_setup"
            : "ready";
  });

  readonly needsSetup = $derived(this.globalStatus === "needs_setup");

  readonly localServers = $derived(
    this.servers
      .filter((server) => server.serverID === NIL_UUID || server.serverID === "")
      .sort((a, b) => a.serverName.localeCompare(b.serverName)),
  );

  readonly remoteServers = $derived(
    this.servers
      .filter((server) => server.serverID !== NIL_UUID && server.serverID !== "")
      .sort((a, b) => a.serverName.localeCompare(b.serverName)),
  );

  readonly selectedServer = $derived(
    this.servers.find((s) => s.serverName === this.selectedServerName) ?? null,
  );

  publicAPI(): ACPMCPSettingsRepository {
    return this as ACPMCPSettingsRepository;
  }

  selectServer(serverName: string): void {
    this.selectedServerName = serverName;
  }

  clearSelectedServer(): void {
    this.selectedServerName = null;
  }

  activeSettingsKey(): string | null {
    const params = this.#activeACPParams();
    if (!params || !this.#supportsMCPSettingsCapability()) return null;
    return `acp:${params.agentServer}:${params.sessionId}`;
  }

  // The desktop connectors view shares a webview with the active chat, so its
  // settings repository can use the live session's model policy directly. A
  // separate IDE sidebar may only have a config-probe session; return null in
  // that case because the probe can use a different model from the open chat.
  activeSessionAllowsCustomMCPServers(): boolean | null {
    if (!this.#activeSession()?.sessionId) return null;
    return this.allowCustomMCPServers;
  }

  canEnsureSettingsSession(): boolean {
    if (this.activeSettingsKey()) return false;
    const agentServer = this.#activeAgentServer();
    return agentServer === ACP_BUNDLED_POOL_AGENT_SERVER || this.#supportsMCPSettingsCapability();
  }

  // Whether the active agent is the bundled Camber agent. Used to hide the
  // Camber connectors UI when the user is working with a different ACP agent.
  // Deliberately does NOT fall back to the default agent: when the active agent
  // is unknown (e.g. a pending chat that hasn't reported its agent yet, or no
  // chat at all), we must not assume Camber — otherwise the sidebar shows
  // Camber connectors over a different ACP agent's chat.
  isActiveAgentPool(): boolean {
    const active = this.#activeSession()?.agentServer ?? getACPActiveAgentServer();
    return active === ACP_BUNDLED_POOL_AGENT_SERVER;
  }

  async ensureSettingsSession(): Promise<void> {
    if (!this.canEnsureSettingsSession()) return;
    const agentServer = this.#activeAgentServer();
    await this.#acp.agents.ensureConfigProbe(agentServer, "/");
  }

  reset(): void {
    this.isLoading = false;
    this.error = null;
    this.servers = [];
    this.variableValues = {};
    this.oauthState = {};
    this.disabledState = {};
    this.allowCustomMCPServers = true;
    this.hasLocalMCPServers = false;
    this.localMCPServerNames = [];
    this.selectedServerName = null;
  }

  async refresh(): Promise<void> {
    if (this.activeSettingsKey()) {
      await this.fetchSettings();
      return;
    }
    this.reset();
  }

  async fetchSettings(): Promise<void> {
    const params = this.#activeACPParams();
    if (!params || !this.#supportsMCPSettingsCapability()) {
      this.reset();
      return;
    }

    this.isLoading = true;
    this.error = null;
    this.variableValues = {};
    this.oauthState = {};
    this.disabledState = {};

    try {
      const result = (await rawACPHostRpc.jsonrpc(ACP_MCP_SETTINGS_METHOD, {
        agentServer: params.agentServer,
        sessionId: params.sessionId,
      })) as ACPMCPSettingsOutput | null;

      this.servers = result?.mcpServers ?? [];
      this.allowCustomMCPServers = result?.allowCustomMCPServers ?? true;
      this.hasLocalMCPServers = result?.hasLocalMCPServers ?? false;
      this.localMCPServerNames = result?.localMCPServerNames ?? [];
      this.#fetchFailures.delete(params.agentServer);
    } catch (e) {
      if (isMethodNotFoundError(e)) {
        this.reset();
        return;
      }
      this.error = extractErrorMessage(e, "Failed to fetch MCP settings");
      this.servers = [];
      this.allowCustomMCPServers = true;
      this.hasLocalMCPServers = false;
      this.localMCPServerNames = [];

      // A config-probe session can go stale (e.g. evicted after switching
      // agents), failing every fetch with no recovery — starting a new *chat*
      // doesn't recreate the *probe*. Forget the stale probe once so the next
      // ensure builds a fresh one; cap at a single auto-retry to avoid a loop.
      const failures = (this.#fetchFailures.get(params.agentServer) ?? 0) + 1;
      this.#fetchFailures.set(params.agentServer, failures);
      if (failures <= 1) {
        this.#acp.agents.forgetConfigProbe(params.agentServer);
      }
    } finally {
      this.isLoading = false;
    }
  }

  async setVariableValue(server: MCPServerInputs, varName: string, value: string): Promise<void> {
    const acpParams = this.#activeACPParams();
    if (!acpParams || !this.#supportsMCPSettingsCapability()) return;

    await rawACPHostRpc.jsonrpc(ACP_MCP_SET_INPUT_VARIABLE_METHOD, {
      agentServer: acpParams.agentServer,
      sessionId: acpParams.sessionId,
      serverID: server.serverID,
      serverURL: server.serverURL,
      variableName: varName,
      value,
    });

    // Key local state by name: local servers all share the nil serverID, so
    // keying by ID would conflate them.
    const key = server.serverName;
    this.variableValues = {
      ...this.variableValues,
      [key]: { ...this.variableValues[key], [varName]: value },
    };
  }

  setOAuthState(serverKey: string, authenticated: boolean): void {
    this.oauthState = { ...this.oauthState, [serverKey]: authenticated };
  }

  async persistServerDisabled(serverName: string, disabled: boolean): Promise<void> {
    const hadOriginalOverride = this.disabledState[serverName] !== undefined;
    const originalOverride = this.disabledState[serverName];
    const originalState =
      originalOverride ??
      this.servers.find((server) => server.serverName === serverName)?.disabled ??
      false;
    const acpParams = this.activeSettingsKey() ? this.#activeACPParams() : null;
    let globalStateChanged = false;
    this.disabledState = { ...this.disabledState, [serverName]: disabled };
    try {
      // Persist globally so new sessions in every workspace inherit the choice.
      await rawACPHostRpc.jsonrpc(MCP_SET_POOL_SERVER_DISABLED_METHOD, {
        serverName,
        disabled,
      });
      globalStateChanged = true;

      // Also update the session backing the open connectors view. For an
      // active conversation this changes its live MCP runtime immediately;
      // without this call the toggle only affected future conversations.
      if (acpParams) {
        await rawACPHostRpc.jsonrpc(ACP_MCP_SET_SERVER_DISABLED_METHOD, {
          agentServer: acpParams.agentServer,
          sessionId: acpParams.sessionId,
          serverName,
          disabled,
        });
      }
    } catch (e) {
      if (globalStateChanged) {
        // Best-effort compensation keeps future sessions aligned with the UI
        // when the live session rejects its update.
        await rawACPHostRpc
          .jsonrpc(MCP_SET_POOL_SERVER_DISABLED_METHOD, {
            serverName,
            disabled: originalState,
          })
          .catch(() => undefined);
      }
      if (this.disabledState[serverName] === disabled) {
        const restored = { ...this.disabledState };
        if (hadOriginalOverride) restored[serverName] = originalOverride!;
        else delete restored[serverName];
        this.disabledState = restored;
      }
      throw e;
    }
  }

  async authenticate(server: MCPServerInputs): Promise<void> {
    const acpParams = this.#activeACPParams();
    if (!acpParams || !this.#supportsMCPSettingsCapability()) return;
    await rawACPHostRpc.jsonrpc(ACP_MCP_AUTHENTICATE_METHOD, {
      agentServer: acpParams.agentServer,
      sessionId: acpParams.sessionId,
      serverID: server.serverID,
      serverURL: server.serverURL,
      serverName: server.serverName,
    });
    this.setOAuthState(server.serverName, true);
  }

  async deleteSecrets(server: MCPServerInputs): Promise<void> {
    const acpParams = this.#activeACPParams();
    if (!acpParams || !this.#supportsMCPSettingsCapability()) return;
    await rawACPHostRpc.jsonrpc(ACP_MCP_DELETE_SECRETS_METHOD, {
      agentServer: acpParams.agentServer,
      sessionId: acpParams.sessionId,
      serverID: server.serverID,
      serverURL: server.serverURL,
    });
    this.setOAuthState(server.serverName, false);
  }

  isServerDisabled(server: MCPServerInputs): boolean {
    const local = this.disabledState[server.serverName];
    return local !== undefined ? local : server.disabled;
  }

  getServerStatus(server: MCPServerInputs): MCPServerStatus {
    const localAuthState = this.oauthState[server.serverName];
    const isAuthenticated = localAuthState ?? server.isAuthenticated;
    const needsOAuth = server.requiresOAuth && !isAuthenticated;

    const serverVars = this.variableValues[server.serverName] || {};
    const needsVariables = server.variables?.some(
      (v) => serverVars[v.name] === undefined && (v.value === null || v.value === undefined),
    );

    return needsOAuth || needsVariables ? "needs_setup" : "ready";
  }

  #activeACPParams(): ACPMCPParams | null {
    const activeSession = this.#activeSession();
    const agentServer = activeSession?.agentServer ?? this.#activeAgentServer();
    const sessionId =
      activeSession?.sessionId ??
      this.#acp.agents.configProbeSessionIdsByAgentServer[agentServer] ??
      null;
    if (!sessionId) return null;
    return {
      agentServer,
      sessionId,
    };
  }

  #supportsMCPSettingsCapability(): boolean {
    const agentServer = this.#activeAgentServer();
    const capabilities = this.#acp.agents.capabilitiesFor(agentServer);
    const meta = (capabilities as { _meta?: Record<string, unknown> } | null)?._meta;
    return Boolean(meta?.[ACP_MCP_SETTINGS_CAPABILITY]);
  }

  #activeAgentServer(): string {
    // Active session (desktop / chat editor) wins. Otherwise fall back to the
    // host-broadcast active agent (VS Code sidebar, which has no session of its
    // own), then the configured default.
    return (
      this.#activeSession()?.agentServer ??
      getACPActiveAgentServer() ??
      this.#acp.agents.defaultAgentServer
    );
  }

  #activeSession(): { agentServer: string; sessionId: string | null } | null {
    return this.#activeSessionResolver();
  }
}

// Fetch only the live session's allowCustomMCPServers (the per-model policy
// flag). The chat webview broadcasts this authoritative signal to the sidebar,
// whose own config probe runs a different model and can't read it. Returns null
// when the value is unknown (non-pool agent, older helper, or the fetch failed).
export async function fetchAllowCustomMCPServers(
  agentServer: string,
  sessionId: string,
): Promise<boolean | null> {
  try {
    const result = (await rawACPHostRpc.jsonrpc(ACP_MCP_SETTINGS_METHOD, {
      agentServer,
      sessionId,
    })) as { allowCustomMCPServers?: boolean } | null;
    return result?.allowCustomMCPServers ?? null;
  } catch {
    // Method missing (older helper) or non-pool agent — treat as unknown.
    return null;
  }
}
