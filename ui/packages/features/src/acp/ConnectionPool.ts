import type {
  AnyMessage,
  ClientSideConnection,
  InitializeRequest,
  InitializeResponse,
} from "@agentclientprotocol/sdk";
import { camberAcpServerRestart } from "@camber/helperapi";
import { get } from "svelte/store";
import { DEFAULT_AGENT_SERVER, normalizeAgentServerName } from "./agentServers";
import { ACPClient } from "./Client";
import { createACPConnection } from "./createACPConnection";
import { ACPDebugLog, normalizeDumpEntries, type ACPDebugAPI } from "./debugDump";
import type { ACPSessionRepositoryWriter } from "./features/SessionRepository.svelte";
import { appState } from "./hostAdapter";
import type { HelperAPIClient } from "./hostRpc";
import { RPCTransport, type ACPTransport } from "./RPCTransport";

interface ACPServerConnection {
  conn: ClientSideConnection;
  initializeResponse: InitializeResponse;
  transport: RPCTransport;
}

const MAX_PENDING_MESSAGES_PER_AGENT = 2_048;

// Bound on connect retries after restarts invalidate in-flight handshakes;
// hitting it means something is restarting the server in a tight loop.
const MAX_CONNECT_ATTEMPTS = 4;

// A connect handshake that a concurrent restart invalidated: the process it
// initialized was torn down. Internal control flow only — connect() retries
// against the restarted process instead of surfacing this.
class StaleConnectionError extends Error {
  constructor(agentServer: string) {
    super(`ACP connection to ${agentServer} was restarted while connecting`);
  }
}

type BridgedACPMessage =
  | {
      agentServer?: string;
      message?: AnyMessage;
    }
  | AnyMessage;

export class ACPConnectionPool implements ACPTransport {
  private connections = new Map<string, ACPServerConnection>();
  private pendingMessages = new Map<string, AnyMessage[]>();
  private pendingConnects = new Map<string, Promise<ACPServerConnection>>();
  // Bumped by disconnect/restart; a connect handshake that started under an
  // older generation initialized a process instance that no longer exists,
  // so its result must not be cached.
  private readonly generations = new Map<string, number>();
  // Gates new connects while a restart stops the helper-side process, so a
  // racing flow cannot initialize the instance the restart is tearing down.
  private readonly restartsInFlight = new Map<string, Promise<void>>();
  private readonly debugLog = new ACPDebugLog();
  readonly debug: ACPDebugAPI;

  constructor(
    private readonly helperApiClient: HelperAPIClient,
    private readonly repo: ACPSessionRepositoryWriter,
  ) {
    this.debug = {
      capture: {
        state: () => this.debugLog.captureState(),
        subscribe: (listener) => this.debugLog.subscribeCapture(listener),
        setConversationCollecting: (agentServer, conversationId, sessionId, enabled) =>
          this.debugLog.setConversationCollecting(agentServer, conversationId, sessionId, enabled),
        resetConversationCollecting: (agentServer, conversationId, sessionId) =>
          this.debugLog.resetConversationCollecting(agentServer, conversationId, sessionId),
        isConversationCollecting: (agentServer, conversationId, sessionId) =>
          this.debugLog.isConversationCollecting(agentServer, conversationId, sessionId),
        bindConversationSession: (agentServer, conversationId, sessionId) =>
          this.debugLog.bindConversationSession(agentServer, conversationId, sessionId),
        setSessionCollecting: (agentServer, sessionId, enabled) =>
          this.debugLog.setSessionCollecting(agentServer, sessionId, enabled),
        resetSessionCollecting: (agentServer, sessionId) =>
          this.debugLog.resetSessionCollecting(agentServer, sessionId),
        isCollecting: (agentServer, sessionId) =>
          this.debugLog.isCollecting(agentServer, sessionId),
      },
      subscribeEntries: (listener) => this.debugLog.subscribeEntries(listener),
      dump: (agentServer) => this.debugLog.dump(agentServer ?? this.activeAgentServer()),
      dumpJSON: (agentServer) =>
        JSON.stringify(this.debugLog.dump(agentServer ?? this.activeAgentServer()), null, 2),
      clear: (agentServer) => this.debugLog.clear(agentServer ?? this.activeAgentServer()),
      load: async (entries, agentServer) => {
        const parsed = normalizeDumpEntries(
          typeof entries === "string" ? JSON.parse(entries) : entries,
        );
        const targetAgentServer = agentServer ?? this.activeAgentServer();
        await this.repo.loadDebugDump(parsed, targetAgentServer);
        this.debugLog.replace(targetAgentServer, parsed);
      },
      restartServer: (agentServer) => this.restart(agentServer ?? this.activeAgentServer()),
    };
  }

