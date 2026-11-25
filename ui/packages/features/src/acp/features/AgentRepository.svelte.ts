import type {
  AgentCapabilities,
  AvailableCommand,
  ClientSideConnection,
  Implementation,
  InitializeResponse,
  PromptCapabilities,
  SessionConfigOption,
  SessionId,
  SessionModeState,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import {
  camberAcpNavGetConfigCache,
  camberAcpNavUpsertConfigCache,
  camberAcpSessionClose,
  camberAppInstallAgentServer,
  camberAppRemoveAgentServer,
  camberAppSetAgentDefaultConfigOption,
  camberAppSetDefaultAgentServer,
  initializeStatefulModule as initializeHelperApi,
} from "@camber/helperapi";
import type {
  AppRemoveAgentServerOutput,
  AppSetAgentDefaultConfigOptionParams,
} from "@camber/helperapi/schemas";
import type { ACPAgentServerConfig, ACPAgentServers } from "@camber/rpc";
import { get } from "svelte/store";
import {
  DEFAULT_AGENT_SERVER,
  agentServerNames,
  normalizeAgentServerName,
  orderAgentServerNames,
  preferredAgentServer,
  resolveAgentServers,
} from "../agentServers";
import { parseAuthMethods, type ACPAuthMethod } from "../authMethods";
import {
  ACPTransportNotConfiguredError,
  normalizeACPError,
  type ACPSessionRepositoryError,
} from "../errors";
import { appState } from "../hostAdapter";
import type { HelperAPIClient } from "../hostRpc";
import {
  findModeConfigOption,
  isAuthRequiredError,
  syncModeFromConfigOptions,
  updateConfigOptionValue,
  updateSessionModeValue,
} from "./Session.svelte";
import { currentConfigSelections, mergeConfigSelections } from "./session/configOptions";
import {
  sessionSteeringTransport,
  supportsSessionSteering,
  type ACPSteerTransport,
} from "./session/steering";

// How long a probe's config report stays trusted before ensureConfigProbe
// re-probes. ACP only reports config options on session/new, so without
// re-probing the new-conversation page would show the first probe's options
// for the whole app run — e.g. missing a model the agent's lab released an
// hour ago. Long enough that focus/page-open bursts coalesce into nothing,
// short enough that agent-side changes appear within minutes.
const AGENT_CONFIG_FRESH_MS = 10 * 60 * 1000;

// Grace period before a superseded config probe's agent-side session is
// closed. MCP-settings RPCs resolve their sessionId from the probe map before
// calling (including `_poolside/mcp/authenticate`, which spans a browser OAuth
// round-trip that typically completes right around the window-focus event
// that triggers rotation); an immediate close would fail those calls, so give
// in-flight requests time to drain against the old session first.
const SUPERSEDED_PROBE_CLOSE_DELAY_MS = 60 * 1000;

// Backoff after a failed probe. Failures record no freshness, so without this
// every window focus would retry a broken agent — reconnecting, respawning the
// subprocess, and (for quiet refreshes) doing it invisibly.
const AGENT_CONFIG_FAILURE_BACKOFF_MS = 2 * 60 * 1000;

export interface ACPConnectionProvider {
  connect(agentServer: string): Promise<{
    conn: ClientSideConnection;
    initializeResponse: InitializeResponse;
  }>;
  disconnect?(agentServer: string): void;
  restart?(agentServer: string): Promise<void>;
}

export interface ACPConfigCacheEntry {
  agentServer: string;
  configOptions: SessionConfigOption[];
  availableCommands: AvailableCommand[];
  modes: SessionModeState | null;
  // Agent prompt capabilities (image / embeddedContext / audio) captured the
  // last time we connected. Cached so the client knows what content a prompt
  // may carry without re-connecting — e.g. to gate image attachments on a new
  // conversation whose agent has not connected yet. null when unknown.
  promptCapabilities: PromptCapabilities | null;
  // Cached so settings can show the installed agent version while disconnected.
  agentInfo: Implementation | null;
  cachedAt: string;
}

export interface ACPConfigCacheState {
  entry?: ACPConfigCacheEntry | null;
}

// A cache entry's payload, detached from Svelte proxies and without the
// identity fields the store owns.
type ACPConfigCacheSnapshot = Omit<ACPConfigCacheEntry, "agentServer" | "cachedAt">;

export interface ACPAgentServerConfigurationChange {
  changed: boolean;
  removedAgentServers: Set<string>;
}

export type ACPAuthenticationProbeResult = "authenticated" | "pending" | "failed";

interface ACPConnectionOptions {
  surfaceErrors?: boolean;
}

/**
 * Per-agent runtime state and connection lifecycle. Distinct from
 * AcpAgentServersRepository (which manages the *configuration* of which
 * agents exist) — this class owns the live state for each configured
 * agent: connection, capabilities, auth, and config cache. Whether a session
 * must be reloaded after its agent restarted is per-session state, on
 * ACPSession.restoreRequired.
 *
 * Methods here are pure agent-level — anything that touches session state
 * (e.g. migrating a local session when the user switches agents,
 * invalidating sessions on agent exit) stays on the session repository and
 * calls into this class for the agent-side work.
 */
export class ACPAgentRepository {
  connectionPool: ACPConnectionProvider | null = null;

  // Live connections keyed by agent server. Callers must ask for the agent
  // they are operating on instead of relying on a repository-global cursor.
  connectionsByAgentServer = $state.raw<Record<string, ClientSideConnection>>({});

  // initialize() responses keyed by agentServer.
  initializeResponses = $state.raw<Record<string, InitializeResponse>>({});

  // Configured agents.
  agentServerNames = $state<string[]>([DEFAULT_AGENT_SERVER]);
  defaultAgentServer = $state(DEFAULT_AGENT_SERVER);
  // Whether the default agent is pinned: pinned defaults are deliberate, so
  // the last-used auto-follow (recording sites) must leave them alone.
  defaultAgentServerPinned = $state(false);
  defaultConfigOptionsByAgentServer = $state.raw<Record<string, Record<string, string>>>({});
  // Config option ids the user pinned per agent (mirror of the store's
  // `pinned_config_options`). A pinned key keeps its default value: the
  // last-used persist skips it until it is unpinned.
  pinnedConfigOptionsByAgentServer = $state.raw<Record<string, string[]>>({});

  // Auth state per agent.
  authRequiredFor = $state<Record<string, true>>({});
  authInProgressFor = $state<Record<string, true>>({});
  authUriFor = $state<Record<string, string>>({});

  // Per-agent config cache (the configOptions / availableCommands / modes
  // a session would see if created against this agent).
  configCacheByAgentServer = $state.raw<Record<string, ACPConfigCacheEntry>>({});
  configCacheLoadingFor = $state.raw<Record<string, true>>({});
  configCacheRefreshes = new Map<string, Promise<void>>();
  // Whether a given in-flight refresh suppresses error banners. Keyed by the
  // refresh itself so a loud caller can tell it must not reuse a quiet one.
  configRefreshQuiet = new WeakMap<Promise<void>, boolean>();
  configProbeSessionIds = new Map<string, SessionId>();
  // When the agent last reported config (probe response, probe streaming
  // update, or a real session/new). Drives the ensureConfigProbe TTL; not
  // persisted, so every app run starts with one probe.
  agentConfigFreshAt = new Map<string, number>();
  // When a probe last failed, so a broken agent isn't retried on every focus.
  agentConfigFailedAt = new Map<string, number>();
  // Config values the user explicitly chose, per agent. The cache's
  // currentValues cannot serve this purpose: they hold whatever the agent
  // last reported for untouched options, so preserving them wholesale would
  // pin the agent's first-seen defaults forever and stop a changed
  // agent-side default from ever reaching the UI.
  userConfigSelections = new Map<string, Map<string, string | boolean>>();
  userModeSelections = new Map<string, string>();
  // Superseded probe sessions awaiting their close drain window, kept so a
  // webview teardown that eats the timer doesn't strand them forever.
  pendingProbeCloses = new Map<string, Set<SessionId>>();
  // Reactive mirror of configProbeSessionIds so consumers (e.g. the MCP
  // settings repo) can $derive off it. The Map above isn't reactive; this
  // is the read surface for code that needs to track changes.
  configProbeSessionIdsByAgentServer = $state.raw<Record<string, SessionId>>({});

  // Connection / agent-level error surface (auth required, transport
  // failures, agent crash). Per-session errors live on ACPSession.promptError.
  nonSessionError = $state.raw<ACPSessionRepositoryError | null>(null);
  nonSessionErrorAgentServer = $state<string | null>(null);

  setConnectionPool(connectionPool: ACPConnectionProvider): void {
    this.connectionPool = connectionPool;
    this.connectionsByAgentServer = {};
  }

  setHelperApiClient(client: HelperAPIClient): void {
    initializeHelperApi(client);
  }

  getInitializeResponse(agentServer: string): InitializeResponse | null {
    return this.initializeResponses[normalizeAgentServerName(agentServer)] ?? null;
  }

  /**
   * Resolve an agent's prompt capabilities, preferring a live initialize
   * response and falling back to the persisted config cache. The cache lets the
   * client know capabilities (e.g. image support) for a new conversation whose
   * agent has not connected yet. Returns null only when nothing is known.
   */
  promptCapabilitiesFor(agentServer: string): PromptCapabilities | null {
    agentServer = normalizeAgentServerName(agentServer);
    const live = this.initializeResponses[agentServer]?.agentCapabilities?.promptCapabilities;
    if (live) return live;
    return this.configCacheByAgentServer[agentServer]?.promptCapabilities ?? null;
  }

  installedVersionFor(agentServer: string): string | null {
    agentServer = normalizeAgentServerName(agentServer);
    const live = this.initializeResponses[agentServer]?.agentInfo?.version;
    if (live) return live;
    return this.configCacheByAgentServer[agentServer]?.agentInfo?.version ?? null;
  }

  setConnection(agentServer: string, conn: ClientSideConnection): void {
    agentServer = normalizeAgentServerName(agentServer);
    this.connectionsByAgentServer = {
      ...this.connectionsByAgentServer,
      [agentServer]: conn,
    };
  }

  connectionFor(agentServer: string): ClientSideConnection | null {
    return this.connectionsByAgentServer[normalizeAgentServerName(agentServer)] ?? null;
  }

  isConnectedTo(agentServer: string): boolean {
    return this.connectionFor(agentServer) !== null;
  }

  hasConnections(): boolean {
    return Object.keys(this.connectionsByAgentServer).length > 0;
  }

  capabilitiesFor(agentServer: string): AgentCapabilities | null {
    return this.getInitializeResponse(agentServer)?.agentCapabilities ?? null;
  }

  supportsLogout(agentServer: string): boolean {
    agentServer = normalizeAgentServerName(agentServer);
    return this.getInitializeResponse(agentServer)?.agentCapabilities?.auth?.logout != null;
  }

  steeringTransport(agentServer: string): ACPSteerTransport | null {
    agentServer = normalizeAgentServerName(agentServer);
    return sessionSteeringTransport(this.getInitializeResponse(agentServer));
  }

  supportsSteering(agentServer: string): boolean {
    agentServer = normalizeAgentServerName(agentServer);
    return supportsSessionSteering(this.getInitializeResponse(agentServer));
  }

  nonSessionErrorFor(agentServer: string): ACPSessionRepositoryError | null {
    agentServer = normalizeAgentServerName(agentServer);
    return this.nonSessionErrorAgentServer === agentServer ? this.nonSessionError : null;
  }

  setNonSessionError(agentServer: string, error: ACPSessionRepositoryError): void {
    this.nonSessionErrorAgentServer = normalizeAgentServerName(agentServer);
    this.nonSessionError = error;
  }

  clearNonSessionError(agentServer: string): void {
    agentServer = normalizeAgentServerName(agentServer);
    if (this.nonSessionErrorAgentServer !== agentServer) return;
    this.nonSessionErrorAgentServer = null;
    this.nonSessionError = null;
  }

  clearAllNonSessionErrors(): void {
    this.nonSessionErrorAgentServer = null;
    this.nonSessionError = null;
  }

  /**
   * Try to open / re-open a connection to `agentServer`. Updates
   * initializeResponses and the per-agent connection slot on success.
   */
  async connectServer(
    agentServer: string,
    options: ACPConnectionOptions = {},
  ): Promise<ClientSideConnection | null> {
    agentServer = normalizeAgentServerName(agentServer);
    if (!this.connectionPool) {
      if (options.surfaceErrors) {
        this.setNonSessionError(agentServer, new ACPTransportNotConfiguredError());
      }
      return null;
    }

    try {
      const { conn, initializeResponse } = await this.connectionPool.connect(agentServer);
      this.initializeResponses = {
        ...this.initializeResponses,
        [agentServer]: initializeResponse,
      };
      this.setConnection(agentServer, conn);
      if (options.surfaceErrors) {
        this.clearNonSessionError(agentServer);
      }
      return conn;
    } catch (e) {
      if (options.surfaceErrors) {
        this.setNonSessionError(agentServer, normalizeACPError(e));
      }
      return null;
    }
  }

  async activate(agentServer: string): Promise<ClientSideConnection | null> {
    agentServer = normalizeAgentServerName(agentServer);
    return this.connectServer(agentServer, { surfaceErrors: true });
  }

  async useAgentServer(agentServer: string): Promise<ClientSideConnection | null> {
    return this.activate(agentServer);
  }

  async connect(): Promise<ClientSideConnection | null> {
    return this.useAgentServer(this.defaultAgentServer);
  }

  async connectConfiguredServers(): Promise<ClientSideConnection | null> {
    if (!this.connectionPool) {
      this.setNonSessionError(this.defaultAgentServer, new ACPTransportNotConfiguredError());
      return null;
    }
    this.clearAllNonSessionErrors();
    let defaultConn: ClientSideConnection | null = null;
    for (const agentServer of this.agentServerNames) {
      const isDefault = agentServer === this.defaultAgentServer;
      const conn = await this.connectServer(agentServer, { surfaceErrors: isDefault });
      if (isDefault) {
        defaultConn = conn;
      }
    }
    return defaultConn;
  }

  markAuthRequired(agentServer: string): void {
    agentServer = normalizeAgentServerName(agentServer);
    if (this.authRequiredFor[agentServer]) return;
    this.authRequiredFor = { ...this.authRequiredFor, [agentServer]: true };
  }

  clearAuthRequired(agentServer: string): void {
    agentServer = normalizeAgentServerName(agentServer);
    if (!this.authRequiredFor[agentServer] && !this.authUriFor[agentServer]) return;
    if (this.authRequiredFor[agentServer]) {
      const next = { ...this.authRequiredFor };
      delete next[agentServer];
      this.authRequiredFor = next;
    }
    if (this.authUriFor[agentServer]) {
      const next = { ...this.authUriFor };
      delete next[agentServer];
      this.authUriFor = next;
    }
  }

  async authenticate(methodId: string, agentServer = this.defaultAgentServer): Promise<void> {
    agentServer = normalizeAgentServerName(agentServer);
    if (this.authInProgressFor[agentServer]) return;
    const conn = await this.connectServer(agentServer, { surfaceErrors: true });
    if (!conn) return;

    this.authInProgressFor = { ...this.authInProgressFor, [agentServer]: true };
    try {
      await conn.authenticate({ methodId });
      this.clearAuthRequired(agentServer);
      this.clearNonSessionError(agentServer);
    } catch (e) {
      this.setNonSessionError(agentServer, normalizeACPError(e));
    } finally {
      const next = { ...this.authInProgressFor };
      delete next[agentServer];
      this.authInProgressFor = next;
    }
  }

  async probeAuthentication(
    methodId: string,
    agentServer = this.defaultAgentServer,
  ): Promise<ACPAuthenticationProbeResult> {
    agentServer = normalizeAgentServerName(agentServer);
    if (this.authInProgressFor[agentServer]) return "pending";
    const conn = await this.connectServer(agentServer, { surfaceErrors: true });
    if (!conn) return "failed";

    this.authInProgressFor = { ...this.authInProgressFor, [agentServer]: true };
    try {
      await conn.authenticate({ methodId });
      this.clearAuthRequired(agentServer);
      this.clearNonSessionError(agentServer);
      return "authenticated";
    } catch (e) {
      const error = normalizeACPError(e);
      if (isAuthRequiredError(error)) {
        this.markAuthRequired(agentServer);
        this.clearNonSessionError(agentServer);
        return "pending";
      }
      this.setNonSessionError(agentServer, error);
      return "failed";
    } finally {
      const next = { ...this.authInProgressFor };
      delete next[agentServer];
      this.authInProgressFor = next;
    }
  }

  async logout(agentServer = this.defaultAgentServer): Promise<void> {
    agentServer = normalizeAgentServerName(agentServer);
    if (this.authInProgressFor[agentServer]) return;
    const conn = await this.connectServer(agentServer, { surfaceErrors: true });
    if (!conn || !this.supportsLogout(agentServer)) return;

    this.authInProgressFor = { ...this.authInProgressFor, [agentServer]: true };
    try {
      await conn.logout({});
      const { [agentServer]: _authUri, ...authUriFor } = this.authUriFor;
      this.authUriFor = authUriFor;
      this.markAuthRequired(agentServer);
      this.clearNonSessionError(agentServer);
    } catch (e) {
      this.setNonSessionError(agentServer, normalizeACPError(e));
    } finally {
      const next = { ...this.authInProgressFor };
      delete next[agentServer];
      this.authInProgressFor = next;
    }
  }

  handleAuthenticateUpdate(params: Record<string, unknown>, agentServer: string): void {
    agentServer = normalizeAgentServerName(agentServer);
    const meta = (params._meta ?? params) as Record<string, unknown>;
    const authUri = typeof meta.authUri === "string" ? meta.authUri : null;
    if (authUri) {
      this.authUriFor = { ...this.authUriFor, [agentServer]: authUri };
    }
  }

  isConfigCacheLoadingFor(agentServer: string): boolean {
    agentServer = normalizeAgentServerName(agentServer);
    return (
      Boolean(this.configCacheLoadingFor[agentServer]) &&
      !this.configCacheByAgentServer[agentServer]
    );
  }

  isConfigCacheRefreshInFlightFor(agentServer: string): boolean {
    return this.configCacheRefreshes.has(normalizeAgentServerName(agentServer));
  }

  authRequiredForAgent(agentServer: string): boolean {
    agentServer = normalizeAgentServerName(agentServer);
    return Boolean(this.authRequiredFor[agentServer]);
  }

  authInProgressForAgent(agentServer: string): boolean {
    agentServer = normalizeAgentServerName(agentServer);
    return Boolean(this.authInProgressFor[agentServer]);
  }

  authMethodsForAgent(agentServer: string): ACPAuthMethod[] {
    agentServer = normalizeAgentServerName(agentServer);
    return parseAuthMethods(this.initializeResponses[agentServer]?.authMethods ?? null);
  }

  authUriForAgent(agentServer: string): string | null {
    agentServer = normalizeAgentServerName(agentServer);
    return this.authUriFor[agentServer] ?? null;
  }

  cachedAvailableCommands(agentServer: string): AvailableCommand[] {
    return (
      this.configCacheByAgentServer[normalizeAgentServerName(agentServer)]?.availableCommands ?? []
    );
  }

  defaultConfigOptionsFor(agentServer = this.defaultAgentServer): Record<string, string> {
    const normalizedAgentServer = normalizeAgentServerName(agentServer);
    const reactiveDefaults = this.defaultConfigOptionsByAgentServer[normalizedAgentServer];
    if (reactiveDefaults) return reactiveDefaults;

    const resolved = resolveAgentServers(get(appState).userSettings.acpAgentServers);
    return resolved[normalizedAgentServer]?.default_config_options ?? {};
  }

  pinnedConfigOptionsFor(agentServer = this.defaultAgentServer): string[] {
    const normalizedAgentServer = normalizeAgentServerName(agentServer);
    const reactivePinned = this.pinnedConfigOptionsByAgentServer[normalizedAgentServer];
    if (reactivePinned) return reactivePinned;

    const resolved = resolveAgentServers(get(appState).userSettings.acpAgentServers);
    return resolved[normalizedAgentServer]?.pinned_config_options ?? [];
  }

  /** Whether the user pinned `configId`'s default for this agent. */
  isPinnedConfigOption(agentServer: string, configId: string): boolean {
    return this.pinnedConfigOptionsFor(agentServer).includes(configId);
  }

  setConfigCacheLoading(agentServer: string, loading: boolean): void {
    agentServer = normalizeAgentServerName(agentServer);
    if (loading) {
      if (this.configCacheLoadingFor[agentServer]) return;
      this.configCacheLoadingFor = { ...this.configCacheLoadingFor, [agentServer]: true };
      return;
    }
    if (!this.configCacheLoadingFor[agentServer]) return;
    const next = { ...this.configCacheLoadingFor };
    delete next[agentServer];
    this.configCacheLoadingFor = next;
  }

  /**
   * Drop the live runtime state (connection and initializeResponse) for an
   * agent that has exited or is being restarted. Session-level
   * invalidation (cancel prompts, mark for restore) is the caller's
   * responsibility — that lives on the session repository.
   */
  clearRuntimeFor(agentServer: string): void {
    agentServer = normalizeAgentServerName(agentServer);
    this.connectionPool?.disconnect?.(agentServer);
    const { [agentServer]: _conn, ...connectionsByAgentServer } = this.connectionsByAgentServer;
    this.connectionsByAgentServer = connectionsByAgentServer;
    const { [agentServer]: _removed, ...initializeResponses } = this.initializeResponses;
    this.initializeResponses = initializeResponses;
    // Throwaway config probe bound to this agent is now invalid.
    this.#removeConfigProbe(agentServer);
  }

  /**
   * Forget only the throwaway config-probe session for an agent, leaving its
   * live connection and cached initialize response intact. Used to recover when
   * a probe session has gone stale (e.g. the agent evicted it) so the next
   * ensureConfigProbe creates a fresh one without a full reconnect.
   */
  forgetConfigProbe(agentServer: string): void {
    agentServer = normalizeAgentServerName(agentServer);
    const sessionId = this.configProbeSessionIds.get(agentServer);
    if (sessionId) {
      // "Stale to one consumer" is not "gone agent-side": a fetch that raced
      // a probe rotation forgets the healthy replacement, which would then
      // leak when the next refresh has no predecessor to close. Drain first —
      // another surface (a second webview, the VS Code sidebar) may still be
      // mid-RPC on this id.
      this.#closeSupersededProbe(agentServer, sessionId);
    }
    this.#removeConfigProbe(agentServer);
  }

  // Drop the throwaway config-probe session bound to an agent (both the Map and
  // the by-agent record). Shared by clearRuntimeFor and forgetConfigProbe.
  #removeConfigProbe(agentServer: string): void {
    this.configProbeSessionIds.delete(agentServer);
    this.agentConfigFreshAt.delete(agentServer);
    // A restart or a forced re-probe is a deliberate retry: don't hold it
    // behind a backoff from the failure that prompted it.
    this.agentConfigFailedAt.delete(agentServer);
    if (this.configProbeSessionIdsByAgentServer[agentServer]) {
      const { [agentServer]: _, ...rest } = this.configProbeSessionIdsByAgentServer;
      this.configProbeSessionIdsByAgentServer = rest;
    }
  }

  discardRuntimeStateFor(agentServers: Set<string>): void {
    const initializeResponses = { ...this.initializeResponses };
    const authRequiredFor = { ...this.authRequiredFor };
    const authInProgressFor = { ...this.authInProgressFor };
    const authUriFor = { ...this.authUriFor };
    const configCacheByAgentServer = { ...this.configCacheByAgentServer };
    const configCacheLoadingFor = { ...this.configCacheLoadingFor };
    let nextConfigProbeSessionIdsByAgentServer = this.configProbeSessionIdsByAgentServer;

    for (const rawAgentServer of agentServers) {
      const agentServer = normalizeAgentServerName(rawAgentServer);
      delete initializeResponses[agentServer];
      delete authRequiredFor[agentServer];
      delete authInProgressFor[agentServer];
      delete authUriFor[agentServer];
      delete configCacheByAgentServer[agentServer];
      delete configCacheLoadingFor[agentServer];
      this.configProbeSessionIds.delete(agentServer);
      this.agentConfigFreshAt.delete(agentServer);
      this.agentConfigFailedAt.delete(agentServer);
      this.userConfigSelections.delete(agentServer);
      this.userModeSelections.delete(agentServer);
      this.pendingProbeCloses.delete(agentServer);
      // configRefreshQuiet is keyed by the refresh promise and weakly held,
      // so it needs no explicit cleanup here.
      if (nextConfigProbeSessionIdsByAgentServer[agentServer]) {
        const { [agentServer]: _, ...rest } = nextConfigProbeSessionIdsByAgentServer;
        nextConfigProbeSessionIdsByAgentServer = rest;
      }
      this.configCacheRefreshes.delete(agentServer);
      const { [agentServer]: _conn, ...connectionsByAgentServer } = this.connectionsByAgentServer;
      this.connectionsByAgentServer = connectionsByAgentServer;
    }

    this.initializeResponses = initializeResponses;
    this.authRequiredFor = authRequiredFor;
    this.authInProgressFor = authInProgressFor;
    this.authUriFor = authUriFor;
    this.configCacheByAgentServer = configCacheByAgentServer;
    this.configCacheLoadingFor = configCacheLoadingFor;
    this.configProbeSessionIdsByAgentServer = nextConfigProbeSessionIdsByAgentServer;
  }

  async restart(agentServer: string): Promise<void> {
    agentServer = normalizeAgentServerName(agentServer);
    this.clearRuntimeFor(agentServer);
    await this.connectionPool?.restart?.(agentServer);
  }

  async setDefaultAgentServer(
    agentServer: string,
  ): Promise<{ agentServers: ACPAgentServers; defaultAgentServer?: string }> {
    // Absent pin param: the store preserves the current pinned state, so a
    // last-used write through here never pins or unpins on its own — and is
    // skipped entirely at dequeue while the store's fresh state says the
    // default is pinned (see #persistDefaultAgentServer).
    return this.#persistDefaultAgentServer(agentServer, undefined);
  }

  /**
   * Pin `agentServer` as the default agent: the default becomes this agent
   * AND stays put — every last-used recording site skips its write while the
   * pin holds. Serialized through the agent-servers persist queue.
   */
  async setPinnedDefaultAgentServer(
    agentServer: string,
  ): Promise<{ agentServers: ACPAgentServers; defaultAgentServer?: string }> {
    return this.#persistDefaultAgentServer(agentServer, true);
  }

  /**
   * Release the default-agent pin. The default agent itself is unchanged; it
   * simply resumes following the last explicitly used agent.
   */
  async unpinDefaultAgentServer(): Promise<{
    agentServers: ACPAgentServers;
    defaultAgentServer?: string;
  }> {
    return this.#persistDefaultAgentServer(undefined, false);
  }

  // Shared writer for the default agent and its pin. `agentServer` undefined
  // leaves the stored default untouched (unpin); `pinned` undefined leaves
  // the stored pin untouched (the plain last-used write) — the store
  // preserves either field when its param is absent.
  async #persistDefaultAgentServer(
    agentServer: string | undefined,
    pinned: boolean | undefined,
  ): Promise<{ agentServers: ACPAgentServers; defaultAgentServer?: string }> {
    const normalized =
      agentServer === undefined ? undefined : normalizeAgentServerName(agentServer);
    const previousDefault = this.defaultAgentServer;
    const previousPinned = this.defaultAgentServerPinned;
    // Optimistic and immediate; the store write serializes behind any other
    // in-flight agent-server persist (see #enqueueAgentServersPersist).
    if (normalized !== undefined) {
      this.defaultAgentServer = preferredAgentServer(this.agentServerNames, normalized);
    }
    if (pinned !== undefined) this.defaultAgentServerPinned = pinned;
    return this.#enqueueAgentServersPersist(async () => {
      try {
        // The helper's shared operation (the camber CLI's agents default runs
        // it too) does the read-modify-write atomically under its own lock.
        // An absent pin param marks the last-used follow
        // (setDefaultAgentServer): its callers gate on an in-memory pin
        // mirror that can be stale — a window that never saw another
        // window's pin would MOVE the pinned default — so the helper re-checks
        // the store's fresh flag and skips the write while it is pinned. The
        // mirrors then heal from the store state it returns. Explicit
        // pin/unpin writes (pinned defined) proceed regardless — they are the
        // deliberate acts the pin protects.
        const res = await camberAppSetDefaultAgentServer({
          ...(normalized === undefined ? {} : { agentServer: normalized }),
          ...(pinned === undefined ? {} : { pinned }),
        });
        const resAgentServers = (res.state.agentServers ?? {}) as ACPAgentServers;
        const names = agentServerNames(resAgentServers);
        this.defaultAgentServer = preferredAgentServer(names, res.state.defaultAgentServer);
        // Absent on the wire means unpinned (the store omits a false flag).
        this.defaultAgentServerPinned = res.state.default_agent_server_pinned === true;
        return {
          agentServers: resAgentServers,
          defaultAgentServer: res.state.defaultAgentServer,
        };
      } catch (error) {
        // Mirror the config-pin path's rollback: a failed persist must not
        // leave the optimistic mirrors claiming a default/pin the store
        // refused.
        this.defaultAgentServer = previousDefault;
        this.defaultAgentServerPinned = previousPinned;
        throw error;
      }
    });
  }

  /**
   * Pin `configId` to `value` for this agent: the star's pressed state. The
   * write carries BOTH the default value and the pinned-list membership, so
   * one queue round trip lands the pair atomically. While pinned, the
   * last-used auto-follow leaves the key alone (see
   * #persistLastUsedConfigOption); how defaults APPLY to new sessions is
   * unchanged — pinning only decides who may write the default.
   */
  async setPinnedDefaultConfigOption(
    agentServer: string,
    configId: string,
    value: string,
  ): Promise<void> {
    agentServer = normalizeAgentServerName(agentServer);
    // Optimistic and immediate; the store write serializes behind any other
    // in-flight agent-server persist (see #enqueueAgentServersPersist).
    const previousDefaults = this.defaultConfigOptionsByAgentServer;
    const previousPinned = this.pinnedConfigOptionsByAgentServer;
    this.defaultConfigOptionsByAgentServer = {
      ...previousDefaults,
      [agentServer]: {
        ...this.defaultConfigOptionsFor(agentServer),
        [configId]: value,
      },
    };
    const optimisticPinned = this.pinnedConfigOptionsFor(agentServer);
    this.pinnedConfigOptionsByAgentServer = {
      ...previousPinned,
      [agentServer]: optimisticPinned.includes(configId)
        ? optimisticPinned
        : [...optimisticPinned, configId],
    };
    return this.#enqueueAgentServersPersist(() =>
      this.#persistConfigOption(
        { agentServer, optionId: configId, value, pinned: true },
        previousDefaults,
        previousPinned,
      ),
    );
  }

  /**
   * Release the pin on `configId`. By default the default value itself stays
   * — the key simply resumes being overwritten by the last-used auto-follow.
   *
   * `clearValue` removes the stored default value in the same write. Callers
   * pass it for options the auto-follow will never manage (behavioral modes
   * and uncategorized/custom-category options — the inverse of
   * shouldPersistConfigSelection): applyDefaultConfigOptions applies EVERY
   * stored default to new sessions, so a kept value on a follow-less key
   * would silently seed every future conversation — e.g. a pinned-then-
   * unpinned "Bypass permissions" — with no UI left to clear it.
   */
  async unpinDefaultConfigOption(
    agentServer: string,
    configId: string,
    options: { clearValue?: boolean } = {},
  ): Promise<void> {
    agentServer = normalizeAgentServerName(agentServer);
    const clearValue = options.clearValue === true;
    const previousDefaults = this.defaultConfigOptionsByAgentServer;
    const previousPinned = this.pinnedConfigOptionsByAgentServer;
    this.pinnedConfigOptionsByAgentServer = {
      ...previousPinned,
      [agentServer]: this.pinnedConfigOptionsFor(agentServer).filter((id) => id !== configId),
    };
    if (clearValue) {
      const { [configId]: _cleared, ...remaining } = this.defaultConfigOptionsFor(agentServer);
      this.defaultConfigOptionsByAgentServer = {
        ...previousDefaults,
        [agentServer]: remaining,
      };
    }
    return this.#enqueueAgentServersPersist(() =>
      this.#persistConfigOption(
        { agentServer, optionId: configId, pinned: false, ...(clearValue ? { clearValue } : {}) },
        previousDefaults,
        previousPinned,
      ),
    );
  }

  // Runs inside the persist queue: one call to the helper's shared
  // camber/app/setAgentDefaultConfigOption operation (the camber CLI's agents
  // config default runs it too), which merges only this change into the
  // agent's stored entry atomically under the helper's lock. `pinned` true
  // pins the value, false unpins (`clearValue` also drops the stored value,
  // for options the last-used auto-follow would never overwrite — see
  // unpinDefaultConfigOption), and absent is the last-used follow, which the
  // helper skips when the store's fresh state has the key pinned. A skipped
  // write (that, or an agent no longer configured) restores the mirrors.
  async #persistConfigOption(
    params: AppSetAgentDefaultConfigOptionParams,
    previousDefaults: Record<string, Record<string, string>>,
    previousPinned: Record<string, string[]>,
  ): Promise<void> {
    const restore = () => {
      this.defaultConfigOptionsByAgentServer = previousDefaults;
      this.pinnedConfigOptionsByAgentServer = previousPinned;
    };
    try {
      const res = await camberAppSetAgentDefaultConfigOption(params);
      if (!res.applied) {
        restore();
        return;
      }
      const savedAgentServers = (res.state.agentServers ?? {}) as ACPAgentServers;
      this.syncDefaultConfigOptions(savedAgentServers);
      appState.update((state) => ({
        ...state,
        userSettings: {
          ...state.userSettings,
          acpAgentServers: savedAgentServers,
        },
      }));
    } catch (error) {
      restore();
      throw error;
    }
  }

  configureAgentServers(
    names: string[],
    defaultAgentServer?: string,
    defaultAgentServerPinned?: boolean,
  ): ACPAgentServerConfigurationChange {
    this.syncDefaultConfigOptions(get(appState).userSettings.acpAgentServers);
    // Only an explicit value syncs the pin mirror: most callers reconfigure
    // names/default without knowing the pin state, and must not clear it.
    if (defaultAgentServerPinned !== undefined) {
      this.defaultAgentServerPinned = defaultAgentServerPinned;
    }
    const ordered = orderAgentServerNames(names);
    const normalizedDefault = normalizeAgentServerName(defaultAgentServer ?? DEFAULT_AGENT_SERVER);
    const previousNames = this.agentServerNames;
    const previousDefault = this.defaultAgentServer;
    const unchanged =
      ordered.length === previousNames.length &&
      ordered.every((name, index) => name === previousNames[index]) &&
      normalizedDefault === previousDefault;
    if (unchanged) {
      return { changed: false, removedAgentServers: new Set() };
    }

    const removedAgentServers = new Set(
      previousNames.filter((agentServer) => !ordered.includes(agentServer)),
    );
    this.agentServerNames = ordered;
    this.defaultAgentServer = preferredAgentServer(ordered, normalizedDefault);
    return { changed: true, removedAgentServers };
  }

  private syncDefaultConfigOptions(agentServers?: ACPAgentServers): void {
    const resolved = Object.entries(resolveAgentServers(agentServers));
    this.defaultConfigOptionsByAgentServer = Object.fromEntries(
      resolved.map(([agentServer, config]) => [
        agentServer,
        { ...(config.default_config_options ?? {}) },
      ]),
    );
    this.pinnedConfigOptionsByAgentServer = Object.fromEntries(
      resolved.map(([agentServer, config]) => [
        agentServer,
        [...(config.pinned_config_options ?? [])],
      ]),
    );
  }

  // ---- Config cache ----
  //
  // The cache is the snapshot of an agent's configOptions / availableCommands
  // / modes that a freshly-created session would see. The empty-state UI
  // reads from it to populate dropdowns before any session exists. It is
  // refreshed from the agent on first use, again whenever ensureConfigProbe
  // runs with the last agent report gone stale (new-conversation page open,
  // window focus), when the user restarts the agent, or via the streaming
  // session updates routed through `handleConfigProbeSessionUpdate`.
  //
  // Option *definitions* in the cache belong to the agent, but the
  // currentValues are user state: sessionless drafts write their picker
  // selections straight into the cache. Refreshes therefore preserve cached
  // selections that are still valid instead of resetting them to the agent's
  // defaults (see preserveCachedSelections).
  //
  // These methods are pure cache operations — they do not apply the cached
  // values to any session. Callers that want a local session to mirror the
  // cache call `session.applyCachedConfig()` after.

  cachedConfigFor(agentServer: string): ACPConfigCacheEntry | undefined {
    return this.configCacheByAgentServer[normalizeAgentServerName(agentServer)];
  }

  /**
   * Make sure the in-memory + persisted cache for `agentServer` is at
   * least somewhat fresh. Loads from the persistence layer first; if
   * stale, refreshes via the agent.
   */
  async ensureCachedConfig(agentServer = this.defaultAgentServer, cwd = "/"): Promise<void> {
    agentServer = normalizeAgentServerName(agentServer);
    if (!this.configCacheByAgentServer[agentServer]) {
      this.setConfigCacheLoading(agentServer, true);
    }
    try {
      const cached = await this.loadCachedConfigFromStore(agentServer);
      if (cached && !isConfigCacheStale(cached)) return;
      await this.refreshCachedConfig(agentServer, cwd);
    } finally {
      this.setConfigCacheLoading(agentServer, false);
    }
  }

  /**
   * Same as ensureCachedConfig but doesn't refresh if a persisted entry
   * exists (even if stale) — used by createSession, which wants the cached
   * values immediately and lets a background ensure run for freshness later
   * if needed.
   */
  async loadOrInitCachedConfig(agentServer: string, cwd: string): Promise<void> {
    agentServer = normalizeAgentServerName(agentServer);
    if (!this.configCacheByAgentServer[agentServer]) {
      this.setConfigCacheLoading(agentServer, true);
    }
    try {
      const cached = await this.loadCachedConfigFromStore(agentServer);
      if (!cached) await this.refreshCachedConfig(agentServer, cwd);
    } finally {
      this.setConfigCacheLoading(agentServer, false);
    }
  }

  /**
   * Ensure a throwaway config probe exists for this agent and that the agent
   * reported config recently (AGENT_CONFIG_FRESH_MS). ACP does not currently
   * expose a sessionless getConfig call, so a probe is implemented by
   * creating an agent-side session and using its returned config/options.
   * It is never represented as an ACPSession. A stale probe is re-run — and
   * its predecessor's agent-side session closed — so the options behind the
   * new-conversation page track the agent instead of freezing at the first
   * probe of the app run.
   */
  async ensureConfigProbe(
    agentServer = this.defaultAgentServer,
    cwd = "/",
    options: { quiet?: boolean } = {},
  ): Promise<void> {
    agentServer = normalizeAgentServerName(agentServer);
    // A failed probe records no freshness, so without a backoff every focus
    // would retry a broken or offline agent — respawning its subprocess each
    // time, invisibly when quiet.
    if (this.#isAgentConfigFailureRecent(agentServer)) return;
    if (this.configProbeSessionIdsByAgentServer[agentServer]) {
      if (this.isAgentConfigFresh(agentServer)) return;
      // Rotating the probe strands the predecessor's agent-side session when
      // the agent cannot close-and-reopen sessions (the helper's close is a
      // silent no-op then). For those agents keep the run's first probe —
      // stale options beat leaking a session per rotation.
      if (!this.#supportsProbeRotation(agentServer)) return;
    }
    await this.refreshCachedConfig(agentServer, cwd, { quiet: options.quiet });
  }

  // Mirror of the helper's supportsSessionClose predicate (acpproxy
  // process.go): session/close plus a reopen path. Without both, the
  // helper's CloseSession succeeds without closing anything.
  #supportsProbeRotation(agentServer: string): boolean {
    const capabilities = this.capabilitiesFor(agentServer);
    if (capabilities?.sessionCapabilities?.close == null) return false;
    return capabilities.sessionCapabilities.resume != null || capabilities.loadSession === true;
  }

  /**
   * Record that the agent just reported its config (a probe response or a
   * real session/new), so ensureConfigProbe can skip re-probing until the
   * report goes stale.
   */
  markAgentConfigFresh(agentServer: string): void {
    agentServer = normalizeAgentServerName(agentServer);
    this.agentConfigFreshAt.set(agentServer, Date.now());
    this.agentConfigFailedAt.delete(agentServer);
  }

  isAgentConfigFresh(agentServer: string): boolean {
    const freshAt = this.agentConfigFreshAt.get(normalizeAgentServerName(agentServer));
    return freshAt !== undefined && Date.now() - freshAt < AGENT_CONFIG_FRESH_MS;
  }

  #markAgentConfigFailed(agentServer: string): void {
    this.agentConfigFailedAt.set(normalizeAgentServerName(agentServer), Date.now());
  }

  #isAgentConfigFailureRecent(agentServer: string): boolean {
    const failedAt = this.agentConfigFailedAt.get(normalizeAgentServerName(agentServer));
    return failedAt !== undefined && Date.now() - failedAt < AGENT_CONFIG_FAILURE_BACKOFF_MS;
  }

  /**
   * Record a config value the user explicitly chose, so a later probe keeps
   * it instead of reverting to the agent's default for a new session. Values
   * the user never touched are deliberately not recorded: those must track
   * the agent, so a lab changing its default default reaches the picker.
   *
   * Every explicit choice also persists as the agent's last-used value (via
   * the same per-agent store applyDefaultConfigOptions reads), so a new
   * conversation starts from whatever the user picked last — unless the
   * caller passes `persist: false` (options whose semantics are not known to
   * be safe to seed future conversations with: mode-shaped behavioral session
   * state, and uncategorized/custom-category options; see
   * shouldPersistConfigSelection). The in-memory recording always happens.
   */
  recordUserConfigSelection(
    agentServer: string,
    configId: string,
    value: string | boolean,
    options: { persist?: boolean } = {},
  ): void {
    agentServer = normalizeAgentServerName(agentServer);
    const selections = this.userConfigSelections.get(agentServer) ?? new Map();
    selections.set(configId, value);
    this.userConfigSelections.set(agentServer, selections);
    if (options.persist === false) return;
    this.#persistLastUsedConfigOption(agentServer, configId, String(value));
  }

  // Every default write to the agent-servers store (a last-used config
  // option, a remembered default agent, a pin) is one helper call that does
  // its read-modify-write atomically under the helper's lock. They still run
  // one at a time through this queue so each optimistic mirror update is
  // reconciled by its own write's result in order (an earlier write's late
  // response can never overwrite a later one's), and so a store re-read can
  // wait for them (agentServersPersistsSettled). In-memory optimistic updates
  // stay immediate, outside the queue.
  #agentServersPersistQueue: Promise<unknown> = Promise.resolve();

  #enqueueAgentServersPersist<T>(job: () => Promise<T>): Promise<T> {
    const result = this.#agentServersPersistQueue.catch(() => {}).then(job);
    this.#agentServersPersistQueue = result;
    return result;
  }

  /**
   * Resolves once every agent-servers persist queued so far has settled. Each
   * persist ends in a store write the helper broadcasts, so a store re-read
   * that waits for this cannot roll back an optimistic mirror mid-write.
   */
  agentServersPersistsSettled(): Promise<void> {
    return this.#agentServersPersistQueue.then(
      () => undefined,
      () => undefined,
    );
  }

  #persistLastUsedConfigOption(agentServer: string, configId: string, value: string): void {
    void this.#enqueueAgentServersPersist(async () => {
      // Checked at run time (not enqueue time) so a queued duplicate of a
      // value an earlier write just landed is skipped too.
      if (this.defaultConfigOptionsFor(agentServer)[configId] === value) return;
      const previousDefaults = this.defaultConfigOptionsByAgentServer;
      const previousPinned = this.pinnedConfigOptionsByAgentServer;
      this.defaultConfigOptionsByAgentServer = {
        ...previousDefaults,
        [agentServer]: {
          ...this.defaultConfigOptionsFor(agentServer),
          [configId]: value,
        },
      };
      // No pin param: pinned keys are deliberate defaults, so the helper
      // skips the write when the store's fresh state (not this window's
      // mirror) has the key pinned, and the mirror is restored. Failures log
      // and move on — persistence must never break the selection itself.
      await this.#persistConfigOption(
        { agentServer, optionId: configId, value },
        previousDefaults,
        previousPinned,
      ).catch((error: unknown) => {
        console.error("Failed to persist last-used ACP config option", error);
      });
    });
  }

  /**
   * Settings > Agents' install: the helper's shared
   * camber/app/installAgentServer operation (the camber CLI's agents install
   * runs it too) downloads and records the agent, then adds `config` to the
   * stored map under the helper's agent-server lock, every other entry — and
   * its default and pinned options — exactly as stored. The download can take
   * a while, so this does not wait in the persist queue: the helper's lock
   * already serializes the write itself against every other writer.
   *
   * Returns the map that was written, so the caller can mirror it into app
   * state instead of its stale snapshot.
   */
  async installAgentServer(
    agentServer: string,
    config: ACPAgentServerConfig,
  ): Promise<ACPAgentServers> {
    const res = await camberAppInstallAgentServer({ agentServer, config });
    const saved = (res.state.agentServers ?? {}) as ACPAgentServers;
    this.syncDefaultConfigOptions(saved);
    return saved;
  }

  /**
   * Settings > Agents' disable: the helper's shared
   * camber/app/removeAgentServer operation (the camber CLI's agents remove
   * runs it too) drops the agent from the stored map under the helper's
   * lock, then archives each of its conversations as the sidebar does. The
   * result lists what was archived and the navigation state after it, for
   * the conversation repository to apply (see
   * ACPConversationRepository.archiveAgentServer).
   */
  async removeAgentServer(agentServer: string): Promise<AppRemoveAgentServerOutput> {
    const res = await camberAppRemoveAgentServer({
      agentServer: normalizeAgentServerName(agentServer),
    });
    this.syncDefaultConfigOptions((res.state.agentServers ?? {}) as ACPAgentServers);
    return res;
  }

  recordUserModeSelection(agentServer: string, modeId: string): void {
    this.userModeSelections.set(normalizeAgentServerName(agentServer), modeId);
  }

  userConfigSelectionsFor(agentServer: string): Map<string, string | boolean> {
    return this.userConfigSelections.get(normalizeAgentServerName(agentServer)) ?? new Map();
  }

  userModeSelectionFor(agentServer: string): string | null {
    return this.userModeSelections.get(normalizeAgentServerName(agentServer)) ?? null;
  }

  /**
   * Force a refresh against the agent (creates a throwaway config probe,
   * reads its config, writes that to the cache). Coalesces concurrent
   * refreshes for the same agent: without `fresh`, an in-flight refresh is
   * returned as-is; with `fresh`, its probe may predate the change that
   * prompted this call, so a new refresh is chained behind it (latest wins).
   */
  async refreshCachedConfig(
    agentServer = this.defaultAgentServer,
    cwd = "/",
    options: { fresh?: boolean; quiet?: boolean } = {},
  ): Promise<void> {
    agentServer = normalizeAgentServerName(agentServer);
    const quiet = options.quiet === true;
    const existing = this.configCacheRefreshes.get(agentServer);
    // Reuse an in-flight refresh only when it will report failures at least
    // as loudly as this caller needs. A loud caller (opening a conversation,
    // confirming a login) riding on a background probe would otherwise have
    // its error swallowed, so it chains its own refresh behind instead.
    const canReuse =
      existing && !options.fresh && (quiet || !this.configRefreshQuiet.get(existing));
    if (canReuse) return existing;

    if (!this.configCacheByAgentServer[agentServer]) {
      this.setConfigCacheLoading(agentServer, true);
    }
    const refresh = (existing ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.refreshCachedConfigCore(agentServer, cwd || "/", quiet))
      .finally(() => {
        // A fresh refresh may have been chained behind this one; only the
        // latest entry cleans up.
        if (this.configCacheRefreshes.get(agentServer) !== refresh) return;
        this.configCacheRefreshes.delete(agentServer);
        this.configRefreshQuiet.delete(refresh);
        this.setConfigCacheLoading(agentServer, false);
      });
    this.configCacheRefreshes.set(agentServer, refresh);
    this.configRefreshQuiet.set(refresh, quiet);
    return refresh;
  }

  async loadCachedConfigFromStore(agentServer: string): Promise<ACPConfigCacheEntry | null> {
    agentServer = normalizeAgentServerName(agentServer);
    const cached = this.configCacheByAgentServer[agentServer];
    if (cached) return cached;
    try {
      const state = normalizeConfigCacheState(await camberAcpNavGetConfigCache({ agentServer }));
      const entry = state.entry ?? null;
      if (!entry) return null;
      this.configCacheByAgentServer = {
        ...this.configCacheByAgentServer,
        [agentServer]: entry,
      };
      return entry;
    } catch (error) {
      console.error("Failed to load ACP config cache", error);
      return null;
    }
  }

  // A quiet refresh is a background freshness probe (window focus): its
  // failures must not paint error banners on conversations the user never
  // touched — e.g. a wake-from-sleep focus hitting a stale agent connection.
  // Callers that need failures surfaced never reuse a quiet refresh (see
  // refreshCachedConfig), so quietness is fixed for the life of one probe.
  // Success always clears a stale banner, quiet or not.
  private async refreshCachedConfigCore(
    agentServer: string,
    cwd: string,
    quiet = false,
  ): Promise<void> {
    const conn = await this.connectServer(agentServer, { surfaceErrors: !quiet });
    if (!conn) {
      this.#markAgentConfigFailed(agentServer);
      return;
    }

    try {
      const res = await conn.newSession({
        cwd,
        mcpServers: [],
        // Mark this as a config probe so the helper skips user-connector
        // injection (keep the key in sync with acpproxy's configProbeMetaKey).
        _meta: { "camber/configProbe": true },
      });
      const previousProbeSessionId = this.configProbeSessionIds.get(agentServer);
      this.configProbeSessionIds.set(agentServer, res.sessionId);
      this.configProbeSessionIdsByAgentServer = {
        ...this.configProbeSessionIdsByAgentServer,
        [agentServer]: res.sessionId,
      };
      if (previousProbeSessionId && previousProbeSessionId !== res.sessionId) {
        this.#closeSupersededProbe(agentServer, previousProbeSessionId);
      }
      const availableCommands = this.cachedAvailableCommands(agentServer);
      const configOptions = preserveCachedSelections(
        res.configOptions ?? [],
        this.userConfigSelectionsFor(agentServer),
      );
      this.markAgentConfigFresh(agentServer);
      await this.upsertCachedConfig(agentServer, {
        configOptions,
        availableCommands,
        modes: preserveCachedModeSelection(
          res.modes ?? null,
          this.userModeSelectionFor(agentServer),
        ),
        // connectServer just populated initializeResponses for this agent, so
        // persist its capabilities alongside the config we just probed.
        promptCapabilities:
          this.getInitializeResponse(agentServer)?.agentCapabilities?.promptCapabilities ?? null,
        agentInfo: this.getInitializeResponse(agentServer)?.agentInfo ?? null,
        authoritativeDefinitions: true,
      });
      this.clearAuthRequired(agentServer);
      // The agent answered, so any banner from an earlier failure is stale.
      this.clearNonSessionError(agentServer);
    } catch (e) {
      this.#markAgentConfigFailed(agentServer);
      const err = normalizeACPError(e);
      if (!isAuthRequiredError(err)) {
        if (!quiet) this.setNonSessionError(agentServer, err);
        return;
      }
      // Auth-required detection is matched on message shape, so a transient
      // upstream 401 can look like a logout. Acting on that in the background
      // would replace the composer with a login panel on a conversation the
      // user never touched — and stick, since the focus refresher skips
      // auth-required agents. Leave it to the paths the user drove.
      if (quiet) return;
      this.markAuthRequired(agentServer);
      this.clearNonSessionError(agentServer);
    }
  }

  // Close a probe the client has stopped using, after a drain window for
  // in-flight RPCs still bound to its id (MCP settings resolves its session
  // from the probe map, including an authenticate that spans a browser OAuth
  // round-trip). Closing twice, or closing an evicted session, no-ops
  // helper-side. Any ids whose timer was eaten by a webview teardown are
  // flushed on the next rotation.
  #closeSupersededProbe(agentServer: string, sessionId: SessionId): void {
    const pending = this.pendingProbeCloses.get(agentServer) ?? new Set<SessionId>();
    for (const stranded of pending) {
      if (stranded === sessionId) continue;
      pending.delete(stranded);
      void this.#closeProbeSession(agentServer, stranded);
    }
    pending.add(sessionId);
    this.pendingProbeCloses.set(agentServer, pending);
    setTimeout(() => {
      if (!this.pendingProbeCloses.get(agentServer)?.delete(sessionId)) return;
      void this.#closeProbeSession(agentServer, sessionId);
    }, SUPERSEDED_PROBE_CLOSE_DELAY_MS);
  }

  #closeProbeSession(agentServer: string, sessionId: SessionId): Promise<void> {
    return camberAcpSessionClose({ agentServer, sessionId })
      .then(() => {})
      .catch((e: unknown) => console.debug("Failed to close ACP config probe", e));
  }

  /**
   * Merge agent-reported option definitions over a cache entry a concurrent
   * writer produced from older ones, keeping that writer's selections. Writes
   * through to the store so a restart can't resurrect the stale definitions.
   */
  #reassertDefinitions(
    agentServer: string,
    snapshot: ACPConfigCacheSnapshot,
    current: ACPConfigCacheEntry,
  ): ACPConfigCacheEntry {
    const configOptions = mergeConfigSelections(
      snapshot.configOptions,
      currentConfigSelections(current.configOptions),
    );
    const merged: ACPConfigCacheEntry = {
      agentServer,
      configOptions,
      availableCommands:
        current.availableCommands.length > 0
          ? current.availableCommands
          : snapshot.availableCommands,
      modes: syncModeFromConfigOptions(current.modes ?? snapshot.modes, configOptions),
      promptCapabilities: snapshot.promptCapabilities,
      agentInfo: snapshot.agentInfo,
      cachedAt: new Date().toISOString(),
    };
    this.configCacheByAgentServer = {
      ...this.configCacheByAgentServer,
      [agentServer]: merged,
    };
    void camberAcpNavUpsertConfigCache({
      agentServer,
      configOptions: merged.configOptions,
      availableCommands: merged.availableCommands,
      modes: merged.modes,
      promptCapabilities: merged.promptCapabilities,
      agentInfo: merged.agentInfo,
    }).catch((error: unknown) => console.error("Failed to persist ACP config cache", error));
    return merged;
  }

  async upsertCachedConfig(
    agentServer: string,
    value: {
      configOptions: SessionConfigOption[];
      availableCommands: AvailableCommand[];
      modes: SessionModeState | null;
      replaceAvailableCommands?: boolean;
      // Omit to preserve the already-cached capabilities (e.g. streaming
      // config-option updates that don't carry capability info).
      promptCapabilities?: PromptCapabilities | null;
      agentInfo?: Implementation | null;
      // The option *definitions* came straight from the agent, so they win
      // over a concurrent write that republished older ones. Only the paths
      // that just read them off the wire may set this.
      authoritativeDefinitions?: boolean;
    },
  ): Promise<ACPConfigCacheEntry | null> {
    agentServer = normalizeAgentServerName(agentServer);
    const availableCommands =
      value.replaceAvailableCommands || value.availableCommands.length > 0
        ? value.availableCommands
        : this.cachedAvailableCommands(agentServer);
    // Explicit value wins; otherwise prefer the live initialize response (so a
    // real session connecting refreshes persisted capabilities) and finally
    // fall back to whatever was already cached.
    const promptCapabilities =
      value.promptCapabilities !== undefined
        ? value.promptCapabilities
        : (this.getInitializeResponse(agentServer)?.agentCapabilities?.promptCapabilities ??
          this.configCacheByAgentServer[agentServer]?.promptCapabilities ??
          null);
    const agentInfo =
      value.agentInfo !== undefined
        ? value.agentInfo
        : (this.getInitializeResponse(agentServer)?.agentInfo ??
          this.configCacheByAgentServer[agentServer]?.agentInfo ??
          null);
    const snapshot = snapshotConfigCacheValue({
      configOptions: value.configOptions,
      availableCommands,
      modes: value.modes,
      promptCapabilities,
      agentInfo,
    });
    const fallback: ACPConfigCacheEntry = {
      agentServer,
      configOptions: snapshot.configOptions,
      availableCommands: snapshot.availableCommands,
      modes: snapshot.modes,
      promptCapabilities: snapshot.promptCapabilities,
      agentInfo: snapshot.agentInfo,
      cachedAt: new Date().toISOString(),
    };
    this.configCacheByAgentServer = {
      ...this.configCacheByAgentServer,
      [agentServer]: fallback,
    };
    try {
      const state = normalizeConfigCacheState(
        await camberAcpNavUpsertConfigCache({
          agentServer,
          configOptions: snapshot.configOptions,
          availableCommands: snapshot.availableCommands,
          modes: snapshot.modes,
          promptCapabilities: snapshot.promptCapabilities,
          agentInfo: snapshot.agentInfo,
        }),
      );
      const entry = state.entry ?? fallback;
      // A concurrent writer (e.g. a draft picker selection landing while this
      // persist round-tripped) replaced our optimistic entry.
      const current = this.configCacheByAgentServer[agentServer];
      if (current !== fallback) {
        // Keep the newer state instead of clobbering it with this call's
        // echo; the concurrent writer persists its own snapshot.
        if (!value.authoritativeDefinitions || !current) return current ?? fallback;
        // Except when we hold agent-reported definitions: a draft's picker
        // write republishes whatever definitions that draft held, which may
        // predate the ones we just read off the wire. Dropping ours would
        // hide a newly released option until the next probe — and freshness
        // is already recorded, so that could be the whole TTL.
        return this.#reassertDefinitions(agentServer, snapshot, current);
      }
      this.configCacheByAgentServer = {
        ...this.configCacheByAgentServer,
        [agentServer]: entry,
      };
      return entry;
    } catch (error) {
      console.error("Failed to update ACP config cache", error);
      return fallback;
    }
  }

  /**
   * Streaming session-update updates the cache when they're addressed to the
   * throwaway config probe created by refreshCachedConfigCore. Returns true
   * if the update was a probe update (so the caller knows it doesn't belong
   * to a real ACPSession).
   */
  handleConfigProbeSessionUpdate(agentServer: string, params: SessionNotification): boolean {
    agentServer = normalizeAgentServerName(agentServer);
    if (this.configProbeSessionIds.get(agentServer) !== params.sessionId) return false;

    const cached = this.configCacheByAgentServer[agentServer] ?? {
      agentServer,
      configOptions: [],
      availableCommands: [],
      modes: null,
      promptCapabilities: null,
      agentInfo: null,
      cachedAt: new Date().toISOString(),
    };
    const next = { ...cached };

    switch (params.update.sessionUpdate) {
      case "config_option_update":
        next.configOptions = preserveCachedSelections(
          params.update.configOptions,
          this.userConfigSelectionsFor(agentServer),
        );
        next.modes = syncModeFromConfigOptions(next.modes, next.configOptions);
        // Only a config report defers the next probe. Commands and mode
        // pushes say nothing about the option set, and an agent that emits
        // them periodically on the idle probe would hold the TTL open
        // forever, so the options would never refresh again.
        this.markAgentConfigFresh(agentServer);
        break;
      case "available_commands_update":
        next.availableCommands = params.update.availableCommands;
        break;
      case "current_mode_update":
        {
          // This describes the throwaway probe session, so it must not
          // override a mode the user chose — that value seeds the next new
          // conversation.
          const modeId = this.userModeSelectionFor(agentServer) ?? params.update.currentModeId;
          const modeConfig = findModeConfigOption(next.configOptions);
          if (modeConfig) {
            next.configOptions = updateConfigOptionValue(next.configOptions, modeConfig.id, modeId);
          }
          next.modes = next.modes
            ? updateSessionModeValue(next.modes, modeId)
            : { currentModeId: modeId, availableModes: [] };
        }
        break;
      default:
        return true;
    }

    void this.upsertCachedConfig(agentServer, {
      configOptions: next.configOptions,
      availableCommands: next.availableCommands,
      modes: next.modes,
      replaceAvailableCommands: params.update.sessionUpdate === "available_commands_update",
      // Only a config_option_update carries definitions from the agent; the
      // other kinds just republish what was already cached.
      authoritativeDefinitions: params.update.sessionUpdate === "config_option_update",
    });
    return true;
  }
}