  async connect(agentServer: string): Promise<ACPServerConnection> {
    const server = normalizeAgentServerName(agentServer);
    // Recovery flows restart the helper-side process while other flows (an
    // early notification, a session load) connect concurrently. Each attempt
    // binds to a generation; disconnect/restart bump it, so an attempt whose
    // process was torn down mid-handshake is retried against the restarted
    // process instead of being cached as a live connection to a dead one.
    for (let attempt = 0; attempt < MAX_CONNECT_ATTEMPTS; attempt++) {
      const restarting = this.restartsInFlight.get(server);
      if (restarting) {
        await restarting.catch(() => {});
      }
      const existing = this.connections.get(server);
      if (existing) {
        return existing;
      }
      // Read the generation before any await below, so both failure modes of a
      // handshake — resolving against a torn-down process, and rejecting
      // because that process went away mid-handshake — are recognized as stale.
      const generation = this.generations.get(server) ?? 0;
      // Concurrent connects to the same server (e.g. a broadcast permission
      // request racing a session load) must share one transport, or the loser's
      // connection would be silently replaced in the map while still in use.
      const pending = this.pendingConnects.get(server);
      if (pending) {
        try {
          return await pending;
        } catch (error) {
          if (this.isStaleConnectFailure(server, generation, error)) continue;
          throw error;
        }
      }

      const connectPromise = (async () => {
        const transport = new RPCTransport(this.helperApiClient, server, this.debugLog);
        const conn = createACPConnection(() => new ACPClient(this.repo, server), transport);
        const initializeResponse = await conn.initialize(defaultInitializeRequest());
        if ((this.generations.get(server) ?? 0) !== generation) {
          throw new StaleConnectionError(server);
        }
        const connected = { conn, initializeResponse, transport };
        this.connections.set(server, connected);
        const pendingMessages = this.pendingMessages.get(server) ?? [];
        this.pendingMessages.delete(server);
        for (const message of pendingMessages) {
          transport.receive(message);
        }
        return connected;
      })();
      this.pendingConnects.set(server, connectPromise);
      try {
        return await connectPromise;
      } catch (error) {
        if (this.isStaleConnectFailure(server, generation, error)) continue;
        throw error;
      } finally {
        if (this.pendingConnects.get(server) === connectPromise) {
          this.pendingConnects.delete(server);
        }
      }
    }
    throw new Error(`ACP connection to ${server} kept restarting; giving up`);
  }

  // A handshake is stale either because it completed against a process a
  // restart had already torn down (StaleConnectionError, thrown above), or
  // because it failed while that teardown was in flight — the helper fails
  // initialize outright when it races the stop. Both mean "retry against the
  // restarted process" rather than surfacing the error to the caller, which
  // is the reload loop this pool exists to break.
  private isStaleConnectFailure(server: string, generation: number, error: unknown): boolean {
    if (error instanceof StaleConnectionError) return true;
    return (this.generations.get(server) ?? 0) !== generation;
  }

  async restart(agentServer = DEFAULT_AGENT_SERVER): Promise<void> {
    const server = normalizeAgentServerName(agentServer);
    // Serialize restarts and gate new connects for the duration: a connect
    // racing the helper's stop would initialize the doomed process instance
    // and hand out a connection to it (the "not initialized" reload loop).
    const previous = this.restartsInFlight.get(server) ?? Promise.resolve();
    const run = (async () => {
      await previous.catch(() => {});
      this.disconnect(server);
      await camberAcpServerRestart({ agentServer: server });
    })();
    this.restartsInFlight.set(server, run);
    try {
      await run;
    } finally {
      if (this.restartsInFlight.get(server) === run) {
        this.restartsInFlight.delete(server);
      }
    }
  }