// ---- Config cache helpers ----

// Re-apply the user's explicit choices onto a fresh agent config report where
// they are still valid. Only recorded user selections are re-applied: the
// cache's other currentValues are just the agent's last-reported defaults, so
// preserving those too would pin the first-seen default forever and stop an
// agent-side default change from ever reaching the picker.
// mergeConfigSelections drops selections whose option or value vanished from
// the fresh definitions.
function preserveCachedSelections(
  fresh: SessionConfigOption[],
  userSelections: Map<string, string | boolean>,
): SessionConfigOption[] {
  if (userSelections.size === 0) return fresh;
  return mergeConfigSelections(fresh, userSelections);
}

// Same as preserveCachedSelections for legacy mode state: keep the user's
// chosen mode when the fresh report still offers it.
function preserveCachedModeSelection(
  fresh: SessionModeState | null,
  userModeId: string | null,
): SessionModeState | null {
  if (!fresh || !userModeId || fresh.currentModeId === userModeId) return fresh;
  if (!fresh.availableModes.some((mode) => mode.id === userModeId)) return fresh;
  return { ...fresh, currentModeId: userModeId };
}

function isConfigCacheStale(entry: ACPConfigCacheEntry): boolean {
  const cachedAt = Date.parse(entry.cachedAt);
  if (Number.isNaN(cachedAt)) return true;
  return Date.now() - cachedAt > 7 * 24 * 60 * 60 * 1000;
}