  disconnect(agentServer = DEFAULT_AGENT_SERVER): void {
    const server = normalizeAgentServerName(agentServer);
    // Invalidate any connect handshake in flight: it belongs to the process
    // instance this disconnect is walking away from.
    this.generations.set(server, (this.generations.get(server) ?? 0) + 1);
    this.connections.delete(server);
    // The connection's outstanding requests will never see a matching
    // response now, so drop their correlation entries rather than leaking
    // them until the map's cap evicts them. Captured messages are untouched.
    this.debugLog.clearCorrelations(server);
  }

  receive(payload: BridgedACPMessage): void {
    const { agentServer, message } = unwrapBridgeMessage(payload);
    if (isLegacyACPTaskDidChangeMessage(message)) {
      // The task/checkpoint system is removed; ignore any notifications a
      // not-yet-updated helper still emits.
      return;
    }

    const connection = this.connections.get(agentServer);
    if (!connection) {
      const pending = this.pendingMessages.get(agentServer) ?? [];
      if (pending.length >= MAX_PENDING_MESSAGES_PER_AGENT) {
        throw new Error(`ACP pending message queue for ${agentServer} is full`);
      }
      pending.push(message);
      this.pendingMessages.set(agentServer, pending);
      // Accepting the message into this bounded queue lets the native bridge
      // acknowledge it without waiting for the connection's initialize
      // response (which may itself follow this notification on helper stdout).
      // The shared pending-connect promise prevents duplicate handshakes.
      void this.connect(agentServer).catch((error) => {
        console.error(`Failed to initialize ACP transport for ${agentServer}`, error);
      });
      return;
    }
    connection.transport.receive(message);
  }

  async sendRequest(payload: BridgedACPMessage): Promise<unknown> {
    const { agentServer, message } = unwrapBridgeMessage(payload);
    // Helper-initiated requests (permission prompts are broadcast to every
    // connected surface) can arrive before anything here has opened this
    // agent's connection — e.g. the phone sitting on the conversation list.
    // Connect lazily so the prompt can be handled instead of erroring back.
    const connection = this.connections.get(agentServer) ?? (await this.connect(agentServer));
    return connection.transport.sendRequest(message);
  }

  private activeAgentServer(): string {
    return this.repo.agents.defaultAgentServer;
  }
}

const LEGACY_ACP_TASK_DID_CHANGE_METHOD = "camber/acpTask/didChange";

function isLegacyACPTaskDidChangeMessage(message: AnyMessage): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    "method" in message &&
    (message as { method?: unknown }).method === LEGACY_ACP_TASK_DID_CHANGE_METHOD
  );
}

function defaultInitializeRequest(): InitializeRequest {
  const environment = get(appState).environment;
  const assistantHost = environment.assistantHost.trim();
  const assistantVersion = environment.assistantVersion.trim();
  const clientCapabilities = {
    fs: {
      readTextFile: true,
      writeTextFile: true,
    },
    terminal: false,
    auth: {
      terminal: true,
    },
    _meta: {
      "terminal-auth": true,
      "subagent-transcript": true,
    },
  } as InitializeRequest["clientCapabilities"] & {
    auth: { terminal: true };
    _meta: { "terminal-auth": true; "subagent-transcript": true };
  };

  return {
    protocolVersion: 1,
    clientInfo: {
      name: assistantHost ? `camber-${assistantHost}` : "camber-assistant",
      version: assistantVersion || "local",
    },
    clientCapabilities,
    _meta: {
      "terminal-auth": true,
    },
  } as InitializeRequest & { _meta: { "terminal-auth": true } };
}

function unwrapBridgeMessage(payload: BridgedACPMessage): {
  agentServer: string;
  message: AnyMessage;
} {
  if (
    payload &&
    typeof payload === "object" &&
    "message" in payload &&
    (payload as { message?: unknown }).message
  ) {
    return {
      agentServer: normalizeAgentServerName(
        typeof (payload as { agentServer?: unknown }).agentServer === "string"
          ? (payload as { agentServer: string }).agentServer
          : DEFAULT_AGENT_SERVER,
      ),
      message: (payload as { message: AnyMessage }).message,
    };
  }

  return {
    agentServer: normalizeAgentServerName(DEFAULT_AGENT_SERVER),
    message: payload as AnyMessage,
  };
}