function normalizeConfigCacheState(state?: {
  entry?: {
    agentServer: string;
    configOptions: unknown;
    availableCommands: unknown;
    modes: unknown;
    promptCapabilities?: unknown;
    agentInfo?: unknown;
    cachedAt: string;
  };
}): ACPConfigCacheState {
  if (!state?.entry) return { entry: null };
  return {
    entry: {
      agentServer: state.entry.agentServer,
      configOptions: state.entry.configOptions as SessionConfigOption[],
      availableCommands: state.entry.availableCommands as AvailableCommand[],
      modes: state.entry.modes as SessionModeState | null,
      promptCapabilities: (state.entry.promptCapabilities as PromptCapabilities | null) ?? null,
      agentInfo: (state.entry.agentInfo as Implementation | null) ?? null,
      cachedAt: state.entry.cachedAt,
    },
  };
}

function snapshotConfigCacheValue(value: ACPConfigCacheSnapshot): ACPConfigCacheSnapshot {
  return {
    configOptions: $state.snapshot(value.configOptions) as SessionConfigOption[],
    availableCommands: $state.snapshot(value.availableCommands) as AvailableCommand[],
    modes: value.modes === null ? null : ($state.snapshot(value.modes) as SessionModeState),
    promptCapabilities:
      value.promptCapabilities === null
        ? null
        : ($state.snapshot(value.promptCapabilities) as PromptCapabilities),
    agentInfo:
      value.agentInfo === null ? null : ($state.snapshot(value.agentInfo) as Implementation),
  };
}
